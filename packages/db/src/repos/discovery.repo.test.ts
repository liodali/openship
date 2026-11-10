import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createDiscoveryRepo } from "./discovery.repo";
import { createDomainRepo } from "./domain.repo";
import { discoveryConfigHash } from "@repo/core";
import type { DiscoveryObservation } from "./discovery.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createDiscoveryRepo(db);
const domainRepo = createDomainRepo(db);

const SERVER = "srv_discovery_test";

function observation(overrides: Partial<DiscoveryObservation> = {}): DiscoveryObservation {
  return {
    serviceKey: "id:my-app",
    containerId: "ctr_1",
    containerName: "my-app",
    hostname: "app.example.com",
    port: 3000,
    networkName: "frontend",
    networkId: "net_1",
    ipAddress: "172.20.0.5",
    configHash: discoveryConfigHash({ hostname: "app.example.com", port: 3000, network: "frontend" }),
    composeProject: "shop",
    composeService: "web",
    ...overrides,
  };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica;");
  await db.insert(schema.servers).values({ id: SERVER, name: "discovery-test", sshHost: "127.0.0.1", organizationId: "org_1" });
});
beforeEach(async () => {
  await db.delete(schema.discoveryBinding);
  await db.delete(schema.discoverySettings);
  await db.delete(schema.domain);
});
afterAll(async () => {
  await db.delete(schema.discoveryBinding);
  await db.delete(schema.servers);
  await client.close();
});

describe("discovery settings", () => {
  it("has no row until configured; discovery starts off", async () => {
    expect(await repo.getSettings(SERVER)).toBeUndefined();
    const row = await repo.configure(SERVER, { enabled: false });
    expect(row.enabled).toBe(false);
    expect(row.sweepIntervalSeconds).toBe(60);
    expect(row.workspaceId).toBeNull();
  });

  it("configures enable, workspace binding and sweep interval idempotently", async () => {
    await repo.configure(SERVER, { enabled: true, workspaceId: "ws_1", sweepIntervalSeconds: 60 });
    const updated = await repo.configure(SERVER, { sweepIntervalSeconds: 120 });
    expect(updated.enabled).toBe(true);
    expect(updated.workspaceId).toBe("ws_1");
    expect(updated.sweepIntervalSeconds).toBe(120);
    expect((await repo.listEnabledServerIds()).map((r) => r.serverId)).toEqual([SERVER]);
  });

  it("records scan outcomes without inventing errors", async () => {
    await repo.configure(SERVER, { enabled: true });
    await repo.recordScan(SERVER, { ok: true });
    const ok = await repo.getSettings(SERVER);
    expect(ok?.lastScanError).toBeNull();
    expect(ok?.lastScanAt).toBeInstanceOf(Date);
    await repo.recordScan(SERVER, { ok: false, error: "daemon unreachable" });
    const failed = await repo.getSettings(SERVER);
    expect(failed?.lastScanError).toBe("daemon unreachable");
  });

  it("clears a workspace binding without touching other settings", async () => {
    await repo.configure(SERVER, { enabled: true, workspaceId: "ws_1", sweepIntervalSeconds: 90 });
    await repo.unbindWorkspace(SERVER);
    const row = await repo.getSettings(SERVER);
    expect(row?.workspaceId).toBeNull();
    expect(row?.enabled).toBe(true);
    expect(row?.sweepIntervalSeconds).toBe(90);
  });
});

describe("binding observations", () => {
  it("creates a pending binding on first sight with generation 1", async () => {
    const { binding: row, desiredChanged } = await repo.observe(SERVER, observation());
    expect(desiredChanged).toBe(true);
    expect(row.applyState).toBe("pending");
    expect(row.desiredGeneration).toBe(1);
    expect(row.appliedGeneration).toBe(0);
    expect(row.observationStatus).toBe("observed");
    expect(row.ipAddress).toBe("172.20.0.5");
    expect(row.composeProject).toBe("shop");
  });

  it("is idempotent: an unchanged rescan changes nothing", async () => {
    await repo.observe(SERVER, observation());
    const { desiredChanged } = await repo.observe(SERVER, observation({ ipAddress: "172.20.0.5" }));
    expect(desiredChanged).toBe(false);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.desiredGeneration).toBe(1);
  });

  it("tracks container replacement without a config change", async () => {
    await repo.observe(SERVER, observation());
    const { desiredChanged } = await repo.observe(
      SERVER,
      observation({ containerId: "ctr_2", containerName: "my-app-2", ipAddress: "172.20.0.9" }),
    );
    expect(desiredChanged).toBe(false);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.containerId).toBe("ctr_2");
    expect(row?.ipAddress).toBe("172.20.0.9");
    expect(row?.desiredGeneration).toBe(1);
  });

  it("marks pending and resets retries when the operator changes config", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("applied");

    const { desiredChanged } = await repo.observe(
      SERVER,
      observation({
        hostname: "other.example.com",
        configHash: discoveryConfigHash({ hostname: "other.example.com", port: 3000, network: "frontend" }),
      }),
    );
    expect(desiredChanged).toBe(true);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.hostname).toBe("other.example.com");
    expect(row?.desiredGeneration).toBe(2);
    expect(row?.applyState).toBe("pending");
    expect(row?.applyAttempts).toBe(0);
    expect(row?.applyError).toBeNull();
  });

  it("never invents a second binding for one identity", async () => {
    await repo.observe(SERVER, observation());
    await repo.observe(SERVER, observation({ containerId: "ctr_2" }));
    const rows = await repo.listByServer(SERVER);
    expect(rows).toHaveLength(1);
  });

  it("keeps everything on observation error and only confirmed removals go missing", async () => {
    await repo.observe(SERVER, observation());
    await repo.markObservationError(SERVER, "id:my-app");
    let row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.observationStatus).toBe("error");
    expect(row?.containerId).toBe("ctr_1");
    expect(row?.configHash).toBeTruthy();

    await repo.markMissing(SERVER, "id:my-app");
    row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.observationStatus).toBe("missing");
    expect(row?.containerId).toBeNull();
    expect(row?.hostname).toBe("app.example.com"); // desired state retained
    expect(row?.configHash).toBeTruthy();
  });
});

