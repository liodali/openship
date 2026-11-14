import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAdapter } from "@repo/adapters";

// ── Mocks (top-level handles; the mocked-module binding is never touched) ────

const state = {
  servers: {} as Record<string, { organizationId: string | null } | undefined>,
};

const serverRepo = {
  get: vi.fn(async (serverId: string) => state.servers[serverId]),
};

vi.mock("@repo/db", () => ({
  repos: { server: serverRepo },
}));

const sweep = vi.fn(async () => ({
  serverId: "srv_1",
  failed: [] as Array<"scan" | "reconcile" | "repair">,
}));

vi.mock("./discovery-sweep", () => ({ sweepServerDiscovery: sweep }));
vi.mock("../../lib/background-work", () => ({
  trackBackgroundWork: (p: Promise<unknown>) => p,
}));

interface RuntimeFixture {
  runtime: RuntimeAdapter;
  events: Array<(event: unknown) => void>;
  cleanups: Array<() => void>;
  closed: Array<(err: Error | null) => void>;
}

function runtimeWithEvents(opts: { supported?: boolean } = {}): RuntimeFixture {
  const events: Array<(event: unknown) => void> = [];
  const closed: Array<(err: Error | null) => void> = [];
  const cleanups: Array<() => void> = [];
  const supported = opts.supported ?? true;
  const runtime = {
    supports: (cap: string) => (cap === "containerEvents" ? supported : false),
    watchContainerEvents:
      supported === false
        ? undefined
        : vi.fn(async (handlers: { onEvent: (event: unknown) => void; onClose: (err: Error | null) => void }) => {
            events.push(handlers.onEvent);
            closed.push(handlers.onClose);
            const cleanup = vi.fn();
            cleanups.push(cleanup);
            return cleanup;
          }),
    dispose: vi.fn(async () => {}),
  } as unknown as RuntimeAdapter;
  return { runtime, events, cleanups, closed };
}

const runtimeFixtures = new Map<string, RuntimeFixture>();

vi.mock("../../lib/deployment-runtime", () => ({
  createServerDockerRuntime: vi.fn(async (serverId: string) => {
    const fixture = runtimeFixtures.get(serverId);
    if (!fixture) throw new Error(`no runtime fixture for ${serverId}`);
    return fixture.runtime;
  }),
}));

const { renewDiscoveryWatchers, stopDiscoveryWatchers, fenceDiscoveryWatchers, unfenceDiscoveryWatchers, discoveryWatcherCount } =
  await import("./discovery-watch");

function enable(serverId: string, organizationId: string | null = "org_1", fixture?: RuntimeFixture) {
  state.servers[serverId] = { organizationId };
  runtimeFixtures.set(serverId, fixture ?? runtimeWithEvents());
  return runtimeFixtures.get(serverId)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  unfenceDiscoveryWatchers(); // the fence test poisons later tests otherwise
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  state.servers = {};
  runtimeFixtures.clear();
});

afterEach(() => {
  stopDiscoveryWatchers();
  vi.useRealTimers();
});

