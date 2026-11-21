import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Discovery renewals route through the DURABLE TLS queue (P2 fix): the
 * ssl:renew scheduler must enqueue server-scoped domain renewals (pacing +
 * dedup + shared gates apply) instead of calling TLS execution directly.
 */
const h = vi.hoisted(() => ({
  ensureOperation: vi.fn(async (input: { initialReason?: string }) => ({
    operation: { id: "dtop_renew", state: input.initialReason ? "deferred" : "waiting", reason: input.initialReason ?? null },
    created: true,
  })),
  kick: vi.fn(),
  recordSslDeferred: vi.fn(async () => {}),
  updateSsl: vi.fn(async () => {}),
  manageDomainSsl: vi.fn(async () => ({ verified: true })),
  getTlsPolicy: vi.fn(async () => ({ tlsProvider: "letsencrypt", tlsPolicyGeneration: 4 })),
  getBindingForDomain: vi.fn(async () => ({
    serviceKey: "id:my-app",
    observationStatus: "observed",
    containerRunning: true,
    tlsDeclaredWildcard: null,
  })),
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      findExpiringSsl: vi.fn(async () => [
        {
          id: "dom_srv_renew",
          ownerType: "server",
          serverId: "srv_1",
          projectId: null,
          hostname: "app.example.com",
          sslExpiresAt: new Date(Date.now() + 5 * 86_400_000),
        },
      ]),
      findPendingServerIssuance: vi.fn(async () => []),
      recordSslDeferred: h.recordSslDeferred,
      updateSsl: h.updateSsl,
      getTlsPolicy: h.getTlsPolicy,
    },
    discovery: { getBindingForDomain: h.getBindingForDomain },
    discoveryTlsQueue: { ensureOperation: h.ensureOperation },
    server: { get: vi.fn(async () => ({ id: "srv_1", organizationId: "org_1", workspaceId: null })) },
    project: { findById: vi.fn(async () => null) },
    mailServer: { list: vi.fn(async () => []) },
  },
}));

vi.mock("@repo/platform/engine/modules/discovery/discovery-tls-queue", () => ({
  kickDiscoveryTlsQueue: h.kick,
}));
vi.mock("@repo/platform/engine/lib/domain-ssl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/platform/engine/lib/domain-ssl")>();
  return { ...actual, manageDomainSsl: h.manageDomainSsl };
});
vi.mock("@repo/platform/engine/modules/mail/mail-certificate.service", () => ({
  renewMailCertificate: vi.fn(async () => ({ renewed: false })),
}));
vi.mock("@repo/platform/engine/lib/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/platform/engine/lib/config/env")>();
  return { ...actual, env: { ...(actual as { env: object }).env, CLOUD_MODE: false } };
});
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { dispatchToOrganizationMembers: vi.fn(async () => {}) },
}));

import { renewExpiringCerts } from "@repo/platform/engine/lib/ssl-scheduler";

beforeEach(() => {
  vi.clearAllMocks();
  h.getTlsPolicy.mockResolvedValue({ tlsProvider: "letsencrypt", tlsPolicyGeneration: 4 });
  h.getBindingForDomain.mockResolvedValue({
    serviceKey: "id:my-app",
    observationStatus: "observed",
    containerRunning: true,
    tlsDeclaredWildcard: null,
  });
});

describe("ssl:renew × durable TLS queue (server domains)", () => {
  it("enqueues the renewal and rotates the entry — NO direct TLS execution", async () => {
    const result = await renewExpiringCerts();
    expect(h.ensureOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "app.example.com",
        source: "exact",
        provider: "letsencrypt",
        serverId: "srv_1",
        serviceKey: "id:my-app",
        policyGeneration: 4,
      }),
    );
    expect(h.kick).toHaveBeenCalledTimes(1);
    // Rotation: the durable operation owns the retry now, so the expiring
    // queue's head advances (recordSslDeferred, not a failure write).
    expect(h.recordSslDeferred).toHaveBeenCalledWith("dom_srv_renew", "queued for paced TLS issuance");
    expect(h.updateSsl).not.toHaveBeenCalled();
    expect(h.manageDomainSsl).not.toHaveBeenCalled();
    // ACCEPTED, not completed: "renewed" stays reserved for confirmed work.
    expect(result.details[0]).toMatchObject({ domain: "app.example.com", status: "queued" });
    expect(result).toMatchObject({ renewed: 0, queued: 1, failed: 0 });
  });

  it("P2: a stopped backend reports DEFERRED — never a false 'renewed' success", async () => {
    h.getBindingForDomain.mockResolvedValue({
      serviceKey: "id:my-app",
      observationStatus: "observed",
      containerRunning: false,
      tlsDeclaredWildcard: null,
    });
    const result = await renewExpiringCerts();
    expect(result.details[0]).toMatchObject({ domain: "app.example.com", status: "deferred" });
    expect(result.renewed).toBe(0); // no certificate work confirmed
    expect(result.queued).toBe(1); // accepted durable work
    expect(h.manageDomainSsl).not.toHaveBeenCalled();
  });

  it("a pre-existing DEFERRED operation reports deferred on re-renewal too", async () => {
    h.ensureOperation.mockResolvedValue({
      operation: { id: "dtop_renew", state: "deferred", reason: "waiting for a running backend" },
      created: false,
    });
    const result = await renewExpiringCerts();
    expect(result.details[0]).toMatchObject({ status: "deferred" });
    expect(result.renewed).toBe(0);
    expect(result.queued).toBe(1);
  });

  it("enqueues a stopped-backend renewal too — the durable operation defers it", async () => {
    h.getBindingForDomain.mockResolvedValue({
      serviceKey: "id:my-app",
      observationStatus: "observed",
      containerRunning: false,
      tlsDeclaredWildcard: null,
    });
    await renewExpiringCerts();
    expect(h.ensureOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        initialReason: expect.stringContaining("not running"),
      }),
    );
    expect(h.manageDomainSsl).not.toHaveBeenCalled();
  });

  it("carries the persisted provider/wildcard intent into the enqueued work", async () => {
    h.getTlsPolicy.mockResolvedValue({
      tlsProvider: "cloudflare-origin-ca",
      tlsCfCredentialId: "cred_1",
      tlsCfZoneId: "zone_1",
      tlsPolicyGeneration: 7,
    });
    h.getBindingForDomain.mockResolvedValue({
      serviceKey: "id:my-app",
      observationStatus: "observed",
      containerRunning: true,
      tlsDeclaredWildcard: "*.example.com",
    });
    await renewExpiringCerts();
    expect(h.ensureOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "wildcard",
        sourceHostname: "*.example.com",
        provider: "cloudflare-origin-ca",
        policyGeneration: 7,
      }),
    );
    // The worker durably defers Cloudflare/wildcard work — no ACME fallback.
    expect(h.manageDomainSsl).not.toHaveBeenCalled();
  });
});
