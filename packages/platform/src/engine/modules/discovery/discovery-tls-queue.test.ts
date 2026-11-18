import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, DISCOVERY_TLS_QUEUE } from "@repo/core";

/**
 * The durable TLS queue WORKER: pacing under an injected clock (one start per
 * second), bounded in-flight claims, dispatch through the shared TLS
 * entrypoint only, durable defer/fail/supersede transitions.
 */
const queue = vi.hoisted(() => ({
  pruneCompleted: vi.fn(async (_before?: Date): Promise<number> => 0),
  claimDueOperations: vi.fn(async (_input?: unknown): Promise<Array<Record<string, unknown>>> => []),
  completeOperation: vi.fn(async (_id?: string, _outcome?: string, _now?: Date): Promise<void> => {}),
  deferOperation: vi.fn(async (_id?: string, _reason?: string, _retryAt?: Date, _now?: Date): Promise<void> => {}),
  failOperation: vi.fn(async (_id?: string, _reason?: string, _retryAt?: Date, _now?: Date): Promise<void> => {}),
  currentPolicyGeneration: vi.fn(async (_serverId?: string, _hostname?: string): Promise<number | null> => 3),
}));

vi.mock("@repo/db", () => ({ repos: { discoveryTlsQueue: queue } }));

const manageDomainSsl = vi.fn(async () => ({ verified: true } as { verified: boolean } & Record<string, unknown>));

vi.mock("../../lib/domain-ssl", () => ({
  manageDomainSsl,
  DiscoveryBackendUnavailableError: class DiscoveryBackendUnavailableError extends AppError {},
}));

const { drainDiscoveryTlsQueue, resetDiscoveryTlsQueuePacingForTests } = await import("./discovery-tls-queue");

/** Deterministic clock: manual time, recorded (never awaited) sleeps. */
function fakeClock(startMs = 0) {
  let t = startMs;
  const sleeps: number[] = [];
  const advance = (ms: number) => {
    t += ms;
  };
  // Cross-drain tests reach the CURRENT clock through this module-level hook.
  fakeClockHelpers = { advance };
  return {
    clock: {
      now: () => new Date(t),
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    },
    advance,
    sleeps,
  };
}
/** The CURRENT fake clock's time control (set by every fakeClock() call). */
let fakeClockHelpers: { advance: (ms: number) => void } = { advance: () => {} };

function operation(over: Record<string, unknown> = {}) {
  return {
    id: `dtop_${Math.random().toString(36).slice(2)}`,
    hostname: "app.example.com",
    sourceHostname: "app.example.com",
    source: "exact",
    provider: "letsencrypt",
    serverId: "srv_1",
    policyGeneration: 3,
    attempts: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDiscoveryTlsQueuePacingForTests();
  queue.currentPolicyGeneration.mockResolvedValue(3);
  queue.claimDueOperations.mockResolvedValue([]);
  manageDomainSsl.mockResolvedValue({ verified: true });
});

