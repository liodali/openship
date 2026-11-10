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
  suppressed: boolean;
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
          suppressed: false,
        };
        state.bindings.set(obs.serviceKey, row);
        return { binding: row, desiredChanged: true, requeued: false };
      }
      const requeued =
        !desiredChanged &&
        existing.applyState !== "blocked" &&
        (existing.containerId !== obs.containerId || existing.running !== obs.running);
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
        ...(existing.applyState !== "blocked" && (desiredChanged || requeued)
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
      return { binding: updated, desiredChanged, requeued };
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
    if (!row) return undefined;
    // Mirror the repo: removal is a reconcile task — a previously applied
    // binding requeues for route withdrawal; idempotent once already missing.
    const newlyMissing = row.observationStatus !== "missing";
    const requeue = newlyMissing && row.applyState !== "blocked" && !row.suppressed;
    state.bindings.set(serviceKey, {
      ...row,
      observationStatus: "missing",
      containerId: null,
      containerName: null,
      running: false,
      ...(requeue
        ? { desiredGeneration: row.desiredGeneration + 1, applyState: "pending" as const, applyError: null }
        : {}),
    });
    return row;
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

  it("requeues on container replacement even without a config change", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    // Mark "applied" the way the reconciler would after the first apply.
    const applied = state.bindings.get("id:my-app")!;
    state.bindings.set("id:my-app", { ...applied, applyState: "applied", appliedGeneration: 1 });
    const replacement = view({ containerId: "ctr_b", name: "my-app-2", networks: [{ name: "frontend", id: "net_fe", ipAddress: "172.20.0.9" }] });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([replacement]) });
    // The route's upstream changed — the binding MUST requeue or keep serving
    // the old IP Docker may hand to another workload.
    expect(summary.desiredChanged).toEqual(["id:my-app"]);
    expect(summary.missing).toEqual([]);
    const binding = state.bindings.get("id:my-app")!;
    expect(binding.containerId).toBe("ctr_b");
    expect(binding.applyState).toBe("pending");
    expect(binding.desiredGeneration).toBe(2);
  });

  it("requeues on stop and start", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    const applied = state.bindings.get("id:my-app")!;
    state.bindings.set("id:my-app", { ...applied, applyState: "applied", appliedGeneration: 1 });

    const stopped = await scanServerDiscovery(
      SERVER,
      "org_1",
      { runtime: runtime([view({ running: false, status: "exited" })]) },
    );
    expect(stopped.desiredChanged).toEqual(["id:my-app"]); // withdraw upstream
    expect(state.bindings.get("id:my-app")?.running).toBe(false);

    const started = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    expect(started.desiredChanged).toEqual(["id:my-app"]); // restore + cert check
    expect(state.bindings.get("id:my-app")?.running).toBe(true);
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

  it("queues route withdrawal when an applied binding's container goes missing (crash-safe)", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    const applied = state.bindings.get("id:my-app")!;
    state.bindings.set("id:my-app", { ...applied, applyState: "applied", appliedGeneration: 1 });

    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([]) });
    expect(summary.missing).toEqual(["id:my-app"]);
    const binding = state.bindings.get("id:my-app")!;
    // Applied + not-due after removal would be exactly the crash window where
    // a live route points at a dead container. Removal must queue withdrawal.
    expect(binding.applyState).toBe("pending");
    expect(binding.desiredGeneration).toBe(2);
  });

  it("does not re-bump an already-missing binding on repeated sweeps", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([]) });
    const generation = state.bindings.get("id:my-app")!.desiredGeneration;
    // The scanner re-runs every sweep until reconciliation catches up.
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([]) });
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([]) });
    expect(state.bindings.get("id:my-app")!.desiredGeneration).toBe(generation);
  });

  it("reports an invalid RECREATED container under its new id and preserves the binding", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    const applied = state.bindings.get("id:my-app")!;
    state.bindings.set("id:my-app", { ...applied, applyState: "applied", appliedGeneration: 1 });

    // Compose recreation: same identity (OPENSHIP_SERVICE_ID=my-app), NEW
    // container id, broken config (selector names a network it is not on).
    const recreatedBad = view({
      containerId: "ctr_NEW",
      name: "my-app-recreated",
      env: [
        "OPENSHIP_DISCOVERY=true",
        "OPENSHIP_SERVICE_ID=my-app",
        "OPENSHIP_DOMAIN=app.example.com",
        "OPENSHIP_PORT=3000",
        "OPENSHIP_NETWORK=missing-net",
      ],
    });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([recreatedBad]) });
    // NOT classified as removal — the identity links the new container back.
    expect(summary.missing).toEqual([]);
    expect(summary.withdrawn).toEqual([]);
    expect(summary.invalid).toHaveLength(1);
    expect(summary.invalid[0]).toMatchObject({
      serviceKey: "id:my-app",
      containerId: "ctr_NEW",
      containerName: "my-app-recreated",
      code: "network-missing",
    });
    const binding = state.bindings.get("id:my-app");
    expect(binding).toBeDefined();
    expect(binding?.hostname).toBe("app.example.com"); // state intact

    // Fixing the config resumes normal observation under the new id.
    const fixed = view({ containerId: "ctr_NEW", name: "my-app-recreated" });
    const after = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([fixed]) });
    expect(after.invalid).toEqual([]);
    expect(after.observed).toEqual(["id:my-app"]);
    expect(state.bindings.get("id:my-app")?.containerId).toBe("ctr_NEW");
  });

  it("reports invalid containers even when no binding exists", async () => {
    // Never scanned before: a standalone opted-in container with a bad port.
    const bad = view({
      containerId: "ctr_lone",
      name: "lone",
      env: [
        "OPENSHIP_DISCOVERY=true",
        "OPENSHIP_SERVICE_ID=lone",
        "OPENSHIP_DOMAIN=app.example.com",
        "OPENSHIP_PORT=not-a-port",
      ],
    });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([bad]) });
    expect(summary.invalid).toHaveLength(1);
    expect(summary.invalid[0]).toMatchObject({
      serviceKey: "id:lone",
      containerId: "ctr_lone",
      code: "invalid-port",
    });
    // An invalid identity cannot name a key.
    const noIdentity = view({ containerId: "ctr_none", name: "anon", env: ["OPENSHIP_DISCOVERY=true", "OPENSHIP_DOMAIN=app.example.com", "OPENSHIP_PORT=80"] });
    const second = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([noIdentity]) });
    expect(second.invalid).toHaveLength(1);
    expect(second.invalid[0]).toMatchObject({ serviceKey: null, containerId: "ctr_none", code: "identity-required" });
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

  it("preserves the binding when the declaration becomes INVALID, and reports it", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    // Operator recreates with a typo: OPENSHIP_NETWORK names a missing network.
    const broken = view({
      containerId: "ctr_a",
      env: [
        "OPENSHIP_DISCOVERY=true",
        "OPENSHIP_SERVICE_ID=my-app",
        "OPENSHIP_DOMAIN=app.example.com",
        "OPENSHIP_PORT=3000",
        "OPENSHIP_NETWORK=missing-net",
      ],
    });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([broken]) });
    expect(summary.withdrawn).toEqual([]); // NEVER silently withdrawn
    expect(summary.invalid).toHaveLength(1);
    expect(summary.invalid[0]).toMatchObject({
      serviceKey: "id:my-app",
      containerId: "ctr_a",
      code: "network-missing",
    });
    const binding = state.bindings.get("id:my-app");
    expect(binding).toBeDefined();
    expect(binding?.hostname).toBe("app.example.com"); // state intact

    // Once fixed, the binding observes normally again.
    const fixed = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view({ containerId: "ctr_a", env: [...view().env, "OPENSHIP_NETWORK=frontend"] })]) });
    expect(fixed.invalid).toEqual([]);
    expect(fixed.observed).toEqual(["id:my-app"]);
  });

  it("withdraws only on explicit opt-out, not on invalid config", async () => {
    await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([view()]) });
    const optedOut = view({ env: ["PATH=/usr/bin"], containerId: "ctr_a" });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([optedOut]) });
    expect(summary.withdrawn).toEqual(["id:my-app"]);
    expect(summary.invalid).toEqual([]);
    expect(state.bindings.has("id:my-app")).toBe(false);
  });

  it("does not let a retained stopped container block its running replacement", async () => {
    // Old replica stopped (scale-down), new replica running — same identity.
    const stoppedOld = view({ containerId: "ctr_old", name: "app-old", running: false, status: "exited" });
    const runningNew = view({ containerId: "ctr_new", name: "app-new" });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([stoppedOld, runningNew]) });
    expect(summary.blocked).toEqual([]); // a live duplicate needs TWO RUNNING
    expect(summary.observed).toEqual(["id:my-app"]);
    const binding = state.bindings.get("id:my-app")!;
    expect(binding.containerId).toBe("ctr_new"); // the RUNNING instance wins
    expect(binding.applyState).toBe("pending");
    expect(binding.running).toBe(true);
  });

  it("blocks two running replicas of one identity, and reports a stopped-only duplicate", async () => {
    const a = view({ containerId: "ctr_a", name: "app-1" });
    const b = view({ containerId: "ctr_b", name: "app-2" });
    const summary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([a, b]) });
    expect(summary.blocked).toHaveLength(1);
    expect(summary.blocked[0].serviceKey).toBe("id:my-app");
    expect(summary.blocked[0].reason).toContain("app-1");
    expect(summary.blocked[0].reason).toContain("app-2");
    expect(state.bindings.get("id:my-app")?.applyState).toBe("blocked");
    // A duplicate stays blocked through rescans — never auto-retried.
    const second = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime([a, b]) });
    expect(second.blocked).toHaveLength(1);
    expect(state.bindings.get("id:my-app")?.applyState).toBe("blocked");

    // Two STOPPED containers of one identity: visible conflict, no route risk.
    const bothStopped = [view({ containerId: "ctr_a", running: false, status: "exited" }), view({ containerId: "ctr_b", running: false, status: "exited" })];
    const stoppedSummary = await scanServerDiscovery(SERVER, "org_1", { runtime: runtime(bothStopped) });
    expect(stoppedSummary.blocked).toHaveLength(1);
    expect(stoppedSummary.blocked[0].reason).toContain("stopped containers claim identity");
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
