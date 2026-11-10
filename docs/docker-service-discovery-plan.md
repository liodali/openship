# Docker service discovery through Openship Edge

Status: implementation plan; no feature code or production changes yet.

## Implementation status (updated as code lands)

- **Step 2 — DONE.** Core parser: `packages/core/src/discovery-config.ts`
  (+33 tests). Runtime view: `getDiscoveryContainerView` +
  `discoveryContainerViewFromDockerInspect` in
  `packages/adapters/src/runtime/` (+5 tests), `discoveryInspection`
  capability, `listAllNetworks` on the adapter interface for driver
  enrichment. View field names match the parser input so a view feeds
  `parseDiscoveryDeclaration` directly.
- **Step 3 — persistence DONE, API layer NOT started.** Schema:
  `packages/db/src/schema/discovery.ts` (`discovery_settings`,
  `discovery_binding`), `domain.serverId` for ownerType='server'; migration
  `drizzle/0224_server_discovery.sql` (hand-written; snapshots end at 0060 —
  follow that convention). Repo: `packages/db/src/repos/discovery.repo.ts`
  (25 tests, PGlite, also validates the migration). Issuance eligibility:
  `serverVerificationOwner` inside `liveVerificationOwner` in
  `domain.repo.ts` (server domains queue with discovery enabled + an
  observed, unsuppressed binding; project rules unchanged). Dump catalogue:
  both tables instance-scoped in `dump.ts`. Not done: contracts schemas,
  platform operations (configure/preview/status/suppress/forget with server
  access policy), controller + routes.
- **Step 4 — scanner DONE, reconciler NOT started.**
  `packages/platform/src/engine/modules/discovery/discovery-scanner.ts`
  (+13 tests): inventory → bounded inspect → parse → observe; duplicate live
  identities block all candidates; other-owner hostnames block;
  `applyState='blocked'` never auto-retries (unblock is explicit/conflict
  resolved); inspect failures leave bindings unclassified; opt-out withdraws
  (forget, domain retained); confirmed removals go missing; unchanged rescans
  converge. NOT done: Edge route apply through the shared serving-target
  primitives, server-domain target resolution, certificate scheduling
  registration, watcher/sweep wiring (step 5).
- Known pre-existing breakage at HEAD (unrelated): platform typecheck fails in
  `modules/actions/` — `repos.actions.runnerSessionCounts` and
  `appendRunnerSessionEvents` are referenced but do not exist in the actions
  repo.

Architecture correction: discovered domains are server-scoped Edge resources.
They require neither an Openship project nor a deployment/adoption record, and
do not require a manual Openship TXT ownership check. Issuance still requires
successful ACME validation. Renewal and repair run independently of deployments.
Certificate issuance and renewal require a currently running discovered container;
stop pauses them, and start triggers an immediate certificate check/reconciliation.

## Objective and first release

Discover explicitly opted-in containers on an enabled standalone Docker server,
register their hostname and container port with that server's Openship Edge,
and extend Openship's certificate lifecycle to support these server-scoped domains.
Docker Compose or the operator continues to own container lifecycle.

Tonight's deployable slice includes:

- Local Linux Docker and existing SSH-connected standalone Docker servers.
- One HTTP backend port and one custom hostname per discovered service.
- Equivalent environment-variable and Docker-label configuration.
- An optional existing Docker network selector.
- Startup inventory, lifecycle-event reconciliation, and a 60-second repair sweep.
- Persistent discovery identity, status, domain ownership, and route errors.
- Server enable/disable, list/status, and manual rescan operations.
- A small server UI for the switch, discovered services, domain/TLS status, and rescan.

Follow-up work: multiple endpoints, HTTPS backends, wildcard domains, Traefik label
compatibility, middleware, TCP/UDP, Swarm, Kubernetes, and Docker Desktop bridge routing.
No automatic network attachment or proxy takeover is part of discovery.

## Configuration contract

Environment variables:

```yaml
services:
  app:
    image: your-app:version
    environment:
      OPENSHIP_DISCOVERY: "true"
      OPENSHIP_SERVICE_ID: "my-app"
      OPENSHIP_DOMAIN: "app.example.com"
      OPENSHIP_PORT: "3000"
      OPENSHIP_NETWORK: "frontend"
    networks:
      - frontend

networks:
  frontend:
    name: frontend
```

