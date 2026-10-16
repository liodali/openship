# OpenShip × Podman — build fails after the BuildKit→classic fallback

> **STATUS: fixed in fork main 2026-10-16** — see
> `openship-podman-compatibility.md` patch 2, addendum "Fix 2026-10-16":
> (a) `/version` probe skips the BuildKit attempt on Podman outright,
> (b) the reactive fallback retry uses a never-pooled connection.
> §6 (CLI folder-deploy `publicEndpoints`) fixed in the SDK's
> `deploySourceWorkflow`. Both guarded by `scripts/fork/patch-guard.mjs`.

Repo: `liodali/openship` (fork), running images
`gitea.dev.adetify.com/medali/openship-{api,dashboard,edge}:0.9.2`
Host: `185.182.184.116` (rootless Podman 5.8.2, SELinux enforcing), self-hosted,
compose install in `~/.openship/compose`.

---

## TL;DR

The podman **BuildKit→classic fallback works** (it is the fix already shipped in
`docker-builder-mode.ts`). But the **classic retry then receives an empty build
context**, so Podman reports:

```
stat /var/tmp/libpod_builder<N>/build/Dockerfile: no such file or directory
```

Everything *upstream* of the build request is correct — context dir, packed tar,
and Podman itself all build the exact same input when called directly. The
failure is specific to the **second (classic) attempt after the first (BuildKit)
attempt is aborted**. This is a **separate bug from the builder-mode fix**.

There is also a smaller, distinct bug in the **CLI folder-deploy** (it omits
`publicEndpoints`, so the self-hosted Cloud preflight rejects it). Both must be
fixed for `openship deploy --folder` to work on self-hosted Podman.

---

## 1. Symptom

Deploying a folder with a `# syntax=docker/dockerfile:1` Dockerfile (i.e. one
that trips `requiresBuildKit`) produces this deployment log:

```
→ Deploy target: server (server 4e78e93f) · runtime: sandboxed (Docker container)
Build strategy: docker (local Docker daemon via socket (/var/run/docker.sock))
[clone] → Preparing Docker build context...
Preparing Docker build context...
[clone] ✓ Docker build context ready (0.0 MB)
Docker build context ready (0.0 MB)
[install] ↷ Repository Dockerfile owns dependency installation
Repository Dockerfile owns dependency installation
[build] → Building image from repository Dockerfile...
Building image from repository Dockerfile...
Streaming build context to Docker daemon - image tag: openship/openship-upload-mbtu0l:bld_soqLADup_qNlzSD4
Build-cache cleanup deferred: (HTTP code 404) unexpected - Not Found
Dockerfile uses BuildKit-only syntax (RUN --mount, a syntax directive or a heredoc) — building with BuildKit.
This daemon has no BuildKit session endpoint (Podman's Docker-compat API, or dockerd without buildkit) — retrying with the classic builder.
Connected to Docker daemon. Build output follows:
stat /var/tmp/libpod_builder3400013987/build/Dockerfile: no such file or directory
Docker build failed: stat /var/tmp/libpod_builder3400013987/build/Dockerfile: no such file or directory
```

- `↷` the BuildKit attempt fails as designed (`POST /session → HTTP/1.1 404 Not Found`).
- `✓` the fallback is selected (the fix works).
- `✗` the classic retry reaches Podman, but **Podman's build context is empty**.

Note: the `Docker build context ready (0.0 MB)` line is **just rounding** — the
context is a few hundred bytes (`(333 / 1024 / 1024).toFixed(1) === "0.0"`). It
is **not** evidence of an empty context. Do not chase this number.

---

## 2. What is proven to work (so the bug is narrow)

Reproduced live on the host. All of the following succeed:

1. **Context creation** — run inside the api container against the uploaded
   source at `/tmp/openship-upload-xN2Y6Q`:

   ```ts
   const ctx = await createDockerBuildContext(cfg, { requireRepositoryDockerfile: true });
   // contextDir      = /tmp/openship-docker-context-JqHBh9
   // buildContextDir = /tmp/openship-docker-context-JqHBh9
   // dockerfileName  = Dockerfile
   // contextSubdir   = ""
   // contextEntries  = ["Dockerfile","openship.json"]
   // usesRepoDocker  = true
   // requiresBuildKit= true
   ```

2. **`packBuildContext` output** — `tar -tzvf` of the gzipped body:

   ```
   drwx------ 0/0     0 .
   -rw-r--r-- 0/0   127 Dockerfile
   -rw-r--r-- 0/0   206 openship.json
   ```

3. **Podman builds that exact tar** via the compat API:

   ```bash
   curl -s --unix-socket /run/user/1000/podman/podman.sock -X POST \
     -H "Content-Type: application/x-tar" \
     --data-binary @/tmp/probe-context.tar.gz \
     "http://d/v1.41/build?t=probe-ctx:latest&dockerfile=Dockerfile&forcerm=1"
   # → Successfully tagged probe-ctx:latest
   ```

4. **dockerode classic alone builds** (no `version`, `forcerm:true`), including
   with `labels`, `buildargs`, and `extrahosts: JSON.stringify(["…:127.0.0.1"])`
   — the same options `buildViaDockerode` passes.

Conclusion: the context, the tar, the options, and Podman are all fine in
isolation. The failure is introduced by the **two-attempt sequence**:
*BuildKit attempt fails → retry classic*.

---

## 3. Where the bug lives

File: `packages/adapters/src/runtime/docker.ts`

- `selectDockerodeBuilder()` (~line 2319) — BuildKit returns
  `{ options: { version: "2" } }`; classic (incl. `forceClassic`) returns
  `{ options: {} }`.
- `buildViaDockerode()` (~line 2437) — the retry loop:

  ```ts
  for (let attempt = 0; ; attempt++) {
    const forceClassic = attempt > 0;
    const { body, abortSignal, abort, detachCancellation, takeError } =
      packBuildContext(buildContext.buildContextDir, buildContext.contextEntries, cancelSignal, buildContext.ignoreContextPath);
    const builder = this.selectDockerodeBuilder(config, buildContext.requiresBuildKit, log, { mode, forceClassic });
    ...
    const stream = await this.docker.buildImage(body, { t: tag, dockerfile: buildContext.dockerfileName, ..., forcerm: true, ...builder.options, abortSignal });
    ...
    catch (err) {
      if (!forceClassic && mode !== "buildkit" && !contextErr &&
          builder.options.version === "2" && isBuildKitSessionUnavailable(err)) {
        log.log("This daemon has no BuildKit session endpoint ... retrying with the classic builder.", "warn");
        abort();               // <-- aborts the in-flight request / stream
        detachCancellation();
        continue;              // <-- repacks and re-issues on the SAME dockerode client
      }
      throw failure;
    }
  }
  ```

The retry re-issues on **the same `this.docker` client** immediately after
`abort()` tears down the first request. The prime suspect is **HTTP
connection reuse after the aborted BuildKit request**: the second `/build`
request goes out on a socket the daemon no longer reads correctly, so Podman
extracts **no context** and then looks for a Dockerfile that was never sent.
(Node 19+ enables `http.globalAgent` keep-alive by default; docker-modem reuses
it.) This matches every observation — direct calls work; only the
retry-after-abort fails.

A secondary suspect is the `tar-fs` pack lifecycle in `packBuildContext()`
(~line 2440): the aborted body may leave `tar-fs` mid-walk, and the re-pack in
the next iteration starts before the old walk fully tears down. Either way the
**retry's request body is empty/truncated by the time Podman reads it**.

---

## 4. Fix options (in order of preference)

### Option A — don't reuse the tainted connection on retry (minimal, robust)

Isolate the two attempts so the classic retry cannot inherit the aborted
BuildKit socket:

- On the fallback, build the retry with a **fresh Docker client** (new
  `docker-modem`/agent), or
