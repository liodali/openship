import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";

/** The scheduler checks instanceof against the class exported by the (mocked)
 *  domain-ssl module — which is this AppError alias. */
class DiscoveryBackendUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 409, "DISCOVERY_BACKEND_UNAVAILABLE");
  }
}

const h = vi.hoisted(() => ({
  cloud: false,
  domains: vi.fn(),
  serverIssuance: vi.fn(),
  list: vi.fn(),
  renewMail: vi.fn(),
  manage: vi.fn(),
  notify: vi.fn(),
  project: vi.fn(),
  access: vi.fn(),
  defer: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      findExpiringSsl: h.domains,
      findPendingServerIssuance: h.serverIssuance,
      findByHostname: async () => ({ id: "dom-mail" }),
      recordSslDeferred: h.defer,
    },
    mailServer: { list: h.list },
    project: { findById: h.project },
    server: { get: vi.fn(async () => null) },
    discovery: { getBindingForDomain: vi.fn(async () => null) },
  },
}));
vi.mock("@repo/platform/engine/modules/billing/management.service", () => ({
  assertManagementAccess: h.access,
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/platform/engine/lib/domain-ssl", () => ({
  MAIL_DOMAIN_OWNER: "mail",
  manageDomainSsl: h.manage,
  tlsIssuedElsewhere: () => null,
  resolveMailOwner: async () => ({ organizationId: "org-1", serverId: "srv-mail" }),
  DiscoveryBackendUnavailableError: AppError,
}));
vi.mock("@repo/platform/engine/modules/mail/mail-certificate.service", () => ({
  renewMailCertificate: h.renewMail,
}));
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { emit: h.notify },
}));
import { renewExpiringCerts } from "@repo/platform/engine/lib/ssl-scheduler";

const mail = () => ({
  serverId: "srv-mail",
  domain: "example.test",
  installedAt: new Date(),
  certificateAutoRenew: true,
  certificateHealth: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  h.cloud = false;
  h.domains.mockResolvedValue([]);
  h.serverIssuance.mockResolvedValue([]);
  h.list.mockResolvedValue([mail()]);
  h.renewMail.mockResolvedValue({});
  h.manage.mockResolvedValue({ verified: true });
  h.project.mockResolvedValue({ organizationId: "org-1", name: "Project" });
  h.access.mockResolvedValue(undefined);
  h.defer.mockResolvedValue(undefined);
});

