/**
 * Route-level coverage for the idempotent TLS ensure endpoint (plan:
 * "Asynchronous queue, ensure API"): real router (auth + permission +
 * controller), real in-memory PGlite with the durable operation table.
 * Outcome/status mapping: skipped → 200; queued/already_queued/deferred → 202.
 */
import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { db, schema, repos } from "@repo/db";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { discoveryRoutes } from "../../../src/modules/discovery/discovery.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono().onError(handleApiError).route("/api/discovery", discoveryRoutes);

/** The skip contract PROVES installed material through a read-only Edge
 *  verify — and route activation through the managed-vhost probe; the fake
 *  lab server has no real Edge, so both are mocked at the platform boundary
 *  (a failing verify must fall through to a durable queue — covered by the
 *  platform ops tests). */
const vhostProbe = vi.hoisted(() => vi.fn(async () => ({ status: "expected" as const })));
vi.mock("@repo/platform/engine/lib/domain-ssl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/platform/engine/lib/domain-ssl")>();
  return {
    ...actual,
    manageDomainSsl: vi.fn(async (hostname: string, opts: { action: string }) =>
      opts.action === "verify"
        ? // Skip path: prove healthy installed material.
          {
            domain: hostname,
            verified: true,
            issuer: "letsencrypt",
            expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
          }
        : // Provision path: unusable result → the worker defers the durable
          // operation (still ACTIVE — retries hit the same operation id).
          { domain: hostname, verified: false, detail: "lab edge cannot issue" },
    ),
    probeServerDomainVhostCert: vhostProbe,
  };
});

let seq = 0;
const uid = (p: string) => `${p}_tls_ensure_${seq++}`;

const labs: string[] = [];

interface Lab {
  serverId: string;
  orgId: string;
  userId: string;
  token: string;
  bindingId: string;
  domainId: string;
}

/** Org + owner + PAT + server + applied binding + enrolled domain row. */
async function seedLab(
  over: Partial<{
    sslStatus: string;
    verified: boolean;
    sslExpiresAt: Date | null;
    tlsProvider: string;
    tlsCfCredentialId: string | null;
    tlsCfZoneId: string | null;
  }> = {},
): Promise<Lab> {
  const orgId = uid("org");
  const userId = uid("user");
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name: "Owner",
    email: `${userId}@test.local`,
    emailVerified: true,
    role: "user",
    autoProvisioned: false,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(schema.organization)
    .values({ id: orgId, name: "Lab", slug: uid("org"), createdAt: now });
  await db
    .insert(schema.member)
    .values({ id: uid("mem"), organizationId: orgId, userId, role: "owner", createdAt: now });
  const serverId = uid("srv");
  const hostname = `${serverId}.example.com`;
  await db.insert(schema.servers).values({
    id: serverId,
    organizationId: orgId,
    name: "lab",
    sshHost: "127.0.0.1",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.discoverySettings).values({ serverId, enabled: true });
  await db.insert(schema.discoveryBinding).values({
    id: uid("dsb"),
    serverId,
    serviceKey: "id:my-app",
    hostname,
    port: 3000,
    configHash: "hash-1",
    containerRunning: true,
    observationStatus: "observed",
    applyState: "applied",
    desiredGeneration: 1,
    appliedGeneration: 1,
  });
  const domainId = uid("dom");
  await db.insert(schema.domain).values({
    id: domainId,
    ownerType: "server",
    serverId,
    hostname,
    sslStatus: over.sslStatus ?? "none",
    verified: over.verified ?? false,
    sslExpiresAt: over.sslExpiresAt ?? null,
    tlsProvider: over.tlsProvider ?? "letsencrypt",
    tlsProviderSource: "default",
    tlsPolicyGeneration: 1,
    tlsCfCredentialId: over.tlsCfCredentialId ?? null,
    tlsCfZoneId: over.tlsCfZoneId ?? null,
  });
  const pat = mintPatToken();
  await repos.personalAccessToken.create({
    userId,
    organizationId: orgId,
    name: "ensure",
    tokenPrefix: pat.tokenPrefix,
    tokenHash: pat.tokenHash,
    readOnly: false,
    scoped: false,
    expiresAt: null,
  });
  labs.push(serverId);
  return { serverId, orgId, userId, token: pat.token, bindingId: hostname, domainId };
}

const authed = (lab: Lab, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    authorization: `Bearer ${lab.token}`,
    "x-organization-id": lab.orgId,
    ...(init.headers ?? {}),
  },
});

const url = (lab: Lab) =>
  `/api/discovery/servers/${lab.serverId}/discovery/services/id%3Amy-app/tls/ensure`;

