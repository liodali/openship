import { describe, expect, it, vi } from "vitest";

import { DockerRuntime } from "./docker";
import { projectBuildCacheVolume } from "./docker-build-cache";
import {
  currentManagedCommandTracking,
  withManagedCommandTracking,
} from "./cloud/command-tracking";

function runtimeWithDial(dial: ReturnType<typeof vi.fn>): DockerRuntime {
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime & Record<string, unknown>;
  Object.assign(runtime, { _docker: { modem: { dial } } });
  return runtime;
}

describe("DockerRuntime.pruneBuildCache", () => {
  it("sends bounded prune policy to POST /build/prune and normalizes the result", async () => {
    const dial = vi.fn((options, callback) =>
      callback(null, { CachesDeleted: ["cache-a", "cache-b"], SpaceReclaimed: 4096 }),
    );
    const runtime = runtimeWithDial(dial);

    await expect(
      runtime.pruneBuildCache({
        all: true,
        keepStorageBytes: 5 * 1024 ** 3,
        filters: { until: ["24h"] },
      }),
    ).resolves.toEqual({ cachesDeleted: ["cache-a", "cache-b"], spaceReclaimed: 4096 });

    expect(dial).toHaveBeenCalledOnce();
    expect(dial.mock.calls[0]?.[0]).toMatchObject({
      path: "/build/prune?",
      method: "POST",
      options: {
        _query: {
          all: true,
          "keep-storage": 5 * 1024 ** 3,
          filters: { until: ["24h"] },
        },
        _body: {},
      },
    });
  });

  it("omits keep-storage for an explicit full prune", async () => {
    const dial = vi.fn((options, callback) => callback(null, { SpaceReclaimed: 0 }));
    const runtime = runtimeWithDial(dial);

    await expect(runtime.pruneBuildCache({ all: true })).resolves.toEqual({
      cachesDeleted: [],
      spaceReclaimed: 0,
    });

    expect(dial.mock.calls[0]?.[0].options._query).toEqual({ all: true });
  });

  it("rejects invalid retention values before contacting Docker", async () => {
    const dial = vi.fn();
    const runtime = runtimeWithDial(dial);

    await expect(runtime.pruneBuildCache({ keepStorageBytes: -1 })).rejects.toThrow(
      "keepStorageBytes must be a non-negative safe integer",
    );
    expect(dial).not.toHaveBeenCalled();
  });

  it("propagates daemon errors", async () => {
    const dial = vi.fn((_options, callback) => callback(new Error("daemon unavailable"), null));
    const runtime = runtimeWithDial(dial);

    await expect(runtime.pruneBuildCache({ all: true })).rejects.toThrow("daemon unavailable");
  });
});

