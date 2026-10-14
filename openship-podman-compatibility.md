# Openship × Podman — compatibility plan (parked, revisit later)

> Created 2026-10-11. Status: staging runs on Openship with **prebuilt Gitea
> images** (GitHub Actions builds). This note captures the options for making
> Openship **build** natively on the VPS, in order of preference.
>
> **2026-10-14 — Option A implemented in the fork** (see "Option A implementation
> status" at the bottom).

## Context (verified on the server)

- VPS `185.182.184.116` (Rocky 9), **rootless Podman 5.8.2** + Docker-compat
  socket (`/run/user/1000/podman/podman.sock`), compat API reports `27.3.1`.
- Rocky repos ceiling: `podman 5.8.2-7.el9_8` — **no 6.x available**.
- Openship CLI/API/edge 0.8.2. Deploys, pulls, volumes, SSL: all work.
- **Builds fail two ways** (reproduced 2026-10-11):
  1. Classic builder → `400 []string: decode slice: expect [ or n, but found h`
     — Openship sends `extrahosts` as bare `host:ip`; the Docker Engine API
     (and Podman) expect a **JSON array string** (`["host:ip"]`). Real dockerd
     is lenient, Podman strict-parses.
  2. BuildKit (`version=2`) → `docker /session failed: 404` — BuildKit's
     session endpoint lives in *dockerd's embedded buildkit*; Podman (any 5.x)
     does not implement `/session` at all. Confirmed: `POST /session → 404`
     on the socket.
- `git` is installed on the VPS (cloning works); building is the only gap.
- Openship **SSH-transport** servers shell out to `docker build` on the CLI —
  that path works with Podman unchanged (bypasses both bugs).

## Option A — upstream contributions (recommended)

Three small, generic PRs against the Openship repo. None are
"podman-only" hacks; all are spec-correct for Docker too.

| PR | Change | Size | Why upstream accepts it |
|---|---|---|---|
| 1. Fix `extrahosts` (and other array-typed query params: `labels`, `cache-from`) | JSON-encode arrays in the dockerode build request | ~1–2 h | Docker Engine API *spec* says JSON array; current code only works because dockerd is lenient. Strict-correct for both daemons. |
| 2. Builder fallback / per-server builder mode | `builderMode: auto\|classic\|buildkit` or auto-fallback when `/session` 404s | ~2–4 h | `auto` makes BuildKit opt-in; classic path works on Podman after PR 1. No Docker behavior change. |
| 3. Nginx `Connection: upgrade` bug (ALREADY patched by us in-container) | `map $http_upgrade $connection_upgrade` in their nginx template instead of unconditional `Connection "upgrade"` | ~1 h | Currently **drops POST bodies** for Dart/shelf (and RFC-strict) apps — admin login was broken by it. Universally correct fix; can include our repro. |

Process: fork → branch → PR with reproduction (GitHub Actions runners run
Podman easily: `podman system service` exposes the compat socket) → their
review. Once merged: **zero maintenance**, native builds for everyone.

Risks: upstream cadence/priorities; they may consider Podman out of scope —
though PR 1 and 3 are correct regardless of Podman support.

## Option B — wrapper image (no fork)

`medali/openship-api-podman:0.8.x` = `FROM ghcr.io/oblien/openship-api:<ver>`
+ `sed` patch set (extrahosts serialization + nginx template) applied in
build. ~1–2 h once, ~15 min per upstream release.
Keeps our current in-container patches alive in a reproducible artifact.

## Option C — full fork (~1–3 days + permanent maintenance)

Not recommended while A/B exist. MVP scope: PR 1+2 changes, own
api/edge/dashboard images in Gitea, full deploy-mode test matrix
(repo, folder, compose, static, volumes, SSL). Then rebase forever.

## Currently live in-container patches (re-apply after `openship update`)

1. Edge nginx.conf (`openship-edge` container): `map $http_upgrade
   $connection_upgrade { default upgrade; '' ''; }` inside `http {}`.
2. Site confs (`/var/lib/openship/edge/sites-enabled/*.conf`, host-side):
   `proxy_set_header Connection $connection_upgrade;` (regenerated per
   deploy — keep the sed, or it reverts).
3. API template (`openship_api_1` container, bun runs TS directly):
   `/app/packages/adapters/src/infra/nginx.ts` line ~158.

## Even if builds work — do we want them?

VPS builds put 10–15 min of full-tilt Flutter compiles on the box that runs
Garage, PocketBase, the edge, and staging. GHA runners are free/cached. The
only UX gap today is push-to-main auto-build — a 3-line workflow trigger.

## References

- Project `fsvger-staging`: `proj__e2m_M591Pp4UMmL` (compose-stack deploy,
  NEVER `--folder`)
- Server: `4e78e93f-baf6-4de2-9bb7-c3e32b7d9bd0`
- Deploy dir: `~/Desktop/DevOps/fluticon-staging-openship/` (README = runbook)
- Auto-deploy: `web-v*-openship` tags (PAT `gha-fluticon-autodeploy2`, secret
  `OPENSHIP_TOKEN` in liodali/fluticon)

## Option A+ (chosen direction, 2026-10-11) — fork + our fixes + sync upstream

Fork `oblien/openship` → keep a thin patch layer → merge upstream regularly:

- **Patch discipline:** tiny, isolated commits on top of pristine upstream
  (extrahosts JSON, builder fallback, nginx `Connection` template). Never
  restructure upstream code — keeps merges near-conflict-free.
- **Sync cadence:** `git fetch upstream && git merge upstream/main` per
  release → CI builds `medali/openship-api-podman:<ver>` in Gitea →
  swap containers on the VPS. ~15–30 min per release.
- **Endgame:** submit the same patches upstream; each merged PR lets us
  delete one patch from the fork until it becomes a pure mirror.
- **TRAP:** `openship update` pulls the official ghcr.io images and would
  silently revert our patches — replace it with a small script that pulls
  our Gitea images and recreates the api/edge containers (plus re-apply of
  any host-side bits). Never run plain `openship update` on this server.

## Update source is ALREADY configurable (discovered 2026-10-11)

The server compose template (`~/.openship/compose/docker-compose.yml`) uses:

    image: ${OPENSHIP_IMAGE_REGISTRY:-ghcr.io/oblien}/openship-api:${OPENSHIP_VERSION:-latest}

→ set in `~/.openship/compose/.env` on the VPS:

    OPENSHIP_IMAGE_REGISTRY=gitea.dev.adetify.com/medali
    OPENSHIP_VERSION=0.8.2-podman1        # our fork tag

- Fork CI pushes `medali/openship-api`, `medali/openship-edge`,
  `medali/openship-dashboard` (same names, our registry) and updates flow
  from Gitea, not ghcr.io.
- Needs `podman login gitea.dev.adetify.com` as rocky (compose pull auth).
- Verify on first update whether `openship update` regenerates the compose
  dir and preserves `.env` (backup it first).
- Dashboard UI for these two vars = optional upstream feature PR; env file is
  the right mechanism anyway.
- This removes the earlier "openship update is forbidden" trap: with the env
  set, update pulls OUR images with OUR patches.

## Option A implementation status (2026-10-14)

All three Option-A patches are implemented in this fork's tree:

1. **extrahosts JSON** — `packages/adapters/src/runtime/docker.ts`
   (`engineApiExtraHosts`): the build request now sends
   `extrahosts=["host:127.0.0.1"]` per the Engine API spec, at both dockerode
   call sites (single build + compose batch).
2. **Builder mode / auto-fallback** — new
   `packages/adapters/src/runtime/docker-builder-mode.ts`: `auto` (default)
   falls back to the classic builder when the daemon 404s BuildKit's `/session`
   (Podman compat API); `OPENSHIP_BUILDER_MODE=classic|buildkit` pins it
   (documented in `.env.example`). The SSH/CLI path was already Podman-safe
   (probes for buildx) and is unchanged.
3. **nginx `Connection` fix** — `EDGE_CONNECTION_UPGRADE_MAP` in
   `packages/adapters/src/infra/openresty-lua.ts`; `PROXY_HEADERS` now sends
   `Connection $connection_upgrade`; each managed vhost carries the map in its
   own prelude (valid on already-deployed edge images) and the baked edge conf
   (`apps/edge/nginx.conf`, regenerated) defines it too. Verified against real
   nginx: plain requests no longer carry `Connection: upgrade`, real upgrades
   still do.

Next: push to the fork, build `openship-api`/`openship-edge` images in Gitea,
and retire the "Currently live in-container patches" 1–3 once the new images
run on the VPS.

## 2026-10-14 — sync worker + fork-registry updates built

`docs/fork-maintenance.md` is now the runbook. Mechanism:
- `.github/workflows/fork-sync.yml` — daily upstream merge (rerere replays
  learned conflict fixes), patch guard + tests, push, chain image build.
- `.github/workflows/fork-images.yml` — api/dashboard/edge → Gitea, tagged
  `<upstream-version>` (+ `-<shortsha>` immutable, `latest`) so
  `openship update`'s repin resolves to OUR registry.
- `scripts/fork/patch-guard.mjs` — fails the worker if a patch stops being
  intact; also the ledger of what is still ours vs upstream's.
