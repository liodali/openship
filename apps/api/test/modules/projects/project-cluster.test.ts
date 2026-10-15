import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import { AppError } from "@repo/core";

const h = vi.hoisted(() => ({
  find: vi.fn(),
  active: vi.fn(),
  lock: vi.fn(),
  fleet: vi.fn(),
  authorize: vi.fn(),
  ready: vi.fn(),
  supported: vi.fn(),
  bind: vi.fn(),
  trigger: vi.fn(),
  builds: vi.fn(),
  audit: vi.fn(),
  available: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: h.find },
    clusterRuntime: { bindProject: h.bind },
    clusterDatabase: { list: vi.fn(async () => []) },
    service: { listByProject: vi.fn(async () => []) },
  },
}));
vi.mock("@repo/platform/engine/lib/active-deployment", () => ({ findActiveDeployment: h.active }));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withProjectStateLock: async (_id: string, work: () => Promise<unknown>) => work(),
  withLiveProjectRuntimeMutation: h.lock,
}));
vi.mock("@repo/platform/engine/lib/cluster-deployment-target", () => ({
  requireClusterDeploymentTarget: h.ready,
  assertClusterWorkloadSupported: h.supported,
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({ withDeploymentRuntime: vi.fn() }));
vi.mock("@repo/platform/engine/modules/system/managed-network.operations", () => ({
  fleetAdmin: h.fleet,
}));
vi.mock("@repo/platform/engine/modules/system/server-cluster.operations", () => ({
  authorizeMember: h.authorize,
  assertClusterManagementAvailable: h.available,
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  triggerDeployment: h.trigger,
  checkNoActiveBuild: h.builds,
}));

import { createProjectClusterOperations } from "@repo/platform/engine/modules/projects/project-cluster.operations";
const ctx = { organizationId: "org", userId: "user" } as ExecutionContext;
const now = new Date("2026-09-21T09:00:00.000Z");
const project = () => ({
  id: "project",
  organizationId: "org",
  clusterId: "cluster",
  clusterConfig: { replicas: 2, imageRepository: "ghcr.io/team/api" },
  updatedAt: now,
  activeDeploymentId: "release",
  framework: "express",
  hasServer: true,
});
const operations = createProjectClusterOperations(h.audit);
beforeEach(() => {
  vi.resetAllMocks();
  h.find.mockResolvedValue(project());
  h.lock.mockImplementation(async (_id, work) => work(await h.find()));
  h.active.mockResolvedValue({ id: "release", meta: { clusterId: "cluster" } });
  h.ready.mockResolvedValue({
    runtime: { plan: { hosts: [{ serverId: "a" }, { serverId: "b" }] } },
  });
  h.trigger.mockResolvedValue({ deployment: { id: "scale-release" } });
});

describe("project cluster lifecycle admission", () => {
  it.each([
    [undefined, true],
    [{ mode: "url", artifactKind: "archive" }, true],
    [{ mode: "url", artifactKind: "image" }, false],
  ])(
    "reports image delivery requirements and the saved destination for %j",
    async (releaseSource, requiresImageRepository) => {
      h.find.mockResolvedValue({
        ...project(),
        clusterId: null,
        serverId: "server-a",
        releaseSource,
      });
      expect(await operations.getClusterWorkload(ctx, "project")).toMatchObject({
        clusterId: null,
        serverId: "server-a",
        activeClusterId: "cluster",
        requiresImageRepository,
      });
      expect(h.bind).not.toHaveBeenCalled();
      expect(h.trigger).not.toHaveBeenCalled();
    },
  );
  it("scales through a configuration release, using the existing deployment lifecycle", async () => {
    expect(
      await operations.scaleClusterWorkload(ctx, "project", {
        replicas: 4,
        expectedDeploymentId: "release",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).toEqual({ deploymentId: "scale-release" });
    expect(h.bind).toHaveBeenCalledWith(
      "org",
      "project",
      "cluster",
      { replicas: 4, imageRepository: "ghcr.io/team/api" },
      now.toISOString(),
    );
    expect(h.trigger).toHaveBeenCalledOnce();
    expect(h.trigger).toHaveBeenCalledWith(ctx, { projectId: "project", refresh: true });
  });
  it.each([
    { expectedDeploymentId: "old", expectedUpdatedAt: now.toISOString() },
    { expectedDeploymentId: "release", expectedUpdatedAt: "old" },
  ])("refuses stale controls before changing desired replicas", async (input) => {
    await expect(
      operations.scaleClusterWorkload(ctx, "project", { replicas: 4, ...input }),
    ).rejects.toMatchObject({ code: "CLUSTER_WORKLOAD_CONFLICT" });
    expect(h.bind).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it("refuses a busy deployment and leaves desired replicas unchanged", async () => {
    h.builds.mockRejectedValue(new AppError("Deployment already running", 409));
    await expect(
      operations.scaleClusterWorkload(ctx, "project", {
        replicas: 4,
        expectedDeploymentId: "release",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).rejects.toThrow("already running");
    expect(h.bind).not.toHaveBeenCalled();
  });
  it("never automatically retries a failed deployment admission", async () => {
    h.trigger.mockRejectedValue(new AppError("Registry unavailable", 502));
    await expect(
      operations.scaleClusterWorkload(ctx, "project", {
        replicas: 4,
        expectedDeploymentId: "release",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).rejects.toThrow("Registry unavailable");
    expect(h.trigger).toHaveBeenCalledOnce();
  });
  it("requires fleet access and checks every host before binding a target", async () => {
    h.find.mockResolvedValue({ ...project(), clusterId: null });
    await operations.setClusterTarget(ctx, "project", {
      clusterId: "cluster",
      config: { replicas: 2, imageRepository: "ghcr.io/team/api" },
      expectedUpdatedAt: now.toISOString(),
      stateless: true,
    });
    expect(h.fleet).toHaveBeenCalledWith(ctx);
    expect(h.authorize.mock.calls).toEqual([
      [ctx, "a"],
      [ctx, "b"],
    ]);
    expect(h.supported).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project",
        framework: "express",
        imageRepository: "ghcr.io/team/api",
      }),
    );
  });
  it("cannot mutate another organization's project", async () => {
    h.find.mockResolvedValue({ ...project(), organizationId: "other" });
    await expect(
      operations.scaleClusterWorkload(ctx, "project", {
        replicas: 4,
        expectedDeploymentId: "release",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).rejects.toThrow();
    expect(h.bind).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });
});
