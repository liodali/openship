import { describe, it, expect, vi } from "vitest";
import type { StackRole } from "@repo/core";
import type { BuildLogger, DeployConfig, RuntimeAdapter } from "@repo/adapters";
import {
  rolesUnsupportedReason,
  roleTeardownTimeoutMs,
  retirePreviousRoleContainers,
  runtimeRoleRolloutDeps,
} from "@repo/platform/engine/modules/deployments/role-runtime";
import type { StabilityFinding } from "@repo/platform/engine/modules/deployments/stability-audit.service";

/**
 * role-runtime.ts binds the pure rollout to a runtime. Everything here runs on
 * fake runtimes (plain objects) and a fake stability watch: no daemon, no timers.
 */

const worker = (name = "worker", extra: Partial<StackRole> = {}): StackRole => ({
  name,
  kind: "worker",
  command: `run ${name}`,
  ...extra,
});
const scheduler = (name = "sched", extra: Partial<StackRole> = {}): StackRole => ({
  name,
  kind: "scheduler",
  command: `run ${name}`,
  ...extra,
});

const asRuntime = (fake: object) => fake as unknown as RuntimeAdapter;

describe("rolesUnsupportedReason", () => {
  const dockerLike = {
    name: "docker",
    supports: (cap: string) => cap === "roles",
    deployRole: async () => ({ containerId: "x" }),
  };
  const bareLike = { name: "bare", supports: () => false };
  const input = (over: Record<string, unknown> = {}) => ({
    roles: [worker()],
    runtime: dockerLike as never,
    deployMode: "server",
    multiService: false,
    ...over,
  });

  it("is null for null, [] and undefined roles, even on a runtime without the capability", () => {
    for (const roles of [null, [], undefined]) {
      expect(rolesUnsupportedReason(input({ roles, runtime: bareLike }))).toBeNull();
      expect(
        rolesUnsupportedReason(
          input({ roles, multiService: true, deployMode: "static-file-serve" }),
        ),
      ).toBeNull();
    }
  });

  it("refuses a multi-service deploy", () => {
    expect(rolesUnsupportedReason(input({ multiService: true }))).toBe(
      'Runtime roles are not supported on multi-service deployments yet. Remove "roles" from openship.json, or deploy the app as a single service.',
    );
  });

  it("refuses a static site", () => {
    expect(rolesUnsupportedReason(input({ deployMode: "static-file-serve" }))).toBe(
      "Runtime roles need a server image; a static site has no process to run them from.",
    );
  });

  it("refuses a runtime without the roles capability and names it", () => {
    const reason = rolesUnsupportedReason(input({ runtime: bareLike }));
    expect(reason).toBe(
      'Runtime roles are not supported on the "bare" runtime yet. Deploy to a Docker server, or remove "roles" from openship.json.',
    );
  });

  it("refuses a runtime that supports roles but has no deployRole", () => {
    const runtime = { name: "odd", supports: () => true };
    expect(rolesUnsupportedReason(input({ runtime }))).toContain('"odd" runtime');
  });

  it("checks multi-service first, then static, then the runtime", () => {
    expect(
      rolesUnsupportedReason(
        input({ multiService: true, deployMode: "static-file-serve", runtime: bareLike }),
      ),
    ).toContain("multi-service");
    expect(
      rolesUnsupportedReason(input({ deployMode: "static-file-serve", runtime: bareLike })),
    ).toContain("static site");
  });

  it("allows a Docker-like runtime on a single-service server deploy", () => {
    expect(rolesUnsupportedReason(input())).toBeNull();
  });
});

describe("roleTeardownTimeoutMs", () => {
  it("is 40s with no roles (30s plus Docker's default 10s grace)", () => {
    expect(roleTeardownTimeoutMs([])).toBe(40_000);
    expect(roleTeardownTimeoutMs(null)).toBe(40_000);
    expect(roleTeardownTimeoutMs(undefined)).toBe(40_000);
  });

  it("adds a role's grace period to the 30s base", () => {
    expect(roleTeardownTimeoutMs([scheduler("s", { stopGracePeriod: "90s" })])).toBe(120_000);
  });

  it("uses the longest grace period across the roles", () => {
    const roles = [
      worker("a", { stopGracePeriod: "20s" }),
      scheduler("b", { stopGracePeriod: "2m" }),
      worker("c", { stopGracePeriod: "45s" }),
    ];
    expect(roleTeardownTimeoutMs(roles)).toBe(150_000);
  });

  it("counts a role without a grace period as 10s", () => {
    expect(roleTeardownTimeoutMs([worker("a", { stopGracePeriod: "5s" }), worker("b")])).toBe(
      40_000,
    );
    expect(roleTeardownTimeoutMs([worker("a")])).toBe(40_000);
  });
});

