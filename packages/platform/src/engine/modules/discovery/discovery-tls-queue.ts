/**
 * Durable TLS operation queue — the worker/drain side
 * (docs/cloudflare-origin-ca-discovery-plan.md, "Asynchronous queue, ensure
 * API"). The `discovery_tls_operation` rows ARE the queue; this module only
 * CLAIMS and EXECUTES them, so nothing about pending issuance lives in
 * process memory:
 *
 *  - Restart recovery: waiting rows survive; a RUNNING row whose lease expired
 *    was abandoned by a dead process and is reclaimed with the next claim.
 *  - Pacing: at most ONE issuance START per second per self-hosted instance
 *    (a start-rate cap, not a throughput promise), and at most a small bounded
 *    set of jobs in flight. Both are injectable-clock testable.
 *  - Provider budget: the per-hostname/per-box ACME locks and provider
 *    backoff live inside the shared TLS entrypoint; Cloudflare request
 *    budgets join when the Origin CA client lands. Retries back off below.
 *  - Execution reuses `manageDomainSsl` — every gate (ownership, dispatch,
 *    fresh backend, under-lock policy re-read) runs exactly as for the sweep,
 *    so the queue can never bypass an eligibility rule.
 */
import { randomUUID } from "node:crypto";
import { AppError, DISCOVERY_TLS_QUEUE, SYSTEM } from "@repo/core";
import { repos } from "@repo/db";
import { reportCaughtError } from "@repo/core/diagnostics";
import {
  activateServerDomainCert,
  activateSharedWildcardChildren,
  assertDiscoveryBackendFresh,
  DiscoveryBackendUnavailableError,
  installSharedWildcardCert,
  manageDomainSsl,
  readServerDomainCert,
  sslIssueLockKey,
} from "../../lib/domain-ssl";
import { createProvisionLock } from "../../lib/provision-lock";
import { ensureOriginCaIssued, ensureWildcardOriginCaShared } from "./origin-ca-issuance";
import { revokeOriginCaCertificate } from "./origin-ca-client";
import { installDiscoveryServerCert } from "../../lib/domain-ssl";
import { decryptSecretField } from "../../lib/credential-encryption";
import { readCredentialSecrets } from "../credentials/credential.service";
import type { DiscoveryTlsOperation } from "@repo/db";

/** Injectable clock: production wall time; tests drive spacing deterministically. */
export interface TlsQueueClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

const wallClock: TlsQueueClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Backoff for deferred/error retries: 1m → 30m cap (the sweep also re-kicks). */
function retryAt(attempts: number, now: Date): Date {
  const delay = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
  return new Date(now.getTime() + delay);
}

/** One worker identity per process (lease attribution in the table). */
const WORKER_ID = `tlsq_${process.pid}_${randomUUID().slice(0, 8)}`;

let draining = false;

/**
 * Instance-wide pacing state: the timestamp of the last issuance START across
 * ALL drains in this process. NOT local to a drain invocation — two drains
 * (an ensure kick racing a sweep tick) must not both start at the same
 * instant. Reset only by tests (a fake clock owns its own timeline).
 */
let lastStartAtMs: number | null = null;

/** Test hook: a fresh fake clock owns its own timeline; stale pacing from a
 *  previous timeline must not leak sleeps into the next test. */
export function resetDiscoveryTlsQueuePacingForTests(): void {
  lastStartAtMs = null;
}

/**
 * Drain due TLS work. Reentrancy-guarded: concurrent kicks (ensure, sweep
 * tick, boot) collapse into one loop; the next kick after this returns finds
 * the guard released. Never throws — every failure lands on its operation row
 * or diagnostics, so fire-and-forget callers stay safe.
 */
export async function drainDiscoveryTlsQueue(clock: TlsQueueClock = wallClock): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    await repos.discoveryTlsQueue.pruneCompleted(
      new Date(clock.now().getTime() - DISCOVERY_TLS_QUEUE.completeRetentionMs),
    ).catch(() => {});

    for (;;) {
      const claimed = await repos.discoveryTlsQueue.claimDueOperations({
        now: clock.now(),
        limit: DISCOVERY_TLS_QUEUE.maxInFlight,
        leasedBy: WORKER_ID,
        leaseUntil: new Date(clock.now().getTime() + DISCOVERY_TLS_QUEUE.leaseMs),
      });
      if (claimed.length === 0) return;

      // Pacing: space the STARTS one second apart — the plan's instance-wide
      // start-rate cap. The anchor is MODULE-level, so concurrent/nested drains
      // pace against the same timeline instead of each starting freely. Sleep
      // BEFORE each start (never after the last); clamp for a clock that moved
      // backwards (a stale anchor from another timeline must not sleep long).
      const runs: Promise<void>[] = [];
      for (const operation of claimed) {
        if (lastStartAtMs !== null) {
          const sinceLast = clock.now().getTime() - lastStartAtMs;
          if (sinceLast < DISCOVERY_TLS_QUEUE.startSpacingMs) {
            await clock.sleep(
              Math.min(DISCOVERY_TLS_QUEUE.startSpacingMs, DISCOVERY_TLS_QUEUE.startSpacingMs - Math.max(0, sinceLast)),
            );
          }
        }
        lastStartAtMs = clock.now().getTime();
        runs.push(executeOperation(operation, clock));
      }
      await Promise.allSettled(runs);
    }
  } catch (error) {
    reportCaughtError(error, "platform/engine/modules/discovery/discovery-tls-queue");
  } finally {
    draining = false;
  }
}

