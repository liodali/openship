/**
 * Route-level coverage for the TLS configuration APIs (plan §5): real router
 * (auth + permission + controller + platform operation), real in-memory
 * PGlite. The Cloudflare preflight is mocked at the platform boundary — its
 * own read-only logic is covered by tls-preflight.test.ts; here we prove the
 * HTTP contract: auth strengths, persisted settings, verified zone names, and
 * FAILED PREFLIGHT PRESERVES THE WORKING POLICY.
 */
import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { db, schema, repos } from "@repo/db";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { discoveryRoutes } from "../../../src/modules/discovery/discovery.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const preflight = vi.hoisted(() => ({
  run: vi.fn(async (_input: { apiToken: string; zoneId: string; hostname: string }) => ({ zoneName: "example.com" })),
}));

vi.mock("@repo/platform/engine/modules/discovery/tls-preflight", () => ({
  preflightCloudflareOriginCa: preflight.run,
}));
// The token decryption is mocked: the seeded secretsEnc envelope is not real.
vi.mock("@repo/platform/engine/modules/credentials/credential.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/platform/engine/modules/credentials/credential.service")>();
  return { ...actual, readCredentialSecrets: () => ({ apiToken: "tok_route_test" }) };
});

const app = new Hono().onError(handleApiError).route("/api/discovery", discoveryRoutes);

let seq = 0;
const uid = (p: string) => `${p}_tls_cfg_${seq++}`;

const labs: string[] = [];

interface Lab {
  serverId: string;
  orgId: string;
  userId: string;
  hostname: string;
  token: string;
  credentialId: string;
}

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
  const credentialId = uid("cred");
  await db.insert(schema.credential).values({
    id: credentialId, organizationId: orgId, provider: "cloudflare", name: "zone token",
    secretsEnc: "enc1:not-real", createdAt: now, updatedAt: now,
  });
  await db.insert(schema.discoveryBinding).values({
    id: uid("dsb"), serverId, serviceKey: "id:my-app", hostname, port: 3000,
    configHash: "hash-1", containerRunning: true, observationStatus: "observed", applyState: "applied",
    desiredGeneration: 1, appliedGeneration: 1,
  });
  const pat = mintPatToken();
  await repos.personalAccessToken.create({
    userId, organizationId: orgId, name: "tls-cfg", tokenPrefix: pat.tokenPrefix,
    tokenHash: pat.tokenHash, readOnly: false, scoped: false, expiresAt: null,
  });
  labs.push(serverId);
  return { serverId, orgId, userId, hostname, token: pat.token, credentialId };
}

/** Merge auth headers + a JSON body in ONE headers object (json() alone would
 *  overwrite the authorization header — always go through this helper). */
function putJson(lab: Lab, url: string, body: unknown): Promise<Response> {
  return app.request(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${lab.token}`,
      "x-organization-id": lab.orgId,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const authed = (lab: Lab, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${lab.token}`, "x-organization-id": lab.orgId, ...(init.headers ?? {}) },
});
const settingsUrl = (lab: Lab) => `/api/discovery/servers/${lab.serverId}/discovery/tls`;
const serviceTlsUrl = (lab: Lab) => `/api/discovery/servers/${lab.serverId}/discovery/services/id%3Amy-app/tls`;

beforeEach(async () => {
  preflight.run.mockClear();
  preflight.run.mockResolvedValue({ zoneName: "example.com" });
  if (labs.length > 0) {
    await db.delete(schema.discoveryTlsOperation).where(inArray(schema.discoveryTlsOperation.serverId, labs));
    await db.delete(schema.discoveryBinding).where(inArray(schema.discoveryBinding.serverId, labs));
    await db.delete(schema.discoverySettings).where(inArray(schema.discoverySettings.serverId, labs));
    await db.delete(schema.domain).where(inArray(schema.domain.serverId, labs));
  }
});

