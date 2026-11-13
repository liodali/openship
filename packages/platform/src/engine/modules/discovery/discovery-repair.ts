/**
 * Discovery route repair from DURABLE records (docs/docker-service-discovery-plan.md).
 *
 * The gap it closes: `registerRoute` is the only writer of a discovered service's
 * vhost, and it runs from reconciliation passes. So a deleted/lost route file (edge
 * volume reset, operator cleanup, a conf write that raced a backup restore) leaves the
 * binding applied in the DB while the edge serves nothing for that hostname — and the
 * default-server page answers under a certificate valid for no hostname, which is the
 * failure mode `terminatesTlsLocally` exists to prevent (#308).
 *
 * SAFETY RULE (the repair loop's whole shape): repair only ever writes the
 * UNAVAILABLE vhost — 503 + TLS + ACME, from the durable record alone. It NEVER
 * re-emits a serving upstream from stored records: after downtime a stored bridge IP
 * or published port may belong to a DIFFERENT container, and repair has no fresh
 * inspection or ownership guard to prove otherwise. Serving routes are (re)established
 * exclusively by the normal guarded reconciliation (fresh probe, ownership check,
 * assertCurrent). What repair CAN safely do:
 *   - a MISSING route file → restore the unavailable vhost (hostname + cert
 *     lifecycle kept; docs: "Repair may restore that unavailable vhost using
 *     existing certificate material");
 *   - a route file still serving a stored upstream that the record says is DEAD
 *     (backend missing/stopped/invalid) → switch it to the unavailable form
 *     (retention sweep for a backend that stopped while no reconcile pass ran);
 *   - anything else (healthy serving route, already-retained vhost) → untouched.
 *
 * Comparison is ACTUAL-vs-record: the provider's `readRouteState` returns the vhost's
 * persisted config, so an existing file is classified, not assumed correct. A conf
 * whose sidecar is unreadable was not (provably) written by us — it is reported and
 * left alone, never clobbered.
 *
 * No ACME order here, ever (docs: "Prove Edge repair can restore an unavailable vhost
 * without triggering an ACME order"); issuance eligibility is the TLS lifecycle's own
 * gate on a running container. Best-effort: one binding's failure is recorded and the
 * sweep moves on. The 60s sweep / startup callers are step 5 wiring.
 */

import { safeErrorMessage } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import {
  resolveDiscoveryEdgeTarget,
  shouldRetainUnavailableVhost,
  unavailableRouteFor,
  type DiscoveryEdgeTarget,
} from "./discovery-reconciler";

export interface DiscoveryRepairSummary {
  /** Bindings with durable application history examined for route state. */
  scanned: number;
  /** Missing vhosts restored as the unavailable form (hostname + TLS kept). */
  repaired: string[];
  /** Serving vhosts switched to the unavailable form (stored backend is dead). */
  retained: string[];
  failed: Array<{ serviceKey: string; reason: string }>;
}

/** True when the binding's durable record still names a plausible upstream. */
function recordUpstreamAlive(binding: {
  observationStatus: string;
  containerRunning: boolean;
  upstreamStrategy: string | null;
  ipAddress: string | null;
  hostPort: number | null;
  port: number;
}): boolean {
  if (binding.observationStatus !== "observed" || !binding.containerRunning) return false;
  if (binding.upstreamStrategy === "published-port") return binding.hostPort !== null;
  if (binding.upstreamStrategy === "network-ip") return binding.ipAddress !== null;
  return false;
}

/** True when the persisted route config is a live serving proxy (not 503/404/redirect). */
function isServingRouteState(state: { targetUrl?: string; unavailable?: boolean } | null): boolean {
  return state !== null && typeof state.targetUrl === "string" && state.targetUrl.length > 0 &&
    state.unavailable !== true;
}

/**
 * Repair one enabled server's discovered routes against its own Edge.
 *
 * Only bindings with durable application history (`appliedGeneration > 0`) are
 * examined — stop/removal observations requeue applied bindings as applyState
 * "pending", so the apply STATE cannot be the gate. Providers without
 * `hasRoute`/`readRouteState` have no on-edge generated config to inspect (cloud
 * API, no-edge desktop) — nothing to repair, "not applicable", not a failure.
 */
export async function repairDiscoveryRoutes(
  serverId: string,
  organizationId: string,
  options?: {
    /** Injected Edge target (tests); resolves the server's own when omitted. */
    edge?: DiscoveryEdgeTarget;
    onLog?: (message: string, level?: "info" | "warn") => void;
  },
): Promise<DiscoveryRepairSummary> {
  const summary: DiscoveryRepairSummary = { scanned: 0, repaired: [], retained: [], failed: [] };
  const settings = await repos.discovery.getSettings(serverId);
  if (!settings?.enabled) return summary;

  const edge = options?.edge ?? (await resolveDiscoveryEdgeTarget(serverId, organizationId));
  const owned = !options?.edge;
  const routing = edge.routing;
  try {
    if (!routing?.hasRoute || !routing?.registerRoute || !routing?.readRouteState) return summary;

    const bindings = await repos.discovery.listActiveForServers([serverId]);
    for (const binding of bindings) {
      if (!shouldRetainUnavailableVhost(binding)) continue;
      summary.scanned += 1;
      try {
        const recordAlive = recordUpstreamAlive(binding);
        if (!(await routing.hasRoute(binding.hostname))) {
          // MISSING route file: the only safe restore is the retained 503 form —
          // never a serving upstream replayed from records (P1: after downtime
          // that endpoint may belong to another container).
          await routing.registerRoute(unavailableRouteFor(binding.hostname));
          summary.repaired.push(binding.hostname);
          options?.onLog?.(
            `Restored discovered route ${binding.hostname} from its stored record` +
              (recordAlive ? " (backend running; guarded reconciliation will resume serving)." : " (backend unavailable, TLS kept)."),
            "warn",
          );
          continue;
        }
        const actual = await routing.readRouteState(binding.hostname);
        if (!actual) {
          // A conf exists but its persisted state is unreadable — it was not
          // (provably) written by this config generator. Never clobber an
          // unclassifiable vhost; surface it instead.
          summary.failed.push({
            serviceKey: binding.serviceKey,
            reason: "route file exists but its stored state is unreadable; refusing to overwrite a vhost Openship cannot classify",
          });
          continue;
        }
        if (!isServingRouteState(actual)) continue; // already 503/retained: nothing to do
        if (recordAlive) continue; // serving and the record agrees: apply-time validation owns it
        // Serving vhost whose stored upstream the record says is DEAD: switch to
        // the retained form so clients see 503 under the right certificate
        // instead of 502 into a possibly-reused endpoint.
        await routing.registerRoute(unavailableRouteFor(binding.hostname));
        summary.retained.push(binding.hostname);
        options?.onLog?.(
          `Retained discovered route ${binding.hostname} (backend unavailable, TLS kept).`,
          "warn",
        );
      } catch (error) {
        reportCaughtError(error, "platform/engine/modules/discovery/discovery-repair");
        summary.failed.push({ serviceKey: binding.serviceKey, reason: safeErrorMessage(error) });
      }
    }
  } finally {
    if (owned) await edge.dispose();
  }
  return summary;
}