interface Harness {
  deps: ReturnType<typeof runtimeRoleRolloutDeps>;
  runtime: Record<string, ReturnType<typeof vi.fn> | unknown>;
  previousRuntime: Record<string, ReturnType<typeof vi.fn> | unknown>;
  logs: { message: string; level: string | undefined }[];
  logger: BuildLogger;
  verifyStability: ReturnType<typeof vi.fn>;
  beforeStart: (containerId: string) => Promise<void>;
  config: DeployConfig;
}

function harness(
  over: {
    roles?: readonly StackRole[];
    previousRoles?: readonly StackRole[];
    findings?: StabilityFinding[];
    runtime?: Record<string, unknown>;
    previousRuntime?: Record<string, unknown>;
    keepProvisionedOnCancel?: () => boolean;
    stabilizationWindowMs?: number;
  } = {},
): Harness {
  const logs: { message: string; level: string | undefined }[] = [];
  const callback = () => {};
  const logger = {
    log: (message: string, level?: string) => logs.push({ message, level }),
    callback,
  } as unknown as BuildLogger;
  const runtime = {
    name: "docker",
    deployRole: vi.fn(async () => ({ containerId: "new-id" })),
    destroy: vi.fn(async () => {}),
    inContainerExecutor: vi.fn(async () => ({ exec: vi.fn(async () => "") })),
    ...over.runtime,
  };
  const previousRuntime = {
    name: "docker",
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    getContainerInfo: vi.fn(async () => ({ containerId: "old", status: "running" })),
    ...over.previousRuntime,
  };
  const verifyStability = vi.fn(async () => over.findings ?? []);
  const beforeStart = async () => {};
  const config = { deploymentId: "dep-1" } as unknown as DeployConfig;
  const deps = runtimeRoleRolloutDeps({
    roles: over.roles ?? [worker()],
    previousRoles: over.previousRoles,
    previous: [],
    runtime: asRuntime(runtime),
    previousRuntime: asRuntime(previousRuntime),
    config,
    logger,
    beforeStart,
    stabilizationWindowMs: over.stabilizationWindowMs ?? 5_000,
    keepProvisionedOnCancel: over.keepProvisionedOnCancel ?? (() => false),
    verifyStability: verifyStability as never,
  });
  return { deps, runtime, previousRuntime, logs, logger, verifyStability, beforeStart, config };
}

const finding = (name: string, ok: boolean, detail: string): StabilityFinding =>
  ({
    target: { serviceName: name, containerId: "c" },
    verdict: { ok } as never,
    summary: detail,
    detail,
  }) as StabilityFinding;

describe("runtimeRoleRolloutDeps: startReplica", () => {
  it("passes config, role, replica, logger.callback and the same beforeStart to deployRole", async () => {
    const h = harness();
    const role = worker("emails");
    const id = await h.deps.startReplica(role, 2);
    expect(id).toBe("new-id");
    const deployRole = h.runtime.deployRole as ReturnType<typeof vi.fn>;
    expect(deployRole).toHaveBeenCalledTimes(1);
    const args = deployRole.mock.calls[0] as unknown[];
    expect(args[0]).toBe(h.config);
    expect(args[1]).toBe(role);
    expect(args[2]).toBe(2);
    expect(typeof args[3]).toBe("function");
    expect((args[4] as { beforeStart: unknown }).beforeStart).toBe(h.beforeStart);
  });
});

