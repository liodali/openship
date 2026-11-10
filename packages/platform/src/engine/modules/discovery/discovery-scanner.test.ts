import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discoveryConfigHash, type DiscoveryContainerView, type DiscoveryParseResult } from "@repo/core";
import type { RuntimeAdapter } from "@repo/adapters";

// ── In-memory discovery repo state ──────────────────────────────────────────
// Mirrors the repo contract the scanner relies on: observe upserts by key with
// generation/config-hash semantics, block/unblock/forget/markMissing mutate
// that state, and recordScan records outcomes.

type BindingRow = {
  serviceKey: string;
  containerId: string | null;
  containerName: string | null;
  running: boolean;
  hostname: string;
  port: number;
  networkName: string;
  configHash: string;
  observationStatus: "observed" | "missing" | "error";
  applyState: "pending" | "applied" | "error" | "blocked";
  applyError: string | null;
  desiredGeneration: number;
  appliedGeneration: number;
};

const SERVER = "srv_scan";
const state = {
  settings: { enabled: false } as { enabled: boolean } | null,
  bindings: new Map<string, BindingRow>(),
  domains: [] as Array<{ hostname: string; ownerType: string; serverId: string | null; id: string }>,
  scans: [] as Array<unknown>,
};

function resetDb(enabled: boolean) {
  state.settings = { enabled };
  state.bindings.clear();
  state.domains = [];
  state.scans = [];
}

const discoveryRepo = {
  getSettings: vi.fn(async () => state.settings),
  recordScan: vi.fn(async (_serverId: string, result: unknown) => {
    state.scans.push(result);
  }),
  observe: vi.fn(
    async (
      _serverId: string,
      obs: {
        serviceKey: string;
        containerId: string;
        containerName?: string | null;
        running: boolean;
        hostname: string;
        port: number;
        networkName: string;
        configHash: string;
      },
    ) => {
      const existing = state.bindings.get(obs.serviceKey);
      const desiredChanged = existing?.configHash !== obs.configHash;
      if (!existing) {
        const row: BindingRow = {
          serviceKey: obs.serviceKey,
          containerId: obs.containerId,
          containerName: obs.containerName ?? null,
          running: obs.running,
          hostname: obs.hostname,
          port: obs.port,
          networkName: obs.networkName,
          configHash: obs.configHash,
          observationStatus: "observed",
          applyState: "pending",
          applyError: null,
          desiredGeneration: 1,
          appliedGeneration: 0,
        };
        state.bindings.set(obs.serviceKey, row);
        return { binding: row, desiredChanged: true };
      }
      const updated: BindingRow = {
        ...existing,
        containerId: obs.containerId,
        containerName: obs.containerName ?? null,
        running: obs.running,
        hostname: obs.hostname,
        port: obs.port,
        networkName: obs.networkName,
        configHash: obs.configHash,
        observationStatus: "observed",
        ...(desiredChanged && existing.applyState !== "blocked"
          ? {
              desiredGeneration: existing.desiredGeneration + 1,
              applyState: "pending" as const,
              applyError: null,
            }
          : desiredChanged
            ? { configHash: obs.configHash }
            : {}),
      };
      state.bindings.set(obs.serviceKey, updated);
      return { binding: updated, desiredChanged };
    },
  ),
  block: vi.fn(async (_serverId: string, serviceKey: string, reason: string) => {
    const row = state.bindings.get(serviceKey);
    if (row) {
      state.bindings.set(serviceKey, { ...row, applyState: "blocked", applyError: reason });
    }
  }),
  unblock: vi.fn(async (_serverId: string, serviceKey: string) => {
    const row = state.bindings.get(serviceKey);
    if (row && row.applyState === "blocked") {
      state.bindings.set(serviceKey, { ...row, applyState: "pending", applyError: null });
    }
  }),
  listByServer: vi.fn(async () => [...state.bindings.values()]),
  markMissing: vi.fn(async (_serverId: string, serviceKey: string) => {
    const row = state.bindings.get(serviceKey);
    if (row) {
      state.bindings.set(serviceKey, { ...row, observationStatus: "missing", containerId: null, running: false });
    }
  }),
  forget: vi.fn(async (_serverId: string, serviceKey: string) => {
    state.bindings.delete(serviceKey);
  }),
  findConflictingDomainOwner: vi.fn(async (_serverId: string, hostname: string) =>
    state.domains.find((d) => d.hostname === hostname.toLowerCase() && d.serverId !== SERVER),
  ),
};

const serverRepo = { get: vi.fn(async () => ({ id: SERVER, name: "scan-test" })) };

vi.mock("@repo/db", () => ({
  repos: { discovery: discoveryRepo, server: serverRepo },
}));

