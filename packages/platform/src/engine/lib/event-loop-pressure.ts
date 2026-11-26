/**
 * Event-loop pressure gauge.
 *
 * The API process shares ONE event loop between the HTTP server and every
 * background reconciler (actions controller, health-watch sweeps, notification
 * pollers, Bull workers). When the loop is saturated, interactive request
 * latency collapses first: HTTP requests queue behind the background backlog,
 * session lookups and Redis calls overrun their deadlines, and callers see
 * 15–30s responses, 503 "Authorization unavailable", and rate-limit warnings
 * that are actually loop-starvation artifacts.
 *
 * This module measures loop lag with a cheap drift timer: a timer scheduled
 * every INTERVAL_MS records how late it actually fired. Sustained lateness
 * means the loop cannot keep up.
 *
 *   eventLoopLagMaxMs()  — highest lag sample in the window
 *   isLoopSaturated()    — true while most recent samples exceed the threshold
 *
 * Background loops should consult `isLoopSaturated()` and BACK OFF (skip or
 * defer the pass). It is advisory backpressure, not a correctness gate:
 * critical safety work (incident handling, lease expiry, incident writes)
 * must never gate on it. The gauge starts lazily on first read; its timer is
 * unref'd so it never holds the process open.
 */

const INTERVAL_MS = 250;
const WINDOW = 12; // ~3s of samples
/** A gauge tick ≥10x late means the loop is behind. */
const SATURATION_MS = 250;

let timer: ReturnType<typeof setTimeout> | null = null;
const samples: number[] = [];
let last = 0;

function ensureGauge(): void {
  if (timer) return;
  last = performance.now();
  const drift = () => {
    const now = performance.now();
    const lag = now - last - INTERVAL_MS;
    last = now;
    samples.push(lag);
    if (samples.length > WINDOW) samples.shift();
    timer = setTimeout(drift, INTERVAL_MS);
    timer.unref?.();
  };
  timer = setTimeout(drift, INTERVAL_MS);
  timer.unref?.();
}

/** Highest loop-lag sample in the window (ms). 0 until the gauge warms up. */
export function eventLoopLagMaxMs(): number {
  ensureGauge();
  return samples.length ? Math.max(...samples) : 0;
}

/**
 * True while the loop has failed to keep up with the 250ms gauge across at
 * least half the recent window. Reports false during warm-up (first window)
 * so a cold start never reads as saturation.
 */
export function isLoopSaturated(thresholdMs = SATURATION_MS): boolean {
  ensureGauge();
  if (samples.length < WINDOW) return false;
  let late = 0;
  for (const lag of samples) if (lag >= thresholdMs) late++;
  return late >= WINDOW / 2;
}
