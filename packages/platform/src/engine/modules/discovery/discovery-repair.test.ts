import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoveryConfigHash } from "@repo/core";

// ── In-memory discovery repo (same contract as the reconciler tests) ────────
// NOTE: mocked modules are reached through these top-level handles, never
// through the `repos` import binding — touching the binding forces the hoisted
// factory to run before its dependencies initialize.

const state = {
  settings: { enabled: true } as { enabled: boolean } | null,
  bindings: [] as Array<Record<string, unknown>>,
};

const discoveryRepo = {
  getSettings: vi.fn(async () => state.settings),
  listActiveForServers: vi.fn(async (_serverIds: string[]) => state.bindings),
  requeueForApply: vi.fn(async (_serverId: string, serviceKey: string, _expected: number) => ({ serviceKey })),
};

const domainRepo = { ensureServerDomain: vi.fn(async () => ({ created: false })) };

vi.mock("@repo/db", () => ({
  repos: { discovery: discoveryRepo, domain: domainRepo },
}));

vi.mock("../../lib/domain-ssl", () => ({
  manageDomainSsl: vi.fn(async () => ({ verified: true, expiresAt: "2027-01-01T00:00:00Z" })),
}));

// Keep the real module (and its env bootstrapping) out of the test.
vi.mock("../../lib/deployment-runtime", () => ({
  resolveServerExecutor: vi.fn(async () => {
    throw new Error("repair must use the injected edge in tests");
  }),
  createPlatformForResolvedServer: vi.fn(),
  resolveServerHostPortTarget: vi.fn(),
  disposePlatform: vi.fn(),
}));

const { repairDiscoveryRoutes } = await import("./discovery-repair");
const { shouldRetainUnavailableVhost, unavailableRouteFor } = await import("./discovery-reconciler");

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dsb_1",
    serviceKey: "id:my-app",
    hostname: "app.example.com",
    port: 3000,
    containerId: "ctr_1",
    observationStatus: "observed",
    applyState: "applied",
    applyAttempts: 0,
    desiredGeneration: 2,
    appliedGeneration: 2,
    suppressed: false,
    withdrawalPending: false,
    containerRunning: true,
    upstreamStrategy: "network-ip",
    ipAddress: "172.20.0.5",
    hostPort: null,
    hostIp: null,
    configHash: discoveryConfigHash({ hostname: "app.example.com", port: 3000, network: "frontend" }),
    ...overrides,
  };
}

interface EdgeOpts {
  hasRoute?: (domain: string) => Promise<boolean>;
  /** The persisted vhost state the provider reports (null = unreadable). */
  routeState?: Record<string, unknown> | null;
}

function edge(opts: EdgeOpts = {}) {
  const registered: Array<Record<string, unknown>> = [];
  return {
    edge: {
      routing: {
        registerRoute: vi.fn(async (route: Record<string, unknown>) => {
          registered.push(route);
        }),
        removeRoute: vi.fn(async () => {}),
        probeUpstream: vi.fn(async () => ({ ok: true })),
        hasRoute: opts.hasRoute ?? vi.fn(async () => false),
        readRouteState:
          opts.routeState === undefined
            ? vi.fn(async () => null)
            : vi.fn(async () => opts.routeState ?? null),
      },
      hostPortTarget: null,
      edgeProxy: null,
      dispose: vi.fn(async () => {}),
    },
    registered,
  };
}

describe("shouldRetainUnavailableVhost (durable application history)", () => {
  it("retains on appliedGeneration > 0 — even when a stop requeued the binding as pending", () => {
    // The P2 case: stop/removal observations flip applied bindings to
    // applyState "pending"; only the generation record proves a vhost exists.
    expect(shouldRetainUnavailableVhost({ appliedGeneration: 2, applyState: "pending", suppressed: false })).toBe(true);
    expect(shouldRetainUnavailableVhost({ appliedGeneration: 1, applyState: "error", suppressed: false })).toBe(true);
    expect(shouldRetainUnavailableVhost({ appliedGeneration: 3, applyState: "applied", suppressed: false })).toBe(true);
  });

  it("never retains without durable history, or under explicit control", () => {
    expect(shouldRetainUnavailableVhost({ appliedGeneration: 0, applyState: "pending", suppressed: false })).toBe(false);
    expect(shouldRetainUnavailableVhost({ appliedGeneration: 0, applyState: "error", suppressed: false })).toBe(false);
    // Suppressed owner / blocked declaration = explicit retirement.
    expect(shouldRetainUnavailableVhost({ appliedGeneration: 2, applyState: "applied", suppressed: true })).toBe(false);
    expect(shouldRetainUnavailableVhost({ appliedGeneration: 2, applyState: "blocked", suppressed: false })).toBe(false);
  });

  it("the retained shape is always the unavailable vhost with TLS", () => {
    expect(unavailableRouteFor("app.example.com")).toEqual({
      domain: "app.example.com",
      tls: true,
      terminatesTlsLocally: true,
      unavailable: true,
    });
  });
});

