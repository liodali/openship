import { describe, expect, it, vi } from "vitest";

// github-output reads the persisted live journal through @repo/db and the
// completed blob through GitHubActionsApi; the parser under test here is
// pure. Keep the import chain free of the env bootstrap.
vi.mock("@repo/db", () => ({ repos: { actions: { events: async () => [] } } }));
vi.mock("./github-api", () => ({ GitHubActionsApi: class {} }));
import { StepLogSplitter } from "./github-output";

const TIMESTAMP = "2026-10-18T15:02:13.1234567Z";

/** Shape from GitHub's raw job-log endpoint (and the live runner stdout):
 * timestamped lines, section markers around each step, group markers around
 * the pre-step command echo, annotations inline. */
const SAMPLE = [
  `${TIMESTAMP} ##[group]Run npm ci`,
  `${TIMESTAMP} with:`,
  `${TIMESTAMP}   cache: npm`,
  `${TIMESTAMP} ##[endgroup]`,
  `${TIMESTAMP} ##[section]Starting: Run npm ci`,
  `${TIMESTAMP} npm warn deprecated left-pad@1.3.0: this module is no longer supported`,
  `${TIMESTAMP} added 1200 packages in 34s`,
  `${TIMESTAMP} ##[section]Finishing: Run npm ci`,
  `${TIMESTAMP} ##[section]Starting: Run tests`,
  `${TIMESTAMP} ##[error]Tests failed with exit code 1`,
  `${TIMESTAMP} FAIL src/app.test.ts`,
  `${TIMESTAMP} ##[section]Finishing: Run tests`,
  `${TIMESTAMP} Post job cleanup.`,
].join("\n");

describe("StepLogSplitter", () => {
  it("attributes lines to the open section and drops marker lines", () => {
    const splitter = new StepLogSplitter();
    const fed = SAMPLE.split(/(?<=\n)/).map((line) => splitter.feed(line));
    const visible = fed.flatMap((entry) => (entry ? [entry] : []));

    // Group markers vanish; their content (with:/cache:) survives in the
    // pre-step zone — a streaming splitter cannot look ahead to the section
    // that has not opened yet, and the echo renders right above it.
    expect(visible.map((entry) => entry.text.replace(TIMESTAMP, "").trim())).toEqual([
      "with:",
      "cache: npm",
      "npm warn deprecated left-pad@1.3.0: this module is no longer supported",
      "added 1200 packages in 34s",
      "##[error]Tests failed with exit code 1".replace("##[error]", ""),
      "FAIL src/app.test.ts",
      "Post job cleanup.",
    ]);
    expect(visible.map((entry) => entry.step)).toEqual([
      null,
      null,
      "Run npm ci",
      "Run npm ci",
      "Run tests",
      "Run tests",
      null,
    ]);
  });

  it("is usable line-by-line across calls (the live journal shape)", () => {
    const splitter = new StepLogSplitter();
    expect(splitter.feed("Runner registered. Waiting for GitHub to assign one job.")).toEqual({
      step: null,
      text: "Runner registered. Waiting for GitHub to assign one job.",
    });
    expect(splitter.feed("##[section]Starting: Set up job")).toBeNull();
    expect(splitter.feed("##[group]Run echo hello")).toBeNull();
    const echo = splitter.feed("##[endgroup]");
    expect(echo).toBeNull();
    expect(splitter.feed("hello")).toMatchObject({ step: "Set up job", text: "hello" });
    expect(splitter.feed("##[section]Finishing: Set up job")).toBeNull();
    expect(splitter.feed("done")?.step).toBeNull();
  });

  it("keeps a step with an empty name attribution-free rather than crashing", () => {
    const splitter = new StepLogSplitter();
    expect(splitter.feed("##[section]Starting: ")).toBeNull();
    expect(splitter.feed("output")?.step).toBeNull();
  });
});