// The scanner must never open a real runtime in tests; an injected one is used.
vi.mock("../../lib/deployment-runtime", () => ({
  createServerDockerRuntime: vi.fn(async () => {
    throw new Error("scanner must use the injected runtime in tests");
  }),
}));

const { scanServerDiscovery } = await import("./discovery-scanner");

// ── Mock runtime ─────────────────────────────────────────────────────────────

function view(overrides: Partial<DiscoveryContainerView> = {}): DiscoveryContainerView {
  return {
    containerId: "ctr_a",
    name: "my-app",
    image: "my-app:v1",
    status: "running",
    running: true,
    env: [
      "OPENSHIP_DISCOVERY=true",
      "OPENSHIP_SERVICE_ID=my-app",
      "OPENSHIP_DOMAIN=app.example.com",
      "OPENSHIP_PORT=3000",
    ],
    labels: {},
    networks: [{ name: "frontend", id: "net_fe", ipAddress: "172.20.0.5" }],
    ...overrides,
  };
}

function runtime(containers: DiscoveryContainerView[]): RuntimeAdapter {
  return {
    name: "docker-test",
    capabilities: new Set(["discoveryInspection"] as never),
    supports: (cap: string) => cap === "discoveryInspection",
    listAllNetworks: vi.fn(async () => [
      { id: "net_fe", name: "frontend", driver: "bridge", labels: {} },
    ]),
    listAllContainers: vi.fn(async () =>
      containers.map((c) => ({
        id: c.containerId,
        names: [c.name ?? "x"],
        image: c.image ?? "img",
        imageId: "sha",
        state: c.running ? "running" : "exited",
        status: c.status,
        labels: c.labels,
        ports: [],
        mounts: [],
      })),
    ),
    getDiscoveryContainerView: vi.fn(async (id: string) =>
      containers.find((c) => c.containerId === id) ?? null,
    ),
    build: vi.fn(async () => {
      throw new Error("not used");
    }),
    cancelBuild: vi.fn(async () => {}),
    getBuildLogs: vi.fn(async () => []),
    deploy: vi.fn(async () => {
      throw new Error("not used");
    }),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  } as unknown as RuntimeAdapter;
}

