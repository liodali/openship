/**
 * Discovery reconciler (docs/docker-service-discovery-plan.md, step 4).
 *
 * Consumes the scanner's desired-state queue and applies it to the serving
 * server's Openship Edge. Per enabled server, one pass:
 *
 *  1. WITHDRAWALS first — bindings flagged `withdrawalPending` (blocked or
 *     suppressed owners included): retire the application route, clear the
 *     flag. Blocking forbids forward applies; it never strands a live route.
 *  2. Due applies (pending/error, backoff elapsed, not suppressed):
 *     - missing/invalid observation → removeRoute (upstream withdrawn; the
 *       domain row and certificate material stay for the TLS lifecycle);
 *     - observed+running → registerRoute against the resolved upstream:
 *       bridge-ip → `http://<ip>:<port>`; published-port → the container's
 *       observed loopback binding `http://127.0.0.1:<hostPort>` — a remote
 *       server's loopback is THAT server's, never the API host's, and the
 *       host-port claim subsystem proves ownership before anything dials it
 *       (the publish is OBSERVED from the container; no allocator runs).
 *  3. Success is `markApplied(desiredGeneration)` only after the edge write
 *     returned; the DB write alone is never "active". Failures persist
 *     backoff via markApplyError and retry on a later pass.
 *
 * Explicitly NOT here (step-4 continuations): the Edge-context reachability
 * probe before activation, server-domain certificate scheduling, and repair
 * sweeps — each lands with the TLS/watcher wiring. The route writer is the
 * adapter's own `routing.registerRoute`; no project wrapper is faked (docs:
 * "must not call a wrapper that demands an active deployment").
 */
import { safeErrorMessage } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { repos, type DiscoveryBinding } from "@repo/db";
import { edgeProxyFor, type RoutingProvider, type Platform, type RuntimeAdapter } from "@repo/adapters";
import type { HostPortTargetIdentity } from "../../lib/host-port-target";
import { manageDomainSsl } from "../../lib/domain-ssl";
import {
  reserveObservedLoopbackPublishes,
  type ObservedLoopbackPublish,
  type ObservedHostPortRuntime,
} from "../deployments/observed-host-port-claims";
import {
  convergeTargetHostPortClaimsUnlocked,
  prepareTargetPinnedHostPorts,
  withHostPortTargetLock,
} from "../deployments/pinned-host-ports";
import {
  createPlatformForResolvedServer,
  disposePlatform,
  resolveServerExecutor,
  resolveServerHostPortTarget,
} from "../../lib/deployment-runtime";

/** Backoff for failed applies: 30s, 2m, 8m, then capped at 30m. */
const APPLY_BACKOFF_MS = [30_000, 120_000, 480_000, 1_800_000];

export interface DiscoveryEdgeTarget {
  routing: Pick<RoutingProvider, "registerRoute" | "removeRoute">;
  hostPortTarget: HostPortTargetIdentity | null;
  runtime?: ObservedHostPortRuntime;
  /** Edge strict-inventory proxy for the loopback ownership guard. */
  edgeProxy: ReturnType<typeof edgeProxyFor> | null;
  dispose: () => Promise<void>;
}

/** Resolve the serving server's Edge context (routing + host-port identity). */
export async function resolveDiscoveryEdgeTarget(
  serverId: string,
  organizationId: string,
): Promise<DiscoveryEdgeTarget> {
  const resolved = await resolveServerExecutor(serverId, organizationId);
  const platform: Platform = await createPlatformForResolvedServer(resolved, "docker", organizationId);
  const hostPortTarget = await resolveServerHostPortTarget(resolved);
  const edgeProxy = resolved.executor
    ? edgeProxyFor(resolved.executor, "openresty", { ours: true })
    : null;
  return {
    routing: platform.routing,
    hostPortTarget,
    runtime: platform.runtime as unknown as ObservedHostPortRuntime,
    edgeProxy,
    dispose: async () => {
      disposePlatform(platform);
    },
  };
}

/** The upstream URL the binding's resolved strategy routes to. Null = withdraw. */
export function upstreamUrlFor(binding: DiscoveryBinding): string | null {
  if (binding.observationStatus === "missing" || binding.observationStatus === "invalid") return null;
  if (!binding.containerRunning) return null;
  if (binding.upstreamStrategy === "published-port") {
    if (!binding.hostPort) return null;
    return `http://127.0.0.1:${binding.hostPort}`;
  }
  if (binding.upstreamStrategy === "network-ip") {
    if (!binding.ipAddress) return null;
    return `http://${binding.ipAddress}:${binding.port}`;
  }
  return null;
}

/** Stable, FK-free claim owner for discovered published-port routes. */
function discoveryClaimOwner(binding: DiscoveryBinding): string {
  return `discovery:${binding.id}`;
}

/**
 * Fire-and-forget certificate reconciliation for a just-applied discovered
 * service (docs: "A start/replacement event triggers immediate certificate
 * reconciliation"). Provision reads before issuing, so a comfortably valid
 * certificate is reused without an order; a missing/due/expired one is issued
 * through the server-domain flow — whose fresh-inspection ACME gate refuses
 * (as a defer, not a failure) if the container stopped in between. ACME success
 * also establishes hostname verification for the server-scoped domain.
 */
async function scheduleServerDomainCert(
  serverId: string,
  organizationId: string,
  binding: DiscoveryBinding,
): Promise<void> {
  try {
    await manageDomainSsl(binding.hostname, {
      action: "provision",
      allowUnverified: true,
      serverId,
    });
  } catch (error) {
    // DiscoveryBackendUnavailableError = deferred (stop/gate), already recorded
    // by manageDomainSsl's failure path only when it is a real SSL failure.
    // Everything else is surfaced for diagnostics; the sweep and the next
    // start/replacement re-trigger this.
    reportCaughtError(error, "platform/engine/modules/discovery/discovery-reconciler");
  }
}

