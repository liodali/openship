import { beforeEach, describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "@repo/adapters";
import type { Project } from "@repo/db";

const h = vi.hoisted(() => ({
  project: { id: "project-b", organizationId: "org", activeDeploymentId: "dep-b" },
  runtime: undefined as unknown,
  keep: new Set<string>(),
}));

vi.mock("@repo/platform/engine/lib/active-deployment", () => ({
  findActiveDeployment: async () => ({ id: "dep-b", meta: {} }),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: async () => ({ runtime: h.runtime }),
}));
vi.mock("@repo/platform/engine/modules/deployments/retention-lock", () => ({
  withRetentionLock: async (_id: string, action: (project: unknown) => Promise<unknown>) =>
    action(h.project),
}));
vi.mock("@repo/platform/engine/modules/deployments/retained-artifacts", () => ({
  computeKeepSet: async () => h.keep,
}));
vi.mock("@repo/platform/engine/modules/deployments/release-retention", () => ({
  refreshRollbackCapacity: async () => {},
}));

import { reapProjectImages } from "@repo/platform/engine/modules/deployments/image-gc";

type Image = {
  Id: string;
  RepoTags: string[];
  Labels: Record<string, string>;
  Size: number;
  inUse?: boolean;
};

function daemon(images: Image[]) {
  const inventory = new Map(images.map((image) => [image.Id, image]));
  const pruneImages = vi.fn(async () => {
    // Docker's filtered prune has no knowledge of Openship's retained IDs.
    for (const image of inventory.values()) {
      if (
        image.Labels["openship.project"] === h.project.id &&
        !image.RepoTags.length &&
        !image.inUse
      )
        inventory.delete(image.Id);
    }
  });
  const remove = vi.fn(async (ref: string, options: { force?: boolean }) => {
    expect(options.force).toBe(false);
    const image =
      inventory.get(ref) ?? [...inventory.values()].find((entry) => entry.RepoTags.includes(ref));
    if (!image) throw Object.assign(new Error("No such image"), { statusCode: 404 });
    if (image.inUse) throw Object.assign(new Error("Image is in use"), { statusCode: 409 });
    if (ref === image.Id || image.RepoTags.length === 1) inventory.delete(image.Id);
    else image.RepoTags = image.RepoTags.filter((tag) => tag !== ref);
  });
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
  Object.assign(runtime, {
    _docker: {
      listImages: async ({ filters }: { filters: { label: string[] } }) =>
        [...inventory.values()].filter((image) =>
          filters.label.every((label) => {
            const [key, value] = label.split("=");
            return image.Labels[key!] === value;
          }),
        ),
      getImage: (ref: string) => ({
        remove: (options: { force?: boolean }) => remove(ref, options),
      }),
      pruneImages,
    },
    dispose: async () => {},
  });
  h.runtime = runtime;
  return { inventory, pruneImages, remove };
}

function image(id: string, tags: string[] = [], projectId = h.project.id): Image {
  return { Id: id, RepoTags: tags, Labels: { "openship.project": projectId }, Size: 100 };
}

beforeEach(() => h.keep.clear());

describe("project image retention on a shared Docker daemon (#1369)", () => {
  it("does not invoke host-wide image prune after a registry-only deployment", async () => {
    const state = daemon([image("foreign", ["openship/a:bld_live"], "project-a")]);
    const result = await reapProjectImages(h.project as Project);

    expect(result).toEqual({ removed: 0, bytes: 0, skippedInUse: 0, errors: 0 });
    expect([...state.inventory.keys()]).toEqual(["foreign"]);
    // /images/prune sweeps containerd build/pull leases BEFORE label filtering,
    // even when the finished project has no locally built images at all.
    expect(state.pruneImages).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("reclaims expired tags and dangling images once while preserving retained, foreign and in-use images", async () => {
    h.keep.add("sha256:retained-digest");
    h.keep.add("openship/b:bld_active");
    h.keep.add("openship/b:bld_pinned");
    const state = daemon([
      image("sha256:retained-digest"),
      image("active", ["openship/b:bld_active"]),
      image("pinned", ["openship/b:bld_pinned"]),
      image("expired", ["openship/b:bld_expired"]),
      image("dangling"),
      { ...image("in-use"), inUse: true },
      image("repurposed", ["openship/b:bld_old", "operator/keep:latest"]),
      image("foreign", [], "project-a"),
      image("base", ["alpine:3.20"], ""),
    ]);

    expect(await reapProjectImages(h.project as Project)).toEqual({
      removed: 3,
      bytes: 200,
      skippedInUse: 1,
      errors: 0,
    });
    expect([...state.inventory.keys()]).toEqual([
      "sha256:retained-digest",
      "active",
      "pinned",
      "in-use",
      "repurposed",
      "foreign",
      "base",
    ]);
    expect(state.inventory.get("repurposed")?.RepoTags).toEqual(["operator/keep:latest"]);
    expect(state.remove.mock.calls.map(([ref]) => ref)).toEqual([
      "openship/b:bld_expired",
      "dangling",
      "in-use",
      "openship/b:bld_old",
    ]);
    expect(state.pruneImages).not.toHaveBeenCalled();
  });
});
