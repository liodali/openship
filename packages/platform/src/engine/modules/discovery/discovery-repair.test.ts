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

const { repairDiscoveryRoutes, desiredRouteForRecord } = await import("./discovery-repair");

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

function edge(opts: { hasRoute?: (domain: string) => Promise<boolean> } = {}) {
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
      },
      hostPortTarget: null,
      edgeProxy: null,
      dispose: vi.fn(async () => {}),
    },
    registered,
  };
}

describe("desiredRouteForRecord", () => {
  it("derives the serving route from the STORED upstream (no live anything)", () => {
    expect(desiredRouteForRecord(binding() as never)).toEqual({
      domain: "app.example.com",
      tls: true,
      terminatesTlsLocally: true,
      targetUrl: "http://172.20.0.5:3000",
    });
    expect(
      desiredRouteForRecord(binding({ upstreamStrategy: "published-port", hostPort: 18080, ipAddress: null }) as never),
    ).toMatchObject({ targetUrl: "http://127.0.0.1:18080" });
  });

  it("derives the unavailable retention route when the record's backend is gone", () => {
    expect(desiredRouteForRecord(binding({ containerRunning: false }) as never)).toEqual({
      domain: "app.example.com",
      tls: true,
      terminatesTlsLocally: true,
      unavailable: true,
    });
    expect(desiredRouteForRecord(binding({ observationStatus: "invalid" }) as never)).toMatchObject({
      unavailable: true,
    });
  });

  it("promises NO route for bindings that never applied (or were blocked)", () => {
    expect(desiredRouteForRecord(binding({ applyState: "pending" }) as never)).toBeNull();
    expect(desiredRouteForRecord(binding({ applyState: "blocked" }) as never)).toBeNull();
  });
});

describe("repairDiscoveryRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.settings = { enabled: true };
    state.bindings = [];
  });

  it("re-emits a missing route file from the durable record — stored upstream, no live probe, no claims", async () => {
    state.bindings = [binding()];
    const { edge: target, registered } = edge({ hasRoute: async () => false });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.scanned).toBe(1);
    expect(summary.repaired).toEqual(["app.example.com"]);
    expect(registered).toEqual([
      { domain: "app.example.com", tls: true, terminatesTlsLocally: true, targetUrl: "http://172.20.0.5:3000" },
    ]);
    // Repair replays RECORDS: no container probe, no claims, no removal.
    expect(target.routing.probeUpstream).not.toHaveBeenCalled();
    expect(target.routing.removeRoute).not.toHaveBeenCalled();
  });

  it("switches a still-registered route to the unavailable vhost when the stored backend is dead", async () => {
    // The container stopped while no reconcile pass ran: the edge still holds a
    // live proxy vhost to a dead upstream. Repair retains the hostname (503 +
    // TLS) — and never triggers issuance.
    state.bindings = [binding({ containerRunning: false })];
    const { edge: target, registered } = edge({ hasRoute: async () => true });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.retained).toEqual(["app.example.com"]);
    expect(summary.repaired).toEqual([]);
    expect(registered).toEqual([
      { domain: "app.example.com", tls: true, terminatesTlsLocally: true, unavailable: true },
    ]);
  });

  it("restores a MISSING route as the unavailable vhost for a stopped backend (cert material kept)", async () => {
    state.bindings = [binding({ containerRunning: false })];
    const { edge: target, registered } = edge({ hasRoute: async () => false });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    // Missing file + dead backend: the only honest restore is the retained 503
    // form — never a live proxy to an unobservable upstream.
    expect(summary.repaired).toEqual(["app.example.com"]);
    expect(registered[0]).toMatchObject({ unavailable: true });
  });

  it("leaves a healthy applied route untouched", async () => {
    state.bindings = [binding()];
    const { edge: target, registered } = edge({ hasRoute: async () => true });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.scanned).toBe(1);
    expect(summary.repaired).toEqual([]);
    expect(summary.retained).toEqual([]);
    expect(registered).toEqual([]);
  });

  it("skips non-applied bindings and disabled servers entirely", async () => {
    state.bindings = [binding({ applyState: "pending" }), binding({ id: "dsb_2", serviceKey: "id:other", applyState: "blocked" })];
    const { edge: target } = edge({ hasRoute: async () => false });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.scanned).toBe(0);

    state.settings = { enabled: false };
    const disabled = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(disabled.scanned).toBe(0);
    expect(disabled.repaired).toEqual([]);
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
      hasRoute: async (domain: string) => domain === "app.example.com" ? Promise.reject(new Error("edge unreachable")) : false,
    });
    const summary = await repairDiscoveryRoutes("srv_1", "org_1", { edge: target as never });
    expect(summary.scanned).toBe(2);
    expect(summary.failed).toEqual([{ serviceKey: "id:broken", reason: "edge unreachable" }]);
    expect(summary.repaired).toEqual(["other.example.com"]);
    expect(registered).toHaveLength(1);
  });
});
