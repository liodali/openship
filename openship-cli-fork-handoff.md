# Handoff — build, publish, and update the OpenShip **CLI** from our fork

> **STATUS: executed 2026-10-16** — Steps A–E complete. Tarball built from
> `0791aa643` + version bump commit `6a44abce2`, published as GitHub release
> `cli-0.9.2-fork.1` (public asset URL). VPS CLI now `0.9.2-fork.1`,
> SELinux template patch re-applied, `openship update --check` reports
> up-to-date (compareSemver treats `0.9.2-fork.1` == `0.9.2`, so the updater
> never reverts to the npm build). §4 e2e deferred — needs a fresh PAT
> (`openship login --token opsh_pat_…` then run §4 as written).

**Goal:** produce an `openship` CLI package built from our fork (`liodali/openship`)
so that `openship deploy --folder` uses the fixed SDK, then let the CLI update
itself from that tarball/URL.

Audience: the "main agent" (or a human) executing this on the VPS / CI.
Status of the rest of the stack: **images already deployed** (see §2). Only the
CLI is out of date.

---

## 1. Why this is needed (one paragraph)

OpenShip is a monorepo. The **CLI** is a separate build artifact from the
**container images**. Both embed the shared library `packages/sdk`. Our fix for
single-app folder deploys lives in
`packages/sdk/src/source-workflow.ts` (`webSingleApp` derivation). The CI builds
that SDK into the **images**, so the server + dashboard are fixed. But the CLI
installed here came from **npm**, which publishes **upstream** (`oblien/openship`)
— so its embedded SDK is the **old** one and `openship deploy --folder` still
derives `workloadType=static` and fails preflight. We need a CLI built from our
fork.

---

## 2. Current state (verified)

```
VPS:          185.182.184.116   (rootless Podman, SELinux enforcing)
install:      ~/.openship/compose  (podman-compose project "openship")
server images gitea.dev.adetify.com/medali/openship-{api,dashboard,edge}:0.9.2
              (moving 0.9.2 == 0.9.2-0791aa643)
              api 09f830f3d0e5 · dashboard 297f782a1727 · edge c4eb2e56eec3
registry:     gitea.dev.adetify.com  (namespace medali), login as user `medali`
CLI (now):    openship@0.9.2  installed from npm  → OLD sdk (no `webSingleApp`)
runtime:      bun 1.4.3  ·  node v24.21.0  (mise)
```

Repo facts:
- Fork: `https://github.com/liodali/openship` (upstream `oblien/openship`).
- Release commit for the deployed images: short sha **`0791aa643`**.
- CLI package dir: `packages/openship`  ·  package name **`openship`**, version **`0.9.2`**.
- Package manager declared: `bun@1.3.14`.
- CLI artifact is **not a native exe**:
  ```
  bin      : { "openship": "./dist/node-entry.js" }   # shebang: #!/usr/bin/env node
  engines  : { "node": ">=22" }
  type     : "module"
  ```
  i.e. a Node/Bun JavaScript package, installable with `npm install -g` or `bun add -g`.

---

## 3. TASK — do these in order

### Step A — build the CLI tarball from the fork

```bash
git clone https://github.com/liodali/openship.git
cd openship
git checkout 0791aa643            # the same commit the images were built from

bun install
# build the CLI + bundle the SDK + native worker
bun run build:sdk                 # == bun run --cwd packages/openship build  (runs build.ts)
#   ...or the root helper: bun run build:cli   (apps/cli build) + build:sdk

cd packages/openship
bun run check                     # build.ts --check (type/build sanity)
npm pack                          # produces  openship-0.9.2.tgz
#   (bun: `bun pm pack` also works)
ls -la ./*.tgz
```

Notes:
- `packages/openship/build.ts` does: build `apps/cli` → copy to `packages/openship/dist`,
  build `packages/platform` native worker → `dist/native/engine-worker.mjs`, then
  bundle `packages/sdk` (`index`/`native`/`client`) with tsup.
- `prepack` runs `build.ts --check`, so `npm pack` fails if the tree is stale.

### Step B — verify the fix is inside the tarball (before publishing)

```bash
mkdir -p /tmp/cli-verify && tar -xzf openship-0.9.2.tgz -C /tmp/cli-verify
# look for the fix. If the build does not minify names you'll see it directly:
grep -rc "webSingleApp" /tmp/cli-verify/package/dist/ || true
# fallback marker (port retype helper, added by the same commit):
grep -rc "serviceForDestination" /tmp/cli-verify/package/dist/ || true
```

If neither string is found, the build minified local names → verify
**behaviourally** instead (authoritative):

```bash
npm install -g ./openship-0.9.2.tgz
openship --version                 # expect 0.9.2 (or the fork's bumped version)
# then §4 end-to-end test: project row must become workloadType=web
```

### Step C — host it so the CLI can fetch it

Pick ONE. (C1 is simplest; C2 enables `openship update`.)

**C1 — direct tarball URL (no registry).**
Upload `openship-0.9.2.tgz` somewhere with a stable URL, e.g.:
- a Gitea **release asset** on `liodali/openship`, or
- your Gitea/S3 "garage" bucket, or
- any static host.
Then share the URL, e.g. `https://…/openship-0.9.2.tgz`.

