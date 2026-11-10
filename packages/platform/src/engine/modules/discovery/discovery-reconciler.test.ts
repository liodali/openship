import { beforeEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";

// ── In-memory discovery repo (same contract as the scanner tests) ───────────

const state = {
  settings: { enabled: false } as { enabled: boolean } | null,
  dueApply: [] as Array<Record<string, unknown>>,
  dueWithdrawal: [] as Array<Record<string, unknown>>,
  applied: [] as Array<{ serviceKey: string; generation: number }>,
  withdrawn: [] as string[],
  applyErrors: [] as Array<{ serviceKey: string; error: string; retryAt: Date }>,
};

function reset() {
  state.settings = { enabled: true };
  state.dueApply = [];
  state.dueWithdrawal = [];
  state.applied = [];
  state.withdrawn = [];
  state.applyErrors = [];
}

const discoveryRepo = {
  getSettings: vi.fn(async () => state.settings),
  dueForApply: vi.fn(async () => state.dueApply),
  dueForWithdrawal: vi.fn(async () => state.dueWithdrawal),
  markApplied: vi.fn(async (_serverId: string, serviceKey: string, generation: number) => {
    state.applied.push({ serviceKey, generation });
    return { serviceKey };
  }),
  markWithdrawn: vi.fn(async (_serverId: string, serviceKey: string) => {
    state.withdrawn.push(serviceKey);
    return { serviceKey };
  }),
  markApplyError: vi.fn(async (_serverId: string, serviceKey: string, error: string, retryAt: Date) => {
    state.applyErrors.push({ serviceKey, error, retryAt });
    return { serviceKey };
  }),
  recordScan: vi.fn(async () => {}),
};

vi.mock("@repo/db", () => ({ repos: { discovery: discoveryRepo } }));

// The injected edge target bypasses server resolution entirely; keep the
// real module (and its env bootstrapping) out of the test.
vi.mock("../../lib/deployment-runtime", () => ({
  resolveServerExecutor: vi.fn(async () => {
    throw new Error("reconciler must use the injected edge in tests");
  }),
  createPlatformForResolvedServer: vi.fn(),
  resolveServerHostPortTarget: vi.fn(),
  disposePlatform: vi.fn(),
}));

const { reconcileServerDiscovery, upstreamUrlFor } = await import("./discovery-reconciler");

// ── Mock edge ────────────────────────────────────────────────────────────────

function edge(): import("./discovery-reconciler").DiscoveryEdgeTarget {
  return {
    routing: {
      registerRoute: vi.fn(async () => {}),
      removeRoute: vi.fn(async () => {}),
    },
    hostPortTarget: { targetKey: "server:test", machineId: "m", hostId: "h" },
    runtime: undefined,
    edgeProxy: { listLoopbackUpstreamPortsStrict: async () => [] },
    dispose: vi.fn(async () => {}),
  } as unknown as import("./discovery-reconciler").DiscoveryEdgeTarget;
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dsb_1",
    serviceKey: "id:my-app",
    hostname: "app.example.com",
    port: 3000,
    containerId: "ctr_1",
    observationStatus: "observed",
    applyState: "pending",
    applyAttempts: 0,
    desiredGeneration: 1,
    appliedGeneration: 0,
    suppressed: false,
    withdrawalPending: false,
    containerRunning: true,
    upstreamStrategy: "network-ip",
    ipAddress: "172.20.0.5",
    hostPort: null,
    hostIp: null,
    ...overrides,
  };
}

describe("upstreamUrlFor", () => {
  it("builds the direct bridge URL and never leaks a stale upstream when unrouteable", () => {
    expect(upstreamUrlFor(binding() as never)).toBe("http://172.20.0.5:3000");
    expect(upstreamUrlFor(binding({ upstreamStrategy: "published-port", hostPort: 18080, ipAddress: null }) as never)).toBe(
      "http://127.0.0.1:18080",
    );
    expect(upstreamUrlFor(binding({ observationStatus: "missing" }) as never)).toBeNull();
    expect(upstreamUrlFor(binding({ observationStatus: "invalid" }) as never)).toBeNull();
    expect(upstreamUrlFor(binding({ containerRunning: false }) as never)).toBeNull();
    expect(upstreamUrlFor(binding({ ipAddress: null }) as never)).toBeNull();
    expect(upstreamUrlFor(binding({ upstreamStrategy: "published-port", hostPort: null }) as never)).toBeNull();
  });
});