describe("discovery scanner", () => {
  beforeAll(() => {
    // silence diagnostic side effects if any
  });
  beforeEach(() => {
    vi.clearAllMocks();
    resetDb(true);
    state.domains = [];
  });

  it("does nothing when discovery is disabled on the server", async () => {
    resetDb(false);
    const rt = runtime([view()]);
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: rt });
    expect(summary.scanned).toBe(0);
    expect(summary.observed).toEqual([]);
    expect(state.scans).toHaveLength(0);
    // No host reads happened.
    expect(vi.mocked(rt.listAllNetworks!)).not.toHaveBeenCalled();
    expect(vi.mocked(rt.listAllContainers!)).not.toHaveBeenCalled();
    const { createServerDockerRuntime } = await import("../../lib/deployment-runtime");
    expect(createServerDockerRuntime).not.toHaveBeenCalled();
  });

  it("observes an eligible container as a pending binding", async () => {
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    expect(summary.ok).toBe(true);
    expect(summary.eligible).toBe(1);
    expect(summary.observed).toEqual(["id:my-app"]);
    expect(summary.desiredChanged).toEqual(["id:my-app"]);
    const binding = state.bindings.get("id:my-app")!;
    expect(binding.applyState).toBe("pending");
    expect(binding.desiredGeneration).toBe(1);
    expect(binding.running).toBe(true);
    expect(binding.hostname).toBe("app.example.com");
    expect(state.scans).toEqual([{ ok: true }]);
  });

  it("converges: an unchanged rescan reports no desired changes", async () => {
    const rt = runtime([view()]);
    await scanServerDiscovery(SERVER, "org_1", { runtime: rt });
    const second = await scanServerDiscovery(SERVER, "org_1", { runtime: rt });
    expect(second.observed).toEqual(["id:my-app"]);
    expect(second.desiredChanged).toEqual([]);
    expect(state.bindings.get("id:my-app")?.desiredGeneration).toBe(1);
  });

  it("tracks container replacement without a config change", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    const replacement = view({ containerId: "ctr_b", name: "my-app-2", networks: [{ name: "frontend", id: "net_fe", ipAddress: "172.20.0.9" }] });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([replacement]) });
    expect(summary.desiredChanged).toEqual([]);
    expect(summary.missing).toEqual([]);
    const binding = state.bindings.get("id:my-app")!;
    expect(binding.containerId).toBe("ctr_b");
    expect(binding.desiredGeneration).toBe(1);
  });

  it("marks a confirmed removal missing and keeps the binding", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([]) });
    expect(summary.missing).toEqual(["id:my-app"]);
    expect(summary.withdrawn).toEqual([]);
    const binding = state.bindings.get("id:my-app")!;
    expect(binding.observationStatus).toBe("missing");
    expect(binding.containerId).toBeNull();
    expect(binding.hostname).toBe("app.example.com"); // desired state retained
  });

  it("withdraws (forgets) an opted-out container that is still present", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    // Same container, opt-in flag removed.
    const optedOut = view({
      env: ["PATH=/usr/bin"],
      containerId: "ctr_a",
    });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([optedOut]) });
    expect(summary.withdrawn).toEqual(["id:my-app"]);
    expect(summary.missing).toEqual([]);
    expect(state.bindings.has("id:my-app")).toBe(false);
  });

  it("blocks duplicate live identities instead of picking a replica", async () => {
    const a = view({ containerId: "ctr_a", name: "app-1" });
    const b = view({ containerId: "ctr_b", name: "app-2" });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([a, b]) });
    expect(summary.blocked).toHaveLength(1);
    expect(summary.blocked[0].serviceKey).toBe("id:my-app");
    expect(summary.blocked[0].reason).toContain("app-1");
    expect(summary.blocked[0].reason).toContain("app-2");
    const binding = state.bindings.get("id:my-app")!;
    expect(binding.applyState).toBe("blocked");
    // A duplicate stays blocked through rescans — never auto-retried.
    const second = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([a, b]) });
    expect(second.blocked).toHaveLength(1);
    expect(state.bindings.get("id:my-app")?.applyState).toBe("blocked");
  });

  it("blocks a hostname another owner already serves, and unblocks when it frees", async () => {
    state.domains = [{ id: "dom_manual", hostname: "app.example.com", ownerType: "project", serverId: null }];
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    expect(summary.blocked).toHaveLength(1);
    expect(summary.blocked[0].reason).toContain("project");
    expect(state.bindings.get("id:my-app")?.applyState).toBe("blocked");

    // The other owner releases the hostname → next scan unblocks.
    state.domains = [];
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    expect(state.bindings.get("id:my-app")?.applyState).toBe("pending");
  });

  it("excludes Openship-owned containers even when they opt in", async () => {
    const owned = view({ labels: { "openship.project": "managed-app" } });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([owned]) });
    expect(summary.eligible).toBe(0);
    expect(summary.observed).toEqual([]);
  });

  it("records a per-container inspect failure without classifying it removed", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    const failing = runtime([view()]);
    vi.mocked(failing.getDiscoveryContainerView!).mockRejectedValueOnce(new Error("daemon hiccup"));
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: failing });
    expect(summary.ok).toBe(true);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].containerId).toBe("ctr_a");
    const binding = state.bindings.get("id:my-app")!;
    expect(binding.observationStatus).toBe("observed"); // retained, not missing
    expect(binding.hostname).toBe("app.example.com");
  });

  it("fails the whole scan (state retained) when the host is unreadable", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    const dead = runtime([view()]);
    vi.mocked(dead.listAllContainers!).mockRejectedValue(new Error("host unreachable"));
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: dead });
    expect(summary.ok).toBe(false);
    expect(summary.errors.length).toBeGreaterThan(0);
    const binding = state.bindings.get("id:my-app")!;
    expect(binding.hostname).toBe("app.example.com");
    expect(state.scans.at(-1)).toEqual({ ok: false, error: expect.stringContaining("unreachable") });
  });

  it("rejects unusable networks instead of guessing an IP", async () => {
    const onHost = view({ networks: [{ name: "host", id: "net_host", driver: "host", ipAddress: "10.0.0.1" }] });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([onHost]) });
    expect(summary.eligible).toBe(0);
    expect(summary.observed).toEqual([]);
    expect(state.bindings.size).toBe(0);
  });

  it("reports config changes when the operator recreates with new config", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    const changed = view({
      containerId: "ctr_c",
      env: [
        "OPENSHIP_DISCOVERY=true",
        "OPENSHIP_SERVICE_ID=my-app",
        "OPENSHIP_DOMAIN=other.example.com",
        "OPENSHIP_PORT=4000",
      ],
    });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([changed]) });
    expect(summary.desiredChanged).toEqual(["id:my-app"]);
    const binding = state.bindings.get("id:my-app")!;
    expect(binding.hostname).toBe("other.example.com");
    expect(binding.port).toBe(4000);
    expect(binding.desiredGeneration).toBe(2);
    expect(binding.applyState).toBe("pending");
    expect(binding.configHash).toBe(discoveryConfigHash({ hostname: "other.example.com", port: 4000, network: "frontend" }));
  });
});

// Keep the type import referenced even if a future edit drops its direct use.
export type { DiscoveryParseResult };
