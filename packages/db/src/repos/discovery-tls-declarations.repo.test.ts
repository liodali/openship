import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { ConflictError, DISCOVERY_TLS_POLICY_CONFLICT, discoveryConfigHash } from "@repo/core";
import * as schema from "../schema";
import { createDiscoveryRepo } from "./discovery.repo";
import { createDomainRepo } from "./domain.repo";
import type { Domain } from "./domain.repo";
import type { DiscoveryObservation } from "./discovery.repo";

/**
 * Discovery TLS declaration intent
 * (docs/cloudflare-origin-ca-discovery-plan.md, "Discovery TLS labels and
 * wildcard certificate sources" — declaration slice): normalized label/env
 * intent persists on the binding, versions the desired generation on its own,
 * reconciles into the per-domain policy without ever touching certificate
 * material, and conflicts with an ADMIN-owned explicit policy instead of
 * undoing it. Ownership is durable recorded provenance — never inferred from
 * the previous label value — which also makes interrupted transitions
 * crash-safe (no scan-local input to lose across a restart).
 */
const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createDiscoveryRepo(db);
const domainRepo = createDomainRepo(db);

const SERVER = "srv_tls_decl";
const ORG = "org_tls_decl";
const CRED = "cred_tls_decl";
const KEY = "id:site-one";
const HOST = "site.sub1.example.com";

/** The certificate-material columns a declaration/policy write must NEVER touch. */
function material(row: Domain) {
  return {
    sslStatus: row.sslStatus,
    sslIssuer: row.sslIssuer,
    sslExpiresAt: row.sslExpiresAt,
    sslChallenge: row.sslChallenge,
    manualSsl: row.manualSsl,
    verified: row.verified,
    status: row.status,
  };
}

function observation(overrides: Partial<DiscoveryObservation> = {}): DiscoveryObservation {
  return {
    serviceKey: KEY,
    containerId: "ctr_1",
    containerName: "site-one",
    running: true,
    hostname: HOST,
    port: 3000,
    networkName: "frontend",
    networkId: "net_1",
    ipAddress: "172.20.0.5",
    configHash: discoveryConfigHash({ hostname: HOST, port: 3000, network: "frontend" }),
    ...overrides,
  };
}

/** Enrolled domain as a post-0232 installation holds it: default letsencrypt, gen 1. */
async function seedDomain(overrides: Partial<typeof schema.domain.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.domain)
    .values({
      id: overrides.id ?? `dom_${Math.random().toString(36).slice(2)}`,
      ownerType: "server",
      serverId: SERVER,
      hostname: HOST,
      sslStatus: "active",
      sslIssuer: "letsencrypt",
      sslExpiresAt: new Date("2030-06-01"),
      verified: true,
      status: "active",
      tlsProvider: "letsencrypt",
      tlsProviderSource: "default",
      tlsPolicyGeneration: 1,
      ...overrides,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica;");
  const now = new Date();
  await db.insert(schema.servers).values({ id: SERVER, name: "tls-decl", sshHost: "127.0.0.1", organizationId: ORG });
  await db.insert(schema.credential).values({
    id: CRED, organizationId: ORG, provider: "cloudflare", name: "zone token", secretsEnc: "enc1:test", createdAt: now, updatedAt: now,
  });
});
beforeEach(async () => {
  await db.delete(schema.discoveryBinding);
  await db.delete(schema.discoverySettings);
  await db.delete(schema.domain);
});
afterAll(async () => {
  await db.delete(schema.discoveryBinding);
  await db.delete(schema.discoverySettings);
  await db.delete(schema.domain);
  await db.delete(schema.servers);
  await client.close();
});

