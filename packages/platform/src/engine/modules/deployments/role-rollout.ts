/**
 * The role rollout: decides the ORDER in which a deployment's worker and
 * scheduler containers are started, checked, handed over, kept or unwound.
 *
 * A deploy with roles runs: release phase, then this module, then the web
 * container's own pipeline, then `commit()` on success or `abort()` on failure.
 * Every side effect (start, verify, stop, restart, destroy) is injected, so the
 * ordering below is testable with fakes and no runtime, container or daemon.
 *
 * THE ORDER, and why:
 *
 *  1. Scalable roles (workers) start BESIDE the previous deployment's
 *     containers. The old ones keep running until `commit()`, so a deploy that
 *     fails leaves the previous version's workers untouched.
 *  2. Those replicas are checked BEFORE any singleton is touched. A broken
 *     worker must never cost the running scheduler its slot.
 *  3. Singleton roles (schedulers, or `singleton: true`) run exactly one
 *     instance, so the handover is stop-first: the previous containers for that
 *     role NAME are stopped and RETAINED (not destroyed), then the new one
 *     starts. A new and an old scheduler must never run together, or every cron
 *     tick fires twice.
 *  4. Any failure destroys what this deployment started, THEN restarts the
 *     retained singletons. Destroy comes first so the old and new singleton are
 *     never both up during the unwind either: a retained singleton is restored
 *     only after every replacement for its role was successfully removed.
 *     A failed or timed-out removal leaves that role stopped and logs the IDs
 *     requiring recovery; settling a request does not prove the process exited.
 *
 * Teardown is CONCURRENT: commit destroys every previous container at once, and
 * the unwind destroys every started container at once (then restarts every
 * retained one at once). Docker's stop waits up to each container's grace
 * period, so one at a time would make a deploy wait N grace periods while the
 * not-yet-stopped old replicas keep taking jobs.
 *
 * Teardown follows the web pipeline's rule (see `bestEffortTeardown` in
 * deploy-pipeline.ts): every unwind and cleanup call is bounded, because a
 * container runtime that never answers must not strand the deploy (#629), and
 * best-effort, because by then the outcome is already decided. The one
 * exception is the singleton stop: it gates the start of the new instance, so
 * its failure FAILS the rollout. A container only counts as retained when its
 * stop actually resolved, mirroring `stopPreviousRetaining`: claiming a
 * retention after a timeout would "restore" something that was never stopped.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { safeErrorMessage, withTimeout, type StackRole } from "@repo/core";
import { DeploymentCancelledError, throwIfDeploymentCancelled } from "./deployment-cancellation";

const ROLE_ROLLOUT_SOURCE = "platform/engine/modules/deployments/role-rollout";

/** Same ceiling as the web pipeline's teardown, for the same reason (#629). */
const DEFAULT_TEARDOWN_TIMEOUT_MS = 30_000;

export interface RoleContainerRef {
  role: string;
  replica: number;
  containerId: string;
}

/** True for kind "scheduler" or `singleton: true`. */
export function isSingletonRole(role: Pick<StackRole, "kind" | "singleton">): boolean {
  return role.kind === "scheduler" || role.singleton === true;
}

/** Expand frozen roles into the replicas to start, in declared order. Null or undefined means none. */
export function planRoleReplicas(roles: readonly StackRole[] | null | undefined): {
  scalable: { role: StackRole; replica: number }[];
  singletons: { role: StackRole; replica: number }[];
} {
  const scalable: { role: StackRole; replica: number }[] = [];
  const singletons: { role: StackRole; replica: number }[] = [];
  for (const role of roles ?? []) {
    if (isSingletonRole(role)) {
      singletons.push({ role, replica: 1 });
      continue;
    }
    const count = Math.max(1, role.replicas ?? 1);
    for (let replica = 1; replica <= count; replica++) scalable.push({ role, replica });
  }
  return { scalable, singletons };
}

