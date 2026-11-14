import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (top-level handles; the mocked-module binding is never touched) ────

const state = {
  enabled: [] as Array<{ serverId: string }>,
  settingsByServer: {} as Record<string, { enabled: boolean; sweepIntervalSeconds: number; lastScanAt: Date | null } | null>,
  servers: {} as Record<string, { organizationId: string | null } | undefined>,
};

const discoveryRepo = {
  getSettings: vi.fn(async (serverId: string) => state.settingsByServer[serverId] ?? null),
  listEnabledServerIds: vi.fn(async () => state.enabled),
};

const serverRepo = {
  get: vi.fn(async (serverId: string) => state.servers[serverId]),
};

vi.mock("@repo/db", () => ({
  repos: { discovery: discoveryRepo, server: serverRepo },
}));

const scan = vi.fn(async (serverId: string) => ({
  scanned: 1,
  eligible: 1,
  observed: [],
  desiredChanged: [],
  invalid: [],
  missing: [],
  withdrawn: [],
  blocked: [],
  errors: [],
  ok: true,
}));
const reconcile = vi.fn(async (): Promise<Record<string, unknown>> => ({
  withdrawals: [],
  applied: [],
  removed: [],
  retained: [],
  failed: [],
  skipped: 0,
  ok: true,
}));
const repair = vi.fn(async (): Promise<Record<string, unknown>> => ({
  scanned: 0,
  repaired: [],
  retained: [],
  requeued: [],
  failed: [],
}));
const renew = vi.fn(async () => {});

vi.mock("./discovery-scanner", () => ({ scanServerDiscovery: scan }));
vi.mock("./discovery-reconciler", () => ({ reconcileServerDiscovery: reconcile }));
vi.mock("./discovery-repair", () => ({ repairDiscoveryRoutes: repair }));
vi.mock("./discovery-watch", () => ({ renewDiscoveryWatchers: renew }));
vi.mock("../../lib/system-jobs", () => ({
  scheduleSystemJob: vi.fn(async () => {}),
}));
vi.mock("../../lib/background-work", () => ({
  trackBackgroundWork: (p: Promise<unknown>) => p,
}));

const { sweepDiscovery, sweepServerDiscovery, startDiscoverySweep } = await import("./discovery-sweep");
const { scheduleSystemJob } = await import("../../lib/system-jobs");

function enable(serverId: string, organizationId: string | null, settings?: Partial<{ sweepIntervalSeconds: number; lastScanAt: Date | null }>) {
  state.enabled.push({ serverId });
  state.servers[serverId] = { organizationId };
  state.settingsByServer[serverId] = {
    enabled: true,
    sweepIntervalSeconds: 60,
    lastScanAt: null,
    ...settings,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = [];
  state.settingsByServer = {};
  state.servers = {};
});

describe("sweepServerDiscovery", () => {
  it("runs scan → reconcile → repair for one server", async () => {
    enable("srv_1", "org_1");
    const summary = await sweepServerDiscovery("srv_1", "org_1");
    expect(scan).toHaveBeenCalledWith("srv_1", "org_1");
    expect(reconcile).toHaveBeenCalledWith("srv_1", "org_1");
    expect(repair).toHaveBeenCalledWith("srv_1", "org_1");
    expect(summary.failed).toEqual([]);
  });

  it("isolates stage failures: a throwing scan still reconciles and repairs", async () => {
    enable("srv_1", "org_1");
    scan.mockRejectedValueOnce(new Error("docker down"));
    const summary = await sweepServerDiscovery("srv_1", "org_1");
    expect(summary.failed).toEqual(["scan"]);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
  });

  it("reports a non-ok reconcile as failed without blocking repair", async () => {
    enable("srv_1", "org_1");
    reconcile.mockResolvedValueOnce({ withdrawals: [], applied: [], removed: [], retained: [], failed: [{ serviceKey: "s", reason: "x" }], skipped: 0, ok: false });
    const summary = await sweepServerDiscovery("srv_1", "org_1");
    expect(summary.failed).toEqual(["reconcile"]);
    expect(repair).toHaveBeenCalledOnce();
  });

  it("skips the scan while the per-server interval is fresh, but always reconciles and repairs", async () => {
    enable("srv_1", "org_1", { sweepIntervalSeconds: 300, lastScanAt: new Date(Date.now() - 10_000) });
    const summary = await sweepServerDiscovery("srv_1", "org_1");
    expect(scan).not.toHaveBeenCalled();
    expect(summary.scan).toBeUndefined();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
    expect(summary.failed).toEqual([]);
  });

  it("scans when the last scan is older than the configured interval", async () => {
    enable("srv_1", "org_1", { sweepIntervalSeconds: 300, lastScanAt: new Date(Date.now() - 400_000) });
    await sweepServerDiscovery("srv_1", "org_1");
    expect(scan).toHaveBeenCalledOnce();
  });

  it("scans when there is no last scan at all (startup)", async () => {
    enable("srv_1", "org_1", { lastScanAt: null });
    await sweepServerDiscovery("srv_1", "org_1");
    expect(scan).toHaveBeenCalledOnce();
  });
});

