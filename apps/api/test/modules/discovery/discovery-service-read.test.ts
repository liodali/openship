/**
 * Route-level coverage for the single-service discovery read
 * (openship-discovery-sites-brief.md, Phase 1): real router (auth +
 * permission + controller + platform operation), real in-memory PGlite.
 *
 * Auth rides the same unscoped-PAT path as the jobs E2E harness: a seeded
 * owner + `Authorization: Bearer`. Never send an `Origin` header (bearer
 * tokens are rejected from browser-trusted origins).
 */
import "../mail/_setup-env";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { db, schema, repos } from "@repo/db";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { discoveryRoutes } from "../../../src/modules/discovery/discovery.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono().onError(handleApiError).route("/api/discovery", discoveryRoutes);

let seq = 0;
const uid = (p: string) => `${p}_svc_read_${seq++}`;

interface Lab {
  serverId: string;
  orgId: string;
  userId: string;
  hostname: string;
  token: string;
}

/** Every server this file has seeded — cleanup keys, never the whole table
 *  (the vitest PGlite instance is shared with other test files). */
const labs: string[] = [];

/** Org + owner + PAT + server, with one applied binding and its domain row.
 *  Hostnames are per-lab unique: `domain.hostname` is globally unique. */
async function seedLab(): Promise<Lab> {
  const orgId = uid("org");
  const userId = uid("user");
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId, name: "Owner", email: `${userId}@test.local`, emailVerified: true,
    role: "user", autoProvisioned: false, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.organization).values({ id: orgId, name: "Lab", slug: uid("org"), createdAt: now });
  await db.insert(schema.member).values({ id: uid("mem"), organizationId: orgId, userId, role: "owner", createdAt: now });
  const serverId = uid("srv");
  const hostname = `${serverId}.example.com`;
  await db.insert(schema.servers).values({
    id: serverId, organizationId: orgId, name: "lab", sshHost: "127.0.0.1", createdAt: now, updatedAt: now,
  });
  await db.insert(schema.discoverySettings).values({ serverId, enabled: true });
  await db.insert(schema.discoveryBinding).values({
    serverId, serviceKey: "id:my-app", hostname, port: 3000,
    configHash: "hash-1", containerRunning: true, applyState: "applied",
    desiredGeneration: 1, appliedGeneration: 1,
  });
  await db.insert(schema.domain).values({
    id: uid("dom"), ownerType: "server", serverId, hostname,
    sslStatus: "active", sslExpiresAt: new Date("2030-01-01"), sslIssuer: "letsencrypt", verified: true,
  });
  const pat = mintPatToken();
  await repos.personalAccessToken.create({
    userId, organizationId: orgId, name: "svc-read", tokenPrefix: pat.tokenPrefix,
    tokenHash: pat.tokenHash, readOnly: false, scoped: false, expiresAt: null,
  });
  labs.push(serverId);
  return { serverId, orgId, userId, hostname, token: pat.token };
}

const authed = (lab: Lab, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${lab.token}`, "x-organization-id": lab.orgId, ...(init.headers ?? {}) },
});

beforeEach(async () => {
  if (labs.length > 0) {
    await db.delete(schema.discoveryBinding).where(inArray(schema.discoveryBinding.serverId, labs));
    await db.delete(schema.discoverySettings).where(inArray(schema.discoverySettings.serverId, labs));
    await db.delete(schema.domain).where(inArray(schema.domain.serverId, labs));
  }
});

describe("GET /api/discovery/servers/:id/discovery/services/:serviceKey", () => {
  it("returns the service directly (HTTP 200) with its server-scoped TLS state", async () => {
    const lab = await seedLab();
    const response = await app.request(
      `/api/discovery/servers/${lab.serverId}/discovery/services/id%3Amy-app`,
      authed(lab),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      serviceKey: "id:my-app",
      hostname: lab.hostname,
      applyState: "applied",
      tls: {
        hostname: lab.hostname,
        verified: true,
        sslStatus: "active",
        sslExpiresAt: "2030-01-01T00:00:00.000Z",
        sslIssuer: "letsencrypt",
      },
    });
  });

  it("keeps a binding with no domain row on today's TLS defaults", async () => {
    const lab = await seedLab();
    await db.delete(schema.domain).where(eq(schema.domain.serverId, lab.serverId));
    const response = await app.request(
      `/api/discovery/servers/${lab.serverId}/discovery/services/id%3Amy-app`,
      authed(lab),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tls: { hostname: lab.hostname, verified: false, sslStatus: "none", sslExpiresAt: null, sslIssuer: null },
    });
  });

  it("routes an ENCODED compose key (embedded ':' and '/') as one segment", async () => {
    const lab = await seedLab();
    await db.insert(schema.discoveryBinding).values({
      serverId: lab.serverId, serviceKey: "compose:proj/serv", hostname: `compose.${lab.hostname}`,
      port: 8080, configHash: "hash-2",
    });
    const response = await app.request(
      `/api/discovery/servers/${lab.serverId}/discovery/services/compose%3Aproj%2Fserv`,
      authed(lab),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ serviceKey: "compose:proj/serv", port: 8080 });
  });

  it("answers an unknown key with the standard not-found envelope (404)", async () => {
    const lab = await seedLab();
    const response = await app.request(
      `/api/discovery/servers/${lab.serverId}/discovery/services/id%3Aghost`,
      authed(lab),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String), code: "NOT_FOUND" });
  });

  it("conceals another organization's server (404, not 403)", async () => {
    const lab = await seedLab();
    const foreign = await seedLab(); // different org, different server
    const response = await app.request(
      `/api/discovery/servers/${lab.serverId}/discovery/services/id%3Amy-app`,
      authed(foreign),
    );
    expect(response.status).toBe(404);
  });

  it("requires authentication (401 without a credential)", async () => {
    const lab = await seedLab();
    const response = await app.request(
      `/api/discovery/servers/${lab.serverId}/discovery/services/id%3Amy-app`,
    );
    expect(response.status).toBe(401);
  });

  it("serves a READ-ONLY credential the single read, but refuses mutations", async () => {
    const lab = await seedLab();
    const pat = mintPatToken();
    await repos.personalAccessToken.create({
      userId: lab.userId, organizationId: lab.orgId, name: "ro", tokenPrefix: pat.tokenPrefix,
      tokenHash: pat.tokenHash, readOnly: true, scoped: false, expiresAt: null,
    });
    const readOnly = authed({ ...lab, token: pat.token });
    const response = await app.request(
      `/api/discovery/servers/${lab.serverId}/discovery/services/id%3Amy-app`,
      readOnly,
    );
    expect(response.status).toBe(200);
    const forget = await app.request(
      `/api/discovery/servers/${lab.serverId}/discovery/services/id%3Amy-app`,
      { method: "DELETE", ...readOnly },
    );
    expect(forget.status).toBe(403);
  });
});
