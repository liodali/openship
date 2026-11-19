import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createDiscoveryTlsIssuanceRepo } from "./discovery-tls-issuance.repo";

/**
 * Origin CA issuance inventory persistence (plan §1/§3): the encrypted intent
 * persists BEFORE the create; one live issuance per domain; the candidate
 * state machine; activation commits domain inventory.
 */
const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createDiscoveryTlsIssuanceRepo(db);

const SERVER = "srv_issuance";
const DOMAIN = "dom_issuance";

const SEALED = "enc1:test-sealed-key";

function startInput(over: Partial<Parameters<typeof repo.startIssuance>[0]> = {}) {
  return {
    domainId: DOMAIN,
    operationId: "dtop_1",
    hostname: "site.example.com",
    zoneId: "zone_1",
    csrPem: "-----BEGIN CERTIFICATE REQUEST-----abc",
    keyEnc: SEALED,
    validityDays: 365,
    ...over,
  };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica;");
  await db.insert(schema.servers).values({ id: SERVER, name: "issuance", sshHost: "127.0.0.1", organizationId: "org_1" });
  await db.insert(schema.domain).values({
    id: DOMAIN, ownerType: "server", serverId: SERVER, hostname: "site.example.com",
    tlsProvider: "cloudflare-origin-ca", tlsProviderSource: "explicit", tlsPolicyGeneration: 2,
  });
});
beforeEach(async () => {
  await db.delete(schema.discoveryTlsIssuance);
});
afterAll(async () => {
  await db.delete(schema.discoveryTlsIssuance);
  await db.delete(schema.servers);
  await client.close();
});

describe("startIssuance (intent persistence)", () => {
  it("persists the encrypted intent with state pending_create", async () => {
    const { issuance, created } = await repo.startIssuance(startInput());
    expect(created).toBe(true);
    expect(issuance.state).toBe("pending_create");
    expect(issuance.keyEnc).toBe(SEALED); // stored exactly as sealed (never plaintext)
    expect(issuance.csr).toContain("BEGIN CERTIFICATE REQUEST");
    expect(issuance.validityDays).toBe(365);
  });

  it("is idempotent per domain: a retried start returns the SAME live row (no second key)", async () => {
    const first = await repo.startIssuance(startInput());
    const retry = await repo.startIssuance(startInput({ keyEnc: "enc1:different-key" }));
    expect(retry.created).toBe(false);
    expect(retry.issuance.id).toBe(first.issuance.id);
    expect(retry.issuance.keyEnc).toBe(SEALED); // the ORIGINAL intent wins
  });

  it("refuses an unsealed key envelope — plaintext key material never persists", async () => {
    await expect(repo.startIssuance(startInput({ keyEnc: "raw-private-key-pem" }))).rejects.toThrow(/unsealed/);
    expect(await repo.findLiveIssuance(DOMAIN)).toBeUndefined();
  });
});

describe("candidate state machine", () => {
  it("recordCandidate advances pending_create → candidate exactly once", async () => {
    const { issuance } = await repo.startIssuance(startInput());
    const candidate = await repo.recordCandidate(issuance.id, {
      certificateId: "ca_1",
      certificatePem: "-----BEGIN CERTIFICATE-----x",
      fingerprint: "aa:bb",
      expiresOn: new Date("2030-01-01"),
    });
    expect(candidate?.state).toBe("candidate");
    expect(candidate?.certificateId).toBe("ca_1");
    // A second record is refused (the transition already happened).
    expect(await repo.recordCandidate(issuance.id, {
      certificateId: "ca_2",
      certificatePem: "pem",
      fingerprint: "cc",
      expiresOn: new Date("2030-02-01"),
    })).toBeUndefined();
    const after = await repo.findIssuanceById(issuance.id);
    expect(after?.certificateId).toBe("ca_1");
  });

  it("markFailed retires the live row, freeing the dedup slot", async () => {
    const { issuance } = await repo.startIssuance(startInput());
    await repo.markFailed(issuance.id, "recovery exhausted");
    const row = await repo.findIssuanceById(issuance.id);
    expect(row?.state).toBe("failed");
    expect(row?.reason).toBe("recovery exhausted");
    // The slot is free: a new intent can start.
    const fresh = await repo.startIssuance(startInput());
    expect(fresh.created).toBe(true);
  });

  it("markSuperseded retires only a pending_create (a policy change frees the slot)", async () => {
    const { issuance } = await repo.startIssuance(startInput());
    await repo.markSuperseded(issuance.id);
    expect((await repo.findIssuanceById(issuance.id))?.state).toBe("failed");
  });

  it("findByCertificateId finds candidates by provider id", async () => {
    const { issuance } = await repo.startIssuance(startInput());
    await repo.recordCandidate(issuance.id, {
      certificateId: "ca_find_me",
      certificatePem: "pem",
      fingerprint: "ff",
      expiresOn: new Date("2030-01-01"),
    });
    expect((await repo.findByCertificateId("ca_find_me"))?.id).toBe(issuance.id);
    expect(await repo.findByCertificateId("ca_ghost")).toBeUndefined();
  });
});