describe("sweepDiscovery", () => {
  it("sweeps every enabled server and renews watcher leases with the enabled ids", async () => {
    enable("srv_1", "org_1");
    enable("srv_2", "org_2");
    const summary = await sweepDiscovery();
    expect(summary.servers).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(renew).toHaveBeenCalledWith(["srv_1", "srv_2"]);
  });

  it("skips tenant-less servers and reports them", async () => {
    enable("srv_1", null);
    const summary = await sweepDiscovery();
    expect(summary.servers).toBe(1);
    expect(summary.failed).toEqual(["srv_1"]);
    expect(scan).not.toHaveBeenCalled();
    // The watcher renewal still runs (with the enabled ids, not the swept ones).
    expect(renew).toHaveBeenCalledWith(["srv_1"]);
  });

  it("keeps other servers sweeping when one throws", async () => {
    enable("srv_1", "org_1");
    enable("srv_2", "org_2");
    scan.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    // Note: sweepServerDiscovery catches stage errors, so a throw here models a
    // crash OUTSIDE the stages (repo failure mid-loop).
    const summary = await sweepDiscovery();
    expect(summary.servers).toBe(2);
    expect(summary.details).toHaveLength(2);
    expect(scan).toHaveBeenCalledTimes(2); // srv_2 still scanned
    void summary;
  });

  it("survives listEnabledServerIds failing", async () => {
    discoveryRepo.listEnabledServerIds.mockRejectedValueOnce(new Error("db down"));
    const summary = await sweepDiscovery();
    expect(summary.servers).toBe(0);
    expect(summary.failed).toEqual([]);
    expect(renew).not.toHaveBeenCalled();
  });
});

describe("startDiscoverySweep", () => {
  it("registers the 60-second cron job and runs the startup inventory immediately", async () => {
    enable("srv_1", "org_1");
    await startDiscoverySweep();
    expect(scheduleSystemJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "discovery:sweep", cronExpression: "* * * * *" }),
    );
    // Startup inventory: the first sweep runs (fire-and-forget) without
    // waiting for a tick.
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(renew).toHaveBeenCalledWith(["srv_1"]));
  });

  it("the job body aggregates repair counters across servers", async () => {
    enable("srv_1", "org_1");
    enable("srv_2", "org_2");
    repair.mockResolvedValue({ scanned: 1, repaired: ["a.example.com"], retained: ["b.example.com"], requeued: ["c.example.com"], failed: [] });
    let jobRun: (() => Promise<Record<string, unknown>>) | undefined;
    vi.mocked(scheduleSystemJob).mockImplementationOnce(async (opts) => {
      jobRun = opts.run as () => Promise<Record<string, unknown>>;
    });
    await startDiscoverySweep();
    // Drain the startup sweep's ticks, then run the job body directly.
    await vi.waitFor(() => expect(jobRun).toBeDefined());
    const jobSummary = await jobRun!();
    expect(jobSummary).toMatchObject({ servers: 2, failed: 0, repaired: 2, retained: 2, requeued: 2 });
  });
});
