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

import { diagnostics as errorDiagnostics, reportCaughtError } from "@repo/core/diagnostics";
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
import { kickDiscoveryTlsQueue } from "./discovery-tls-queue";
import { probeServerDomainVhostCert, readServerDomainCert } from "../../lib/domain-ssl";
import { revokeOriginCaCertificate } from "./origin-ca-client";
import { readCredentialSecrets } from "../credentials/credential.service";
import { renewDiscoveryWatchers } from "./discovery-watch";

export const DISCOVERY_SWEEP_JOB = "discovery:sweep";

/** Per-stage summaries for one server's sweep. */
export interface DiscoveryServerSweepSummary {
  /** Replaced Origin CA certificates revoked after successful replacement. */
  revokedCertificates?: number;
  /** Domains enqueued for Edge repair/rotation by the periodic cert audit. */
  certAuditScheduled?: number;
  serverId: string;
  scan?: DiscoveryScanSummary;
  reconcile?: DiscoveryReconcileSummary;
  repair?: DiscoveryRepairSummary;
  /** Stages that threw (their key is absent from the summary). */
  failed: Array<"scan" | "reconcile" | "repair" | "certificate-cleanup" | "certificate-audit">;
}

/**
 * ONE queue per server: the startup inventory, the cron tick, every
 * event-triggered pass, AND operator mutations that touch routes (forget)
 * serialize through it. Without this, an older pass can read pre-event state
 * and withdraw or replace a route a newer pass just wrote — scan→reconcile is
 * a read-modify-write cycle and must not overlap itself for one server.
 * Different servers still queue independently.
 */
const serverSweepQueues = new Map<string, Promise<unknown>>();

/**
 * Serialize a task on a server's queue. The queue entry observes BOTH outcomes
 * (then(onFulfilled, onRejected), never a discarded run.finally) so a failing
 * task rejects only through the CALLER's promise — no unhandled rejection —
 * and the entry is dropped once it is the tail.
 */
export async function runInServerQueue<T>(serverId: string, task: () => Promise<T>): Promise<T> {
  const tail = serverSweepQueues.get(serverId);
  const run = (tail ?? Promise.resolve()).catch(() => undefined).then(task);
  serverSweepQueues.set(serverId, run);
  const dropQueueEntry = (): void => {
    if (serverSweepQueues.get(serverId) === run) serverSweepQueues.delete(serverId);
  };
  void run.then(dropQueueEntry, dropQueueEntry);
  return run;
}

export interface DiscoverySweepSummary {
  servers: number;
  failed: string[];
  details: DiscoveryServerSweepSummary[];
}

/**
 * Run scan → reconcile → repair for ONE enabled server, SERIALIZED through the
 * per-server queue (startup, cron, and event triggers all enter here). Every
 * stage is individually error-isolated; the summary reports which stages
 * failed.
 *
 * `fresh` bypasses the per-server scan interval. It is REQUIRED for triggers
 * whose whole point is current state — the startup inventory, and every
 * lifecycle event (a stop event just after a scan must not reconcile cached
 * state). Only the recurring cron poll applies the interval.
 */
export function sweepServerDiscovery(
  serverId: string,
  organizationId: string,
  options?: { fresh?: boolean },
): Promise<DiscoveryServerSweepSummary> {
  return runInServerQueue(serverId, () => runServerSweep(serverId, organizationId, options));
}

/**
 * Bounded periodic certificate audit: for server domains recording ACTIVE
 * Origin CA inventory, compare the EDGE fingerprint against the database —
 * and, when the files agree, the managed vhost's CONFIGURED certificate
 * selection against the expected source. A mismatch or missing material
 * enqueues the durable worker (whose repair flow re-issues through the full
 * gate chain); a healthy-files vhost drift (bootstrap, another source, no
 * TLS listener) enqueues the SAME worker, whose reuse path re-activates the
 * route without requesting another certificate. Transient read failures are
 * ignored — an SSH blip must not spin up re-issuance.
 */
/**
 * Fair-rotation cursor (per server, in-process): each sweep audits the next
 * slice of active domains after the last audited id, so every domain is
 * eventually checked instead of a fixed first page forever. Resets when the
 * selection is exhausted (wrapped around) or on restart.
 */
const certificateAuditCursor = new Map<string, string>();

