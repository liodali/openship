#!/usr/bin/env node
/**
 * Fork patch guard — fails CI the moment one of our Podman-compatibility
 * patches stops being intact after an upstream merge.
 *
 * Run by .github/workflows/fork-sync.yml AFTER `git merge upstream/main` and
 * BEFORE anything is pushed. A structural check, not a test suite: it answers
 * one question fast — "did upstream refactor the exact code our patches
 * live in?" — with a message that names the patch, not a stack trace.
 *
 *   node scripts/fork/patch-guard.mjs
 *
 * The three Podman patches (openship-podman-compatibility.md, Option A):
 *   1. extrahosts JSON        — dockerode build request is spec-correct
 *   2. builder mode/fallback  — OPENSHIP_BUILDER_MODE + /session-404 fallback
 *   3. nginx Connection map   — $connection_upgrade instead of "upgrade"
 * Plus two fork-identity/UX patches:
 *   4. fork badge             — dashboard sidebar marks our build (fork-badge.tsx)
 *   5. folder-deploy routes   — SDK passes scan publicEndpoints to ensure + build/access
 *   6. hosted-only own domain — no synthesized *.opsh.io routes on self-hosted
 *
 * WHEN UPSTREAM ADOPTS THE SAME FIX: resolve the merge by taking THEIR version
 * and delete that check here. Every merged upstream PR shrinks the fork back
 * toward a pure mirror — this file is the ledger of what is still ours.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Anchor every path to the repo root (this script lives in scripts/fork/), so
// the guard behaves identically from CI, a monorepo package dir, or anywhere.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => {
  const abs = join(ROOT, p);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
};
const failures = [];
const check = (name, ok, hint) => {
  if (!ok) failures.push(hint ? `${name}: ${hint}` : name);
};

// ── Patch 1: extrahosts sent as a JSON array string ─────────────────────────
const dockerTs = read("packages/adapters/src/runtime/docker.ts") ?? "";
check(
  "patch 1 (extrahosts JSON)",
  dockerTs.includes("engineApiExtraHosts(ownershipHost)"),
  "docker.ts no longer routes the build's extrahosts through engineApiExtraHosts() — the bare `host:ip` form is back (Podman 400s the build).",
);
check(
  "patch 1 (no bare extrahosts)",
  !/extrahosts: `\$\{ownershipHost\}/.test(dockerTs),
  "docker.ts contains a bare `extrahosts: `${ownershipHost}:…` literal again — strict daemons reject it.",
);

// ── Patch 2: builder mode + BuildKit /session fallback ──────────────────────
const builderMode = read("packages/adapters/src/runtime/docker-builder-mode.ts") ?? "";
check(
  "patch 2 (module present)",
  builderMode.includes("isBuildKitSessionUnavailable") &&
    builderMode.includes("OPENSHIP_BUILDER_MODE"),
  "docker-builder-mode.ts is missing or no longer exports the /session-404 detector + env resolver.",
);
check(
  "patch 2 (regex tolerates the real status line)",
  // String-contains, deliberately: the needle is the literal SOURCE text of the
  // matcher (escaped for JS), which exists only in the code line — a regex test
  // would also match the prose in the doc comment, where the same words appear
  // unescaped, and pass even when the code was tampered with (found the hard way).
  builderMode.includes("docker \\/session failed: (?:HTTP\\/[\\d.]+ )?40[45]"),
  "the /session matcher no longer tolerates the 'HTTP/1.1 ' prefix upgradeRequest() emits — the fallback is dead again.",
);
check(
  "patch 2 (wired into docker.ts)",
  dockerTs.includes("isBuildKitSessionUnavailable") &&
    dockerTs.includes("resolveDockerodeBuilderMode"),
  "docker.ts no longer imports/uses the builder-mode module — no fallback, no OPENSHIP_BUILDER_MODE.",
);
check(
  "patch 2 (Podman probe wired)",
  dockerTs.includes("probeDaemonSkipsBuildKit") &&
    dockerTs.includes("daemonSupportsBuildKitSession"),
  "docker.ts no longer probes the daemon via /version before the BuildKit attempt — on Podman the doomed attempt (and its tainted-connection retry) is back.",
);
check(
  "patch 2 (fresh connection on the classic retry)",
  dockerTs.includes("useFreshBuildConnection"),
  "docker.ts no longer swaps the modem agent on the BuildKit→classic fallback — the retry reuses the aborted upload's pooled socket and ships an EMPTY context on Podman (libpod_builder 'Dockerfile: no such file').",
);
check(
  "patch 2 (env documented)",
  (read(".env.example") ?? "").includes("OPENSHIP_BUILDER_MODE"),
  ".env.example no longer documents OPENSHIP_BUILDER_MODE.",
);

// ── Patch 3: nginx Connection follows the request ───────────────────────────
const nginxTs = read("packages/adapters/src/infra/nginx.ts") ?? "";
check(
  "patch 3 (header uses the map variable)",
  nginxTs.includes("proxy_set_header Connection $connection_upgrade;"),
  "PROXY_HEADERS no longer sends `Connection $connection_upgrade` — the unconditional literal (Dart/shelf empty-POST bug) is back.",
);
check(
  "patch 3 (vhost carries its own map)",
  nginxTs.includes("EDGE_CONNECTION_UPGRADE_MAP") &&
    nginxTs.includes('serverBlock.includes("$connection_upgrade")'),
  "writeRoute no longer prepends EDGE_CONNECTION_UPGRADE_MAP to vhosts that reference the variable — confs fail openresty -t on older edge images.",
);
check(
  "patch 3 (map defined once, shared)",
  (read("packages/adapters/src/infra/openresty-lua.ts") ?? "").includes(
    "EDGE_CONNECTION_UPGRADE_MAP",
  ),
  "EDGE_CONNECTION_UPGRADE_MAP vanished from openresty-lua.ts.",
);
check(
  "patch 3 (baked conf regenerated)",
  (read("apps/edge/nginx.conf") ?? "").includes("map $http_upgrade $connection_upgrade {"),
  "apps/edge/nginx.conf no longer defines the map — regenerate with `bun run edge:conf` in packages/adapters.",
);

// ── Patch 6: the platform's own (*.opsh.io) domain is hosted-only ────────────
// Self-hosted boxes without HOST_DOMAIN must not have free *.opsh.io routes
// synthesized next to the user's custom domain — the routing base falls back
// to CLOUD_DOMAIN, an edge this box never serves. Gated by
// managedFreeRoutingAvailable() at every synthesis site.
const routingDomainsTs = read("packages/platform/src/engine/lib/routing-domains.ts") ?? "";
const publicEndpointsTs = read("packages/platform/src/engine/lib/public-endpoints.ts") ?? "";
check(
  "patch 6 (own domain is hosted-only)",
  routingDomainsTs.includes("export function managedFreeRoutingAvailable") &&
    routingDomainsTs.includes("if (!usesManagedRouting || !managedFreeRoutingAvailable()) return null;") &&
    publicEndpointsTs.includes("managedFreeRoutingAvailable"),
  "the managed-free-routing gate vanished — synthesized *.opsh.io routes are back next to users' custom domains on self-hosted boxes (routing-domains.ts / public-endpoints.ts).",
);

// ── Patch 5: folder-deploy carries declared domains to the deploy API ────────
// The SDK's source workflow dropped the scan's publicEndpoints, so a
// self-hosted `openship deploy --folder` with declared domains 403'd at the
// Cloud preflight ("Connect Openship Cloud to use a free subdomain").
const sourceWorkflowTs = read("packages/sdk/src/source-workflow.ts") ?? "";
check(
  "patch 5 (folder-deploy passes publicEndpoints)",
  sourceWorkflowTs.includes("publicEndpoints.map(buildAccessEndpoint)") &&
    sourceWorkflowTs.includes("...(publicEndpoints?.length ? { publicEndpoints } : {})") &&
    sourceWorkflowTs.includes("webSingleApp"),
  "source-workflow.ts no longer forwards the scan's publicEndpoints to projects/ensure + deployments/build/access, or lost the single-app web-workload derivation — self-hosted folder deploys fail the Cloud preflight / the static-port preflight again.",
);

// ── Patch 4: fork badge visible in the dashboard sidebar ────────────────────
// Not a Podman patch — a fork IDENTITY marker. The daily worker's promise is
// "you can always tell you're on our build"; an upstream sidebar refactor that
// silently drops the badge breaks that promise, so it gets the same guard.
const sidebarTsx = read("apps/dashboard/src/components/sidebar.tsx") ?? "";
check(
  "patch 4 (fork badge in sidebar)",
  read("apps/dashboard/src/components/fork-badge.tsx") !== null &&
    sidebarTsx.includes('from "@/components/fork-badge"'),
  "the sidebar no longer mounts ForkBadge — an upstream refactor of the sidebar header dropped our fork marker (apps/dashboard/src/components/fork-badge.tsx).",
);

if (failures.length > 0) {
  console.error("\n✖ fork patch guard: a patch no longer looks intact after the merge.\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nEither fix the merge (keep our side where upstream merely moved code), or — if\n" +
      "upstream adopted the same fix — take THEIR version and delete that check from\n" +
      "scripts/fork/patch-guard.mjs. Nothing was pushed.\n",
  );
  process.exit(1);
}
console.log(
  "✔ fork patch guard: all six patches intact (extrahosts JSON, builder fallback, nginx Connection map, fork badge, folder-deploy endpoints, hosted-only own domain).",
);
