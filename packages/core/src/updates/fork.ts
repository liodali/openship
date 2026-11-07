/**
 * Fork-channel update logic — the `-fork.N` version contract.
 *
 * A fork build (`0.9.11-fork.3`) must update FROM THE FORK (liodali/openship
 * GitHub releases), never from upstream npm: a plain `openship update` on a
 * fork machine installs the upstream package and silently drops the fork SDK
 * (folder-deploy, Podman tolerances — see docs/fork-maintenance.md).
 *
 * `compareSemver` strips prerelease suffixes, so `0.9.11-fork.1` and
 * `0.9.11-fork.4` compare EQUAL there — by design, against upstream. Fork →
 * fork updates need the suffix compared too, which is what lives here. Pure
 * functions only (no I/O) so the gate is unit-testable like resolve.ts.
 */

import { compareSemver } from "./semver";

/** `0.9.11-fork.3` → base "0.9.11", fork 3. Null when not a fork version. */
export interface ForkVersion {
  base: string;
  fork: number;
}

const FORK_VERSION_RE = /^v?(\d+\.\d+\.\d+)-fork\.(\d+)$/;

/** Is this a fork build version (`*-fork.N`)? */
export function isForkVersion(version: string): boolean {
  return FORK_VERSION_RE.test((version ?? "").trim());
}

/** Parse `X.Y.Z-fork.N`; null for upstream versions or garbage. */
export function parseForkVersion(version: string): ForkVersion | null {
  const m = FORK_VERSION_RE.exec((version ?? "").trim());
  return m ? { base: m[1]!, fork: parseInt(m[2]!, 10) } : null;
}

/**
 * -1 if a<b, 0 if equal, 1 if a>b — base version first (compareSemver), then
 * the fork build number. Comparing a fork version against an upstream one
 * (`0.9.12` vs `0.9.11-fork.3`) works: the upstream side parses as fork 0, so
 * upstream `0.9.11` == fork `0.9.11-fork.0` ordering-wise, and a NEWER
 * upstream base still wins. That is the "has upstream moved past us?" check.
 */
export function compareForkVersions(a: string, b: string): number {
  const pa = parseForkVersion(a) ?? { base: stripSuffix(a), fork: 0 };
  const pb = parseForkVersion(b) ?? { base: stripSuffix(b), fork: 0 };
  const base = compareSemver(pa.base, pb.base);
  if (base !== 0) return base;
  return Math.sign(pa.fork - pb.fork);
}

function stripSuffix(v: string): string {
  return (v ?? "").trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
}

export interface ForkUpdatePlan {
  action: "install" | "up-to-date";
  channel: "fork";
  current: string;
  latest: string;
}

/** The fork-channel version gate — `resolveCliUpdatePlan`'s fork counterpart. */
export function resolveForkUpdatePlan(current: string, latest: string): ForkUpdatePlan {
  const install = !!latest && compareForkVersions(latest, current) > 0;
  return {
    action: install ? "install" : "up-to-date",
    channel: "fork",
    current,
    latest,
  };
}

/**
 * Pick the newest fork CLI release tag from a GitHub release tag list.
 * Immutable releases are `cli-<X.Y.Z(-fork.N)>-<shortsha>` (fork-cli.yml);
 * the moving `cli-latest` tag carries no version and is skipped. Invalid or
 * upstream-shaped tags are ignored — an empty list yields null.
 */
export function pickLatestForkReleaseTag(tags: readonly string[]): string | null {
  const re = /^cli-(\d+\.\d+\.\d+(?:-fork\.\d+)?)-[0-9a-f]+$/;
  let best: { tag: string; version: string } | null = null;
  for (const tag of tags) {
    const m = re.exec(tag ?? "");
    if (!m) continue;
    const version = m[1]!;
    if (!best || compareForkVersions(version, best.version) > 0) best = { tag, version };
  }
  return best?.tag ?? null;
}

/** The version embedded in a `cli-<version>-<sha>` release tag. */
export function forkReleaseTagVersion(tag: string): string | null {
  const m = /^cli-(\d+\.\d+\.\d+(?:-fork\.\d+)?)-[0-9a-f]+$/.exec(tag ?? "");
  return m?.[1] ?? null;
}

/**
 * Has upstream shipped a base version newer than this fork build's base?
 * The in-CLI counterpart of the fork-drift GitHub workflow: notify, never
 * install — a fork machine must not take an upstream build.
 */
export function upstreamAheadOfFork(upstreamLatest: string, forkCurrent: string): boolean {
  return compareForkVersions(upstreamLatest, forkCurrent) > 0;
}