describe("declaration persistence and generation (observe)", () => {
  it("persists normalized provider/wildcard intent; absent declarations stay null", async () => {
    const plain = await repo.observe(SERVER, observation());
    expect(plain.binding.tlsDeclaredProvider).toBeNull();
    expect(plain.binding.tlsDeclaredWildcard).toBeNull();
    expect(plain.binding.tlsPolicyConflict).toBeNull();

    const declared = await repo.observe(
      SERVER,
      observation({ containerId: "ctr_2", tlsProvider: "cloudflare-origin-ca", tlsWildcard: "*.sub1.example.com" }),
    );
    expect(declared.binding.tlsDeclaredProvider).toBe("cloudflare-origin-ca");
    expect(declared.binding.tlsDeclaredWildcard).toBe("*.sub1.example.com");
  });

  it("a TLS-only change bumps the desired generation without any routing change", async () => {
    const first = await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    await repo.markApplied(SERVER, KEY, first.binding.desiredGeneration);
    const hash = first.binding.configHash;

    // Provider change alone: same hash, same container, same IP — still desired state.
    const changed = await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca" }));
    expect(changed.desiredChanged).toBe(true);
    expect(changed.binding.desiredGeneration).toBe(first.binding.desiredGeneration + 1);
    expect(changed.binding.applyState).toBe("pending");
    expect(changed.binding.configHash).toBe(hash); // routing fingerprint untouched

    // Wildcard-only change versions the same way.
    const wildcard = await repo.observe(
      SERVER,
      observation({ tlsProvider: "cloudflare-origin-ca", tlsWildcard: "*.sub1.example.com" }),
    );
    expect(wildcard.desiredChanged).toBe(true);
    expect(wildcard.binding.desiredGeneration).toBe(changed.binding.desiredGeneration + 1);

    // An unchanged rescan touches nothing.
    const again = await repo.observe(
      SERVER,
      observation({ tlsProvider: "cloudflare-origin-ca", tlsWildcard: "*.sub1.example.com" }),
    );
    expect(again.desiredChanged).toBe(false);
    expect(again.requeued).toBe(false);
    expect(again.binding.desiredGeneration).toBe(wildcard.binding.desiredGeneration);
  });

  it("removing a declaration is itself a desired-state change (intent, not policy, reverts)", async () => {
    const first = await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca" }));
    const removed = await repo.observe(SERVER, observation());
    expect(removed.desiredChanged).toBe(true);
    expect(removed.binding.tlsDeclaredProvider).toBeNull();
    expect(removed.binding.desiredGeneration).toBe(first.binding.desiredGeneration + 1);
  });

  it("a blocked binding records the new declaration without unblocking or re-bumping", async () => {
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    await repo.block(SERVER, KEY, "hostname conflict");
    const blocked = await repo.getBinding(SERVER, KEY);
    const changed = await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca" }));
    expect(changed.binding.applyState).toBe("blocked");
    expect(changed.binding.desiredGeneration).toBe(blocked!.desiredGeneration);
    expect(changed.binding.tlsDeclaredProvider).toBe("cloudflare-origin-ca");
  });
});

