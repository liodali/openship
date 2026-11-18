/**
 * Server discovery operations — the kernel surface the HTTP API and MCP call
 * (docs/docker-service-discovery-plan.md, step 3 tail).
 *
 * Every operation authorizes SERVER access first ({@link Authorization} on the
 * "server" resource), then works through the engine modules. The heavy lifting
 * stays in the engine: the scanner/reconciler/repair own all route and
 * certificate behavior, the sweep queue owns serialization — `rescan` just
 * enters the same per-server queue as every other trigger, with fresh
 * inventory.
 *
 * Explicit operator intent and its route/certificate retention behavior:
 *   - suppress: the scanner keeps observing (status visibility), no route is
 *     reconciled, and a LIVE route is retired outright (never 503-retained —
 *     explicit control). Certificate material on the server-scoped domain row
 *     is RETAINED (the row stays; re-acceptance reuses it).
 *   - unsuppress: clears the opt-out AND any not-yet-executed retirement, so
     * a change of heart doesn't delete a route the operator decided to keep.
 *   - forget: retires the route NOW (synchronously — a failed removal leaves
 *     the binding intact for retry), then deletes the binding row. The domain
 *     row is deliberately untouched: certificate files, expiry and retry state
 *     survive forgetting a service.
 *   - disable (configure {enabled:false}): schedules retirement for every
 *     applied binding; the reconciler withdraws them outright on its next pass
 *     (the one stage that runs for disabled servers). Watchers expire by
 *     lease. Certificates are retained unless separately forgotten.
 */

import { ConflictError, DISCOVERY_TLS_DEFAULT_PROVIDER } from "@repo/core";
import {
  AppError,
  DiscoveryConfigureInputSchema,
  DiscoveryRescanSchema,
  DiscoveryServiceActionInputSchema,
  DiscoveryTlsEnsureInputSchema,
  NotFoundError,
  parseInput,
  type DiscoveryRescan,
  type DiscoveryService,
  type DiscoveryStatus,
  type DiscoveryTlsEnsureResponse,
} from "@repo/contracts";
import { repos, type DiscoveryBinding, type DiscoveryTlsOperation } from "@repo/db";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import type { OperationResult } from "./deployments";
import { runInServerQueue, sweepServerDiscovery } from "./engine/modules/discovery/discovery-sweep";
import { kickDiscoveryTlsQueue } from "./engine/modules/discovery/discovery-tls-queue";
import { certComfortablyValid, manageDomainSsl } from "./engine/lib/domain-ssl";
import {
  retireBindingRoute,
  type DiscoveryEdgeTarget,
} from "./engine/modules/discovery/discovery-reconciler";

export interface PlatformDiscoveryOperations {
  configure(ctx: ExecutionContext, serverId: string, input: unknown): Promise<OperationResult<DiscoveryStatus>>;
  status(ctx: ExecutionContext, serverId: string): Promise<OperationResult<DiscoveryStatus>>;
  getService(ctx: ExecutionContext, serverId: string, input: unknown): Promise<OperationResult<DiscoveryService>>;
  rescan(ctx: ExecutionContext, serverId: string): Promise<OperationResult<DiscoveryRescan>>;
  ensureServiceTls(ctx: ExecutionContext, serverId: string, input: unknown): Promise<OperationResult<DiscoveryTlsEnsureResponse>>;
  suppress(ctx: ExecutionContext, serverId: string, input: unknown): Promise<OperationResult<DiscoveryService>>;
  unsuppress(ctx: ExecutionContext, serverId: string, input: unknown): Promise<OperationResult<DiscoveryService>>;
  forget(ctx: ExecutionContext, serverId: string, input: unknown): Promise<OperationResult<{ forgotten: boolean }>>;
}

