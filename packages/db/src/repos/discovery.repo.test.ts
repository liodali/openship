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
    running: true,
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
    const { desiredChanged, requeued } = await repo.observe(SERVER, observation({ ipAddress: "172.20.0.5" }));
    expect(desiredChanged).toBe(false);
    expect(requeued).toBe(false);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.desiredGeneration).toBe(1);
  });

  it("requeues on container replacement even without a config change", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    const { requeued } = await repo.observe(
      SERVER,
      observation({ containerId: "ctr_2", containerName: "my-app-2", ipAddress: "172.20.0.9" }),
    );
    // The route's upstream CHANGED — an applied binding must re-apply or it
    // keeps serving the old IP Docker may hand to another workload.
    expect(requeued).toBe(true);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.containerId).toBe("ctr_2");
    expect(row?.ipAddress).toBe("172.20.0.9");
    expect(row?.applyState).toBe("pending");
    expect(row?.desiredGeneration).toBe(2); // applied generation 1 < desired 2 → due
    expect((await repo.dueForApply(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
  });

  it("requeues on stop and on start", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);

    const stopped = await repo.observe(SERVER, observation({ running: false }));
    expect(stopped.requeued).toBe(true);
    let row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.containerRunning).toBe(false);
    expect(row?.applyState).toBe("pending");

    await repo.markApplied(SERVER, "id:my-app", 2);
    const started = await repo.observe(SERVER, observation({ running: true }));
    expect(started.requeued).toBe(true);
    row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.containerRunning).toBe(true);
    expect(row?.applyState).toBe("pending");
  });

  it("leaves an applied binding untouched when nothing about the target changed", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    const { requeued, desiredChanged } = await repo.observe(SERVER, observation({ ipAddress: "172.20.0.5" }));
    expect(requeued).toBe(false);
    expect(desiredChanged).toBe(false);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("applied");
    expect(row?.desiredGeneration).toBe(1);
    expect(await repo.dueForApply(SERVER)).toHaveLength(0);
  });

  it("requeues when the resolved upstream target changes (published host port)", async () => {
    await repo.observe(
      SERVER,
      observation({ upstreamStrategy: "published-port", hostPort: 18080, hostIp: "127.0.0.1", networkName: null }),
    );
    await repo.markApplied(SERVER, "id:my-app", 1);

    // The operator re-published the port; same config hash, different target.
    const { requeued } = await repo.observe(
      SERVER,
      observation({ running: true, upstreamStrategy: "published-port", hostPort: 18081, hostIp: "0.0.0.0", networkName: null }),
    );
    expect(requeued).toBe(true);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("pending");
    expect(row?.hostPort).toBe(18081);
    expect(row?.desiredGeneration).toBe(2);
  });

  it("stores upstream strategy and nulls network for published-only services", async () => {
    const row = (
      await repo.observe(
        SERVER,
        observation({ upstreamStrategy: "published-port", hostPort: 18080, hostIp: "127.0.0.1", networkName: null, networkId: null, ipAddress: null }),
      )
    ).binding;
    expect(row.upstreamStrategy).toBe("published-port");
    expect(row.hostPort).toBe(18080);
    expect(row.hostIp).toBe("127.0.0.1");
    expect(row.networkName).toBeNull();
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

  it("queues route withdrawal when an applied binding goes missing (crash-safe)", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    expect(await repo.dueForApply(SERVER)).toHaveLength(0);

    await repo.markMissing(SERVER, "id:my-app");
    const row = await repo.getBinding(SERVER, "id:my-app");
    // The reconciler must withdraw the live route even if the process dies
    // right here — applied + not-due would be exactly that crash window.
    expect(row?.applyState).toBe("pending");
    expect(row?.desiredGeneration).toBe(2);
    expect((await repo.dueForApply(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
  });

  it("does not re-bump an already-missing binding on repeated removals", async () => {
    await repo.observe(SERVER, observation());
    await repo.markMissing(SERVER, "id:my-app");
    const first = await repo.getBinding(SERVER, "id:my-app");
    const generation = first?.desiredGeneration;
    // The scanner re-runs every sweep until reconciliation catches up.
    await repo.markMissing(SERVER, "id:my-app");
    await repo.markMissing(SERVER, "id:my-app");
    const stable = await repo.getBinding(SERVER, "id:my-app");
    expect(stable?.desiredGeneration).toBe(generation);
    expect(stable?.observationStatus).toBe("missing");
  });

  it("schedules withdrawal for a BLOCKED binding with a previously applied route (P1: applied → blocked → missing)", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1); // route is live
    await repo.block(SERVER, "id:my-app", "hostname owned elsewhere");
    expect(await repo.dueForApply(SERVER)).toHaveLength(0); // forward applies blocked

    // Container removed while blocked: the LIVE route must still be retired.
    await repo.markMissing(SERVER, "id:my-app");
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("blocked"); // block survives — no forward apply
    expect(row?.withdrawalPending).toBe(true); // retirement scheduled
    expect(row?.observationStatus).toBe("missing");

    // Retirement is consumable independently of the apply queue...
    expect((await repo.dueForWithdrawal(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
    await repo.markWithdrawn(SERVER, "id:my-app");
    expect(await repo.dueForWithdrawal(SERVER)).toHaveLength(0);
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("blocked");
  });

  it("schedules withdrawal for a SUPPRESSED binding with a previously applied route", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    await repo.suppress(SERVER, "id:my-app");
    await repo.markMissing(SERVER, "id:my-app");
    expect((await repo.dueForWithdrawal(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
  });

  it("does not schedule withdrawal for bindings that never had a route", async () => {
    await repo.observe(SERVER, observation()); // pending, appliedGeneration 0
    await repo.markMissing(SERVER, "id:my-app");
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.withdrawalPending).toBe(false); // nothing to retire
    expect(row?.applyState).toBe("pending"); // normal requeue still applies
  });

  it("markInvalid invalidates the old observation, keeps metadata, and queues withdrawal (P1: invalid replacement)", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);

    await repo.markInvalid(SERVER, "id:my-app");
    const row = await repo.getBinding(SERVER, "id:my-app");
    // Old observation invalidated — no stale IP/running flag survives.
    expect(row?.observationStatus).toBe("invalid");
    expect(row?.containerId).toBeNull();
    expect(row?.containerName).toBeNull();
    expect(row?.ipAddress).toBeNull();
    expect(row?.containerRunning).toBe(false);
    // Binding/certificate metadata retained.
    expect(row?.hostname).toBe("app.example.com");
    expect(row?.port).toBe(3000);
    expect(row?.configHash).toBeTruthy();
    // Upstream withdrawal queued.
    expect(row?.applyState).toBe("pending");
    expect(row?.desiredGeneration).toBe(2);
    expect((await repo.dueForApply(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);

    // Idempotent: re-invalidating does not re-bump.
    await repo.markInvalid(SERVER, "id:my-app");
    expect((await repo.getBinding(SERVER, "id:my-app"))?.desiredGeneration).toBe(2);
  });

  it("markInvalid schedules withdrawal for a blocked binding with a prior route", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    await repo.block(SERVER, "id:my-app", "duplicate hostname");
    await repo.markInvalid(SERVER, "id:my-app");
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("blocked");
    expect((await repo.dueForWithdrawal(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
  });
});

describe("apply scheduling", () => {
  it("blocks and unblocks a conflicting binding, and other-owner hostnames are found", async () => {
    await repo.observe(SERVER, observation());

    // A project-owned domain already serves the hostname → conflict found.
    await db.insert(schema.domain).values({
      id: "dom_project_owner",
      projectId: "proj_other",
      hostname: "app.example.com",
    });
    const conflict = await repo.findConflictingDomainOwner(SERVER, "app.example.com");
    expect(conflict?.id).toBe("dom_project_owner");

    await repo.block(SERVER, "id:my-app", "hostname owned elsewhere");
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("blocked");
    // Blocked rows never become due, no matter the backoff.
    expect(await repo.dueForApply(SERVER)).toHaveLength(0);

    // markApplyError must not overwrite a blocked row.
    await repo.markApplyError(SERVER, "id:my-app", "should be ignored", new Date());
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyError).toBe("hostname owned elsewhere");

    // Resolution clears the block back to the pending queue.
    await repo.unblock(SERVER, "id:my-app");
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("pending");
  });

  it("keeps a blocked binding blocked through config changes, until unblocked", async () => {
    await repo.observe(SERVER, observation());
    await repo.block(SERVER, "id:my-app", "duplicate identity");
    // Operator recreates the container with new config while still conflicted.
    await repo.observe(
      SERVER,
      observation({
        containerId: "ctr_2",
        hostname: "moved.example.com",
        configHash: discoveryConfigHash({ hostname: "moved.example.com", port: 3000, network: "frontend" }),
      }),
    );
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("blocked"); // stays blocked across observation updates
    expect(row?.hostname).toBe("moved.example.com"); // but desired config is current
    await repo.unblock(SERVER, "id:my-app");
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("pending");
  });

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
  containerRunning?: boolean;
  organizationId?: string | null;
} = {}) {
  const {
    enabled = true,
    suppressed = false,
    observationStatus = "observed",
    containerRunning = true,
    organizationId,
  } = overrides;
  if (organizationId !== undefined) {
    await db.update(schema.servers).set({ organizationId }).where(eq(schema.servers.id, SERVER));
  }
  await repo.configure(SERVER, { enabled });
  await repo.observe(SERVER, observation({ running: containerRunning }));
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

  it("queues a server domain for issuance with NO project or deployment, and never through TXT verification", async () => {
    await seedServerDomain();
    // TXT verification does not apply to this owner type — verification IS the
    // first successful ACME issuance, driven by the reconciler after apply.
    const pending = await domainRepo.findPendingVerification(new Date(Date.now() + 1000));
    expect(pending.map((r) => r.hostname)).not.toContain("app.example.com");
    // A DNS-verified server domain with no certificate is issuance-eligible
    // through the pending-SSL queue (findPendingSsl).
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

  it("excludes suppressed bindings, stopped containers, and unobserved containers", async () => {
    await seedServerDomain({ suppressed: true });
    expect(
      (await domainRepo.findPendingVerification(new Date(Date.now() + 1000))).map((r) => r.hostname),
    ).not.toContain("app.example.com");

    // Second scenario needs its own domain row (hostname unique in `domain`).
    await db.delete(schema.domain);
    // Observed but STOPPED: ineligible even though the row is alive and fresh.
    await seedServerDomain({ containerRunning: false });
    expect(
      (await domainRepo.findPendingVerification(new Date(Date.now() + 1000))).map((r) => r.hostname),
    ).not.toContain("app.example.com");

    await db.delete(schema.domain);
    await seedServerDomain({ observationStatus: "missing" });
    expect(
      (await domainRepo.findPendingVerification(new Date(Date.now() + 1000))).map((r) => r.hostname),
    ).not.toContain("app.example.com");
  });

  it("retries a FAILED first issuance via findPendingServerIssuance (no stranding)", async () => {
    await seedServerDomain();
    // First issuance failed: row unverified, sslStatus error, verify attempts
    // recorded. It sits in none of the project queues (by design) — this queue
    // is what keeps it retrying.
    await db
      .update(schema.domain)
      .set({ sslStatus: "error", verifyAttempts: 1, lastVerifyError: "DNS not pointed yet" })
      .where(eq(schema.domain.id, "dom_server_scope"));
    const retried = await domainRepo.findPendingServerIssuance();
    expect(retried.map((r) => r.hostname)).toContain("app.example.com");

    // A stopped container pauses the retry (eligibility predicate).
    await db.update(schema.discoveryBinding).set({ containerRunning: false }).where(eq(schema.discoveryBinding.serverId, SERVER));
    expect((await domainRepo.findPendingServerIssuance()).map((r) => r.hostname)).not.toContain("app.example.com");
    await db.update(schema.discoveryBinding).set({ containerRunning: true }).where(eq(schema.discoveryBinding.serverId, SERVER));

    // Disabled discovery pauses it too.
    await repo.configure(SERVER, { enabled: false });
    expect((await domainRepo.findPendingServerIssuance()).map((r) => r.hostname)).not.toContain("app.example.com");
    await repo.configure(SERVER, { enabled: true });

    // Suppressed bindings are out.
    await repo.suppress(SERVER, "id:my-app");
    expect((await domainRepo.findPendingServerIssuance()).map((r) => r.hostname)).not.toContain("app.example.com");
  });

  it("scopes server domains by organization through the server row", async () => {
    await seedServerDomain({ organizationId: "org_1" });
    // Org scoping matters on the issuance queue (findPendingSsl, verified rows);
    // the TXT verification queue never contains server domains at all.
    await db
      .update(schema.domain)
      .set({ verified: true, verifiedAt: new Date(), sslStatus: "none" })
      .where(eq(schema.domain.id, "dom_server_scope"));
    const now = new Date();
    expect((await domainRepo.findPendingSsl(50, "org_1")).map((r) => r.hostname)).toContain("app.example.com");
    expect((await domainRepo.findPendingSsl()).map((r) => r.hostname)).toContain("app.example.com");
    expect((await domainRepo.findPendingSsl(50, "org_other")).map((r) => r.hostname)).not.toContain("app.example.com");
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
