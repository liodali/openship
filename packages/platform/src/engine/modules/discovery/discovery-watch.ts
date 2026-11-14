/**
 * Container lifecycle events as an ACCELERATOR for the discovery sweep.
 *
 * The sweep polls every enabled server once a minute; the daemon already knows
 * the instant a container starts, stops, or dies. We listen — and turn a burst
 * of transitions into "sweep that one server now", cutting detection latency
 * from up to 60s to ~2s for the cases that matter (a container coming up should
 * route and certify promptly; going down should retain its vhost promptly).
 *
 * ── What this module deliberately does NOT do ─────────────────────────────────
 * It never classifies events. A `die` is a crash, a `docker stop`, and a
 * redeploy alike, and the event carries no discovery state — so an event only
 * ever triggers the same `sweepServerDiscovery(serverId)` the poll runs, with
 * FRESH inventory (the event exists because state just changed). Every
 * classification rule (missing vs invalid vs stopped, retention vs removal)
 * stays in exactly one place: the scanner. The worst a spurious event can cost
 * is one extra scan.
 *
 * ── The poll stays; the stream is an edge-triggered accelerator ────────────────
 * The stream carries TRANSITIONS, never state: a dropped connection loses them
 * permanently, a container already down before we connected never emits one at
 * all. That is why the sweep stays authoritative and every (re)connect itself
 * triggers a fresh sweep.
 *
 * ── Reconnect / backoff / visible status ─────────────────────────────────────
 * The runtime deliberately does not reconnect on its own (see
 * `watchContainerEvents`). `renewDiscoveryWatchers()` runs at the END of every
 * sweep tick with the enabled server ids: dead subscriptions are re-armed on
 * the next tick (≤60s outage — that cadence IS the backoff), unsupported
 * runtimes (`supports("containerEvents")`) simply never get a watcher and run
 * on the poll alone, and scan health stays visible through the settings row's
 * `lastScanAt`/`lastScanError` exactly as for poll-only servers.
 *
 * ── The lease ────────────────────────────────────────────────────────────────
 * Each renewal vouches for its subscriptions for LEASE_MS (comfortably more
 * than two poll intervals). A lease nobody renews expires ITSELF — via a timer
 * per renewal, deliberately not a check on the next sweep, because the case
 * that matters most is the one where there is no next sweep (the job died or
 * was removed). One mechanism buys all of:
 *   - no startup hook — the first sweep after boot subscribes;
 *   - discovery disable/forget really is off: an expired subscription is
 *     drained, so it cannot keep sweeping out of band;
 *   - a server whose settings flip disabled loses its accelerator on its own.
 *
 * ── Shutdown ─────────────────────────────────────────────────────────────────
 * `fenceDiscoveryWatchers()` (from API shutdown, BEFORE the job runner, SSH
 * pool, and database close) fences renewals and drains every subscription, so
 * watchers cannot schedule sweeps against resources that are closing.
 */

import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import type { RuntimeAdapter } from "@repo/adapters";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";
import { trackBackgroundWork } from "../../lib/background-work";
import { sweepServerDiscovery } from "./discovery-sweep";

/** How long one renewal vouches for a group (container-events: 150s). */
const LEASE_MS = 150_000;
/** Burst coalescing: one `docker stop` emits kill+die+stop; one sweep answers all. */
const DEBOUNCE_MS = 1_500;

interface DiscoveryWatcher {
  /** Drains the runtime's event subscription. */
  cleanup: () => void;
  /** The held-open runtime (long-lived loopback/SSH for remote boxes). */
  runtime: RuntimeAdapter;
  leasedUntil: number;
  /** Pending debounced sweep timer for this server. */
  debounce: NodeJS.Timeout | null;
  /**
   * Self-expiry: armed per renewal, fires if nobody renews. Deliberately a
   * timer, not a check on the next sweep — the case that matters most is the
   * one where there is no next sweep (the job died or was removed).
   */
  expiry: NodeJS.Timeout;
  /** The org the subscription was armed under (sweeps need it). */
  organizationId: string;
}