export interface RoleRolloutDeps {
  roles: readonly StackRole[] | null | undefined;
  /** The previous deployment's recorded role containers. */
  previous: readonly RoleContainerRef[] | null | undefined;
  /** Start one replica for the NEW deployment and resolve to its container id. */
  startReplica(role: StackRole, replica: number): Promise<string>;
  /** Startup check across the given containers: null when every one stayed up, else a failure detail. */
  verify(containers: readonly RoleContainerRef[]): Promise<string | null>;
  /** Stop must confirm shutdown (or absence), not just a non-running UI status. */
  stopPrevious(containerId: string): Promise<void>;
  startPrevious(containerId: string): Promise<void>;
  destroyPrevious(containerId: string): Promise<void>;
  /** Resolve only once the replacement is gone; reject if removal is uncertain. */
  destroyStarted(containerId: string): Promise<void>;
  log(message: string, level?: "info" | "warn"): void;
  signal?: AbortSignal;
  /** On cancellation, leave every container exactly as it is (the pipeline's keepProvisionedOnCancel). */
  keepProvisionedOnCancel?: boolean;
  /** Bound for each teardown call in commit/abort/unwind. Default 30_000. */
  teardownTimeoutMs?: number;
}

export interface RoleRollout {
  readonly started: readonly RoleContainerRef[];
  /**
   * Retire the previous deployment's containers. Never throws: resolves to a
   * warning for the deploy naming every container it could not remove, or null.
   */
  commit(): Promise<string | null>;
  abort(): Promise<void>;
}

const NOOP_ROLLOUT: RoleRollout = {
  started: [],
  commit: async () => null,
  abort: async () => {},
};

/**
 * The deploy warning for previous containers that commit could not remove. A
 * failed removal does not prove the container still runs, so it says "may".
 */
function retirementWarning(failed: readonly RoleContainerRef[]): string | null {
  if (failed.length === 0) return null;
  const names = failed
    .map((ref) => `${ref.role} replica ${ref.replica} (${ref.containerId.slice(0, 12)})`)
    .join(", ");
  return failed.length === 1
    ? `Previous role container ${names} could not be removed. ` +
        "It may still be running the previous release's code. Remove it manually."
    : `${failed.length} previous role containers could not be removed: ${names}. ` +
        "They may still be running the previous release's code. Remove them manually.";
}

/**
 * Start the deployment's role containers in the order described in the file
 * header. Resolves to a handle whose `commit()` retires the previous
 * deployment's containers and whose `abort()` undoes this rollout. Throws the
 * original error after unwinding when any step fails.
 */
