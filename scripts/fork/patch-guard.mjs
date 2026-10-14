#!/usr/bin/env node
/**
 * Fork patch guard — fails CI the moment one of our Podman-compatibility
 * patches stops being intact after an upstream merge.
 *
 * Run by .github/workflows/fork-sync.yml AFTER `git merge upstream/main` and
 * BEFORE anything is pushed. A structural check, not a test suite: it answers
 * one question fast — "did upstream refactor the exact code our three patches
 * live in?" — with a message that names the patch, not a stack trace.
 *
 *   node scripts/fork/patch-guard.mjs
 *
 * The three patches (openship-podman-compatibility.md, Option A):
 *   1. extrahosts JSON        — dockerode build request is spec-correct
 *   2. builder mode/fallback  — OPENSHIP_BUILDER_MODE + /session-404 fallback
 *   3. nginx Connection map   — $connection_upgrade instead of "upgrade"
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
  "✔ fork patch guard: all three patches intact (extrahosts JSON, builder fallback, nginx Connection map).",
);
