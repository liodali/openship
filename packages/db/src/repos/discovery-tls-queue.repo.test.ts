import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createDiscoveryTlsQueueRepo } from "./discovery-tls-queue.repo";

/**
 * Durable TLS operation queue persistence
 * (docs/cloudflare-origin-ca-discovery-plan.md, "Asynchronous queue"): the
 * ROWS are the queue — dedup by active identity, lease-based claiming with
 * restart recovery, supersede on policy change, bounded history.
 */
const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createDiscoveryTlsQueueRepo(db);

const SERVER = "srv_tls_queue";
const DOMAIN = "dom_tls_queue";

function input(over: Partial<Parameters<typeof repo.ensureOperation>[0]> = {}) {
  return {
    hostname: "app.example.com",
    sourceHostname: "app.example.com",
    source: "exact" as const,
    provider: "letsencrypt" as const,
    domainId: DOMAIN,
    serverId: SERVER,
    organizationId: "org_1",
    serviceKey: "id:my-app",
    policyGeneration: 3,
    ...over,
  };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica;");
  await db.insert(schema.servers).values({ id: SERVER, name: "tls-queue", sshHost: "127.0.0.1", organizationId: "org_1" });
  await db.insert(schema.domain).values({
    id: DOMAIN, ownerType: "server", serverId: SERVER, hostname: "app.example.com",
    tlsProvider: "letsencrypt", tlsProviderSource: "default", tlsPolicyGeneration: 3,
  });
});
beforeEach(async () => {
  await db.delete(schema.discoveryTlsOperation);
});
afterAll(async () => {
  await db.delete(schema.discoveryTlsOperation);
  await db.delete(schema.servers);
  await client.close();
});

describe("ensureOperation dedup", () => {
  it("a retried ensure returns the SAME operation — never a second job", async () => {
    const first = await repo.ensureOperation(input());
    expect(first.created).toBe(true);
    const retry = await repo.ensureOperation(input());
    expect(retry.created).toBe(false);
    expect(retry.operation.id).toBe(first.operation.id);
    expect((await repo.listActiveOperationsByServer(SERVER)).size).toBe(1);
  });

  it("dedups by certificate SOURCE identity — a wildcard source is distinct from exact", async () => {
    await repo.ensureOperation(input());
    const wildcard = await repo.ensureOperation(
      input({ source: "wildcard", sourceHostname: "*.example.com" }),
    );
    expect(wildcard.created).toBe(true);
    // Both stay active under their own source identity (the status join keys
    // by hostname, so both attach to the same service — one row each).
    expect((await repo.findActiveOperation(SERVER, "app.example.com", 3))?.source).toBe("exact");
    expect((await repo.findActiveOperation(SERVER, "*.example.com", 3))?.source).toBe("wildcard");
    expect((await repo.findActiveOperationForHostname(SERVER, "app.example.com"))?.source).toBe("exact");
  });

  it("a policy generation bump frees the slot for new work", async () => {
    await repo.ensureOperation(input());
    const next = await repo.ensureOperation(input({ policyGeneration: 4 }));
    expect(next.created).toBe(true);
    expect(next.operation.id).not.toBe((await repo.findActiveOperation(SERVER, "app.example.com", 3))!.id);
  });

  it("completion frees the dedup slot for future renewal work", async () => {
    const { operation } = await repo.ensureOperation(input());
    await repo.completeOperation(operation.id, "issued");
    const again = await repo.ensureOperation(input());
    expect(again.created).toBe(true); // renewals are new operations
    expect((await repo.findActiveOperationForHostname(SERVER, "app.example.com"))?.id).toBe(again.operation.id);
  });

  it("seeds a deferred state directly (stopped backend at ensure time)", async () => {
    const { operation } = await repo.ensureOperation(
      input({ initialReason: "backend not running; certificate work waits." }),
    );
    expect(operation.state).toBe("deferred");
    expect(operation.reason).toContain("not running");
  });
});

