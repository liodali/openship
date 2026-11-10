/**
 * Discovery scanner (docs/docker-service-discovery-plan.md, steps 4–5).
 *
 * One pass over an enabled server's Docker host: list containers, inspect each
 * with bounded concurrency, parse opt-in declarations with the core parser, and
 * persist observations through the discovery repo. This is INVENTORY — the
 * authoritative desired-state read. Docker lifecycle events are only hints that
 * trigger a rescan; every state change flows through here so daemon restarts,
 * dropped event streams, and missed events all converge to the same truth.
 *
 * Guarantees (each maps to a plan requirement):
 *  - Duplicate LIVE identity (two running containers, one serviceKey) blocks
 *    every candidate — a replica is never picked arbitrarily (plan: "Reject
 *    duplicate live candidates for one identity").
 *  - A hostname an existing non-discovery owner serves blocks the binding —
 *    discovery never repoints another owner's route.
 *  - Confirmed removals are distinct from inspection failures: a failed
 *    inspection retains bindings and reports an error; a container absent from
 *    the inventory is `missing`. An opted-out but still-present container is
 *    `withdrawn` (binding forgotten; domain/certificate metadata retained).
 *  - Openship-owned containers never become candidates (parser exclusion).
 *  - Nothing here mutates routes — the reconciler consumes the summary.
 */
import {
  discoveryConfigHash,
  parseDiscoveryDeclaration,
  type DiscoveryContainerView,
} from "@repo/core";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import type { RuntimeAdapter } from "@repo/adapters";
import { mapWithLimit } from "../../lib/map-with-limit";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";

export interface DiscoveryScanSummary {
  /** Containers inspected this pass. */
  scanned: number;
  /** Containers that parsed into eligible declarations. */
  eligible: number;
  /** Bindings written (created or observation-updated). */
  observed: string[];
  /** Bindings whose desired config changed (reconciler must apply). Includes
   *  requeues from runtime-target changes (replacement, IP, stop/start). */
  desiredChanged: string[];
  /** Containers whose declaration is INVALID or now excluded: binding
   *  preserved when one matches, error surfaced — never silently withdrawn
   *  (an operator typo in OPENSHIP_NETWORK must not erase discovery state).
   *  Every invalid OPTED-IN container is reported, whether or not a binding
   *  matches: recreation changes the container id, so id-matching alone would
   *  hide the error. serviceKey is the recoverable identity (null when the
   *  identity fields themselves failed to parse). */
  invalid: Array<{
    serviceKey: string | null;
    containerId: string;
    containerName?: string | null;
    code: string;
    message: string;
  }>;
  /** Bindings whose container is confirmed gone from the host. */
  missing: string[];
  /** Bindings withdrawn because the container no longer opts in. */
  withdrawn: string[];
  /** Blocked from reconciliation, with the sanitized reason. */
  blocked: Array<{ serviceKey: string; reason: string }>;
  /** Per-container or whole-scan failures that did NOT mutate state. */
  errors: Array<{ containerId?: string; message: string }>;
  /** False when the scan could not read the host at all (state retained). */
  ok: boolean;
}

const INSPECT_CONCURRENCY = 5;

/** Driver enrichment result: per-container networks get drivers from the host network list. */
function enrichDrivers(view: DiscoveryContainerView, driverById: Map<string, string>, driverByName: Map<string, string>): DiscoveryContainerView {
  return {
    ...view,
    networks: view.networks.map((net) => ({
      ...net,
      driver: (net.id && driverById.get(net.id)) || driverByName.get(net.name) || null,
    })),
  };
}

