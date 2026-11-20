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

const otherRepos = vi.hoisted(() => ({
  getTlsPolicy: vi.fn(async (): Promise<Record<string, unknown> | undefined> => ({
    tlsProvider: "cloudflare-origin-ca",
    tlsCfCredentialId: "cred_cf",
    tlsCfZoneId: "zone_1",
    tlsValidityDays: 90,
    tlsPolicyGeneration: 3,
  })),
  credentialFind: vi.fn(async (_org?: string, id?: string) => ({ id: id ?? "cred_cf", provider: "cloudflare" })),
  domainFindById: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
  countByCertificateId: vi.fn(async (): Promise<number> => 0),
  findOriginCaActiveDomainsForServer: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  findDomainsForBindings: vi.fn(async (): Promise<Map<string, Record<string, unknown>>> => new Map()),
  getBindingsForWildcard: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
}));

const issuanceInventory = vi.hoisted(() => ({
  findLiveIssuance: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
  markActive: vi.fn(async (): Promise<{ activated: boolean; reason?: string }> => ({ activated: true })),
  markSuperseded: vi.fn(async (): Promise<void> => {}),
  markFailed: vi.fn(async (): Promise<void> => {}),
  findByCertificateId: vi.fn(async (_id?: string): Promise<Record<string, unknown> | undefined> => undefined),
  findLiveIssuanceByHostname: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
}));

vi.mock("@repo/db", () => ({
  repos: {
    discoveryTlsQueue: queue,
    domain: {
      getTlsPolicy: otherRepos.getTlsPolicy,
      findById: otherRepos.domainFindById,
      countByCertificateId: otherRepos.countByCertificateId,
      findOriginCaActiveDomainsForServer: otherRepos.findOriginCaActiveDomainsForServer,
    },
    discovery: {
      getBindingForDomain: vi.fn(async () => undefined),
      getBindingsForWildcard: otherRepos.getBindingsForWildcard,
      findDomainsForBindings: otherRepos.findDomainsForBindings,
      getSettings: vi.fn(async () => ({ enabled: true })),
    },
    credential: { findById: otherRepos.credentialFind },
    discoveryTlsIssuance: issuanceInventory,
  },
}));

const manageDomainSsl = vi.fn(async () => ({ verified: true } as { verified: boolean } & Record<string, unknown>));

