import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";

// ── Mocks (top-level handles) ────────────────────────────────────────────────

const authorize = vi.fn(async () => {});

vi.mock("./authorization", () => ({
  authorization: { authorize },
}));

const state = {
  settings: { enabled: true, workspaceId: null, sweepIntervalSeconds: 60, lastScanAt: null, lastScanError: null },
  bindings: new Map<string, Record<string, unknown>>(),
  /** Server-scoped domain rows by hostname — the join target for TLS state. */
  domains: new Map<string, Record<string, unknown>>(),
  forgotten: [] as string[],
  configured: [] as Array<{ enabled: boolean }>,
  withdrawalsScheduled: 0,
  /** Durable TLS operations by id (the ensure/queue surface). */
  tlsOperations: new Map<string, Record<string, unknown>>(),
  /** Material state for the ensure-enrollment domain row (undefined = none). */
  domainSsl: undefined as { sslStatus: string; verified: boolean; sslExpiresAt: Date | null } | undefined,
  /** Persisted per-domain TLS policy for getTlsPolicy (undefined = default). */
  domainPolicy: undefined as Record<string, unknown> | undefined,
  /** Server TLS default provider (configureServerTls path). */
  serverTlsDefault: undefined as string | undefined,
};

/** The one domain fixture every lookup path shares — batch and single alike. */
const DOMAIN_ROW = {
  hostname: "app.example.com",
  verified: true,
  sslStatus: "issued",
  sslExpiresAt: new Date("2030-01-01"),
  sslIssuer: "letsencrypt",
};

const discoveryRepo = {
  getSettings: vi.fn(async () => state.settings),
  getTlsSettings: vi.fn(async () => ({ defaultProvider: state.serverTlsDefault ?? "letsencrypt" })),
  configureTls: vi.fn(async (_serverId: string, defaultProvider: string) => {
    state.serverTlsDefault = defaultProvider;
    return { defaultProvider };
  }),
  configure: vi.fn(async (_serverId: string, patch: { enabled: boolean }) => {
    state.configured.push(patch);
    state.settings = { ...state.settings, enabled: patch.enabled };
    return { serverId: "srv_1", ...state.settings };
  }),
  disableAndScheduleWithdrawals: vi.fn(async (_serverId: string) => {
    state.settings = { ...state.settings, enabled: false };
    return [];
  }),
  getBinding: vi.fn(async (_serverId: string, serviceKey: string) => state.bindings.get(serviceKey)),
  listByServer: vi.fn(async () => [...state.bindings.values()]),
  findDomainForBinding: vi.fn(async (_serverId: string, hostname: string) => state.domains.get(hostname.toLowerCase()) ?? null),
  findDomainsForBindings: vi.fn(async (_serverId: string, hostnames: string[]) => {
    const out = new Map<string, Record<string, unknown>>();
    for (const hostname of hostnames) {
      const row = state.domains.get(hostname.toLowerCase());
      if (row) out.set(hostname.toLowerCase(), row);
    }
    return out;
  }),
  suppress: vi.fn(async (_serverId: string, serviceKey: string) => state.bindings.get(serviceKey)),
  unsuppress: vi.fn(async (_serverId: string, serviceKey: string) => state.bindings.get(serviceKey)),
  forget: vi.fn(async (_serverId: string, serviceKey: string) => {
    state.forgotten.push(serviceKey);
    state.bindings.delete(serviceKey);
  }),
  scheduleWithdrawalForAll: vi.fn(async () => {
    state.withdrawalsScheduled += 1;
    return [];
  }),
};

/** The durable TLS operation queue surface the operations module consumes. */
let operationSeq = 0;
const tlsQueueRepo = {
  listActiveOperationsByServer: vi.fn(async () => {
    const out = new Map<string, Record<string, unknown>>();
    for (const op of state.tlsOperations.values()) {
      if (!out.has(op.hostname as string)) out.set(op.hostname as string, op);
    }
    return out;
  }),
  findActiveOperationForHostname: vi.fn(async (_serverId: string, hostname: string) => {
    for (const op of state.tlsOperations.values()) if (op.hostname === hostname.toLowerCase()) return op;
    return undefined;
  }),
  ensureOperation: vi.fn(async (input: Record<string, unknown> & { hostname: string; sourceHostname: string; initialReason?: string }) => {
    const existing = [...state.tlsOperations.values()].find(
      (op) => op.hostname === input.hostname && op.sourceHostname === input.sourceHostname && op.state !== "complete",
    );
    if (existing) return { operation: existing, created: false };
    const op = {
      id: `dtop_test_${operationSeq++}`,
      state: input.initialReason ? "deferred" : "waiting",
      reason: input.initialReason ?? null,
      attempts: 0,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...input,
      hostname: input.hostname.toLowerCase(),
    };
    state.tlsOperations.set(op.id as string, op);
    return { operation: op, created: true };
  }),
};

