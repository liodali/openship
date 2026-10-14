import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildConfig } from "../types";
import { DockerRuntime } from "./docker";
import {
  DOCKER_BUILDER_MODE_ENV,
  isBuildKitSessionUnavailable,
  resolveDockerodeBuilderMode,
} from "./docker-builder-mode";

// The module under test is deliberately tiny; these tests pin the two contracts
// the build path leans on: which mode an env var resolves to (everything else
// is "auto"), and exactly which failure shapes authorize a BuildKit→classic
// fallback. A 404 on any OTHER endpoint must never demote a build.

describe("resolveDockerodeBuilderMode", () => {
  const original = process.env[DOCKER_BUILDER_MODE_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[DOCKER_BUILDER_MODE_ENV];
    else process.env[DOCKER_BUILDER_MODE_ENV] = original;
  });

  it.each([
    [undefined, "auto"],
    ["", "auto"],
    ["  ", "auto"],
    ["auto", "auto"],
    ["AUTO", "auto"],
    [" Classic ", "classic"],
    ["buildkit", "buildkit"],
    ["podman", "auto"],
  ])("resolves %p to %p", (raw, expected) => {
    if (raw === undefined) delete process.env[DOCKER_BUILDER_MODE_ENV];
    else process.env[DOCKER_BUILDER_MODE_ENV] = raw as string;
    expect(resolveDockerodeBuilderMode()).toBe(expected);
  });
});

describe("isBuildKitSessionUnavailable", () => {
  it("matches the real raw-upgrade 404 the Bun path emits", () => {
    // Exact shape produced by upgradeRequest() in docker-exec-stream.ts: it
    // interpolates the FULL status line, so "HTTP/1.1 " sits between
    // "failed: " and the code. Verified live against Podman 5.8.2 (rootless
    // compat socket): POST /session -> "HTTP/1.1 404 Not Found".
    expect(
      isBuildKitSessionUnavailable(
        new Error("docker /session failed: HTTP/1.1 404 Not Found — Not Found"),
      ),
    ).toBe(true);
    // Tolerate a body-less status line too.
    expect(isBuildKitSessionUnavailable(new Error("docker /session failed: 404"))).toBe(true);
    // 405 — some proxies answer an unsupported upgrade that way.
    expect(
      isBuildKitSessionUnavailable(
        new Error("docker /session failed: HTTP/1.1 405 Method Not Allowed"),
      ),
    ).toBe(true);
  });

  it("matches docker-modem's dial error shape", () => {
    expect(isBuildKitSessionUnavailable(new Error("(HTTP code 404) unexpected - /session"))).toBe(
      true,
    );
  });

  it.each([
    "docker /session failed: 500 Internal Server Error",
    "docker /session failed: HTTP/1.1 500 Internal Server Error",
    "docker /session upgrade timed out after 30000ms",
    "(HTTP code 404) no such image",
    "(HTTP code 500) server error",
    "the --mount option requires BuildKit",
    "exit code 1",
    // Only a 404 on /session demotes a build — never one on another endpoint.
    "docker /container/abc/attach failed: HTTP/1.1 404 Not Found",
    "docker /exec/abc/start failed: HTTP/1.1 404 Not Found",
  ])("does not match %p", (message) => {
    expect(isBuildKitSessionUnavailable(new Error(message))).toBe(false);
  });

  it("ignores non-Error rejections", () => {
    expect(isBuildKitSessionUnavailable("docker /session failed: 404")).toBe(false);
    expect(isBuildKitSessionUnavailable(null)).toBe(false);
  });
});