const watchers = new Map<string, DiscoveryWatcher>();

/**
 * Shutdown fence: once set, renewals become no-ops (no renewal, no re-arm —
 * a sweep draining on the runner must not resurrect subscriptions) and every
 * live subscription drains. Wired from API shutdown BEFORE the job runner,
 * SSH pool, and database close, so watchers cannot schedule sweeps against
 * resources that are closing.
 */
let fenced = false;

function armExpiry(serverId: string, watcher: DiscoveryWatcher): NodeJS.Timeout {
  const timer = setTimeout(() => {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-watch",
      `[discovery-watch] watcher lease for ${serverId} expired; draining subscription`,
    );
    drainWatcher(serverId, watcher);
  }, LEASE_MS + 5_000);
  timer.unref?.();
  return timer;
}

/** Burst-coalesced sweep trigger: events schedule, the timer sweeps once. */
function scheduleSweep(serverId: string, watcher: DiscoveryWatcher): void {
  if (watcher.debounce) clearTimeout(watcher.debounce);
  watcher.debounce = setTimeout(() => {
    watcher.debounce = null;
    // Events are the accelerator precisely because state JUST changed: the
    // sweep must read fresh inventory, never reconcile the last poll's cache.
    void trackBackgroundWork(
      sweepServerDiscovery(serverId, watcher.organizationId, { fresh: true }).catch((error) => {
        errorDiagnostics.warn(
          "platform/engine/modules/discovery/discovery-watch",
          `[discovery-watch] event-triggered sweep failed for ${serverId}: ${safeErrorMessage(error)}`,
        );
      }),
    );
  }, DEBOUNCE_MS);
  watcher.debounce.unref?.();
}

async function armWatcher(serverId: string, organizationId: string): Promise<void> {
  const existing = watchers.get(serverId);
  if (existing) {
    existing.leasedUntil = Date.now() + LEASE_MS;
    clearTimeout(existing.expiry);
    existing.expiry = armExpiry(serverId, existing);
    return; // live subscription: just renew the lease
  }

  let runtime: RuntimeAdapter | undefined;
  try {
    runtime = await createServerDockerRuntime(serverId, organizationId);
    if (!runtime.watchContainerEvents || !runtime.supports("containerEvents")) {
      // Unsupported stream (cloud/bare/old edge): the poll alone is the design,
      // not a degradation to report.
      return;
    }
    const cleanup = await runtime.watchContainerEvents({
      onEvent: () => {
        const watcher = watchers.get(serverId);
        if (!watcher) return; // drained mid-burst
        scheduleSweep(serverId, watcher);
      },
      onClose: (err) => {
        // The runtime never self-reconnects; drop THIS instance (clearing its
        // stale expiry timer and runtime) and let the next sweep tick re-arm
        // (≤60s outage — that cadence is the backoff). The re-arm's own arming
        // sweep reads fresh inventory.
        const watcher = watchers.get(serverId);
        if (watcher) dropClosedWatcher(serverId, watcher);
        if (err) {
          errorDiagnostics.warn(
            "platform/engine/modules/discovery/discovery-watch",
            `[discovery-watch] event stream for ${serverId} closed: ${safeErrorMessage(err)}; will re-arm on the next sweep tick`,
          );
        }
      },
    });
    const watcher: DiscoveryWatcher = {
      cleanup,
      runtime,
      leasedUntil: Date.now() + LEASE_MS,
      debounce: null,
      expiry: undefined as unknown as NodeJS.Timeout,
      organizationId,
    };
    watcher.expiry = armExpiry(serverId, watcher);
    watchers.set(serverId, watcher);
    // A fresh subscription (boot, or reconnect after an outage) missed every
    // transition while it was down: sweep once, with fresh inventory.
    scheduleSweep(serverId, watcher);
  } catch (error) {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-watch",
      `[discovery-watch] could not arm event watcher for ${serverId}: ${safeErrorMessage(error)}`,
    );
  } finally {
    // The watch holds the runtime open (long-lived loopback/SSH for remote
    // boxes) — only dispose when the subscription could NOT be established.
    if (runtime && !watchers.has(serverId)) {
      await runtime.dispose?.().catch(() => {});
    }
  }
}

