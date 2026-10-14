# Fork maintenance — the sync worker + image updates

How this fork stays a thin Podman-compatible patch layer on top of
`oblien/openship`, and how the VPS updates from OUR images instead of
`ghcr.io`. Companion to `openship-podman-compatibility.md` (the why); this is
the how. Created with the Option A patches (2026-10).

## The loop

```
                ┌────────────────────────── every day (03:23 UTC) ─────────────────────────┐
                │                                                                          │
 upstream main ─┼─► fork-sync.yml: merge ─► patch-guard ─► tsc + tests ─► push ─► images ─┼─► Gitea registry
 (oblien/openship)   (rerere replays       (3 patches      (packages/      fork main   (api, dashboard,
                      memorized fixes)      intact?)         adapters)                  edge; version tags)
                │                                                                          │
                └─ conflict or guard failure → GitHub issue, nothing pushed ───────────────┘

 VPS: openship update → CLI from npm → compose reconcile → pull gitea/<ns>/openship-*:<ver> → recreate
```

Files that make this up:

| File | Role |
|---|---|
| `.github/workflows/fork-sync.yml` | the worker: daily merge, guards, push, chain images |
| `.github/workflows/fork-images.yml` | build `openship-api/dashboard/edge` → our registry (also on manual push to main) |
| `scripts/fork/patch-guard.mjs` | structural check that the three patches survived the merge |

## One-time setup

**On the GitHub fork** (Settings → Secrets and variables → Actions):

| Name | Kind | Value |
|---|---|---|
| `FORK_REGISTRY` | secret | your registry host, e.g. `gitea.example.com` |
| `FORK_REGISTRY_USER` | secret | registry username with push rights |
| `FORK_REGISTRY_TOKEN` | secret | registry token (Gitea: a personal access token with `write:package`… on Gitea it's a regular PAT + collaborator/push rights on the package namespace) |
| `FORK_NAMESPACE` | variable (optional) | namespace under the registry; default `medali` |

Enable Actions on the fork (Actions tab → enable workflows). `schedule:` does
not fire until Actions is enabled; GitHub also pauses cron workflows after 60
days of repo inactivity — the sync's own pushes reset that clock.

**On the VPS** (once, as the rocky user):

```sh
# compose pulls must authenticate to the private registry
podman login gitea.example.com

# point the stack at our images — ~/.openship/compose/.env:
OPENSHIP_IMAGE_REGISTRY=gitea.example.com/medali
OPENSHIP_VERSION=<tag>          # e.g. 0.9.2 or 0.9.2-<shortsha>
```

`OPENSHIP_IMAGE_REGISTRY` is in the CLI's managed-but-sticky set
(`keepConfig` in `apps/cli/src/lib/compose.ts`): every `openship up` /
`openship update` regenerates `.env` but **carries it forward**. Back the file
up before the first update anyway.

## How `openship update` works against our registry

1. `openship update` updates the **CLI binary** from npm (it's plumbing —
   upstream's, not ours).
2. The new CLI re-execs and reconciles the compose install: regenerates
   compose + `.env` (registry preserved), then pulls images and recreates.
3. It repins `OPENSHIP_VERSION` in `.env` to **the CLI's version**
   (`resolveImageVersion`: explicit flag → env → CLI version). That is why the
   worker tags images with the plain upstream version from `package.json` —
   after updating to CLI 0.9.3, the pull resolves to
   `gitea.example.com/medali/openship-api:0.9.3`, i.e. **ours**.
4. If our registry doesn't have that tag yet (upstream released faster than
   the worker), `pinnedImagesReady` aborts **before touching the box**:
   "The pinned image tag isn't in the registry yet". Re-run once the worker
   has built it, or pin explicitly:
   `OPENSHIP_VERSION=0.9.2-<shortsha> openship up --compose`.

Image tags pushed by the worker:

- `<version>` — moving; what `openship update` lands on.
- `<version>-<shortsha>` — immutable; use for pins and rollback.
- `latest` — convenience, avoid pinning to it.

## Day-to-day

Nothing. The worker merges, guards, pushes, builds, and either keeps up or
files an issue. Check the Actions tab if an issue appears.

## Fixing a conflict (the issue loop)

Enable rerere in your local clone — this is the mechanism that makes repeated
conflicts a once-ever cost:

```sh
git config rerere.enabled true
```

Then:

```sh
git fetch upstream                          # oblien/openship
git merge upstream/main                     # conflicts, rerere records them
# resolve in the editor, keep OUR side where upstream only moved code;
# take THEIR side where they genuinely changed behavior
git rerere diff                             # sanity-check the resolutions
git commit
bun install && node scripts/fork/patch-guard.mjs && cd packages/adapters && bunx vitest run src/runtime/docker-builder-mode.test.ts src/runtime/docker-build-cancellation.test.ts src/infra/nginx.test.ts src/infra/edge-baked-conf.test.ts
git push origin main                        # push-trigger builds the images
gh issue close <n>
```

From now on the same file/hunk conflict auto-resolves — locally AND in the
worker (whose `.git/rr-cache` is cached across runs, so it replays anything it
has seen complete).

## When a merge breaks a patch (guard red, merge clean)

Upstream refactored around our patches:

- If they only MOVED code: re-apply our side at the new location, keep the
  guard green.
- If upstream **adopted the same fix** (the endgame): take their version,
  delete that check from `scripts/fork/patch-guard.mjs`, drop our patch. Each
  such merge shrinks the fork toward a pure mirror.

## Rollback on the VPS

```sh
podman login gitea.example.com    # if the token rotated
OPENSHIP_VERSION=0.9.2-<shortsha> openship up --compose
```

The `-<shortsha>` tags are immutable; `<version>` and `latest` move with the
worker.

## Known limits

- Images are `linux/amd64` only (the VPS is x86_64). Add a platform axis to
  `fork-images.yml` (and native arm runners, like upstream's workflow does)
  before pointing an arm box at the registry.
- The worker builds only `api`, `dashboard`, `edge` — what the VPS compose
  stack runs. `mail`/`webmail`/`cluster-tasks` can be added to the matrix.
- The worker never auto-resolves a NOVEL conflict — it stops clean and files
  an issue. Resolutions are learned from your manual merges (rerere), which
  keeps "our stuff wins" a human decision.
