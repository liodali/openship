/**
 * Fork marker — a quiet tag beneath the sidebar account identifying this
 * dashboard as OUR build (liodali/openship), not an upstream release.
 *
 * Fork-specific UI lives in its own file on purpose: the daily upstream merge
 * (fork-sync.yml) never conflicts with a file upstream doesn't have, and
 * scripts/fork/patch-guard.mjs checks that the sidebar still mounts it. If
 * upstream ever grows its own edition/badge concept, take theirs, delete this
 * file, and drop that check from the guard.
 */
export function ForkBadge() {
  return (
    <span
      className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
      title="liodali/openship — fork build"
    >
      fork
    </span>
  );
}