/** Kick a drain without awaiting it (enqueue paths, sweep tick, boot). */
export function kickDiscoveryTlsQueue(clock?: TlsQueueClock): void {
  void drainDiscoveryTlsQueue(clock).catch(() => {});
}

/** Execute one claimed operation through the shared TLS entrypoint.
 *
 * Every terminal write is LEASE-FENCED with this worker's identity, and the
 * lease is renewed on an interval while the work runs — an ACME run can
 * outlive the original lease window, and a lapsed lease would let another
 * worker reclaim the row mid-execution. A fenced write that returns false
 * means the operation was reclaimed: this attempt's result is stale and must
 * not overwrite the new owner's state (the reclaiming worker redoes it).
 */
async function executeOperation(operation: DiscoveryTlsOperation, clock: TlsQueueClock): Promise<void> {
  const now = () => clock.now();
  // Renew the lease at half its window while the work runs; cleared on every
  // exit path so a short execution never leaves a timer behind.
  const leaseRenewal = setInterval(() => {
    void repos.discoveryTlsQueue
      .renewOperationLease(
        operation.id,
        WORKER_ID,
        new Date(clock.now().getTime() + DISCOVERY_TLS_QUEUE.leaseMs),
        clock.now(),
      )
      .catch(() => {});
  }, DISCOVERY_TLS_QUEUE.leaseMs / 2);
  leaseRenewal.unref?.();
  try {
    // Stale-generation check: a policy change supersedes this work outright —
    // it must never issue for the old intent (stop/disable/purge/change
    // invalidate queued work before it starts). A VANISHED domain row has no
    // owner to serve: defer (the post-issuance persist would miss too).
    const currentGeneration = await repos.discoveryTlsQueue.currentPolicyGeneration(
      operation.serverId,
      operation.hostname,
    );
    if (currentGeneration === null) {
      await repos.discoveryTlsQueue.deferOperation(
        operation.id,
        `The domain record for ${operation.hostname} disappeared while this work waited; deferring.`,
        retryAt(operation.attempts, now()),
        now(),
        WORKER_ID,
      );
      return;
    }
    if (currentGeneration > operation.policyGeneration) {
      await repos.discoveryTlsQueue.completeOperation(operation.id, "superseded", now(), WORKER_ID);
      return;
    }

    // Dispatch gate mirror: exact Let's Encrypt through the shared entrypoint;
    // Cloudflare Origin CA through the dedicated resumable issuance flow (no
    // ACME fallback in either direction). Shared wildcard sources dispatch
    // through the Origin CA sharing flow; an exact-host certificate is never
    // ordered as a wildcard fallback.
    if (operation.provider === "cloudflare-origin-ca") {
      if (operation.source !== "exact") {
        await dispatchWildcardOriginCa(operation, clock);
        return;
      }
      await dispatchOriginCaIssuance(operation, clock);
      return;
    }
    if (operation.source !== "exact") {
      // A Let's Encrypt wildcard declaration is ACME DNS-01 work routed by the
      // policy, not a Cloudflare shared resource; keep it on the durable queue
      // with the shared-entrypoint gates (no exact-host fallback).
      await repos.discoveryTlsQueue.deferOperation(
        operation.id,
        `${operation.hostname} requests the shared wildcard certificate ${operation.sourceHostname}; wildcard issuance waits for the shared-certificate dispatch (no exact-host fallback).`,
        retryAt(operation.attempts, now()),
        now(),
        WORKER_ID,
      );
      return;
    }

    // Exact-host Let's Encrypt through the shared entrypoint: ownership,
    // backend freshness, dispatch and under-lock policy re-reads all apply.
    const result = await manageDomainSsl(operation.hostname, {
      action: "provision",
      allowUnverified: true,
      serverId: operation.serverId,
    });
    if (result.verified) {
      await repos.discoveryTlsQueue.completeOperation(operation.id, "issued", now(), WORKER_ID);
    } else {
      await repos.discoveryTlsQueue.deferOperation(
        operation.id,
        result.detail ?? "The certificate is not usable yet; the next attempt retries.",
        retryAt(operation.attempts, now()),
        now(),
        WORKER_ID,
      );
    }
  } catch (error) {
    if (error instanceof DiscoveryBackendUnavailableError) {
      // Durable defer: stopped/unobservable backend, disabled discovery,
      // policy switched under us — intent kept, retried with backoff.
      await repos.discoveryTlsQueue.deferOperation(
        operation.id,
        error.message,
        retryAt(operation.attempts, now()),
        now(),
        WORKER_ID,
      );
      return;
    }
    // Actionable failure: recorded on the row (sanitized), retried with
    // backoff. AppError already carries a safe message; anything else is
    // reduced to a generic reason — never a provider body or stack. A lost
    // lease (reclaimed meanwhile) discards this attempt's outcome silently:
    // the new owner redoes the work from a fresh claim.
    const reason =
      error instanceof AppError ? error.message : "Certificate issuance failed; the next attempt retries.";
    reportCaughtError(error, "platform/engine/modules/discovery/discovery-tls-queue");
    await repos.discoveryTlsQueue.failOperation(operation.id, reason, retryAt(operation.attempts, now()), now(), WORKER_ID);
  } finally {
    clearInterval(leaseRenewal);
  }
}

