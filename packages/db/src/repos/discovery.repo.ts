import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { discoveryBinding as binding, discoverySettings as settings, domain } from "../schema";
import type { DiscoveryDeclaration } from "@repo/core";

export type DiscoverySettings = typeof settings.$inferSelect;
export type DiscoveryBinding = typeof binding.$inferSelect;

/** One scanned container's confirmed observation, from the core parser + runtime view. */
export interface DiscoveryObservation {
  serviceKey: string;
  containerId: string;
  containerName?: string | null;
  /** Fresh `State.Running` from the scan — the certificate queue filter. */
  running: boolean;
  hostname: string;
  port: number;
  networkName: string;
  networkId?: string | null;
  ipAddress?: string | null;
  configHash: string;
  composeProject?: string | null;
  composeService?: string | null;
}

type SettingsPatch = Partial<
  Pick<DiscoverySettings, "enabled" | "workspaceId" | "sweepIntervalSeconds">
>;

/**
 * Discovery persistence (docs/docker-service-discovery-plan.md, step 3).
 *
 * Observations are the scanner's single upsert path per container. Identity
 * (serverId + serviceKey) is unique: a replacement container updates the
 * observation of the SAME binding; a config change bumps the desired
 * generation and marks the apply pending; an unchanged rescan touches nothing
 * the reconciler would act on. Removal is explicit — a failed scan never
 * classifies every service as missing.
 */