export interface DiscoveryReconcileSummary {
  withdrawals: string[];
  applied: string[];
  removed: string[];
  failed: Array<{ serviceKey: string; reason: string }>;
  skipped: number;
  ok: boolean;
}

export async function reconcileServerDiscovery(
  serverId: string,
  organizationId: string,
  options?: {
    /** Injected Edge target (tests); resolves the server's own when omitted. */
    edge?: DiscoveryEdgeTarget;
  },
): Promise<DiscoveryReconcileSummary> {
  const summary: DiscoveryReconcileSummary = {
    withdrawals: [],
    applied: [],
    removed: [],
    failed: [],
    skipped: 0,
    ok: false,
  };

  const settings = await repos.discovery.getSettings(serverId);
  if (!settings?.enabled) return summary;

  const edge = options?.edge ?? (await resolveDiscoveryEdgeTarget(serverId, organizationId));
  const owned = !options?.edge;
  try {
    const routing = edge.routing;
    if (!routing?.registerRoute) {
      summary.failed.push({ serviceKey: "*", reason: "server edge has no routing provider; is the Edge installed?" });
      await repos.discovery.recordScan(serverId, { ok: false, error: "server edge has no routing provider" }).catch(() => {});
      return summary;
    }

    // ── Withdrawals first: retire live routes for blocked/suppressed owners ──
    for (const binding of await repos.discovery.dueForWithdrawal(serverId)) {
      try {
        await routing.removeRoute(binding.hostname);
        await repos.discovery.markWithdrawn(serverId, binding.serviceKey);
        summary.withdrawals.push(binding.serviceKey);
      } catch (error) {
        summary.failed.push({ serviceKey: binding.serviceKey, reason: safeErrorMessage(error) });
      }
    }

    // ── Due applies ────────────────────────────────────────────────────────
    for (const binding of await repos.discovery.dueForApply(serverId)) {
      const upstream = upstreamUrlFor(binding);
      try {
        if (!upstream) {
          // Missing/invalid/stopped: withdraw the application upstream. The
          // domain row and certificate material stay (TLS lifecycle decides
          // vhost retention with cert files; see TLS scheduling continuation).
          await routing.removeRoute(binding.hostname);
          await repos.discovery.markApplied(serverId, binding.serviceKey, binding.desiredGeneration);
          summary.removed.push(binding.serviceKey);
          continue;
        }

        // The server-scoped domain row backs the TLS lifecycle (verification
        // flows, the renewal sweep, the cert scheduling below). Created here,
        // on apply — never by container configuration alone.
        await repos.domain.ensureServerDomain({
          serverId,
          hostname: binding.hostname,
          targetPort: binding.port,
        });

        if (binding.upstreamStrategy === "published-port") {
          // Loopback published route: prove workload ownership through the
          // host-port claim subsystem BEFORE dialing it (docs: "Use existing
          // observed-port ownership rules... do not invoke an allocator").
          // The publish is OBSERVED from the container inspect; the claim owner
          // is stable and FK-free (`discovery:<bindingId>`).
          const { hostPortTarget, edgeProxy } = edge;
          if (!hostPortTarget || !edgeProxy || !binding.hostPort) {
            throw new Error("published-port route requires a resolved host-port target, edge inventory, and observed host port");
          }
          const publishes: ObservedLoopbackPublish[] = [
            {
              serviceId: binding.serviceKey,
              containerId: binding.containerId ?? undefined,
              containerPort: binding.port,
              hostPort: binding.hostPort,
            },
          ];
          await withHostPortTargetLock(hostPortTarget, async () => {
            await prepareTargetPinnedHostPorts({
              target: hostPortTarget,
              edgeProxy,
            });
            await reserveObservedLoopbackPublishes({
              target: hostPortTarget,
              projectId: discoveryClaimOwner(binding),
              runtime: edge.runtime,
              publishes,
            });
            await routing.registerRoute({
              domain: binding.hostname,
              targetUrl: upstream,
              tls: true,
              terminatesTlsLocally: true,
            });
            await convergeTargetHostPortClaimsUnlocked({
              target: hostPortTarget,
              projectId: discoveryClaimOwner(binding),
              desiredPublishes: publishes,
              edgeProxy,
            });
          });
        } else {
          // Bridge-IP direct route: no loopback, no host-port claims.
          await routing.registerRoute({
            domain: binding.hostname,
            targetUrl: upstream,
            tls: true,
            terminatesTlsLocally: true,
          });
        }

        await repos.discovery.markApplied(serverId, binding.serviceKey, binding.desiredGeneration);
        summary.applied.push(binding.serviceKey);
        // Immediate certificate reconciliation for the freshly (re-)applied
        // upstream. Deferred inside: the ACME gate re-inspects the container
        // fresh and defers (never fails the route) when it stopped meanwhile.
        void scheduleServerDomainCert(serverId, organizationId, binding)
      } catch (error) {
        reportCaughtError(error, "platform/engine/modules/discovery/discovery-reconciler");
        const reason = safeErrorMessage(error);
        summary.failed.push({ serviceKey: binding.serviceKey, reason });
        const attempts = binding.applyAttempts;
        const delay = APPLY_BACKOFF_MS[Math.min(attempts, APPLY_BACKOFF_MS.length - 1)];
        await repos.discovery
          .markApplyError(serverId, binding.serviceKey, reason, new Date(Date.now() + delay))
          .catch(() => {});
      }
    }

    summary.ok = true;
    return summary;
  } finally {
    if (owned) await edge.dispose().catch(() => {});
  }
}

export type { RuntimeAdapter };