/**
 * The Cloudflare Origin CA dispatch: provider configuration resolution
 * (credential + zone + validity from the persisted policy), the per-hostname
 * TLS lock, the SAME fresh-backend eligibility gate ACME uses, the stale
 * generation check re-run UNDER the lock, then the resumable issuance
 * (reuse healthy active material — or resume/recover/create, ambiguity-safe).
 */
/**
 * The shared-wildcard backend gate: pick the consumer that DRIVES this
 * dispatch — the first candidate whose backend passes the SAME fresh gate
 * ACME uses. Candidates arrive in preference order: the operation's
 * original requester first (a running requester never re-keys the
 * dispatch), then authorized siblings. The operation row names whichever
 * consumer's ensure (or due-renewal scheduling) created it, and every
 * other consumer DEDUPLICATES onto that same row — so a gate on the row's
 * hostname alone would let ONE stopped requester pin the pattern's renewal
 * while a sibling runs. An ALL-stopped consumer set defers: with the
 * requester alone it keeps the exact ACME-era reason, otherwise a
 * pattern-scoped one.
 */
async function selectRunningWildcardConsumer(
  operation: Pick<DiscoveryTlsOperation, "serverId" | "organizationId" | "hostname" | "sourceHostname">,
  candidates: string[],
): Promise<string> {
  const owner = {
    kind: "server",
    serverId: operation.serverId,
    organizationId: operation.organizationId,
    isLocal: false,
    workspaceId: null,
  } as const;
  let requesterUnavailable: DiscoveryBackendUnavailableError | undefined;
  for (const candidate of candidates) {
    try {
      await assertDiscoveryBackendFresh(owner, candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof DiscoveryBackendUnavailableError)) throw error;
      requesterUnavailable ??= error;
    }
  }
  if (candidates.length > 1) {
    throw new DiscoveryBackendUnavailableError(
      `No running backend among the consumers of ${operation.sourceHostname}; shared certificate work waits for a running consumer.`,
    );
  }
  throw requesterUnavailable ??
    new DiscoveryBackendUnavailableError(
      `The discovered backend for ${operation.hostname} is not running; certificate work waits for a running backend.`,
    );
}

/**
 * The SHARED WILDCARD dispatch: one Origin CA certificate per declared
 * pattern (`*.base`), issued once and shared by every unsuppressed binding
 * declaring it. The edge resolves children through its parent-wildcard
 * lookup, so the shared pair installs ONCE under `certDir/<wildcard>/`;
 * each sharing domain's activation is fenced individually. Backend
 * eligibility is the consumer SET's, not the operation row's (see
 * {@link selectRunningWildcardConsumer}).
 */