function drainWatcher(serverId: string, watcher: DiscoveryWatcher): void {
  if (watcher.debounce) clearTimeout(watcher.debounce);
  clearTimeout(watcher.expiry);
  try {
    watcher.cleanup();
  } catch (error) {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-watch",
      `[discovery-watch] cleanup failed for ${serverId}: ${safeErrorMessage(error)}`,
    );
  }
  void watcher.runtime.dispose?.().catch(() => {});
  // Identity guard: a re-armed replacement may already occupy this key (this
  // call can come from a stale expiry timer that outlived its instance).
  // Never drain the replacement.
  if (watchers.get(serverId) === watcher) watchers.delete(serverId);
}

/**
 * Drop a watcher whose STREAM CLOSED (its cleanup already ran — the contract
 * fires onClose at most once and not after cleanup). Clears the stale expiry
 * timer and disposes the held runtime, with the same identity guard: the old
 * instance must never delete or dispose the re-armed replacement.
 */
function dropClosedWatcher(serverId: string, watcher: DiscoveryWatcher): void {
  if (watcher.debounce) clearTimeout(watcher.debounce);
  clearTimeout(watcher.expiry);
  if (watchers.get(serverId) === watcher) watchers.delete(serverId);
  void watcher.runtime.dispose?.().catch(() => {});
}

/**
 * Renew (or arm) watcher subscriptions for the ENABLED servers; expire leases
 * for everything else. Called at the end of each sweep tick, so:
 *   - no startup hook needed — the first sweep arms;
 *   - a disabled/forgotten server's subscription expires itself within ~2.5min;
 *   - a dead stream re-arms on the next tick (the backoff cadence).
 */
export async function renewDiscoveryWatchers(enabledServerIds: string[]): Promise<void> {
  if (fenced) return; // shutdown: renewal would re-arm against closing resources
  const enabled = new Set(enabledServerIds);
  const now = Date.now();

  for (const serverId of enabled) {
    const existing = watchers.get(serverId);
    if (existing) {
      existing.leasedUntil = now + LEASE_MS;
      clearTimeout(existing.expiry);
      existing.expiry = armExpiry(serverId, existing);
      continue;
    }
    const server = await repos.server.get(serverId);
    if (!server?.organizationId) continue; // orphaned/tenant-less: poll alone, reported
    await armWatcher(serverId, server.organizationId);
  }

  const expired: string[] = [];
  for (const [serverId, watcher] of watchers) {
    if (!enabled.has(serverId) || watcher.leasedUntil <= now) {
      drainWatcher(serverId, watcher);
      expired.push(serverId);
    }
  }
  if (expired.length > 0) {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-watch",
      `[discovery-watch] expired watcher leases: ${expired.join(", ")}`,
    );
  }
}

/** Stop every watcher (job removal / tests). */
export function stopDiscoveryWatchers(): void {
  for (const [serverId, watcher] of [...watchers]) drainWatcher(serverId, watcher);
}

/**
 * The production shutdown entry: fence renewals FIRST (a sweep still draining
 * on the runner must not re-arm), then drain every subscription, pending
 * debounce, and held runtime. Call BEFORE the job runner, SSH manager, and
 * database close (apps/api/src/server.ts).
 */
export function fenceDiscoveryWatchers(): void {
  fenced = true;
  stopDiscoveryWatchers();
}

/** Clear the shutdown fence (tests; a fresh process is never fenced). */
export function unfenceDiscoveryWatchers(): void {
  fenced = false;
}

/** Test seam. */
export function discoveryWatcherCount(): number {
  return watchers.size;
}
