import { AppError, NotFoundError, type ActionWorkerEvent } from "@repo/core";
import { repos, type ActionJob, type ActionRun } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { GitHubActionsApi } from "./github-api";

function apiFor(ctx: ExecutionContext, run: ActionRun) {
  if (ctx.organizationId !== run.organizationId) throw new NotFoundError("Actions run");
  if (
    run.controller !== "github" ||
    !run.github ||
    !run.configuration.owner ||
    !run.configuration.repo
  )
    throw new Error("Invalid GitHub run");
  return new GitHubActionsApi(ctx, run.configuration.owner, run.configuration.repo);
}
export async function gitHubArtifacts(ctx: ExecutionContext, run: ActionRun) {
  return (await apiFor(ctx, run).artifacts(run.github!.id))
    .filter((item) => !item.expired)
    .map((item) => ({
      id: item.id,
      name: item.name,
      size: item.size_in_bytes,
      createdAt: item.created_at,
      expiresAt: item.expires_at,
    }));
}
export async function gitHubArtifactDownload(ctx: ExecutionContext, run: ActionRun, id: number) {
  // Artifact IDs are repository-wide: verify this run's membership before signing.
  if (!(await gitHubArtifacts(ctx, run)).some((item) => item.id === id))
    throw new NotFoundError("Actions artifact");
  return apiFor(ctx, run).redirect(`/actions/artifacts/${id}/zip`);
}

/** One step boundary too many in one place: GitHub's raw job log text (and the
 * live runner stdout we journal) marks steps with workflow commands. Sections
 * are the authoritative boundaries; group markers bracket a step's pre-echo
 * (command/env), and annotation tokens carry a message that must survive. */
export class StepLogSplitter {
  private step: string | null = null;

  /** Feed one line; null when the line is pure structure and shows nothing. */
  feed(line: string): { step: string | null; text: string } | null {
    // No `$` anchors: lines keep their trailing newline and JS `$` does not
    // match before one — `.` already stops at the newline.
    const section = line.match(/##\[section\]Starting:\s*(.*)/);
    if (section) {
      this.step = section[1]!.trim() || null;
      return null;
    }
    if (/##\[section\]Finishing:/.test(line)) {
      this.step = null;
      return null;
    }
    // `##[group]<label>` / `##[endgroup]` bracket the pre-step echo; the
    // section header that follows repeats the label, so the marker line adds
    // nothing. Content BETWEEN the markers stays, attributed to the next step.
    if (/##\[(group|endgroup)\]/.test(line)) return null;
    // Annotations (##[error], ##[warning], …) keep their message, drop the token.
    return { step: this.step, text: line.replace(/##\[\w+\]\s?/g, "") };
  }
}

/** Chunk step-tagged log text on line boundaries so a chunk never splits a
 * line and (where possible) never spans two steps. */
function stepTaggedChunks(
  text: string,
  maxBytes: number,
): Array<{ step: string | null; message: string }> {
  const splitter = new StepLogSplitter();
  const chunks: Array<{ step: string | null; message: string }> = [];
  let current: { step: string | null; message: string } | null = null;
  const flush = () => {
    if (current && current.message.trim()) chunks.push(current);
    current = null;
  };
  for (const line of text.split(/(?<=\n)/)) {
    const fed = splitter.feed(line);
    if (!fed) continue;
    if (!current || current.step !== fed.step || Buffer.byteLength(current.message) + Buffer.byteLength(fed.text) > maxBytes) {
      flush();
      current = { step: fed.step, message: fed.text };
    } else current.message += fed.text;
  }
  flush();
  return chunks;
}

export async function gitHubJobEvents(
  ctx: ExecutionContext,
  run: ActionRun,
  job: ActionJob,
  after: number,
) {
  if (job.organizationId !== run.organizationId || job.runId !== run.id)
    throw new NotFoundError("Actions job");
  if (!job.github) throw new Error("Invalid GitHub job");
  // LIVE: the supervisor journals the runner's own stdout while the job runs
  // (secret-masked by the runner before it prints, re-masked by the worker's
  // event redaction), and reconcileSession persists it — stream that. GitHub's
  // completed blob takes over once the job finishes, as the authoritative copy.
  if (!job.finishedAt) {
    const rows = await repos.actions.events(ctx.organizationId, job.id, after);
    const splitter = new StepLogSplitter();
    const events: ActionWorkerEvent[] = [];
    for (const row of rows) {
      const event = row.event;
      if (event.type === "log" && event.message !== undefined) {
        const fed = splitter.feed(event.message);
        if (!fed) continue;
        event.step = fed.step ?? undefined;
        event.message = fed.text;
      }
      events.push(event);
    }
    return {
      events,
      next: rows.length ? rows[rows.length - 1]!.event.sequence : after,
      complete: false,
    };
  }
  const { url } = await apiFor(ctx, run).redirect(`/actions/jobs/${job.github.id}/logs`);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body)
    throw new AppError("GitHub job logs are not available yet", 503, "ACTIONS_LOGS_PENDING");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = 8 * 1024 * 1024 - bytes;
      parts.push(chunk.value.subarray(0, remaining));
      bytes += Math.min(chunk.value.length, remaining);
      if (chunk.value.length > remaining || bytes === 8 * 1024 * 1024) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel();
  }
  const text =
    Buffer.concat(parts).toString("utf8") +
    (truncated ? "\nLog preview limited to 8 MiB. Open GitHub to download the full log.\n" : "");
  const chunks = stepTaggedChunks(text, 16384);
  const events: ActionWorkerEvent[] = chunks.slice(after, after + 200).map((chunk, index) => ({
    version: 1,
    sequence: after + index + 1,
    time: job.finishedAt!.toISOString(),
    type: "log",
    step: chunk.step ?? undefined,
    message: chunk.message,
  }));
  const next = Math.max(after, after + events.length);
  return { events, next, complete: next >= chunks.length };
}
