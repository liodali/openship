# Actions runner on rootless Podman — fork changes needed

> **Status 2026-10-18 (later): all eight items are implemented on this branch**
> (P1.1–P1.4, P2.5–P2.6, P3.7–P3.8; see the "Implemented" notes per item).
> The shim-retirement gate below still applies: it needs a fork release that
> carries P1 deployed to the server first.
>
> Created 2026-10-18 after the first successful end-to-end run of the GitHub
> Actions runner on the self-hosted server (fsvger-op staging pipeline,
> `v0.0.18-staging-db` built and published). The full incident record lives in
> the fixer-svg-automater repo: `docs/openship-runner-fixes-2026-10-18.md`.
>
> Today the pipeline works because of a hand-made docker→podman shim at
> `/usr/local/bin/docker` on the server (v3). That shim is fragile — an
> `openship update`, server reinstall, or regeneration of the shim reverts it.
> This file lists the changes that absorb the shim into the fork so a normal
> release carries them. **Until a release with P1 ships, keep the shim.**

## Environment (verified)

- Server: Rocky 9, SELinux **Enforcing**, rootless Podman 5.8.2 as uid 1000
  (`rocky`), linger on. Docker-compat socket symlinked at
  `/var/run/docker.sock` → `/run/user/1000/podman/podman.sock`.
- Deployed API is our fork build: `gitea.dev.adetify.com/medali/openship-api:0.9.3`
  — fork changes reach the server through the normal build/deploy cycle.
- Runner: `Smaller OPRunner`, container mode, image
  `gitea.dev.adetify.com/medali/builder-base:latest`, labels
  `self-hosted,openship,linux,x64`, `allowDockerSocket: true`.
- The job container runs `--user <uid>:<gid>` (uid 1000). Under rootless
  podman that maps to host uid **100999** — not the worker's uid 1000.

## P1 — absorb the shim (small, safe, each independently shippable)

### 1. Podman-tolerant docker daemon probe

`packages/adapters/src/system/catalog.ts` (~line 95):

```ts
daemonCommand: "docker info --format '{{.ServerVersion}}'",
```

Podman's docker-compat CLI cannot evaluate `.ServerVersion` (exit 125, empty
output) → the server check reports docker unhealthy → the actions dispatcher
never starts jobs (this froze dispatch for hours; errors are invisible unless
`SYSTEM_DEBUG_LOGS` is on).

Proposed: try the Docker field, fall back to Podman's. `executor.exec` runs
via `sh -c`, so a fallback expression is safe:

```ts
daemonCommand:
  "docker info --format '{{.ServerVersion}}' 2>/dev/null || " +
  "docker info --format '{{.Version.Version}}'",
```

Both branches return non-empty on their respective engines; the existing
"exited 0 with no server version" unhealthy arm stays correct.
`docker-check.test.ts:168` asserts `daemonCommand` contains `ServerVersion` —
still passes. Consider a test for the fallback branch.

**Implemented** exactly as proposed (stderr of the Docker branch silenced so a
podman template error cannot become the reported failure text). Tests cover
the fallback expression string and a podman-version answer reading healthy.

### 2. Rootless UID mapping for the GitHub runner container

`packages/actions-runner/github.go` → `githubContainerArgs` (~line 284).

The worker creates the job tree `0700` as host uid 1000
(`MkdirAll(request.Directory, 0700)` line 211, runner root line 139, tar
extraction lines 166/170, `home` line 291), then runs the runner container
`--user 1000:1000`. Rootless podman maps container-1000 → host 100999, which
cannot traverse the `0700` dirs — `Runner.Listener` dies with
`Permission denied` (even `cat` fails). Docker does not have this gap because
`--user 1000:1000` maps to the same host uid there.

Proposed, in `githubContainerArgs` after the args are built:

```go
// Rootless podman maps --user <uid> to an unrelated subuid, which cannot
// traverse the worker's 0700 job directories. keep-id pins the container
// uid to the same host uid. Detected, not assumed: only podman needs it.
if isRootlessPodman() {
    args = append(args, "--userns=keep-id")
}
```