export async function scanServerDiscovery(
  serverId: string,
  organizationId: string,
  options?: {
    /** Overrides the settings check (startup proof / tests). Default: read settings. */
    runtime?: RuntimeAdapter;
  },
): Promise<DiscoveryScanSummary> {
  const summary: DiscoveryScanSummary = {
    scanned: 0,
    eligible: 0,
    observed: [],
    desiredChanged: [],
    invalid: [],
    missing: [],
    withdrawn: [],
    blocked: [],
    errors: [],
    ok: false,
  };

  const settings = await repos.discovery.getSettings(serverId);
  if (!settings?.enabled) return summary; // never configured or disabled: nothing runs

  const server = await repos.server.get(serverId);
  if (!server) {
    summary.errors.push({ message: "server row missing; discovery settings are orphaned" });
    return summary;
  }

  let rt: RuntimeAdapter | undefined = options?.runtime;
  let ownedRuntime = false;
  try {
    if (!rt) {
      rt = await createServerDockerRuntime(serverId, organizationId);
      ownedRuntime = true;
    }

    // One host-level read for network drivers: the per-container inspect does
    // not carry drivers, and usability must be proven, not assumed.
    const hostNetworks = await rt.listAllNetworks?.().catch((error: unknown) => {
      summary.errors.push({ message: `network list failed: ${safeErrorMessage(error)}` });
      return undefined as Awaited<ReturnType<NonNullable<RuntimeAdapter["listAllNetworks"]>> | undefined>;
    });
    if (!hostNetworks) {
      await repos.discovery
        .recordScan(serverId, { ok: false, error: `network list failed: ${summary.errors.at(-1)?.message ?? "unknown"}` })
        .catch(() => {});
      return summary;
    }
    const driverById = new Map(hostNetworks.map((n) => [n.id, n.driver]));
    const driverByName = new Map(hostNetworks.map((n) => [n.name, n.driver]));

    const containers = await rt.listAllContainers?.().catch((error: unknown) => {
      summary.errors.push({ message: `container list failed: ${safeErrorMessage(error)}` });
      return undefined as Awaited<ReturnType<NonNullable<RuntimeAdapter["listAllContainers"]>> | undefined>;
    });
    if (!containers) {
      await repos.discovery
        .recordScan(serverId, { ok: false, error: `container list failed: ${summary.errors.at(-1)?.message ?? "unknown"}` })
        .catch(() => {});
      return summary;
    }
    summary.scanned = containers.length;

    // Bounded inspect fan-out (same limiter as migration discovery).
    const inspectView = rt.getDiscoveryContainerView?.bind(rt);
    if (!inspectView) {
      await repos.discovery.recordScan(serverId, { ok: false, error: "runtime lacks discovery inspection" });
      return summary;
    }
    const failedContainerIds = new Set<string>();
    /** Every invalid/excluded opted-in container, keyed by container id. */
    const rejectionsByContainerId = new Map<
      string,
      { code: string; message: string; serviceKey?: string; containerName?: string | null }
    >();
    const views = await mapWithLimit(containers, INSPECT_CONCURRENCY, async (container) => {
      try {
        const view = await inspectView(container.id);
        if (!view) return { containerId: container.id, view: null };
        return { containerId: container.id, view: enrichDrivers(view, driverById, driverByName) };
      } catch (error) {
        // One container's inspect failure retains everything and reports — it
        // must not classify that service as removed.
        failedContainerIds.add(container.id);
        summary.errors.push({ containerId: container.id, message: safeErrorMessage(error) });
        return { containerId: container.id, view: null };
      }
    });

    // Parse every inspectable container; group eligible declarations by key.
    // Running and stopped candidates are tracked SEPARATELY: identity conflicts
    // exist between LIVE candidates only — a retained stopped container must
    // never block its running replacement (docs: "Reject duplicate LIVE
    // candidates").
    type Candidate = {
      view: DiscoveryContainerView;
      hostname: string;
      port: number;
      network?: string;
      networkId?: string;
      ipAddress?: string;
      upstreamStrategy: "network-ip" | "published-port";
      hostPort?: number;
      hostIp?: string | null;
      configHash: string;
      running: boolean;
    };
    const candidatesByKey = new Map<string, { running: Candidate[]; stopped: Candidate[] }>();
    const presentContainerIds = new Set<string>();
    for (const { containerId, view } of views) {
      if (!view) continue;
      presentContainerIds.add(containerId);
      const result = parseDiscoveryDeclaration(view);
      if (!result.eligible) {
        if (result.rejection.kind !== "not-opted-in") {
          rejectionsByContainerId.set(containerId, {
            code: result.rejection.kind === "excluded" ? "openship-owned" : result.rejection.code,
            message:
              result.rejection.kind === "excluded"
                ? `container is Openship-owned (${result.rejection.label})`
                : result.rejection.message,
            ...(result.rejection.kind === "invalid" && result.rejection.serviceKey
              ? { serviceKey: result.rejection.serviceKey }
              : {}),
            containerName: view.name ?? null,
          });
        }
        continue;
      }
      summary.eligible += 1;
      const { declaration } = result;
      // Deterministic interim upstream selection (docs: "Persist the resolved
      // strategy and observed target separately from authored config"). The
      // parser orders candidates deterministically; the resolver's Edge-context
      // REACHABILITY PROBE (reconciler, step 4) makes the final call before any
      // route write — a strategy flip requeues via observe(). Until that lands,
      // prefer the bridge IP when present, else the first published binding.
      const bridge = declaration.upstreams.find((u) => u.kind === "bridge-ip");
      const published = declaration.upstreams.find((u) => u.kind === "published-port");
      const selected = bridge ?? published;
      const candidate: Candidate = {
        view,
        hostname: declaration.hostname,
        port: declaration.port,
        network: declaration.network,
        networkId: declaration.networkId,
        ipAddress:
          selected?.kind === "bridge-ip"
            ? selected.ipAddress
            : (view.networks.find((n) => n.name === declaration.network)?.ipAddress ?? undefined),
        upstreamStrategy: selected?.kind === "published-port" ? "published-port" : "network-ip",
        ...(selected?.kind === "published-port"
          ? { hostPort: selected.hostPort, hostIp: selected.hostIp }
          : {}),
        configHash: discoveryConfigHash(declaration),
        running: view.running,
      };
      const group = candidatesByKey.get(declaration.serviceKey) ?? { running: [], stopped: [] };
      (view.running ? group.running : group.stopped).push(candidate);
      candidatesByKey.set(declaration.serviceKey, group);
    }

    /** Persist one candidate's observation. */
    const observeCandidate = (serviceKey: string, d: Candidate) => ({
      serviceKey,
      containerId: d.view.containerId,
      containerName: d.view.name ?? null,
      running: d.running,
      hostname: d.hostname,
      port: d.port,
      networkName: d.network ?? null,
      networkId: d.networkId ?? null,
      ipAddress: d.ipAddress ?? null,
      upstreamStrategy: d.upstreamStrategy,
      hostPort: d.hostPort ?? null,
      hostIp: d.hostIp ?? null,
      configHash: d.configHash,
      composeProject: d.view.labels["com.docker.compose.project"] ?? null,
      composeService: d.view.labels["com.docker.compose.service"] ?? null,
    });

    // Identity conflicts: only LIVE (running) candidates of one key block each
    // other — observe every running candidate, then block ALL of them. A sole
    // running candidate wins outright over same-key stopped containers, whose
    // observation must never overwrite it (the running instance is the one the
    // route targets). Stopped-only keys observe their single candidate.
    for (const [serviceKey, group] of candidatesByKey) {
      const effective = group.running.length > 0 ? group.running : group.stopped;
      if (effective.length < 2) continue;
      const live = group.running.length > 1;
      const containers = effective.map((d) => `${d.view.name ?? d.view.containerId}`).join(", ");
      const reason = live
        ? `${effective.length} running containers claim identity ${serviceKey} (${containers}); resolve the duplicate before any route is written`
        : `${effective.length} stopped containers claim identity ${serviceKey} (${containers}); resolve the duplicate before either starts`;
      for (const d of effective) {
        try {
          await repos.discovery.observe(serverId, observeCandidate(serviceKey, d));
        } catch (error) {
          summary.errors.push({ message: `observe(${serviceKey}) failed: ${safeErrorMessage(error)}` });
        }
        await repos.discovery.block(serverId, serviceKey, reason);
      }
      summary.observed.push(serviceKey);
      summary.blocked.push({ serviceKey, reason });
    }

    // Observe unique identities; hostname ownership conflicts block instead of routing.
    for (const [serviceKey, group] of candidatesByKey) {
      const effective = group.running.length > 0 ? group.running : group.stopped;
      if (effective.length !== 1) continue;
      const d = effective[0];
      try {
        const { binding, desiredChanged, requeued } = await repos.discovery.observe(
          serverId,
          observeCandidate(serviceKey, d),
        );
        summary.observed.push(binding.serviceKey);
        // Config changes AND runtime-target changes (replacement, IP, stop,
        // start) both require an apply — an applied binding whose container IP
        // changed must re-apply or it keeps routing to the old upstream.
        if (desiredChanged || requeued) summary.desiredChanged.push(binding.serviceKey);

        const other = await repos.discovery.findConflictingDomainOwner(serverId, d.hostname);
        if (other) {
          const reason = `hostname ${d.hostname} is already owned by a ${other.ownerType} domain (${other.id}); discovery never repoints it`;
          await repos.discovery.block(serverId, serviceKey, reason);
          summary.blocked.push({ serviceKey, reason });
        } else if (binding.applyState === "blocked") {
          // The conflict that blocked this binding is gone — return it to the
          // reconciler's queue instead of leaving it blocked forever.
          await repos.discovery.unblock(serverId, serviceKey);
        }
      } catch (error) {
        summary.errors.push({ message: `observe(${serviceKey}) failed: ${safeErrorMessage(error)}` });
      }
    }

    // Classify bindings not seen this scan. The distinctions matter:
    //  - container present, declaration INVALID or now excluded → binding
    //    PRESERVED and the validation error surfaced. An operator typo (say a
    //    missing network) must never silently erase discovery state — only an
    //    explicit opt-out withdraws;
    //  - container present, cleanly not opted in → WITHDRAWN (forget; the
    //    reconciler retires discovery-owned routes; domain metadata retained);
    //  - container absent from the host → MISSING (confirmed removal);
    //  - container unreadable this scan → UNCLASSIFIED (state kept).
    const existing = await repos.discovery.listByServer(serverId);
    const seenKeys = new Set(candidatesByKey.keys());

    // Report EVERY invalid opted-in container — not only ones matching a
    // binding's recorded container id: Compose recreation changes that id, and
    // an id-only lookup would hide exactly the typo the operator needs to see.
    // serviceKey is the parser's recovered identity when available, else the
    // matching binding's key, else null (identity itself unparseable).
    const bindingByKey = new Map(existing.map((b) => [b.serviceKey, b]));
    for (const [containerId, rejection] of rejectionsByContainerId) {
      summary.invalid.push({
        serviceKey: rejection.serviceKey ?? bindingByKey.get(rejection.serviceKey ?? "")?.serviceKey ?? null,
        containerId,
        ...(rejection.containerName ? { containerName: rejection.containerName } : {}),
        code: rejection.code,
        message: rejection.message,
      });
    }

    for (const bindingRow of existing) {
      if (seenKeys.has(bindingRow.serviceKey)) continue;
      // An inspect failure leaves the binding UNCLASSIFIED — the plan requires
      // "failed/incomplete inventory retains bindings and reports an error";
      // only a confirmed absence (or a readable opt-out) changes state.
      if (bindingRow.containerId != null && failedContainerIds.has(bindingRow.containerId)) continue;
      // Invalid/excluded declaration belonging to THIS binding — by container
      // id (same-id rejection) or by STABLE IDENTITY (recreated container,
      // including the case where a previous markInvalid already cleared the
      // stored container id). The container is present but unparseable: the
      // binding is preserved, its stale observation invalidated, and a live
      // route queued for withdrawal — never reclassified as missing while the
      // invalid container keeps claiming the identity.
      const rejectedForBinding =
        (bindingRow.containerId != null && rejectionsByContainerId.has(bindingRow.containerId)) ||
        [...rejectionsByContainerId.values()].some((r) => r.serviceKey === bindingRow.serviceKey);
      if (rejectedForBinding) {
        await repos.discovery.markInvalid(serverId, bindingRow.serviceKey).catch((error) => {
          summary.errors.push({ message: `markInvalid(${bindingRow.serviceKey}) failed: ${safeErrorMessage(error)}` });
        });
        continue; // already reported in summary.invalid above
      }
      // A container that scanned but did not produce THIS binding's key has
      // explicitly opted out; its containerId tells us it is still around.
      const containerStillPresent =
        bindingRow.containerId != null && presentContainerIds.has(bindingRow.containerId);
      try {
        if (containerStillPresent) {
          await repos.discovery.forget(serverId, bindingRow.serviceKey);
          summary.withdrawn.push(bindingRow.serviceKey);
        } else {
          await repos.discovery.markMissing(serverId, bindingRow.serviceKey);
          summary.missing.push(bindingRow.serviceKey);
        }
      } catch (error) {
        summary.errors.push({
          message: `classify(${bindingRow.serviceKey}) failed: ${safeErrorMessage(error)}`,
        });
      }
    }

    summary.ok = true;
    await repos.discovery.recordScan(serverId, { ok: true });
    return summary;
  } catch (error) {
    reportCaughtError(error, "platform/engine/modules/discovery/discovery-scanner");
    summary.errors.push({ message: safeErrorMessage(error) });
    // A failed scan retains every binding and reports; it never mass-deletes.
    await repos.discovery.recordScan(serverId, { ok: false, error: safeErrorMessage(error) }).catch(() => {});
    return summary;
  } finally {
    if (ownedRuntime) await rt?.dispose?.().catch(() => {});
  }
}
