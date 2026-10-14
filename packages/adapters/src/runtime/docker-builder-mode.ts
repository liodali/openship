/**
 * Builder selection for the dockerode (Engine API) build path.
 *
 * Three modes, resolved once per build from `OPENSHIP_BUILDER_MODE`:
 *
 *   auto     (default) — BuildKit only when the Dockerfile needs it
 *                        (RUN --mount, a syntax directive, a heredoc), with an
 *                        automatic fallback to the classic builder when the
 *                        daemon cannot serve BuildKit's `/session` endpoint.
 *   classic  — never send `version=2`. For OCI-compatible daemons that
 *             implement the Engine API but not dockerd's embedded BuildKit
 *             (Podman's compat socket is the common case).
 *   buildkit — always send `version=2`, even for a plain Dockerfile.
 *
 * Why a fallback belongs here rather than in the caller's error handling:
 * BuildKit-over-API needs TWO things dockerd happens to provide and other
 * daemons don't — the `/session` reverse-h2c endpoint (credentials) and the
 * `version=2` build path itself. A daemon that 404s `/session` fails the build
 * BEFORE the first layer compiles, with an error that names neither BuildKit
 * nor a fix ("docker /session failed: 404"). Falling back to the classic
 * builder turns that into a slower-but-correct build plus one warning line.
 *
 * The mode is deliberately NOT a per-project setting: which builder a daemon
 * can serve is a property of the DAEMON, not of the image being built.
 */

/** Env var that overrides builder selection for the Engine API path. */
export const DOCKER_BUILDER_MODE_ENV = "OPENSHIP_BUILDER_MODE";

export type DockerodeBuilderMode = "auto" | "classic" | "buildkit";

export function resolveDockerodeBuilderMode(
  raw: string | undefined = process.env[DOCKER_BUILDER_MODE_ENV],
): DockerodeBuilderMode {
  const value = raw?.trim().toLowerCase();
  return value === "classic" || value === "buildkit" ? value : "auto";
}

/**
 * Did this build failure mean "the daemon has no BuildKit session endpoint"?
 *
 * Podman (any 5.x) implements the Docker compat API but not `/session` — that
 * endpoint lives in dockerd's embedded buildkit. The failure surfaces before
 * the build starts, either from OpenShip's own raw-upgrade path
 * ("docker /session failed: 404 …", via docker-exec-stream) or, on a
 * stock-node dockerode, as the modem's `(HTTP code 404)` dial error. Both
 * shapes are matched narrowly: a 404 on a DIFFERENT endpoint must never
 * demote a build to the classic builder.
 */
export function isBuildKitSessionUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  if (/docker \/session failed: 40[45]/.test(message)) return true;
  return /\(HTTP code 404\)/i.test(message) && /\bsession\b/i.test(message);
}