beforeEach(async () => {
  if (labs.length > 0) {
    await db
      .delete(schema.discoveryTlsOperation)
      .where(inArray(schema.discoveryTlsOperation.serverId, labs));
    await db.delete(schema.discoveryBinding).where(inArray(schema.discoveryBinding.serverId, labs));
    await db
      .delete(schema.discoverySettings)
      .where(inArray(schema.discoverySettings.serverId, labs));
    await db.delete(schema.domain).where(inArray(schema.domain.serverId, labs));
  }
  // The managed vhost's configured selection defaults to the steady state;
  // the drift case overrides per test.
  vhostProbe.mockReset();
  vhostProbe.mockResolvedValue({ status: "expected" });
});

describe("POST /api/discovery/servers/:id/discovery/services/:serviceKey/tls/ensure", () => {
  it("queues durable work (202) and returns the SAME operation id on retry", async () => {
    const lab = await seedLab();
    const first = await app.request(url(lab), { method: "POST", ...authed(lab) });
    expect(first.status).toBe(202);
    const body = await first.json();
    expect(body).toMatchObject({ outcome: "queued", hostname: `${lab.serverId}.example.com` });
    expect(typeof body.operationId).toBe("string");

    // The kicked drain settles the operation into its durable DEFERRED state
    // (the mocked lab edge cannot issue) — still ACTIVE, still the same row.
    await vi.waitFor(async () => {
      const [row] = await db.select().from(schema.discoveryTlsOperation);
      expect(row?.state).toBe("deferred");
    });

    const retry = await app.request(url(lab), { method: "POST", ...authed(lab) });
    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toMatchObject({
      outcome: "deferred",
      operationId: body.operationId,
    });

    // Exactly ONE durable operation row exists — a client retry never doubles.
    const rows = await db.select().from(schema.discoveryTlsOperation);
    expect(rows.filter((row) => row.serverId === lab.serverId)).toHaveLength(1);
  });

  it("skips (200) when valid material for the desired provider is installed", async () => {
    const lab = await seedLab({
      sslStatus: "active",
      verified: true,
      sslExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    const response = await app.request(url(lab), { method: "POST", ...authed(lab) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "skipped",
      reason: "already_valid",
      source: "exact",
    });
    expect(await db.select().from(schema.discoveryTlsOperation)).toHaveLength(0);
  });

  it("queues (202) instead when healthy material's managed vhost is DRIFTED — the skip needs route proof", async () => {
    // Healthy files alone are not already_valid: a vhost still selecting its
    // bootstrap pair (or an outdated source) must queue the activation repair.
    const lab = await seedLab({
      sslStatus: "active",
      verified: true,
      sslExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    vhostProbe.mockResolvedValueOnce({
      status: "drifted",
      certPath: "/etc/letsencrypt/openship-bootstrap/x/fullchain.pem",
    });
    const response = await app.request(url(lab), { method: "POST", ...authed(lab) });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ outcome: "queued" });
    // One durable operation row — the retry/progress handle.
    const rows = await db.select().from(schema.discoveryTlsOperation);
    expect(rows.filter((row) => row.serverId === lab.serverId)).toHaveLength(1);
  });

  it("defers (202) with a durable operation when the backend is stopped", async () => {
    const lab = await seedLab();
    await db
      .update(schema.discoveryBinding)
      .set({ containerRunning: false })
      .where(inArray(schema.discoveryBinding.serverId, [lab.serverId]));
    const response = await app.request(url(lab), { method: "POST", ...authed(lab) });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ outcome: "deferred" });
    expect(body.reason).toContain("not running");
    const [op] = await db.select().from(schema.discoveryTlsOperation);
    expect(op?.state).toBe("deferred");
  });

  it("refuses an unconfigured Cloudflare policy with a 409 conflict and creates nothing", async () => {
    const lab = await seedLab({ tlsProvider: "cloudflare-origin-ca" });
    const response = await app.request(url(lab), { method: "POST", ...authed(lab) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "TLS_CONFIGURATION_REQUIRED" });
    expect(await db.select().from(schema.discoveryTlsOperation)).toHaveLength(0);
  });

  it("rejects a non-empty body (400) — identity is the service key, not a submitted hostname", async () => {
    const lab = await seedLab();
    const response = await app.request(url(lab), {
      method: "POST",
      ...authed(lab, {
        body: JSON.stringify({ hostname: "evil.example.com" }),
        headers: { "content-type": "application/json" },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("requires write access: read-only credential gets 403, unknown keys 404", async () => {
    const lab = await seedLab();
    const pat = mintPatToken();
    await repos.personalAccessToken.create({
      userId: lab.userId,
      organizationId: lab.orgId,
      name: "ro",
      tokenPrefix: pat.tokenPrefix,
      tokenHash: pat.tokenHash,
      readOnly: true,
      scoped: false,
      expiresAt: null,
    });
    const denied = await app.request(url(lab), {
      method: "POST",
      headers: { authorization: `Bearer ${pat.token}`, "x-organization-id": lab.orgId },
    });
    expect(denied.status).toBe(403);

    const missing = await app.request(
      `/api/discovery/servers/${lab.serverId}/discovery/services/id%3Aghost/tls/ensure`,
      { method: "POST", ...authed(lab) },
    );
    expect(missing.status).toBe(404);
  });
});
