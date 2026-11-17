import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { ConflictError, ValidationError } from "@repo/core";
import * as schema from "../schema";
import { createDiscoveryRepo } from "./discovery.repo";
import { createDomainRepo } from "./domain.repo";
import type { Domain } from "./domain.repo";

/**
 * Managed TLS provider settings and persistence
 * (docs/cloudflare-origin-ca-discovery-plan.md §1, provider settings slice):
 * exactly two provider IDs, default Let's Encrypt, per-domain selection with
 * Cloudflare credential/zone references — and existing certificates unchanged.
 */
const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createDiscoveryRepo(db);
const domainRepo = createDomainRepo(db);

const SERVER = "srv_tls_policy";
const SERVER_B = "srv_tls_policy_b";
const ORG = "org_tls_policy";
const ORG_FOREIGN = "org_tls_foreign";
const CRED_A = "cred_tls_a";
const CRED_B = "cred_tls_b";
const CRED_FOREIGN = "cred_tls_foreign"; // belongs to ANOTHER organization
const CRED_NON_CF = "cred_tls_noncf"; // right org, wrong provider type

/** The certificate-material columns a policy write must NEVER touch. */
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

/** Seed a server-scoped domain the way a post-0232 installation holds it:
 *  enrolled (or backfilled) with resolved letsencrypt policy at generation 1. */