describe("repairDiscoveryRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.settings = { enabled: true };
    state.bindings = [];
  });

  it("restores a MISSING route as the unavailable vhost — NEVER a serving upstream from records", async () => {
    // P1: after downtime the stored bridge IP or published port may belong to
    // another container. Repair has no fresh inspection or ownership guard, so
    // the only safe restore is the retained 503 form; guarded reconciliation
    // resumes serving.
    state.bindings = [binding()];
    const { edge: target, registered } = edge({ hasRoute: async () => false });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.scanned).toBe(1);
    expect(summary.repaired).toEqual(["app.example.com"]);
    expect(registered).toEqual([
      { domain: "app.example.com", tls: true, terminatesTlsLocally: true, unavailable: true },
    ]);
    // Repair replays RECORDS: no container probe, no claims, no removal, no
    // targetUrl anywhere.
    expect(target.routing.probeUpstream).not.toHaveBeenCalled();
    expect(target.routing.removeRoute).not.toHaveBeenCalled();
    expect(JSON.stringify(registered)).not.toContain("targetUrl");
  });

  it("a restored 503 for a RUNNING backend is temporary: repair queues guarded reconciliation", async () => {
    // P2: repair restored the 503 but the record says the backend is running —
    // an unchanged scan never requeues an applied binding, so without the
    // requeue the hostname would sit unavailable forever. The generation bump
    // hands the serving decision to guarded reconciliation (fresh probe).
    state.bindings = [binding()];
    const { edge: target, registered } = edge({ hasRoute: async () => false });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.requeued).toEqual(["app.example.com"]);
    expect(discoveryRepo.requeueForApply).toHaveBeenCalledWith("srv_1", "id:my-app", 2);
    // The write stays 503 — the guarded pass does the serving registration.
    expect(registered).toEqual([
      { domain: "app.example.com", tls: true, terminatesTlsLocally: true, unavailable: true },
    ]);
  });

  it("a restored 503 for a DEAD backend is NOT requeued (reconciliation would only re-retain)", async () => {
    state.bindings = [binding({ containerRunning: false })];
    const { edge: target } = edge({ hasRoute: async () => false });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.repaired).toEqual(["app.example.com"]);
    expect(summary.requeued).toEqual([]);
    expect(discoveryRepo.requeueForApply).not.toHaveBeenCalled();
  });

  it("switches a still-serving vhost to the unavailable form when the record says the backend is dead", async () => {
    // The container stopped while no reconcile pass ran: the edge still holds a
    // live proxy vhost to a stored upstream the record no longer names.
    state.bindings = [binding({ containerRunning: false })];
    const { edge: target, registered } = edge({
      hasRoute: async () => true,
      routeState: { domain: "app.example.com", tls: true, targetUrl: "http://172.20.0.5:3000" },
    });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.retained).toEqual(["app.example.com"]);
    expect(summary.repaired).toEqual([]);
    expect(registered).toEqual([
      { domain: "app.example.com", tls: true, terminatesTlsLocally: true, unavailable: true },
    ]);
  });

  it("an unavailable vhost with a RUNNING recorded backend is queued too (crash-safe recovery)", async () => {
    // P2: a previous repair may have written the 503 and died before its
    // requeue committed — the next sweep must retry reconciliation, not treat
    // the retained vhost as final. Record says running + binding converged →
    // queue (idempotent: a committed requeue already flipped it to pending,
    // and this no-ops). The vhost itself is never touched.
    state.bindings = [binding()];
    const { edge: target, registered } = edge({
      hasRoute: async () => true,
      routeState: { domain: "app.example.com", tls: true, unavailable: true },
    });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.requeued).toEqual(["app.example.com"]);
    expect(discoveryRepo.requeueForApply).toHaveBeenCalledWith("srv_1", "id:my-app", 2);
    expect(registered).toEqual([]); // no unvalidated write; the guarded pass decides
  });

  it("an unavailable vhost with a DEAD recorded backend stays retained without requeue", async () => {
    state.bindings = [binding({ containerRunning: false })];
    const { edge: target, registered } = edge({
      hasRoute: async () => true,
      routeState: { domain: "app.example.com", tls: true, unavailable: true },
    });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.requeued).toEqual([]);
    expect(summary.retained).toEqual([]);
    expect(registered).toEqual([]);
    expect(discoveryRepo.requeueForApply).not.toHaveBeenCalled();
  });

  it("leaves a serving route whose target matches the recorded upstream untouched", async () => {
    state.bindings = [binding()];
    const { edge: target, registered } = edge({
      hasRoute: async () => true,
      routeState: { domain: "app.example.com", tls: true, targetUrl: "http://172.20.0.5:3000" },
    });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.scanned).toBe(1);
    expect(summary.repaired).toEqual([]);
    expect(summary.retained).toEqual([]);
    expect(summary.requeued).toEqual([]);
    expect(registered).toEqual([]);
    expect(discoveryRepo.requeueForApply).not.toHaveBeenCalled();
  });

  it("a STALE serving target (old IP/port) is detected and queued for guarded reconciliation", async () => {
    // The record says the backend is running — but the vhost serves a different
    // URL than the record names (replacement/IP churn). Repair can't validate
    // the new endpoint, so it leaves the file and queues the guarded pass,
    // which re-probes fresh and rewrites.
    state.bindings = [binding({ ipAddress: "172.20.0.9" })];
    const { edge: target, registered } = edge({
      hasRoute: async () => true,
      routeState: { domain: "app.example.com", tls: true, targetUrl: "http://172.20.0.5:3000" },
    });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.requeued).toEqual(["app.example.com"]);
    expect(summary.retained).toEqual([]);
    expect(summary.repaired).toEqual([]);
    // No unvalidated write: the serving decision belongs to guarded reconciliation.
    expect(registered).toEqual([]);
    expect(discoveryRepo.requeueForApply).toHaveBeenCalledWith("srv_1", "id:my-app", 2);
  });

  it("an already-queued (pending) binding with a stale target is left to its scheduled pass", async () => {
    state.bindings = [binding({ ipAddress: "172.20.0.9", applyState: "pending" })];
    const { edge: target, registered } = edge({
      hasRoute: async () => true,
      routeState: { domain: "app.example.com", tls: true, targetUrl: "http://172.20.0.5:3000" },
    });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.requeued).toEqual([]); // no double queue: the pass is coming
    expect(discoveryRepo.requeueForApply).not.toHaveBeenCalled();
    expect(registered).toEqual([]);
  });

  it("refuses to clobber a conf whose stored sidecar is unreadable", async () => {
    state.bindings = [binding()];
    const { edge: target, registered } = edge({ hasRoute: async () => true, routeState: null });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].reason).toMatch(/unreadable/);
    expect(registered).toEqual([]);
  });

  it("scans bindings by durable history — a stop-requeued pending binding IS scanned, never-applied is not", async () => {
    state.bindings = [
      // Applied once, then stopped: applyState requeued to pending, history intact.
      binding({ applyState: "pending", containerRunning: false }),
      // Never applied anything: nothing to repair.
      binding({ id: "dsb_2", serviceKey: "id:fresh", hostname: "fresh.example.com", appliedGeneration: 0, applyState: "pending", ipAddress: null, containerId: null }),
    ];
    const { edge: target, registered } = edge({ hasRoute: async () => false });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.scanned).toBe(1);
    expect(summary.repaired).toEqual(["app.example.com"]);
    expect(registered).toHaveLength(1);
  });

  it("does nothing on disabled servers", async () => {
    state.settings = { enabled: false };
    state.bindings = [binding()];
    const { edge: target, registered } = edge({ hasRoute: async () => false });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.scanned).toBe(0);
    expect(registered).toEqual([]);
  });

  it("does nothing on providers without route introspection (cloud API, no-edge desktop)", async () => {
    state.bindings = [binding()];
    const target = {
      routing: {
        registerRoute: vi.fn(async () => {}),
        removeRoute: vi.fn(async () => {}),
        probeUpstream: vi.fn(async () => ({ ok: true })),
      },
      hostPortTarget: null,
      edgeProxy: null,
      dispose: vi.fn(async () => {}),
    };
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.scanned).toBe(0);
    expect(summary.failed).toEqual([]);
    expect(target.routing.registerRoute).not.toHaveBeenCalled();
  });

  it("records one binding's failure and keeps repairing the rest", async () => {
    state.bindings = [
      binding({ id: "dsb_1", serviceKey: "id:broken" }),
      binding({ id: "dsb_2", serviceKey: "id:fine", hostname: "other.example.com" }),
    ];
    const { edge: target, registered } = edge({
      hasRoute: async (domain: string) =>
        domain === "app.example.com" ? Promise.reject(new Error("edge unreachable")) : false,
    });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.scanned).toBe(2);
    expect(summary.failed).toEqual([{ serviceKey: "id:broken", reason: "edge unreachable" }]);
    expect(summary.repaired).toEqual(["other.example.com"]);
    expect(registered).toHaveLength(1);
  });
});