describe("claiming with leases", () => {
  it("claims due waiting rows, bumps attempts, holds a lease", async () => {
    const { operation } = await repo.ensureOperation(input());
    const now = new Date("2026-01-01T00:00:00Z");
    const claimed = await repo.claimDueOperations({ now, limit: 5, leasedBy: "w1", leaseUntil: new Date(now.getTime() + 300_000) });
    expect(claimed.map((row) => row.id)).toEqual([operation.id]);
    expect(claimed[0].state).toBe("running");
    expect(claimed[0].attempts).toBe(1);
    expect(claimed[0].leasedBy).toBe("w1");
    // A second claim while the lease holds gets nothing.
    expect(await repo.claimDueOperations({ now: new Date(now.getTime() + 1000), limit: 5, leasedBy: "w2", leaseUntil: new Date(now.getTime() + 301_000) })).toEqual([]);
  });

  it("respects backoff: a deferred row past its next_attempt_at claims, a future one does not", async () => {
    const { operation } = await repo.ensureOperation(input());
    // A deferral only happens to a RUNNING row (a worker examined it) — claim first.
    const start = new Date("2026-01-01T00:00:00Z");
    await repo.claimDueOperations({ now: start, limit: 5, leasedBy: "w1", leaseUntil: new Date(start.getTime() + 300_000) });
    await repo.deferOperation(operation.id, "backend stopped", new Date("2026-01-01T00:10:00Z"));
    const before = new Date("2026-01-01T00:05:00Z");
    expect(await repo.claimDueOperations({ now: before, limit: 5, leasedBy: "w1", leaseUntil: new Date(before.getTime() + 300_000) })).toEqual([]);
    const after = new Date("2026-01-01T00:10:01Z");
    const claimed = await repo.claimDueOperations({ now: after, limit: 5, leasedBy: "w1", leaseUntil: new Date(after.getTime() + 300_000) });
    expect(claimed.map((row) => row.id)).toEqual([operation.id]);
  });

  it("restart recovery: an abandoned RUNNING row (expired lease) is reclaimable", async () => {
    const { operation } = await repo.ensureOperation(input());
    const start = new Date("2026-01-01T00:00:00Z");
    await repo.claimDueOperations({ now: start, limit: 5, leasedBy: "dead-worker", leaseUntil: new Date(start.getTime() + 300_000) });
    // The worker died; its lease lapses while a later drain runs.
    const later = new Date(start.getTime() + 600_000);
    const reclaimed = await repo.claimDueOperations({ now: later, limit: 5, leasedBy: "new-worker", leaseUntil: new Date(later.getTime() + 300_000) });
    expect(reclaimed.map((row) => row.id)).toEqual([operation.id]);
    expect(reclaimed[0].attempts).toBe(2); // the abandoned attempt counts
    expect(reclaimed[0].leasedBy).toBe("new-worker");
  });

  it("claims fairly in creation order and respects the limit", async () => {
    for (const hostname of ["a.example.com", "b.example.com", "c.example.com"]) {
      await repo.ensureOperation(input({ hostname, sourceHostname: hostname }));
    }
    const now = new Date();
    const claimed = await repo.claimDueOperations({ now, limit: 2, leasedBy: "w1", leaseUntil: new Date(now.getTime() + 300_000) });
    expect(claimed.map((row) => row.hostname)).toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("supersede and prune", () => {
  it("supersedes active operations whose policy generation fell behind", async () => {
    await db.update(schema.domain).set({ tlsPolicyGeneration: 7 }).where(eq(schema.domain.id, DOMAIN));
    const { operation } = await repo.ensureOperation(input({ policyGeneration: 3 }));
    const count = await repo.supersedeStaleOperations({ serverId: SERVER, hostname: "app.example.com", currentGeneration: 7 });
    expect(count).toBe(1);
    const after = await repo.findActiveOperationForHostname(SERVER, "app.example.com");
    expect(after?.id).not.toBe(operation.id); // no longer active
    const row = (await db.query.discoveryTlsOperation.findFirst({ where: eq(schema.discoveryTlsOperation.id, operation.id) }))!;
    expect(row.state).toBe("complete");
    expect(row.outcome).toBe("superseded");
  });

  it("prunes only completed operations past the retention window", async () => {
    const fresh = await repo.ensureOperation(input({ hostname: "keep.example.com", sourceHostname: "keep.example.com" }));
    await repo.completeOperation(fresh.operation.id, "issued", new Date("2026-01-02T00:00:00Z"));
    await db.update(schema.discoveryTlsOperation)
      .set({ updatedAt: new Date("2025-12-01T00:00:00Z") })
      .where(eq(schema.discoveryTlsOperation.id, fresh.operation.id));
    const waiting = await repo.ensureOperation(input({ hostname: "wait.example.com", sourceHostname: "wait.example.com" }));
    expect(waiting.created).toBe(true);
    const removed = await repo.pruneCompleted(new Date("2026-01-01T00:00:00Z"));
    expect(removed).toBe(1); // the stale completed row only
    expect(await repo.findActiveOperationForHostname(SERVER, "wait.example.com")).toBeDefined();
    expect(await repo.currentPolicyGeneration(SERVER, "app.example.com")).toBe(7);
  });
});
