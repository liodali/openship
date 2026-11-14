/**
 * Discovery sweep wiring (docs/docker-service-discovery-plan.md, step 5).
 *
 * ONE recurring job drives the whole discovery lifecycle for every enabled
 * server, every minute (the plan's "60-second repair sweep"; per-server
 * `sweepIntervalSeconds` can stretch only the SCAN — reconcile and repair run
 * every tick, they are DB-driven and cheap):
 *
 *   scan (inventory → desired state) → reconcile (routes + withdrawals +
 *   retention) → repair (durable-record route files).
 *
 * Stage isolation: a failed scan must not block reconciliation of the state
 * already recorded (the scanner's own errors are visible retry states), and a
 * failed reconcile must not block repair of route files. A failed server never
 * blocks the others.
 *
 * `startDiscoverySweep` registers the job on the shared runner (job_run
 * history via scheduleSystemJob) AND runs one sweep immediately — the
 * plan's startup inventory: discovery state converges at boot without
 * waiting for the first tick. The lifecycle-event watcher
 * (`discovery-watch.ts`) renews from the sweep itself, so it also arms here.
 */

import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import { scheduleSystemJob, type JobSummary } from "../../lib/system-jobs";
import { trackBackgroundWork } from "../../lib/background-work";
import { scanServerDiscovery, type DiscoveryScanSummary } from "./discovery-scanner";
import {
  reconcileServerDiscovery,
  type DiscoveryReconcileSummary,
} from "./discovery-reconciler";
import { repairDiscoveryRoutes, type DiscoveryRepairSummary } from "./discovery-repair";
import { renewDiscoveryWatchers } from "./discovery-watch";

export const DISCOVERY_SWEEP_JOB = "discovery:sweep";

/** Per-stage summaries for one server's sweep. */
export interface DiscoveryServerSweepSummary {
  serverId: string;
  scan?: DiscoveryScanSummary;
  reconcile?: DiscoveryReconcileSummary;
  repair?: DiscoveryRepairSummary;
  /** Stages that threw (their key is absent from the summary). */
  failed: Array<"scan" | "reconcile" | "repair">;
}

export interface DiscoverySweepSummary {
  servers: number;
  failed: string[];
  details: DiscoveryServerSweepSummary[];
}

/**
 * Run scan → reconcile → repair for ONE enabled server. Every stage is
 * individually error-isolated; the summary reports which stages failed.
 */
export async function sweepServerDiscovery(
  serverId: string,
  organizationId: string,
): Promise<DiscoveryServerSweepSummary> {
  const summary: DiscoveryServerSweepSummary = { serverId, failed: [] };

  // Honor the per-server scan interval: a server configured to rescan less
  // often skips its inventory when the last scan is fresh. Reconcile and
  // repair ALWAYS run — they are DB-driven and cheap, and a reconcile that
  // clears the apply queue must not wait on a stretched scan cadence.
  const settings = await repos.discovery.getSettings(serverId);
  const scanDue =
    !settings?.lastScanAt ||
    Date.now() - settings.lastScanAt.getTime() >= Math.max(0, (settings?.sweepIntervalSeconds ?? 60) - 5) * 1000;
  if (scanDue) {
    try {
      summary.scan = await scanServerDiscovery(serverId, organizationId);
      if (!summary.scan.ok) summary.failed.push("scan");
    } catch (error) {
      errorDiagnostics.warn(
        "platform/engine/modules/discovery/discovery-sweep",
        `[discovery-sweep] scan failed for ${serverId}: ${safeErrorMessage(error)}`,
      );
      summary.failed.push("scan");
    }
  }

  try {
    summary.reconcile = await reconcileServerDiscovery(serverId, organizationId);
    if (!summary.reconcile.ok) summary.failed.push("reconcile");
  } catch (error) {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-sweep",
      `[discovery-sweep] reconcile failed for ${serverId}: ${safeErrorMessage(error)}`,
    );
    summary.failed.push("reconcile");
  }

  try {
    summary.repair = await repairDiscoveryRoutes(serverId, organizationId);
  } catch (error) {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-sweep",
      `[discovery-sweep] repair failed for ${serverId}: ${safeErrorMessage(error)}`,
    );
    summary.failed.push("repair");
  }

  return summary;
}

/** One sweep across every enabled server. */
export async function sweepDiscovery(): Promise<DiscoverySweepSummary> {
  const summary: DiscoverySweepSummary = { servers: 0, failed: [], details: [] };
  let enabled: Array<{ serverId: string }>;
  try {
    enabled = await repos.discovery.listEnabledServerIds();
  } catch (error) {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-sweep",
      `[discovery-sweep] could not list enabled servers: ${safeErrorMessage(error)}`,
    );
    return summary;
  }
  summary.servers = enabled.length;

  for (const { serverId } of enabled) {
    try {
      const server = await repos.server.get(serverId);
      if (!server?.organizationId) {
        // Orphaned settings or a server without a tenant: nothing org-scoped
        // (runtime, domains, TLS) can resolve. The scanner would say the same.
        summary.failed.push(serverId);
        continue;
      }
      const detail = await sweepServerDiscovery(serverId, server.organizationId);
      summary.details.push(detail);
      if (detail.failed.length > 0) summary.failed.push(serverId);
    } catch (error) {
      errorDiagnostics.warn(
        "platform/engine/modules/discovery/discovery-sweep",
        `[discovery-sweep] server ${serverId} sweep failed: ${safeErrorMessage(error)}`,
      );
      summary.failed.push(serverId);
    }
  }

  // Watcher lease renewal rides the sweep (see discovery-watch): enabled
  // servers keep their lifecycle-event subscriptions, everything else expires.
  await renewDiscoveryWatchers(enabled.map((s) => s.serverId)).catch((error) => {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-sweep",
      `[discovery-sweep] watcher renewal failed: ${safeErrorMessage(error)}`,
    );
  });
  return summary;
}

/**
 * Register the recurring sweep and run the startup inventory immediately.
 * Idempotent per job id. Called from API startup (self-hosted).
 */
export async function startDiscoverySweep(): Promise<void> {
  await scheduleSystemJob({
    jobId: DISCOVERY_SWEEP_JOB,
    cronExpression: "* * * * *", // every minute = the plan's 60-second sweep
    run: async (): Promise<JobSummary> => {
      const summary = await sweepDiscovery();
      return {
        servers: summary.servers,
        failed: summary.failed.length,
        repaired: summary.details.reduce((n, d) => n + (d.repair?.repaired.length ?? 0), 0),
        retained: summary.details.reduce((n, d) => n + (d.repair?.retained.length ?? 0), 0),
        requeued: summary.details.reduce((n, d) => n + (d.repair?.requeued.length ?? 0), 0),
      };
    },
  });
  // Startup inventory: converge now, don't wait for the first tick. The
  // watcher subscriptions arm inside the sweep's renewal.
  void trackBackgroundWork(
    sweepDiscovery().catch((error) => {
      errorDiagnostics.warn(
        "platform/engine/modules/discovery/discovery-sweep",
        `[discovery-sweep] startup inventory failed: ${safeErrorMessage(error)}`,
      );
    }),
  );
}