- Force `Connection: close` on the BuildKit request so its socket is never
  pooled, or
- Give `buildViaDockerode` its own `http.Agent({ keepAlive: false })` for the
  retry attempt.

Sketch:

```ts
if (/* BuildKit-unavailable */) {
  abort(); detachCancellation();
  // Recreate the client/agent so the retry cannot reuse the aborted socket.
  this.docker = createDockerodeClient(this.dockerOptionsWithKeepAliveDisabled);
  continue;
}
```

### Option B — probe BuildKit support before the first attempt

Avoid the doomed first request entirely on Podman:

- Read `GET /version` / `GET /info` and detect Podman (e.g.
  `Components[].Name === "Podman"`, or `Platform.Name`), **or**
- Cheaply probe the session endpoint once per daemon and cache the result, then
  send `requiresBuildKit` Dockerfiles straight to the **classic** builder.

This sidesteps the abort/reuse interaction completely and removes the misleading
`/session` error from logs.

### Option C — buffer the context once

Pack the context tar **once** into a `Buffer`, and re-send the same buffer for
both attempts (with a known `Content-Length`). Removes any `tar-fs` re-walk
race and makes the retry body deterministic. Uses more memory for large
contexts, so cap/gate it.

> Recommended: **A + B**. B avoids the failure mode on Podman; A makes the
> fallback safe on any daemon where the first attempt is genuinely needed.

---

## 5. Reproduction

Self-hosted folder deploy (bypasses the CLI gate, see §6):

```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.openship/config.json')))['contexts']['default']['token'])")
API=http://127.0.0.1:4000/api
PROJECT=proj_5GTMMgsEK1nRWh2k      # any existing project
SERVER=4e78e93f-baf6-4de2-9bb7-c3e32b7d9bd0

# Dockerfile that trips requiresBuildKit
printf '# syntax=docker/dockerfile:1\nFROM alpine:3.20\nRUN echo hi\nEXPOSE 8080\nCMD ["sh","-c","sleep 3600"]\n' > Dockerfile
printf '{"framework":"docker","port":8080}\n' > openship.json
tar -czf /tmp/src.tgz Dockerfile openship.json

# 1) session → 2) upload → 3) scan → 4) ensure → 5) build
SID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT\"}" $API/projects/folder/session \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["sessionId"])')
TICKET=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT\"}" $API/projects/folder/session \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["upload"]["headers"]["x-upload-ticket"])')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "x-upload-ticket: $TICKET" \
  -H 'Content-Type: application/gzip' --data-binary @/tmp/src.tgz \
  "$API/projects/folder/upload/$SID" >/dev/null
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{}' "$API/projects/folder/scan/$SID" >/dev/null
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{
  \"projectId\":\"$PROJECT\",\"name\":\"bt\",\"framework\":\"docker\",\"gitProvider\":\"upload\",
  \"serverId\":\"$SERVER\",\"port\":8080,\"workloadType\":\"web\",\"sourceKind\":\"upload\",
  \"buildKind\":\"dockerfile\",\"productionMode\":\"host\",\"hasServer\":true,\"hasBuild\":true,
  \"publicEndpoints\":[{\"customDomain\":\"bt.example.com\",\"domainType\":\"custom\",\"port\":8080}],
  \"uploadSessionId\":\"$SID\",\"services\":[]}" "$API/projects/ensure" >/dev/null
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{
  \"projectId\":\"$PROJECT\",\"uploadSessionId\":\"$SID\",\"buildStrategy\":\"server\",
  \"serverId\":\"$SERVER\",\"environment\":\"production\",
  \"publicEndpoints\":[{\"customDomain\":\"bt.example.com\",\"domainType\":\"custom\",\"port\":\"8080\"}]}" \
  "$API/deployments/build/access"
```

Then: `openship logs <deployment_id>`.

---

## 6. Separate bug: CLI folder-deploy omits `publicEndpoints`

`openship deploy --folder` on a **self-hosted** install always fails with:

