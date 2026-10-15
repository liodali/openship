import { describe, expect, it, vi } from "vitest";
import {
  assertBuildStorage,
  ensureProjectBuildCache,
  managedBuildCaches,
  parseBuildStorage,
  projectBuildCacheVolume,
  pruneManagedBuildCaches,
} from "./docker-build-cache";

const GIB = 1024 ** 3;
function volume(projectId: string, bytes = GIB, refs = 0) {
  return {
    Name: projectBuildCacheVolume(projectId),
    Mountpoint: `/cache/${projectId}`,
    Labels: { "openship.build-cache": "1", "openship.build-cache.project": projectId },
    CreatedAt: new Date().toISOString(),
    UsageData: { Size: bytes, RefCount: refs },
  };
}
function fixture(volumes = [volume("a"), volume("b")]) {
  const removed: string[] = [];
  const docker = {
    listVolumes: vi.fn(async () => ({ Volumes: volumes })),
    listContainers: vi.fn(
      async () => [] as Array<{ Mounts: Array<{ Name: string; Source: string }> }>,
    ),
    getVolume: vi.fn((name: string) => ({
      inspect: vi.fn(async () => volumes.find((v) => v.Name === name)!),
      remove: vi.fn(async () => {
        removed.push(name);
      }),
    })),
    createVolume: vi.fn(async () => ({})),
  };
  const exec = vi.fn(async (command: string) => {
    if (command.includes("df -Pk")) return "104857600 52428800\n100000\n";
    if (command.startsWith("du ")) {
      const v = volumes.find((v) => command.includes(v.Mountpoint))!;
      return `${v.UsageData.Size / 1024}\t${v.Mountpoint}\n`;
    }
    if (command.includes("stat -c"))
      return command.includes(projectBuildCacheVolume("a")) ? "2000000000\n" : "2000000100\n";
    return "";
  });
  return { docker, executor: { exec } as never, exec, removed };
}