describe("declaration → policy reconciliation (applyTlsDeclaration)", () => {
  it("waits for enrollment: no domain row means no policy write", async () => {
    await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    expect(outcome).toEqual({ outcome: "no-domain" });
  });

  it("a declaration becomes the explicit policy with DECLARATION provenance", async () => {
    const domain = await seedDomain();
    const before = material(domain);
    await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca", tlsWildcard: "*.sub1.example.com" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: "*.sub1.example.com" });
    expect(outcome).toEqual({ outcome: "applied", generation: 2 });
    const policy = await domainRepo.getTlsPolicy(domain.id);
    expect(policy).toMatchObject({
      tlsProvider: "cloudflare-origin-ca",
      tlsProviderSource: "explicit",
      tlsPolicyOrigin: "declaration",
      tlsPolicyGeneration: 2,
      // A declaration NEVER carries credentials or zones: admin configuration
      // is still required (configuration_required at issuance time).
      tlsCfCredentialId: null,
      tlsCfZoneId: null,
      tlsValidityDays: null,
      tlsActiveProvider: null,
    });
    expect(material((await db.query.domain.findFirst({ where: eq(schema.domain.id, domain.id) }))!)).toEqual(before);
  });

  it("agreement is idempotent — no generation bump; a confirmed default becomes declaration-owned", async () => {
    const domain = await seedDomain(); // default letsencrypt, gen 1
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect(outcome).toEqual({ outcome: "agreed" });
    const policy = await domainRepo.getTlsPolicy(domain.id);
    expect(policy?.tlsPolicyGeneration).toBe(1); // unchanged
    expect(policy?.tlsProviderSource).toBe("explicit"); // the label confirmed the choice
    expect(policy?.tlsPolicyOrigin).toBe("declaration");
    // Repeating the agreed declaration changes nothing at all.
    const again = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect(again).toEqual({ outcome: "agreed" });
    expect((await domainRepo.getTlsPolicy(domain.id))?.tlsPolicyGeneration).toBe(1);
  });

  it("agreement with an ADMIN-owned policy never transfers ownership", async () => {
    const domain = await seedDomain();
    await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" } });
    await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    expect(outcome).toEqual({ outcome: "agreed" });
    const policy = await domainRepo.getTlsPolicy(domain.id);
    expect(policy?.tlsPolicyOrigin).toBe("admin"); // agreement is not a write of ownership
    expect(policy?.tlsPolicyGeneration).toBe(2);
  });

  it("no declaration preserves the persisted policy — removing a label never reverts", async () => {
    const domain = await seedDomain();
    await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" } });
    await repo.observe(SERVER, observation()); // no TLS labels
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: null, wildcard: null });
    expect(outcome).toEqual({ outcome: "no-declaration" });
    const policy = await domainRepo.getTlsPolicy(domain.id);
    expect(policy?.tlsProvider).toBe("cloudflare-origin-ca");
    expect(policy?.tlsCfCredentialId).toBe(CRED);
    expect(policy?.tlsPolicyGeneration).toBe(2);
  });

  it("conflicts with an ADMIN-owned explicit policy: marker only, nothing else moves", async () => {
    const domain = await seedDomain();
    await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" } });
    const before = await domainRepo.getTlsPolicy(domain.id);
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect(outcome.outcome).toBe("conflict");
    if (outcome.outcome !== "conflict") throw new Error("unreachable");
    expect(outcome.reason).toContain(DISCOVERY_TLS_POLICY_CONFLICT);
    expect(outcome.reason).toContain("letsencrypt");
    expect(outcome.reason).toContain("cloudflare-origin-ca");
    // The policy, its generation and the certificate material are untouched.
    const after = await domainRepo.getTlsPolicy(domain.id);
    expect(after).toEqual(before);
    const binding = await repo.getBinding(SERVER, KEY);
    expect(binding?.tlsPolicyConflict).toContain(DISCOVERY_TLS_POLICY_CONFLICT);
    expect(binding?.applyState).not.toBe("blocked"); // a TLS conflict never blocks routing
    // Periodic rescans keep reporting the conflict without undoing the UI choice.
    const rescan = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect(rescan.outcome).toBe("conflict");
    expect((await domainRepo.getTlsPolicy(domain.id))?.tlsProvider).toBe("cloudflare-origin-ca");
  });

  it("P1: admin credential configuration under a declared provider transfers ownership — a later label change conflicts, credentials survive", async () => {
    const domain = await seedDomain();
    // The label enrols Cloudflare (declaration-owned, no credentials yet).
    await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    // The admin configures THIS domain's credential/zone under the SAME provider.
    // The provider value still matches the label — ownership must transfer anyway.
    await domainRepo.setTlsPolicy({
      domainId: domain.id,
      policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1", zoneName: "sub1.example.com", validityDays: 90 },
    });
    expect((await domainRepo.getTlsPolicy(domain.id))?.tlsPolicyOrigin).toBe("admin");
    const before = await domainRepo.getTlsPolicy(domain.id);
    // The container is recreated with a Let's Encrypt label: it must NOT replace
    // the admin-selected policy or clear its credentials.
    await repo.observe(SERVER, observation({ containerId: "ctr_2", tlsProvider: "letsencrypt" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect(outcome.outcome).toBe("conflict");
    const after = await domainRepo.getTlsPolicy(domain.id);
    expect(after).toEqual(before); // provider, credential, zone, validity, generation all intact
    expect(after?.tlsCfCredentialId).toBe(CRED);
    expect(after?.tlsCfZoneId).toBe("zone_1");
  });

  it("a declaration-owned explicit policy evolves with the declaration", async () => {
    const domain = await seedDomain();
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect((await domainRepo.getTlsPolicy(domain.id))?.tlsPolicyOrigin).toBe("declaration");
    // The explicit policy is declaration-owned → a new declaration evolves it.
    await repo.observe(SERVER, observation({ containerId: "ctr_2", tlsProvider: "cloudflare-origin-ca" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    // Agreement kept generation 1; the evolution is the first bump.
    expect(outcome).toEqual({ outcome: "applied", generation: 2 });
    const policy = await domainRepo.getTlsPolicy(domain.id);
    expect(policy?.tlsProvider).toBe("cloudflare-origin-ca");
    expect(policy?.tlsPolicyOrigin).toBe("declaration");
    // The reconciler's idempotent re-check now agrees.
    const recheck = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    expect(recheck).toEqual({ outcome: "agreed" });
  });

  it("an identical admin confirmation of a DECLARATION-owned policy takes ownership — no bump", async () => {
    const domain = await seedDomain();
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    const before = await domainRepo.getTlsPolicy(domain.id);
    expect(before?.tlsProviderSource).toBe("explicit");
    expect(before?.tlsPolicyOrigin).toBe("declaration");
    const confirmed = await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "letsencrypt" } });
    // Identical selection: the generation NEVER moves (no pending work invalidated)…
    expect(confirmed.tlsPolicyGeneration).toBe(before?.tlsPolicyGeneration);
    // …but provenance TRANSFERS to admin: the operator confirmed this choice, so
    // a later label change may not evolve or overwrite it (P2: the old early
    // return kept origin="declaration", leaving labels in control).
    expect(confirmed.tlsPolicyOrigin).toBe("admin");
    // The label can no longer evolve the operator-confirmed policy.
    await repo.observe(SERVER, observation({ containerId: "ctr_2", tlsProvider: "cloudflare-origin-ca" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    expect(outcome.outcome).toBe("conflict");
  });

  it("an identical admin re-affirmation of an ADMIN-owned policy is a pure no-op", async () => {
    const domain = await seedDomain(); // default letsencrypt
    const first = await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "letsencrypt" } });
    expect(first.tlsPolicyOrigin).toBe("admin");
    const again = await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "letsencrypt" } });
    expect(again.tlsPolicyGeneration).toBe(first.tlsPolicyGeneration);
    expect(again.updatedAt).toEqual(first.updatedAt); // nothing was written at all
  });

  it("an admin confirmation of a DEFAULT-resolved policy makes it admin-owned", async () => {
    const domain = await seedDomain(); // default letsencrypt
    const confirmed = await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "letsencrypt" } });
    expect(confirmed.tlsProviderSource).toBe("explicit");
    expect(confirmed.tlsPolicyOrigin).toBe("admin");
    expect(confirmed.tlsPolicyGeneration).toBe(1); // identical selection: no bump
    // A disagreeing declaration now conflicts instead of evolving.
    await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    expect(outcome.outcome).toBe("conflict");
  });

  it("switching to Let's Encrypt clears Cloudflare references the declaration never carried", async () => {
    const domain = await seedDomain();
    await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    // The declaration switches back while it still owns the policy (no admin
    // write happened in between).
    await repo.observe(SERVER, observation({ containerId: "ctr_2", tlsProvider: "letsencrypt" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect(outcome.outcome).toBe("applied");
    const policy = await domainRepo.getTlsPolicy(domain.id);
    expect(policy).toMatchObject({
      tlsProvider: "letsencrypt",
      tlsPolicyOrigin: "declaration",
      tlsCfCredentialId: null,
      tlsCfZoneId: null,
      tlsCfZoneName: null,
      tlsValidityDays: null,
    });
  });

  it("resolves a conflict when the declaration agrees again or is removed", async () => {
    const domain = await seedDomain();
    await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" } });
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect((await repo.getBinding(SERVER, KEY))?.tlsPolicyConflict).not.toBeNull();

    // Operator updates the label to agree with the UI policy.
    await repo.observe(SERVER, observation({ containerId: "ctr_2", tlsProvider: "cloudflare-origin-ca" }));
    const agreed = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    expect(agreed).toEqual({ outcome: "agreed" });
    expect((await repo.getBinding(SERVER, KEY))?.tlsPolicyConflict).toBeNull();
    const policy = await domainRepo.getTlsPolicy(domain.id);
    expect(policy?.tlsCfCredentialId).toBe(CRED); // agreement keeps admin config
    expect(policy?.tlsPolicyOrigin).toBe("admin"); // …and admin ownership

    // …or removes it entirely: the policy stays, the marker stays clear.
    await repo.observe(SERVER, observation({ containerId: "ctr_3" }));
    const removed = await repo.applyTlsDeclaration(SERVER, KEY, { provider: null, wildcard: null });
    expect(removed).toEqual({ outcome: "no-declaration" });
    expect((await repo.getBinding(SERVER, KEY))?.tlsPolicyConflict).toBeNull();
    expect((await domainRepo.getTlsPolicy(domain.id))?.tlsProvider).toBe("cloudflare-origin-ca");
  });

  it("the reconciler stale guard detects a UI change that moved the policy away", async () => {
    const domain = await seedDomain();
    // Declaration enrols cloudflare-origin-ca.
    await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    // Operator removes the label, then switches the policy through the UI.
    await repo.observe(SERVER, observation({ containerId: "ctr_2" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: null, wildcard: null });
    await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "letsencrypt" } });
    // The container comes back with the old declaration; the reconciler re-check
    // must see an ADMIN-owned policy, not declaration ownership.
    await repo.observe(SERVER, observation({ containerId: "ctr_3", tlsProvider: "cloudflare-origin-ca" }));
    const outcome = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    expect(outcome.outcome).toBe("conflict");
    expect((await domainRepo.getTlsPolicy(domain.id))?.tlsProvider).toBe("letsencrypt"); // UI choice stands
  });

  it("P2: a crash between observation and reconciliation resumes without a false conflict", async () => {
    const domain = await seedDomain();
    // Declaration v1 enrols letsencrypt (declaration-owned policy).
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    // The scanner commits observation v2 (cloudflare) and the process restarts
    // BEFORE policy reconciliation runs: only the binding row changed.
    await repo.observe(SERVER, observation({ containerId: "ctr_2", tlsProvider: "cloudflare-origin-ca" }));
    // No scan-local "previous declaration" survives the restart — and none is
    // needed: the reconciler pass converges on durable provenance alone.
    const resumed = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    expect(resumed).toEqual({ outcome: "applied", generation: 2 });
    expect((await domainRepo.getTlsPolicy(domain.id))?.tlsProvider).toBe("cloudflare-origin-ca");
    expect((await repo.getBinding(SERVER, KEY))?.tlsPolicyConflict).toBeNull();
    // Repeating the pass (next sweep) is a stable agreement, never a conflict.
    expect(await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null })).toEqual({ outcome: "agreed" });
  });

  it("P2: a crash against an ADMIN-owned policy resumes as a TRUE conflict, stable across passes", async () => {
    const domain = await seedDomain();
    await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" } });
    // Observation commits a disagreeing declaration; restart before reconciliation.
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    const resumed = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect(resumed.outcome).toBe("conflict");
    const again = await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect(again.outcome).toBe("conflict");
    expect((await domainRepo.getTlsPolicy(domain.id))?.tlsCfCredentialId).toBe(CRED);
  });
});