async function auditServerCertificates(serverId: string, organizationId: string): Promise<number> {
  const domains = await repos.domain.findOriginCaActiveDomainsForServer(serverId, {
    afterId: certificateAuditCursor.get(serverId),
    limit: 5,
  });
  if (domains.length === 0) {
    certificateAuditCursor.delete(serverId); // exhausted — the next sweep wraps around
    return 0;
  }
  certificateAuditCursor.set(serverId, domains[domains.length - 1]!.id);
  let scheduled = 0;
  for (const domainRow of domains) {
    if (!domainRow.tlsCertificateFingerprint) continue;
    const binding = await repos.discovery.getBindingForDomain(serverId, domainRow.hostname);
    const wildcard = binding?.tlsDeclaredWildcard ?? null;
    const edge = await readServerDomainCert(domainRow.hostname, { serverId });
    const filesHealthy =
      edge.verified && edge.fingerprint
        ? edge.fingerprint === domainRow.tlsCertificateFingerprint
        : edge.reason === "read_error";
    if (filesHealthy) {
      // Healthy files alone are NOT proof the route serves them: the read
      // above resolves through the certificate directory, so a vhost still
      // selecting its enrollment bootstrap pair — or an outdated exact/shared
      // source — reads as healthy while visitors get the wrong certificate.
      // The managed vhost's CONFIGURED selection decides: CONFIRMED drift
      // (another source, or no TLS listener at all) enqueues the durable
      // worker, whose reuse path re-activates the route WITHOUT requesting
      // another certificate. Everything unproven stays unproven: a missing
      // route belongs to the route repair sweep (activation would no-op), a
      // transport failure waits for the next pass, and an edge without the
      // signal (cloud API) has nothing to classify.
      let probe: Awaited<ReturnType<typeof probeServerDomainVhostCert>>;
      try {
        probe = await probeServerDomainVhostCert(domainRow.hostname, {
          serverId,
          expectedCertDomain: (wildcard ?? domainRow.hostname).toLowerCase(),
        });
      } catch (error) {
        // Authorization/ownership refused (row vanished mid-audit): not
        // drift, and not this sweep's business to repair.
        reportCaughtError(error, "platform/engine/modules/discovery/discovery-sweep");
        continue;
      }
      if (probe.status !== "drifted" && probe.status !== "no_tls_listener") continue;
    }
    const policy = await repos.domain.getTlsPolicy(domainRow.id);
    const { created } = await repos.discoveryTlsQueue.ensureOperation({
      hostname: domainRow.hostname,
      sourceHostname: (wildcard ?? domainRow.hostname).toLowerCase(),
      source: wildcard ? "wildcard" : "exact",
      provider: policy?.tlsProvider ?? "letsencrypt",
      domainId: domainRow.id,
      serverId,
      organizationId,
      serviceKey: binding?.serviceKey ?? domainRow.hostname,
      policyGeneration: policy?.tlsPolicyGeneration ?? 0,
    });
    if (created) {
      kickDiscoveryTlsQueue();
      scheduled += 1;
    }
  }
  return scheduled;
}