describe("runtimeRoleRolloutDeps: verify", () => {
  const refs = [
    { role: "worker", replica: 1, containerId: "c1" },
    { role: "worker", replica: 2, containerId: "c2" },
    { role: "sched", replica: 1, containerId: "c3" },
  ];

  it("returns the first non-ok finding's detail and never runs exec health", async () => {
    const exec = vi.fn(async () => "");
    const h = harness({
      roles: [worker("worker", { health: { kind: "exec", command: "true" } })],
      runtime: { inContainerExecutor: vi.fn(async () => ({ exec })) },
      findings: [
        finding("worker-1", true, "fine"),
        finding("worker-2", false, "worker-2 crashed"),
        finding("sched-1", false, "later"),
      ],
    });
    expect(await h.deps.verify(refs)).toBe("worker-2 crashed");
    expect(exec).not.toHaveBeenCalled();
    expect(h.runtime.inContainerExecutor).not.toHaveBeenCalled();
  });

  it("passes the window through and names targets <role>-<replica>", async () => {
    const h = harness({ stabilizationWindowMs: 12_345 });
    await h.deps.verify(refs);
    const [rt, targets, logger, opts] = h.verifyStability.mock.calls[0] as unknown[];
    expect(rt).toBeDefined();
    expect(targets).toEqual([
      { serviceName: "worker-1", containerId: "c1" },
      { serviceName: "worker-2", containerId: "c2" },
      { serviceName: "sched-1", containerId: "c3" },
    ]);
    expect(logger).toBe(h.logger);
    expect((opts as { windowMs: number }).windowMs).toBe(12_345);
  });

  it("logs unverified details as warnings", async () => {
    const h = harness();
    await h.deps.verify(refs);
    const opts = h.verifyStability.mock.calls[0]![3] as { onUnverified: (d: string) => void };
    opts.onUnverified("cannot sample");
    expect(h.logs).toEqual([{ message: "cannot sample\n", level: "warn" }]);
  });

  it("runs exec health only for exec roles, once each, with the role's command", async () => {
    const execs: Record<string, ReturnType<typeof vi.fn>> = {};
    const inContainerExecutor = vi.fn(async (id: string) => {
      execs[id] = vi.fn(async () => "");
      return { exec: execs[id]! };
    });
    const h = harness({
      roles: [
        worker("worker", { health: { kind: "exec", command: "pgrep worker" } }),
        scheduler("sched", { health: { kind: "process" } }),
      ],
      runtime: { inContainerExecutor },
    });
    expect(await h.deps.verify(refs)).toBeNull();
    expect(inContainerExecutor).toHaveBeenCalledTimes(2);
    expect(Object.keys(execs).sort()).toEqual(["c1", "c2"]);
    expect(execs.c1).toHaveBeenCalledTimes(1);
    expect(execs.c1).toHaveBeenCalledWith("pgrep worker", { timeout: 30_000 });
    expect(execs.c2).toHaveBeenCalledWith("pgrep worker", { timeout: 30_000 });
  });

  it("returns the health failure message when exec throws", async () => {
    const h = harness({
      roles: [worker("worker", { health: { kind: "exec", command: "check" } })],
      runtime: {
        inContainerExecutor: vi.fn(async () => ({
          exec: async () => {
            throw new Error("exit 1");
          },
        })),
      },
    });
    expect(await h.deps.verify([refs[1]!])).toBe(
      'Role "worker" replica 2 health command failed: exit 1',
    );
  });

  it("warns and passes when the runtime has no inContainerExecutor", async () => {
    const h = harness({
      roles: [worker("worker", { health: { kind: "exec", command: "check" } })],
      runtime: { inContainerExecutor: undefined },
    });
    expect(await h.deps.verify([refs[0]!])).toBeNull();
    expect(h.logs.some((l) => l.level === "warn" && l.message.includes('role "worker"'))).toBe(
      true,
    );
  });

  it("returns null when stability and health both pass", async () => {
    const h = harness({
      roles: [worker("worker", { health: { kind: "exec", command: "ok" } })],
      findings: [finding("worker-1", true, "fine")],
    });
    expect(await h.deps.verify([refs[0]!])).toBeNull();
  });
});