describe("markActive (fenced activation commit)", () => {
  function fence(over: Record<string, unknown> = {}) {
    return {
      issuanceId: "",
      domainId: DOMAIN,
      expectedServerId: SERVER,
      expectedTlsProvider: "cloudflare-origin-ca",
      expectedPolicyGeneration: 2,
      ...over,
    };
  }

  it("commits the domain inventory (id + fingerprint + active provider + expiry + VERIFIED) and wipes pending key material", async () => {
    const { issuance } = await repo.startIssuance(startInput());
    await repo.recordCandidate(issuance.id, {
      certificateId: "ca_live",
      certificatePem: "-----BEGIN CERTIFICATE-----y",
      fingerprint: "11:22:33",
      expiresOn: new Date("2031-06-01"),
    });
    const activation = await repo.markActive(fence({ issuanceId: issuance.id }));
    expect(activation.activated).toBe(true);
    const domainRow = await db.query.domain.findFirst({ where: eq(schema.domain.id, DOMAIN) });
    expect(domainRow).toMatchObject({
      tlsCertificateId: "ca_live",
      tlsCertificateFingerprint: "11:22:33",
      tlsActiveProvider: "cloudflare-origin-ca",
      sslStatus: "active",
      sslIssuer: "cloudflare-origin-ca",
      // Verification lifecycle converges too — a newly discovered domain must
      // not stay status "pending" with no verifiedAt while serving actively.
      verified: true,
      verifiedAt: expect.any(Date),
      status: "active",
      verifyAttempts: 0,
      lastVerifyError: null,
    });
    expect(domainRow?.sslExpiresAt?.getTime()).toBe(new Date("2031-06-01").getTime());
    const activeRow = await repo.findIssuanceById(issuance.id);
    expect(activeRow?.state).toBe("active");
    // PENDING KEY MATERIAL IS GONE: the private key now lives only on the
    // server's edge; the instance keeps no sealed copy after durable success.
    expect(activeRow?.keyEnc).toBe("");
    // Activation frees the live slot.
    const fresh = await repo.startIssuance(startInput());
    expect(fresh.created).toBe(true);
  });

  it("a policy generation that moved during installation fences the commit — NOTHING writes", async () => {
    const { issuance } = await repo.startIssuance(startInput());
    await repo.recordCandidate(issuance.id, {
      certificateId: "ca_stale",
      certificatePem: "pem",
      fingerprint: "aa",
      expiresOn: new Date("2031-01-01"),
    });
    const before = await db.query.domain.findFirst({ where: eq(schema.domain.id, DOMAIN) });
    const activation = await repo.markActive(fence({ issuanceId: issuance.id, expectedPolicyGeneration: 1 }));
    expect(activation).toMatchObject({ activated: false, reason: expect.stringContaining("generation") });
    // Domain untouched — nothing NEW was written by this refused activation…
    const domainRow = await db.query.domain.findFirst({ where: eq(schema.domain.id, DOMAIN) });
    expect(domainRow?.tlsCertificateId).toBe(before?.tlsCertificateId ?? null);
    expect(domainRow?.tlsCertificateFingerprint).toBe(before?.tlsCertificateFingerprint ?? null);
    // …and the pending key is NOT wiped (the intent is retired instead).
    const row = await repo.findIssuanceById(issuance.id);
    expect(row?.state).toBe("candidate");
    expect(row?.keyEnc).not.toBe("");
  });

  it("a provider or ownership change fences the commit too", async () => {
    const { issuance } = await repo.startIssuance(startInput());
    await repo.recordCandidate(issuance.id, {
      certificateId: "ca_x",
      certificatePem: "pem",
      fingerprint: "bb",
      expiresOn: new Date("2031-01-01"),
    });
    const providerSwitch = await repo.markActive(fence({ issuanceId: issuance.id, expectedTlsProvider: "letsencrypt" }));
    expect(providerSwitch.activated).toBe(false);
    const ownershipMove = await repo.markActive(fence({ issuanceId: issuance.id, expectedServerId: "srv_other" }));
    expect(ownershipMove.activated).toBe(false);
    // …and neither refusal retired the issuance (the caller decides).
    expect((await repo.findIssuanceById(issuance.id))?.state).toBe("candidate");
  });

  it("markSuperseded retires a CANDIDATE too (a fenced refusal frees the live slot)", async () => {
    const { issuance } = await repo.startIssuance(startInput());
    await repo.recordCandidate(issuance.id, {
      certificateId: "ca_old",
      certificatePem: "pem",
      fingerprint: "cc",
      expiresOn: new Date("2031-01-01"),
    });
    await repo.markSuperseded(issuance.id);
    expect((await repo.findIssuanceById(issuance.id))?.state).toBe("failed");
    // The slot is free: the next generation issues its own material.
    const fresh = await repo.startIssuance(startInput());
    expect(fresh.created).toBe(true);
  });

  it("does nothing for a row without a candidate (crash-safe no-op)", async () => {
    // The domain may already carry inventory from an earlier test's activation;
    // the point is that THIS call changes nothing new.
    const { issuance } = await repo.startIssuance(startInput());
    const before = await db.query.domain.findFirst({ where: eq(schema.domain.id, DOMAIN) });
    await repo.markActive({ issuanceId: issuance.id, domainId: DOMAIN, expectedServerId: SERVER, expectedTlsProvider: "cloudflare-origin-ca", expectedPolicyGeneration: 2 });
    const domainRow = await db.query.domain.findFirst({ where: eq(schema.domain.id, DOMAIN) });
    expect(domainRow?.tlsCertificateId).toBe(before?.tlsCertificateId ?? null);
    expect(domainRow?.tlsCertificateFingerprint).toBe(before?.tlsCertificateFingerprint ?? null);
    expect((await repo.findIssuanceById(issuance.id))?.state).toBe("pending_create"); // untouched
  });
});
