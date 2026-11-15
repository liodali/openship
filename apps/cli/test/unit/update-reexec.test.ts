import { describe, it, expect } from "vitest";

/**
 * `openship update` fetches the new bundle, then re-execs the freshly-fetched
 * binary to run the reconcile (`update --apply-only`) so the NEW compose template
 * / service unit lands in the same command. These pin the two subtle bits of that
 * re-exec: the argv ordering (`--json` is a ROOT option, so it must precede the
 * subcommand) and the loop guard (a re-exec'd child must never re-exec again).
 */

import { mkdtempSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOnlyArgv,
  freshInvocation,
  isReexecChild,
  REEXEC_ENV,
  targetVersionEnv,
  whichOnPath,
  TARGET_VERSION_ENV,
} from "../../src/lib/update-reexec";

describe("applyOnlyArgv", () => {
  it("appends the subcommand after the CLI's own entry args", () => {
    expect(applyOnlyArgv(["/opt/cli/dist/index.js"], false)).toEqual([
      "/opt/cli/dist/index.js",
      "update",
      "--apply-only",
    ]);
  });

  it("works for a launcher invocation with no entry args (tarball)", () => {
    expect(applyOnlyArgv([], false)).toEqual(["update", "--apply-only"]);
  });

  it("puts --json BEFORE the subcommand (root option, not `update --json`)", () => {
    const argv = applyOnlyArgv(["/opt/cli/dist/index.js"], true);
    expect(argv).toEqual([
      "/opt/cli/dist/index.js",
      "--json",
      "update",
      "--apply-only",
    ]);
    // The contract: --json must precede `update`, or the subcommand parser rejects it.
    expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("update"));
  });
});

describe("isReexecChild", () => {
  it("is true only when the sentinel env is exactly '1'", () => {
    expect(isReexecChild({ [REEXEC_ENV]: "1" })).toBe(true);
  });

  it("is false when the sentinel is unset or any other value", () => {
    expect(isReexecChild({})).toBe(false);
    expect(isReexecChild({ [REEXEC_ENV]: "0" })).toBe(false);
    expect(isReexecChild({ [REEXEC_ENV]: "true" })).toBe(false);
  });
});

describe("targetVersionEnv", () => {
  it("returns the version the fetch phase installed", () => {
    expect(targetVersionEnv({ [TARGET_VERSION_ENV]: "0.9.12-fork.1" })).toBe("0.9.12-fork.1");
  });

  it("is null when unset, and trims/ignores blank values", () => {
    expect(targetVersionEnv({})).toBeNull();
    expect(targetVersionEnv({ [TARGET_VERSION_ENV]: "  " })).toBeNull();
  });
});

describe("whichOnPath", () => {
  it("finds the first executable match on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    const bin = join(dir, "openship");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    try {
      expect(whichOnPath("openship", { PATH: "/nonexistent" + delimiterChar() + dir })).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips non-executable leftovers and returns null when nothing matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    writeFileSync(join(dir, "openship"), "not executable");
    try {
      expect(whichOnPath("openship", { PATH: dir })).toBeNull();
      expect(whichOnPath("openship", { PATH: "" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("freshInvocation", () => {
  const fallback = { runtime: "/usr/bin/bun", args: ["/old/store/openship/dist/index.js"] };

  it("prefers the PATH bin over a stale argv[1] entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    const bin = join(dir, "openship");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    try {
      const inv = freshInvocation(fallback, { PATH: dir });
      expect(inv.runtime).toBe(fallback.runtime);
      expect(inv.args[0]).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the fallback when PATH yields nothing", () => {
    expect(freshInvocation(fallback, { PATH: "/nonexistent" })).toEqual(fallback);
    expect(freshInvocation(fallback, { PATH: "" })).toEqual(fallback);
  });

  it("keeps the fallback when the PATH bin IS the fallback entry (replaced in place)", () => {
    const entry = "/usr/local/bin/openship";
    expect(freshInvocation({ runtime: "bun", args: [entry] }, { PATH: "/usr/local/bin" })).toEqual({
      runtime: "bun",
      args: [entry],
    });
  });

  // Tarball updates: the launcher takes the SUBCOMMAND directly (args []), so
  // the PATH bin must NOT become args[0] — that hand the launcher its own path
  // as a bogus first command and "update --apply-only" fails to parse.
  it("keeps the tarball launcher shape (args []) even when a bin is on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    const bin = join(dir, "openship");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const launcher = "/home/op/.openship/bin/openship";
    try {
      expect(freshInvocation({ runtime: launcher, args: [] }, { PATH: dir })).toEqual({
        runtime: launcher,
        args: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The runtime's PATH delimiter without importing a second path module here. */
function delimiterChar(): string {
  return process.platform === "win32" ? ";" : ":";
}