describe("runtimeRoleRolloutDeps: stopPrevious", () => {
  it("resolves when stop resolves, without asking for the status", async () => {
    const h = harness();
    await h.deps.stopPrevious("old");
    expect(h.previousRuntime.stop).toHaveBeenCalledWith("old");
    expect(h.previousRuntime.getContainerInfo).not.toHaveBeenCalled();
  });

  it.each(["running", "stopped", "deploying", "failed", "missing"])(
    "propagates an unconfirmed stop even when the inventory status is %s",
    async (status) => {
      const original = new Error("daemon timeout");
      const h = harness({
        previousRuntime: {
          stop: vi.fn(async () => {
            throw original;
          }),
          getContainerInfo: vi.fn(async () => ({ containerId: "old", status })),
        },
      });
      await expect(h.deps.stopPrevious("old")).rejects.toBe(original);
      expect(h.previousRuntime.getContainerInfo).not.toHaveBeenCalled();
    },
  );

  it("uses previousRuntime, never runtime", async () => {
    const runtimeStop = vi.fn(async () => {});
    const h = harness({ runtime: { stop: runtimeStop } });
    await h.deps.stopPrevious("old");
    expect(runtimeStop).not.toHaveBeenCalled();
  });
});

describe("runtimeRoleRolloutDeps: restore and destroy", () => {
  it("startPrevious and destroyPrevious go to previousRuntime; destroyStarted goes to runtime", async () => {
    const h = harness();
    await h.deps.startPrevious("p1");
    await h.deps.destroyPrevious("p2");
    await h.deps.destroyStarted("n1");
    expect(h.previousRuntime.start).toHaveBeenCalledWith("p1");
    expect(h.previousRuntime.destroy).toHaveBeenCalledWith("p2");
    expect(h.previousRuntime.destroy).not.toHaveBeenCalledWith("n1");
    expect(h.runtime.destroy).toHaveBeenCalledWith("n1");
    expect(h.runtime.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("runtimeRoleRolloutDeps: log, signal and timeouts", () => {
  it("logs through the logger with a trailing newline and the info default", () => {
    const h = harness();
    h.deps.log("hello");
    h.deps.log("careful", "warn");
    expect(h.logs).toEqual([
      { message: "hello\n", level: "info" },
      { message: "careful\n", level: "warn" },
    ]);
  });

  it("derives the teardown timeout from the roles", () => {
    expect(
      harness({ roles: [scheduler("s", { stopGracePeriod: "90s" })] }).deps.teardownTimeoutMs,
    ).toBe(120_000);
  });

  it("an old role with a longer grace period than every new role sets the bound", () => {
    const h = harness({
      roles: [worker("w", { stopGracePeriod: "5s" })],
      previousRoles: [scheduler("s", { stopGracePeriod: "90s" })],
    });
    expect(h.deps.teardownTimeoutMs).toBe(120_000);
  });

  it("a new role with the longer grace period still wins over shorter previous roles", () => {
    const h = harness({
      roles: [scheduler("s", { stopGracePeriod: "60s" })],
      previousRoles: [worker("w", { stopGracePeriod: "5s" })],
    });
    expect(h.deps.teardownTimeoutMs).toBe(90_000);
  });

  it("keepProvisionedOnCancel reflects the input function's CURRENT value", () => {
    let keep = false;
    const h = harness({ keepProvisionedOnCancel: () => keep });
    expect(h.deps.keepProvisionedOnCancel).toBe(false);
    keep = true;
    expect(h.deps.keepProvisionedOnCancel).toBe(true);
  });
});

describe("retirePreviousRoleContainers", () => {
  const roleRefs = [
    { role: "worker", replica: 1, containerId: "old-w1" },
    { role: "worker", replica: 2, containerId: "old-w2" },
    { role: "sched", replica: 1, containerId: "old-sched" },
  ];
  const previous = (over: Record<string, unknown> = {}) =>
    ({
      id: "dep-old",
      organizationId: "org-1",
      meta: null,
      roleContainers: roleRefs,
      ...over,
    }) as never;

  function setup(destroy: (id: string) => Promise<void> = async () => {}) {
    const logs: { message: string; level: string | undefined }[] = [];
    const destroyed: string[] = [];
    const runtime = {
      destroy: vi.fn(async (id: string) => {
        destroyed.push(id);
        await destroy(id);
      }),
    };
    const withRuntime = vi.fn(async (_dep: unknown, fn: (rt: RuntimeAdapter) => Promise<unknown>) =>
      fn(asRuntime(runtime)),
    );
    const log = (message: string, level?: "info" | "warn") => logs.push({ message, level });
    return { logs, destroyed, runtime, withRuntime, log };
  }

  it("destroys each previous role container once, concurrently", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = setup(() => hold);
    const done = retirePreviousRoleContainers({
      previous: previous(),
      currentDeploymentId: "dep-new",
      log: t.log,
      withRuntime: t.withRuntime as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Every destroy was called while none had resolved.
    expect(t.destroyed.sort()).toEqual(["old-sched", "old-w1", "old-w2"]);
    release();
    await done;
    expect(t.runtime.destroy).toHaveBeenCalledTimes(3);
    expect(t.withRuntime).toHaveBeenCalledTimes(1);
    expect(t.logs.every((l) => l.level !== "warn")).toBe(true);
  });

  it("is a no-op with no predecessor", async () => {
    const t = setup();
    for (const missing of [null, undefined]) {
      await retirePreviousRoleContainers({
        previous: missing,
        currentDeploymentId: "dep-new",
        log: t.log,
        withRuntime: t.withRuntime as never,
      });
    }
    expect(t.withRuntime).not.toHaveBeenCalled();
    expect(t.logs).toEqual([]);
  });

  it("is a no-op when the predecessor is the current deployment", async () => {
    const t = setup();
    await retirePreviousRoleContainers({
      previous: previous({ id: "dep-new" }),
      currentDeploymentId: "dep-new",
      log: t.log,
      withRuntime: t.withRuntime as never,
    });
    expect(t.withRuntime).not.toHaveBeenCalled();
    expect(t.destroyed).toEqual([]);
  });

  it("is a no-op when the predecessor has no role containers", async () => {
    const t = setup();
    for (const roleContainers of [null, []]) {
      await retirePreviousRoleContainers({
        previous: previous({ roleContainers }),
        currentDeploymentId: "dep-new",
        log: t.log,
        withRuntime: t.withRuntime as never,
      });
    }
    expect(t.withRuntime).not.toHaveBeenCalled();
  });

  it("a failing destroy only warns and the rest still run", async () => {
    const t = setup(async (id) => {
      if (id === "old-w1") throw new Error("rm failed");
    });
    await expect(
      retirePreviousRoleContainers({
        previous: previous(),
        currentDeploymentId: "dep-new",
        log: t.log,
        withRuntime: t.withRuntime as never,
      }),
    ).resolves.toBeUndefined();
    expect(t.destroyed.sort()).toEqual(["old-sched", "old-w1", "old-w2"]);
    const warns = t.logs.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("rm failed");
  });

  it("a hanging destroy is bounded and only warns", async () => {
    vi.useFakeTimers();
    try {
      const t = setup((id) => (id === "old-w2" ? new Promise<void>(() => {}) : Promise.resolve()));
      const done = retirePreviousRoleContainers({
        previous: previous(),
        currentDeploymentId: "dep-new",
        log: t.log,
        withRuntime: t.withRuntime as never,
      });
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(done).resolves.toBeUndefined();
      const warns = t.logs.filter((l) => l.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]!.message).toContain("timed out after 40000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a runtime that cannot be resolved only warns", async () => {
    const t = setup();
    const withRuntime = vi.fn(async () => {
      throw new Error("host unreachable");
    });
    await expect(
      retirePreviousRoleContainers({
        previous: previous(),
        currentDeploymentId: "dep-new",
        log: t.log,
        withRuntime: withRuntime as never,
      }),
    ).resolves.toBeUndefined();
    const warns = t.logs.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("host unreachable");
  });

  it("bounds each destroy by the PREVIOUS roles' grace period", async () => {
    vi.useFakeTimers();
    try {
      const t = setup(() => new Promise<void>(() => {}));
      const meta = { roles: [scheduler("sched", { stopGracePeriod: "90s" })] };
      const done = retirePreviousRoleContainers({
        previous: previous({ meta }),
        currentDeploymentId: "dep-new",
        log: t.log,
        withRuntime: t.withRuntime as never,
      });
      // 30s base plus 90s grace is 120s: nothing has timed out at 119s.
      await vi.advanceTimersByTimeAsync(119_000);
      expect(t.logs.filter((l) => l.level === "warn")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await done;
      const warns = t.logs.filter((l) => l.level === "warn");
      expect(warns).toHaveLength(3);
      expect(warns[0]!.message).toContain("timed out after 120000ms");
    } finally {
      vi.useRealTimers();
    }
  });
});