async function dispatchWildcardOriginCa(operation: DiscoveryTlsOperation, clock: TlsQueueClock): Promise<void> {
  // Lock the PATTERN, not the site: concurrent dispatches for different
  // children sharing the wildcard serialize here instead of racing duplicate
  // issuances.
  await createProvisionLock(sslIssueLockKey(operation.sourceHostname)).run(async () => {
    const now = () => clock.now();
    try {
      const currentGeneration = await repos.discoveryTlsQueue.currentPolicyGeneration(
        operation.serverId,
        operation.hostname,
      );
      if (currentGeneration === null) {
        await defer(operation.id, `The domain record for ${operation.hostname} disappeared while this work waited; deferring.`, operation.attempts, now(), WORKER_ID);
        return;
      }
      if (currentGeneration > operation.policyGeneration) {
        await repos.discoveryTlsQueue.completeOperation(operation.id, "superseded", now(), WORKER_ID);
        return;
      }
      const policy = await repos.domain.getTlsPolicy(operation.domainId);
      if (!policy?.tlsCfCredentialId || !policy?.tlsCfZoneId) {
        await defer(operation.id, `TLS configuration required: ${operation.hostname} has no Cloudflare credential/zone for this domain.`, operation.attempts, now(), WORKER_ID);
        return;
      }
      const credential = await repos.credential.findById(operation.organizationId, policy.tlsCfCredentialId);
      if (!credential || credential.provider !== "cloudflare") {
        await defer(operation.id, `The domain's Cloudflare credential (${policy.tlsCfCredentialId}) is missing or is not a cloudflare credential.`, operation.attempts, now(), WORKER_ID);
        return;
      }
      const apiToken = readCredentialSecrets(credential).apiToken;
      if (!apiToken) {
        await defer(operation.id, "The domain's Cloudflare credential has no stored API token; re-enter it through the credentials flow.", operation.attempts, now(), WORKER_ID);
        return;
      }
      // Backend eligibility is a CONSUMER-SET property, not the operation
      // row's: the row names whichever consumer's ensure (or due-renewal
      // scheduling) created it, and every other consumer DEDUPLICATES onto
      // that same row — so a fresh gate on the row's hostname alone lets ONE
      // stopped requester pin the pattern's renewal while a sibling runs.
      // The sharing set fetched here serves both the gate and the fan-out
      // below; the original requester keeps first claim (a running
      // requester never re-keys the dispatch), and only a sibling whose
      // CURRENT row would authorize the fan-out may drive it (a driver the
      // fan-out would refuse would strand the install on an unauthorized
      // consumer). An ALL-stopped consumer set defers — the rule.
      const sharingBindings = await repos.discovery.getBindingsForWildcard(operation.serverId, operation.sourceHostname);
      const candidateHostnames = [...new Set([operation.hostname.toLowerCase(), ...sharingBindings.map((b) => b.hostname.toLowerCase())])];
      const sharingDomains = await repos.discovery.findDomainsForBindings(operation.serverId, candidateHostnames);
      type SiblingRow = NonNullable<(typeof sharingDomains) extends Map<string, infer R> ? R : never>;
      const siblingAuthorized = (row: SiblingRow | undefined): boolean =>
        !!row &&
        // The lookup is server-scoped: a row here belongs to THIS server,
        // hence this organization — the server is the org boundary.
        row.manualSsl !== true && // operator-uploaded material is never replaced by the fan-out
        row.tlsProvider === "cloudflare-origin-ca" && // policy moved on: the sibling owns its bookkeeping
        row.tlsPolicyGeneration === operation.policyGeneration; // generation moved on: fenced
      const consumerHostname = await selectRunningWildcardConsumer(operation, [
        operation.hostname.toLowerCase(),
        ...candidateHostnames.slice(1).filter((hostname) => siblingAuthorized(sharingDomains.get(hostname))),
      ]);

      // Shared-material health on the EDGE, read through the DRIVING
      // CONSUMER (the wildcard pattern has no domain row of its own; a
      // child's inherited read reports the shared certificate's
      // fingerprint). The comparison decides reuse vs repair — transient
      // read failures never trigger a re-issue.
      let activeMaterialHealthy = true;
      let activeCertificateId: string | null = null;
      const shared = await repos.domain.findOriginCaActiveDomainsForServer(operation.serverId, { limit: 25 });
      const edge = await readServerDomainCert(consumerHostname, { serverId: operation.serverId });
      if (edge.verified && edge.fingerprint) {
        const match = shared.find((row) => row.tlsCertificateFingerprint === edge.fingerprint);
        if (match) {
          activeCertificateId = match.tlsCertificateId;
          // Rotation horizon (same rule as exact issuance): near-expiry shared
          // material is replaced, not reused.
          const horizonDays = Math.max(
            1,
            Math.min(SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS, (policy.tlsValidityDays ?? 365) / 2),
          );
          if (match.sslExpiresAt && match.sslExpiresAt.getTime() <= Date.now() + horizonDays * 86_400_000) {
            activeMaterialHealthy = false;
          }
        } else activeMaterialHealthy = false; // someone else's wildcard serves there — repair
      } else if (edge.reason !== "read_error") {
        activeMaterialHealthy = false; // the shared pattern is missing on the edge
      }

      const result = await ensureWildcardOriginCaShared({
        serverId: operation.serverId,
        domainId: operation.domainId,
        operationId: operation.id,
        hostname: operation.sourceHostname,
        zoneId: policy.tlsCfZoneId,
        apiToken,
        organizationId: operation.organizationId,
        validityDays: (policy.tlsValidityDays ?? undefined) as import("@repo/core").OriginCaValidityDays | undefined,
        activeMaterialHealthy,
        activeCertificateId,
        credentialId: policy.tlsCfCredentialId,
      });
      // The fan-out's authorization (needed on BOTH success paths: siblings
      // must actually SERVE the pattern before any inventory is committed).
      // A DECLARING BINDING IS NOT AUTHORIZATION: the fan-out authorizes each
      // sibling's CURRENT ownership, policy, and generation — before its
      // route or certificate files are touched — because the sharing query
      // includes blocked ownership conflicts and stale declarations. A
      // sibling that fails any check is skipped untouched; its own durable
      // operation re-checks and handles it. Only the DRIVING CONSUMER is
      // pre-authorized (the selection above ran its fresh gate); the
      // original requester is NOT — a requester whose row moved on must not
      // have its route switched by a sibling's dispatch.
      const childHostname = consumerHostname;
      const authorizedSiblings = candidateHostnames.filter(
        (hostname) => hostname === childHostname || siblingAuthorized(sharingDomains.get(hostname)),
      );
      // The checks above are necessary but NOT sufficient: they run while
      // holding only the PATTERN lock, and a sibling can switch to Let's
      // Encrypt under its OWN hostname lock between this read and the
      // install — which would then delete that sibling's exact certificate
      // and renewal record. The later database fence cannot restore Edge
      // files. So every mutation below first acquires each authorized
      // sibling's hostname lock, RE-READS the sibling rows under the locks,
      // re-filters, and only then touches the filesystem. Compatible lock
      // order (pattern → sibling): a sibling's exact/dispatch work takes
      // only its own hostname lock, and a sibling's wildcard operation takes
      // the SAME pattern lock first — no path acquires them in reverse, so
      // the nesting cannot deadlock.
      const withSiblingLocks = async <T>(
        work: (authorized: string[]) => Promise<T>,
      ): Promise<T | null> => {
        const descend = async (index: number): Promise<T | null> => {
          if (index >= authorizedSiblings.length) {
            // Every sibling lock is held: re-read NOW — the moment a
            // sibling's own provisioning acquires its hostname lock and
            // flips provider, this read observes it.
            const fresh = await repos.discovery.findDomainsForBindings(operation.serverId, authorizedSiblings);
            if (!siblingAuthorized(fresh.get(childHostname))) return null; // the driver's own policy moved: defer everything
            return work(authorizedSiblings.filter((h) => h === childHostname || siblingAuthorized(fresh.get(h))));
          }
          return createProvisionLock(sslIssueLockKey(authorizedSiblings[index])).run(() => descend(index + 1));
        };
        return descend(0);
      };
      if (result.outcome === "reused") {
        // The shared pattern is healthy on the edge — but a consumer whose
        // route was never activated (newly enrolled, or superseded before its
        // own operation ran) stays without TLS unless it is switched to the
        // pattern HERE: reuse would otherwise only commit database inventory.
        // Every health read in this dispatch was resolved through certDir,
        // where the parent-wildcard pair satisfies the read the moment ANY
        // consumer installed it — a child whose live vhost still serves the
        // enrollment bootstrap pair (it was applied before the pattern
        // material existed) reads as healthy without serving it. Activation
        // is idempotent (a re-register that resolves to the pattern rewrites
        // the vhost to it), so the fan-out repairs exactly that state for
        // every authorized consumer; "reused" must mean every authorized
        // consumer SERVES the pattern, not just that the resolver can read
        // it.
        const authorized = await withSiblingLocks(async (authorized) =>
          activateSharedWildcardChildren(
            consumerHostname,
            operation.sourceHostname,
            authorized,
            { serverId: operation.serverId },
          ),
        );
        if (authorized === null) {
          await defer(operation.id, `The TLS policy for ${consumerHostname} moved on while its wildcard operation waited; the domain's own dispatch takes over from here.`, operation.attempts, now(), WORKER_ID);
          return;
        }
        // Commit THIS domain's inventory from the issuing row (sharing
        // activation), then complete.
        if (result.issuanceId) {
          await repos.discoveryTlsIssuance.markActive({
            issuanceId: result.issuanceId,
            domainId: operation.domainId,
            expectedServerId: operation.serverId,
            expectedTlsProvider: "cloudflare-origin-ca",
            expectedPolicyGeneration: operation.policyGeneration,
          });
        }
        await repos.discoveryTlsQueue.completeOperation(operation.id, "reused", now(), WORKER_ID);
        return;
      }
      if (result.outcome === "issued") {
        // Install the shared pair under the PATTERN directory (children
        // inherit it through the edge's parent-wildcard resolution).
        const row = await repos.discoveryTlsIssuance.findLiveWildcardIssuance(operation.serverId, operation.sourceHostname);
        if (!row || !row.certificatePem || !row.fingerprint || !row.keyEnc) {
          await defer(operation.id, `The shared wildcard inventory for ${operation.sourceHostname} is incomplete; the next attempt retries.`, operation.attempts, now(), WORKER_ID);
          return;
        }
        // Narrowed above; captured into consts because the install closure
        // below does not inherit control-flow narrowing.
        const certificatePem: string = row.certificatePem;
        const expectedFingerprint: string = row.fingerprint;
        const keyPem = decryptSecretField(row.keyEnc);
        if (!keyPem) {
          await repos.discoveryTlsIssuance.markFailed(result.issuanceId, "the shared wildcard private key could not be unsealed for installation");
          await defer(operation.id, `The pending private key for ${operation.sourceHostname} could not be unsealed; the issuance was retired and a fresh one follows.`, operation.attempts, now(), WORKER_ID);
          return;
        }
        // Authorized through the DRIVING CONSUMER (the wildcard has no
        // domain row of its own). Under the sibling locks (freshly
        // re-checked rows), the material lands in the pattern directory and
        // every AUTHORIZED sharing route is switched to it — with rollback —
        // before any inventory below is committed.
        const install = await withSiblingLocks(async (authorized) => {
          const installed = await installSharedWildcardCert(
            consumerHostname,
            operation.sourceHostname,
            { certPem: certificatePem, keyPem },
            {
              serverId: operation.serverId,
              expectedFingerprint,
              children: authorized,
              // This dispatch IS the authorized provider operation (fenced on
              // policy + generation): a certbot-managed exact certificate that
              // shadows the pattern is replaced, with renewal ownership
              // transferred to the shared material.
              replaceCertbot: true,
            },
          );
          // Inventory commit mirrors the AUTHORIZED fan-out (fenced per
          // domain; refusals are skipped — those domains' own operations
          // handle them). Siblings dropped by the under-lock re-check keep
          // their old bookkeeping untouched — like their Edge files.
          for (const hostname of authorized) {
            const domainRow = sharingDomains.get(hostname);
            if (!domainRow) continue;
            await repos.discoveryTlsIssuance
              .markActive({
                issuanceId: result.issuanceId,
                domainId: domainRow.id,
                expectedServerId: operation.serverId,
                expectedTlsProvider: "cloudflare-origin-ca",
                expectedPolicyGeneration: operation.policyGeneration,
              })
              .catch(() => {});
          }
          return installed;
        });
        if (install === null) {
          await defer(operation.id, `The TLS policy for ${consumerHostname} moved on while its wildcard operation waited; the domain's own dispatch takes over from here.`, operation.attempts, now(), WORKER_ID);
          return;
        }
        if (!install.result.verified) {
          await defer(operation.id, `The shared certificate for ${operation.sourceHostname} is not serving yet; the previous certificate remains on the edge.`, operation.attempts, now(), WORKER_ID);
          return;
        }
        // The issuing row is now terminal-active; pending key material wiped.
        await repos.discoveryTlsQueue.completeOperation(operation.id, "installed", now(), WORKER_ID);
        return;
      }
      // unknown: ambiguity/recovery in progress — visible, bounded, no duplicate.
      await defer(operation.id, result.reason, operation.attempts, now(), WORKER_ID);
    } catch (error) {
      if (error instanceof DiscoveryBackendUnavailableError) {
        await defer(operation.id, error.message, operation.attempts, now(), WORKER_ID);
        return;
      }
      const reason =
        error instanceof AppError ? error.message : "Shared wildcard issuance failed; the next attempt retries.";
      reportCaughtError(error, "platform/engine/modules/discovery/discovery-tls-queue");
      await defer(operation.id, reason, operation.attempts, now(), WORKER_ID);
    }
  });
}

