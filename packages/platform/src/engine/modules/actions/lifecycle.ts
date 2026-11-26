import { diagnostics } from "@repo/core/diagnostics";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { nativeJobsEnabled } from "../../native/execution-policy";
import { trackBackgroundWork } from "../../lib/background-work";
import { isLoopSaturated } from "../../lib/event-loop-pressure";
import { actionController } from "./execution";

let timer: ReturnType<typeof setTimeout> | undefined;
let current: Promise<void> | undefined;
let shutdown: AbortController | undefined;
let stopped = true;
let schedulesAt = 0;
let poolsReady = false;
let retentionAt = 0;
let runnerProbeAt = 0;
/** Runner heartbeat cadence — long enough that an idle estate pays one SSH
 * connect per destination per pass, short enough that `checkedAt` answers
 * "is this runner alive" between config edits. */
const RUNNER_PROBE_MS = 5 * 60_000;

/**
 * Tick cadence. The controller shares the process event loop with the HTTP
 * server, so a fixed fast tick is a liability: when a pass is expensive
 * (slow GitHub, busy loop, GC pressure) a 3s period keeps the loop pegged and
 * interactive requests starve — which is exactly the "dashboard takes 20s +
 * random 503s" failure mode. So the wait is derived from observed pressure:
 *
 *   - never shorter than TICK_MIN_MS (the old 3s cadence, preserved)
 *   - never shorter than the pass itself took (self-pacing: the period is
 *     at least the work — a slow pass schedules a slower next pass)
 *   - while the loop is SATURATED, at least TICK_SATURATED_MS, so
 *     interactive traffic wins the loop and background throughput is what
 *     gets sacrificed first
 *   - never longer than TICK_MAX_MS, so work still progresses
 */
const TICK_MIN_MS = 3_000;
const TICK_MAX_MS = 30_000;
const TICK_SATURATED_MS = 15_000;

export async function assertActionsTransferReady(): Promise<void> {
  if (
    (await repos.actions.unsettledRunCount()) ||
    (await repos.actions.runnerSessions()).length ||
    (await repos.actions.pendingActionDeploymentCount())
  )
    throw new AppError(
      "Finish or cancel queued automatic deployments and active Actions runs before moving this instance. Their artifact connections must stay on the current controller until cleanup finishes.",
      409,
      "ACTIONS_INSTANCE_MOVE_BUSY",
    );
}
/** Only the active API/native controller starts this reconciler. Durable leases
 * arbitrate replicas; stopping this process does not kill destination workers. */
export function startActionController(): void {
  if (!stopped || !nativeJobsEnabled()) return;
  stopped = false;
  poolsReady = false;
  const abort = (shutdown = new AbortController());
  const tick = () => {
    if (stopped) return;
    const tickStartedAt = Date.now();
    current = trackBackgroundWork(
      (async () => {
        await (await import("./deployment-gate")).actionDeploymentController.tick();
        if (Date.now() - schedulesAt > 30_000) {
          schedulesAt = Date.now();
          if (!poolsReady) {
            try {
              await (await import("./cloud-runner")).ensureConfiguredActionPools();
              poolsReady = true;
            } catch (error) {
              diagnostics.warn("actions/pools", "Actions pool configuration failed", error);
            }
          }
          await (await import("./triggers")).dispatchActionSchedules();
          await (await import("./storage")).actionStorageProtocol().sweep();
          if (Date.now() - runnerProbeAt > RUNNER_PROBE_MS) {
            runnerProbeAt = Date.now();
            // Refreshes `checkedAt` so it stays a liveness signal; per-runner
            // failures land on the runner row instead of failing this sweep.
            await (await import("./runner.service"))
              .probeActionRunnerSweep()
              .catch((error) =>
                diagnostics.warn("actions/controller", "Runner heartbeat sweep failed", error),
              );
          }
          if (Date.now() - retentionAt > 3_600_000) {
            const cutoff = new Date(Date.now() - 30 * 86_400_000);
            await repos.actions.pruneDeliveries(cutoff);
            await repos.actions.pruneRuns(cutoff);
            retentionAt = Date.now();
          }
        }
        if (abort.signal.aborted) return;
        await repos.actions.settleGitHubObserverDeliveries();
        await (await import("./triggers")).actionWebhookInbox.tick();
        await actionController.tick(abort.signal);
        if (!abort.signal.aborted)
          await (await import("./github-sync")).reconcileGitHubWorkflows(abort.signal);
        if (!abort.signal.aborted)
          await (await import("./github-runners")).reconcileGitHubRunners(abort.signal);
      })().catch((error) => diagnostics.warn("actions/controller", "Actions sweep failed", error)),
    );
    void current.finally(() => {
      current = undefined;
      if (!stopped) {
        const took = Math.max(0, Date.now() - tickStartedAt);
        const saturated = isLoopSaturated();
        const wait = Math.min(
          TICK_MAX_MS,
          Math.max(TICK_MIN_MS, took, saturated ? TICK_SATURATED_MS : 0),
        );
        if (saturated) {
          diagnostics.warn(
            "actions/controller",
            `Event loop saturated; deferring next actions pass by ${wait}ms`,
          );
        }
        timer = setTimeout(tick, wait);
        timer.unref?.();
      }
    });
  };
  timer = setTimeout(tick, 0);
  timer.unref?.();
}
export async function stopActionController(timeoutMs?: number): Promise<void> {
  stopped = true;
  shutdown?.abort();
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!current) return;
  // Instance moves wait for full quiescence. Process shutdown can abandon this
  // controller's inspection after its grace period; the remote journal and DB
  // lease let its successor resume without replaying the running job.
  if (timeoutMs === undefined) {
    await current;
    return;
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      current,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}