export function createDiscoveryOperations(authorization: Authorization): PlatformDiscoveryOperations {
  async function authorizeServer(ctx: ExecutionContext, serverId: string, action: "read" | "write" | "admin"): Promise<void> {
    await authorization.authorize(ctx, { resourceType: "server", resourceId: serverId, action });
  }

  function requireBinding(serverId: string, serviceKey: string): Promise<DiscoveryBinding> {
    return (async () => {
      const row = await repos.discovery.getBinding(serverId, serviceKey);
      if (!row) throw new NotFoundError("Discovered service", serviceKey);
      return row;
    })();
  }

  /** The ONE binding→service serializer: single reads, list reads, and action
   *  responses all render through it, so TLS defaults and field formats stay
   *  identical across every surface. A missing (or partial) domain row keeps
   *  today's defaults — hostname falls back to the binding's own declaration. */
  function toService(
    row: DiscoveryBinding,
    domainRow: { hostname: string; verified: boolean | null; sslStatus: string | null; sslExpiresAt: Date | null; sslIssuer: string | null } | undefined | null,
    tlsOperation?: DiscoveryTlsOperation | null,
  ): DiscoveryService {
    return {
      id: row.id,
      serviceKey: row.serviceKey,
      composeProject: row.composeProject ?? null,
      composeService: row.composeService ?? null,
      hostname: row.hostname,
      port: row.port,
      networkName: row.networkName ?? null,
      observationStatus: row.observationStatus,
      containerName: row.containerName ?? null,
      containerRunning: row.containerRunning,
      upstreamStrategy: row.upstreamStrategy ?? null,
      ipAddress: row.ipAddress ?? null,
      hostPort: row.hostPort !== null ? String(row.hostPort) : null,
      applyState: row.applyState,
      applyError: row.applyError ?? null,
      applyAttempts: row.applyAttempts,
      nextApplyAt: row.nextApplyAt ? row.nextApplyAt.toISOString() : null,
      withdrawalPending: row.withdrawalPending,
      suppressed: row.suppressed,
      desiredGeneration: row.desiredGeneration,
      appliedGeneration: row.appliedGeneration,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      tlsDeclaredProvider: row.tlsDeclaredProvider ?? null,
      tlsDeclaredWildcard: row.tlsDeclaredWildcard ?? null,
      tlsPolicyConflict: row.tlsPolicyConflict ?? null,
      tls: {
        hostname: domainRow?.hostname ?? row.hostname,
        verified: domainRow?.verified ?? false,
        sslStatus: domainRow?.sslStatus ?? "none",
        sslExpiresAt: domainRow?.sslExpiresAt ? domainRow.sslExpiresAt.toISOString() : null,
        sslIssuer: domainRow?.sslIssuer ?? null,
      },
      tlsOperation: tlsOperation
        ? {
            operationId: tlsOperation.id,
            state: tlsOperation.state,
            source: tlsOperation.source,
            provider: tlsOperation.provider,
            reason: tlsOperation.reason ?? null,
            attempts: tlsOperation.attempts,
            updatedAt: tlsOperation.updatedAt ? tlsOperation.updatedAt.toISOString() : null,
          }
        : null,
    };
  }

  async function statusData(ctx: ExecutionContext, serverId: string): Promise<DiscoveryStatus> {
    const settings = await repos.discovery.getSettings(serverId);
    const bindings = await repos.discovery.listByServer(serverId);
    // ONE server-scoped batch lookup for every binding's domain — never a
    // per-binding query (an N+1 that scales with binding count; expect hundreds
    // to thousands per server). The empty-server case must not query at all.
    const domains = await repos.discovery.findDomainsForBindings(serverId, bindings.map((row) => row.hostname));
    // Same batching for the ACTIVE TLS operations (progress visibility).
    const tlsOperations = await repos.discoveryTlsQueue.listActiveOperationsByServer(serverId);
    void ctx;
    return {
      settings: {
        serverId,
        enabled: settings?.enabled ?? false,
        workspaceId: settings?.workspaceId ?? null,
        sweepIntervalSeconds: settings?.sweepIntervalSeconds ?? 60,
        lastScanAt: settings?.lastScanAt ? settings.lastScanAt.toISOString() : null,
        lastScanError: settings?.lastScanError ?? null,
      },
      services: bindings.map((row) =>
        toService(row, domains.get(row.hostname.toLowerCase()), tlsOperations.get(row.hostname.toLowerCase()) ?? null),
      ),
    };
  }

  const operations: PlatformDiscoveryOperations = {
    async configure(ctx, serverId, input): Promise<OperationResult<DiscoveryStatus>> {
      await authorizeServer(ctx, serverId, "admin");
      const parsed = parseInput(DiscoveryConfigureInputSchema, input ?? {});
      const settings = await repos.discovery.getSettings(serverId);
      if (!settings && !parsed.enabled) {
        // Configuring nothing to nothing: still a valid no-op state.
      }
      if (parsed.enabled) {
        const row = await repos.discovery.configure(serverId, { enabled: true });
        if (!row) throw new AppError("Discovery settings could not be written", 500, "DISCOVERY_CONFIGURE_FAILED");
      } else {
        // Disable is ATOMIC and SERIALIZED: the settings flip and the
        // withdrawal scheduling commit together (a crash in between would
        // strand live routes on a server no sweep selects), and the whole
        // operation enters the server's sweep queue — an already-started FIRST
        // route write must finish (and record appliedGeneration) before the
        // scheduling runs, or a binding without application history would be
        // excluded from retirement while its route goes live. The reconciler's
        // withdrawal stage is the one that runs for disabled servers; watcher
        // leases expire on their own.
        await runInServerQueue(serverId, async () => {
          await repos.discovery.disableAndScheduleWithdrawals(serverId);
        });
      }
      return { context: ctx, data: await statusData(ctx, serverId) };
    },

    async status(ctx, serverId): Promise<OperationResult<DiscoveryStatus>> {
      await authorizeServer(ctx, serverId, "read");
      return { context: ctx, data: await statusData(ctx, serverId) };
    },

    /** Read ONE discovered service by its stable identity — a constant-size,
     *  constant-query-count alternative to the full server status for callers
     *  (ContainerPub's site controllers) that already know the key. */
    async getService(ctx, serverId, input): Promise<OperationResult<DiscoveryService>> {
      await authorizeServer(ctx, serverId, "read");
      const { serviceKey } = parseInput(DiscoveryServiceActionInputSchema, input ?? {});
      const row = await requireBinding(serverId, serviceKey);
      const [domainRow, tlsOperation] = await Promise.all([
        repos.discovery.findDomainForBinding(serverId, row.hostname),
        repos.discoveryTlsQueue.findActiveOperationForHostname(serverId, row.hostname),
      ]);
      return { context: ctx, data: toService(row, domainRow, tlsOperation ?? null) };
    },

    async rescan(ctx, serverId): Promise<OperationResult<DiscoveryRescan>> {
      await authorizeServer(ctx, serverId, "write");
      const sweep = await sweepServerDiscovery(serverId, ctx.organizationId, { fresh: true });
      const data: DiscoveryRescan = {
        serverId,
        failed: sweep.failed,
        scan: sweep.scan ? { scanned: sweep.scan.scanned, ok: sweep.scan.ok } : null,
        reconcile: sweep.reconcile
          ? {
              applied: sweep.reconcile.applied,
              removed: sweep.reconcile.removed,
              retained: sweep.reconcile.retained,
              withdrawals: sweep.reconcile.withdrawals,
              failed: sweep.reconcile.failed,
              ok: sweep.reconcile.ok,
            }
          : null,
        repair: sweep.repair ?? null,
      };
      // Validate the shaped output against the published contract before it
      // leaves the kernel, so a drifted summary fails loudly here.
      parseInput(DiscoveryRescanSchema, JSON.parse(JSON.stringify(data)));
      return { context: ctx, data };
    },

    /**
     * Idempotent TLS ensure for ONE discovered service (plan: "Asynchronous
     * queue, ensure API"). Persists the desired TLS work through the durable
     * operation queue and returns PROMPTLY — container/application readiness
     * is never coupled to certificate issuance. Outcomes: skipped (valid
     * material for the desired provider/source already installed), queued /
     * already_queued (the SAME stable operation id — a retry never creates a
     * second job), deferred (durable wait with reason). Configuration,
     * authorization and conflicts use the normal error conventions and
     * perform no create. A kicked, paced drain does the issuing.
     */
    async ensureServiceTls(ctx, serverId, input): Promise<OperationResult<DiscoveryTlsEnsureResponse>> {
      await authorizeServer(ctx, serverId, "write");
      const { serviceKey } = parseInput(DiscoveryServiceActionInputSchema, input ?? {});
      const binding = await requireBinding(serverId, serviceKey);

      // The server-scoped domain row backs the TLS lifecycle. The shared
      // ownership helper is idempotent — no route activation and no issuance
      // happens here, only the eligible metadata this work needs.
      const { domain: domainRow } = await repos.domain.ensureServerDomain({
        serverId,
        hostname: binding.hostname,
        targetPort: binding.port,
      });
      const policy = await repos.domain.getTlsPolicy(domainRow.id);
      const provider = policy?.tlsProvider ?? DISCOVERY_TLS_DEFAULT_PROVIDER;
      const wildcard = binding.tlsDeclaredWildcard ?? null;
      const source = wildcard ? "wildcard" : "exact";
      const sourceHostname = (wildcard ?? binding.hostname).toLowerCase();

      // Cloudflare selection without its per-domain configuration waits in a
      // VISIBLE configuration-required state — no implicit Let's Encrypt
      // fallback, and no operation pretending to make progress.
      if (provider === "cloudflare-origin-ca" && !(policy?.tlsCfCredentialId && policy?.tlsCfZoneId)) {
        throw new ConflictError(
          `TLS configuration required: ${binding.hostname} is set to Cloudflare Origin CA but has no credential/zone for this domain. Configure them before ensuring.`,
          "TLS_CONFIGURATION_REQUIRED",
        );
      }

      // Skip: valid INSTALLED material for the DESIRED provider/source — proven
      // in two steps, never trusted from database metadata alone:
      //  1. Provider/source provenance: the domain's recorded installed provider
      //     must agree (an old provider's certificate during a pending switch is
      //     a fallback, not proof); wildcard intent never skips.
      //  2. The material itself: a read-only verify against the serving Edge —
      //     sslStatus/expiry columns describe bookkeeping, and a row updated by
      //     a Cloudflare-era issuance can look healthy while the installed
      //     certificate is anything but. An unusable or UNPROVABLE state (edge
      //     unreachable, verify error) queues durable work instead of skipping.
      // Due-renewal scheduling stays the scheduler's job; due-soon material
      // still skips (certComfortablyValid uses the same threshold everywhere).
      if (
        source === "exact" &&
        provider === "letsencrypt" &&
        (policy?.tlsActiveProvider == null || policy.tlsActiveProvider === "letsencrypt") &&
        domainRow.sslStatus === "active" &&
        domainRow.verified &&
        domainRow.sslExpiresAt &&
        domainRow.sslExpiresAt.getTime() > Date.now()
      ) {
        try {
          const installed = await manageDomainSsl(binding.hostname, {
            action: "verify",
            allowUnverified: true,
            serverId,
          });
          if (installed.verified && certComfortablyValid(installed)) {
            return {
              context: ctx,
              data: { outcome: "skipped", reason: "already_valid", hostname: binding.hostname, source },
            };
          }
        } catch {
          // Unprovable (edge unreachable etc.): fall through and queue — the
          // durable drain re-checks eligibility before any order opens.
        }
      }

      // A stopped/unobservable/suppressed backend defers its durable
      // operation immediately — the queue keeps the intent and the reason;
      // fresh runtime eligibility (or the next sweep) resumes it.
      const notRunnable =
        binding.suppressed ||
        binding.observationStatus !== "observed" ||
        !binding.containerRunning;
      const initialReason = notRunnable
        ? `The discovered backend for ${binding.hostname} is ${
            binding.suppressed ? "suppressed" : binding.observationStatus !== "observed" ? binding.observationStatus : "not running"
          }; certificate work waits for a running backend.`
        : undefined;

      const { operation, created } = await repos.discoveryTlsQueue.ensureOperation({
        hostname: binding.hostname,
        sourceHostname,
        source,
        provider,
        domainId: domainRow.id,
        serverId,
        organizationId: ctx.organizationId,
        serviceKey,
        policyGeneration: policy?.tlsPolicyGeneration ?? 0,
        initialReason,
      });
      if (created) kickDiscoveryTlsQueue();

      const data: DiscoveryTlsEnsureResponse =
        created && initialReason
          ? { outcome: "deferred", hostname: binding.hostname, operationId: operation.id, reason: operation.reason ?? initialReason }
          : created
            ? { outcome: "queued", hostname: binding.hostname, operationId: operation.id }
            : operation.state === "deferred"
              ? { outcome: "deferred", hostname: binding.hostname, operationId: operation.id, reason: operation.reason ?? "waiting for a runnable backend" }
              : { outcome: "already_queued", hostname: binding.hostname, operationId: operation.id };
      return { context: ctx, data };
    },

    async suppress(ctx, serverId, input): Promise<OperationResult<DiscoveryService>> {
      await authorizeServer(ctx, serverId, "write");
      const { serviceKey } = parseInput(DiscoveryServiceActionInputSchema, input ?? {});
      const binding = await requireBinding(serverId, serviceKey);
      const row = await repos.discovery.suppress(serverId, serviceKey);
      if (!row) throw new NotFoundError("Discovered service", serviceKey);
      void binding;
      return { context: ctx, data: toService(row, await repos.discovery.findDomainForBinding(serverId, row.hostname)) };
    },

    async unsuppress(ctx, serverId, input): Promise<OperationResult<DiscoveryService>> {
      await authorizeServer(ctx, serverId, "write");
      const { serviceKey } = parseInput(DiscoveryServiceActionInputSchema, input ?? {});
      const row = await repos.discovery.unsuppress(serverId, serviceKey);
      if (!row) throw new NotFoundError("Discovered service", serviceKey);
      return { context: ctx, data: toService(row, await repos.discovery.findDomainForBinding(serverId, row.hostname)) };
    },

    async forget(ctx, serverId, input): Promise<OperationResult<{ forgotten: boolean }>> {
      await authorizeServer(ctx, serverId, "admin");
      const { serviceKey } = parseInput(DiscoveryServiceActionInputSchema, input ?? {});
      // The WHOLE forget — INCLUDING the binding read — runs inside the
      // server's sweep queue. A queued scan can change the hostname before
      // this task executes; reading outside the queue would retire the OLD
      // hostname and delete the CURRENT binding, stranding its new route.
      // Inside, the read sees the post-scan row, the removal targets the right
      // hostname, and the deletion cannot interleave with a reconcile. A
      // failed removal (edge down) leaves the binding intact for a retry; the
      // domain row (certificate material) deliberately survives.
      await runInServerQueue(serverId, async () => {
        const binding = await requireBinding(serverId, serviceKey);
        await retireBindingRoute(serverId, ctx.organizationId, binding);
        await repos.discovery.forget(serverId, serviceKey);
      });
      return { context: ctx, data: { forgotten: true } };
    },
  };
  return Object.freeze(operations);
}

export type { DiscoveryEdgeTarget };
