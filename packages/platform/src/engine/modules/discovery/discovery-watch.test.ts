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

const { renewDiscoveryWatchers, stopDiscoveryWatchers, discoveryWatcherCount } = await import("./discovery-watch");

function enable(serverId: string, organizationId: string | null = "org_1", fixture?: RuntimeFixture) {
  state.servers[serverId] = { organizationId };
  runtimeFixtures.set(serverId, fixture ?? runtimeWithEvents());
  return runtimeFixtures.get(serverId)!;
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(sweep).toHaveBeenCalledExactlyOnceWith("srv_1", "org_1");
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
