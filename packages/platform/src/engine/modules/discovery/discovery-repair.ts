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
 * UNAVAILABLE vhost — 503 + TLS + ACME. It NEVER re-emits a serving upstream from
 * stored records: after downtime a stored bridge IP or published port may belong to
 * a DIFFERENT container, and repair has no fresh inspection or ownership guard to
 * prove otherwise. Serving routes are established exclusively by the normal guarded
 * reconciliation (fresh probe, ownership check, assertCurrent). Repair therefore
 * writes the retained 503 form and — whenever the record describes a RUNNING backend
 * — QUEUES guarded reconciliation (`requeueForApply`), so the restored hostname
 * never stays unavailable indefinitely: an unchanged scan would never requeue an
 * applied binding on its own.
 *
 * Comparison is ACTUAL-vs-record: the provider's `readRouteState` returns the vhost's
 * persisted config, so an existing file is classified, not assumed correct. A serving
 * vhost whose target disagrees with the record's upstream is STALE (old IP/port after
 * a replacement): repair can't validate a replacement either, so it leaves the file
 * and queues guarded reconciliation to re-probe and rewrite. A conf whose sidecar is
 * unreadable was not (provably) written by us — reported and left alone, never
 * clobbered.
 *
 * No ACME order here, ever (docs: "Prove Edge repair can restore an unavailable vhost
 * without triggering an ACME order"); issuance eligibility is the TLS lifecycle's own
 * gate on a running container. Best-effort: one binding's failure is recorded and the
 * sweep moves on. The 60s sweep / startup callers are step 5 wiring.
 */

import { safeErrorMessage } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import type { DiscoveryBinding } from "@repo/db";
import {
  resolveDiscoveryEdgeTarget,
  shouldRetainUnavailableVhost,
  unavailableRouteFor,
  upstreamUrlFor,
  type DiscoveryEdgeTarget,
} from "./discovery-reconciler";

export interface DiscoveryRepairSummary {
  /** Bindings with durable application history examined for route state. */
  scanned: number;
  /** Missing vhosts restored as the unavailable form (hostname + TLS kept). */
  repaired: string[];
  /** Serving vhosts switched to the unavailable form (stored backend is dead). */
  retained: string[];
  /** Hostnames queued for guarded reconciliation (running backend / stale target). */
  requeued: string[];
  failed: Array<{ serviceKey: string; reason: string }>;
}

/** True when the persisted route config is a live serving proxy (not 503/404/redirect). */
function isServingRouteState(state: { targetUrl?: string; unavailable?: boolean } | null): boolean {
  return state !== null && typeof state.targetUrl === "string" && state.targetUrl.length > 0 &&
    state.unavailable !== true;
}

/**
 * Queue a guarded reconciliation for a binding whose route file repair cannot make
 * correct. Only converged bindings need it — pending/error bindings are already
 * queued (backoff), blocked ones are excluded by the retention predicate. The
 * generation bump invalidates in-flight applies; the next reconcile pass re-probes
 * fresh and either rewrites the serving route or re-retains.
 */
async function queueGuardedReconciliation(serverId: string, binding: DiscoveryBinding): Promise<boolean> {
  if (binding.applyState !== "applied") return false;
  return (await repos.discovery.requeueForApply(serverId, binding.serviceKey)) !== undefined;
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
  const summary: DiscoveryRepairSummary = {
    scanned: 0,
    repaired: [],
    retained: [],
    requeued: [],
    failed: [],
  };
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
        // The record's own upstream: null = backend missing/stopped/invalid or
        // unresolvable — the record itself says nothing is serving.
        const storedUpstream = upstreamUrlFor(binding);
        if (!(await routing.hasRoute(binding.hostname))) {
          // MISSING route file: the only safe restore is the retained 503 form —
          // never a serving upstream replayed from records. When the record
          // describes a RUNNING backend, queue guarded reconciliation right
          // away, or the restored 503 would sit forever (an unchanged scan
          // never requeues an applied binding).
          await routing.registerRoute(unavailableRouteFor(binding.hostname));
          // Queue guarded reconciliation ONLY when the record describes a
          // running backend — a dead one would just be re-retained by the next
          // pass (churn without effect).
          const queued = storedUpstream !== null
            ? await queueGuardedReconciliation(serverId, binding)
            : false;
          summary.repaired.push(binding.hostname);
          if (queued) summary.requeued.push(binding.hostname);
          options?.onLog?.(
            `Restored discovered route ${binding.hostname} from its stored record` +
              (queued
                ? "; queued guarded reconciliation to resume serving."
                : " (backend unavailable, TLS kept)."),
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
        if (storedUpstream === null) {
          // Serving vhost whose stored upstream the record says is DEAD: switch to
          // the retained form so clients see 503 under the right certificate
          // instead of 502 into a possibly-reused endpoint. No requeue: the
          // backend is gone; reconciliation would only re-retain.
          await routing.registerRoute(unavailableRouteFor(binding.hostname));
          summary.retained.push(binding.hostname);
          options?.onLog?.(
            `Retained discovered route ${binding.hostname} (backend unavailable, TLS kept).`,
            "warn",
          );
          continue;
        }
        if (actual.targetUrl === storedUpstream) continue; // serving the recorded upstream: apply-time validation owns it
        // STALE TARGET: the vhost serves an old IP/port (replacement, IP churn).
        // Repair can't validate the new endpoint either — leave the file and
        // queue guarded reconciliation to re-probe fresh and rewrite. (An
        // already-queued binding needs no bump: its pass is coming.)
        const queued = await queueGuardedReconciliation(serverId, binding);
        if (queued) summary.requeued.push(binding.hostname);
        options?.onLog?.(
          `Discovered route ${binding.hostname} serves ${actual.targetUrl} but the record names ${storedUpstream};` +
            (queued ? " queued guarded reconciliation." : " already queued for reconciliation."),
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
