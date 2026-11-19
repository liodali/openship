/**
 * The gate for the real-daemon E2E suite.
 *
 * These four files are the only proof that rollback and restore work against
 * Docker rather than against mocks, and they were green-by-accident: the gate was
 * `describe.skipIf(!existsSync(resolveLocalDockerSocketPath()))`, so on any box
 * whose daemon isn't at `/var/run/docker.sock` — Colima, Rancher Desktop, Podman,
 * rootless — every case reported skipped, the file reported pass, and nobody
 * could tell "rollback works" from "rollback was never exercised".
 *
 * Two changes make silence impossible:
 *
 *   - `RUN_DOCKER_E2E=1` (what CI sets) makes a missing daemon a HARD FAILURE.
 *     The suite still runs, `requireDocker()` throws in `beforeAll`, and the job
 *     goes red with the resolved socket path in the message.
 *   - Without it, the suite skips — but prints the reason it skipped, so a
 *     developer sees "no daemon at /var/run/docker.sock" instead of nothing.
 *
 * Reachability is probed with the product's own `assertReachable()`, at module
 * load, via top-level await: a stale socket FILE is not a running daemon, and the
 * describe-selection below has to be decided before collection.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe } from "vitest";
import { DockerRuntime, resolveLocalDockerSocketPath } from "@repo/adapters";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** CI sets this. It converts "no daemon" from a skip into a failure. */
export const DOCKER_E2E_REQUIRED = process.env.RUN_DOCKER_E2E === "1";

/** The socket the product itself would dial (explicit → DOCKER_HOST → context → default). */
export const dockerSocketPath = resolveLocalDockerSocketPath();

async function probeDaemon(): Promise<string | null> {
  if (!existsSync(dockerSocketPath)) {
    return `no Docker socket at ${dockerSocketPath}`;
  }
  let runtime: DockerRuntime | null = null;
  try {
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.assertReachable();
    return null;
  } catch (err) {
    return `Docker socket ${dockerSocketPath} is not answering: ${
      err instanceof Error ? err.message : String(err)
    }`;
  } finally {
    await runtime?.dispose().catch(() => {});
  }
}

const unreachableReason = await probeDaemon();

if (unreachableReason && !DOCKER_E2E_REQUIRED) {
  console.warn(
    `[docker-e2e] SKIPPING real-daemon E2E: ${unreachableReason}. ` +
      `Set RUN_DOCKER_E2E=1 to make this a failure instead.`,
  );
}

/**
 * `describe` for a real-daemon suite. Skips when no daemon is reachable — unless
 * `RUN_DOCKER_E2E=1`, in which case the suite runs so `requireDocker()` can fail
 * it out loud.
 */
export const describeDockerE2E =
  DOCKER_E2E_REQUIRED || !unreachableReason ? describe : describe.skip;

/**
 * Call first in `beforeAll`. Throws when the daemon is unreachable, which under
 * `RUN_DOCKER_E2E=1` is the whole point: the CI job must not be able to pass by
 * not testing anything.
 */
export async function requireDocker(): Promise<void> {
  if (!unreachableReason) return;
  throw new Error(
    `RUN_DOCKER_E2E=1 but no Docker daemon is reachable — ${unreachableReason}. ` +
      `Start a daemon, or select its \`docker context\` / set DOCKER_HOST if it ` +
      `isn't at the default socket.`,
  );
}

/**
 * The OpenResty the edge ACTUALLY ships, for the real-image E2E suites — read
 * from the Dockerfile so a base bump can never leave them testing a version
 * nothing ships.
 *
 * Two regimes, detected from the file itself:
 *  - Normal: the first FROM is the pullable base image; return it verbatim.
 *  - Interim from-source build (nginx 1.31.9 CVE fixes, openresty#1166 — the
 *    official 1.31.9.1 image is unpublished): the first FROM is the alpine
 *    BUILDER, and the openresty the edge ships is compiled in the
 *    `openresty-build` stage. Build THAT stage (`docker build --target`,
 *    layer-cached across runs) and return its tag, so the suites still test
 *    the shipping nginx. When the Dockerfile returns to a single pullable
 *    FROM, this falls back to reading it — no test edit needed.
 */
export async function edgeBaseImage(): Promise<string> {
  const dockerfile = await readFile(join(REPO_ROOT, "apps", "edge", "Dockerfile"), "utf8");
  if (/^FROM\s+\S+\s+AS\s+openresty-build\b/mi.test(dockerfile)) {
    const tag = "openship-edge-e2e:openresty-build";
    await execFileAsync(
      "docker",
      [
        "build", "--target", "openresty-build",
        "-t", tag,
        "-f", join(REPO_ROOT, "apps", "edge", "Dockerfile"),
        REPO_ROOT,
      ],
      // A cold compile of OpenSSL + PCRE2 + OpenResty takes minutes; cached
      // rebuilds are seconds. The output is voluminous (make -j).
      { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    return tag;
  }
  const from = dockerfile.match(/^FROM\s+(\S+)/m)?.[1];
  if (!from) throw new Error("apps/edge/Dockerfile has no FROM line");
  return from;
}