describe("renewDiscoveryWatchers", () => {
  it("arms a subscription for an enabled server on the first renewal (no startup hook needed)", async () => {
    const fixture = enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    expect(fixture.runtime.watchContainerEvents).toHaveBeenCalledOnce();
    expect(discoveryWatcherCount()).toBe(1);
  });

  it("a renewal renews the lease instead of re-arming (one subscription per server)", async () => {
    const fixture = enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    await renewDiscoveryWatchers(["srv_1"]);
    await renewDiscoveryWatchers(["srv_1"]);
    expect(fixture.runtime.watchContainerEvents).toHaveBeenCalledOnce();
  });

  it("an unsupported event stream is simply absent — the poll alone runs, no error", async () => {
    enable("srv_1", "org_1", runtimeWithEvents({ supported: false }));
    await renewDiscoveryWatchers(["srv_1"]);
    expect(discoveryWatcherCount()).toBe(0);
  });

  it("a tenant-less or missing server row never arms", async () => {
    enable("srv_1", null);
    state.servers["srv_2"] = undefined;
    runtimeFixtures.set("srv_2", runtimeWithEvents());
    await renewDiscoveryWatchers(["srv_1", "srv_2"]);
    expect(discoveryWatcherCount()).toBe(0);
  });

  it("coalesces an event burst into ONE debounced sweep", async () => {
    enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    const [onEvent] = runtimeFixtures.get("srv_1")!.events;
    onEvent({ action: "die" });
    onEvent({ action: "kill" });
    onEvent({ action: "stop" });
    await vi.advanceTimersByTimeAsync(1_400);
    expect(sweep).not.toHaveBeenCalled(); // still inside the debounce window
    await vi.advanceTimersByTimeAsync(200);
    expect(sweep).toHaveBeenCalledExactlyOnceWith("srv_1", "org_1", { fresh: true });
  });

  it("an onClose error drops the watcher and the next renewal re-arms it (the 60s tick is the backoff)", async () => {
    const fixture = enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    const [onClose] = fixture.closed;
    onClose(new Error("ssh dropped"));
    expect(discoveryWatcherCount()).toBe(0);
    await renewDiscoveryWatchers(["srv_1"]);
    expect(fixture.runtime.watchContainerEvents).toHaveBeenCalledTimes(2);
    expect(discoveryWatcherCount()).toBe(1);
  });

  it("a closed watcher's STALE expiry timer cannot drain its re-armed replacement", async () => {
    // P2: the old instance's expiry timer must be cleared on close AND guarded
    // by instance identity — after reconnect, the old timer firing (t≈155s)
    // must not delete/dispose the replacement (armed at t≈100s, expiring
    // t≈255s). Without the clear+guard, the stale timer kills the replacement.
    const fixture = enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    await vi.advanceTimersByTimeAsync(100_000); // the old subscription ages
    const [onClose] = fixture.closed;
    onClose(new Error("ssh dropped")); // old expiry timer cleared here
    await renewDiscoveryWatchers(["srv_1"]); // replacement armed at t≈100s
    const replacementCleanup = fixture.cleanups[1];
    await vi.advanceTimersByTimeAsync(60_000); // t≈160s: the OLD deadline passed
    expect(discoveryWatcherCount()).toBe(1); // the replacement survives
    // The closed instance is torn down WITHOUT cleanup() (its stream already
    // ended — onClose is mutually exclusive with cleanup per the contract);
    // its runtime dispose is the teardown evidence.
    expect(fixture.runtime.dispose).toHaveBeenCalledTimes(1); // only the closed instance's runtime
    expect(replacementCleanup).not.toHaveBeenCalled(); // the replacement's subscription is live
    void replacementCleanup;
  });

  it("closing disposes the closed instance's runtime (the held SSH/loopback is not leaked)", async () => {
    const fixture = enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    const [onClose] = fixture.closed;
    onClose(new Error("transport gone"));
    expect(fixture.runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("event-triggered sweeps read FRESH inventory, never the poll's cached state", async () => {
    enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    const [onEvent] = runtimeFixtures.get("srv_1")!.events;
    onEvent({ action: "die" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sweep).toHaveBeenCalledWith("srv_1", "org_1", { fresh: true });
  });

  it("arming after a reconnect triggers one fresh sweep too (the stream missed transitions)", async () => {
    const fixture = enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    const [onClose] = fixture.closed;
    onClose(new Error("ssh dropped"));
    sweep.mockClear();
    await renewDiscoveryWatchers(["srv_1"]); // reconnect / re-arm
    await vi.advanceTimersByTimeAsync(2_000); // the arm sweep debounce
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith("srv_1", "org_1", { fresh: true });
    void fixture;
  });

  it("fenceDiscoveryWatchers drains everything and renewal becomes a no-op", async () => {
    const fixture = enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    fenceDiscoveryWatchers();
    expect(discoveryWatcherCount()).toBe(0);
    expect(fixture.cleanups[0]).toHaveBeenCalledOnce();
    expect(fixture.runtime.dispose).toHaveBeenCalledTimes(1);
    // A renewal after the fence must NOT re-arm (a draining sweep must not
    // resurrect subscriptions against closing resources).
    await renewDiscoveryWatchers(["srv_1"]);
    expect(fixture.runtime.watchContainerEvents).toHaveBeenCalledTimes(1);
    expect(discoveryWatcherCount()).toBe(0);
  });

  it("a lease nobody renews expires itself and drains the subscription + runtime", async () => {
    const fixture = enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    await vi.advanceTimersByTimeAsync(160_000); // past LEASE_MS + margin: the self-expiry fires
    expect(discoveryWatcherCount()).toBe(0);
    expect(fixture.cleanups[0]).toHaveBeenCalledOnce();
    expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
  });

  it("a server that left the enabled set expires on the next renewal", async () => {
    const fixture = enable("srv_1");
    await renewDiscoveryWatchers(["srv_1"]);
    await renewDiscoveryWatchers([]); // discovery disabled meanwhile
    expect(discoveryWatcherCount()).toBe(0);
    expect(fixture.cleanups[0]).toHaveBeenCalledOnce();
  });
});

describe("stopDiscoveryWatchers", () => {
  it("drains every subscription and pending debounce", async () => {
    enable("srv_1");
    enable("srv_2");
    await renewDiscoveryWatchers(["srv_1", "srv_2"]);
    const [onEvent] = runtimeFixtures.get("srv_1")!.events;
    onEvent({ action: "die" }); // pending debounced sweep
    stopDiscoveryWatchers();
    expect(discoveryWatcherCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep).not.toHaveBeenCalled(); // the pending burst died with the watcher
  });
});
