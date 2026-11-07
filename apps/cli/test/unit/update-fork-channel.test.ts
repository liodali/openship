import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The fork update channel: a `*-fork.N` build must resolve + install from the
 * fork's GitHub releases (never `openship@latest` from npm — upstream's
 * package, which silently drops the fork SDK), and must SAY IT when upstream
 * has moved past the fork's base version (the in-CLI twin of fork-drift.yml).
 *
 * Everything with I/O or globals is mocked; the version math itself lives in
 * @repo/core (updates/fork.test.ts). ok/info/err write to process.stderr
 * (see lib/output.ts), so that's what's captured.
 */

const forkChannel = vi.hoisted(() => ({
  resolveForkLatest: vi.fn(),
  checkUpstreamDrift: vi.fn(),
  forkStableInstallUrl: () =>
    "https://github.com/liodali/openship/releases/download/cli-latest/openship-cli-fork.tgz",
  FORK_REPO: "liodali/openship",
}));

const spawn = vi.hoisted(() => vi.fn(() => ({ status: 0 })));

vi.mock("../../src/lib/fork-channel", () => forkChannel);
vi.mock("node:child_process", () => ({ spawnSync: spawn }));
vi.mock("../../src/lib/service", () => ({
  restart: vi.fn(() => ({ restarted: true })),
  selfInvocation: vi.fn(() => ({ runtime: process.execPath, args: [process.execPath] })),
}));
vi.mock("../../src/lib/compose", () => ({
  readInstallMethod: vi.fn(() => null),
  composeUpdate: vi.fn(),
}));
vi.mock("../../src/lib/source-install", () => ({
  readSourceInstall: vi.fn(() => null),
  rebuildFromSource: vi.fn(),
  remoteSha: vi.fn(),
}));
vi.mock("../../src/lib/cli-install", () => ({
  readCliInstall: vi.fn(() => null),
  writeCliInstall: vi.fn(),
}));
vi.mock("../../src/lib/compose-env", () => ({
  readComposeEnvFile: vi.fn(() => ({ env: {}, unreadable: null })),
}));

import { updateCommand } from "../../src/commands/update";

function run(args: string[]) {
  return updateCommand.parseAsync(args, { from: "user" });
}

function stderrText(): string {
  return (spawn.stderrWrite as unknown as string[]).join("\n");
}

describe("openship update — fork channel", () => {
  let writes: string[];

  beforeEach(() => {
    vi.stubGlobal("__CLI_VERSION__", "0.9.10-fork.3");
    writes = [];
    spawn.mockClear();
    spawn.stderrWrite = writes as unknown;
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    forkChannel.resolveForkLatest.mockReset();
    forkChannel.checkUpstreamDrift.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("--check reports a fork update as available", async () => {
    forkChannel.resolveForkLatest.mockResolvedValue({
      tag: "cli-0.9.11-fork.1-deadbeef",
      version: "0.9.11-fork.1",
      assetUrl:
        "https://github.com/liodali/openship/releases/download/cli-0.9.11-fork.1-deadbeef/openship-cli.tgz",
    });
    forkChannel.checkUpstreamDrift.mockResolvedValue({ upstream: "0.9.11", ahead: false });
    await run(["--check"]);
    expect(stderrText()).toContain("Fork update available: v0.9.10-fork.3 → v0.9.11-fork.1");
  });

  it("--check stays quiet when the fork is current", async () => {
    forkChannel.resolveForkLatest.mockResolvedValue({
      tag: "cli-0.9.10-fork.3-abc0000",
      version: "0.9.10-fork.3",
      assetUrl: "https://example/openship-cli.tgz",
    });
    forkChannel.checkUpstreamDrift.mockResolvedValue({ upstream: "0.9.10", ahead: false });
    await run(["--check"]);
    expect(stderrText()).toContain("Up to date on the fork channel (v0.9.10-fork.3)");
  });

  it("notifies when upstream has moved past the fork", async () => {
    forkChannel.resolveForkLatest.mockResolvedValue({
      tag: "cli-0.9.10-fork.3-abc0000",
      version: "0.9.10-fork.3",
      assetUrl: "https://example/openship-cli.tgz",
    });
    forkChannel.checkUpstreamDrift.mockResolvedValue({ upstream: "0.9.11", ahead: true });
    await run(["--check"]);
    const out = stderrText();
    expect(out).toContain("Upstream Openship v0.9.11 is out");
    expect(out).toContain("an upstream build would drop the fork changes");
  });

  it("installs from the fork release URL, never npm's openship@latest", async () => {
    const assetUrl =
      "https://github.com/liodali/openship/releases/download/cli-0.9.11-fork.1-deadbeef/openship-cli.tgz";
    forkChannel.resolveForkLatest.mockResolvedValue({
      tag: "cli-0.9.11-fork.1-deadbeef",
      version: "0.9.11-fork.1",
      assetUrl,
    });
    forkChannel.checkUpstreamDrift.mockResolvedValue({ upstream: "0.9.11", ahead: false });
    await run(["--via", "npm"]);
    const call = spawn.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("install"),
    );
    expect(call).toBeTruthy();
    const ref = (call![1] as string[]).at(-1);
    expect(ref).toBe(assetUrl);
    expect(ref).not.toMatch(/^openship@/);
  });

  it("fails legibly when the fork has published no releases", async () => {
    forkChannel.resolveForkLatest.mockResolvedValue(null);
    await run(["--check"]);
    const out = stderrText();
    expect(out).toContain("No fork CLI releases found on liodali/openship");
    expect(out).toContain("cli-latest/openship-cli-fork.tgz");
  });
});
