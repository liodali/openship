import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { BuildLogger, DockerRuntime, LocalExecutor, type BuildConfig } from "@repo/adapters";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

const execFileAsync = promisify(execFile);
const resources = { cpuCores: 0.25, memoryMb: 512, diskMb: 8192 };

/** Exercise the production Cloud Docker command against a real daemon. Only the
 * workspace transport is local; BuildKit, its cgroups, image loading and cleanup
 * are real. Provider namespace admission is covered by the engine tests. */
describeDockerE2E("Cloud builds use a bounded, temporary Docker worker", () => {
  let runtime: DockerRuntime;
  let root: string;
  const projectId = `cloud-capacity-e2e-${randomUUID()}`;
  const builder = `openship-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
  const worker = `buildx_buildkit_${builder}0`;
  const sibling = `${projectId}-runtime`;
  const images = new Set<string>();
  const docker = (...args: string[]) => execFileAsync("docker", args, { timeout: 120_000 });
  const inspect = async (name: string) => JSON.parse((await docker("inspect", name)).stdout)[0];

  beforeAll(async () => {
    await requireDocker();
    vi.stubEnv("DOCKER_HOST", `unix://${dockerSocketPath}`);
    vi.stubEnv("DOCKER_CONTEXT", undefined);
    // Fail rather than skip: the new driver must actually run in CI/release tests.
    await docker("buildx", "version");
    root = await mkdtemp(join(tmpdir(), "openship-cloud-build-capacity-"));
    const executor = new LocalExecutor();
    // Reap the test's local shell as the Cloud executor reaps its remote task.
    const streamExec = executor.streamExec.bind(executor);
    executor.streamExec = (command, logger, options) =>
      streamExec(command, logger, { ...options, killProcessTree: true });
    runtime = await DockerRuntime.create({ transport: "socket", executor });
    Object.assign(runtime, { connectionOptions: { transport: "cloud", executor } });
    await docker("run", "-d", "--name", sibling, "alpine:3.20", "sleep", "600");
  });

  afterAll(async () => {
    if (runtime) {
      await docker("buildx", "rm", "--force", builder).catch(() => {});
      await docker("rm", "-f", worker, sibling).catch(() => {});
      // --keep-state is correct in production; only this suite's cache is disposable.
      await docker("volume", "rm", `${worker}_state`).catch(() => {});
      for (const image of images) await docker("rmi", "-f", image).catch(() => {});
      await runtime.dispose();
    }
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function build(outcome: "success" | "failure" | "cancel", limits = resources) {
    const marker = `running-${randomUUID()}`;
    const image = `openship/capacity-e2e:${randomUUID()}`;
    images.add(image);
    await writeFile(
      join(root, "Dockerfile"),
      [
        "FROM alpine:3.20",
        // Keep a real RUN active long enough to inspect the actual worker limits.
        `RUN echo ${marker} && sleep ${outcome === "cancel" ? 60 : 3}${outcome === "failure" ? " && exit 7" : ""}`,
        'CMD ["echo", "cloud-build-capacity-ok"]',
        "",
      ].join("\n"),
    );
    const controller = new AbortController();
    const logs: string[] = [];
    // Calling the existing private command boundary avoids implementing a second
    // build runner in the test or provisioning any paid Cloud infrastructure.
    const remote = runtime as unknown as {
      buildImageOnRemote(
        config: BuildConfig,
        directory: string,
        dockerfile: string,
        tag: string,
        logger: BuildLogger,
        options: { signal: AbortSignal },
      ): Promise<void>;
    };
    const result = remote
      .buildImageOnRemote(
        { projectId, sessionId: marker, resources: limits } as BuildConfig,
        root,
        "Dockerfile",
        image,
        new BuildLogger((entry) => logs.push(entry.message)),
        { signal: controller.signal },
      )
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
    try {
      await vi.waitFor(() => expect(logs.join("\n")).toContain(marker), {
        timeout: 120_000,
        interval: 200,
      });
      const active = await inspect(worker);
      expect(active.State.Running).toBe(true);
      expect(active.HostConfig.Memory).toBe(limits.memoryMb * 1024 * 1024);
      expect(active.HostConfig.MemorySwap).toBe(limits.memoryMb * 1024 * 1024);
      expect(active.HostConfig.CpuQuota).toBe(limits.cpuCores * 100_000);
      expect(active.HostConfig.CpuPeriod).toBe(limits.cpuCores ? 100_000 : 0);
      expect((await inspect(sibling)).State.Running).toBe(true);
      if (outcome === "cancel") controller.abort();
      const finished = await result;
      if (outcome === "success") {
        expect(finished.error, logs.join("\n")).toBeNull();
        expect((await docker("run", "--rm", image)).stdout.trim()).toBe("cloud-build-capacity-ok");
      } else if (outcome === "cancel") {
        expect(finished.error).toMatchObject({ name: "BuildCancelledError" });
      } else {
        expect(finished.error).toBeInstanceOf(Error);
        expect(logs.join("\n")).toContain("exit code: 7");
      }
      expect((await docker("ps", "-aq", "--filter", `name=^/${worker}$`)).stdout.trim()).toBe("");
      expect((await inspect(sibling)).State.Running).toBe(true);
    } finally {
      controller.abort();
      await result;
    }
  }

  it.each(["success", "failure", "cancel"] as const)(
    "enforces the selected budget and removes the worker after %s",
    build,
  );
  it.each(["success", "failure", "cancel"] as const)(
    "keeps the real Cloud build worker uncapped and removes it after %s",
    outcome => build(outcome, { cpuCores: 0, memoryMb: 0, diskMb: 0 }),
  );

});