const installDiscoveryServerCert = vi.fn();
const readServerDomainCert = vi.fn();
vi.mock("../../lib/domain-ssl", () => ({
  manageDomainSsl,
  assertDiscoveryBackendFresh: vi.fn(async () => {}),
  sslIssueLockKey: vi.fn((hostname: string) => `lock:${hostname}`),
  installDiscoveryServerCert: (...args: unknown[]) => installDiscoveryServerCert(...args),
  readServerDomainCert: (hostname: string, opts: { serverId: string }) => readServerDomainCert(hostname, opts),
  DiscoveryBackendUnavailableError: class DiscoveryBackendUnavailableError extends AppError {},
}));
vi.mock("../../lib/credential-encryption", () => ({
  encryptSecretField: vi.fn((plain: string) => `enc1:sealed(${plain.length})`),
  decryptSecretField: vi.fn((sealed: string | null | undefined) =>
    sealed && sealed.startsWith("enc1:") ? "UNSEALED-PRIVATE-KEY" : undefined,
  ),
}));
vi.mock("../../lib/provision-lock", () => ({
  createProvisionLock: vi.fn((_key: string) => ({ run: (fn: () => Promise<unknown>) => fn() })),
}));
vi.mock("../credentials/credential.service", () => ({
  readCredentialSecrets: vi.fn((credential: { id: string } | undefined) =>
    credential ? { apiToken: `tok_${credential.id}` } : {},
  ),
}));
const ensureOriginCaIssued = vi.fn();
const ensureWildcardOriginCaShared = vi.fn();
vi.mock("./origin-ca-issuance", () => ({ ensureOriginCaIssued: ensureOriginCaIssued, ensureWildcardOriginCaShared: (...args: unknown[]) => ensureWildcardOriginCaShared(...args) }));
const revokeOriginCaCertificate = vi.fn(async (_token: string, _id: string): Promise<void> => {});
vi.mock("./origin-ca-client", () => ({
  createOriginCaCertificate: vi.fn(),
  getOriginCaCertificate: vi.fn(),
  listOriginCaCertificates: vi.fn(),
  revokeOriginCaCertificate: (token: string, id: string) => revokeOriginCaCertificate(token, id),
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
    domainId: "dom_1",
    organizationId: "org_1",
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
  otherRepos.getTlsPolicy.mockResolvedValue({
    tlsProvider: "cloudflare-origin-ca",
    tlsCfCredentialId: "cred_cf",
    tlsCfZoneId: "zone_1",
    tlsValidityDays: 90,
    tlsPolicyGeneration: 3,
  });
  otherRepos.credentialFind.mockResolvedValue({ id: "cred_cf", provider: "cloudflare" });
  otherRepos.domainFindById.mockResolvedValue(undefined);
  otherRepos.countByCertificateId.mockResolvedValue(0);
  otherRepos.findOriginCaActiveDomainsForServer.mockResolvedValue([]);
  otherRepos.findDomainsForBindings.mockResolvedValue(new Map());
  otherRepos.getBindingsForWildcard.mockResolvedValue([]);
  readServerDomainCert.mockReset();
  readServerDomainCert.mockResolvedValue({ domain: "x", verified: false, reason: "missing" });
  readServerDomainCert.mockResolvedValue({ domain: "app.example.com", verified: false, reason: "missing" });
  revokeOriginCaCertificate.mockResolvedValue(undefined);
  issuanceInventory.findByCertificateId.mockResolvedValue(undefined);
  issuanceInventory.findLiveIssuanceByHostname.mockResolvedValue(undefined);
  ensureWildcardOriginCaShared.mockResolvedValue({ outcome: "unknown", reason: "unused" });
  ensureOriginCaIssued.mockResolvedValue({
    outcome: "issued",
    issuanceId: "dti_1",
    certificateId: "ca_1",
    fingerprint: "ab:cd",
    expiresAt: new Date("2030-01-01"),
  });
  issuanceInventory.findLiveIssuance.mockResolvedValue({
    id: "dti_1",
    domainId: "dom_1",
    state: "candidate",
    certificatePem: "-----BEGIN CERTIFICATE-----",
    fingerprint: "ab:cd",
    keyEnc: "enc1:sealed",
  });
  issuanceInventory.markActive.mockResolvedValue({ activated: true });
  issuanceInventory.markSuperseded.mockResolvedValue(undefined);
  issuanceInventory.markFailed.mockResolvedValue(undefined);
  installDiscoveryServerCert.mockResolvedValue({
    outcome: "installed",
    result: { domain: "app.example.com", verified: true, issuer: "manual", expiresAt: new Date("2030-01-01").toISOString(), fingerprint: "ab:cd" },
  });
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

  it("dispatches Cloudflare Origin CA: issuance then INSTALLATION, activation commit, honest completion", async () => {
    const { clock } = fakeClock();
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    // NO ACME for Origin CA — the dedicated issuance flow ran instead.
    expect(manageDomainSsl).not.toHaveBeenCalled();
    expect(ensureOriginCaIssued).toHaveBeenCalledWith(
      expect.objectContaining({
        domainId: op.domainId,
        hostname: "app.example.com",
        zoneId: "zone_1",
        apiToken: "tok_cred_cf",
        validityDays: 90,
      }),
    );
    // Installation on the server edge: the candidate's PUBLIC cert + UNSEALED key.
    expect(installDiscoveryServerCert).toHaveBeenCalledWith(
      "app.example.com",
      { certPem: "-----BEGIN CERTIFICATE-----", keyPem: "UNSEALED-PRIVATE-KEY" },
      { serverId: op.serverId, expectedFingerprint: "ab:cd" },
    );
    // Durable activation — FENCED with the issued intent.
    expect(issuanceInventory.markActive).toHaveBeenCalledWith({
      issuanceId: "dti_1",
      domainId: op.domainId,
      expectedServerId: op.serverId,
      expectedTlsProvider: "cloudflare-origin-ca",
      expectedPolicyGeneration: op.policyGeneration,
    });
    // Honest completion naming the install outcome.
    expect(queue.completeOperation).toHaveBeenCalledWith(op.id, "installed", expect.any(Date), expect.any(String));
    expect(queue.deferOperation).not.toHaveBeenCalled();
  });

  it("a crash between install and commit recovers through the served fingerprint — no reinstall", async () => {
    const { clock } = fakeClock();
    installDiscoveryServerCert.mockResolvedValue({
      outcome: "recovered",
      result: { domain: "app.example.com", verified: true, fingerprint: "ab:cd" },
    });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(installDiscoveryServerCert).toHaveBeenCalled(); // the fingerprint CHECK ran
    expect(issuanceInventory.markActive).toHaveBeenCalledWith(
      expect.objectContaining({ issuanceId: "dti_1", domainId: op.domainId }),
    );
    expect(queue.completeOperation).toHaveBeenCalledWith(op.id, "recovered", expect.any(Date), expect.any(String));
  });

  it("a policy change DURING installation is caught by the activation fence — nothing commits", async () => {
    const { clock } = fakeClock();
    // The generation passed the pre-install check, but the FENCED transaction
    // (last word, under the write lock) sees the row has moved on.
    issuanceInventory.markActive.mockResolvedValue({
      activated: false,
      reason: "the TLS policy generation moved to 9 while installation ran",
    });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    // The fence arguments carry the intent the certificate was issued FOR.
    expect(issuanceInventory.markActive).toHaveBeenCalledWith({
      issuanceId: "dti_1",
      domainId: op.domainId,
      expectedServerId: op.serverId,
      expectedTlsProvider: "cloudflare-origin-ca",
      expectedPolicyGeneration: op.policyGeneration,
    });
    // Superseded intent retired; the stale activation never lands.
    expect(issuanceInventory.markSuperseded).toHaveBeenCalledWith("dti_1");
    expect(queue.completeOperation).toHaveBeenCalledWith(op.id, "superseded", expect.any(Date), expect.any(String));
  });

  it("a policy change between issuance and install supersedes the operation", async () => {
    const { clock } = fakeClock();
    queue.currentPolicyGeneration.mockResolvedValueOnce(3).mockResolvedValueOnce(9); // generation moved under us
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(installDiscoveryServerCert).not.toHaveBeenCalled();
    expect(queue.completeOperation).toHaveBeenCalledWith(op.id, "superseded", expect.any(Date), expect.any(String));
    expect(issuanceInventory.markActive).not.toHaveBeenCalled();
  });

  it("an installation failure defers with rollback preserved — nothing commits", async () => {
    const { clock } = fakeClock();
    installDiscoveryServerCert.mockRejectedValue(
      new AppError("The certificate for app.example.com could not be installed; the previous certificate remains on the edge.", 502, "DISCOVERY_CERT_INSTALL_FAILED"),
    );
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(queue.deferOperation).toHaveBeenCalledWith(
      op.id,
      expect.stringContaining("could not be installed"),
      expect.any(Date),
      expect.any(Date),
      expect.any(String),
    );
    expect(issuanceInventory.markActive).not.toHaveBeenCalled();
    expect(queue.completeOperation).not.toHaveBeenCalled();
  });

  it("an unverified install result defers honestly (prior certificate preserved on the edge)", async () => {
    const { clock } = fakeClock();
    installDiscoveryServerCert.mockResolvedValue({
      outcome: "installed",
      result: { domain: "app.example.com", verified: false, reason: "reload_failed" },
    });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(queue.deferOperation).toHaveBeenCalledWith(
      op.id,
      expect.stringContaining("not serving yet"),
      expect.any(Date),
      expect.any(Date),
      expect.any(String),
    );
    expect(issuanceInventory.markActive).not.toHaveBeenCalled();
  });

  it("incomplete candidate inventory defers instead of installing", async () => {
    const { clock } = fakeClock();
    issuanceInventory.findLiveIssuance.mockResolvedValue({ id: "dti_1", state: "candidate", certificatePem: null });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(installDiscoveryServerCert).not.toHaveBeenCalled();
    expect(queue.deferOperation).toHaveBeenCalledWith(
      op.id,
      expect.stringContaining("inventory"),
      expect.any(Date),
      expect.any(Date),
      expect.any(String),
    );
  });

  it("an unsealable pending key is DEFINITIVE: the issuance is retired and the operation defers", async () => {
    const { clock } = fakeClock();
    issuanceInventory.findLiveIssuance.mockResolvedValue({
      id: "dti_1", state: "candidate", certificatePem: "pem", fingerprint: "ab:cd", keyEnc: "restored-sentinel",
    });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(installDiscoveryServerCert).not.toHaveBeenCalled();
    expect(issuanceInventory.markFailed).toHaveBeenCalledWith(
      "dti_1",
      expect.stringContaining("could not be unsealed"),
    );
    expect(queue.deferOperation).toHaveBeenCalledWith(
      op.id,
      expect.stringContaining("fresh one follows"),
      expect.any(Date),
      expect.any(Date),
      expect.any(String),
    );
  });

  it("a REUSED healthy Origin CA certificate completes the operation (it is serving)", async () => {
    const { clock } = fakeClock();
    ensureOriginCaIssued.mockResolvedValue({ outcome: "reused", fingerprint: "ab", expiresAt: new Date("2030-01-01") });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(queue.completeOperation).toHaveBeenCalledWith(op.id, "reused", expect.any(Date), expect.any(String));
  });

  it("a Cloudflare policy WITHOUT its configuration defers configuration-required — no issuance", async () => {
    const { clock } = fakeClock();
    otherRepos.getTlsPolicy.mockResolvedValue({
      tlsProvider: "cloudflare-origin-ca", tlsCfCredentialId: null, tlsCfZoneId: null, tlsPolicyGeneration: 3,
    });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(ensureOriginCaIssued).not.toHaveBeenCalled();
    expect(queue.deferOperation).toHaveBeenCalledWith(
      op.id,
      expect.stringContaining("no Cloudflare credential/zone"),
      expect.any(Date),
      expect.any(Date),
      expect.any(String),
    );
  });

  it("EDGE repair: active inventory whose edge fingerprint is missing forces a fresh issuance", async () => {
    const { clock } = fakeClock();
    otherRepos.domainFindById.mockResolvedValue({
      id: "dom_1",
      tlsCertificateId: "ca_old",
      tlsActiveProvider: "cloudflare-origin-ca",
      tlsCertificateFingerprint: "old:fp",
    });
    readServerDomainCert.mockResolvedValue({ domain: "app.example.com", verified: false, reason: "missing" });
  revokeOriginCaCertificate.mockResolvedValue(undefined);
  issuanceInventory.findByCertificateId.mockResolvedValue(undefined);
  issuanceInventory.findLiveIssuanceByHostname.mockResolvedValue(undefined);
  ensureWildcardOriginCaShared.mockResolvedValue({ outcome: "unknown", reason: "unused" });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    // The database metadata alone is not trusted: the repair flag reaches the
    // issuance flow, bypassing the reuse short-circuit.
    expect(ensureOriginCaIssued).toHaveBeenCalledWith(
      expect.objectContaining({ activeMaterialHealthy: false }),
    );
  });

  it("EDGE repair: a MISMATCHED served fingerprint also forces repair", async () => {
    const { clock } = fakeClock();
    otherRepos.domainFindById.mockResolvedValue({
      id: "dom_1",
      tlsCertificateId: "ca_old",
      tlsActiveProvider: "cloudflare-origin-ca",
      tlsCertificateFingerprint: "old:fp",
    });
    readServerDomainCert.mockResolvedValue({
      domain: "app.example.com", verified: true, fingerprint: "somebody:elses", issuer: "manual",
    });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(ensureOriginCaIssued).toHaveBeenCalledWith(
      expect.objectContaining({ activeMaterialHealthy: false }),
    );
  });

  it("a transient edge read failure does NOT trigger repair (the reuse decision stands)", async () => {
    const { clock } = fakeClock();
    otherRepos.domainFindById.mockResolvedValue({
      id: "dom_1",
      tlsCertificateId: "ca_old",
      tlsActiveProvider: "cloudflare-origin-ca",
      tlsCertificateFingerprint: "old:fp",
    });
    readServerDomainCert.mockResolvedValue({ domain: "app.example.com", verified: false, reason: "read_error" });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(ensureOriginCaIssued).toHaveBeenCalledWith(
      expect.objectContaining({ activeMaterialHealthy: true }),
    );
  });

  it("ROTATION cleanup: the replaced certificate is revoked when exclusively managed and unused", async () => {
    const { clock } = fakeClock();
    // The domain previously held a DIFFERENT, exclusively managed certificate.
    otherRepos.domainFindById
      .mockResolvedValueOnce({ id: "dom_1", tlsCertificateId: "ca_previous" }) // pre-activation inventory
      .mockResolvedValueOnce({ id: "dom_1", tlsCertificateId: "ca_previous" }); // post-issue read in dispatch
    issuanceInventory.findByCertificateId.mockImplementation(
      async (id?: string): Promise<Record<string, unknown> | undefined> =>
        id === "ca_previous" ? { id: "dti_old", certificateId: "ca_previous" } : undefined,
    );
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    // Legacy row without a credential reference: the current policy credential resolves the token.
    expect(revokeOriginCaCertificate).toHaveBeenCalledWith("tok_cred_cf", "ca_previous");
    expect(queue.completeOperation).toHaveBeenCalledWith(op.id, "installed", expect.any(Date), expect.any(String));
  });

  it("CLEANUP revokes with the ISSUING credential reference from the inventory row", async () => {
    const { clock } = fakeClock();
    // The replaced certificate was issued by a DIFFERENT credential than the
    // domain's current policy names (reconfiguration mid-lifecycle).
    otherRepos.domainFindById.mockResolvedValue({ id: "dom_1", tlsCertificateId: "ca_prev" });
    issuanceInventory.findByCertificateId.mockResolvedValue({
      id: "dti_old",
      certificateId: "ca_prev",
      credentialId: "cred_issuing_old",
    });
    otherRepos.credentialFind.mockImplementation(
      async (_org: string | undefined, id?: string) =>
        id === "cred_issuing_old" ? { id: "cred_issuing_old", provider: "cloudflare" } : { id: id ?? "cred_cf", provider: "cloudflare" },
    );
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(otherRepos.credentialFind).toHaveBeenCalledWith("org_1", "cred_issuing_old");
    expect(revokeOriginCaCertificate).toHaveBeenCalledWith("tok_cred_issuing_old", "ca_prev");
  });

  it("CLEANUP restraint: a certificate another domain still uses is NOT revoked", async () => {
    const { clock } = fakeClock();
    otherRepos.domainFindById.mockResolvedValue({ id: "dom_1", tlsCertificateId: "ca_shared" });
    issuanceInventory.findByCertificateId.mockResolvedValue({ id: "dti_old", certificateId: "ca_shared" });
    otherRepos.countByCertificateId.mockResolvedValue(1); // another domain references it
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(revokeOriginCaCertificate).not.toHaveBeenCalled();
  });

  it("CLEANUP restraint: an unmanaged (adopted/uploaded) certificate is NOT revoked", async () => {
    const { clock } = fakeClock();
    otherRepos.domainFindById.mockResolvedValue({ id: "dom_1", tlsCertificateId: "ca_uploaded" });
    issuanceInventory.findByCertificateId.mockResolvedValue(undefined); // no issuance row → unmanaged
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(revokeOriginCaCertificate).not.toHaveBeenCalled();
  });

  it("WILDCARD dispatch: issues the shared pattern, installs under the pattern dir, activates all sharing domains", async () => {
    const { clock } = fakeClock();
    const wildcardOp = operation({ provider: "cloudflare-origin-ca", source: "wildcard", hostname: "a.example.com", sourceHostname: "*.example.com" });
    ensureWildcardOriginCaShared.mockResolvedValue({
      outcome: "issued", issuanceId: "dti_w", certificateId: "ca_w", fingerprint: "w:fp", expiresAt: new Date("2030-01-01"),
    });
    issuanceInventory.findLiveIssuanceByHostname.mockResolvedValue({
      id: "dti_w", state: "candidate", certificatePem: "-----BEGIN CERTIFICATE-----", fingerprint: "w:fp", keyEnc: "enc1:sealed",
    });
    otherRepos.findDomainsForBindings.mockResolvedValue(new Map([
      ["a.example.com", { id: "dom_1" }],
      ["b.example.com", { id: "dom_2" }],
    ]));
    queue.claimDueOperations.mockResolvedValueOnce([wildcardOp]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    // The PATTERN is the issuance identity + the install target.
    expect(ensureWildcardOriginCaShared).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "*.example.com", domainId: wildcardOp.domainId, credentialId: "cred_cf" }),
    );
    expect(installDiscoveryServerCert).toHaveBeenCalledWith(
      "*.example.com",
      { certPem: "-----BEGIN CERTIFICATE-----", keyPem: "UNSEALED-PRIVATE-KEY" },
      { serverId: wildcardOp.serverId, expectedFingerprint: "w:fp" },
    );
    // EVERY sharing domain activates (fenced individually).
    expect(issuanceInventory.markActive).toHaveBeenCalledWith(
      expect.objectContaining({ issuanceId: "dti_w", domainId: "dom_1" }),
    );
    expect(issuanceInventory.markActive).toHaveBeenCalledWith(
      expect.objectContaining({ issuanceId: "dti_w", domainId: "dom_2" }),
    );
    expect(queue.completeOperation).toHaveBeenCalledWith(wildcardOp.id, "installed", expect.any(Date), expect.any(String));
  });

  it("WILDCARD reuse: healthy shared material commits THIS domain's inventory and completes without issuing", async () => {
    const { clock } = fakeClock();
    const wildcardOp = operation({ provider: "cloudflare-origin-ca", source: "wildcard", hostname: "b.example.com", sourceHostname: "*.example.com" });
    otherRepos.findOriginCaActiveDomainsForServer.mockResolvedValue([
      { id: "dom_1", tlsCertificateId: "ca_shared", tlsCertificateFingerprint: "w:fp", sslExpiresAt: new Date("2030-01-01") },
    ]);
    readServerDomainCert.mockResolvedValue({ domain: "*.example.com", verified: true, fingerprint: "w:fp" });
    ensureWildcardOriginCaShared.mockResolvedValue({
      outcome: "reused", issuanceId: "dti_w0", fingerprint: "shared", expiresAt: new Date("2030-01-01"),
    });
    queue.claimDueOperations.mockResolvedValueOnce([wildcardOp]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(ensureWildcardOriginCaShared).toHaveBeenCalledWith(
      expect.objectContaining({ activeMaterialHealthy: true, activeCertificateId: "ca_shared" }),
    );
    expect(issuanceInventory.markActive).toHaveBeenCalledWith(
      expect.objectContaining({ issuanceId: "dti_w0", domainId: wildcardOp.domainId }),
    );
    expect(queue.completeOperation).toHaveBeenCalledWith(wildcardOp.id, "reused", expect.any(Date), expect.any(String));
  });

  it("WILDCARD ambiguity defers like the exact flow", async () => {
    const { clock } = fakeClock();
    const wildcardOp = operation({ provider: "cloudflare-origin-ca", source: "wildcard", hostname: "a.example.com", sourceHostname: "*.example.com" });
    ensureWildcardOriginCaShared.mockResolvedValue({ outcome: "unknown", reason: "certificate creation outcome is unknown (recovery attempt 1); no duplicate is created" });
    queue.claimDueOperations.mockResolvedValueOnce([wildcardOp]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(queue.deferOperation).toHaveBeenCalledWith(
      wildcardOp.id,
      expect.stringContaining("no duplicate is created"),
      expect.any(Date),
      expect.any(Date),
      expect.any(String),
    );
  });

  it("an ambiguous Origin CA outcome stays durably deferred with the recovery reason", async () => {
    const { clock } = fakeClock();
    ensureOriginCaIssued.mockResolvedValue({ outcome: "unknown", reason: "certificate creation outcome is unknown (recovery attempt 1); no duplicate is created" });
    const op = operation({ provider: "cloudflare-origin-ca" });
    queue.claimDueOperations.mockResolvedValueOnce([op]).mockResolvedValue([]);
    await drainDiscoveryTlsQueue(clock);
    expect(queue.deferOperation).toHaveBeenCalledWith(
      op.id,
      expect.stringContaining("no duplicate is created"),
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