Equivalent labels:

```yaml
labels:
  openship.discovery: "true"
  openship.service.id: "my-app"
  openship.domain: "app.example.com"
  openship.port: "3000"
  openship.network: "frontend"
```

Rules:

- Explicit opt-in is required; absent/false means undiscovered.
- Read effective container configuration from Docker inspect. Compose performs
  any `${VARIABLE}` interpolation before Openship reads the container.
- Labels and env may coexist only when overlapping values agree; reject conflicts.
- Domain and numeric container port (1–65535) are required. No port guessing.
- An explicit service ID is recommended and is mandatory for standalone containers
  without Compose identity. Otherwise use Compose project + Compose service labels.
- Identity is scoped to the server's configured organization/workspace. Containers
  cannot choose an organization, workspace, or project ID through configuration.
- Resolve an explicit network by its actual Docker name, not a Compose YAML alias.
  Missing membership is an error, never a fallback to another network.
- Without a network selector, accept one usable user-defined bridge network;
  require a selector when several are available. Reject host/none/unsupported
  topology in the first release.
- Reject duplicate live candidates for one identity; do not arbitrarily pick a
  replica. Confirm identity conflicts before mutating routes.
- Container config changes require the operator to recreate the container.
- Exclude Openship's control-plane, Edge, and build/helper containers. Initially
  exclude already managed application containers to avoid competing route owners.

## Existing integration points

- `packages/adapters/src/runtime/docker.ts`: inventory, inspect, Docker transport,
  lifecycle event stream. Current IP selection returns the first address and
  needs an explicit network-aware read API for discovery.
- `packages/platform/src/engine/modules/migration/docker-inspect.service.ts`:
  existing label-agnostic server discovery. Reuse transport/inspection primitives;
  do not invoke full migration or read Compose source files for every scan.
- `packages/db/src/schema/domain.ts`: add a server-scoped domain binding alongside
  project/mail/webhook domains. Project and service FKs remain null for discovery.
- `packages/db/src/repos/domain.repo.ts`: pending issuance eligibility currently
  uses `liveVerificationOwner`; extend its owner predicate for server domains.
- `packages/platform/src/engine/lib/routing-domains.ts`: reuse hostname conflict
  validation without requiring project ownership.
- `packages/platform/src/engine/lib/route-apply.service.ts`: canonical route writes
  to the correct serving target, including existing locking and reconciliation.
- `packages/platform/src/engine/modules/domains/project-edge.service.ts`: extract
  reusable server Edge readiness primitives from the project entry point.
- `packages/platform/src/engine/lib/domain-ssl.ts`: add server-scoped authorization
  and provider resolution; existing non-mail authorization requires a project.
- `packages/platform/src/engine/lib/ssl-scheduler.ts`: resolve server domain context
  without `projectId`, including notifications and management-access checks.
- `packages/platform/src/engine/lib/edge-vhost-repair.ts`: repair itself is already
  provider-scoped; add startup/scheduled server callers independent of deployment.
- `packages/platform/src/engine/modules/monitoring/container-events.ts`: event
  subscription/reconnect pattern. Its tracked-health-container filtering cannot
  be reused unchanged for undiscovered containers.
- `packages/platform/src/engine/lib/system-jobs.ts` and API startup/shutdown:
  repair sweep registration and watcher lifecycle.

## Architecture and server scope

```text
Server discovery enabled + assigned workspace
        |
Docker inventory / lifecycle event / scheduled rescan
        |
Inspect -> parse opt-in -> validate identity + hostname + port + network
        |
Desired discovered-service state compared with persisted observation
        |
Server-scoped discovery binding + domain record (no project or deployment)
        |
Canonical route reconciliation -> server's Openship Edge
        |
ACME validation / shared TLS jobs -> HTTPS and renewal
```

Discovered services are their own server-scoped resources, grouped by Compose
project for display only. Do not create projects, service-table rows, active
deployments, or adopted deployments to satisfy legacy APIs. Discovery exposes
route management and observations, never application lifecycle mutation operations.

Introduce one domain-target resolver with variants for existing project targets,
mail targets, existing webhook targets where applicable, and explicit server Edge
targets. A server target derives organization and management access from its stored
server record and resolves the serving Edge directly. No fallback to the API host
on a remote-server connection failure. Keep existing owner-specific behavior intact.

