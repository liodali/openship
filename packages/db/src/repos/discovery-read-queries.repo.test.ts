import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createDiscoveryRepo } from "./discovery.repo";

/**
 * Query-count proofs for the two discovery READ paths (single service and
 * server status). Both run the REAL repository code against real PGlite and
 * count actual SQL statements: every statement drizzle issues — select,
 * relational query, insert — funnels through `client.query`, so a proxy over
 * the client counts round trips exactly. (Neither read path uses
 * transactions, which would need BEGIN/COMMIT accounting too.)
 *
 * The acceptance behind these tests (openship-discovery-sites-brief.md,
 * Phase 1): a single read is constant-query-count, the list read costs the
 * same for 1 binding and for 500, and there is no per-binding domain read.
 */
const SERVER = "srv_discovery_read_queries";
const OTHER_SERVER = "srv_discovery_read_other";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });

let statements = 0;
const countingClient = new Proxy(client, {
  get(target, prop) {
    if (prop === "query") {
      return (...args: Parameters<typeof target.query>) => {
        statements += 1;
        return target.query(...args);
      };
    }
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
});
const repo = createDiscoveryRepo(drizzle(countingClient as unknown as PGlite, { schema }));

/** Bulk-seed N bindings (bulk insert — the count assertions measure the READ
 *  paths only, so seeding happens on the plain, uncounted drizzle instance). */
async function seedBindings(count: number): Promise<void> {
  const bindings = Array.from({ length: count }, (_, i) => ({
    serverId: SERVER,
    serviceKey: `id:site-${i}`,
    hostname: `site-${i}.example.com`,
    port: 3000,
    configHash: `hash-${i}`,
    containerRunning: true,
    applyState: "applied" as const,
  }));
  const domains = bindings.map((b, i) => ({
    id: `dom_read_${i}`,
    ownerType: "server" as const,
    serverId: SERVER,
    hostname: b.hostname,
    sslStatus: "active",
    sslExpiresAt: new Date("2030-01-01"),
  }));
  await db.insert(schema.discoveryBinding).values(bindings);
  await db.insert(schema.domain).values(domains);
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica;");
  await db.insert(schema.servers).values([
    { id: SERVER, name: "read-queries", sshHost: "127.0.0.1", organizationId: "org_1" },
    { id: OTHER_SERVER, name: "read-queries-other", sshHost: "127.0.0.1", organizationId: "org_2" },
  ]);
  await db.insert(schema.discoverySettings).values({ serverId: SERVER, enabled: true });
});
beforeEach(async () => {
  await db.delete(schema.discoveryBinding);
  await db.delete(schema.domain);
  statements = 0;
});
afterAll(async () => {
  await db.delete(schema.discoveryBinding);
  await db.delete(schema.discoverySettings);
  await db.delete(schema.servers);
  await client.close();
});

describe("single-service read (getBinding + findDomainForBinding)", () => {
  it("costs exactly TWO statements — whether the server has 1 binding or 500", async () => {
    await seedBindings(500);
    const binding = await repo.getBinding(SERVER, "id:site-499");
    const domain = await repo.findDomainForBinding(SERVER, binding!.hostname);
    expect(statements).toBe(2);
    expect(domain?.hostname).toBe("site-499.example.com");

    await db.delete(schema.discoveryBinding);
    await db.delete(schema.domain);
    await seedBindings(1);
    statements = 0;
    const only = await repo.getBinding(SERVER, "id:site-0");
    await repo.findDomainForBinding(SERVER, only!.hostname);
    expect(statements).toBe(2);
  });
});

describe("status/list read (getSettings + listByServer + findDomainsForBindings)", () => {
  it("costs the SAME three statements for 1 binding and for 500 — no N+1 domain reads", async () => {
    await seedBindings(500);
    await readStatusPath();
    const fiveHundred = statements;
    expect(fiveHundred).toBe(3);

    await db.delete(schema.discoveryBinding);
    await db.delete(schema.domain);
    await seedBindings(1);
    statements = 0;
    const one = await readStatusPath();
    expect(statements).toBe(fiveHundred);
    expect(one.bindings).toHaveLength(1);
  });

  it("skips the domain query entirely for an empty server (no invalid empty IN clause)", async () => {
    const status = await readStatusPath();
    expect(status.bindings).toHaveLength(0);
    expect(status.domains.size).toBe(0);
    expect(statements).toBe(2); // settings + bindings only
  });

  async function readStatusPath() {
    const settings = await repo.getSettings(SERVER);
    const bindings = await repo.listByServer(SERVER);
    const domains = await repo.findDomainsForBindings(SERVER, bindings.map((b) => b.hostname));
    return { settings, bindings, domains };
  }
});

describe("findDomainsForBindings scoping", () => {
  it("returns only THIS server's rows, keyed by normalized hostname; absent rows stay absent", async () => {
    await seedBindings(2);
    // A same-hostname row for another server is impossible (hostname is
    // globally unique), but the OTHER server's own domain must never surface
    // through this server's lookup — and vice versa.
    await db.insert(schema.domain).values({
      id: "dom_read_foreign",
      ownerType: "server",
      serverId: OTHER_SERVER,
      hostname: "foreign.example.com",
    });

    const mine = await repo.findDomainsForBindings(SERVER, [
      "site-0.example.com",
      "site-1.EXAMPLE.com", // normalized like the single-row helper
      "foreign.example.com",
      "unknown.example.com",
      "site-0.example.com", // duplicates collapse
    ]);
    expect([...mine.keys()].sort()).toEqual(["site-0.example.com", "site-1.example.com"]);
    expect(mine.get("site-1.example.com")?.hostname).toBe("site-1.example.com");

    const foreign = await repo.findDomainsForBindings(OTHER_SERVER, ["foreign.example.com"]);
    expect(foreign.get("foreign.example.com")?.id).toBe("dom_read_foreign");

    // The other server's settings/bindings are invisible here regardless.
    expect((await repo.listByServer(OTHER_SERVER)).length).toBe(0);
    expect(await repo.getBinding(OTHER_SERVER, "id:site-0")).toBeUndefined();
  });

  it("returns an empty map WITHOUT querying for empty input", async () => {
    const out = await repo.findDomainsForBindings(SERVER, []);
    expect(out.size).toBe(0);
    expect(statements).toBe(0);
  });
});

// Keep the FK-enabled sanity check honest even under replica mode (mirrors
// discovery.repo.test.ts): the seeded server row must exist for these reads.
it("seeds a real server row (bindings join a live server)", async () => {
  expect(await db.query.servers.findFirst({ where: eq(schema.servers.id, SERVER) })).toBeTruthy();
});
