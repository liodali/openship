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
 * ever triggers the same `sweepServerDiscovery(serverId)` the poll runs. Every
 * classification rule (missing vs invalid vs stopped, retention vs removal)
 * stays in exactly one place: the scanner. The worst a spurious event can cost
 * is one extra scan.
 *
 * ── The poll stays; the stream is an edge-triggered accelerator ────────────────
 * The stream carries TRANSITIONS, never state: a dropped connection loses them
 * permanently, a container already down before we connected never emits one.
 * That is why the sweep stays authoritative and every (re)connect itself
 * triggers a sweep.
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
 * than two poll intervals). A lease nobody renews expires ITSELF and drains the
 * subscription — so discovery disable/forget really is off within ~2.5 minutes
 * even if the job's cleanup hook never runs, and a server whose settings flip
 * to disabled loses its out-of-band accelerator structurally.
 */

import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import type { RuntimeAdapter } from "@repo/adapters";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";
import { trackBackgroundWork } from "../../lib/background-work";
import { sweepServerDiscovery } from "./discovery-sweep";

/** How long one renewal vouches for a subscription (container-events: 150s). */
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

/** Burst-coalesced sweep trigger: events schedule, the timer sweeps once. */
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

function scheduleSweep(serverId: string, watcher: DiscoveryWatcher): void {
  if (watcher.debounce) clearTimeout(watcher.debounce);
  watcher.debounce = setTimeout(() => {
    watcher.debounce = null;
    void trackBackgroundWork(
      sweepServerDiscovery(serverId, watcher.organizationId).catch((error) => {
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
        // The runtime never self-reconnects; drop the entry and let the next
        // sweep tick re-arm (≤60s outage — that cadence is the backoff). Every
        // reconnect triggers a fresh sweep via that renewal's first events or
        // the poll itself.
        const watcher = watchers.get(serverId);
        if (watcher) {
          if (watcher.debounce) clearTimeout(watcher.debounce);
          watchers.delete(serverId);
        }
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
  watchers.delete(serverId);
}

/**
 * Renew (or arm) watcher subscriptions for the ENABLED servers; expire leases
 * for everything else. Called at the end of each sweep tick, so:
 *   - no startup hook needed — the first sweep arms;
 *   - a disabled/forgotten server's subscription expires itself within ~2.5min;
 *   - a dead stream re-arms on the next tick (the backoff cadence).
 */
export async function renewDiscoveryWatchers(enabledServerIds: string[]): Promise<void> {
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

/** Stop every watcher (API shutdown / job removal / tests). */
export function stopDiscoveryWatchers(): void {
  for (const [serverId, watcher] of [...watchers]) drainWatcher(serverId, watcher);
}

/** Test seam. */
export function discoveryWatcherCount(): number {
  return watchers.size;
}