Extract the reusable Edge write/repair primitives below project routing wrappers.
The new server reconciler must not call a wrapper that demands an active deployment,
or fake one. Preserve provider transaction/reload behavior and domain/box locks.

Proposed additive persistence:

- Per-server discovery settings: enabled, workspace binding, sweep interval.
- Discovery bindings with unique `(serverId, stableServiceKey)`, observed container
  ID, selected network identity, desired hostname
  and port, config hash, last successful observation, desired/applied generation,
  status, sanitized error, retry state, and any user suppression/forget marker.
- Domain `ownerType = "server"`, an explicit server FK, and a discovery binding
  reference where needed. Enforce valid owner/FK combinations; do not overload
  project/service foreign keys. Workspace visibility comes from the server settings.

Determine exact columns using repository conventions in step 1. Existing projects
and domains must remain valid with discovery disabled and after application rollback.

Discovery owns only bindings it created. An existing manual or other project's
hostname is a conflict. Never repoint it based on an observed container declaration.
Do not persist complete inspected env, secrets, or raw inspection responses.

### Verification and TLS behavior

- A trusted operator enables discovery for the server. A container declaration
  can request a hostname but cannot transfer an existing domain binding.
- No manual Openship TXT ownership token is required for this server-domain flow.
  Hostname uniqueness and tenant/server authorization still apply.
- Keep separate states for configured, ACME pending, certificate active, and error.
  Do not mark a domain DNS-verified merely because it has a label or env variable.
- Make server-scoped domains eligible for initial issuance without the project
  TXT gate through an explicit owner-specific policy. Existing project checks
  remain intact. ACME success establishes certificate validation.
- Provision/renew through the shared TLS machinery and existing ACME locks. Route
  the challenge through Openship Edge while the discovered container is running.
- Issuance and renewal require an enabled persisted domain binding, its serving
  server, and a freshly confirmed running container for the stable identity.
  They never require a project or active deployment. Re-check running state before
  opening an ACME order, including jobs queued before a container stopped.
- Stopped, removed, or unobservable containers are ineligible for new ACME orders.
  Retain certificate material, expiry, and retry state without treating a deliberate
  stop as a renewal failure. Unknown inspection state defers work until a successful
  inventory; a cached running flag alone is insufficient.
- A start/replacement event triggers immediate certificate reconciliation. Reuse
  a comfortably valid certificate; renew a due/expired one, or issue a missing one,
  with the existing backoff/locks. Startup inventory and the periodic sweep cover
  missed start events. Restarting never forces an unnecessary certificate order.
- An ACME order already opened before a stop may complete; do not start further
  issuance/renewal attempts until the container is confirmed running again.
- Repair runs on startup and periodically for enabled server Edge configurations,
  including servers with zero Openship deployments and stopped application backends.
- Stored-route replay repairs existing stale config; desired-state reconciliation
  must also restore a missing route/config file from durable server domain records.
- Retain an unavailable vhost with TLS/challenge handling while a backend is absent.
  Repair may restore that unavailable vhost using existing certificate material,
  but must not trigger issuance/renewal while the backend is stopped or unobservable.
  A transient inventory failure must not erase the binding or certificate state.
- Manual disable/forget explicitly controls route retirement and renewal policy;
  absence of a deployment never does. Disabled bindings retain certificate files
  but stop automatic issuance/renewal unless separately configured to retain it.
- Failed DNS, blocked ports, ACME errors, and unreachable servers are visible retry
  states with backoff; they do not require redeploying or clicking repair.

## Implementation steps and completion checks

### 1. Prove Edge integration and lock the first-release contract

- Trace domain authorization, issuance eligibility, provider resolution, scheduled
  renewal, route repair, and cleanup for every existing domain owner type.
- Confirm Edge on the target Linux host can reach the chosen bridge IP and port.
- Prove a server-scoped record can issue/renew with no project/deployment while
  its container is running, pause ACME work while stopped, and resume on start.
- Prove Edge repair can restore an unavailable vhost without triggering an ACME order.
- Identify project-only owner predicates and garbage collection rules to extend
  so they retain server-scoped domain records and vhosts.
- Record the target instance, architecture, current release/image digest, test
  domain, DNS/challenge method, and deployment workflow before rollout.

