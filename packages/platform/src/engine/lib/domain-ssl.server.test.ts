import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";

// ── Repos ────────────────────────────────────────────────────────────────────

const state = {
  domainRow: {
    id: "dom_srv",
    ownerType: "server",
    serverId: "srv_tls",
    projectId: null,
    hostname: "app.example.com",
    domainType: "custom",
    targetPort: 3000,
    status: "pending",
    verified: false,
    sslStatus: "none",
    sslChallenge: "http-01",
    sslDnsMode: "automatic",
    sslExpiresAt: null,
    externalIngress: false,
    manualSsl: false,
  } as Record<string, unknown>,
  binding: {
    serviceKey: "id:my-app",
    containerId: "ctr_1",
    observationStatus: "observed",
    containerRunning: true,
    suppressed: false,
  } as Record<string, unknown> | null,
  server: { id: "srv_tls", organizationId: "org_1", isLocal: false, workspaceId: null } as Record<string, unknown> | null,
  markedVerified: 0,
  providerCommits: 0,
  sslPatches: [] as Array<Record<string, unknown>>,
  failures: [] as string[],
  discoveryEnabled: true,
  /** When set, the under-lock findById re-read returns THIS row instead. */
  policyRow: null as Record<string, unknown> | null,
  /** Sequential binding responses; empty = current binding (see mock). */
  bindingQueue: [] as Array<Record<string, unknown> | null>,
};

const provisionCert = vi.fn(async () => ({
  domain: "app.example.com",
  verified: true,
  issuer: "letsencrypt",
  expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
}));
const verifyCert = vi.fn(async () => ({
  domain: "app.example.com",
  verified: false,
  reason: "missing" as const,
}));
const installCert = vi.fn(async () => ({
  domain: "app.example.com",
  verified: true,
  issuer: "manual",
  expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
  fingerprint: "aa:bb:cc:dd",
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      findByHostname: vi.fn(async () => state.domainRow),
      // The UNDER-LOCK policy re-read: defaults to the same row the snapshot
      // came from; race tests point it at a policy that changed while queued.
      findById: vi.fn(async () => state.policyRow ?? state.domainRow),
      markServerDomainVerified: vi.fn(async () => {
        state.markedVerified += 1;
      }),
      commitServerDomainProvider: vi.fn(async () => {
        state.providerCommits += 1;
      }),
      updateSsl: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        state.sslPatches.push(patch);
      }),
      recordSslFailure: vi.fn(async (_id: string, error: string) => {
        state.failures.push(error);
      }),
    },
    server: {
      get: vi.fn(async () => state.server),
    },
    discovery: {
      // Sequential responses for the binding reads (pre-lock dispatch gate →
      // under-lock backend check → under-lock policy check): shift the queue
      // while non-empty, else the current binding.
      getBindingForDomain: vi.fn(async () => state.bindingQueue.shift() ?? state.binding),
      getSettings: vi.fn(async () => (state.discoveryEnabled ? { enabled: true } : { enabled: false })),
    },
  },
}));

// ── Platform / lock / env isolation ─────────────────────────────────────────

const activateCert = vi.fn(async () => {});
const takeoverRenewalOwnership = vi.fn(async () => {});
const sslProvider = {
  certificateManagement: "certbot" as const,
  provisionCert,
  verifyCert,
  installCert,
  activateCert,
  takeoverRenewalOwnership,
};

vi.mock("../config/env", () => ({
  env: { CLOUD_MODE: false, DEPLOY_MODE: "desktop" },
}));

vi.mock("./provision-lock", () => ({
  createProvisionLock: vi.fn((_key: string) => ({ run: (fn: () => Promise<unknown>) => fn() })),
}));

vi.mock("./deployment-runtime", () => ({
  resolveDeploymentPlatform: vi.fn(async () => ({
    platform: { ssl: sslProvider },
    ownedPlatform: { dispose: async () => {} },
  })),
  disposePlatform: vi.fn(),
  createServerDockerRuntime: vi.fn(async () => ({
    getDiscoveryContainerView: vi.fn(async () => ({ running: true })),
    dispose: vi.fn(async () => {}),
  })),
}));

vi.mock("../modules/dns/dns-credential.service", () => ({
  resolveDnsManager: vi.fn(async () => null),
}));

const { manageDomainSsl, installDiscoveryServerCert, DiscoveryBackendUnavailableError } = await import("./domain-ssl");

