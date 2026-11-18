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
import { AppError, DISCOVERY_TLS_QUEUE } from "@repo/core";
import { repos } from "@repo/db";
import { reportCaughtError } from "@repo/core/diagnostics";
import { manageDomainSsl, DiscoveryBackendUnavailableError } from "../../lib/domain-ssl";
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

    let lastStartAt: number | null = null;
    for (;;) {
      const claimed = await repos.discoveryTlsQueue.claimDueOperations({
        now: clock.now(),
        limit: DISCOVERY_TLS_QUEUE.maxInFlight,
        leasedBy: WORKER_ID,
        leaseUntil: new Date(clock.now().getTime() + DISCOVERY_TLS_QUEUE.leaseMs),
      });
      if (claimed.length === 0) return;

      // Pacing: space the STARTS one second apart — the plan's instance-wide
      // start-rate cap. Sleeping BEFORE each start (never after the last)
      // keeps an idle drain free of trailing waits. (A null sentinel, not 0:
      // an injected clock may legitimately start at epoch zero.)
      const runs: Promise<void>[] = [];
      for (const operation of claimed) {
        if (lastStartAt !== null) {
          const sinceLast = clock.now().getTime() - lastStartAt;
          if (sinceLast < DISCOVERY_TLS_QUEUE.startSpacingMs) {
            await clock.sleep(DISCOVERY_TLS_QUEUE.startSpacingMs - sinceLast);
          }
        }
        lastStartAt = clock.now().getTime();
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

/** Execute one claimed operation through the shared TLS entrypoint. */
async function executeOperation(operation: DiscoveryTlsOperation, clock: TlsQueueClock): Promise<void> {
  const now = () => clock.now();
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
      );
      return;
    }
    if (currentGeneration > operation.policyGeneration) {
      await repos.discoveryTlsQueue.completeOperation(operation.id, "superseded", now());
      return;
    }

    // Dispatch gate mirror: until provider/source dispatch exists, exact
    // Let's Encrypt is the ONLY executable work. Cloudflare/wildcard intent
    // stays durably deferred — never an ACME fallback, never an exact-host
    // fallback — and the persisted row keeps it visible for the dispatch step.
    if (operation.provider !== "letsencrypt" || operation.source !== "exact") {
      await repos.discoveryTlsQueue.deferOperation(
        operation.id,
        operation.provider !== "letsencrypt"
          ? `Cloudflare Origin CA issuance for ${operation.hostname} waits for the provider dispatch (no Let's Encrypt fallback).`
          : `${operation.hostname} requests the shared wildcard certificate ${operation.sourceHostname}; wildcard issuance waits for the shared-certificate dispatch (no exact-host fallback).`,
        retryAt(operation.attempts, now()),
        now(),
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
      await repos.discoveryTlsQueue.completeOperation(operation.id, "issued", now());
    } else {
      await repos.discoveryTlsQueue.deferOperation(
        operation.id,
        result.detail ?? "The certificate is not usable yet; the next attempt retries.",
        retryAt(operation.attempts, now()),
        now(),
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
      );
      return;
    }
    // Actionable failure: recorded on the row (sanitized), retried with
    // backoff. AppError already carries a safe message; anything else is
    // reduced to a generic reason — never a provider body or stack.
    const reason =
      error instanceof AppError ? error.message : "Certificate issuance failed; the next attempt retries.";
    reportCaughtError(error, "platform/engine/modules/discovery/discovery-tls-queue");
    await repos.discoveryTlsQueue.failOperation(operation.id, reason, retryAt(operation.attempts, now()), now());
  }
}