async function dispatchOriginCaIssuance(operation: DiscoveryTlsOperation, clock: TlsQueueClock): Promise<void> {
  await createProvisionLock(sslIssueLockKey(operation.hostname)).run(async () => {
    const now = () => clock.now();
    try {
      // Under-lock policy re-read: a policy change while this job waited must
      // not issue for the old intent (mirror of the ACME under-lock guard).
      const currentGeneration = await repos.discoveryTlsQueue.currentPolicyGeneration(
        operation.serverId,
        operation.hostname,
      );
      if (currentGeneration === null) {
        await defer(operation.id, `The domain record for ${operation.hostname} disappeared while this work waited; deferring.`, operation.attempts, now(), WORKER_ID);
        return;
      }
      if (currentGeneration > operation.policyGeneration) {
        await repos.discoveryTlsQueue.completeOperation(operation.id, "superseded", now(), WORKER_ID);
        return;
      }

      // Provider configuration from the persisted policy.
      const policy = await repos.domain.getTlsPolicy(operation.domainId);
      if (!policy?.tlsCfCredentialId || !policy?.tlsCfZoneId) {
        await defer(operation.id, `TLS configuration required: ${operation.hostname} has no Cloudflare credential/zone for this domain.`, operation.attempts, now(), WORKER_ID);
        return;
      }
      const credential = await repos.credential.findById(operation.organizationId, policy.tlsCfCredentialId);
      if (!credential || credential.provider !== "cloudflare") {
        await defer(operation.id, `The domain's Cloudflare credential (${policy.tlsCfCredentialId}) is missing or is not a cloudflare credential.`, operation.attempts, now(), WORKER_ID);
        return;
      }
      const apiToken = readCredentialSecrets(credential).apiToken;
      if (!apiToken) {
        await defer(operation.id, "The domain's Cloudflare credential has no stored API token; re-enter it through the credentials flow.", operation.attempts, now(), WORKER_ID);
        return;
      }

      // Backend eligibility: the SAME fresh-inspection contract ACME uses —
      // absent/stopped/unobservable defers, never issues.
      await assertDiscoveryBackendFresh(
        { kind: "server", serverId: operation.serverId, organizationId: operation.organizationId, isLocal: false, workspaceId: null },
        operation.hostname,
      );


      // EDGE health for the reuse decision: active inventory in the DATABASE
      // can lie (a rebuilt server lost the cert files). When the domain
      // records active Origin CA material, the edge fingerprint decides:
      // matching → reuse/rotate by expiry; missing/mismatched → repair (a
      // fresh issuance, no reuse). A transient read failure NEVER triggers
      // repair — the reuse decision simply stands this cycle.
      let activeMaterialHealthy = true;
      const inventory = await repos.domain.findById(operation.domainId);
      if (inventory?.tlsCertificateId && inventory.tlsActiveProvider === "cloudflare-origin-ca") {
        const edge = await readServerDomainCert(operation.hostname, { serverId: operation.serverId });
        if (edge.verified && edge.fingerprint) {
          activeMaterialHealthy = edge.fingerprint === inventory.tlsCertificateFingerprint;
        } else if (edge.reason !== "read_error") {
          activeMaterialHealthy = false; // missing or unusable on the edge → repair
        }
      }

      const result = await ensureOriginCaIssued({
        domainId: operation.domainId,
        operationId: operation.id,
        hostname: operation.hostname,
        zoneId: policy.tlsCfZoneId,
        apiToken,
        organizationId: operation.organizationId,
        validityDays: (policy.tlsValidityDays ?? undefined) as import("@repo/core").OriginCaValidityDays | undefined,
        activeMaterialHealthy,
        credentialId: policy.tlsCfCredentialId,
      });
      if (result.outcome === "reused") {
        // Reuse proved the exact material is READABLE on the edge — not that
        // the route references it: the read resolves through certDir, so a
        // vhost still serving its enrollment bootstrap pair (or a route lost
        // after a partial install) reads as healthy while visitors get the
        // bootstrap certificate. Re-activate the route (idempotent
        // re-register + reload) before completing, so "active" inventory
        // keeps meaning the route SERVES the recorded certificate.
        await activateServerDomainCert(operation.hostname, { serverId: operation.serverId });
        await repos.discoveryTlsQueue.completeOperation(operation.id, "reused", now(), WORKER_ID);
        return;
      }
      if (result.outcome === "issued") {
        // INSTALLATION PHASE — same dispatch, same per-hostname lock, fresh
        // gates: policy generation and running-backend are re-checked right
        // here (not at enqueue), then the shared installer puts the candidate
        // on the server's edge with its rollback protection.
        const generationBeforeInstall = await repos.discoveryTlsQueue.currentPolicyGeneration(
          operation.serverId,
          operation.hostname,
        );
        if (generationBeforeInstall === null) {
          await defer(operation.id, `The domain record for ${operation.hostname} disappeared before installation; deferring.`, operation.attempts, now(), WORKER_ID);
          return;
        }
        if (generationBeforeInstall > operation.policyGeneration) {
          await repos.discoveryTlsQueue.completeOperation(operation.id, "superseded", now(), WORKER_ID);
          return;
        }
        // The candidate inventory carries the PUBLIC certificate and the
        // SEALED private key — unsealed exactly once, here, for the install.
        const candidate = await repos.discoveryTlsIssuance.findLiveIssuance(operation.domainId);
        if (
          !candidate ||
          candidate.state !== "candidate" ||
          !candidate.certificatePem ||
          !candidate.fingerprint ||
          !candidate.keyEnc
        ) {
          await defer(operation.id, `The issued certificate inventory for ${operation.hostname} is incomplete; the next attempt retries.`, operation.attempts, now(), WORKER_ID);
          return;
        }
        const keyPem = decryptSecretField(candidate.keyEnc);
        if (!keyPem) {
          // DEFINITIVE (not ambiguous): an unsealable key can never install.
          await repos.discoveryTlsIssuance.markFailed(result.issuanceId, "the issued private key could not be unsealed for installation");
          await defer(operation.id, `The pending private key for ${operation.hostname} could not be unsealed; the issuance was retired and a fresh one follows.`, operation.attempts, now(), WORKER_ID);
          return;
        }
        const install = await installDiscoveryServerCert(
          operation.hostname,
          { certPem: candidate.certificatePem, keyPem },
          { serverId: operation.serverId, expectedFingerprint: candidate.fingerprint },
        );
        if (!install.result.verified) {
          await defer(operation.id, `The certificate for ${operation.hostname} is not serving yet; the previous certificate remains on the edge.`, operation.attempts, now(), WORKER_ID);
          return;
        }
        // Durable activation commit — FENCED against a policy that moved on
        // while the asynchronous installation ran: the transaction re-checks
        // server ownership, provider, and generation under the write lock and
        // writes the domain inventory (+ verified) only if all three still
        // match the intent this certificate was issued for. A refusal commits
        // NOTHING (the pending key is not wiped either): the intent is retired
        // as superseded and the next generation issues its own material.
        // Capture the PREVIOUS active certificate (for cleanup) before the
        // activation commit overwrites the domain inventory.
        const previousCertificateId = (await repos.domain.findById(operation.domainId))?.tlsCertificateId ?? null;
        const activation = await repos.discoveryTlsIssuance.markActive({
          issuanceId: result.issuanceId,
          domainId: operation.domainId,
          expectedServerId: operation.serverId,
          expectedTlsProvider: "cloudflare-origin-ca",
          expectedPolicyGeneration: operation.policyGeneration,
        });
        if (!activation.activated) {
          await repos.discoveryTlsIssuance.markSuperseded(result.issuanceId);
          await repos.discoveryTlsQueue.completeOperation(operation.id, "superseded", now(), WORKER_ID);
          return;
        }
        // CLEANUP: a REPLACED certificate is revoked when it is EXCLUSIVELY
        // ours (an issuance row proves we issued it — uploaded/adopted certs
        // are never touched) and no OTHER domain still references it.
        // Best-effort: a provider outage here never fails the durable success
        // already committed; the certificate simply expires naturally.
        if (previousCertificateId && previousCertificateId !== result.certificateId) {
          const managed = await repos.discoveryTlsIssuance.findByCertificateId(previousCertificateId);
          if (managed) {
            const foreignUsage = await repos.domain.countByCertificateId(previousCertificateId, operation.domainId);
            if (foreignUsage === 0) {
              // Revoke with the credential that ISSUED the replaced
              // certificate (the current policy token may name a different
              // credential after a reconfiguration; the issuance row carries
              // the issuing reference).
              const issuingCredentialId = managed.credentialId ?? policy.tlsCfCredentialId;
              const issuingCredential = issuingCredentialId
                ? await repos.credential.findById(operation.organizationId, issuingCredentialId)
                : undefined;
              const issuingToken =
                issuingCredential?.provider === "cloudflare" ? readCredentialSecrets(issuingCredential).apiToken : undefined;
              if (issuingToken) {
                await revokeOriginCaCertificate(issuingToken, previousCertificateId).catch((error) => {
                  reportCaughtError(error, "platform/engine/modules/discovery/discovery-tls-queue");
                });
              }
            }
          }
        }
        await repos.discoveryTlsQueue.completeOperation(
          operation.id,
          install.outcome === "recovered" ? "recovered" : "installed",
          now(),
          WORKER_ID,
        );
        return;
      }
      // unknown: ambiguity/recovery in progress — visible, bounded, no duplicate.
      await defer(operation.id, result.reason, operation.attempts, now(), WORKER_ID);
    } catch (error) {
      if (error instanceof DiscoveryBackendUnavailableError) {
        await defer(operation.id, error.message, operation.attempts, now(), WORKER_ID);
        return;
      }
      const reason =
        error instanceof AppError ? error.message : "Origin CA issuance failed; the next attempt retries.";
      reportCaughtError(error, "platform/engine/modules/discovery/discovery-tls-queue");
      await defer(operation.id, reason, operation.attempts, now(), WORKER_ID);
    }
  });
}

/** Local helper: the worker's defer call with its lease identity. */
async function defer(
  operationId: string,
  reason: string,
  attempts: number,
  now: Date,
  leasedBy: string,
): Promise<void> {
  await repos.discoveryTlsQueue.deferOperation(operationId, reason, retryAt(attempts, now), now, leasedBy);
}