describe("shared mail certificate scheduler", () => {
  it("fair-merges server issuance retries into the batch — a full expiring queue cannot starve them", async () => {
    const expiring = Array.from({ length: 50 }, (_, i) => ({
      id: `dom_${i}`,
      hostname: `d${i}.example.com`,
      ownerType: "project",
      projectId: "proj_1",
      sslExpiresAt: new Date(Date.now() + 86_400_000),
      sslDnsMode: "automatic",
      verified: true,
      status: "active",
      serverId: "srv-1",
    }));
    h.list.mockResolvedValue([]); // isolate the domain queues from the mail candidate
    h.domains.mockResolvedValue(expiring);
    h.serverIssuance.mockResolvedValue([
      {
        id: "dom_srv_retry",
        hostname: "svc.example.com",
        ownerType: "server",
        serverId: "srv-discovery",
        projectId: null,
        sslStatus: "error",
        sslExpiresAt: null,
        sslDnsMode: "automatic",
        verified: false,
        status: "failed",
      },
    ]);
    const result = await renewExpiringCerts();
    const manageHostnames = h.manage.mock.calls.map((c) => c[0]);
    // Appending retries after a full 50-item expiring list and truncating would
    // drop them entirely; round-robin interleaving puts them in the batch.
    expect(manageHostnames).toContain("svc.example.com");
    expect(manageHostnames.indexOf("svc.example.com")).toBeLessThan(50);
    expect(result.total).toBe(51);
  });

  it("deferred entries rotate back — 50 stopped domains cannot starve the 51st running one", async () => {
    // findExpiringSsl sorts by coalesce(lastCheckedAt, createdAt) ASC. The 50
    // stopped domains carry OLD check times; the running one was checked
    // recently — it sits AFTER them, outside a 50-item batch.
    const now = Date.now();
    const stopped = Array.from({ length: 50 }, (_, i) => ({
      id: `dom_stopped_${i}`,
      hostname: `stopped${i}.example.com`,
      ownerType: "server",
      serverId: "srv-discovery",
      projectId: null,
      sslExpiresAt: new Date(now + 86_400_000),
      sslDnsMode: "automatic",
      verified: true,
      status: "active",
      lastCheckedAt: new Date(now - 10 * 86_400_000),
    }));
    const running = {
      id: "dom_running",
      hostname: "running.example.com",
      ownerType: "server",
      serverId: "srv-discovery",
      projectId: null,
      sslExpiresAt: new Date(now + 86_400_000),
      sslDnsMode: "automatic",
      verified: true,
      status: "active",
      lastCheckedAt: new Date(now - 86_400_000),
    };
    h.list.mockResolvedValue([]);
    h.domains.mockResolvedValue([...stopped, running]);
    // Simulate the real gate: stopped backends defer (DiscoveryBackendUnavailableError),
    // the running one renews.
    h.manage.mockImplementation(async (hostname: string) => {
      if (String(hostname).startsWith("stopped")) {
        throw new DiscoveryBackendUnavailableError("backend stopped");
      }
      return { verified: true };
    });

    // Sweep 1: the batch is exactly the 50 stopped domains; the running domain
    // is NOT attempted. Each defer ADVANCES the entry (recordSslDeferred).
    await renewExpiringCerts();
    let attempted = h.manage.mock.calls.map((c) => c[0]);
    expect(attempted).toContain("stopped0.example.com");
    expect(attempted).not.toContain("running.example.com");
    expect(h.defer).toHaveBeenCalledTimes(50);

    // Simulate the repo effect of those defers: lastCheckedAt = now, which
    // moves the stopped entries BEHIND the running one in the sort order.
    const deferredIds = new Set(h.defer.mock.calls.map((c) => c[0]));
    h.domains.mockResolvedValue(
      [...stopped, running].sort(
        (a, b) =>
          (deferredIds.has(a.id) ? now : (a.lastCheckedAt as Date).getTime()) -
          (deferredIds.has(b.id) ? now : (b.lastCheckedAt as Date).getTime()),
      ),
    );

    // Sweep 2: the running domain gets service FIRST — the deferred entries
    // rotated behind it (their advanced lastCheckedAt sorts them last), and the
    // remaining slot count no longer hides it.
    h.manage.mockClear();
    await renewExpiringCerts();
    attempted = h.manage.mock.calls.map((c) => c[0]);
    expect(attempted).toContain("running.example.com");
    expect(attempted[0]).toBe("running.example.com");
  });

  it("deduplicates a server domain that appears in both queues", async () => {
    const row = {
      id: "dom_srv",
      hostname: "both.example.com",
      ownerType: "server",
      serverId: "srv-discovery",
      projectId: null,
      sslExpiresAt: new Date(Date.now() + 86_400_000),
      sslDnsMode: "automatic",
      verified: true,
      status: "active",
    };
    h.list.mockResolvedValue([]); // isolate the domain queues from the mail candidate
    h.domains.mockResolvedValue([row]);
    h.serverIssuance.mockResolvedValue([row]);
    const result = await renewExpiringCerts();
    expect(result.total).toBe(1);
    expect(h.manage.mock.calls.filter((c) => c[0] === "both.example.com")).toHaveLength(1);
  });

  it("repairs legacy mail installs without a domain row", async () => {
    expect(await renewExpiringCerts()).toMatchObject({ renewed: 1 });
    expect(h.renewMail).toHaveBeenCalledWith("srv-mail", true);
  });

  it("never renews mail twice through both its domain and install records", async () => {
    h.domains.mockResolvedValue([{ ownerType: "mail", hostname: "mail.example.test" }]);
    await renewExpiringCerts();
    expect(h.renewMail).toHaveBeenCalledTimes(1);
    expect(h.manage).not.toHaveBeenCalled();
  });

  it("respects disabled renewal even if the mail domain is expired", async () => {
    h.domains.mockResolvedValue([{ ownerType: "mail", hostname: "mail.example.test" }]);
    h.list.mockResolvedValue([{ ...mail(), certificateAutoRenew: false }]);
    expect(await renewExpiringCerts()).toMatchObject({ total: 0 });
    expect(h.renewMail).not.toHaveBeenCalled();
    expect(h.manage).not.toHaveBeenCalled();
  });

  it("notifies the mail server's organization when renewal or reload fails", async () => {
    h.renewMail.mockRejectedValueOnce(new Error("SMTP still serves an expired certificate"));
    expect(await renewExpiringCerts()).toMatchObject({ failed: 1 });
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", eventType: "ssl.renewal_failed" }),
    );
  });

  it("renews only paid customer-host certificates in cloud mode, without touching mail or provider TLS", async () => {
    h.cloud = true;
    h.domains.mockResolvedValue([
      { id: "customer", ownerType: "project", projectId: "customer", hostname: "customer.example.test" },
      { id: "provider", ownerType: "project", projectId: "provider", hostname: "provider.example.test" },
      { id: "expired", ownerType: "project", projectId: "expired", hostname: "expired.example.test" },
      { id: "local", ownerType: "project", projectId: "local", hostname: "local.example.test" },
      { id: "mail", ownerType: "mail", projectId: null, hostname: "mail.example.test" },
    ]);
    h.project.mockImplementation(async (id) => ({
      organizationId: "org-1", name: "Project",
      serverId: id === "local" ? null : `server-${id}`,
      workspaceId: id === "provider" ? "cloud-space" : null,
    }));
    h.access.mockImplementation(async (_org, serverId) => {
      if (serverId === "server-expired")
        throw new AppError("Manage expired", 402, "MANAGEMENT_PLAN_REQUIRED");
    });
    expect(await renewExpiringCerts()).toEqual({
      renewed: 1, failed: 0, total: 1,
      details: [{ domain: "customer.example.test", status: "renewed" }],
    });
    expect(h.manage).toHaveBeenCalledExactlyOnceWith("customer.example.test", {
      action: "provision", projectId: "customer",
    });
    expect(h.list).not.toHaveBeenCalled();
    expect(h.renewMail).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("does not mark certificates broken if management expires after selection", async () => {
    h.cloud = true;
    h.domains.mockResolvedValue([
      { id: "customer", projectId: "customer", hostname: "customer.example.test" },
    ]);
    h.project.mockResolvedValue({ organizationId: "org-1", serverId: "server-customer" });
    h.manage.mockRejectedValueOnce(new AppError("Manage expired", 402, "MANAGEMENT_PLAN_REQUIRED"));
    expect(await renewExpiringCerts()).toMatchObject({ renewed: 0, failed: 0, details: [] });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("leaves certificates unchanged when paid access cannot be verified", async () => {
    h.cloud = true;
    h.domains.mockResolvedValue([
      { id: "customer", projectId: "customer", hostname: "customer.example.test" },
    ]);
    h.project.mockResolvedValue({ organizationId: "org-1", serverId: "server-customer" });
    h.access.mockRejectedValueOnce(new Error("Billing provider unavailable"));
    await expect(renewExpiringCerts()).rejects.toThrow("Billing provider unavailable");
    expect(h.manage).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
});
