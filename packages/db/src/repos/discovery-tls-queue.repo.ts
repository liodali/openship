import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { DiscoveryTlsOperationSource, DiscoveryTlsOperationState, DiscoveryTlsProvider } from "@repo/core";
import type { Database } from "../client";
import { discoveryTlsOperation as operation, domain } from "../schema";

export type DiscoveryTlsOperation = typeof operation.$inferSelect;

/**
 * Persistence for the durable TLS operation queue
 * (docs/cloudflare-origin-ca-discovery-plan.md, "Asynchronous queue, ensure
 * API"). The rows ARE the queue: enqueue is a dedup'd insert, the drain
 * claims due work with short leases (SKIP LOCKED — safe across processes),
 * and every terminal/deferred transition is a single conditional write.
 *
 * Dedup identity: ONE ACTIVE operation per (serverId, sourceHostname,
 * policyGeneration) — the plan's "certificate source + organization + serving
 * Edge + provider/policy generation". A retried ensure or reconciler trigger
 * hits the unique index and gets the SAME operation back; a policy change
 * bumps the generation and supersedes stale work at claim time.
 */
export function createDiscoveryTlsQueueRepo(db: Database) {
  const ACTIVE_STATES = ["waiting", "running", "deferred", "error"] as const;

  return {
    /**
     * Idempotent enqueue: create the operation, or return the EXISTING active
     * one for this (server, source, generation). `initialReason` seeds a
     * deferred state directly (stopped backend at ensure time keeps its
     * durable operation instead of pretending to be startable).
     */
    async ensureOperation(input: {
      hostname: string;
      sourceHostname: string;
      source: DiscoveryTlsOperationSource;
      provider: DiscoveryTlsProvider;
      domainId: string;
      serverId: string;
      organizationId: string;
      serviceKey: string;
      policyGeneration: number;
      initialReason?: string;
    }): Promise<{ operation: DiscoveryTlsOperation; created: boolean }> {
      const [created] = await db
        .insert(operation)
        .values({
          id: generateId("dtop"),
          hostname: input.hostname.toLowerCase(),
          sourceHostname: input.sourceHostname.toLowerCase(),
          source: input.source,
          provider: input.provider,
          domainId: input.domainId,
          serverId: input.serverId,
          organizationId: input.organizationId,
          serviceKey: input.serviceKey,
          policyGeneration: input.policyGeneration,
          state: input.initialReason ? "deferred" : "waiting",
          reason: input.initialReason ?? null,
        })
        // The partial unique index is the arbiter: a racing or retried ensure
        // inserts nothing and reads the existing row instead. (No conflict
        // TARGET: targetless ON CONFLICT DO NOTHING catches every unique
        // violation, including the partial active-states index.)
        .onConflictDoNothing()
        .returning();
      if (created) return { operation: created, created: true };
      const existing = await this.findActiveOperation(input.serverId, input.sourceHostname, input.policyGeneration);
      // The index guarantees an active row exists here; a missing read is a
      // torn state we refuse to paper over.
      if (!existing) throw new Error("TLS operation dedup read lost its row; retrying is safe");
      return { operation: existing, created: false };
    },

    /** The active operation for a dedup identity, or null. */
    findActiveOperation(serverId: string, sourceHostname: string, policyGeneration: number) {
      return db.query.discoveryTlsOperation.findFirst({
        where: and(
          eq(operation.serverId, serverId),
          eq(operation.sourceHostname, sourceHostname.toLowerCase()),
          eq(operation.policyGeneration, policyGeneration),
          inArray(operation.state, [...ACTIVE_STATES]),
        ),
      });
    },

    /** The active operation for a hostname on a server (single-service reads). */
    async findActiveOperationForHostname(serverId: string, hostname: string): Promise<DiscoveryTlsOperation | undefined> {
      return db.query.discoveryTlsOperation.findFirst({
        where: and(
          eq(operation.serverId, serverId),
          eq(operation.hostname, hostname.toLowerCase()),
          inArray(operation.state, [...ACTIVE_STATES]),
        ),
        orderBy: [asc(operation.createdAt)],
      });
    },

    /** Active operations for a server, keyed for status joins by hostname. */
    async listActiveOperationsByServer(serverId: string): Promise<Map<string, DiscoveryTlsOperation>> {
      const rows = await db
        .select()
        .from(operation)
        .where(and(eq(operation.serverId, serverId), inArray(operation.state, [...ACTIVE_STATES])))
        .orderBy(asc(operation.createdAt));
      // First-by-creation wins when several share a hostname (a superseded
      // generation's row may linger until its claim-time supersede).
      const out = new Map<string, DiscoveryTlsOperation>();
      for (const row of rows) if (!out.has(row.hostname)) out.set(row.hostname, row);
      return out;
    },

    /**
     * Claim up to `limit` startable operations for this worker. Startable:
     * waiting and due (next_attempt_at passed or null), OR any active row
     * whose LEASE expired (a running row from a dead process — restart
     * recovery — and deferred/error rows past their backoff share the claim).
     * SKIP LOCKED keeps concurrent drains safe; the returned rows are
     * state='running' with a fresh short lease and attempts already bumped.
     */
    async claimDueOperations(input: {
      now: Date;
      limit: number;
      leasedBy: string;
      leaseUntil: Date;
    }): Promise<DiscoveryTlsOperation[]> {
      return db.transaction(async (tx) => {
        const due = await tx
          .select({ id: operation.id })
          .from(operation)
          .where(
            and(
              inArray(operation.state, [...ACTIVE_STATES]),
              // NO live lease: unleased, or the holder's lease expired (a
              // running row from a dead process — restart recovery).
              or(isNull(operation.leasedUntil), lte(operation.leasedUntil, input.now)),
              // Backoff due: no scheduled retry, or it has passed.
              or(isNull(operation.nextAttemptAt), lte(operation.nextAttemptAt, input.now)),
            ),
          )
          .orderBy(asc(operation.nextAttemptAt), asc(operation.createdAt))
          .limit(input.limit)
          .for("update", { skipLocked: true });
        if (due.length === 0) return [];
        const claimed = await tx
          .update(operation)
          .set({
            state: "running",
            leasedBy: input.leasedBy,
            leasedUntil: input.leaseUntil,
            attempts: sql`${operation.attempts} + 1`,
            reason: null,
            updatedAt: input.now,
          })
          .where(
            and(
              inArray(
                operation.id,
                due.map((row) => row.id),
              ),
              // Conditional re-check: only rows still in a claimable state
              // flip (a concurrent completer wins otherwise).
              inArray(operation.state, [...ACTIVE_STATES]),
            ),
          )
          .returning();
        return claimed;
      });
    },

    /**
     * Extend a held lease (long-running work: an ACME run can outlive the
     * original lease window). Returns false when the lease was already lost —
     * another worker reclaimed the row and owns it now.
     */
    async renewOperationLease(id: string, leasedBy: string, leasedUntil: Date, now = new Date()): Promise<boolean> {
      const renewed = await db
        .update(operation)
        .set({ leasedUntil, updatedAt: now })
        .where(and(eq(operation.id, id), eq(operation.state, "running"), eq(operation.leasedBy, leasedBy)))
        .returning();
      return renewed.length > 0;
    },

    /**
     * Terminal success. LEASE-FENCED: only the worker that still owns the
     * lease may complete the row — a stale worker whose operation was
     * reclaimed (expired lease) must never overwrite the new owner's state.
     * Frees the dedup slot for future renewal work. Returns whether THIS
     * caller's write won.
     */
    async completeOperation(id: string, outcome: "issued" | "reused" | "superseded", now = new Date(), leasedBy?: string): Promise<boolean> {
      const completed = await db
        .update(operation)
        .set({ state: "complete", outcome, reason: null, leasedBy: null, leasedUntil: null, updatedAt: now })
        .where(
          and(
            eq(operation.id, id),
            inArray(operation.state, ["running", "waiting", "deferred", "error"]),
            // FENCE: absent for supersede/admin paths, required for workers.
            ...(leasedBy ? [eq(operation.leasedBy, leasedBy)] : []),
          ),
        )
        .returning();
      return completed.length > 0;
    },

    /**
     * Durable wait: intent kept, retried at `retryAt`. LEASE-FENCED like
     * completeOperation — returns false when the lease was lost mid-flight.
     */
    async deferOperation(id: string, reason: string, retryAt: Date, now = new Date(), leasedBy?: string): Promise<boolean> {
      const deferred = await db
        .update(operation)
        .set({ state: "deferred", reason: reason.slice(0, 500), nextAttemptAt: retryAt, leasedBy: null, leasedUntil: null, updatedAt: now })
        .where(
          and(
            eq(operation.id, id),
            eq(operation.state, "running"),
            ...(leasedBy ? [eq(operation.leasedBy, leasedBy)] : []),
          ),
        )
        .returning();
      return deferred.length > 0;
    },

    /**
     * Actionable failure: still active (retryable), with backoff.
     * LEASE-FENCED like completeOperation.
     */
    async failOperation(id: string, reason: string, retryAt: Date, now = new Date(), leasedBy?: string): Promise<boolean> {
      const failed = await db
        .update(operation)
        .set({ state: "error", reason: reason.slice(0, 500), nextAttemptAt: retryAt, leasedBy: null, leasedUntil: null, updatedAt: now })
        .where(
          and(
            eq(operation.id, id),
            eq(operation.state, "running"),
            ...(leasedBy ? [eq(operation.leasedBy, leasedBy)] : []),
          ),
        )
        .returning();
      return failed.length > 0;
    },

    /**
     * Supersede every active operation for a hostname whose policy generation
     * fell behind the domain's current one — a policy change invalidated that
     * queued work; it must never issue for the old intent.
     */
    async supersedeStaleOperations(input: { serverId: string; hostname: string; currentGeneration: number }): Promise<number> {
      const stale = await db
        .update(operation)
        .set({ state: "complete", outcome: "superseded", reason: null, leasedBy: null, leasedUntil: null, updatedAt: new Date() })
        .where(
          and(
            eq(operation.serverId, input.serverId),
            eq(operation.hostname, input.hostname.toLowerCase()),
            inArray(operation.state, [...ACTIVE_STATES]),
            sql`${operation.policyGeneration} < ${input.currentGeneration}`,
          ),
        )
        .returning();
      return stale.length;
    },

    /** Bounded history: completed operations older than the retention window go. */
    async pruneCompleted(before: Date): Promise<number> {
        const removed = await db
          .delete(operation)
          .where(and(eq(operation.state, "complete"), lte(operation.updatedAt, before)))
          .returning();
        return removed.length;
    },

    /** The domain row's CURRENT policy generation for a hostname (supersede checks). */
    async currentPolicyGeneration(serverId: string, hostname: string): Promise<number | null> {
      const [row] = await db
        .select({ generation: domain.tlsPolicyGeneration })
        .from(domain)
        .where(and(eq(domain.serverId, serverId), eq(domain.hostname, hostname.toLowerCase())))
        .limit(1);
      return row?.generation ?? null;
    },
  };
}

export type DiscoveryTlsQueueRepo = ReturnType<typeof createDiscoveryTlsQueueRepo>;