describe("bounded project build cache", () => {
  it("validates free bytes and refuses an exhausted filesystem", () => {
    expect(parseBuildStorage("102400 51200\n100")).toEqual({
      totalBytes: 104857600,
      freeBytes: 52428800,
      freeInodes: 100,
    });
    expect(() => parseBuildStorage("bad")).toThrow(/measure/);
    expect(
      parseBuildStorage("login banner\nOPENSHIP_STORAGE 102400 51200\nOPENSHIP_INODES 100\n"),
    ).toEqual({ totalBytes: 104857600, freeBytes: 52428800, freeInodes: 100 });
    expect(() => parseBuildStorage("1024 2048")).toThrow(/measure/);
    expect(() =>
      assertBuildStorage({ totalBytes: 100 * GIB, freeBytes: GIB, freeInodes: 100 }),
    ).toThrow(/too little/);
    expect(() =>
      assertBuildStorage({ totalBytes: 100 * GIB, freeBytes: 10 * GIB, freeInodes: 0 }),
    ).toThrow(/too little/);
  });

  it("does not accept foreign, unlabeled, malformed, or unknown-usage volumes", () => {
    expect(
      managedBuildCaches({
        Volumes: [
          volume("a"),
          { ...volume("b"), Name: "database" },
          { ...volume("c"), Labels: {} },
          { ...volume("data"), Labels: { ...volume("data").Labels, "openship.project": "data" } },
          { ...volume("d"), UsageData: { Size: -1, RefCount: 0 } },
        ],
      }),
    ).toHaveLength(1);
    expect(managedBuildCaches({ Volumes: null })).toEqual([]);
    expect(() => managedBuildCaches({})).toThrow(/inventory/);
  });

  it("preserves cache under budget, then evicts the least recently used idle cache", async () => {
    const h = fixture();
    await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: 2 * GIB,
      now: 2000000200000,
    });
    expect(h.removed).toEqual([]);
    const result = await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: GIB,
      now: 2000000200000,
    });
    expect(h.removed).toEqual([projectBuildCacheVolume("a")]);
    expect(result.spaceReclaimed).toBe(GIB);
  });

  it("protects attached state even when the host is over budget", async () => {
    const h = fixture();
    h.docker.listContainers.mockResolvedValue([
      { Mounts: [{ Name: projectBuildCacheVolume("a"), Source: "/cache/a" }] },
    ]);
    await pruneManagedBuildCaches(h.docker as never, h.executor, { keepBytes: 0 });
    expect(h.removed).toEqual([projectBuildCacheVolume("b")]);
  });
  it("does not walk attached or pending state while its files can change", async () => {
    const h = fixture([volume("a"), volume("b"), volume("c")]);
    h.docker.listContainers.mockResolvedValue([
      { Mounts: [{ Name: projectBuildCacheVolume("a"), Source: "/cache/a" }] },
    ]);
    await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: GIB, protectedProjectIds: new Set(["b"]),
    });
    expect(h.exec.mock.calls.filter(([command]) => command.startsWith("du ")))
      .toEqual([["du -sk -- '/cache/c'", { timeout: 15_000 }]]);
    expect(h.removed).toEqual([]);
    h.exec.mockClear();
    await pruneManagedBuildCaches(h.docker as never, h.executor, { protectAll: true, keepBytes: 0 });
    expect(h.exec.mock.calls.some(([command]) => command.startsWith("du "))).toBe(false);
  });
  it("protects durable pending commands even before a worker appears", async () => {
    const h = fixture();
    await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: 0,
      protectedProjectIds: new Set(["a"]),
    });
    expect(h.removed).toEqual([projectBuildCacheVolume("b")]);
    await expect(
      pruneManagedBuildCaches(h.docker as never, h.executor, {
        projectId: "a",
        protectedProjectIds: new Set(["a"]),
      }),
    ).rejects.toMatchObject({ code: "BUILD_CACHE_IN_USE" });
    h.removed.length = 0;
    await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: 0,
      protectAll: true,
    });
    expect(h.removed).toEqual([]);
  });

  it("removes only the requested project's cache and refuses a live project cache", async () => {
    const h = fixture();
    await pruneManagedBuildCaches(h.docker as never, h.executor, { projectId: "b" });
    expect(h.removed).toEqual([projectBuildCacheVolume("b")]);
    expect(h.exec.mock.calls.filter(([command]) => command.startsWith("du ")))
      .toEqual([["du -sk -- '/cache/b'", { timeout: 15_000 }]]);
    h.docker.listContainers.mockResolvedValue([
      { Mounts: [{ Name: projectBuildCacheVolume("a"), Source: "/cache/a" }] },
    ]);
    await expect(
      pruneManagedBuildCaches(h.docker as never, h.executor, { projectId: "a" }),
    ).rejects.toMatchObject({ code: "BUILD_CACHE_IN_USE" });
  });

  it("stops deletion when ownership changes between discovery and remove", async () => {
    const h = fixture();
    h.docker.getVolume.mockImplementation(() => ({
      inspect: vi.fn(async () => volume("foreign")),
      remove: vi.fn(async () => {}),
    }));
    await expect(
      pruneManagedBuildCaches(h.docker as never, h.executor, { keepBytes: 0 }),
    ).rejects.toMatchObject({ code: "BUILD_CACHE_OWNER_MISMATCH" });
    expect(h.removed).toEqual([]);
  });

  it("does not force-remove a cache attached after inventory", async () => {
    const h = fixture([volume("a")]);
    const remove = vi.fn(async () => {
      throw { statusCode: 409 };
    });
    h.docker.getVolume.mockImplementation(() => ({
      inspect: vi.fn(async () => volume("a")),
      remove,
    }));
    expect(await pruneManagedBuildCaches(h.docker as never, h.executor, { keepBytes: 0 })).toEqual({
      cachesDeleted: [],
      spaceReclaimed: 0,
    });
    expect(remove).toHaveBeenCalledWith();
    await expect(
      pruneManagedBuildCaches(h.docker as never, h.executor, { projectId: "a" }),
    ).rejects.toMatchObject({ code: "BUILD_CACHE_IN_USE" });
  });

  it("creates an owned cache and checks the actual winner of a concurrent create", async () => {
    const h = fixture([volume("a")]);
    const inspect = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValueOnce(volume("a"));
    h.docker.getVolume.mockImplementation(() => ({ inspect, remove: vi.fn(async () => {}) }));
    expect(await ensureProjectBuildCache(h.docker as never, "a")).toBe(false);
    expect(h.docker.createVolume).toHaveBeenCalledWith({
      Name: projectBuildCacheVolume("a"),
      Labels: volume("a").Labels,
    });
    inspect.mockRejectedValueOnce({ statusCode: 404 }).mockResolvedValueOnce(volume("foreign"));
    await expect(ensureProjectBuildCache(h.docker as never, "a")).rejects.toMatchObject({
      code: "BUILD_CACHE_OWNER_MISMATCH",
    });
  });

  it("fails closed on permission failures instead of claiming a cache", async () => {
    const h = fixture();
    h.docker.getVolume.mockImplementation(() => ({
      inspect: vi.fn(async () => {
        throw { statusCode: 403 };
      }),
      remove: vi.fn(async () => {}),
    }));
    await expect(ensureProjectBuildCache(h.docker as never, "a")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.docker.createVolume).not.toHaveBeenCalled();
  });
});