async function seedServerDomain(overrides: Partial<typeof schema.domain.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.domain)
    .values({
      id: overrides.id ?? `dom_${Math.random().toString(36).slice(2)}`,
      ownerType: "server",
      serverId: overrides.serverId ?? SERVER,
      hostname: overrides.hostname ?? `host-${Math.random().toString(36).slice(2)}.example.com`,
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
  await db.insert(schema.servers).values([
    { id: SERVER, name: "tls-policy", sshHost: "127.0.0.1", organizationId: ORG },
    { id: SERVER_B, name: "tls-policy-b", sshHost: "127.0.0.1", organizationId: ORG },
  ]);
  await db.insert(schema.credential).values([
    { id: CRED_A, organizationId: ORG, provider: "cloudflare", name: "zone A token", secretsEnc: "enc1:test-a", createdAt: now, updatedAt: now },
    { id: CRED_B, organizationId: ORG, provider: "cloudflare", name: "zone B token", secretsEnc: "enc1:test-b", createdAt: now, updatedAt: now },
    { id: CRED_FOREIGN, organizationId: ORG_FOREIGN, provider: "cloudflare", name: "foreign org token", secretsEnc: "enc1:test-foreign", createdAt: now, updatedAt: now },
    { id: CRED_NON_CF, organizationId: ORG, provider: "docker-registry", name: "registry login", secretsEnc: "enc1:test-noncf", createdAt: now, updatedAt: now },
  ]);
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

describe("server TLS settings", () => {
  it("defaults to Let's Encrypt — with or without a settings row", async () => {
    expect(await repo.getTlsSettings(SERVER)).toEqual({ defaultProvider: "letsencrypt" });
    await repo.configure(SERVER, { enabled: true });
    expect(await repo.getTlsSettings(SERVER)).toEqual({ defaultProvider: "letsencrypt" });
  });

  it("sets and reads back the default; unknown IDs are rejected", async () => {
    await repo.configure(SERVER, { enabled: true, workspaceId: "ws_1" });
    await repo.configureTls(SERVER, "cloudflare-origin-ca");
    expect(await repo.getTlsSettings(SERVER)).toEqual({ defaultProvider: "cloudflare-origin-ca" });
    // One column only: enablement/visibility/sweep state survive untouched.
    const settings = await repo.getSettings(SERVER);
    expect(settings?.enabled).toBe(true);
    expect(settings?.workspaceId).toBe("ws_1");
    expect(settings?.sweepIntervalSeconds).toBe(60);
    // Back to Let's Encrypt is equally valid.
    await repo.configureTls(SERVER, "letsencrypt");
    expect(await repo.getTlsSettings(SERVER)).toEqual({ defaultProvider: "letsencrypt" });
    await expect(repo.configureTls(SERVER, "zero_ssl" as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it("creates the settings row on demand without enabling discovery", async () => {
    await repo.configureTls(SERVER, "cloudflare-origin-ca");
    const settings = await repo.getSettings(SERVER);
    expect(settings?.enabled).toBe(false); // a TLS default is not a master switch
    expect(settings?.tlsDefaultProvider).toBe("cloudflare-origin-ca");
  });
});

describe("migration backfill (0232)", () => {
  it("marks existing server-scoped domains letsencrypt and leaves every other owner unmanaged", async () => {
    // Rows as a pre-migration installation would have them: policy columns NULL.
    const serverRow = await seedServerDomain({ id: "dom_backfill_srv" });
    await db
      .update(schema.domain)
      .set({ tlsProvider: null, tlsProviderSource: null, tlsPolicyGeneration: 0 })
      .where(eq(schema.domain.id, serverRow.id));
    await db.insert(schema.project).values({ id: "proj_tls", organizationId: ORG, groupId: "grp_tls", name: "P", slug: "p-tls" });
    await db.insert(schema.domain).values({
      id: "dom_backfill_proj",
      projectId: "proj_tls",
      hostname: "project.example.com",
    });

    // The 0232 backfill statement itself (kept in lockstep with the migration file).
    const migrationSql = readFileSync(
      fileURLToPath(new URL("../../drizzle/0232_discovery_tls_providers.sql", import.meta.url)),
      "utf8",
    );
    const backfill = migrationSql.slice(migrationSql.indexOf("UPDATE \"domain\""));
    await client.exec(backfill);

    const backfilled = await domainRepo.getTlsPolicy(serverRow.id);
    expect(backfilled).toMatchObject({
      ownerType: "server",
      tlsProvider: "letsencrypt",
      tlsProviderSource: "default",
      tlsActiveProvider: null, // never guessed from material — dispatch records it
      tlsPolicyGeneration: 1,
    });
    const projectPolicy = await domainRepo.getTlsPolicy("dom_backfill_proj");
    expect(projectPolicy).toMatchObject({ tlsProvider: null, tlsProviderSource: null, tlsPolicyGeneration: 0 });

    // The backfill touched NO certificate material.
    const after = (await db.query.domain.findFirst({ where: eq(schema.domain.id, serverRow.id) }))!;
    expect(material(after)).toEqual(material(serverRow));
  });
});

describe("enrollment resolves the server default exactly once (ensureServerDomain)", () => {
  it("inherits letsencrypt with no settings row, and the server default when set", async () => {
    const plain = await domainRepo.ensureServerDomain({ serverId: SERVER, hostname: "one.example.com", targetPort: 3000 });
    expect(plain.created).toBe(true);
    expect(plain.domain).toMatchObject({ tlsProvider: "letsencrypt", tlsProviderSource: "default", tlsPolicyGeneration: 1 });

    await repo.configureTls(SERVER, "cloudflare-origin-ca");
    const inherited = await domainRepo.ensureServerDomain({ serverId: SERVER, hostname: "two.example.com", targetPort: 3000 });
    expect(inherited.domain).toMatchObject({
      tlsProvider: "cloudflare-origin-ca",
      tlsProviderSource: "default",
      tlsPolicyGeneration: 1,
      tlsCfCredentialId: null, // a default grants NO credential or zone
      tlsCfZoneId: null,
    });
  });

  it("a later default change never rewrites an enrolled domain — even through re-ensure", async () => {
    const { domain: first } = await domainRepo.ensureServerDomain({ serverId: SERVER, hostname: "keep.example.com", targetPort: 3000 });
    await repo.configureTls(SERVER, "cloudflare-origin-ca");
    // Re-ensure with a changed port (the update path) still must not touch policy.
    const again = await domainRepo.ensureServerDomain({ serverId: SERVER, hostname: "keep.example.com", targetPort: 8080 });
    expect(again.created).toBe(false);
    expect(again.domain.targetPort).toBe(8080);
    expect(again.domain.tlsProvider).toBe("letsencrypt"); // retained
    expect(again.domain.tlsProviderSource).toBe("default");
    expect(again.domain.tlsPolicyGeneration).toBe(1);
    // And per-server isolation: server B's default is independent.
    const other = await domainRepo.ensureServerDomain({ serverId: SERVER_B, hostname: "b.example.com", targetPort: 3000 });
    expect(other.domain.tlsProvider).toBe("letsencrypt"); // B never configured → default
  });
});

describe("explicit per-domain policy (setTlsPolicy)", () => {
  it("stores an explicit Cloudflare selection with its credential/zone and bumps the generation", async () => {
    const row = await seedServerDomain({ id: "dom_cf", hostname: "cf.example.com" });
    const before = material(row);
    const updated = await domainRepo.setTlsPolicy({
      domainId: row.id,
      policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A, zoneId: "zone_123", zoneName: "example.com", validityDays: 90 },
    });
    expect(updated).toMatchObject({
      tlsProvider: "cloudflare-origin-ca",
      tlsProviderSource: "explicit",
      tlsActiveProvider: null, // desired ≠ installed: no switch has happened
      tlsPolicyGeneration: 2, // enrolled at 1, one explicit change
      tlsCfCredentialId: CRED_A,
      tlsCfZoneId: "zone_123",
      tlsCfZoneName: "example.com",
      tlsValidityDays: 90,
    });
    // Policy writes never touch certificate material.
    expect(material(updated)).toEqual(before);
  });

  it("two domains hold isolated credential/zone references", async () => {
    const a = await seedServerDomain({ id: "dom_cf_a", hostname: "a.example.com" });
    const b = await seedServerDomain({ id: "dom_cf_b", hostname: "b.example.com" });
    await domainRepo.setTlsPolicy({ domainId: a.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A, zoneId: "zone_a" } });
    await domainRepo.setTlsPolicy({ domainId: b.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED_B, zoneId: "zone_b", validityDays: 30 } });
    const pa = await domainRepo.getTlsPolicy(a.id);
    const pb = await domainRepo.getTlsPolicy(b.id);
    expect(pa?.tlsCfCredentialId).toBe(CRED_A);
    expect(pb?.tlsCfCredentialId).toBe(CRED_B);
    expect(pb?.tlsValidityDays).toBe(30);
    expect(pa?.tlsValidityDays).toBeNull(); // null = provider default (365), not B's 30
  });

  it("switching back to Let's Encrypt clears every Cloudflare reference", async () => {
    const row = await seedServerDomain({ id: "dom_le", hostname: "le.example.com" });
    await domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A, zoneId: "zone_123", zoneName: "example.com", validityDays: 365 } });
    const cleared = await domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "letsencrypt" } });
    expect(cleared).toMatchObject({
      tlsProvider: "letsencrypt",
      tlsCfCredentialId: null,
      tlsCfZoneId: null,
      tlsCfZoneName: null,
      tlsValidityDays: null,
    });
  });

  it("requires the credential and zone together, and Cloudflare's DISCRETE validity values", async () => {
    const row = await seedServerDomain({ id: "dom_bad", hostname: "bad.example.com" });
    await expect(
      domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "cloudflare-origin-ca", zoneId: "zone_123" } as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A } as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Any integer-looking but unsupported duration — 8 and 3650 sit INSIDE the
    // naive 7–3650 range the API still rejects; 5475 (15y) is supported.
    for (const bad of [2, 8, 3650, 5474]) {
      await expect(
        domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A, zoneId: "zone_123", validityDays: bad } }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    for (const good of [7, 30, 365, 730, 1095, 5475] as const) {
      await domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A, zoneId: "zone_123", validityDays: good } });
    }
    // Nothing above may have half-applied: the last accepted write is the row's state.
    const settled = await domainRepo.getTlsPolicy(row.id);
    expect(settled?.tlsValidityDays).toBe(5475);
    expect(settled?.tlsCfCredentialId).toBe(CRED_A);
  });

  it("enforces credential ownership: same org as the domain's server, and a Cloudflare credential", async () => {
    const row = await seedServerDomain({ id: "dom_owner", hostname: "owner.example.com" });
    // Another organization's token — exists, satisfies the FK, still refused.
    await client.exec("SET session_replication_role = DEFAULT;");
    try {
      await expect(
        domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED_FOREIGN, zoneId: "zone_123" } }),
      ).rejects.toBeInstanceOf(ConflictError);
      // Right organization, wrong credential type.
      await expect(
        domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED_NON_CF, zoneId: "zone_123" } }),
      ).rejects.toBeInstanceOf(ValidationError);
      // A well-formed unknown id is input validation, not a conflict.
      await expect(
        domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "cloudflare-origin-ca", credentialId: "cred_ghost", zoneId: "zone_123" } }),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await client.exec("SET session_replication_role = replica;");
    }
    const untouched = await domainRepo.getTlsPolicy(row.id);
    expect(untouched?.tlsProvider).toBe("letsencrypt"); // backfill default
    expect(untouched?.tlsCfCredentialId).toBeNull();
  });

  it("repeating the IDENTICAL policy is a no-op — the generation never moves", async () => {
    const row = await seedServerDomain({ id: "dom_idem", hostname: "idem.example.com" });
    const first = await domainRepo.setTlsPolicy({
      domainId: row.id,
      policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A, zoneId: "zone_123", zoneName: "example.com", validityDays: 90 },
    });
    expect(first.tlsPolicyGeneration).toBe(2); // enrolled at 1 → one change
    // Same selection re-submitted (even WITHOUT zoneName, and 90 spelled the same):
    const again = await domainRepo.setTlsPolicy({
      domainId: row.id,
      policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A, zoneId: "zone_123", validityDays: 90 },
    });
    expect(again.tlsPolicyGeneration).toBe(2); // unchanged — no pending work invalidated
    expect(again.updatedAt).toEqual(first.updatedAt); // no write happened at all
    expect(again.tlsCfZoneName).toBe("example.com"); // the verified zone name survives
    // Explicit default validity (365) and an omitted validity are the SAME policy
    // (both store null): a fresh row proves the normalization in both directions.
    const defaults = await seedServerDomain({ id: "dom_idem_dflt", hostname: "idem-dflt.example.com" });
    const omitted = await domainRepo.setTlsPolicy({
      domainId: defaults.id,
      policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A, zoneId: "zone_123" },
    });
    expect(omitted.tlsPolicyGeneration).toBe(2);
    expect(omitted.tlsValidityDays).toBeNull();
    const spelledOut = await domainRepo.setTlsPolicy({
      domainId: defaults.id,
      policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A, zoneId: "zone_123", validityDays: 365 },
    });
    expect(spelledOut.tlsPolicyGeneration).toBe(2); // 365 IS the default → identical
    // A genuinely different selection still bumps.
    const changed = await domainRepo.setTlsPolicy({
      domainId: row.id,
      policy: { provider: "cloudflare-origin-ca", credentialId: CRED_A, zoneId: "zone_456", validityDays: 365 },
    });
    expect(changed.tlsPolicyGeneration).toBe(3);
    expect(changed.tlsCfZoneName).toBeNull(); // new zone → recorded name invalidated until re-verified
    // Repeating an explicit LET'S ENCRYPT that matches the enrolled default is a no-op too.
    const le = await seedServerDomain({ id: "dom_idem_le", hostname: "idem-le.example.com" });
    const leOnce = await domainRepo.setTlsPolicy({ domainId: le.id, policy: { provider: "letsencrypt" } });
    expect(leOnce.tlsPolicyGeneration).toBe(1); // identical → no bump
    expect(leOnce.tlsProviderSource).toBe("explicit"); // but the choice is now recorded as explicit
  });

  it("refuses stale generations, non-discovery owners, and unknown domains", async () => {
    const row = await seedServerDomain({ id: "dom_race", hostname: "race.example.com" });
    await expect(
      domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "letsencrypt" }, expectedGeneration: 99 }),
    ).rejects.toBeInstanceOf(ConflictError);

    await db.insert(schema.project).values({ id: "proj_tls2", organizationId: ORG, groupId: "grp_tls2", name: "P2", slug: "p-tls2" });
    const [projDomain] = await db
      .insert(schema.domain)
      .values({ id: "dom_proj_owner", projectId: "proj_tls2", hostname: "owned.example.com" })
      .returning();
    await expect(
      domainRepo.setTlsPolicy({ domainId: projDomain!.id, policy: { provider: "letsencrypt" } }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      domainRepo.setTlsPolicy({ domainId: "dom_ghost", policy: { provider: "letsencrypt" } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("credential deletion clears the reference (set null), not the policy", async () => {
    const row = await seedServerDomain({ id: "dom_fk", hostname: "fk.example.com" });
    await domainRepo.setTlsPolicy({ domainId: row.id, policy: { provider: "cloudflare-origin-ca", credentialId: CRED_B, zoneId: "zone_b" } });
    await client.exec("SET session_replication_role = DEFAULT;");
    await db.delete(schema.credential).where(and(eq(schema.credential.id, CRED_B)));
    await client.exec("SET session_replication_role = replica;");
    const after = await domainRepo.getTlsPolicy(row.id);
    expect(after?.tlsProvider).toBe("cloudflare-origin-ca"); // desired policy survives
    expect(after?.tlsCfCredentialId).toBeNull(); // the reference is gone → configuration_required later
  });
});