describe("managed project cache cleanup", () => {
  function cacheRuntime() {
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime & {
      clearManagedProjectBuildCache(projectId: string): Promise<void>;
    };
    let attached = true;
    let protectedIds: string[] = [];
    let pending = 0;
    let deferAcks = false;
    const calls: string[] = [];
    const exec = vi.fn(async (command: string) => {
      calls.push(command);
      if (deferAcks && command.startsWith("docker ")) {
        pending++;
        currentManagedCommandTracking()!.defer(
          new Promise((resolve) =>
            setTimeout(() => {
              pending--;
              resolve();
            }, 5),
          ),
        );
      }
      if (command.startsWith("docker buildx rm")) attached = false;
      if (command.includes("df -Pk"))
        return "OPENSHIP_STORAGE 104857600 52428800\nOPENSHIP_INODES 100000\n";
      if (command.startsWith("du ")) return "1024\t/cache/state\n";
      return "";
    });
    const remove = vi.fn(async () => {
      calls.push("remove-volume");
    });
    const dial = vi.fn((_options, callback) =>
      callback(null, {
        CachesDeleted: ["native-cache"],
        SpaceReclaimed: 4096,
      }),
    );
    const volume = {
      Name: projectBuildCacheVolume("p1"),
      Mountpoint: "/cache/state",
      Labels: { "openship.build-cache": "1", "openship.build-cache.project": "p1" },
    };
    Object.assign(runtime, {
      connectionOptions: {
        transport: "cloud",
        executor: { exec },
        buildCacheProtection: async () => ({ projectIds: protectedIds, all: pending > 0 }),
      },
      provisionLock: {
        run: async (work: () => Promise<void>) => {
          calls.push("lock");
          try {
            return await work();
          } finally {
            calls.push("unlock");
          }
        },
      },
      _docker: {
        modem: { dial },
        listVolumes: async () => ({ Volumes: [volume] }),
        listContainers: async () => (attached ? [{ Mounts: [{ Name: volume.Name }] }] : []),
        getVolume: () => ({ inspect: async () => volume, remove }),
      },
    });
    return {
      runtime,
      calls,
      remove,
      exec,
      dial,
      idle: () => {
        attached = false;
      },
      deferAcks: () => {
        deferAcks = true;
      },
      protect: () => {
        protectedIds = ["p1"];
      },
    };
  }

  it("collects idle project state without touching the daemon's native BuildKit cache", async () => {
    const h = cacheRuntime();
    h.idle();
    await expect(h.runtime.pruneBuildCache({ all: true, keepStorageBytes: 0 })).resolves.toEqual({
      cachesDeleted: [projectBuildCacheVolume("p1")],
      spaceReclaimed: 1024 * 1024,
    });
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.dial).not.toHaveBeenCalled();
    expect(h.calls[0]).toBe("lock");
    expect(h.calls.at(-1)).toBe("unlock");
  });

  it("preserves attached project state without falling through to native pruning", async () => {
    const h = cacheRuntime();
    await expect(h.runtime.pruneBuildCache({ all: true, keepStorageBytes: 0 })).resolves.toEqual({
      cachesDeleted: [],
      spaceReclaimed: 0,
    });
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.dial).not.toHaveBeenCalled();
  });

  it("rejects Engine-only filters before any Cloud cache mutation", async () => {
    const h = cacheRuntime();
    h.idle();
    await expect(h.runtime.pruneBuildCache({ filters: { until: ["24h"] } })).rejects.toMatchObject({
      code: "CLOUD_BUILD_CACHE_FILTER_UNSUPPORTED",
    });
    expect(h.calls).toEqual([]);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.dial).not.toHaveBeenCalled();
  });

  it("refuses Cloud cleanup without the managed executor instead of pruning the daemon", async () => {
    const h = cacheRuntime();
    Object.assign(h.runtime.connectionOptions!, { executor: undefined });
    await expect(h.runtime.pruneBuildCache()).rejects.toMatchObject({
      code: "CLOUD_BUILD_EXECUTOR_UNAVAILABLE",
    });
    expect(h.dial).not.toHaveBeenCalled();
  });

  it("detaches an idle managed worker before removing its retained cache under the host lock", async () => {
    const h = cacheRuntime();
    await h.runtime.clearManagedProjectBuildCache("p1");
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.calls[0]).toBe("lock");
    expect(h.calls.at(-1)).toBe("unlock");
    expect(h.calls.findIndex((command) => command.includes("openship-cache-"))).toBeLessThan(
      h.calls.indexOf("remove-volume"),
    );
  });

  it("drains its own deferred exit acknowledgements before checking cache protection", async () => {
    const h = cacheRuntime();
    h.deferAcks();
    await withManagedCommandTracking({ record: async () => {}, complete: async () => {} }, () =>
      h.runtime.clearManagedProjectBuildCache("p1"),
    );
    expect(h.remove).toHaveBeenCalledOnce();
  });

  it("leaves the worker and volume intact while durable project commands are pending", async () => {
    const h = cacheRuntime();
    h.protect();
    await expect(h.runtime.clearManagedProjectBuildCache("p1")).rejects.toMatchObject({
      code: "CLOUD_COMMAND_EXIT_UNCONFIRMED",
    });
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
});
