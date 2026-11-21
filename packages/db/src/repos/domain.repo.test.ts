import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { eq } from "drizzle-orm";
import { domain } from "../schema";
import { createDomainRepo } from "./domain.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) integration test for the SSL-renewal selection query.
 * FK enforcement is disabled for the session so we can seed domain rows without
 * the project/organization chain; we are testing the sslStatus/expiry filter,
 * not referential integrity.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;"); // skip FK seeding
  return { client, db, repo: createDomainRepo(db) };
}

/** now + `days` (days may be negative for an already-expired cert). */
function inDays(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

describe("domain.repo findExpiringSsl (PGlite)", () => {
  let ctx: Awaited<ReturnType<typeof freshRepo>>;
  beforeEach(async () => {
    ctx = await freshRepo();
    await ctx.db.insert(domain).values([
      // active + expiring within the cutoff — the baseline renewal case.
      { id: "d1", projectId: "p1", hostname: "active-expiring.test", sslStatus: "active", sslExpiresAt: inDays(5) },
      // errored on a prior renew + still expiring — MUST be retried, else the
      // cert silently expires (findExpiringSsl is the only auto-renewal source).
      { id: "d2", projectId: "p1", hostname: "error-expiring.test", sslStatus: "error", sslExpiresAt: inDays(5) },
      // already expired + errored — the worst case; must still be picked up.
      { id: "d3", projectId: "p1", hostname: "error-expired.test", sslStatus: "error", sslExpiresAt: inDays(-2) },
      // active but far from expiry — outside the cutoff, must be skipped.
      { id: "d4", projectId: "p1", hostname: "active-fresh.test", sslStatus: "active", sslExpiresAt: inDays(60) },
      // externally-managed TLS — never our certbot to renew.
      { id: "d5", projectId: "p1", hostname: "external-expiring.test", sslStatus: "external", sslExpiresAt: inDays(5) },
      // mid-issuance — no cert to renew yet, must stay excluded.
      { id: "d6", projectId: "p1", hostname: "provisioning-expiring.test", sslStatus: "provisioning", sslExpiresAt: inDays(5) },
      { id: "d7", projectId: "p1", hostname: "error-unissued.test", sslStatus: "error", sslExpiresAt: null },
    ]);
  }, 30_000);
  afterEach(async () => { await ctx?.client.close(); });

  it("selects active AND errored certs within the cutoff, excludes external/provisioning/fresh", async () => {
    const cutoff = inDays(14);
    const rows = await ctx.repo.findExpiringSsl(cutoff);
    const hostnames = rows.map((r) => r.hostname).sort();

    expect(hostnames).toEqual([
      "active-expiring.test",
      "error-expired.test",
      "error-expiring.test",
    ]);
  });

  it("never returns a literal wildcard as a project's openable primary URL", async () => {
    await ctx.db.insert(domain).values({ id: "wildcard", projectId: "p2", hostname: "*.example.com", isPrimary: true });
    expect(await ctx.repo.getPrimaryByProject("p2")).toBeNull();
    expect((await ctx.repo.getPrimariesByProjects(["p2"])).has("p2")).toBe(false);
    await ctx.db.insert(domain).values({ id: "concrete", projectId: "p2", hostname: "app.example.com" });
    expect((await ctx.repo.getPrimaryByProject("p2"))?.hostname).toBe("app.example.com");
    expect((await ctx.repo.getPrimariesByProjects(["p2"])).get("p2")?.hostname).toBe("app.example.com");
  });
});

describe("domain.repo commitServerDomainProvider + certificate audit cursor (PGlite)", () => {
  it("commits only under matching fences; a moved generation or provider refuses", async () => {
    const { client, db, repo } = await freshRepo();
    try {
      await db.insert(domain).values({
        id: "sd1",
        ownerType: "server",
        serverId: "srv_1",
        hostname: "switch.test",
        status: "active",
        verified: true,
        tlsProvider: "letsencrypt",
        tlsPolicyGeneration: 7,
        tlsActiveProvider: "cloudflare-origin-ca",
        tlsCertificateId: "ca_old",
        tlsCertificateFingerprint: "old:fp",
      });
      // Fence mismatch: generation moved (a newer CF activation landed).
      const fenced = await repo.commitServerDomainProvider({
        domainId: "sd1", provider: "letsencrypt",
        expectedServerId: "srv_1", expectedTlsProvider: "letsencrypt", expectedPolicyGeneration: 6,
      });
      expect(fenced).toBe(false);
      let row = await db.query.domain.findFirst({ where: eq(domain.id, "sd1") });
      expect(row?.tlsCertificateId).toBe("ca_old"); // untouched
      // Fence mismatch: provider flipped back to Cloudflare.
      expect(await repo.commitServerDomainProvider({
        domainId: "sd1", provider: "letsencrypt",
        expectedServerId: "srv_1", expectedTlsProvider: "cloudflare-origin-ca", expectedPolicyGeneration: 7,
      })).toBe(false);
      // Matching fences: the replaced certificate is RELEASED for cleanup.
      const landed = await repo.commitServerDomainProvider({
        domainId: "sd1", provider: "letsencrypt",
        expectedServerId: "srv_1", expectedTlsProvider: "letsencrypt", expectedPolicyGeneration: 7,
      });
      expect(landed).toBe(true);
      row = await db.query.domain.findFirst({ where: eq(domain.id, "sd1") });
      expect(row?.tlsActiveProvider).toBe("letsencrypt");
      expect(row?.tlsCertificateId).toBeNull();
      expect(row?.tlsCertificateFingerprint).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("the audit selection rotates fairly: id-ordered cursor, exhausted selection wraps", async () => {
    const { client, db, repo } = await freshRepo();
    try {
      await db.insert(domain).values([
        { id: "a1", ownerType: "server", serverId: "srv_a", hostname: "a1.test", status: "active", verified: true, tlsActiveProvider: "cloudflare-origin-ca", tlsCertificateId: "c1", tlsCertificateFingerprint: "f1" },
        { id: "a2", ownerType: "server", serverId: "srv_a", hostname: "a2.test", status: "active", verified: true, tlsActiveProvider: "cloudflare-origin-ca", tlsCertificateId: "c2", tlsCertificateFingerprint: "f2" },
        { id: "a3", ownerType: "server", serverId: "srv_a", hostname: "a3.test", status: "active", verified: true, tlsActiveProvider: "letsencrypt" }, // not origin-ca
      ]);
      const page1 = await repo.findOriginCaActiveDomainsForServer("srv_a", { limit: 2 });
      expect(page1.map((r) => r.id)).toEqual(["a1", "a2"]);
      const page2 = await repo.findOriginCaActiveDomainsForServer("srv_a", { afterId: page1[page1.length - 1]!.id, limit: 2 });
      expect(page2).toEqual([]); // exhausted — the sweep wraps its cursor
      const wrapped = await repo.findOriginCaActiveDomainsForServer("srv_a", { limit: 2 });
      expect(wrapped.map((r) => r.id)).toEqual(["a1", "a2"]);
    } finally {
      await client.close();
    }
  });
});