/** The domain-repo surface the operations module consumes (ensure enrollment). */
const domainRepo = {
  ensureServerDomain: vi.fn(async (input: { hostname: string; targetPort: number }) => ({
    domain: {
      id: "dom_ensure",
      hostname: input.hostname.toLowerCase(),
      serverId: "srv_1",
      ownerType: "server",
      targetPort: input.targetPort,
      sslStatus: state.domainSsl?.sslStatus ?? "none",
      verified: state.domainSsl?.verified ?? false,
      sslExpiresAt: state.domainSsl?.sslExpiresAt ?? null,
      ...state.domainPolicy,
    },
    created: true,
  })),
  getTlsPolicy: vi.fn(async () => ({
    hostname: "app.example.com",
    ownerType: "server",
    serverId: "srv_1",
    tlsProvider: state.domainPolicy?.tlsProvider ?? "letsencrypt",
    tlsProviderSource: state.domainPolicy?.tlsProviderSource ?? "default",
    tlsPolicyOrigin: state.domainPolicy?.tlsPolicyOrigin ?? null,
    tlsActiveProvider: state.domainPolicy?.tlsActiveProvider ?? null,
    tlsPolicyGeneration: state.domainPolicy?.tlsPolicyGeneration ?? 1,
    tlsCfCredentialId: state.domainPolicy?.tlsCfCredentialId ?? null,
    tlsCfZoneId: state.domainPolicy?.tlsCfZoneId ?? null,
    tlsCfZoneName: state.domainPolicy?.tlsCfZoneName ?? null,
    tlsValidityDays: state.domainPolicy?.tlsValidityDays ?? null,
  })),
  setTlsPolicy: vi.fn(async (input: {
    domainId: string;
    policy: { provider: string; credentialId?: string; zoneId?: string; zoneName?: string; validityDays?: number };
  }) => {
    state.domainPolicy = {
      tlsProvider: input.policy.provider,
      tlsProviderSource: "explicit",
      tlsPolicyOrigin: "admin",
      tlsPolicyGeneration: ((state.domainPolicy?.tlsPolicyGeneration as number | undefined) ?? 1) + 1,
      tlsCfCredentialId: input.policy.provider === "cloudflare-origin-ca" ? input.policy.credentialId ?? null : null,
      tlsCfZoneId: input.policy.provider === "cloudflare-origin-ca" ? input.policy.zoneId ?? null : null,
      tlsCfZoneName: input.policy.provider === "cloudflare-origin-ca" ? input.policy.zoneName ?? null : null,
      tlsValidityDays: input.policy.provider === "cloudflare-origin-ca" ? input.policy.validityDays ?? null : null,
    };
    return { id: input.domainId, hostname: "app.example.com", sslStatus: "none", ...state.domainPolicy };
  }),
};

vi.mock("@repo/db", () => ({
  repos: { discovery: discoveryRepo, discoveryTlsQueue: tlsQueueRepo, domain: domainRepo, credential: credentialRepo },
  // Advisory-lock primitives used by the per-hostname provision lock (policy
  // mutations serialize with TLS-queue installation); in-process stubs here.
  withAdvisoryLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  tryAcquireAdvisoryLock: vi.fn(async () => ({ release: async () => {} })),
}));

/** Org-scoped credential lookups (the CF policy path's token source). */
const credentialRepo = {
  findById: vi.fn(async (_orgId: string, id: string) =>
    id === "cred_cf"
      ? { id: "cred_cf", organizationId: "org_1", provider: "cloudflare", name: "zone token", secretsEnc: "enc1:x" }
      : id === "cred_registry"
        ? { id: "cred_registry", organizationId: "org_1", provider: "docker-registry", name: "ghcr", secretsEnc: "enc1:x" }
        : undefined,
  ),
};

const kick = vi.fn();
vi.mock("./engine/modules/discovery/discovery-tls-queue", () => ({ kickDiscoveryTlsQueue: kick }));

/** The Cloudflare preflight: READ-ONLY checks before any policy write. */
const preflight = vi.fn(async () => ({ zoneName: "example.com" }));
vi.mock("./engine/modules/discovery/tls-preflight", () => ({ preflightCloudflareOriginCa: preflight }));

/** Credential decryption (never exercised directly in unit tests). */
const readSecrets = vi.fn(() => ({ apiToken: "tok_test" }));
vi.mock("./engine/modules/credentials/credential.service", () => ({ readCredentialSecrets: readSecrets }));

/** The shared TLS entrypoint: the skip path validates INSTALLED material
 *  through a read-only verify (never trusting database bookkeeping alone). */
const tlsVerify = vi.fn(async () =>
  ({ verified: true, expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString() } as { verified: boolean; expiresAt?: string; reason?: string; detail?: string }),
);

/** Read-only edge-material read (the Cloudflare skip proof). */
const tlsEdgeRead = vi.fn(async (_hostname: string, _opts: { serverId: string }) =>
  ({ verified: true, fingerprint: "fp:9", expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }));

/**
 * The managed vhost's CONFIGURED certificate selection (the skip proof's
 * route-activation half). Defaults to "expected" — the steady state every
 * existing skip assumes; drift/unproven tests override per call.
 */
type VhostProbeResult =
  | { status: "expected" }
  | { status: "drifted"; certPath: string }
  | { status: "no_tls_listener" }
  | { status: "no_route" }
  | { status: "unavailable" }
  | { status: "unproven" };
const tlsVhostProbe = vi.fn(
  async (_hostname: string, _opts: { serverId: string; expectedCertDomain: string }): Promise<VhostProbeResult> =>
    ({ status: "expected" }),
);
vi.mock("./engine/lib/domain-ssl", () => ({
  manageDomainSsl: (...args: unknown[]) => tlsVerify(...(args as [])),
  readServerDomainCert: (hostname: string, opts: { serverId: string }) => tlsEdgeRead(hostname, opts),
  probeServerDomainVhostCert: (hostname: string, opts: { serverId: string; expectedCertDomain: string }) =>
    tlsVhostProbe(hostname, opts),
  certComfortablyValid: (result: { verified?: boolean; expiresAt?: string | null }) =>
    !!result.verified && !!result.expiresAt && new Date(result.expiresAt).getTime() > Date.now(),
  sslIssueLockKey: (hostname: string) => `lock:${hostname}`,
}));

const sweep = vi.fn(async () => ({
  serverId: "srv_1",
  failed: [],
  scan: { scanned: 3, ok: true },
  reconcile: { withdrawals: [], applied: ["id:my-app"], removed: [], retained: [], failed: [], ok: true },
  repair: { scanned: 1, repaired: [], retained: [], requeued: [], failed: [] },
}));
const retire = vi.fn(async () => {});