async function runServerSweep(
  serverId: string,
  organizationId: string,
  options?: { fresh?: boolean },
): Promise<DiscoveryServerSweepSummary> {
  const summary: DiscoveryServerSweepSummary = { serverId, failed: [] };

  // Honor the per-server scan interval — for the recurring poll only (see the
  // `fresh` option): a server configured to rescan less often skips its
  // inventory when the last scan is fresh. Reconcile and repair ALWAYS run —
  // they are DB-driven and cheap, and a reconcile that clears the apply queue
  // must not wait on a stretched scan cadence.
  const settings = await repos.discovery.getSettings(serverId);
  const scanDue =
    options?.fresh === true ||
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

  // CERTIFICATE AUDIT: bounded periodic check that the edge still holds the
  // certificate the database claims — INDEPENDENT of route reapplication (a
  // server rebuild loses cert files while every binding stays unchanged, and
  // a healthy DB expiry would otherwise keep the repair path forever
  // unreached). Missing/mismatched material enqueues the durable worker,
  // whose repair flow re-issues; transient read failures never audit-repair.
  try {
    summary.certAuditScheduled = await auditServerCertificates(serverId, organizationId);
  } catch (error) {
    reportCaughtError(error, "platform/engine/modules/discovery/discovery-sweep");
    summary.failed.push("certificate-audit");
  }

  // CERTIFICATE CLEANUP: activated Origin CA certificates this instance
  // exclusively issued whose id is no longer referenced by ANY domain —
  // they were replaced (rotation, or a provider switch to Let's Encrypt,
  // whose completion path knows nothing about Cloudflare revocation).
  // Bounded per sweep; strictly best-effort: a revocation failure leaves the
  // certificate to expire naturally and never fails the sweep.
  try {
    const stale = await repos.discoveryTlsIssuance.findStaleIssuedForServer(serverId, 5);
    let revoked = 0;
    for (const row of stale) {
      if (!row.certificateId) continue;
      // Revoke with the ISSUING credential (persisted on the inventory row) —
      // the domain's current policy credential is cleared on a provider
      // switch and may change across reconfigurations. Legacy rows without a
      // reference fall back to the current policy credential.
      const policy = await repos.domain.getTlsPolicy(row.domainId);
      const credentialId = row.credentialId ?? policy?.tlsCfCredentialId ?? null;
      const credential = credentialId ? await repos.credential.findById(organizationId, credentialId) : undefined;
      const apiToken = credential?.provider === "cloudflare" ? readCredentialSecrets(credential).apiToken : undefined;
      if (!apiToken) continue; // credential gone/changed: the certificate expires naturally
      await revokeOriginCaCertificate(apiToken, row.certificateId);
      await repos.discoveryTlsIssuance.markRevokedAfterReplacement(row.id);
      revoked += 1;
    }
    if (revoked > 0) summary.revokedCertificates = revoked;
  } catch (error) {
    reportCaughtError(error, "platform/engine/modules/discovery/discovery-sweep");
    summary.failed.push("certificate-cleanup");
  }

  return summary;
}

/**
 * One sweep across every sweepable server: enabled ones, PLUS disabled
 * servers still owing route withdrawals (disable scheduled retirement —
 * reconcile must run for them; scan/apply/repair self-gate on `enabled`).
 * `fresh` (startup inventory) forces fresh inventory on every server; the
 * recurring cron body calls without it.
 */
export async function sweepDiscovery(options?: { fresh?: boolean }): Promise<DiscoverySweepSummary> {
  const summary: DiscoverySweepSummary = { servers: 0, failed: [], details: [] };
  let enabled: Array<{ serverId: string }>;
  try {
    enabled = await repos.discovery.listSweepableServerIds();
  } catch (error) {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-sweep",
      `[discovery-sweep] could not list sweepable servers: ${safeErrorMessage(error)}`,
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
      const detail = await sweepServerDiscovery(serverId, server.organizationId, options);
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

  // Watcher lease renewal rides the sweep (see discovery-watch): ENABLED
  // servers keep their lifecycle-event subscriptions — a disabled server's
  // watcher lease expires itself (disable "cancels watchers"). Owing-only
  // disabled servers never arm.
  const enabledIds: string[] = [];
  for (const detail of summary.details) {
    const settings = await repos.discovery.getSettings(detail.serverId).catch(() => null);
    if (settings?.enabled) enabledIds.push(detail.serverId);
  }
  await renewDiscoveryWatchers(enabledIds).catch((error) => {
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
      const summary = await sweepDiscovery(); // cron poll: interval-gated
      // The durable TLS queue drains on every tick too (restart recovery for
      // waiting/abandoned work; the in-drain pacing keeps starts ≤1/sec).
      void kickDiscoveryTlsQueue();
      return {
        servers: summary.servers,
        failed: summary.failed.length,
        repaired: summary.details.reduce((n, d) => n + (d.repair?.repaired.length ?? 0), 0),
        retained: summary.details.reduce((n, d) => n + (d.repair?.retained.length ?? 0), 0),
        requeued: summary.details.reduce((n, d) => n + (d.repair?.requeued.length ?? 0), 0),
      };
    },
  });
  // Startup inventory: converge now, don't wait for the first tick, with
  // FRESH inventory (the interval gate is a poll-cadence tool, not a startup
  // one). The watcher subscriptions arm inside the sweep's renewal.
  void trackBackgroundWork(
    sweepDiscovery({ fresh: true }).catch((error) => {
      errorDiagnostics.warn(
        "platform/engine/modules/discovery/discovery-sweep",
        `[discovery-sweep] startup inventory failed: ${safeErrorMessage(error)}`,
      );
    }),
  );
  // Resume durable TLS work abandoned by a previous process (expired leases)
  // and any waiting rows that never drained.
  void kickDiscoveryTlsQueue();
}
