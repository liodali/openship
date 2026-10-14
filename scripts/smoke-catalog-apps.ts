import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { buildCatalog } from "../packages/core/scripts/gen-catalog";
import type { AppTemplate, TemplateServiceSpec } from "../packages/core/src/app-templates";
import { runAppPrepareCommand } from "../packages/platform/src/engine/modules/deployments/compose/app-prepare";
import retiredBuilds from "./fixtures/catalog-retired-builds.json";

export const OFFICIAL_APP_STACKS = [
  "wordpress",
  "odoo",
  "postgresql",
  "mariadb",
  "rabbitmq",
  "authentik",
  "nextcloud",
] as const;
const run = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function inputValue(html: string, name: string): string | undefined {
  const input = html
    .match(/<input\b[^>]*>/gi)
    ?.find((tag) => new RegExp("\\bname=['\"]" + name + "['\"]").test(tag));
  return input && /\bvalue=['"]([^'"]*)/.exec(input)?.[1];
}
let operation = "initialization";
const docker = async (...args: string[]) => {
  try {
    return (
      await run("docker", args, { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 })
    ).stdout.trim();
  } catch (error) {
    // Docker errors embed argv, which can contain the disposable test credentials.
    const stderr =
      (error as { stderr?: string }).stderr?.replace(/[a-f0-9]{64}/g, "[redacted]") ?? "";
    if (stderr)
      await writeFile(join(tmpdir(), "openship-catalog-smoke-failure.log"), stderr, {
        mode: 0o600,
      });
    throw new Error(
      `Docker ${args[0]} failed during ${operation}; details: ${join(tmpdir(), "openship-catalog-smoke-failure.log")}`,
    );
  }
};

/** Disposable local integration stack. All runtime image/argv/env/volume/config
 * comes from the canonical template. App-specific checks exercise real login
 * and data APIs; no production API, Cloud purchase, or customer data is used. */
async function smokeApp(app: AppTemplate) {
  const testRetired = process.env.CATALOG_TEST_FROM_RETIRED_BUILD === "1";
  if (testRetired && app.id !== "wordpress" && app.id !== "odoo")
    throw new Error("Retired-build conversion tests support only WordPress and Odoo");
  const retired = testRetired ? retiredBuilds[app.id as keyof typeof retiredBuilds] : undefined;
  // Start with the actual historical recipe, then replace only the application
  // with today's official image and mounted helper on the same data volumes.
  let runtimeRecipe = retired
    ? {
        ...app,
        services: app.services!.map((s) => {
          if (s.name !== app.id) return s;
          const { image, commandArgv, ...rest } = s;
          return { ...rest, build: retired };
        }),
        files: (app.files ?? []).filter((f) => f.service !== app.id),
      }
    : app;
  const prefix = "openship-app-smoke-" + randomUUID().slice(0, 8);
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const names = new Map(app.services!.map((s) => [s.name, prefix + "-" + s.name]));
  const volumes = new Map<string, string>();
  const configVolumes = new Map<string, string>();
  const images = new Map<string, string>();
  const generatedImages = new Set<string>();
  const environment = new Map<string, Record<string, string>>();
  const urls = new Map<string, string>();
  const config = new Map<string, string>();
  const groups = new Map<string, string>();
  const marker = randomUUID();
  // Keep ports per invocation local to this disposable test. Independent CI
  // jobs run on independent hosts; no database/broker port is published.
  let port = 35_000 + Math.floor(Math.random() * 15_000);
  for (const s of app.services!) if (s.exposedPort) urls.set(s.name, "http://127.0.0.1:" + port++);
  for (const field of app.configFields ?? []) {
    let value = field.default ?? "";
    if (field.generate === "secret") {
      value =
        (field.generateGroup && groups.get(field.generateGroup)) || randomBytes(32).toString("hex");
      if (field.generateGroup) groups.set(field.generateGroup, value);
    }
    config.set(field.key, value);
  }
  for (const group of app.settings ?? [])
    for (const field of group.fields) {
      config.set(
        field.key,
        field.key.includes("EMAIL") ? "smoke@openship.io" : (field.default ?? ""),
      );
    }
  const resolve = (value: string) =>
    value
      .replace(/\{\{config:([^}]+)\}\}/g, (_, key) => config.get(key) ?? "")
      .replace(
        /\{\{publicUrl:([^}:]+)(?::\d+)?\}\}/g,
        (_, name) => urls.get(name) ?? "http://" + name,
      );
  const exec = (service: string, command: string) =>
    docker("exec", names.get(service)!, "sh", "-c", command);
  const env = (service: string, key: string) => environment.get(service)![key]!;
  const url = (service: string, path = "") => urls.get(service)! + path;
  const basic = (user: string, password: string) =>
    "Basic " + Buffer.from(user + ":" + password).toString("base64");
  const request = async (service: string, path: string, options?: RequestInit) =>
    fetch(url(service, path), { ...options, signal: AbortSignal.timeout(30_000) });
  const waitHealthy = async (service: TemplateServiceSpec) => {
    const deadline = Date.now() + 480_000;
    while (Date.now() < deadline) {
      const state = JSON.parse(
        await docker("inspect", "--format", "{{json .State}}", names.get(service.name)!),
      );
      if (state.Health?.Status === "healthy" || (!service.healthcheck && state.Running)) return;
      if (state.OOMKilled || (!state.Running && !state.Restarting))
        throw new Error(app.id + "/" + service.name + " exited during startup");
      await pause(2_000);
    }
    // Persist local, bounded logs without echoing credential-bearing argv.
    const log = await docker("logs", "--tail", "30", names.get(service.name)!).catch(
      () => "unavailable",
    );
    const sanitized = [...config.values()]
      .filter((v) => v.length >= 24)
      .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), log);
    await writeFile(join(dir, "failure.log"), sanitized, { mode: 0o600 });
    throw new Error(app.id + "/" + service.name + " did not become healthy");
  };
  const create = async (s: TemplateServiceSpec) => {
    const memory = s.resources ? s.resources.memoryMb + "m" : "768m";
    const args = [
      "create",
      "--name",
      names.get(s.name)!,
      "--hostname",
      s.name,
      "--network",
      prefix,
      "--network-alias",
      s.name,
      "--label",
      "openship.test=catalog-apps",
      "--memory",
      memory,
    ];
    if (s.resources) args.push("--cpus", String(s.resources.cpuCores));
    if (s.exposedPort)
      args.push("-p", "127.0.0.1:" + new URL(urls.get(s.name)!).port + ":" + s.exposedPort);
    for (const [key, value] of Object.entries(environment.get(s.name)!))
      args.push("-e", key + "=" + value);
    for (const mount of s.volumes ?? []) {
      const [name, target, mode] = mount.split(":");
      assert(name && target, "Malformed catalog mount");
      args.push("-v", volumes.get(name)! + ":" + target + (mode ? ":" + mode : ""));
    }
    const health = s.healthcheck as
      | {
          test: string[];
          interval?: string;
          timeout?: string;
          retries?: number;
          startPeriod?: string;
        }
      | undefined;
    if (health) {
      args.push(
        "--health-cmd",
        health.test[0] === "CMD-SHELL"
          ? health.test[1]!
          : health.test.slice(1).map(quote).join(" "),
      );
      for (const [flag, value] of [
        ["--health-interval", health.interval],
        ["--health-timeout", health.timeout],
        ["--health-retries", health.retries?.toString()],
        ["--health-start-period", health.startPeriod],
      ] as const)
        if (value) args.push(flag, value);
    }
    const files = (runtimeRecipe.files ?? []).filter((f) => f.service === s.name);
    if (files.length) {
      const fileRoot = join(dir, "config", s.name);
      const volume = configVolumes.get(s.name) ?? prefix + "-" + s.name + "-config";
      if (!configVolumes.has(s.name)) {
        await docker("volume", "create", "--label", "openship.test=catalog-apps", volume);
        configVolumes.set(s.name, volume);
      }
      const helper = prefix + "-" + s.name + "-config-writer";
      try {
        await docker(
          "create",
          "--name",
          helper,
          "--label",
          "openship.test=catalog-apps",
          "--network",
          "none",
          "--entrypoint",
          "sh",
          "--mount",
          "type=volume,source=" + volume + ",target=/config",
          images.get(s.name)!,
        );
        for (const [index, file] of files.entries()) {
          assert(
            file.path.startsWith("/") && !file.path.split("/").includes(".."),
            "Unsafe catalog file path",
          );
          const path = join(fileRoot, String(index));
          await mkdir(fileRoot, { recursive: true });
          await writeFile(path, resolve(file.content), { mode: 0o644 });
          await chmod(path, 0o644);
          await docker("cp", path, helper + ":/config/" + index);
        }
      } finally {
        await docker("rm", "-f", "-v", helper).catch(() => {});
      }
      // Mirror the engine's individual read-only file binds. Staging in a
      // daemon volume works with local Linux, Colima, and remote test daemons.
      const source = await docker("volume", "inspect", "--format", "{{.Mountpoint}}", volume);
      for (const [index, file] of files.entries())
        args.push(
          "--mount",
          "type=bind,source=" + source + "/" + index + ",target=" + file.path + ",readonly",
        );
    }
    args.push(images.get(s.name)!);
    if (s.commandArgv) args.push(...s.commandArgv);
    else if (s.command) args.push("sh", "-c", s.command);
    await docker(...args);
  };
  const start = async () => {
    for (const s of runtimeRecipe.services!) {
      operation = app.id + "/start/" + s.name;
      await create(s);
      await docker("start", names.get(s.name)!);
      await waitHealthy(s);
    }
    for (const step of app.prepare ?? []) {
      operation = app.id + "/prepare/" + step.capture;
      await runAppPrepareCommand(step, { exec: (command) => exec(step.service, command) });
    }
  };
  const replace = async () => {
    if (runtimeRecipe !== app) {
      const applications = app.services!.filter((s) => s.name === app.id);
      for (const s of applications) {
        await docker("pull", s.image!);
        images.set(s.name, s.image!);
        await docker("rm", "-f", names.get(s.name)!);
      }
      runtimeRecipe = app;
      for (const s of applications) {
        await create(s);
        await docker("start", names.get(s.name)!);
        await waitHealthy(s);
      }
      return;
    }
    for (const s of [...app.services!].reverse()) await docker("rm", "-f", names.get(s.name)!);
    await start();
  };
  try {
    operation = app.id + "/provision";
    await docker("network", "create", "--label", "openship.test=catalog-apps", prefix);
    for (const s of runtimeRecipe.services!) {
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(s.environment ?? {})) values[key] = resolve(value);
      for (const f of app.configFields ?? [])
        if (f.service === s.name && config.get(f.key)) values[f.key] = config.get(f.key)!;
      for (const group of app.settings ?? [])
        for (const f of group.fields) if (f.service === s.name) values[f.key] = config.get(f.key)!;
      environment.set(s.name, values);
      for (const mount of s.volumes ?? []) {
        const name = mount.split(":")[0]!;
        if (!volumes.has(name)) {
          volumes.set(name, prefix + "-" + name);
          await docker(
            "volume",
            "create",
            "--label",
            "openship.test=catalog-apps",
            volumes.get(name)!,
          );
        }
      }
      if (s.build) {
        const context = join(dir, "build", s.name);
        await mkdir(context, { recursive: true });
        await writeFile(join(context, "Dockerfile"), resolve(s.build.dockerfile));
        for (const file of s.build.files ?? []) {
          const path = join(context, s.name, file.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, resolve(file.content));
        }
        const image = prefix + "/" + s.name + ":test";
        await docker("build", "--label", "openship.test=catalog-apps", "-t", image, context);
        generatedImages.add(image);
        images.set(s.name, image);
      } else {
        images.set(s.name, s.image!);
        await docker("pull", s.image!);
      }
    }
    await start();
    operation = app.id + "/login-and-write";
    switch (app.id) {
      case "wordpress": {
        const loginAs = (password: string) =>
          request("wordpress", "/wp-login.php", {
            method: "POST",
            redirect: "manual",
            body: new URLSearchParams({
              log: env("wordpress", "OPENSHIP_ADMIN_USER"),
              pwd: password,
              "wp-submit": "Log In",
              redirect_to: url("wordpress", "/wp-admin/"),
              testcookie: "1",
            }),
            headers: { Cookie: "wordpress_test_cookie=WP%20Cookie%20check" },
          });
        const login = await loginAs(env("wordpress", "OPENSHIP_ADMIN_PASSWORD"));
        assert(
          login.headers.getSetCookie().some((c) => c.startsWith("wordpress_logged_in_")),
          "WordPress admin login failed",
        );
        const php = (code: string) =>
          exec(
            "wordpress",
            "su -s /bin/sh www-data -c " +
              quote("php -r " + quote("require '/var/www/html/wp-load.php'; " + code)),
          );
        await php(`update_option('openship_smoke', '${marker}');`);
        const changedPassword = randomBytes(32).toString("hex");
        await php(
          `wp_set_password('${changedPassword}', get_user_by('login', getenv('OPENSHIP_ADMIN_USER'))->ID);`,
        );
        await exec(
          "wordpress",
          `printf '%s' '${marker}' > /var/www/html/wp-content/openship-smoke`,
        );
        await replace();
        assert(
          (await php("echo get_option('openship_smoke');")) === marker,
          "WordPress content did not persist",
        );
        assert(
          (await exec("wordpress", "cat /var/www/html/wp-content/openship-smoke")) === marker,
          "WordPress uploaded files did not persist",
        );
        assert(
          (await loginAs(changedPassword)).headers
            .getSetCookie()
            .some((c) => c.startsWith("wordpress_logged_in_")),
          "WordPress reset the administrator's changed password on redeploy",
        );
        assert(
          !(await loginAs(env("wordpress", "OPENSHIP_ADMIN_PASSWORD"))).headers
            .getSetCookie()
            .some((c) => c.startsWith("wordpress_logged_in_")),
          "WordPress restored the initial administrator password",
        );
        break;
      }
      case "odoo": {
        const login = await request("odoo", "/web/session/authenticate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "call",
            params: {
              db: "odoo",
              login: env("odoo", "OPENSHIP_ADMIN_EMAIL"),
              password: env("odoo", "OPENSHIP_ADMIN_PASSWORD"),
            },
          }),
        });
        assert(((await login.json()) as any).result?.uid, "Odoo administrator login failed");
        await exec(
          "odoo-db",
          `psql -U odoo -d odoo -c "INSERT INTO ir_config_parameter (key, value) VALUES ('openship_smoke', '${marker}')"`,
        );
        await exec("odoo", `printf '%s' '${marker}' > /var/lib/odoo/openship-smoke`);
        await replace();
        assert(
          (await exec(
            "odoo-db",
            "psql -U odoo -d odoo -Atc \"SELECT value FROM ir_config_parameter WHERE key = 'openship_smoke'\"",
          )) === marker,
          "Odoo database did not persist",
        );
        assert(
          (await exec("odoo", "cat /var/lib/odoo/openship-smoke")) === marker,
          "Odoo filestore volume did not persist",
        );
        break;
      }
      case "postgresql": {
        const appSql = (sql: string) =>
          exec(
            "postgres",
            'PGPASSWORD="$OPENSHIP_APP_PASSWORD" psql -h 127.0.0.1 -U app -d app -Atc ' +
              quote(sql),
          );
        assert(
          (await appSql(
            "SELECT rolsuper::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text FROM pg_roles WHERE rolname = current_user",
          )) === "false|false|false",
          "PostgreSQL application connection has administrative privileges",
        );
        const page = await request("pgadmin", "/login");
        const body = await page.text();
        const csrf =
          inputValue(body, "csrf_token") ?? /"csrfToken"\s*:\s*"([^"]+)"/.exec(body)?.[1];
        if (!csrf)
          await writeFile(join(tmpdir(), "openship-pgadmin-login-form.html"), body, {
            mode: 0o600,
          });
        assert(csrf, "pgAdmin login did not provide a CSRF token");
        const login = await request("pgadmin", "/login", {
          method: "POST",
          redirect: "manual",
          headers: {
            Cookie: page.headers
              .getSetCookie()
              .map((c) => c.split(";")[0])
              .join("; "),
            "Content-Type": "application/json",
            "X-CSRFToken": csrf,
          },
          body: JSON.stringify({
            email: env("pgadmin", "PGADMIN_DEFAULT_EMAIL"),
            password: env("pgadmin", "PGADMIN_DEFAULT_PASSWORD"),
          }),
        });
        const cookies = new Map(
          [...page.headers.getSetCookie(), ...login.headers.getSetCookie()].map((c) => {
            const pair = c.split(";")[0]!;
            return [pair.split("=")[0], pair] as const;
          }),
        );
        const browser = await request("pgadmin", "/browser/", {
          redirect: "manual",
          headers: { Cookie: [...cookies.values()].join("; ") },
        });
        assert(
          browser.status === 200 && !browser.headers.get("Location"),
          "pgAdmin administrator login failed (HTTP " + login.status + ")",
        );
        await appSql(
          `CREATE TABLE openship_smoke (value text); INSERT INTO openship_smoke VALUES ('${marker}')`,
        );
        await replace();
        assert(
          (await appSql("SELECT value FROM openship_smoke")) === marker,
          "PostgreSQL data did not persist",
        );
        break;
      }
      case "mariadb": {
        const page = await request("adminer", "/");
        const form = await page.text();
        const token = inputValue(form, "token");
        assert(token, "Adminer login did not provide a CSRF token");
        const login = await request("adminer", "/", {
          method: "POST",
          redirect: "manual",
          headers: {
            Cookie: page.headers
              .getSetCookie()
              .map((c) => c.split(";")[0])
              .join("; "),
          },
          body: new URLSearchParams({
            token,
            "auth[driver]": "server",
            "auth[server]": "MariaDB",
            "auth[username]": "openship",
            "auth[password]": env("mariadb", "MARIADB_PASSWORD"),
            "auth[db]": "app",
          }),
        });
        assert(
          [302, 303].includes(login.status) &&
            login.headers.get("Location")?.includes("username=openship"),
          "Adminer database login failed (HTTP " + login.status + ")",
        );
        await exec(
          "mariadb",
          `mariadb -u openship -p"$MARIADB_PASSWORD" app -e "CREATE TABLE openship_smoke (value text); INSERT INTO openship_smoke VALUES ('${marker}')"`,
        );
        await replace();
        assert(
          (await exec(
            "mariadb",
            "mariadb -N -s -u openship -p\"$MARIADB_PASSWORD\" app -e 'SELECT value FROM openship_smoke'",
          )) === marker,
          "MariaDB data did not persist",
        );
        break;
      }
      case "rabbitmq": {
        const headers = {
          Authorization: basic("openship", env("rabbitmq", "RABBITMQ_DEFAULT_PASS")),
          "Content-Type": "application/json",
        };
        assert(
          (await request("rabbitmq", "/api/overview")).status === 401,
          "RabbitMQ permits unauthenticated administration",
        );
        assert(
          (await request("rabbitmq", "/api/overview", { headers })).ok,
          "RabbitMQ administrator login failed",
        );
        assert(
          (
            await request("rabbitmq", "/api/queues/openship/smoke", {
              method: "PUT",
              headers,
              body: JSON.stringify({ durable: true, auto_delete: false, arguments: {} }),
            })
          ).ok,
          "RabbitMQ queue creation failed",
        );
        const published = await request("rabbitmq", "/api/exchanges/openship/amq.default/publish", {
          method: "POST",
          headers,
          body: JSON.stringify({
            properties: { delivery_mode: 2 },
            routing_key: "smoke",
            payload: marker,
            payload_encoding: "string",
          }),
        });
        assert(((await published.json()) as any).routed, "RabbitMQ did not route the message");
        await replace();
        const message = await request("rabbitmq", "/api/queues/openship/smoke/get", {
          method: "POST",
          headers,
          body: JSON.stringify({
            count: 1,
            ackmode: "ack_requeue_true",
            encoding: "auto",
            truncate: 1000,
          }),
        });
        assert(
          ((await message.json()) as any)[0]?.payload === marker,
          "RabbitMQ persistent message did not survive replacement",
        );
        break;
      }
      case "authentik": {
        // Check the actual stored password with Authentik's own Django API;
        // the web UI uses this same authentication backend.
        const result = await exec(
          "authentik-worker",
          'ak shell -c \'import os; from authentik.core.models import User; u=User.objects.get(username="akadmin"); assert u.check_password(os.environ["AUTHENTIK_BOOTSTRAP_PASSWORD"]); print("admin-ok")\'',
        );
        assert(result.includes("admin-ok"), "Authentik bootstrap login failed");
        assert(
          (await request("authentik", "/if/flow/default-authentication-flow/")).ok,
          "Authentik login page is unavailable",
        );
        await exec(
          "authentik-db",
          `psql -U authentik -d authentik -c "CREATE TABLE openship_smoke (value text); INSERT INTO openship_smoke VALUES ('${marker}')"`,
        );
        await replace();
        assert(
          (await exec(
            "authentik-db",
            "psql -U authentik -d authentik -Atc 'SELECT value FROM openship_smoke'",
          )) === marker,
          "Authentik data did not persist",
        );
        break;
      }
      case "nextcloud": {
        const headers = {
          Authorization: basic("admin", env("nextcloud", "NEXTCLOUD_ADMIN_PASSWORD")),
        };
        const path = "/remote.php/dav/files/admin/openship-smoke.txt";
        assert(
          (await request("nextcloud", path, { method: "PUT", headers, body: marker })).ok,
          "Nextcloud authenticated file upload failed",
        );
        assert(
          (await exec(
            "nextcloud",
            "su -s /bin/sh www-data -c 'php occ config:app:get core backgroundjobs_mode'",
          )) === "cron",
          "Nextcloud did not enable scheduled jobs",
        );
        await replace();
        assert(
          (await request("nextcloud", path, { headers })).status === 200 &&
            (await request("nextcloud", path, { headers }).then((r) => r.text())) === marker,
          "Nextcloud uploaded file did not persist",
        );
        break;
      }
    }
    console.log(app.id + ": startup, credentials, application access and persistence passed");
  } catch (error) {
    const logs: string[] = [];
    for (const [service, name] of names) {
      const output = await run("docker", ["logs", "--tail", "40", name], {
        timeout: 10_000,
        maxBuffer: 512_000,
      }).catch(() => null);
      if (output) logs.push(service + ":\n" + output.stdout + output.stderr);
    }
    const sanitized = [...config.values()]
      .filter((v) => v.length >= 24)
      .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), logs.join("\n"));
    const logPath = join(tmpdir(), "openship-catalog-smoke-" + app.id + "-failure.log");
    await writeFile(logPath, sanitized, { mode: 0o600 });
    console.error("Sanitized startup logs: " + logPath);
    throw error;
  } finally {
    operation = app.id + "/cleanup";
    for (const name of [...names.values()].reverse())
      await docker("rm", "-f", name).catch(() => {});
    for (const volume of volumes.values()) await docker("volume", "rm", volume).catch(() => {});
    for (const volume of configVolumes.values())
      await docker("volume", "rm", volume).catch(() => {});
    await docker("network", "rm", prefix).catch(() => {});
    for (const image of generatedImages) await docker("image", "rm", image).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const selected = process.argv.slice(2);
    for (const id of selected.length ? selected : OFFICIAL_APP_STACKS) {
      const app = buildCatalog().apps.find((a) => a.id === id);
      assert(
        app?.services?.length && OFFICIAL_APP_STACKS.includes(id as any),
        "Unknown smoke-test app: " + id,
      );
      console.log(id + ": testing canonical catalog stack");
      await smokeApp(app);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Catalog stack smoke failed");
    process.exitCode = 1;
  }
}