const queueTasks: Array<() => Promise<unknown>> = [];
/** Set by queue-deferral tests: tasks queue without executing until flushed. */
let deferQueue = false;
/** Production semantics for deferred tasks: the caller's promise resolves
 *  only when its task eventually runs (an early resolve would let queued
 *  operations continue on state their task has not produced yet). */
const deferred: Array<() => void> = [];
const runQueuedTasksNow = async (): Promise<void> => {
  deferQueue = false;
  // Deferred wrappers run their task EXACTLY ONCE (queueTasks is the
  // enqueue record; execution happens here, awaited).
  for (const run of deferred.splice(0)) await run();
};
vi.mock("./engine/modules/discovery/discovery-sweep", () => ({
  sweepServerDiscovery: sweep,
  runInServerQueue: vi.fn((_serverId: string, task: () => Promise<unknown>) => {
    queueTasks.push(task);
    if (!deferQueue) return task();
    return new Promise((resolve, reject) => {
      deferred.push(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      });
    });
  }),
}));
vi.mock("./engine/modules/discovery/discovery-reconciler", () => ({ retireBindingRoute: retire }));

const { createDiscoveryOperations } = await import("./discovery");

const ctx = {
  organizationId: "org_1",
  userId: "usr_1",
} as unknown as import("./context").ExecutionContext;

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dsb_1",
    serviceKey: "id:my-app",
    hostname: "app.example.com",
    port: 3000,
    containerName: "my-app",
    observationStatus: "observed",
    containerRunning: true,
    applyState: "applied",
    applyAttempts: 0,
    desiredGeneration: 2,
    appliedGeneration: 2,
    suppressed: false,
    withdrawalPending: false,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = { enabled: true, workspaceId: null, sweepIntervalSeconds: 60, lastScanAt: null, lastScanError: null };
  state.bindings = new Map([["id:my-app", binding()]]);
  state.domains = new Map([["app.example.com", { ...DOMAIN_ROW }]]);
  state.forgotten = [];
  state.configured = [];
  state.withdrawalsScheduled = 0;
  state.tlsOperations = new Map();
  state.domainSsl = undefined;
  state.domainPolicy = undefined;
  state.serverTlsDefault = undefined;
  queueTasks.length = 0;
  deferred.length = 0;
  deferQueue = false;
  // The managed vhost's configured selection defaults to the steady state
  // ("expected") so the pre-existing skip behavior is unchanged; drift and
  // unproven cases override per test.
  tlsVhostProbe.mockResolvedValue({ status: "expected" });
});