```
✖ Folder deploy failed
Connect Openship Cloud to use a free subdomain — free *.opsh.io domains route
through the Openship Cloud edge. Add a custom domain instead, or connect Cloud in Settings.
```

Cause: `packages/platform/src/engine/modules/deployments/preflight.ts`
(`resolveCloudPreflight` / `hasManagedProjectDomain`):

```ts
const hasManagedProjectDomain =
  !opts?.multiService && !hasEndpointRouting && !!opts?.slug &&
  !opts?.customDomain && usesManagedRouting;      // self-hosted server target
```

`opts.customDomain` is only satisfied when the deploy request carries
`customDomain` / `publicEndpoints`. The **dashboard wizard sends them; the CLI
does not** — `getShipClient().deploy({ source:{type:"directory"}, name,
projectId, environment, serverId, serviceIds })` in
`packages/openship/dist/index.js` (folder-deploy branch) has no endpoints, so
`build/access` 403s at `POST /api/deployments/build/access`.

The folder scan already returns the endpoints:

```json
"publicEndpoints": [
  { "customDomain": "buildtest.dev.kahuna.adetify.com", "domainType": "custom", "port": 8080 }
]
```

**Fix:** in the CLI folder-deploy, pass `publicEndpoints` (from the
`folder/scan` result, or from the parsed `openship.json` `domains`) through to
`deployments/build/access` (and to `projects/ensure`). With that, the flow
passes the gate — proven by the API reproduction in §5, which got a `200` and a
real `deployment_id`.

---

## 7. Verification (after the fix)

1. Run the §5 reproduction. Expected in `openship logs <dep>`:

   ```
   Dockerfile uses BuildKit-only syntax ... — building with BuildKit.
   This daemon has no BuildKit session endpoint ... — retrying with the classic builder.
   Connected to Docker daemon. Build output follows:
   STEP 1/4: FROM alpine:3.20
   ...
   Successfully tagged ...
   ```

   (i.e. `STEP 1/…` instead of `stat …/Dockerfile: no such file or directory`.)

2. `podman images | grep openship/` shows the built image; the deployment row in
   Postgres (`deployment.image_ref`) is set and `status='ready'`.

3. Then `openship deploy --folder` from the same directory should pass the
   preflight (§6) and complete.

4. Regression: a normal (non-BuildKit) Dockerfile still builds with the classic
   builder, and a genuine build error still fails (no infinite retry).

---

## 8. Environment

```
Podman        5.8.2 (rootless), compat socket /run/user/1000/podman/podman.sock
crun          1.27
OpenShip      fork images 0.9.2  (api 2.38 GB, dashboard 306 MB, edge 221 MB)
CLI           0.9.2 (npm)
SELinux       enforcing (api/dashboard run with security_opt: ["label=disable"])
Node/Bun      api runs under bun; node v24 on host for probes
Confirmed:    POST /session → HTTP/1.1 404 Not Found  (the trigger for the fallback)
```

---

## 9. Quick reference — exact evidence commands

```bash
# context is correct
podman exec openship_api_1 sh -lc 'cd /app && bun /tmp/probe.ts'

# packBuildContext tar contains Dockerfile
podman exec openship_api_1 sh -lc 'cd /app && bun /tmp/probe2.ts'

# the same tar builds fine when sent directly to Podman
podman cp openship_api_1:/tmp/probe-context.tar.gz /tmp/
curl -s --unix-socket /run/user/1000/podman/podman.sock -X POST \
  -H "Content-Type: application/x-tar" --data-binary @/tmp/probe-context.tar.gz \
  "http://d/v1.41/build?t=probe-ctx:latest&dockerfile=Dockerfile&forcerm=1"

# dockerode classic alone builds
podman exec openship_api_1 sh -lc 'cd /app && bun /tmp/probe3.ts'

# ONLY the two-attempt (BuildKit → classic) sequence fails
podman exec openship_api_1 sh -lc 'cd /app && bun /tmp/probe5.ts'   # hangs / fails on Podman
```