describe("GET/PUT /api/discovery/servers/:id/discovery/tls", () => {
  it("defaults to letsencrypt; PUT persists and is idempotent", async () => {
    const lab = await seedLab();
    const got = await app.request(settingsUrl(lab), authed(lab));
    expect(got.status).toBe(200);
    await expect(got.json()).resolves.toEqual({ defaultProvider: "letsencrypt" });

    const put = await putJson(lab, settingsUrl(lab), { defaultProvider: "cloudflare-origin-ca" });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({ defaultProvider: "cloudflare-origin-ca" });
    const persisted = await db.query.discoverySettings.findFirst({
      where: eq(schema.discoverySettings.serverId, lab.serverId),
    });
    expect(persisted?.tlsDefaultProvider).toBe("cloudflare-origin-ca");

    // Repeat identical PUT: still 200, same value.
    const again = await putJson(lab, settingsUrl(lab), { defaultProvider: "cloudflare-origin-ca" });
    expect(again.status).toBe(200);
  });

  it("rejects an invalid provider with 400 and accepts only the two managed IDs", async () => {
    const lab = await seedLab();
    const bad = await putJson(lab, settingsUrl(lab), { defaultProvider: "zero-ssl" });
    expect(bad.status).toBe(400);
    const extra = await putJson(lab, settingsUrl(lab), { defaultProvider: "letsencrypt", zoneId: "nope" });
    expect(extra.status).toBe(400); // additionalProperties: false — no server-wide zone
  });

  it("requires server admin for PUT: a read-only credential gets 403; reads stay open", async () => {
    const lab = await seedLab();
    const pat = mintPatToken();
    await repos.personalAccessToken.create({
      userId: lab.userId, organizationId: lab.orgId, name: "ro", tokenPrefix: pat.tokenPrefix,
      tokenHash: pat.tokenHash, readOnly: true, scoped: false, expiresAt: null,
    });
    const denied = await app.request(settingsUrl(lab), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${pat.token}`,
        "x-organization-id": lab.orgId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ defaultProvider: "letsencrypt" }),
    });
    expect(denied.status).toBe(403);
    const read = await app.request(settingsUrl(lab), {
      headers: { authorization: `Bearer ${pat.token}`, "x-organization-id": lab.orgId },
    });
    expect(read.status).toBe(200);
  });

  it("conceals another organization's server (404)", async () => {
    const lab = await seedLab();
    const foreign = await seedLab();
    const response = await app.request(settingsUrl(lab), authed(foreign));
    expect(response.status).toBe(404);
  });
});

describe("GET/PUT /api/discovery/servers/:id/discovery/services/:serviceKey/tls", () => {
  it("PUT letsencrypt persists the explicit policy and the view exposes it", async () => {
    const lab = await seedLab();
    const put = await putJson(lab, serviceTlsUrl(lab), { provider: "letsencrypt" });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toMatchObject({
      hostname: lab.hostname,
      provider: "letsencrypt",
      selectionSource: "explicit",
      state: "pending",
      cloudflare: null,
    });
    // The domain row was enrolled with the explicit policy — admin provenance.
    const row = await db.query.domain.findFirst({ where: eq(schema.domain.serverId, lab.serverId) });
    expect(row).toMatchObject({ tlsProvider: "letsencrypt", tlsProviderSource: "explicit", tlsPolicyOrigin: "admin" });
  });

  it("PUT cloudflare runs preflight and records the VERIFIED zone name", async () => {
    const lab = await seedLab();
    const put = await putJson(lab, serviceTlsUrl(lab), {
      provider: "cloudflare-origin-ca",
      cloudflare: { credentialId: lab.credentialId, zoneId: "zone_route", validityDays: 90 },
    });
    expect(put.status).toBe(200);
    // Preflight ran with the decrypted token BEFORE the write.
    expect(preflight.run).toHaveBeenCalledWith({
      apiToken: "tok_route_test",
      zoneId: "zone_route",
      hostname: lab.hostname,
    });
    await expect(put.json()).resolves.toMatchObject({
      provider: "cloudflare-origin-ca",
      cloudflare: { credentialId: lab.credentialId, zoneId: "zone_route", zoneName: "example.com", validityDays: 90 },
    });
    const row = await db.query.domain.findFirst({ where: eq(schema.domain.serverId, lab.serverId) });
    expect(row).toMatchObject({
      tlsProvider: "cloudflare-origin-ca",
      tlsCfCredentialId: lab.credentialId,
      tlsCfZoneId: "zone_route",
      tlsCfZoneName: "example.com", // verified through Cloudflare, never trusted from input
      tlsValidityDays: 90,
    });
  });

  it("a FAILED preflight returns the error and PRESERVES the previous policy + certificate state", async () => {
    const lab = await seedLab();
    // Working policy: explicit letsencrypt.
    await putJson(lab, serviceTlsUrl(lab), { provider: "letsencrypt" });
    preflight.run.mockRejectedValueOnce(
      Object.assign(new (await import("@repo/core")).AppError("no proxied record", 409, "TLS_DNS_NOT_PROXIED")),
    );
    const put = await putJson(lab, serviceTlsUrl(lab), {
      provider: "cloudflare-origin-ca",
      cloudflare: { credentialId: lab.credentialId, zoneId: "zone_route" },
    });
    expect(put.status).toBe(409);
    await expect(put.json()).resolves.toMatchObject({ code: "TLS_DNS_NOT_PROXIED" });
    // NOTHING was written: the policy and material state survive unchanged.
    const row = await db.query.domain.findFirst({ where: eq(schema.domain.serverId, lab.serverId) });
    expect(row).toMatchObject({ tlsProvider: "letsencrypt", tlsProviderSource: "explicit" });
    const view = await app.request(serviceTlsUrl(lab), authed(lab));
    await expect(view.json()).resolves.toMatchObject({ provider: "letsencrypt", cloudflare: null });
    expect(preflight.run).toHaveBeenCalledTimes(1); // the failed attempt only
  });

  it("an unknown credential 404s before any Cloudflare call; a non-CF credential 400s", async () => {
    const lab = await seedLab();
    const ghost = await putJson(lab, serviceTlsUrl(lab), {
      provider: "cloudflare-origin-ca",
      cloudflare: { credentialId: "cred_ghost", zoneId: "z" },
    });
    expect(ghost.status).toBe(404);
    expect(preflight.run).not.toHaveBeenCalled();

    const now = new Date();
    const registryId = `${lab.credentialId}_reg`;
    await db.insert(schema.credential).values({
      id: registryId, organizationId: lab.orgId, provider: "docker-registry",
      name: "ghcr", secretsEnc: "enc1:x", createdAt: now, updatedAt: now,
    });
    const wrong = await putJson(lab, serviceTlsUrl(lab), {
      provider: "cloudflare-origin-ca",
      cloudflare: { credentialId: registryId, zoneId: "z" },
    });
    expect(wrong.status).toBe(400);
    expect(preflight.run).not.toHaveBeenCalled();
  });

  it("requires admin for PUT (read-only 403) and conceals foreign servers on GET", async () => {
    const lab = await seedLab();
    const pat = mintPatToken();
    await repos.personalAccessToken.create({
      userId: lab.userId, organizationId: lab.orgId, name: "ro", tokenPrefix: pat.tokenPrefix,
      tokenHash: pat.tokenHash, readOnly: true, scoped: false, expiresAt: null,
    });
    const denied = await app.request(serviceTlsUrl(lab), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${pat.token}`,
        "x-organization-id": lab.orgId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "letsencrypt" }),
    });
    expect(denied.status).toBe(403);
    const foreign = await seedLab();
    expect((await app.request(serviceTlsUrl(lab), authed(foreign))).status).toBe(404);
  });

  it("a strict discriminated body: CF without cloudflare block 400s, LE with one 400s", async () => {
    const lab = await seedLab();
    const missing = await putJson(lab, serviceTlsUrl(lab), { provider: "cloudflare-origin-ca" });
    expect(missing.status).toBe(400);
    const extra = await putJson(lab, serviceTlsUrl(lab), {
      provider: "letsencrypt",
      cloudflare: { credentialId: "x", zoneId: "z" },
    });
    expect(extra.status).toBe(400);
    expect(preflight.run).not.toHaveBeenCalled();
  });
});
