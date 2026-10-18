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
 (oblien/openship)   (rerere replays       (7 patches      (packages/      fork main   (api, dashboard,
                      memorized fixes)      intact?)         adapters)                  edge; version tags)
                │                                                                          │
                └─ conflict or guard failure → GitHub issue, nothing pushed ───────────────┘

 VPS: openship update → compose reconcile → pull gitea/<ns>/openship-*:<ver> → recreate
 CLI: npm install -g https://github.com/liodali/openship/releases/download/cli-latest/openship-cli-fork.tgz
```

Files that make this up:

| File                                | Role                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `.github/workflows/fork-sync.yml`   | the worker: daily merge, guards, push, chain images + CLI                              |
| `.github/workflows/fork-images.yml` | build `openship-api/dashboard/edge` → our registry (also on manual push to main) |
| `.github/workflows/fork-cli.yml`    | build the `openship` CLI → GitHub release assets (also on manual push to main)   |
| `scripts/fork/patch-guard.mjs`      | structural check that the seven patches survived the merge (3 Podman + fork badge + folder-deploy endpoints + hosted-only own domain + podman actions runner) |

## One-time setup

**On the GitHub fork** (Settings → Secrets and variables → Actions):

| Name                  | Kind                | Value                                                                                                                                                              |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FORK_REGISTRY`       | **variable**        | registry host, e.g. `gitea.example.com` (non-secret config — GitHub variables are the pipeline's ".env"; a committed file would leak the host in this public fork) |
| `FORK_NAMESPACE`      | variable (optional) | namespace under the registry; default `medali`                                                                                                                     |
| `FORK_REGISTRY_USER`  | **secret**          | registry username with push rights                                                                                                                                 |
| `FORK_REGISTRY_TOKEN` | **secret**          | registry token (push auth can never be public)                                                                                                                     |

Or with the `gh` CLI:

```sh
gh variable set FORK_REGISTRY   --repo liodali/openship --body "gitea.example.com"
gh variable set FORK_NAMESPACE  --repo liodali/openship --body "medali"
# push auth stays a secret — never a variable
gh secret set FORK_REGISTRY_USER  --repo liodali/openship
gh secret set FORK_REGISTRY_TOKEN --repo liodali/openship
```

If `FORK_REGISTRY` was ever created as a **secret** (pre-`45db33db` setups),
delete it after creating the variable — the workflow reads the VARIABLE only:

```sh
gh secret delete FORK_REGISTRY --repo liodali/openship
```

Local builds read the same keys from a gitignored `fork.env` — see
[Local builds](#local-builds) below.

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

## The fork CLI (GitHub releases, not npm)

The CLI is a separate artifact from the images and embeds the same `packages/sdk`.
The npm package `openship` publishes from **upstream**, so an npm-installed CLI
runs the OLD sdk — `openship deploy --folder` loses the fork fixes. The worker
therefore builds the CLI from fork main too (`fork-cli.yml`, chained after the
daily merge like the images) and publishes it as **GitHub release assets**:

- **`cli-latest`** (moving) — stable install URL, asset replaced every build:

  ```sh
  npm install -g https://github.com/liodali/openship/releases/download/cli-latest/openship-cli-fork.tgz
  ```

- **`cli-<version>-<shortsha>`** (immutable) — the versioned tarball for pins
  and rollback, same convention as the image sha tags.

Why GitHub and not the Gitea npm registry: the package name is unscoped
`openship`, so a scoped registry override can never catch it — using the Gitea
npm registry means switching a machine's GLOBAL npm registry. A release URL
installs with zero npm configuration. (Gitea = images, GitHub = CLI.)

Versioning: the CLI keeps a `-fork.N` suffix (`0.9.2-fork.1`). `compareSemver`
strips prerelease suffixes, so `openship update` — which resolves UPSTREAM
releases — sees the fork build as version-equal and never "updates" it back to
the npm one. After an upstream merge bumps the version (and loses the suffix),
`fork-cli.yml` re-appends `-fork.<run_number>` to both manifests before
building. ⚠️ When upstream ships a genuinely NEW version (0.9.3 vs 0.9.2), a
plain `openship update` on a machine WILL install the upstream npm build and
silently drop the fork SDK — reinstall from `cli-latest` after syncing.

After any CLI (re)install on the VPS, re-apply the SELinux compose-template
patch: `~/openship-repatch.sh`.

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
worker, whose `.git/rr-cache` is cached across runs. The worker completes a
fully replayed merge itself (`git commit --no-edit` after rerere stages the
memorized resolutions); it only files an issue when a **novel** conflict
remains.

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

## Local builds

The same images can be built and pushed from a laptop, no GitHub round-trip:

```sh
cp fork.env.example fork.env   # fill in the real host; gitignored (has the push token)
podman login gitea.example.com   # or put user/token in fork.env

scripts/fork/build-images.sh                 # api + dashboard + edge
scripts/fork/build-images.sh --no-push edge  # build one, don't push
scripts/fork/build-images.sh --tag 0.9.3-rc1 # custom tag
```

Tags follow the CI contract (`<version>`, `<version>-<shortsha>`, `latest`).
Local builds target `linux/amd64` (the VPS) — emulated and slow on arm64 Macs,
so CI remains the cheap path; this is for hand-pushed commits and Dockerfile
experiments.

## Public or private registry?

Gitea container registries can serve packages **publicly** (anonymous pull).
What that buys and costs:

- **Public**: the VPS (or any box) pulls without `podman login` — one less
  setup step, and `pinnedImagesReady`'s `docker manifest inspect` probe works
  anonymously. **Push always needs the token either way** — a public package
  changes nothing about CI auth. Cost: anyone who learns the hostname can pull
  your images and the registry's bandwidth is your VPS's bandwidth.
- **Private** (recommended): `podman login` once per box (the runbook above),
  and the host stays off the public internet's radar.

To go public: Gitea → package (`openship-api` etc.) → Settings → Visibility →
Public. Nothing in this repo changes — the same refs work anonymous.

## Known limits

- Images are `linux/amd64` only (the VPS is x86_64). Add a platform axis to
  `fork-images.yml` (and native arm runners, like upstream's workflow does)
  before pointing an arm box at the registry.
- The worker builds only `api`, `dashboard`, `edge` — what the VPS compose
  stack runs. `mail`/`webmail`/`cluster-tasks` can be added to the matrix.
- The worker never auto-resolves a NOVEL conflict — it stops clean and files
  an issue. Resolutions are learned from your manual merges (rerere), which
  keeps "our stuff wins" a human decision.