with a small `isRootlessPodman()` helper (cache the result): true when
`docker info --format '{{.Host.Security.Rootless}}'` prints `true`, or when
`docker version` client output mentions `Podman`. `--userns` is rejected by
docker only when combined with `--pid=host`/`--ipc=host`/`--cgroupns=host`,
none of which we pass, so the flag is dormant on Docker if detection errs.

Complementary (portability, not required with keep-id): create the runner
tree dirs `0755` instead of `0700` (file modes stay as extracted). Only do
this if keep-id is deemed insufficient on its own.

**Implemented.** `isRootlessPodman()` (cached once per process) answers from
`docker info --format '{{.Host.Security.Rootless}}'` == `true` OR a `docker
version` client banner mentioning `Podman`; both probes fail closed. The flag
is appended in `githubContainerArgs` before the image name, alongside the new
ICU and SELinux flags (see below). Go tests stub the detectors and script a
fake `docker`/`getenforce` on PATH to exercise the probes themselves. The
`0755` complement was NOT taken — keep-id is sufficient on the server.

### 3. .NET runner needs ICU or invariant globalization

`packages/actions-runner/github.go` → `githubContainerArgs`.

`builder-base` (Debian slim, no libicu): `Runner.Listener` execs fine, then
FailFast-exits 134 in `System.Globalization.GlobalizationMode..cctor`.

Proposed (unconditional — harmless when libicu exists):

```go
args = append(args, "--env", "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1")
```

(Alternative: require libicu in runner images and document it; the env var is
the smaller contract.)

**Implemented** unconditionally in `githubContainerArgs`, as proposed.

### 4. SELinux `connectto` on the worker Docker proxy

Same function. The job container's docker socket is the worker's ownership
proxy (server side `unconfined_t`); `container_t` processes may not `connectto`
it → `docker info` in jobs gets `permission denied` (flaky-looking because
MCS categories vary per container). The proxy comment already states "this is
resource tracking, not a security sandbox: Docker-enabled runners execute
trusted code", so disabling label confinement for the runner container is
consistent with the design:

```go
if isSELinuxEnforcing() { // getenforce == "Enforcing"
    args = append(args, "--security-opt", "label=disable")
}
```

(`container_connect_any=1` was also set on this server; keep it as belt and
braces, it is not sufficient alone.)

**Implemented.** `isSELinuxEnforcing()` (cached, `getenforce` == "Enforcing",
absent binary reads as not enforcing) adds `--security-opt label=disable` in
`githubContainerArgs`.

## P2 — operational robustness (cost real time during the incident)

### 5. Failed worker sessions poison their job

A job whose `action_runner_session` row is `finished` with an error is never
re-dispatched — every retry required cancelling and re-pushing the tag (four
times today). Where: `packages/platform/src/engine/modules/actions/github-runners.ts`
(`reserveDemand` / `queuedGitHubJobs()`). Desired: a queued job with a
finished-failed session becomes eligible again after a bounded backoff
(e.g. 3 attempts, 5 min apart), with the attempt count visible on the run.