// The retry itself, exercised through buildViaDockerode (the dockerode build
// path for local-socket/TCP transports): attempt 1 selects BuildKit because
// the Dockerfile needs it, the daemon 404s /session, and the SAME build must
// go out again through the classic builder. A daemon that fails the classic
// attempt too must fail the build with that error — never a retry loop.
describe("DockerRuntime buildViaDockerode BuildKit fallback", () => {
  let contextDir: string | null = null;

  afterEach(async () => {
    if (contextDir) await rm(contextDir, { recursive: true, force: true });
    contextDir = null;
  });

  function buildConfig(sessionId: string): BuildConfig {
    return {
      sessionId,
      projectId: "project-1",
      slug: "fallback-test",
      repoUrl: "https://example.com/repo.git",
      branch: "main",
      stack: "docker",
      buildImage: "",
      packageManager: "",
      installCommand: "",
      buildCommand: "",
      outputDirectory: "",
      port: 8080,
      runtimeImage: "",
      envVars: {},
      resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
      cloneOnServer: false,
    };
  }

  function makeContext(requiresBuildKit: boolean, cleanup: () => Promise<void>) {
    return {
      contextDir,
      buildContextDir: contextDir,
      contextSubdir: "",
      contextEntries: ["Dockerfile"],
      dockerfileName: "Dockerfile",
      rootDirectory: "",
      usesRepositoryDockerfile: true,
      requiresBuildKit,
      ignoreContextPath: undefined,
      cleanup,
    };
  }

  async function freshContext(requiresBuildKit: boolean) {
    contextDir = await mkdtemp(join(tmpdir(), "openship-fallback-"));
    await writeFile(join(contextDir, "Dockerfile"), "FROM scratch\n");
    const cleanup = vi.fn(async () => {});
    return { context: makeContext(requiresBuildKit, cleanup), cleanup };
  }

  function runtimeWith(buildImage: unknown) {
    const logs: Array<{ message: string; level?: string }> = [];
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime &
      Record<string, unknown>;
    Object.assign(runtime, {
      connectionOptions: {},
      transport: { kind: "socket", description: "local socket" },
      systemManager: null,
      _docker: { buildImage, listContainers: vi.fn(async () => []) },
      estimateContextSize: vi.fn(async () => 0),
      verifyImageBuilt: vi.fn(async () => {}),
      streamDockerodeBuild: vi.fn(async () => {}),
    });
    const log = { log: (message: string, level?: string) => logs.push({ message, level }) };
    const buildViaDockerode = (
      runtime as unknown as Record<string, CallableFunction>
    ).buildViaDockerode.bind(runtime) as (
      config: BuildConfig,
      ctx: unknown,
      tag: string,
      log: unknown,
    ) => Promise<void>;
    return { buildViaDockerode, log, logs };
  }

  it("retries with the classic builder when the daemon has no /session endpoint", async () => {
    const { context, cleanup } = await freshContext(true);

    const buildImage = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("docker /session failed: HTTP/1.1 404 Not Found — Not Found");
      })
      .mockImplementationOnce(async () => ({ resume: () => {} }));

    const { buildViaDockerode, log, logs } = runtimeWith(buildImage);
    await buildViaDockerode(buildConfig("session-fallback"), context, "fallback-test:tag", log);

    expect(buildImage).toHaveBeenCalledTimes(2);
    // Attempt 1 asked for BuildKit; attempt 2 did not — and, being classic, it
    // carries the ownership extra-host as a spec-correct JSON array.
    expect((buildImage.mock.calls[0] as unknown[])[1]).toMatchObject({ version: "2" });
    const second = (buildImage.mock.calls[1] as unknown[])[1] as Record<string, unknown>;
    expect(second.version).toBeUndefined();
    expect(second.extrahosts).toMatch(/^\["openship-build-[0-9a-f-]+\.invalid:127\.0\.0\.1"\]$/);
    expect(logs.some((l) => /classic builder/.test(l.message) && l.level === "warn")).toBe(true);
    // The context survived the first attempt so the retry could re-pack it,
    // and was cleaned exactly once, after the last attempt.
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("fails with the real error when the classic retry fails too", async () => {
    const { context } = await freshContext(true);

    const buildImage = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("docker /session failed: 404 Not Found");
      })
      .mockImplementationOnce(async () => {
        throw new Error("something broke in RUN");
      });

    const { buildViaDockerode, log } = runtimeWith(buildImage);
    await expect(
      buildViaDockerode(buildConfig("session-fallback-twice"), context, "fallback-test:tag2", log),
    ).rejects.toThrow("something broke in RUN");
    expect(buildImage).toHaveBeenCalledTimes(2);
  });

  it("does not retry a genuine build failure", async () => {
    const { context } = await freshContext(true);

    const buildImage = vi.fn(async () => {
      throw new Error("(HTTP code 500) server error");
    });

    const { buildViaDockerode, log } = runtimeWith(buildImage);
    await expect(
      buildViaDockerode(buildConfig("session-fallback-500"), context, "fallback-test:tag3", log),
    ).rejects.toThrow("(HTTP code 500) server error");
    expect(buildImage).toHaveBeenCalledTimes(1);
  });

  it("never selects BuildKit under OPENSHIP_BUILDER_MODE=classic, even for BuildKit-only syntax", async () => {
    const original = process.env[DOCKER_BUILDER_MODE_ENV];
    process.env[DOCKER_BUILDER_MODE_ENV] = "classic";
    try {
      const { context } = await freshContext(true);
      const buildImage = vi.fn(async () => ({ resume: () => {} }));
      const { buildViaDockerode, log, logs } = runtimeWith(buildImage);

      await buildViaDockerode(
        buildConfig("session-classic-mode"),
        context,
        "fallback-test:tag4",
        log,
      );

      expect(buildImage).toHaveBeenCalledTimes(1);
      const first = (buildImage.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
      expect(first.version).toBeUndefined();
      expect(logs.some((l) => /OPENSHIP_BUILDER_MODE=classic/.test(l.message))).toBe(true);
    } finally {
      if (original === undefined) delete process.env[DOCKER_BUILDER_MODE_ENV];
      else process.env[DOCKER_BUILDER_MODE_ENV] = original;
    }
  });

  it("honours an explicit buildkit pin: a /session 404 fails the build, no fallback", async () => {
    // A pinned build must not silently switch builders — the classic one caps
    // memory via the Engine API where BuildKit runs uncapped, so a fallback
    // under `buildkit` would change the build's resource semantics.
    const original = process.env[DOCKER_BUILDER_MODE_ENV];
    process.env[DOCKER_BUILDER_MODE_ENV] = "buildkit";
    try {
      const { context } = await freshContext(false); // plain Dockerfile — the pin forces v2
      const buildImage = vi.fn(async () => {
        throw new Error("docker /session failed: HTTP/1.1 404 Not Found — Not Found");
      });
      const { buildViaDockerode, log } = runtimeWith(buildImage);

      await expect(
        buildViaDockerode(buildConfig("session-buildkit-pin"), context, "fallback-test:tag5", log),
      ).rejects.toThrow("/session failed: HTTP/1.1 404");
      expect(buildImage).toHaveBeenCalledTimes(1);
      const first = (buildImage.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
      expect(first.version).toBe("2");
    } finally {
      if (original === undefined) delete process.env[DOCKER_BUILDER_MODE_ENV];
      else process.env[DOCKER_BUILDER_MODE_ENV] = original;
    }
  });

  it("falls back on the REAL status-line shape Podman produces", async () => {
    // End-to-end guard for the regression this fixes: the matcher must accept
    // the full "HTTP/1.1 404 Not Found" status line upgradeRequest() emits —
    // the earlier fixture ("failed: 404 …") was a shape production never makes.
    const { context } = await freshContext(true);
    const buildImage = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("docker /session failed: HTTP/1.1 404 Not Found — Not Found");
      })
      .mockImplementationOnce(async () => ({ resume: () => {} }));
    const { buildViaDockerode, log } = runtimeWith(buildImage);

    await buildViaDockerode(buildConfig("session-real-shape"), context, "fallback-test:tag6", log);

    expect(buildImage).toHaveBeenCalledTimes(2);
    expect((buildImage.mock.calls[1] as unknown[])[1]).not.toHaveProperty("version");
  });
});