describe("explicit policy writes against declarations (setTlsPolicy gate)", () => {
  it("refuses a UI provider switch that disagrees with a persisted declaration", async () => {
    const domain = await seedDomain();
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    const before = await domainRepo.getTlsPolicy(domain.id);
    await expect(
      domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" } }),
    ).rejects.toMatchObject({ code: DISCOVERY_TLS_POLICY_CONFLICT });
    expect(await domainRepo.getTlsPolicy(domain.id)).toEqual(before); // nothing written
  });

  it("allows identical re-submissions and same-provider credential configuration", async () => {
    const domain = await seedDomain();
    await repo.observe(SERVER, observation({ tlsProvider: "cloudflare-origin-ca" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "cloudflare-origin-ca", wildcard: null });
    // Same provider as the declaration: credential/zone configuration is admin
    // business the declaration never carries — allowed, generation bumps once,
    // and ownership transfers to the admin.
    const configured = await domainRepo.setTlsPolicy({
      domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" },
    });
    expect(configured.tlsCfCredentialId).toBe(CRED);
    expect(configured.tlsPolicyOrigin).toBe("admin");
    // Identical re-submission stays a no-op even with the declaration present.
    const again = await domainRepo.setTlsPolicy({
      domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" },
    });
    expect(again.tlsPolicyGeneration).toBe(configured.tlsPolicyGeneration);
  });

  it("an agreeing declaration lets a UI switch through and clears the stale marker", async () => {
    const domain = await seedDomain();
    await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" } });
    // Conflicting declaration → marker.
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    expect((await repo.getBinding(SERVER, KEY))?.tlsPolicyConflict).not.toBeNull();
    // Credential-only configuration under the SAME provider is never gated by
    // the declaration (which requests providers, not credentials) — and the
    // unresolved provider conflict stays visible.
    const reconfigured = await domainRepo.setTlsPolicy({
      domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_2" },
    });
    expect(reconfigured.tlsCfZoneId).toBe("zone_2");
    expect((await repo.getBinding(SERVER, KEY))?.tlsPolicyConflict).not.toBeNull();
    // Switching TO the declared provider agrees with it: allowed, and the
    // stale conflict marker resolves with the committed switch.
    const switched = await domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "letsencrypt" } });
    expect(switched.tlsProvider).toBe("letsencrypt");
    expect(switched.tlsCfCredentialId).toBeNull();
    expect(switched.tlsPolicyOrigin).toBe("admin");
    expect((await repo.getBinding(SERVER, KEY))?.tlsPolicyConflict).toBeNull();
  });

  it("a UI switch works once the conflicting declaration is removed and observed", async () => {
    const domain = await seedDomain();
    await repo.observe(SERVER, observation({ tlsProvider: "letsencrypt" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: "letsencrypt", wildcard: null });
    await expect(
      domainRepo.setTlsPolicy({ domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" } }),
    ).rejects.toBeInstanceOf(ConflictError);
    // Operator removes the label; the next observation persists the removal.
    await repo.observe(SERVER, observation({ containerId: "ctr_2" }));
    await repo.applyTlsDeclaration(SERVER, KEY, { provider: null, wildcard: null });
    const switched = await domainRepo.setTlsPolicy({
      domainId: domain.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED, zoneId: "zone_1" },
    });
    expect(switched.tlsProvider).toBe("cloudflare-origin-ca");
  });
});