Done: one test container can be represented without project/deployment records,
and a route can reach it through the existing Edge writer. If this fails, resolve the
integration before building watcher/UI code.

### 2. Add configuration parser and network-aware inspection

- Add a pure typed parser in core for env/label normalization and validation.
- Extend adapter read types to expose selected network ID/name/IP and running state.
- Resolve exactly the declared container port on the selected network.
- Read only required fields; redact diagnostics and bound inspection concurrency.
- Test booleans, invalid hostnames/ports, conflicting sources, missing/ambiguous
  networks, stable identity, helper exclusions, and duplicate identity.

Done: deterministic normalized declarations without Docker or database mutations.

### 3. Add server-scoped persistence and preview/status API

- Add additive schema changes and repositories for settings and binding state.
- Implement server-domain target resolution and discovery observation persistence;
  no adoption, deployment creation, or project lifecycle APIs.
- Add organization-scoped server operations for configure, preview/rescan, status,
  and forget/suppress. Respect existing server access and workspace policy.
- Preview shows create/update/conflict/remove decisions before enabling discovery.
- Add tests proving manual domains cannot be claimed and application rollback
  still works with the additive schema.

Done: observations survive restart; forgetting a service cannot delete its container,
and no project or active deployment is required by any discovery operation.

### 4. Implement idempotent reconciliation into Openship Edge

- Compute the complete desired state before making routing changes.
- Lock by serving server/domain using existing lock conventions and re-check
  generation/container identity before applying each change.
- Create/update server-scoped observations and domain binding records.
- Apply through shared serving-target Edge primitives; extend the shared TLS jobs
  and eligibility queries to accept server targets without project TXT verification.
- Register deployment-independent server repair and certificate scheduling. Gate
  new ACME orders on fresh running-container observation; do not couple unavailable
  vhost repair to certificate issuance. Validate restoration of deleted route files.
- Store pending/applied/error states independently; retry partial applies.
- Do not mark a route active merely because its database write succeeded.
- Verify upstream reachability from the serving host/Edge execution context.
- Keep HTTP challenge handling available while a certificate is pending.
- An unchanged rescan performs no route reload or new certificate order.

Done: an opted-in container gets a valid HTTPS endpoint through Openship Edge,
and unrelated vhosts remain unchanged.

### 5. Add continuous discovery and replacement handling

- Watch enabled servers with initial inventory, bounded reconnect backoff, and
  cleanup on disable, server removal, or application shutdown.
- Subscribe then inventory (or otherwise close the startup scan/event race).
- Debounce events into serialized server rescans; events are hints, inventory
  is authoritative. Run a repair sweep every 60 seconds.
- Replacement with the same stable identity updates its observed container/IP.
- Start/replacement immediately schedules the certificate check; stop/removal
  pauses pending issuance/renewal work. Re-check eligibility under the certificate
  lock before a queued job opens an order.
- Confirmed stop/removal immediately withdraws the application upstream; retain
  an owned unavailable vhost and its domain/certificate rather than serving a
  cached IP that Docker may assign to another workload.
- A short replacement grace window may delay metadata cleanup, never permit
  routing to an unconfirmed stale IP.
- Failed/incomplete inventory retains bindings and reports an error; it must not
  classify every service as removed. A confirmed disappearance is distinct.
- Domain removal/change or opt-out withdraws only discovery-owned routes. Keep
  certificate files for reuse; schedule metadata cleanup separately.
- Disable mode cancels watchers, withdraws discovery-owned application routes,
  and retains ownership/certificate metadata. A separate freeze mode is deferred.

Done: replacement, daemon/API restart, and a missed event converge without manual repair.

### 6. Add minimal dashboard and documentation

- Server settings: enable discovery, select workspace, preview, and rescan.
- List stable service name, container, hostname, port/network, observation state,
  Edge apply state, verification/TLS state, and actionable sanitized errors.
- Show discovered services under the server; no project/deployment creation is
  needed to display or manage their domain/TLS state.
- Follow `apps/dashboard/AGENTS.md` and the shared dashboard design guide.
- Document env and label examples, actual Docker network names, required DNS,
  replacing containers to change config, conflicts, and disable/forget behavior.

Done: the operator can enable and diagnose discovery without inspecting logs.

### 7. Validate the complete feature