describe("reconcileServerDiscovery", () => {
  beforeEach(reset);

  it("does nothing when discovery is disabled", async () => {
    state.settings = { enabled: false };
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: edge() });
    expect(summary.ok).toBe(false);
    expect(summary.applied).toEqual([]);
  });

  it("registers a bridge-ip binding and marks it applied only after the edge write", async () => {
    state.dueApply = [binding()];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "app.example.com",
        targetUrl: "http://172.20.0.5:3000",
        tls: true,
        terminatesTlsLocally: true,
      }),
    );
    expect(summary.applied).toEqual(["id:my-app"]);
    expect(state.applied).toEqual([{ serviceKey: "id:my-app", generation: 1 }]);
  });

  it("withdraws the upstream for missing/invalid/stopped bindings while keeping the domain", async () => {
    state.dueApply = [
      binding({ observationStatus: "missing", containerId: null, ipAddress: null, containerRunning: false }),
    ];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(target.routing.registerRoute).not.toHaveBeenCalled();
    expect(summary.removed).toEqual(["id:my-app"]);
    expect(state.applied).toEqual([{ serviceKey: "id:my-app", generation: 1 }]);
  });

  it("processes withdrawals first and clears the retirement flag", async () => {
    state.dueWithdrawal = [binding({ applyState: "blocked", withdrawalPending: true })];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(summary.withdrawals).toEqual(["id:my-app"]);
    expect(state.withdrawn).toEqual(["id:my-app"]);
  });

  it("routes published-port bindings through the loopback ownership guard", async () => {
    state.dueApply = [
      binding({
        upstreamStrategy: "published-port",
        hostPort: 18080,
        hostIp: "127.0.0.1",
        ipAddress: null,
      }),
    ];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({ targetUrl: "http://127.0.0.1:18080", domain: "app.example.com" }),
    );
    expect(summary.applied).toEqual(["id:my-app"]);
    // The ownership guard ran under the target lock with the binding's claim.
    expect(reserveObservedLoopbackPublishes).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "discovery:dsb_1",
        publishes: [
          { serviceId: "id:my-app", containerId: "ctr_1", containerPort: 3000, hostPort: 18080 },
        ],
      }),
    );
    expect(prepareTargetPinnedHostPorts).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ targetKey: "server:test" }) }),
    );
  });

  it("persists apply errors with backoff instead of losing the binding", async () => {
    state.dueApply = [binding()];
    const target = edge();
    vi.mocked(target.routing.registerRoute).mockRejectedValue(new Error("edge write failed"));
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].reason).toContain("edge write failed");
    expect(state.applyErrors).toHaveLength(1);
    expect(state.applyErrors[0].error).toContain("edge write failed");
    expect(state.applyErrors[0].retryAt.getTime()).toBeGreaterThan(Date.now());
    expect(state.applied).toEqual([]);
  });
});

import {
  prepareTargetPinnedHostPorts,
  withHostPortTargetLock,
} from "../deployments/pinned-host-ports";
import { reserveObservedLoopbackPublishes } from "../deployments/observed-host-port-claims";
vi.mock("../deployments/pinned-host-ports", () => ({
  withHostPortTargetLock: vi.fn((_target: unknown, fn: () => Promise<void>) => fn()),
  prepareTargetPinnedHostPorts: vi.fn(async () => {}),
  convergeTargetHostPortClaimsUnlocked: vi.fn(async () => ({})),
}));
vi.mock("../deployments/observed-host-port-claims", () => ({
  reserveObservedLoopbackPublishes: vi.fn(async () => {}),
  loopbackHostPortFromUrl: vi.fn(() => null),
}));

function SERVER() {
  return "srv_reconcile";
}