describe("pacing and claiming", () => {
  it("spaces issuance STARTS one second apart under the injected clock", async () => {
    const { clock, sleeps } = fakeClock();
    const ops = [operation(), operation(), operation()];
    let claim = 0;
    queue.claimDueOperations.mockImplementation(async () => (claim++ === 0 ? ops : []));
    await drainDiscoveryTlsQueue(clock);
    // Two sleeps of 1000ms: starts 1→2 and 2→3 (no trailing wait after the last).
    expect(sleeps).toEqual([1000, 1000]);
    // Every op executed exactly once through the shared entrypoint.
    expect(manageDomainSsl).toHaveBeenCalledTimes(3);
    expect(queue.completeOperation).toHaveBeenCalledTimes(3);
  });

  it("claims at most the in-flight cap and drains in further batches", async () => {
    const { clock } = fakeClock();
    const calls: number[] = [];
    queue.claimDueOperations.mockImplementation(async (input: unknown) => {
      calls.push((input as { limit: number }).limit);
      // First claim returns the cap's worth; second returns one; then none.
      if (calls.length === 1) return Array.from({ length: DISCOVERY_TLS_QUEUE.maxInFlight }, () => operation());
      if (calls.length === 2) return [operation()];
      return [] as Array<Record<string, unknown>>;
    });
    await drainDiscoveryTlsQueue(clock);
    expect(calls[0]).toBe(DISCOVERY_TLS_QUEUE.maxInFlight);
    expect(calls.length).toBe(3);
    expect(manageDomainSsl).toHaveBeenCalledTimes(DISCOVERY_TLS_QUEUE.maxInFlight + 1);
  });

  it("a single due operation starts immediately — no leading sleep", async () => {
    const { clock, sleeps } = fakeClock();
    queue.claimDueOperations.mockResolvedValueOnce([operation()]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(sleeps).toEqual([]);
    expect(manageDomainSsl).toHaveBeenCalledTimes(1);
  });

  it("P2: pacing persists ACROSS drains — a second drain cannot start at the same instant", async () => {
    const { clock, sleeps } = fakeClock();
    // Drain one: starts one job.
    queue.claimDueOperations.mockResolvedValueOnce([operation()]).mockResolvedValueOnce([]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(sleeps).toEqual([]);
    // A second drain (an ensure kick racing the sweep tick) starts its job
    // against the SAME module-level anchor: its first start sleeps the full
    // spacing — the old per-drain local reset would have started immediately.
    queue.claimDueOperations.mockResolvedValueOnce([operation()]).mockResolvedValue([]);
    fakeClockHelpers.advance(200); // well inside the spacing window
    await drainDiscoveryTlsQueue(clock);
    expect(sleeps).toEqual([800]);
    expect(manageDomainSsl).toHaveBeenCalledTimes(2);
  });
});

describe("execution dispatch", () => {
  it("completes a successful exact Let's Encrypt issuance", async () => {
    const { clock } = fakeClock();
    const op = operation();
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(manageDomainSsl).toHaveBeenCalledWith("app.example.com", {
      action: "provision",
      allowUnverified: true,
      serverId: "srv_1",
    });
    expect(queue.completeOperation).toHaveBeenCalledWith(op.id, "issued", expect.any(Date), expect.any(String));
  });

  it("defers an unusable result instead of failing it", async () => {
    const { clock } = fakeClock();
    manageDomainSsl.mockResolvedValue({ verified: false, detail: "challenge pending" });
    const op = operation();
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(queue.deferOperation).toHaveBeenCalledWith(op.id, "challenge pending", expect.any(Date), expect.any(Date), expect.any(String));
    expect(queue.completeOperation).not.toHaveBeenCalled();
  });

  it("defers — never fails — when the shared gate reports an unavailable backend", async () => {
    const { clock } = fakeClock();
    const { DiscoveryBackendUnavailableError } = await import("../../lib/domain-ssl");
    manageDomainSsl.mockRejectedValueOnce(new DiscoveryBackendUnavailableError("backend not running"));
    const op = operation();
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(queue.deferOperation).toHaveBeenCalledWith(op.id, "backend not running", expect.any(Date), expect.any(Date), expect.any(String));
    expect(queue.failOperation).not.toHaveBeenCalled();
  });

  it("records an actionable failure with backoff for real errors", async () => {
    const { clock } = fakeClock();
    manageDomainSsl.mockRejectedValueOnce(new AppError("edge write failed", 502, "EDGE_FAILED"));
    // attempts arrives post-claim-bump; attempt 3 → 2^(3-1) = 4 minutes.
    const op = operation({ attempts: 3 });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(queue.failOperation).toHaveBeenCalledWith(op.id, "edge write failed", expect.any(Date), expect.any(Date), expect.any(String));
    const retryAt = queue.failOperation.mock.calls[0][2] as Date;
    expect(retryAt.getTime() - clock.now().getTime()).toBe(4 * 60_000);
  });

  it("supersedes stale-generation work WITHOUT issuing (a policy change won)", async () => {
    const { clock } = fakeClock();
    const op = operation({ policyGeneration: 2 });
    queue.currentPolicyGeneration.mockResolvedValue(3);
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(manageDomainSsl).not.toHaveBeenCalled();
    expect(queue.completeOperation).toHaveBeenCalledWith(op.id, "superseded", expect.any(Date), expect.any(String));
  });

  it("durably defers Cloudflare intent — no ACME fallback — with the provider's reason", async () => {
    const { clock } = fakeClock();
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(manageDomainSsl).not.toHaveBeenCalled();
    expect(queue.deferOperation).toHaveBeenCalledWith(
      op.id,
      expect.stringContaining("waits for the provider dispatch"),
      expect.any(Date),
      expect.any(Date),
      expect.any(String),
    );
  });

  it("durably defers wildcard intent — no exact-host fallback", async () => {
    const { clock } = fakeClock();
    const op = operation({ source: "wildcard", sourceHostname: "*.example.com" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(manageDomainSsl).not.toHaveBeenCalled();
    expect(queue.deferOperation).toHaveBeenCalledWith(
      op.id,
      expect.stringContaining("wildcard"),
      expect.any(Date),
      expect.any(Date),
      expect.any(String),
    );
  });

  it("a vanished domain row defers its operation (nothing issues into limbo)", async () => {
    const { clock } = fakeClock();
    queue.currentPolicyGeneration.mockResolvedValue(null);
    const op = operation();
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(manageDomainSsl).not.toHaveBeenCalled();
    expect(queue.completeOperation).not.toHaveBeenCalled();
    expect(queue.deferOperation).toHaveBeenCalled();
  });
});