describe("migration backfill (0234)", () => {
  it("marks pre-existing EXPLICIT policies admin-owned; default-resolved rows stay null", async () => {
    // Rows as a pre-0234 installation holds them: provenance column NULL.
    const explicit = await seedDomain({ id: "dom_origin_explicit", tlsProviderSource: "explicit" });
    const defaulted = await seedDomain({ id: "dom_origin_default", hostname: "default-origin.example.com" });
    await db.insert(schema.project).values({ id: "proj_origin", organizationId: ORG, groupId: "grp_origin", name: "P", slug: "p-origin" });
    await db.insert(schema.domain).values({ id: "dom_origin_proj", projectId: "proj_origin", hostname: "project-origin.example.com" });

    // The 0234 backfill statement itself (kept in lockstep with the migration file).
    const migrationSql = readFileSync(
      fileURLToPath(new URL("../../drizzle/0234_discovery_tls_policy_origin.sql", import.meta.url)),
      "utf8",
    );
    await client.exec(migrationSql.slice(migrationSql.indexOf('UPDATE "domain"')));

    expect((await domainRepo.getTlsPolicy(explicit.id))?.tlsPolicyOrigin).toBe("admin");
    expect((await domainRepo.getTlsPolicy(defaulted.id))?.tlsPolicyOrigin).toBeNull();
    expect((await domainRepo.getTlsPolicy("dom_origin_proj"))?.tlsPolicyOrigin).toBeNull();
    // The backfill touched NO certificate material.
    const after = (await db.query.domain.findFirst({ where: eq(schema.domain.id, explicit.id) }))!;
    expect(material(after)).toEqual(material(explicit));
  });
});