Run focused parser/reconciler/ownership tests, affected-package typechecks, and
the repository's required release gates. Use real Docker and Openship Edge for:

1. Compose service using env and standalone service using labels.
2. Domain with no Openship TXT verification/project/deployment -> HTTP challenge
   -> valid HTTPS certificate and response.
3. Repeated scan -> no duplicate rows, proxy writes, or certificate orders.
4. Container recreation/IP change -> same identity and new reachable upstream.
5. Backend stop/removal -> unavailable response; never another container's content.
6. Network selector change/missing network -> visible error and no guessed IP.
7. Domain/port change and opt-out -> correct owned-route update/withdrawal.
8. Duplicate hostname/identity -> conflict with existing route preserved.
9. Docker/API restart and dropped event stream -> automatic convergence.
10. Server inspection failure -> retained records, no mass route deletion.
11. Discovery disabled or discovered binding forgotten -> external container still running.
12. Due certificate with no project/deployment: stopped backend -> zero new ACME
    orders and retained binding/certificate; start -> immediate renewal on the
    correct server. A valid certificate is reused without an order.
13. Concurrent replicas of the control plane -> one effective reconciliation writer.
14. Existing manual project domain and dashboard HTTPS -> unchanged and healthy.
15. Deleted route file or outdated config -> startup/periodic repair restores it
    from server-domain records without deployment or operator intervention.
16. New certificate attempt while DNS/ACME is invalid -> pending/error with retries;
    existing project ownership checks and cross-server hostname conflicts remain intact.
17. Queued renewal followed by stop, or Docker inspection failure -> deferred order;
    successful inventory after start resumes it. Repair while stopped performs no ACME work.

Use staging ACME for repeated issuance tests when supported by the existing flow;
make one real production issuance on the final test domain before declaring rollout complete.

### 8. Build, canary, and deploy tonight

- Finish implementation and gates before changing the target instance.
- Prefer a commit-specific/manual test image tag through the existing Docker image
  workflow rather than moving `latest` or creating a broad public release.
- The existing `.github/workflows/docker-images.yml` supports manual tagged
  publication and runs the release gate. Build queue/runtime is external to the
  implementation estimate. Use the target's established deployment mechanism.
- Save database backup and current image digests/configuration; verify restoration
  access. Apply only the additive migrations and release artifacts required.
- Deploy the control-plane changes with discovery disabled. Update dashboard when
  its UI changes require it. Reuse the current Edge image if its API/configuration
  contract remains sufficient; discovery lives in the control plane.
- Confirm control-plane health and existing domain HTTPS first.
- Enable discovery for one server and one test service; observe initial inventory,
  ACME validation, issuance, Edge route application, and HTTPS response without
  creating an Openship project/deployment or requesting a TXT ownership token.
- Recreate that service once and verify automatic upstream replacement.
- Enable the intended opted-in services on that server, verify every endpoint,
  and observe at least two repair sweeps without unintended writes/errors.
- Record deployed commit/digests, migration state, discovered identities/domains,
  test results, and rollback artifacts in the implementation handoff.

Done: target instance runs the release, discovery recovers a replacement container,
HTTPS works, and pre-existing domains still work.

## Rollback

- First disable discovery and withdraw its application routes using the new release.
- If the application cannot run, use the recorded binding inventory and the
  existing Edge management path to withdraw only discovery-owned routes.
- Restore the previous control-plane/dashboard digests using the recorded mechanism.
- Leave additive tables/columns in place; do not run a destructive schema rollback.
- External containers/networks remain untouched. Retain certificate material.
- Verify existing domain routes and dashboard access. Re-enable only after repair.

## Tonight's sequencing and decision points

Work sequentially: server-domain Edge/TLS proof -> parser/inspection -> persistence ->
reconciler/TLS -> watchers -> minimal UI -> integration gates -> canary -> rollout.

Planning allowance: approximately 8–12 hours for this bounded first release if
the shared Edge/TLS paths can be extracted cleanly, plus CI/publication and DNS/ACME delays.
This is a working estimate, not a deployment guarantee. A shorter window should
prioritize a single-server canary; do not omit ownership/lifecycle validation to
meet the clock. Broader server rollout can follow the validated canary.

Open operational input: exact deployment instance/server and its normal update
workflow. Implementation preparation and local validation do not depend on that
answer; publishing or rolling out to an unspecified instance does.