describe("createDiscoveryOperations", () => {
  it("authorizes SERVER access for every operation, at the right strength", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    await ops.status(ctx, "srv_1");
    expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "read" });
    authorize.mockClear();
    await ops.getService(ctx, "srv_1", { serviceKey: "id:my-app" });
    expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "read" });
    authorize.mockClear();
    await ops.configure(ctx, "srv_1", { enabled: false });
    expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "admin" });
    authorize.mockClear();
    await ops.rescan(ctx, "srv_1");
    expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "write" });
    authorize.mockClear();
    await ops.forget(ctx, "srv_1", { serviceKey: "id:my-app" });
    expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "admin" });
  });

  it("status joins each binding with its server-scoped TLS state", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const { data } = await ops.status(ctx, "srv_1");
    expect(data.settings.enabled).toBe(true);
    expect(data.services).toHaveLength(1);
    expect(data.services[0]).toMatchObject({
      serviceKey: "id:my-app",
      hostname: "app.example.com",
      applyState: "applied",
      tls: { verified: true, sslStatus: "issued", sslIssuer: "letsencrypt", sslExpiresAt: "2030-01-01T00:00:00.000Z" },
    });
  });

  it("status reads domains in ONE server-scoped batch — never a per-binding loop", async () => {
    // The N+1 pin: whatever the binding count, the domain join is one call.
    // A regression to findDomainForBinding per row scales with binding count
    // (hundreds to thousands per server are expected).
    const ops = createDiscoveryOperations({ authorize } as never);
    state.bindings.set("id:second", binding({ serviceKey: "id:second", hostname: "second.example.com" }));
    await ops.status(ctx, "srv_1");
    expect(discoveryRepo.findDomainsForBindings).toHaveBeenCalledTimes(1);
    expect(discoveryRepo.findDomainsForBindings).toHaveBeenCalledWith("srv_1", ["app.example.com", "second.example.com"]);
    expect(discoveryRepo.findDomainForBinding).not.toHaveBeenCalled();
  });

  it("getService reads one service with a CONSTANT shape — the same serializer the list uses", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const list = await ops.status(ctx, "srv_1");
    vi.clearAllMocks(); // isolate the single read's own repository calls
    const single = await ops.getService(ctx, "srv_1", { serviceKey: "id:my-app" });
    expect(single.data).toEqual(list.data.services[0]);
    // The single read joins the domain server-scoped on its own — one binding
    // lookup plus one domain lookup, and never the batch path.
    expect(discoveryRepo.getBinding).toHaveBeenCalledWith("srv_1", "id:my-app");
    expect(discoveryRepo.findDomainForBinding).toHaveBeenCalledWith("srv_1", "app.example.com");
    expect(discoveryRepo.findDomainsForBindings).not.toHaveBeenCalled();
  });

  it("a binding without a domain row keeps today's TLS defaults in BOTH reads", async () => {
    state.domains.clear();
    const ops = createDiscoveryOperations({ authorize } as never);
    const single = await ops.getService(ctx, "srv_1", { serviceKey: "id:my-app" });
    const list = await ops.status(ctx, "srv_1");
    const expected = {
      hostname: "app.example.com", // falls back to the binding's own declaration
      verified: false,
      sslStatus: "none",
      sslExpiresAt: null,
      sslIssuer: null,
      tlsProvider: null, // additive provider fields: null without a domain row
      tlsActiveProvider: null,
    };
    expect(single.data.tls).toEqual(expected);
    expect(list.data.services[0].tls).toEqual(expected);
  });

  it("getService rejects unknown services with the not-found error", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    await expect(ops.getService(ctx, "srv_1", { serviceKey: "id:ghost" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("disable commits settings + withdrawal scheduling ATOMICALLY (one repo call)", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const { data } = await ops.configure(ctx, "srv_1", { enabled: false });
    // The atomic repo method is the ONLY writer: separate configure(false) +
    // scheduling calls could interleave with a crash, leaving live routes on a
    // server no sweep would select.
    expect(discoveryRepo.disableAndScheduleWithdrawals).toHaveBeenCalledWith("srv_1");
    expect(discoveryRepo.configure).not.toHaveBeenCalled();
    expect(data.settings.enabled).toBe(false);
    expect(queueTasks).toHaveLength(1); // the whole disable entered the server queue
  });

  it("enable keeps using the plain configure path", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    await ops.configure(ctx, "srv_1", { enabled: true });
    expect(discoveryRepo.configure).toHaveBeenCalledWith("srv_1", { enabled: true });
    expect(discoveryRepo.disableAndScheduleWithdrawals).not.toHaveBeenCalled();
  });

  it("rescan enters the serialized server queue with FRESH inventory and validates its output", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const { data } = await ops.rescan(ctx, "srv_1");
    expect(sweep).toHaveBeenCalledWith("srv_1", "org_1", { fresh: true });
    expect(data).toMatchObject({
      serverId: "srv_1",
      failed: [],
      scan: { scanned: 3, ok: true },
      reconcile: { applied: ["id:my-app"], ok: true },
    });
  });

  it("forget retires the route BEFORE deleting the binding, INSIDE the server sweep queue", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const { data } = await ops.forget(ctx, "srv_1", { serviceKey: "id:my-app" });
    expect(data.forgotten).toBe(true);
    expect(retire).toHaveBeenCalledWith("srv_1", "org_1", expect.objectContaining({ hostname: "app.example.com" }));
    expect(discoveryRepo.forget).toHaveBeenCalledWith("srv_1", "id:my-app");
    // Order matters: a failed removal must leave the binding intact.
    const retireOrder = retire.mock.invocationCallOrder[0];
    const forgetOrder = discoveryRepo.forget.mock.invocationCallOrder[0];
    expect(retireOrder).toBeLessThan(forgetOrder);
    // P1: the WHOLE retire+delete sequence runs inside the serialized server
    // queue — an in-flight reconcile must not recreate the route between the
    // two steps. (The inline mock executed the task once; the recorded entry
    // must never be re-run — the binding is already deleted.)
    expect(queueTasks).toHaveLength(1);
  });

  it("a forget whose route removal fails leaves NO queue residue and deletes nothing", async () => {
    retire.mockRejectedValueOnce(new Error("edge down"));
    const ops = createDiscoveryOperations({ authorize } as never);
    await expect(ops.forget(ctx, "srv_1", { serviceKey: "id:my-app" })).rejects.toThrow("edge down");
    expect(state.bindings.has("id:my-app")).toBe(true);
    expect(queueTasks).toHaveLength(1); // the failed task entered and drained from the queue
  });

  it("forget reads the binding INSIDE the queue: a queued scan may have changed the hostname first", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    deferQueue = true; // the forget task queues behind a not-yet-run scan
    const pending = ops.forget(ctx, "srv_1", { serviceKey: "id:my-app" });
    await vi.waitFor(() => expect(queueTasks.length).toBe(1)); // the op reached the queue
    // The queued scan REPLACES the container: same serviceKey, new hostname.
    state.bindings.set("id:my-app", binding({ hostname: "renamed.example.com" }));
    await runQueuedTasksNow(); // scan already consumed its slot; the forget task now runs
    await pending;
    // The retirement targeted the CURRENT (post-scan) hostname, not a stale one.
    expect(retire).toHaveBeenCalledWith(
      "srv_1",
      "org_1",
      expect.objectContaining({ hostname: "renamed.example.com" }),
    );
    expect(discoveryRepo.forget).toHaveBeenCalledWith("srv_1", "id:my-app");
  });

  it("disable runs INSIDE the server queue too (cannot race a first route write)", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    deferQueue = true;
    const pending = ops.configure(ctx, "srv_1", { enabled: false }); // queued behind passes
    expect(discoveryRepo.disableAndScheduleWithdrawals).not.toHaveBeenCalled(); // waits for the queue
    await runQueuedTasksNow();
    await pending;
    expect(discoveryRepo.disableAndScheduleWithdrawals).toHaveBeenCalledWith("srv_1");
    expect(state.settings.enabled).toBe(false);
  });

  it("suppress/unsuppress return the updated service with its TLS state", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const { data } = await ops.suppress(ctx, "srv_1", { serviceKey: "id:my-app" });
    expect(discoveryRepo.suppress).toHaveBeenCalledWith("srv_1", "id:my-app");
    expect(data).toMatchObject({ serviceKey: "id:my-app", tls: { verified: true } });
    const again = await ops.unsuppress(ctx, "srv_1", { serviceKey: "id:my-app" });
    expect(again.data).toMatchObject({ serviceKey: "id:my-app" });
  });

  it("rejects unknown services with NotFound", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    await expect(ops.forget(ctx, "srv_1", { serviceKey: "id:ghost" })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(ops.getService(ctx, "srv_1", { serviceKey: "" })).rejects.toBeDefined(); // empty key fails input validation
  });

  describe("ensureServiceTls (idempotent durable ensure)", () => {
    const ensure = (input?: unknown) =>
      createDiscoveryOperations({ authorize } as never).ensureServiceTls(ctx, "srv_1", input ?? { serviceKey: "id:my-app" });

    it("authorizes server WRITE and skips when valid letsencrypt material is INSTALLED (verified, not just recorded)", async () => {
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      const { data } = await ensure();
      expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "write" });
      // The skip PROVED the installed material through a read-only Edge verify.
      expect(tlsVerify).toHaveBeenCalledWith("app.example.com", expect.objectContaining({ action: "verify", serverId: "srv_1" }));
      expect(data).toEqual({ outcome: "skipped", reason: "already_valid", hostname: "app.example.com", source: "exact" });
      expect(tlsQueueRepo.ensureOperation).not.toHaveBeenCalled(); // skip creates no job
    });

    it("P2: an old Cloudflare certificate (recorded installed provider) never skips a Let's Encrypt ensure", async () => {
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      state.domainPolicy = { tlsActiveProvider: "cloudflare-origin-ca" };
      const { data } = await ensure();
      // The provenance guard short-circuits: no verify, no skip — durable work.
      expect(tlsVerify).not.toHaveBeenCalled();
      expect(data).toMatchObject({ outcome: "queued" });
    });

    it("skips when healthy Cloudflare-managed exact material is installed and the edge fingerprint EQUALS the recorded certificate", async () => {
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      state.domainPolicy = {
        tlsProvider: "cloudflare-origin-ca", tlsActiveProvider: "cloudflare-origin-ca",
        tlsCfCredentialId: "cred_1", tlsCfZoneId: "zone_1", tlsPolicyGeneration: 2,
        tlsCertificateId: "ca_9", tlsCertificateFingerprint: "fp:9",
      };
      const { data } = await ensure();
      // The skip proved provider provenance AND material identity — no job.
      expect(tlsEdgeRead).toHaveBeenCalledWith("app.example.com", { serverId: "srv_1" });
      expect(data).toEqual({ outcome: "skipped", reason: "already_valid", hostname: "app.example.com", source: "exact" });
      expect(tlsQueueRepo.ensureOperation).not.toHaveBeenCalled();
    });

    it("skips a wildcard source when the shared certificate identity matches the edge read (source: wildcard)", async () => {
      state.bindings.set("id:my-app", binding({ tlsDeclaredWildcard: "*.example.com" }));
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      state.domainPolicy = {
        tlsProvider: "cloudflare-origin-ca", tlsActiveProvider: "cloudflare-origin-ca",
        tlsCfCredentialId: "cred_1", tlsCfZoneId: "zone_1", tlsPolicyGeneration: 2,
        tlsCertificateId: "ca_w", tlsCertificateFingerprint: "fp:9",
      };
      const { data } = await ensure();
      expect(data).toEqual({ outcome: "skipped", reason: "already_valid", hostname: "app.example.com", source: "wildcard" });
      expect(tlsQueueRepo.ensureOperation).not.toHaveBeenCalled();
      // The skip also proved route activation: the child's vhost must SELECT
      // the declared pattern directory, and the expected source is the
      // WILDCARD identity, never the child's own hostname.
      expect(tlsVhostProbe).toHaveBeenCalledWith("app.example.com", {
        serverId: "srv_1",
        expectedCertDomain: "*.example.com",
      });
    });

    it("healthy Let's Encrypt files + a vhost still selecting the BOOTSTRAP pair queue repair instead of skipping", async () => {
      // The drift the material read cannot see: certDir holds healthy exact
      // material while the managed vhost still names its enrollment bootstrap
      // pair. A skip here would return already_valid for a route that serves
      // the wrong certificate forever.
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      tlsVhostProbe.mockResolvedValueOnce({ status: "drifted", certPath: "/etc/letsencrypt/openship-bootstrap/app.example.com/fullchain.pem" });
      const { data } = await ensure();
      expect(tlsVerify).toHaveBeenCalled(); // the material proof PASSED…
      expect(tlsVhostProbe).toHaveBeenCalledWith("app.example.com", { serverId: "srv_1", expectedCertDomain: "app.example.com" });
      expect(data).toMatchObject({ outcome: "queued" }); // …and the route proof refused the skip
      expect(tlsQueueRepo.ensureOperation).toHaveBeenCalled();
    });

    it("healthy Cloudflare files + a vhost selecting an OUTDATED source queue repair (exact and shared)", async () => {
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      state.domainPolicy = {
        tlsProvider: "cloudflare-origin-ca", tlsActiveProvider: "cloudflare-origin-ca",
        tlsCfCredentialId: "cred_1", tlsCfZoneId: "zone_1", tlsPolicyGeneration: 2,
        tlsCertificateId: "ca_9", tlsCertificateFingerprint: "fp:9",
      };
      // The recorded fingerprint is what the edge READS — the vhost's
      // configured selection is the only signal that can disagree.
      tlsVhostProbe.mockResolvedValueOnce({ status: "drifted", certPath: "/etc/letsencrypt/live/old.example.com/fullchain.pem" });
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued", hostname: "app.example.com" });

      // Same rule for a shared wildcard child whose vhost never switched to
      // the pattern directory.
      tlsQueueRepo.ensureOperation.mockClear();
      state.bindings.set("id:my-app", binding({ tlsDeclaredWildcard: "*.example.com" }));
      tlsVhostProbe.mockResolvedValueOnce({ status: "drifted", certPath: "/etc/letsencrypt/openship-bootstrap/app.example.com/fullchain.pem" });
      const wildcard = await ensure();
      expect(wildcard.data).toMatchObject({ outcome: "queued", hostname: "app.example.com" });
      expect(tlsQueueRepo.ensureOperation).toHaveBeenCalledWith(
        expect.objectContaining({ sourceHostname: "*.example.com", source: "wildcard" }),
      );
    });

    it("a vhost with NO TLS listener while the inventory says active never skips", async () => {
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      state.domainPolicy = {
        tlsProvider: "cloudflare-origin-ca", tlsActiveProvider: "cloudflare-origin-ca",
        tlsCfCredentialId: "cred_1", tlsCfZoneId: "zone_1", tlsPolicyGeneration: 2,
        tlsCertificateId: "ca_9", tlsCertificateFingerprint: "fp:9",
      };
      tlsVhostProbe.mockResolvedValueOnce({ status: "no_tls_listener" });
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued" });
    });

    it("an UNPROVABLE vhost read queues durable work — never a skip, never a throw", async () => {
      // A transport blip during the conf read is a RETRYABLE state: the
      // durable drain re-proves everything (and its own edge read decides
      // reuse vs repair), so queueing is the honest answer.
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      tlsVhostProbe.mockResolvedValueOnce({ status: "unproven" });
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued" });
      expect(tlsQueueRepo.ensureOperation).toHaveBeenCalled();
    });

    it("a MISSING route does not block the skip — route restoration is the repair sweep's own state", async () => {
      // Activation from durable records would silently no-op for a fully
      // missing route (no sidecar to re-register from), so queueing TLS work
      // here would only churn operations; the route repair sweep owns it.
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      tlsVhostProbe.mockResolvedValueOnce({ status: "no_route" });
      const { data } = await ensure();
      expect(data).toEqual({ outcome: "skipped", reason: "already_valid", hostname: "app.example.com", source: "exact" });
      expect(tlsQueueRepo.ensureOperation).not.toHaveBeenCalled();
    });

    it("an edge with NO vhost signal keeps the files-only skip decision", async () => {
      // Cloud API / no-edge desktop: no generated config exists to classify,
      // so the pre-signal proof stands unchanged.
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      tlsVhostProbe.mockResolvedValueOnce({ status: "unavailable" });
      const { data } = await ensure();
      expect(data).toEqual({ outcome: "skipped", reason: "already_valid", hostname: "app.example.com", source: "exact" });
    });

    it("a Cloudflare edge read that does NOT match the recorded identity queues instead of skipping (bootstrap conflation guard)", async () => {
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      state.domainPolicy = {
        tlsProvider: "cloudflare-origin-ca", tlsActiveProvider: "cloudflare-origin-ca",
        tlsCfCredentialId: "cred_1", tlsCfZoneId: "zone_1", tlsPolicyGeneration: 2,
        tlsCertificateId: "ca_9", tlsCertificateFingerprint: "fp:9",
      };
      // The resolver can read SOME healthy pair (e.g. an inherited wildcard or
      // leftover material) that is not the certificate the inventory records —
      // a skip here would strand a vhost still serving foreign material.
      tlsEdgeRead.mockResolvedValueOnce({ verified: true, fingerprint: "other:fp", expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued" });
    });

    it("Cloudflare-managed material without a recorded certificate identity (first contact) never skips", async () => {
      state.domainSsl = { sslStatus: "none", verified: false, sslExpiresAt: null };
      state.domainPolicy = {
        tlsProvider: "cloudflare-origin-ca", tlsActiveProvider: null,
        tlsCfCredentialId: "cred_1", tlsCfZoneId: "zone_1", tlsPolicyGeneration: 2,
      };
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued" });
      expect(tlsEdgeRead).not.toHaveBeenCalled();
    });

    it("P2: healthy bookkeeping with missing/unusable installed material queues instead of skipping", async () => {
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      tlsVerify.mockResolvedValueOnce({ verified: false, reason: "missing" });
      const { data } = await ensure();
      expect(tlsVerify).toHaveBeenCalled();
      expect(data).toMatchObject({ outcome: "queued" }); // the row lied; the Edge decides
    });

    it("an UNPROVABLE skip (edge unreachable during verify) queues instead", async () => {
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      tlsVerify.mockRejectedValueOnce(new Error("edge unreachable"));
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued" }); // fall through to durable work
    });

    it("queues durable work with a stable operation id and kicks the drain", async () => {
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued", hostname: "app.example.com" });
      expect(typeof (data as { operationId: string }).operationId).toBe("string");
      expect(kick).toHaveBeenCalledTimes(1);
      // A retried ensure returns the SAME operation id — never a second job.
      const retry = await ensure();
      expect(retry.data).toMatchObject({
        outcome: "already_queued",
        operationId: (data as { operationId: string }).operationId,
      });
      expect(kick).toHaveBeenCalledTimes(1); // only creations kick
    });

    it("defers — with a durable operation — when the backend is not runnable", async () => {
      state.bindings.set("id:my-app", binding({ containerRunning: false }));
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "deferred", hostname: "app.example.com" });
      expect((data as { reason: string }).reason).toContain("not running");
      // A later ensure against the still-deferred operation reports deferred again.
      const retry = await ensure();
      expect(retry.data).toMatchObject({ outcome: "deferred" });
    });

    it("refuses Cloudflare without its per-domain configuration (no create, no fallback)", async () => {
      state.domainPolicy = { tlsProvider: "cloudflare-origin-ca", tlsCfCredentialId: null, tlsCfZoneId: null, tlsPolicyGeneration: 2 };
      await expect(ensure()).rejects.toMatchObject({ code: "TLS_CONFIGURATION_REQUIRED" });
      expect(tlsQueueRepo.ensureOperation).not.toHaveBeenCalled();
    });

    it("queues (durably deferred by the worker) a configured Cloudflare policy", async () => {
      state.domainPolicy = { tlsProvider: "cloudflare-origin-ca", tlsCfCredentialId: "cred_1", tlsCfZoneId: "zone_1", tlsPolicyGeneration: 2 };
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued", hostname: "app.example.com" });
    });

    it("a declared wildcard sources the operation from the wildcard identity", async () => {
      state.bindings.set("id:my-app", binding({ tlsDeclaredWildcard: "*.example.com" }));
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued" });
      expect(tlsQueueRepo.ensureOperation).toHaveBeenCalledWith(
        expect.objectContaining({ source: "wildcard", sourceHostname: "*.example.com", policyGeneration: 1 }),
      );
    });

    it("an old-provider certificate is NOT proof during a pending switch — never skips", async () => {
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() + 30 * 86_400_000) };
      state.domainPolicy = { tlsProvider: "cloudflare-origin-ca", tlsCfCredentialId: "cred_1", tlsCfZoneId: "zone_1", tlsPolicyGeneration: 5 };
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued" }); // desired provider ≠ installed material
    });

    it("expired installed material does not skip", async () => {
      state.domainSsl = { sslStatus: "active", verified: true, sslExpiresAt: new Date(Date.now() - 86_400_000) };
      const { data } = await ensure();
      expect(data).toMatchObject({ outcome: "queued" });
    });

    it("rejects unknown services with NotFound", async () => {
      await expect(createDiscoveryOperations({ authorize } as never).ensureServiceTls(ctx, "srv_1", { serviceKey: "id:ghost" })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it("status exposes the ACTIVE TLS operation for a service", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    await ops.ensureServiceTls(ctx, "srv_1", { serviceKey: "id:my-app" });
    const single = await ops.getService(ctx, "srv_1", { serviceKey: "id:my-app" });
    const list = await ops.status(ctx, "srv_1");
    expect(single.data.tlsOperation).toMatchObject({ state: "waiting", source: "exact", provider: "letsencrypt", attempts: 0 });
    expect(list.data.services[0].tlsOperation?.operationId).toBe(single.data.tlsOperation?.operationId);
  });

  describe("TLS configuration APIs (plan §5)", () => {
    it("server settings: read for readers, admin-only write, unknown providers are validation errors", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      const got = await ops.getServerTlsSettings(ctx, "srv_1");
      expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "read" });
      expect(got.data).toEqual({ defaultProvider: "letsencrypt" });
      authorize.mockClear();
      const put = await ops.configureServerTls(ctx, "srv_1", { defaultProvider: "cloudflare-origin-ca" });
      expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "admin" });
      expect(put.data).toEqual({ defaultProvider: "cloudflare-origin-ca" });
      await expect(ops.configureServerTls(ctx, "srv_1", { defaultProvider: "zero_ssl" })).rejects.toBeDefined();
      await expect(ops.configureServerTls(ctx, "srv_1", { defaultProvider: "letsencrypt", extra: true })).rejects.toBeDefined();
    });

    it("per-domain GET: no domain row resolves the server default without creating anything", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      state.domains.clear(); // binding not enrolled yet
      const { data } = await ops.getServiceTls(ctx, "srv_1", { serviceKey: "id:my-app" });
      expect(data).toEqual({
        hostname: "app.example.com",
        provider: "letsencrypt",
        activeProvider: null,
        selectionSource: "default",
        state: "pending",
        cloudflare: null,
        error: null,
      });
    });

    it("per-domain GET: Cloudflare desired without credential/zone is configuration_required; LE has no cloudflare block", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      state.domainPolicy = { tlsProvider: "cloudflare-origin-ca", tlsCfCredentialId: null, tlsCfZoneId: null };
      const missing = await ops.getServiceTls(ctx, "srv_1", { serviceKey: "id:my-app" });
      expect(missing.data.state).toBe("configuration_required");
      expect(missing.data.cloudflare).toBeNull();
      state.domainPolicy = { tlsProvider: "letsencrypt" };
      const le = await ops.getServiceTls(ctx, "srv_1", { serviceKey: "id:my-app" });
      expect(le.data).toMatchObject({ provider: "letsencrypt", state: "pending", cloudflare: null });
    });

    it("per-domain GET: an installed matching provider with active material is ACTIVE", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      state.domainPolicy = { tlsProvider: "letsencrypt", tlsActiveProvider: "letsencrypt" };
      state.domains.set("app.example.com", { ...DOMAIN_ROW, sslStatus: "active" });
      const { data } = await ops.getServiceTls(ctx, "srv_1", { serviceKey: "id:my-app" });
      expect(data).toMatchObject({ provider: "letsencrypt", activeProvider: "letsencrypt", state: "active" });
    });

    it("PUT letsencrypt: persists through setTlsPolicy — no Cloudflare I/O at all", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      const { data } = await ops.setServiceTls(ctx, "srv_1", { serviceKey: "id:my-app", provider: "letsencrypt" });
      expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "admin" });
      expect(domainRepo.setTlsPolicy).toHaveBeenCalledWith(expect.objectContaining({ policy: { provider: "letsencrypt" } }));
      expect(preflight).not.toHaveBeenCalled();
      expect(data).toMatchObject({ provider: "letsencrypt", selectionSource: "explicit" });
    });

    it("PUT cloudflare: org-scoped credential lookup, provider check, decrypt, preflight, verified zone name", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      const { data } = await ops.setServiceTls(ctx, "srv_1", {
        serviceKey: "id:my-app",
        provider: "cloudflare-origin-ca",
        cloudflare: { credentialId: "cred_cf", zoneId: "zone_123", validityDays: 90 },
      });
      expect(credentialRepo.findById).toHaveBeenCalledWith("org_1", "cred_cf");
      expect(readSecrets).toHaveBeenCalledWith(expect.objectContaining({ provider: "cloudflare" }));
      expect(preflight).toHaveBeenCalledWith({ apiToken: "tok_test", zoneId: "zone_123", hostname: "app.example.com" });
      // The zone NAME comes from Cloudflare (verified), never the input — and
      // the input carries no zoneName field at all in the strict contract.
      expect(domainRepo.setTlsPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ policy: expect.objectContaining({ zoneName: "example.com", validityDays: 90 }) }),
      );
      expect(data).toMatchObject({
        provider: "cloudflare-origin-ca",
        cloudflare: { credentialId: "cred_cf", zoneId: "zone_123", zoneName: "example.com", validityDays: 90 },
      });
    });

    it("PUT cloudflare: an unknown or non-cloudflare credential is refused BEFORE preflight", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      await expect(
        ops.setServiceTls(ctx, "srv_1", {
          serviceKey: "id:my-app",
          provider: "cloudflare-origin-ca",
          cloudflare: { credentialId: "cred_ghost", zoneId: "zone_1" },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(preflight).not.toHaveBeenCalled();
      await expect(
        ops.setServiceTls(ctx, "srv_1", {
          serviceKey: "id:my-app",
          provider: "cloudflare-origin-ca",
          cloudflare: { credentialId: "cred_registry", zoneId: "zone_1" },
        }),
      ).rejects.toMatchObject({ code: "TLS_CREDENTIAL_PROVIDER_INVALID" });
      expect(preflight).not.toHaveBeenCalled();
    });

    it("P2: a failed preflight leaves the previous policy INTACT — nothing is written", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      state.domainPolicy = { tlsProvider: "letsencrypt", tlsProviderSource: "explicit", tlsPolicyOrigin: "admin", tlsPolicyGeneration: 3 };
      preflight.mockRejectedValueOnce(new AppError("not proxied", 409, "TLS_DNS_NOT_PROXIED"));
      await expect(
        ops.setServiceTls(ctx, "srv_1", {
          serviceKey: "id:my-app",
          provider: "cloudflare-origin-ca",
          cloudflare: { credentialId: "cred_cf", zoneId: "zone_123" },
        }),
      ).rejects.toMatchObject({ code: "TLS_DNS_NOT_PROXIED" });
      expect(domainRepo.setTlsPolicy).not.toHaveBeenCalled(); // working certificate + policy untouched
      const view = await ops.getServiceTls(ctx, "srv_1", { serviceKey: "id:my-app" });
      expect(view.data).toMatchObject({ provider: "letsencrypt", selectionSource: "explicit" });
    });

    it("an identical admin re-submission is a no-op — no Cloudflare I/O, no generation bump", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      state.domainPolicy = {
        tlsProvider: "cloudflare-origin-ca", tlsProviderSource: "explicit", tlsPolicyOrigin: "admin",
        tlsPolicyGeneration: 5, tlsCfCredentialId: "cred_cf", tlsCfZoneId: "zone_123", tlsValidityDays: null,
      };
      await ops.setServiceTls(ctx, "srv_1", {
        serviceKey: "id:my-app",
        provider: "cloudflare-origin-ca",
        cloudflare: { credentialId: "cred_cf", zoneId: "zone_123" },
      });
      expect(preflight).not.toHaveBeenCalled(); // no-op, not an API traffic generator
      expect(domainRepo.setTlsPolicy).not.toHaveBeenCalled();
    });

    it("a strict discriminated body: Cloudflare without its block (or LE with one) fails validation", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      await expect(
        ops.setServiceTls(ctx, "srv_1", { serviceKey: "id:my-app", provider: "cloudflare-origin-ca" }),
      ).rejects.toBeDefined();
      await expect(
        ops.setServiceTls(ctx, "srv_1", { serviceKey: "id:my-app", provider: "letsencrypt", cloudflare: { credentialId: "x", zoneId: "z" } }),
      ).rejects.toBeDefined();
      expect(domainRepo.setTlsPolicy).not.toHaveBeenCalled();
    });

    it("P2: the binding is read INSIDE the queue — a queued scan that renames the service configures the NEW hostname", async () => {
      const ops = createDiscoveryOperations({ authorize } as never);
      deferQueue = true; // the PUT task queues behind a not-yet-run scan
      const pending = ops.setServiceTls(ctx, "srv_1", { serviceKey: "id:my-app", provider: "letsencrypt" });
      await vi.waitFor(() => expect(queueTasks.length).toBe(1));
      // The queued scan REPLACES the declaration: same key, new hostname.
      state.bindings.set("id:my-app", binding({ hostname: "renamed.example.com" }));
      state.domains.set("renamed.example.com", { ...DOMAIN_ROW, hostname: "renamed.example.com", sslStatus: "none" });
      await runQueuedTasksNow();
      await pending;
      // The policy write and the RESPONSE target the CURRENT (post-scan)
      // identity — not the pre-queue snapshot.
      expect(domainRepo.ensureServerDomain).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: "renamed.example.com" }),
      );
      expect(domainRepo.setTlsPolicy).toHaveBeenCalled();
      const written = domainRepo.setTlsPolicy.mock.calls[0][0];
      const view = await ops.getServiceTls(ctx, "srv_1", { serviceKey: "id:my-app" });
      expect(view.data.hostname).toBe("renamed.example.com");
      expect(discoveryRepo.findDomainForBinding).toHaveBeenCalledWith("srv_1", "renamed.example.com");
      void written;
    });
  });
});