**C2 — publish to a registry so `openship update` works.**
Our Gitea has an npm registry:
`https://gitea.dev.adetify.com/api/packages/medali/npm/`
```bash
# auth (Gitea PAT with package write) — NOTE: package name is unscoped `openship`
npm config set //gitea.dev.adetify.com/api/packages/medali/npm/:_authToken <PAT>
npm publish --registry https://gitea.dev.adetify.com/api/packages/medali/npm/
```
Because the name is **unscoped**, a *scoped* registry override won't apply; to
make `openship update` resolve it you must point the CLI's package manager at
that registry for the `openship` name (see Step D2). Prefer **C1** if you don't
want to change the global registry.

> Tip: bump `version` in `packages/openship/package.json` (e.g. `0.9.2-fork.1`)
> so the fork build is distinguishable from upstream `0.9.2`.

### Step D — update the CLI on the VPS

**D1 — install directly from the tarball/URL (works with C1):**
```bash
# on the VPS
npm install -g https://…/openship-0.9.2.tgz
#   or, if bun:  bun add -g https://…/openship-0.9.2.tgz
openship --version
```
This replaces the CLI without touching the server.

**D2 — make `openship update` pull from our registry (needs C2):**
`openship update` internally runs `npm install -g openship@latest` (or
`bun add -g …`) from whatever registry the package manager is configured to use.
So point npm/bun at our Gitea registry for this package, then:
```bash
export NPM_CONFIG_REGISTRY=https://gitea.dev.adetify.com/api/packages/medali/npm/
# (or a persistent ~/.npmrc entry — affects all global installs, so prefer D1/D2-with-scope)
openship update --check            # should report our version as "latest"
openship update --via npm          # or: openship update --via bun
```
> ⚠️ Changing the global npm registry affects every `npm i -g`. For a single
> package it's cleaner to use **D1** (direct tarball/URL) or a scoped name.

### Step E — re-apply the SELinux template patch (IMPORTANT)

Any CLI reinstall overwrites the bundled compose template. Re-apply it:
```bash
/home/rocky/openship-repatch.sh
# → "patched: …/dist/chunk-XXXX.js"   (adds security_opt: ["label=disable"] to the api service)
```
(Only matters if `openship up` is ever run to regenerate the compose file.)

---

## 4. End-to-end verification (proves the CLI fix)

```bash
# single-app folder with a port (the case that used to fail)
mkdir -p /tmp/cli-e2e && cd /tmp/cli-e2e
cat > Dockerfile <<'EOF'
# syntax=docker/dockerfile:1
FROM nginx:1.27-alpine
RUN echo "cli fork OK" > /usr/share/nginx/html/index.html
RUN printf 'server {\n listen 8080;\n location / { root /usr/share/nginx/html; index index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 8080
EOF
echo '{"framework":"docker","port":8080,"domains":[{"domain":"cli-e2e.dev.kahuna.adetify.com","type":"custom","port":8080}]}' > openship.json

openship login --token opsh_pat_…            # PAT from the dashboard
openship deploy --folder --name cli-e2e --watch   # or --project <existing single-app>

# expected: build succeeds AND the project row is web, not static:
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/api/projects/<id> \
  | jq '{workloadType,hasServer,hasBuild,productionMode,port}'
#  → workloadType=web  hasServer=true  hasBuild=true  productionMode=host  port=8080
```

Old (broken) behaviour: `Pre-deploy checks failed: … Static deployments cannot
expose port-targeted routes`. Fixed behaviour: build + deploy, route serves 200.

---

## 5. Gotchas

- **Runtime required:** the CLI needs Node **≥22** or **Bun**. It is not a
  standalone binary. (Bun *can* compile it: `bun build --compile dist/node-entry.js`
  if you ever want a no-runtime artifact.)
- **Version pinning:** `openship update` resolves `<version>` tags; if you publish
  a fork version, keep the same `package.json` version the updater expects, or
  install by explicit URL/tag.
- **Registry scope:** package name is unscoped `openship`; a scoped registry
  override won't catch it.
- **Do not let a reinstall silently drop the SELinux patch** — run
  `~/openship-repatch.sh` (Step E).
- **Auth:** the CLI on this box is currently **logged out** (the earlier bootstrap
  PAT was revoked). `openship login --token opsh_pat_…` before deploying.

---

## 6. Rollback

```bash
# CLI rollback to the npm/upstream build:
npm install -g openship@0.9.2
# Server-side rollback (images):
cd ~/.openship/compose
cp .env.pre-0791 .env 2>/dev/null || sed -i 's/^OPENSHIP_VERSION=.*/OPENSHIP_VERSION=0.9.2-2fd169ba7/' .env
podman-compose up -d --force-recreate api dashboard edge
```

---

## 7. Reference

| Thing | Value |
|---|---|
| Fork | `https://github.com/liodali/openship` |
| Release commit (images) | `0791aa643` |
| Fix file | `packages/sdk/src/source-workflow.ts` (`webSingleApp`, `serviceForDestination`) |
| CLI package dir | `packages/openship` (name `openship`, version `0.9.2`) |
| CLI bin | `./dist/node-entry.js` (`#!/usr/bin/env node`) |
| Engines | `node >=22` |
| Build | `bun run build:sdk` (root) / `bun run build` (in `packages/openship`) |
| Pack | `npm pack` (or `bun pm pack`) → `openship-0.9.2.tgz` |
| Gitea npm registry | `https://gitea.dev.adetify.com/api/packages/medali/npm/` |
| Gitea image registry | `https://gitea.dev.adetify.com/v2/medali/openship-{api,dashboard,edge}` |
| CLI update internals | `npm install -g openship@latest` / `bun add -g openship@latest` |
| SELinux re-patch | `/home/rocky/openship-repatch.sh` |
| Related fix brief | `/home/rocky/openship-podman-build-fix-brief.md` |