export function createDiscoveryRepo(db: Database) {
  return {
    // ── Settings ────────────────────────────────────────────────────────

    getSettings(serverId: string) {
      return db.query.discoverySettings.findFirst({ where: eq(settings.serverId, serverId) });
    },

    /** Configure (or implicitly create) the settings row. Discovery starts OFF. */
    async configure(serverId: string, patch: SettingsPatch) {
      const now = new Date();
      const [row] = await db
        .insert(settings)
        .values({ serverId, ...patch, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.serverId,
          set: { ...patch, updatedAt: now },
        })
        .returning();
      return row;
    },

    /** Clear the workspace binding (organization-level visibility). */
    async unbindWorkspace(serverId: string) {
      await db
        .update(settings)
        .set({ workspaceId: null, updatedAt: new Date() })
        .where(eq(settings.serverId, serverId));
    },

    async recordScan(serverId: string, result: { ok: true } | { ok: false; error: string }) {
      await db
        .update(settings)
        .set({
          lastScanAt: new Date(),
          ...(result.ok ? { lastScanError: null } : { lastScanError: result.error }),
          updatedAt: new Date(),
        })
        .where(eq(settings.serverId, serverId));
    },

    /** Enabled servers for watcher/sweep registration. */
    listEnabledServerIds() {
      return db
        .select({ serverId: settings.serverId })
        .from(settings)
        .where(eq(settings.enabled, true));
    },

    // ── Bindings ────────────────────────────────────────────────────────

    getBinding(serverId: string, serviceKey: string) {
      return db.query.discoveryBinding.findFirst({
        where: and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)),
      });
    },

    getBindingById(id: string) {
      return db.query.discoveryBinding.findFirst({ where: eq(binding.id, id) });
    },

    listByServer(serverId: string) {
      return db
        .select()
        .from(binding)
        .where(eq(binding.serverId, serverId))
        .orderBy(binding.serviceKey);
    },

    /**
     * Upsert one scanned container's observation. Returns the binding row plus
     * two flags the reconciler acts on:
     *  - `desiredChanged`: the DECLARED config changed (hash differs) — bump
     *    generation, reset retries, apply from scratch;
     *  - `requeued`: the RUNTIME TARGET changed (container id, IP on the
     *    selected network, or running→stopped/started→running) while config is
     *    unchanged — the route must be re-applied (new upstream, or upstream
     *    withdrawal on stop), so the binding returns to the pending queue.
     * Both bump the desired generation: it versions "what an apply must
     * converge to", and routes target the container/IP, not just the config.
     */
    async observe(serverId: string, observation: DiscoveryObservation) {
      return db.transaction(async (tx) => {
        const now = new Date();
        const desired = {
          hostname: observation.hostname,
          port: observation.port,
          networkName: observation.networkName,
          networkId: observation.networkId ?? null,
          configHash: observation.configHash,
        };
        const [existing] = await tx
          .select()
          .from(binding)
          .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, observation.serviceKey)))
          .for("update");
        if (!existing) {
          const [row] = await tx
            .insert(binding)
            .values({
              serverId,
              serviceKey: observation.serviceKey,
              composeProject: observation.composeProject ?? null,
              composeService: observation.composeService ?? null,
              containerId: observation.containerId,
              containerName: observation.containerName ?? null,
              ipAddress: observation.ipAddress ?? null,
              containerRunning: observation.running,
              observationStatus: "observed",
              lastObservedAt: now,
              applyState: "pending",
              desiredGeneration: 1,
              ...desired,
            })
            .returning();
          return { binding: row!, desiredChanged: true, requeued: false };
        }
        const desiredChanged = existing.configHash !== observation.configHash;
        const requeued =
          !desiredChanged &&
          existing.applyState !== "blocked" &&
          (existing.containerId !== observation.containerId ||
            existing.ipAddress !== (observation.ipAddress ?? null) ||
            existing.containerRunning !== observation.running);
        const [row] = await tx
          .update(binding)
          .set({
            containerId: observation.containerId,
            containerName: observation.containerName ?? null,
            ipAddress: observation.ipAddress ?? null,
            containerRunning: observation.running,
            observationStatus: "observed",
            lastObservedAt: now,
            composeProject: observation.composeProject ?? existing.composeProject,
            composeService: observation.composeService ?? existing.composeService,
            // A blocked binding (identity conflict, other owner's hostname)
            // stays blocked through observation updates — only the reconciler's
            // explicit unblock (conflict resolved) returns it to pending.
            ...(existing.applyState !== "blocked" && (desiredChanged || requeued)
              ? {
                  ...(desiredChanged ? desired : {}),
                  desiredGeneration: existing.desiredGeneration + 1,
                  applyState: "pending" as const,
                  applyError: null,
                  applyAttempts: 0,
                  nextApplyAt: null,
                }
              : desiredChanged
                ? desired
                : {}),
            updatedAt: now,
          })
          .where(eq(binding.id, existing.id))
          .returning();
        return { binding: row!, desiredChanged, requeued };
      });
    },

    /**
     * Mark a binding's container as CONFIRMED removed. The binding row and its
     * certificate metadata are RETAINED — only the application upstream goes
     * away (the reconciler withdraws the route; the domain keeps TLS state).
     */
    async markMissing(serverId: string, serviceKey: string) {
      const [row] = await db
        .update(binding)
        .set({
          observationStatus: "missing",
          containerId: null,
          containerName: null,
          ipAddress: null,
          containerRunning: false,
          updatedAt: new Date(),
        })
        .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
        .returning();
      return row;
    },

    /** Inspection failed for this binding: keep EVERYTHING, record the state. */
    async markObservationError(serverId: string, serviceKey: string) {
      const [row] = await db
        .update(binding)
        .set({ observationStatus: "error", updatedAt: new Date() })
        .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
        .returning();
      return row;
    },

    /**
     * Bindings whose desired state still needs an Edge apply, backoff elapsed,
     * not suppressed. Callers lock rows again inside their apply transaction.
     */
    dueForApply(serverId: string, now = new Date()) {
      return db
        .select()
        .from(binding)
        .where(
          and(
            eq(binding.serverId, serverId),
            eq(binding.suppressed, false),
            or(eq(binding.applyState, "pending"), eq(binding.applyState, "error")),
            or(isNull(binding.nextApplyAt), lte(binding.nextApplyAt, now)),
          ),
        );
    },

    /** Every not-suppressed binding of a set of servers (startup repair path). */
    listActiveForServers(serverIds: string[]) {
      if (serverIds.length === 0) return Promise.resolve([]);
      return db
        .select()
        .from(binding)
        .where(and(inArray(binding.serverId, serverIds), eq(binding.suppressed, false)));
    },

    /** Record a verified Edge apply for `generation` (applyState → applied). */
    async markApplied(serverId: string, serviceKey: string, generation: number) {
      const [row] = await db
        .update(binding)
        .set({
          applyState: "applied",
          appliedGeneration: generation,
          applyError: null,
          applyAttempts: 0,
          nextApplyAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(binding.serverId, serverId),
            eq(binding.serviceKey, serviceKey),
            // Stale applier: a newer generation became desired meanwhile.
            lte(binding.desiredGeneration, generation),
          ),
        )
        .returning();
      return row;
    },

    /** Record a failed apply with persisted backoff. */
    async markApplyError(serverId: string, serviceKey: string, error: string, retryAt: Date) {
      const [row] = await db
        .update(binding)
        .set({
          applyState: "error",
          applyError: error.slice(0, 500),
          applyAttempts: sql`${binding.applyAttempts} + 1`,
          nextApplyAt: retryAt,
          updatedAt: new Date(),
        })
        .where(
          // A blocked binding is not retryable, backoff or not.
          and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey), ne(binding.applyState, "blocked")),
        )
        .returning();
      return row;
    },

    /**
     * BLOCK a binding from reconciliation: duplicate live identity (two running
     * containers claim one serviceKey — never pick a replica) or a hostname an
     * existing non-discovery owner already serves (never repoint it). Stays
     * blocked across scans until the operator resolves it; re-observation
     * never clears it (see observe), only `unblock` does.
     */
    async block(serverId: string, serviceKey: string, reason: string) {
      const [row] = await db
        .update(binding)
        .set({
          applyState: "blocked",
          applyError: reason.slice(0, 500),
          nextApplyAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
        .returning();
      return row;
    },

    /** Resolve a conflict; the next reconciliation pass re-applies desired state. */
    async unblock(serverId: string, serviceKey: string) {
      const [row] = await db
        .update(binding)
        .set({
          applyState: "pending",
          applyError: null,
          applyAttempts: 0,
          nextApplyAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey), eq(binding.applyState, "blocked")),
        )
        .returning();
      return row;
    },

    /**
     * The OTHER-owner check for a candidate hostname: an existing domain row
     * served by a project/webhook/mail owner (not this server's discovery).
     * Discovery never repoints such a row — the scanner blocks instead.
     */
    findConflictingDomainOwner(serverId: string, hostname: string) {
      return db.query.domain.findFirst({
        where: and(
          eq(domain.hostname, hostname.toLowerCase()),
          or(isNull(domain.serverId), ne(domain.serverId, serverId)),
        ),
      });
    },

    /** The operator declined this declaration; the scanner keeps observing it. */
    async suppress(serverId: string, serviceKey: string) {
      const [row] = await db
        .update(binding)
        .set({ suppressed: true, suppressedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
        .returning();
      return row;
    },

    async unsuppress(serverId: string, serviceKey: string) {
      const [row] = await db
        .update(binding)
        .set({ suppressed: false, suppressedAt: null, updatedAt: new Date() })
        .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
        .returning();
      return row;
    },

    /**
     * Forget a binding entirely. The DOMAIN row is intentionally untouched —
     * certificate material, expiry and retry state survive (see schema note);
     * route retirement is the reconciler's job, never the repo's.
     */
    async forget(serverId: string, serviceKey: string) {
      await db
        .delete(binding)
        .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)));
    },

    /** Binding↔domain join helper: the server-scoped domain row for a binding.
     *  Hostnames are normalized lowercase, matching the parser's declarations. */
    findDomainForBinding(serverId: string, hostname: string) {
      return db.query.domain.findFirst({
        where: and(eq(domain.serverId, serverId), eq(domain.hostname, hostname.toLowerCase())),
      });
    },
  };
}

// Re-export the declaration type so callers can name the parser's output type
// without importing @repo/core directly in server code paths.
export type { DiscoveryDeclaration };
