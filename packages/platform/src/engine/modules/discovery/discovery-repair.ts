/**
 * Discovery route repair from DURABLE records (docs/docker-service-discovery-plan.md).
 *
 * The gap it closes: `registerRoute` is the only writer of a discovered service's
 * vhost, and it runs from reconciliation passes. So a deleted/lost route file (edge
 * volume reset, operator cleanup, a conf write that raced a backup restore) leaves the
 * binding `applied` in the DB while the edge serves nothing for that hostname — and the
 * default-server page answers under a certificate valid for no hostname, which is the
 * failure mode `terminatesTlsLocally` exists to prevent (#308).
 *
 * The repair loop re-derives the desired vhost from the binding row alone — the STORED
 * upstream (ip/hostPort), observation status, and running flag — and never:
 *   - probes the container live (repair replays RECORDS; the reconciler probes fresh),
 *   - touches host-port claims (they live in DB/edge state, not in the vhost file),
 *   - triggers issuance/renewal (no ACME order here, ever — docs: "Prove Edge repair
 *     can restore an unavailable vhost without triggering an ACME order"; issuance
 *     eligibility is the TLS lifecycle's own gate on a running container).
 *
 * Modes (durable, from the binding row):
 *   observed + running   → proxy route to the STORED upstream (restore serving);
 *   otherwise            → unavailable vhost: 503 + TLS + ACME retained (docs:
 *                          "Repair may restore that unavailable vhost using existing
 *                          certificate material, but must not trigger issuance/renewal
 *                          while the backend is stopped or unobservable").
 *
 * Best-effort like everything else on the routing path: one binding's failure is
 * recorded and the sweep moves on — a half-repaired edge with a report beats a wedged
 * one. The 60s sweep / startup callers are step 5 wiring.
 */

import { safeErrorMessage } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { repos, type DiscoveryBinding } from "@repo/db";
import type { DiscoveryEdgeTarget } from "./discovery-reconciler";
import { upstreamUrlFor } from "./discovery-reconciler";

export interface DiscoveryRepairSummary {
  /** Applied bindings examined for route existence. */
  scanned: number;
  /** Missing vhosts re-emitted from the durable record (serving or unavailable). */
  repaired: string[];
  /** Existing vhosts switched to the unavailable form (stored upstream is dead). */
  retained: string[];
  failed: Array<{ serviceKey: string; reason: string }>;
}

/** Desired route shape for a binding, from its DURABLE row. Null = no route should exist. */
export function desiredRouteForRecord(
  binding: DiscoveryBinding,
): { unavailable: true; tls: true; terminatesTlsLocally: true; domain: string } | {
  domain: string;
  tls: true;
  terminatesTlsLocally: true;
  targetUrl: string;
} | null {
  if (binding.applyState !== "applied") return null;
  const upstream = upstreamUrlFor(binding);
  if (upstream) {
    return { domain: binding.hostname, tls: true, terminatesTlsLocally: true, targetUrl: upstream };
  }
  return { domain: binding.hostname, tls: true, terminatesTlsLocally: true, unavailable: true };
}

/**
 * Repair one enabled server's discovered routes against its own Edge.
 *
 * Only applied bindings are examined (a pending/blocked binding has no route the
 * record promises). Providers without `hasRoute` have no on-edge generated config to
 * probe (cloud API, no-edge desktop) — nothing to repair, "not applicable", not a
 * failure.
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

  const { resolveDiscoveryEdgeTarget } = await import("./discovery-reconciler");
  const edge = options?.edge ?? (await resolveDiscoveryEdgeTarget(serverId, organizationId));
  const owned = !options?.edge;
  const routing = edge.routing;
  try {
    if (!routing?.hasRoute || !routing?.registerRoute) return summary;

    const bindings = await repos.discovery.listActiveForServers([serverId]);
    for (const binding of bindings) {
      if (binding.applyState !== "applied") continue;
      summary.scanned += 1;
      try {
        const desired = desiredRouteForRecord(binding);
        // An applied binding always yields a route shape (proxy or unavailable);
        // desiredRouteForRecord returns null only for non-applied rows.
        if (!desired) continue;
        const exists = await routing.hasRoute(binding.hostname);
        if (exists && !("unavailable" in desired)) continue; // serving + healthy: nothing to do
        // Missing file → repaired (restored from the durable record). Existing
        // file switched to the unavailable form → retained (retention sweep
        // for a backend that stopped while no reconcile pass ran).
        await routing.registerRoute(desired);
        const missing = !exists;
        const serving = "targetUrl" in desired;
        summary[missing ? "repaired" : "retained"].push(binding.hostname);
        options?.onLog?.(
          missing
            ? `Restored discovered route ${binding.hostname} from its stored record` +
              (serving ? "." : " (backend unavailable, TLS kept).")
            : `Retained discovered route ${binding.hostname} (backend unavailable, TLS kept).`,
          missing && serving ? "info" : "warn",
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