export async function rolloutRoles(deps: RoleRolloutDeps): Promise<RoleRollout> {
  const { signal, log } = deps;
  const teardownTimeoutMs = deps.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
  const plan = planRoleReplicas(deps.roles);
  const previous = deps.previous ?? [];

  if (plan.scalable.length === 0 && plan.singletons.length === 0 && previous.length === 0) {
    return NOOP_ROLLOUT;
  }

  const started: RoleContainerRef[] = [];
  /** Previous singleton containers whose stop resolved: the only ones an unwind may restart. */
  const retained: RoleContainerRef[] = [];

  /** One bounded teardown call; a rejection or a timeout is a warning, never a failure. */
  const bestEffort = async (what: string, run: () => Promise<void>): Promise<boolean> => {
    try {
      await withTimeout(
        run(),
        teardownTimeoutMs,
        `timed out after ${teardownTimeoutMs}ms (the container runtime never answered)`,
      );
      return true;
    } catch (err) {
      observeCaughtError(err, ROLE_ROLLOUT_SOURCE);
      log(`Warning: ${what}: ${safeErrorMessage(err)}`, "warn");
      return false;
    }
  };

  /**
   * Destroy everything this deployment started concurrently, and only once ALL
   * of those settled restart only the retained roles whose replacements are
   * confirmed removed. Unrelated cleanup failures must not block safe restores.
   */
  const unwind = async (): Promise<void> => {
    if (started.length > 0) {
      log(
        `Removing ${started.length} role container${started.length === 1 ? "" : "s"} started by this deploy...`,
      );
    }
    const removed = await Promise.all(
      started.map((ref) =>
        bestEffort(
          `failed to remove role container ${ref.role} ${ref.replica} (${ref.containerId})`,
          () => deps.destroyStarted(ref.containerId),
        ),
      ),
    );
    const uncertainByRole = new Map<string, string[]>();
    started.forEach((ref, index) => {
      if (removed[index]) return;
      const ids = uncertainByRole.get(ref.role) ?? [];
      ids.push(ref.containerId);
      uncertainByRole.set(ref.role, ids);
    });
    const restorable = retained.filter((ref) => {
      const uncertain = uncertainByRole.get(ref.role);
      if (!uncertain) return true;
      log(
        `Rollback incomplete: previous role "${ref.role}" container ${ref.containerId} remains stopped because replacement container(s) ${uncertain.join(", ")} could not be removed. Remove those replacements before restarting the previous container.`,
        "warn",
      );
      return false;
    });
    if (restorable.length > 0) {
      log(
        `Restarting ${restorable.length} previous role container${restorable.length === 1 ? "" : "s"}...`,
      );
    }
    await Promise.all(
      restorable.map((ref) =>
        bestEffort(`failed to restart previous role container ${ref.role} ${ref.replica}`, () =>
          deps.startPrevious(ref.containerId),
        ),
      ),
    );
  };

  const verifyContainers = async (containers: readonly RoleContainerRef[]): Promise<void> => {
    const detail = await deps.verify(containers);
    if (detail !== null) throw new Error(`Role startup check failed: ${detail}`);
  };

  const startOne = async (role: StackRole, replica: number): Promise<RoleContainerRef> => {
    throwIfDeploymentCancelled(signal);
    log(`Starting role ${role.name} replica ${replica}...`);
    const containerId = await deps.startReplica(role, replica);
    const ref: RoleContainerRef = { role: role.name, replica, containerId };
    started.push(ref);
    return ref;
  };

  try {
    // Scalable phase: beside the previous containers, checked before any singleton moves.
    const scalableRefs: RoleContainerRef[] = [];
    for (const { role, replica } of plan.scalable) {
      scalableRefs.push(await startOne(role, replica));
    }
    if (scalableRefs.length > 0) {
      await verifyContainers(scalableRefs);
      throwIfDeploymentCancelled(signal);
    }

    // Singleton phase: stop-first, retaining the old container so a failure can restore it.
    const singletonRefs: RoleContainerRef[] = [];
    for (const { role, replica } of plan.singletons) {
      for (const old of previous.filter((ref) => ref.role === role.name)) {
        // A cancellation must be seen before the old scheduler is stopped, or
        // keepProvisionedOnCancel would leave no scheduler running at all.
        throwIfDeploymentCancelled(signal);
        log(`Stopping previous ${role.name} (kept restorable until this deploy is healthy)...`);
        try {
          await withTimeout(
            deps.stopPrevious(old.containerId),
            teardownTimeoutMs,
            `timed out after ${teardownTimeoutMs}ms (the container runtime never answered)`,
          );
        } catch (err) {
          observeCaughtError(err, ROLE_ROLLOUT_SOURCE);
          throw new Error(
            `Could not stop the previous "${role.name}" container, so a single instance cannot be guaranteed: ${safeErrorMessage(err)}`,
          );
        }
        retained.push(old);
      }
      singletonRefs.push(await startOne(role, replica));
    }
    if (singletonRefs.length > 0) {
      await verifyContainers(singletonRefs);
      throwIfDeploymentCancelled(signal);
    }
  } catch (err) {
    const cancelled = err instanceof DeploymentCancelledError || signal?.aborted === true;
    if (cancelled && deps.keepProvisionedOnCancel) throw err;
    await unwind();
    throw err;
  }

  // Commit and abort are mutually exclusive and idempotent: the first one to run wins.
  let settled = false;

  return {
    started,
    async commit() {
      if (settled) return null;
      settled = true;
      if (previous.length > 0) {
        log(
          `Removing ${previous.length} previous role container${previous.length === 1 ? "" : "s"}...`,
        );
      }
      const removed = await Promise.all(
        previous.map((ref) =>
          bestEffort(`failed to remove previous role container ${ref.role} ${ref.replica}`, () =>
            deps.destroyPrevious(ref.containerId),
          ),
        ),
      );
      return retirementWarning(previous.filter((_, index) => !removed[index]));
    },
    async abort() {
      if (settled) return;
      settled = true;
      await unwind();
    },
  };
}