describe("apply scheduling", () => {
  it("picks up due bindings and excludes suppressed ones", async () => {
    await repo.observe(SERVER, observation());
    await repo.observe(SERVER, observation({ serviceKey: "id:other", hostname: "b.example.com" }));
    await repo.suppress(SERVER, "id:other");
    const due = await repo.dueForApply(SERVER);
    expect(due.map((r) => r.serviceKey)).toEqual(["id:my-app"]);
    await repo.unsuppress(SERVER, "id:other");
    expect((await repo.dueForApply(SERVER)).length).toBe(2);
  });

  it("honors persisted backoff", async () => {
    await repo.observe(SERVER, observation());
    const retryAt = new Date(Date.now() + 60_000);
    await repo.markApplyError(SERVER, "id:my-app", "edge unreachable", retryAt);
    expect((await repo.dueForApply(SERVER)).length).toBe(0);
    const afterBackoff = new Date(retryAt.getTime() + 1000);
    expect((await repo.dueForApply(SERVER, afterBackoff)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("error");
    expect(row?.applyAttempts).toBe(1);
    expect(row?.applyError).toBe("edge unreachable");
  });

  it("rejects a stale applied generation but accepts the current one", async () => {
    await repo.observe(SERVER, observation());
    await repo.observe(SERVER, observation({ port: 3001, configHash: "changed" }));
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.desiredGeneration).toBe(2);

    const stale = await repo.markApplied(SERVER, "id:my-app", 1);
    expect(stale).toBeUndefined(); // desired moved on; this apply is obsolete
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("pending");

    await repo.markApplied(SERVER, "id:my-app", 2);
    const applied = await repo.getBinding(SERVER, "id:my-app");
    expect(applied?.applyState).toBe("applied");
    expect(applied?.appliedGeneration).toBe(2);
    expect(await repo.dueForApply(SERVER)).toHaveLength(0);
  });
});

describe("forget and domain retention", () => {
  it("deletes the binding but retains the server-owned domain row", async () => {
    await db.insert(schema.domain).values({
      id: "dom_srv",
      ownerType: "server",
      serverId: SERVER,
      hostname: "app.example.com",
      sslStatus: "active",
      verified: true,
    });
    await repo.observe(SERVER, observation());
    await repo.forget(SERVER, "id:my-app");
    expect(await repo.getBinding(SERVER, "id:my-app")).toBeUndefined();
    const retained = await repo.findDomainForBinding(SERVER, "app.example.com");
    expect(retained?.id).toBe("dom_srv");
    expect(retained?.sslStatus).toBe("active");
    expect(retained?.projectId).toBeNull();
  });

  it("joins the binding's domain server-scoped, never another owner's", async () => {
    // Another (project) domain on the same hostname globally is impossible —
    // hostname is unique — so the join can only find the server-scoped row.
    await db.insert(schema.domain).values({
      id: "dom_srv2",
      ownerType: "server",
      serverId: SERVER,
      hostname: "x.example.com",
    });
    expect((await repo.findDomainForBinding(SERVER, "X.example.com"))?.id).toBe("dom_srv2");
    expect(await repo.findDomainForBinding(SERVER, "missing.example.com")).toBeUndefined();
  });

  it("cascades: server-scoped domain rows die with the server", async () => {
    const cascadeServer = "srv_cascade_probe";
    await db.insert(schema.servers).values({ id: cascadeServer, name: "cascade", sshHost: "127.0.0.1" });
    await db.insert(schema.domain).values({
      id: "dom_cascade",
      ownerType: "server",
      serverId: cascadeServer,
      hostname: "cascade.example.com",
    });
    // Replica mode disables FK triggers (see beforeAll); enforce them only
    // around the delete so the cascade itself is what's under test.
    await client.exec("SET session_replication_role = DEFAULT;");
    await db.delete(schema.servers).where(eq(schema.servers.id, cascadeServer));
    await client.exec("SET session_replication_role = replica;");
    expect(await repo.findDomainForBinding(cascadeServer, "cascade.example.com")).toBeUndefined();
  });
});

/** Seed a server-scoped domain + its binding, and the matching discovery settings. */
async function seedServerDomain(overrides: {
  enabled?: boolean;
  suppressed?: boolean;
  observationStatus?: "observed" | "missing" | "error";
  organizationId?: string | null;
} = {}) {
  const { enabled = true, suppressed = false, observationStatus = "observed", organizationId } = overrides;
  if (organizationId !== undefined) {
    await db.update(schema.servers).set({ organizationId }).where(eq(schema.servers.id, SERVER));
  }
  await repo.configure(SERVER, { enabled });
  await repo.observe(SERVER, observation());
  if (suppressed) await repo.suppress(SERVER, "id:my-app");
  if (observationStatus !== "observed") {
    await db
      .update(schema.discoveryBinding)
      .set({ observationStatus })
      .where(eq(schema.discoveryBinding.serverId, SERVER));
  }
  await db.insert(schema.domain).values({
    id: "dom_server_scope",
    ownerType: "server",
    serverId: SERVER,
    hostname: "app.example.com",
    domainType: "custom",
    verified: false,
    status: "pending",
  });
}

describe("server-scoped issuance eligibility (liveVerificationOwner extension)", () => {
  beforeEach(async () => {
    await db.delete(schema.discoveryBinding);
    await db.delete(schema.discoverySettings);
    await db.delete(schema.domain);
    await db.delete(schema.project);
  });

  it("queues a server domain for verification with NO project or deployment", async () => {
    await seedServerDomain();
    const pending = await domainRepo.findPendingVerification(new Date(Date.now() + 1000));
    expect(pending.map((r) => r.hostname)).toContain("app.example.com");
    // A DNS-verified server domain with no certificate is issuance-eligible
    // (the TXT ownership gate does not apply to this owner type).
    await db
      .update(schema.domain)
      .set({ verified: true, verifiedAt: new Date(), sslStatus: "none" })
      .where(eq(schema.domain.id, "dom_server_scope"));
    const pendingSsl = await domainRepo.findPendingSsl();
    expect(pendingSsl.map((r) => r.hostname)).toContain("app.example.com");
  });

  it("excludes server domains when discovery is disabled on the server", async () => {
    await seedServerDomain({ enabled: false });
    const pending = await domainRepo.findPendingVerification(new Date(Date.now() + 1000));
    expect(pending.map((r) => r.hostname)).not.toContain("app.example.com");
  });

  it("excludes suppressed bindings and unobserved (stopped/missing) containers", async () => {
    await seedServerDomain({ suppressed: true });
    expect(
      (await domainRepo.findPendingVerification(new Date(Date.now() + 1000))).map((r) => r.hostname),
    ).not.toContain("app.example.com");

    // Second scenario needs its own domain row (hostname unique in `domain`).
    await db.delete(schema.domain);
    await seedServerDomain({ observationStatus: "missing" });
    expect(
      (await domainRepo.findPendingVerification(new Date(Date.now() + 1000))).map((r) => r.hostname),
    ).not.toContain("app.example.com");
  });

  it("scopes server domains by organization through the server row", async () => {
    await seedServerDomain({ organizationId: "org_1" });
    const now = new Date(Date.now() + 1000);
    expect((await domainRepo.findPendingVerification(now, 100, "org_1")).map((r) => r.hostname)).toContain("app.example.com");
    expect((await domainRepo.findPendingVerification(now)).map((r) => r.hostname)).toContain("app.example.com");
    expect((await domainRepo.findPendingVerification(now, 100, "org_other")).map((r) => r.hostname)).not.toContain("app.example.com");
  });

  it("keeps project-domain eligibility rules exactly as they were", async () => {
    // Project seeding is FK-free here (replica mode); NOT NULL columns still
    // apply — name/slug/groupId are required, the org id is a bare string.
    await db.insert(schema.project).values([
      { id: "proj_live", organizationId: "org_1", groupId: "grp_live", name: "Live", slug: "live", activeDeploymentId: "dep_1" },
      { id: "proj_idle", organizationId: "org_1", groupId: "grp_idle", name: "Idle", slug: "idle" },
    ]);
    await db.insert(schema.domain).values([
      { id: "dom_live", projectId: "proj_live", hostname: "live.example.com", domainType: "custom", verified: false, status: "pending" },
      { id: "dom_idle", projectId: "proj_idle", hostname: "idle.example.com", domainType: "custom", verified: false, status: "pending" },
    ]);
    const hostnames = (
      await domainRepo.findPendingVerification(new Date(Date.now() + 1000))
    ).map((r) => r.hostname);
    expect(hostnames).toContain("live.example.com");
    expect(hostnames).not.toContain("idle.example.com");
  });
});