beforeEach(() => {
  vi.clearAllMocks();
  state.discoveryEnabled = true;
  installCert.mockResolvedValue({
    domain: "app.example.com",
    verified: true,
    issuer: "manual",
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    fingerprint: "aa:bb:cc:dd",
  });
  activateCert.mockClear();
  takeoverRenewalOwnership.mockClear();
  provisionCert.mockClear();
  state.markedVerified = 0;
  state.providerCommits = 0;
  state.sslPatches = [];
  state.failures = [];
  state.domainRow.verified = false;
  state.domainRow.sslStatus = "none";
  delete state.domainRow.tlsProvider;
  state.policyRow = null;
  state.bindingQueue = [];
  state.binding = {
    serviceKey: "id:my-app",
    containerId: "ctr_1",
    observationStatus: "observed",
    containerRunning: true,
    suppressed: false,
  };
});

describe("server-scoped domain TLS (ownerType='server')", () => {
  it("provisions through ACME-as-verification without a project or TXT token", async () => {
    const result = await manageDomainSsl("app.example.com", {
      action: "provision",
      allowUnverified: true,
      serverId: "srv_tls",
    });
    // An ACME order opened...
    expect(provisionCert).toHaveBeenCalledWith("app.example.com", expect.objectContaining({ force: true }));
    // ...succeeded, so the row flipped verified + active WITHOUT any TXT check...
    expect(result.verified).toBe(true);
    expect(state.markedVerified).toBe(1);
    expect(state.sslPatches.some((p) => p.sslStatus === "active")).toBe(true);
    // PROVIDER-SWITCH inventory commit: the newly activated provider (ACME →
    // letsencrypt) owns the domain's TLS — stale Cloudflare Origin CA
    // inventory is cleared so the replaced certificate can be cleaned up.
    expect(state.providerCommits).toBe(1);
  });

  it("defers — never fails — when the binding is stopped, and opens no order", async () => {
    state.binding = { ...state.binding!, containerRunning: false };
    await expect(
      manageDomainSsl("app.example.com", { action: "provision", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled();
    expect(state.markedVerified).toBe(0);
    // A deferred gate is not an SSL failure: nothing recorded on the row.
    expect(state.failures).toEqual([]);
  });

  it("defers when the FRESH inspection reports the container stopped", async () => {
    const { createServerDockerRuntime } = await import("./deployment-runtime");
    vi.mocked(createServerDockerRuntime).mockImplementationOnce(async () =>
      ({
        getDiscoveryContainerView: vi.fn(async () => ({ running: false })),
        dispose: vi.fn(async () => {}),
      }) as never,
    );
    await expect(
      manageDomainSsl("app.example.com", { action: "provision", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled();
  });

  it("defers when the engine cannot be inspected (unknown state waits for inventory)", async () => {
    const { createServerDockerRuntime } = await import("./deployment-runtime");
    vi.mocked(createServerDockerRuntime).mockImplementationOnce(async () =>
      ({
        getDiscoveryContainerView: vi.fn(async () => {
          throw new Error("engine unreachable");
        }),
        dispose: vi.fn(async () => {}),
      }) as never,
    );
    await expect(
      manageDomainSsl("app.example.com", { action: "provision", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled();
  });

  it("defers when discovery is disabled on the server, even with a running container", async () => {
    state.discoveryEnabled = false;
    await expect(
      manageDomainSsl("app.example.com", { action: "provision", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled();
    expect(state.failures).toEqual([]);
  });

  it("gates the renew action too — a stopped container defers the order", async () => {
    state.binding = { ...state.binding!, containerRunning: false };
    await expect(
      manageDomainSsl("app.example.com", { action: "renew", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled();
    expect(state.failures).toEqual([]);
  });

  it("reuses a comfortably valid certificate without opening an order", async () => {
    verifyCert.mockResolvedValueOnce({
      domain: "app.example.com",
      verified: true,
      issuer: "letsencrypt",
      expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    } as never);
    const result = await manageDomainSsl("app.example.com", {
      action: "provision",
      allowUnverified: true,
      serverId: "srv_tls",
    });
    expect(result.verified).toBe(true);
    expect(provisionCert).not.toHaveBeenCalled(); // reused, no new order
  });

  it("refuses a caller that passes a projectId for a server domain", async () => {
    await expect(
      manageDomainSsl("app.example.com", {
        action: "provision",
        allowUnverified: true,
        projectId: "proj_someone",
      }),
    ).rejects.toThrow(AppError);
    expect(provisionCert).not.toHaveBeenCalled();
  });

  it("rejects a serverId scope mismatch", async () => {
    await expect(
      manageDomainSsl("app.example.com", {
        action: "provision",
        allowUnverified: true,
        serverId: "srv_other",
      }),
    ).rejects.toThrow(AppError);
    expect(provisionCert).not.toHaveBeenCalled();
  });

  // ── Interim provider/source dispatch gate (ACME-only until dispatch exists) ──

  it("defers a Cloudflare Origin CA policy — never falls back to an exact Let's Encrypt order", async () => {
    state.domainRow.tlsProvider = "cloudflare-origin-ca";
    await expect(
      manageDomainSsl("app.example.com", { action: "provision", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled();
    expect(state.markedVerified).toBe(0);
    expect(state.failures).toEqual([]); // a dispatch deferral is not an SSL failure
  });

  it("defers the renew action for a Cloudflare policy too — no ACME for the old provider's material", async () => {
    state.domainRow.tlsProvider = "cloudflare-origin-ca";
    state.domainRow.sslStatus = "active";
    await expect(
      manageDomainSsl("app.example.com", { action: "renew", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled();
    expect(state.failures).toEqual([]);
  });

  it("defers an explicit wildcard source — an exact-host certificate is never the fallback", async () => {
    state.domainRow.tlsProvider = "letsencrypt";
    state.binding = { ...state.binding!, tlsDeclaredWildcard: "*.example.com" };
    await expect(
      manageDomainSsl("app.example.com", { action: "provision", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled();
    expect(state.failures).toEqual([]);
  });

  // ── Under-lock re-read: the policy can change while an ACME job waits ──

  it("re-reads the policy INSIDE the issuance lock — a provider switch while provision waited defers", async () => {
    // The pre-lock dispatch gate sees an eligible exact Let's Encrypt policy…
    state.domainRow.tlsProvider = "letsencrypt";
    // …but the under-lock re-read finds the operator switched the domain to
    // Cloudflare Origin CA while this job queued behind the hostname/box locks.
    state.policyRow = { ...state.domainRow, tlsProvider: "cloudflare-origin-ca" };
    await expect(
      manageDomainSsl("app.example.com", { action: "provision", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled(); // no exact ACME order for the old provider
    expect(state.markedVerified).toBe(0);
    expect(state.failures).toEqual([]); // durable defer, not a certificate failure
  });

  it("re-reads the policy inside the lock for RENEW too — a switch while waiting defers the order", async () => {
    state.domainRow.tlsProvider = "letsencrypt";
    state.domainRow.sslStatus = "active";
    state.domainRow.verified = true;
    state.policyRow = { ...state.domainRow, tlsProvider: "cloudflare-origin-ca" };
    await expect(
      manageDomainSsl("app.example.com", { action: "renew", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled();
    expect(state.failures).toEqual([]);
  });

  it("a wildcard declared while the job waited defers under the lock — no exact fallback", async () => {
    state.domainRow.tlsProvider = "letsencrypt";
    // Pre-lock gate: plain binding, no wildcard. Backend check under the lock:
    // still plain. Policy check under the lock: the wildcard arrived meanwhile.
    state.bindingQueue = [
      state.binding!,
      state.binding!,
      { ...state.binding!, tlsDeclaredWildcard: "*.example.com" },
    ];
    await expect(
      manageDomainSsl("app.example.com", { action: "provision", allowUnverified: true, serverId: "srv_tls" }),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(provisionCert).not.toHaveBeenCalled();
    expect(state.failures).toEqual([]);
  });

  it("a policy that stayed Lets Encrypt issues normally — the re-read is not a blanket block", async () => {
    state.domainRow.tlsProvider = "letsencrypt";
    state.policyRow = { ...state.domainRow }; // same policy under the lock
    const result = await manageDomainSsl("app.example.com", {
      action: "provision",
      allowUnverified: true,
      serverId: "srv_tls",
    });
    expect(result.verified).toBe(true);
    expect(provisionCert).toHaveBeenCalled();
  });

  it("keeps verify exempt — read-only inspection of installed material still works", async () => {
    state.domainRow.tlsProvider = "cloudflare-origin-ca";
    await manageDomainSsl("app.example.com", { action: "verify", allowUnverified: true, serverId: "srv_tls" });
    expect(verifyCert).toHaveBeenCalledWith("app.example.com");
    expect(provisionCert).not.toHaveBeenCalled();
  });

  it("still issues for an exact Let's Encrypt policy without a wildcard source", async () => {
    state.domainRow.tlsProvider = "letsencrypt";
    const result = await manageDomainSsl("app.example.com", {
      action: "provision",
      allowUnverified: true,
      serverId: "srv_tls",
    });
    expect(result.verified).toBe(true);
    expect(provisionCert).toHaveBeenCalled();
  });

  it("installs an Origin CA candidate on the server edge; verification converges via the activation commit", async () => {
    const install = await installDiscoveryServerCert(
      "app.example.com",
      { certPem: "-----BEGIN CERTIFICATE-----", keyPem: "-----BEGIN PRIVATE KEY-----" },
      { serverId: "srv_tls", expectedFingerprint: "aa:bb:cc:dd" },
    );
    expect(install.outcome).toBe("installed");
    expect(installCert).toHaveBeenCalledWith(
      "app.example.com",
      { certPem: "-----BEGIN CERTIFICATE-----", keyPem: "-----BEGIN PRIVATE KEY-----" },
    );
    // Verification is committed WITH the active inventory (markActive) so
    // both install paths converge — the installer does not write it alone
    // (a swallowed write here could leave the domain permanently unverified).
    expect(state.markedVerified).toBe(0);
  });

  it("SKIPS installation when the staged cert matches but EXPLICITLY ACTIVATES it (files are not proof)", async () => {
    verifyCert.mockResolvedValueOnce({
      domain: "app.example.com",
      verified: true,
      issuer: "Cloudflare Origin CA",
      expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      fingerprint: "aa:bb:cc:dd",
    } as never);
    const install = await installDiscoveryServerCert(
      "app.example.com",
      { certPem: "x", keyPem: "y" },
      { serverId: "srv_tls", expectedFingerprint: "aa:bb:cc:dd" },
    );
    expect(install.outcome).toBe("recovered"); // crash between staging and reload
    expect(installCert).not.toHaveBeenCalled(); // no reinstall
    // The interrupted renewal-ownership takeover completes FIRST (mirrors
    // writeCert's stage → remove renewal record → activate): Certbot must
    // never be left able to replace the Origin CA certificate.
    expect(takeoverRenewalOwnership).toHaveBeenCalledWith("app.example.com");
    expect(takeoverRenewalOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      activateCert.mock.invocationCallOrder[0]!,
    );
    // The matching pair is EXPLICITLY activated: a staged-but-unloaded cert
    // must not be committed as active (verifyCert reads files, not the edge).
    expect(activateCert).toHaveBeenCalledWith("app.example.com");
  });

  it("a provider WITHOUT activation cannot recover — it installs fully instead", async () => {
    // Remove activateCert from the provider for this test only.
    const original = sslProvider.activateCert;
    const providerWithout = sslProvider as { activateCert?: typeof activateCert };
    delete providerWithout.activateCert;
    try {
      const install = await installDiscoveryServerCert(
        "app.example.com",
        { certPem: "-----BEGIN CERTIFICATE-----", keyPem: "-----BEGIN PRIVATE KEY-----" },
        { serverId: "srv_tls", expectedFingerprint: "aa:bb:cc:dd" },
      );
      expect(install.outcome).toBe("installed"); // full install, not a trust-files recovery
      expect(installCert).toHaveBeenCalled();
      expect(activateCert).not.toHaveBeenCalled();
    } finally {
      providerWithout.activateCert = original;
    }
  });

  it("a DIFFERENT served fingerprint does not recover — it installs", async () => {
    verifyCert.mockResolvedValueOnce({
      domain: "app.example.com",
      verified: true,
      issuer: "letsencrypt",
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      fingerprint: "ff:ee:dd:cc",
    } as never);
    const install = await installDiscoveryServerCert(
      "app.example.com",
      { certPem: "-----BEGIN CERTIFICATE-----", keyPem: "-----BEGIN PRIVATE KEY-----" },
      { serverId: "srv_tls", expectedFingerprint: "aa:bb:cc:dd" },
    );
    expect(install.outcome).toBe("installed");
    expect(installCert).toHaveBeenCalled();
  });

  it("an install failure surfaces as an error (rollback happens inside the provider)", async () => {
    installCert.mockResolvedValueOnce({ domain: "app.example.com", verified: false, issuer: "", expiresAt: "", fingerprint: "" });
    await expect(
      installDiscoveryServerCert(
        "app.example.com",
        { certPem: "x", keyPem: "y" },
        { serverId: "srv_tls", expectedFingerprint: "aa:bb:cc:dd" },
      ),
    ).rejects.toThrow(/could not be installed; the previous certificate remains/);
    expect(state.markedVerified).toBe(0);
  });

  it("refuses to install for a domain owned by ANOTHER server", async () => {
    await expect(
      installDiscoveryServerCert(
        "app.example.com",
        { certPem: "x", keyPem: "y" },
        { serverId: "srv_other", expectedFingerprint: "aa:bb:cc:dd" },
      ),
    ).rejects.toThrow();
    expect(installCert).not.toHaveBeenCalled();
  });

  it("refuses to install when the discovered backend is not running (defer, not fail)", async () => {
    state.binding = { ...state.binding!, containerRunning: false };
    await expect(
      installDiscoveryServerCert(
        "app.example.com",
        { certPem: "x", keyPem: "y" },
        { serverId: "srv_tls", expectedFingerprint: "aa:bb:cc:dd" },
      ),
    ).rejects.toThrow(DiscoveryBackendUnavailableError);
    expect(installCert).not.toHaveBeenCalled();
  });
});
