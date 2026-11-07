/**
 * The fork update channel — I/O counterpart of @repo/core's updates/fork.ts.
 *
 * Fork builds (`*-fork.N`, published by .github/workflows/fork-cli.yml to
 * GitHub releases on liodali/openship) resolve and install FROM THE FORK:
 *   • latest = highest `cli-<version>-<sha>` release tag (the moving
 *     `cli-latest` release carries no version in its name);
 *   • install = `npm|bun add -g <release asset URL>` — never `openship@latest`
 *     from npm, which is upstream's package and silently drops the fork SDK;
 *   • upstream (oblien/openship) is still WATCHED: when its base version moves
 *     past the fork's, the operator is told to sync — the in-CLI twin of the
 *     fork-drift GitHub workflow. Notify only; a fork machine never installs
 *     an upstream build from here.
 *
 * Images are unaffected: the post-install reconcile pulls whatever
 * `OPENSHIP_IMAGE_REGISTRY` in .env pins — the fork's Gitea registry on a
 * fork install — and fork-images.yml tags the same `*-fork.N` versions this
 * channel installs (docs/fork-maintenance.md).
 */
import { pickLatestForkReleaseTag, forkReleaseTagVersion } from "@repo/core";
import { REPO as UPSTREAM_REPO, resolveLatestTag } from "./github-releases";

export const FORK_REPO = process.env.OPENSHIP_FORK_REPO?.trim() || "liodali/openship";
const FORK_ASSET = "openship-cli.tgz";

export interface ForkLatest {
  /** Release tag, e.g. `cli-0.9.11-fork.2-cafe000`. */
  tag: string;
  /** Version embedded in the tag, e.g. `0.9.11-fork.2`. */
  version: string;
  /** Direct install URL of the release's npm-package tarball. */
  assetUrl: string;
}

/** Newest fork CLI release, or null when the fork has published none (yet). */
export async function resolveForkLatest(): Promise<ForkLatest | null> {
  const res = await fetch(`https://api.github.com/repos/${FORK_REPO}/releases?per_page=50`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "openship-cli" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Fork release lookup failed: HTTP ${res.status}`);
  const releases = (await res.json()) as Array<{
    tag_name?: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  }>;
  const tag = pickLatestForkReleaseTag(releases.map((r) => r.tag_name ?? ""));
  if (!tag) return null;
  const version = forkReleaseTagVersion(tag)!;
  const asset = releases
    .find((r) => r.tag_name === tag)
    ?.assets?.find((a) => a.name === FORK_ASSET);
  return { tag, version, assetUrl: asset?.browser_download_url ?? forkAssetUrl(tag) };
}

function forkAssetUrl(tag: string): string {
  return `https://github.com/${FORK_REPO}/releases/download/${tag}/${FORK_ASSET}`;
}

/** The stable moving install URL (cli-latest asset) — reinstall hint. */
export function forkStableInstallUrl(): string {
  return `https://github.com/${FORK_REPO}/releases/download/cli-latest/openship-cli-fork.tgz`;
}

export interface UpstreamDrift {
  upstream: string;
  /** True when upstream's base version is newer than this fork build's. */
  ahead: boolean;
}

/**
 * Best-effort upstream watch — never fatal to the update flow. Null when
 * GitHub can't be reached (the workflow-level drift watch still covers it).
 */
export async function checkUpstreamDrift(forkCurrent: string): Promise<UpstreamDrift | null> {
  try {
    const upstream = (await resolveLatestTag(UPSTREAM_REPO)).replace(/^v/, "");
    const { upstreamAheadOfFork } = await import("@repo/core");
    return { upstream, ahead: upstreamAheadOfFork(upstream, forkCurrent) };
  } catch {
    return null;
  }
}