**Implemented in `reserveRunnerSession`** (`packages/db/src/repos/action-github.repo.ts`):
the previous-session gate now allows a retry when every prior session for the
demand job is fully cleaned, fewer than `ACTIONS_RUNNER_SESSION_ATTEMPTS` (3)
sessions exist, and the most recent failed one settled at least
`ACTIONS_RUNNER_SESSION_RETRY_MS` (5 min) ago. An uncleaned session still
blocks, and the attempt cap keeps a broken destination from looping (and never
loops a paid VM). The count surfaces as `runnerAttempts` on each job in the
run view (`ActionJobSchema`; the dashboard job header shows "Dispatch attempt
N" when > 1). Covered end-to-end in `github-runners.test.ts`.

### 6. API reruns are rejected by the access policy

`POST /api/actions/runs/<id>/rerun` executes as `adetifyopenship[bot]`; with
`audience: selected` (only `liodali`) admission goes
`actor_not_allowed` and the attempt waits forever. Either allow the bot
actor for reruns it initiated, or fail the rerun loudly instead of parking
it. Where: `run-access.ts` / `github-commands.ts`.

**Implemented (allow path)** in `evaluateActionRunAdmission`: an accepted
`action_command` receipt for exactly this (workflow, remote run, attempt)
proves the attempt was initiated by our API at an already-authorized user's
request, so the bot actor skips only the audience gate — approval and fork
gates still apply, and a human rerunning directly on GitHub keeps the normal
check. This also un-parks bot-dispatched `workflow_dispatch` runs under
`selected` policies (same mechanism, same reasoning). Covered in
`run-access.test.ts`.

## P3 — nice to have

### 7. `checkedAt` is not a heartbeat

`runner.service.ts`: `checkedAt` only updates on config save or explicit
probe. A frozen value looks like an outage (it did today). Add a periodic
`probeActionRunner` sweep or rename/document the field semantics.

**Implemented (sweep).** `probeActionRunnerSweep()` in `runner.service.ts`
re-probes every enabled server-backed runner (serial, one SSH connect per
destination) and records capabilities/error/`checkedAt` with the same
contract as an explicit probe; per-runner failures land on the runner row
and never fail the pass. Wired into the actions controller tick at a 5-minute
cadence (`lifecycle.ts`). Covered in `runner.service.test.ts`.

### 8. Diagnostics defaults

The whole incident was debugged blind because sweep errors are swallowed
unless `SYSTEM_DEBUG_LOGS` is set. Consider logging dispatcher skips/failures
at warn level unconditionally (they are rare), or surface the last dispatch
error on the runner/run records.

**Implemented (both halves, cheaply).** `reserveDemand` now names dispatcher
skips through `diagnostics.warn` — which prints to the console even with the
reporter disabled — once per skip-reason *change* per job (no per-tick spam):
a parked admission state and "no enabled runner matches labels […]" (the
exact silent `continue` that froze the incident) are the two named
conditions. Run-level state was already visible via `admission.state/reason`
on the waiting run; runner-level health now also flows from the P3.7 sweep.

## What stays server-side (do NOT move into the fork)

- `/etc/systemd/system/user@.service.d/delegate.conf` — cgroup v2 cpu
  delegation for rootless podman (OS concern; runner sets `--cpus`).
- `semanage fcontext` rule labeling `~/.local/share/openship/actions` as
  `container_file_t` (absorbed by P1.4's `label=disable`, but keep the rule —
  it also covers non-disabled flows).
- `builder-base` image contents (docker.io/podman/slug packages) — that lives
  in the build-images repo on the server; workflows already select
  podman-or-docker per job (fluticon-backend-api commits `aafe477`,
  `6b620d9`, `8b7f2b0`).

## Verification checklist (from the incident, reproducible)

1. `openship server check <id>` → docker **healthy** on the podman server (P1.1).
2. Push a `v*-staging-db` tag; run dispatches without re-push (P2.5), the
   runner container starts, `Runner.Listener` registers (GitHub run shows a
   runner name), job steps execute in builder-base.
3. In-job `docker info` over the mounted proxy socket succeeds (P1.4):
   `docker ps` in a workflow step.
4. `_work` writes, checkout and build steps succeed as uid 1000 (P1.2).
5. No ICU abort in runner logs (P1.3).
6. Regression on Docker hosts: the new flags are no-ops there (probe returns
   `.ServerVersion`; detection skips keep-id/label=disable).

## Shim retirement

After a fork release with P1.1–P1.4 is deployed to the server, restore the
minimal shim (only the `ServerVersion` map can go; keep it until P1.1 is
confirmed live) — concretely: remove the actions-container flag injection
from `/usr/local/bin/docker` once jobs run green on the release, and keep
backups `docker.bak-*` for rollback.
