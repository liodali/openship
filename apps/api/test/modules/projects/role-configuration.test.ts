import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, repos, schema } from "@repo/db";
import { DockerRuntime } from "@repo/adapters";
import { ProjectControlSchemas } from "@repo/contracts";
import { createResourceOperations } from "../../../../../packages/platform/src/resource-operations";
import { createProjectControls } from "@repo/platform/engine/modules/projects/project-controls.operations";
import type { ExecutionContext } from "@repo/platform";
import { seedDeployment, seedOrg, seedProject, seedService, setActive } from "../../helpers/seed";
const h = vi.hoisted(() => ({
  runtime: null as unknown,
  start: vi.fn(async () => "build"),
  access: vi.fn(async () => {}),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>()),
  withDeploymentRuntime: async (_dep: unknown, run: (runtime: unknown) => Promise<unknown>) =>
    run(h.runtime),
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/deployments/build.service")>()),
  startBuild: h.start,
}));
vi.mock("@repo/platform/engine/modules/github/github-access", () => ({
  assertGitHubRepoAccess: h.access,
}));
const { configureRuntimeRoles, getRoleConfiguration } =
  await import("@repo/platform/engine/modules/projects/role-configuration.service");
const imageId = `sha256:${"a".repeat(64)}`;
const owned: string[] = [];
beforeEach(() => {
  h.start.mockClear();
  h.access.mockClear();
});
afterEach(async () => {
  for (const id of owned.splice(0))
    await db.delete(schema.project).where(eq(schema.project.id, id));
});
async function fixture(target = "server") {
  const org = await seedOrg();
  const project = await seedProject(org.organizationId);
  owned.push(project.id);
  const active = await seedDeployment(project, {
    containerId: "web",
    url: "https://app.example.test",
    meta: {
      runtimeMode: "docker",
      deployTarget: target,
      hasServer: true,
      framework: "node",
      port: 3000,
      startCommand: "exec app",
      roles: [],
    },
    envVars: { SECRET: "frozen" },
  });
  await setActive(project.id, active.id);
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
  Object.assign(runtime, {
    capabilities: new Set(["roles"]),
    findOwnedDeploymentContainer: async (_ref: string, owner: { deploymentId: string }) =>
      owner.deploymentId === active.id ? "web" : null,
    inspectContainer: async () => ({ id: "web", state: "running", imageId }),
  });
  h.runtime = runtime;
  const config = await getRoleConfiguration(project.id, org.organizationId);
  const ctx = {
    organizationId: org.organizationId,
    userId: org.userId,
    source: "test",
  } as unknown as ExecutionContext;
  const input = {
    expectedDeploymentId: active.id,
    expectedUpdatedAt: config.updatedAt,
    roles: [{ name: "queue", kind: "worker" as const, command: "exec worker", replicas: 2 }],
  };
  return { project, active, org, config, ctx, input, runtime };
}
describe("runtime role configuration admission", () => {
  it("uses the active immutable image and frozen environment, persists desired roles atomically and deduplicates a pending retry", async () => {
    const f = await fixture();
    const operations = createResourceOperations(
      ProjectControlSchemas,
      {
        authorize: async (ctx: ExecutionContext) => ctx,
      },
      "project",
      createProjectControls(vi.fn()),
    );
    const read = await operations.getRuntimeRoleConfiguration(f.ctx, f.project.id);
    expect(read.data).toMatchObject({ supported: true, deploymentId: f.active.id });
    const { data: result } = await operations.configureRuntimeRoles(f.ctx, f.project.id, f.input);
    const dep = (await repos.deployment.findById(result.deploymentId))!;
    expect(dep.meta).toMatchObject({
      handoverAppImage: imageId,
      roles: f.input.roles,
      roleConfiguration: { sourceDeploymentId: f.active.id, webContainerId: "web", imageId },
    });
    expect(dep.envVars).toEqual(f.active.envVars);
    expect(dep.url).toBe(f.active.url);
    expect(await repos.deployment.findBuildSessionByDeploymentId(dep.id)).toMatchObject({
      status: "queued",
    });
    expect((await repos.project.findById(f.project.id))?.roles).toMatchObject(f.input.roles);
    expect(await configureRuntimeRoles(f.ctx, f.project.id, f.input)).toEqual(result);
    expect(
      (await repos.deployment.listInFlightByProject(f.project.id)).map((row) => row.id),
    ).toEqual([dep.id]);
  });
  it("supports a headless Docker primary process using the same workload classification as deployment", async () => {
    const f = await fixture();
    await repos.deployment.updateStatus(f.active.id, "ready", {
      meta: {
        ...(f.active.meta as Record<string, unknown>),
        hasServer: false,
        workload: "worker",
      },
    });
    expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(true);
    expect((await configureRuntimeRoles(f.ctx, f.project.id, f.input)).deploymentId).toBeTruthy();
  });
  it("uses the deployment topology rules for primary records and disabled sidecars", async () => {
    const f = await fixture();
    await seedService(f.project.id, { name: "primary", kind: "app", enabled: true });
    const sidecar = await seedService(f.project.id, {
      name: "database",
      kind: "compose",
      enabled: false,
    });
    expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(true);
    await db.update(schema.service).set({ enabled: true }).where(eq(schema.service.id, sidecar.id));
    expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(false);
    await expect(configureRuntimeRoles(f.ctx, f.project.id, f.input)).rejects.toThrow(
      "single-app Docker",
    );
    await db
      .update(schema.service)
      .set({ enabled: false })
      .where(eq(schema.service.id, sidecar.id));
    expect((await configureRuntimeRoles(f.ctx, f.project.id, f.input)).deploymentId).toBeTruthy();
  });
  it("rejects stale edits, unavailable images, unsupported Cloud and foreign organizations before creating work", async () => {
    const f = await fixture();
    await expect(
      configureRuntimeRoles(f.ctx, f.project.id, { ...f.input, expectedDeploymentId: "stale" }),
    ).rejects.toMatchObject({ code: "ROLE_CONFIGURATION_CHANGED" });
    f.runtime.inspectContainer = async () => null;
    await expect(configureRuntimeRoles(f.ctx, f.project.id, f.input)).rejects.toMatchObject({
      code: "ROLE_CONFIGURATION_UNAVAILABLE",
    });
    await expect(
      configureRuntimeRoles({ ...f.ctx, organizationId: "foreign" }, f.project.id, f.input),
    ).rejects.toThrow();
    const cloud = await fixture("cloud");
    expect(cloud.config.supported).toBe(false);
    await expect(configureRuntimeRoles(cloud.ctx, cloud.project.id, cloud.input)).rejects.toThrow(
      "single-app Docker",
    );
    expect(h.start).not.toHaveBeenCalled();
  });
});
