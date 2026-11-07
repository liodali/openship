import { describe, it, expect } from "vitest";
import {
  isForkVersion,
  parseForkVersion,
  compareForkVersions,
  resolveForkUpdatePlan,
  pickLatestForkReleaseTag,
  forkReleaseTagVersion,
  upstreamAheadOfFork,
} from "./fork";

describe("isForkVersion / parseForkVersion", () => {
  it("recognizes fork versions with and without a leading v", () => {
    expect(isForkVersion("0.9.11-fork.1")).toBe(true);
    expect(isForkVersion("v0.9.11-fork.42")).toBe(true);
    expect(isForkVersion("0.9.11")).toBe(false);
    expect(isForkVersion("0.9.11-fork")).toBe(false);
    expect(isForkVersion("0.9.11-fork.1+meta")).toBe(false);
    expect(isForkVersion("")).toBe(false);
  });

  it("parses base and fork number", () => {
    expect(parseForkVersion("v0.9.11-fork.7")).toEqual({ base: "0.9.11", fork: 7 });
    expect(parseForkVersion("0.9.11")).toBeNull();
  });
});

describe("compareForkVersions", () => {
  it("orders by base version first", () => {
    expect(compareForkVersions("0.9.11-fork.1", "0.9.10-fork.99")).toBe(1);
    expect(compareForkVersions("0.9.11-fork.9", "0.9.12-fork.1")).toBe(-1);
  });

  it("orders by fork number when the base is equal (unlike compareSemver)", () => {
    expect(compareForkVersions("0.9.11-fork.2", "0.9.11-fork.1")).toBe(1);
    expect(compareForkVersions("0.9.11-fork.2", "0.9.11-fork.2")).toBe(0);
  });

  it("compares a fork version against a plain upstream version", () => {
    // Same base: the fork build is ahead of the plain release, and never equal.
    expect(compareForkVersions("0.9.11-fork.1", "0.9.11")).toBe(1);
    // A genuinely newer upstream base wins — the drift signal.
    expect(compareForkVersions("0.9.12", "0.9.11-fork.3")).toBe(1);
  });
});

describe("resolveForkUpdatePlan", () => {
  it("installs only when the fork latest is strictly newer", () => {
    expect(resolveForkUpdatePlan("0.9.11-fork.1", "0.9.11-fork.2").action).toBe("install");
    expect(resolveForkUpdatePlan("0.9.11-fork.2", "0.9.11-fork.2").action).toBe("up-to-date");
    expect(resolveForkUpdatePlan("0.9.11-fork.2", "0.9.11-fork.1").action).toBe("up-to-date");
    expect(resolveForkUpdatePlan("0.9.10-fork.5", "0.9.11-fork.1").action).toBe("install");
  });
});

describe("pickLatestForkReleaseTag", () => {
  it("picks the highest version across fork and plain tags", () => {
    const tags = [
      "cli-latest",
      "cli-0.9.10-fork.3-abc1234",
      "cli-0.9.11-fork.1-deadbeef",
      "cli-0.9.11-fork.2-cafe000",
      "v0.9.11",
      "some-other-tag",
    ];
    expect(pickLatestForkReleaseTag(tags)).toBe("cli-0.9.11-fork.2-cafe000");
  });

  it("prefers a newer base over a newer fork number", () => {
    const tags = ["cli-0.9.12-fork.1-1111111", "cli-0.9.11-fork.9-2222222"];
    expect(pickLatestForkReleaseTag(tags)).toBe("cli-0.9.12-fork.1-1111111");
  });

  it("returns null for no fork releases", () => {
    expect(pickLatestForkReleaseTag(["cli-latest", "v1.0.0"])).toBeNull();
    expect(pickLatestForkReleaseTag([])).toBeNull();
  });
});

describe("forkReleaseTagVersion", () => {
  it("extracts the version from an immutable release tag", () => {
    expect(forkReleaseTagVersion("cli-0.9.11-fork.1-deadbeef")).toBe("0.9.11-fork.1");
    expect(forkReleaseTagVersion("cli-latest")).toBeNull();
  });
});

describe("upstreamAheadOfFork", () => {
  it("is true only when upstream's base moved past the fork's base", () => {
    expect(upstreamAheadOfFork("0.9.12", "0.9.11-fork.3")).toBe(true);
    expect(upstreamAheadOfFork("0.9.11", "0.9.11-fork.3")).toBe(false);
    expect(upstreamAheadOfFork("0.9.10", "0.9.11-fork.3")).toBe(false);
  });
});
