#!/usr/bin/env tsx
/**
 * Unit Test: Hosted SDK TYPE-LEVEL contracts.
 *
 * These assertions are checked by `tsc`, not at run time. The file compiles
 * under `npm run type-check` (which is how the illegal cases below are proven
 * illegal) and executes as a trivial pass so it can ride the normal unit run.
 *
 * What is pinned here cannot be pinned any other way: every case is about code
 * that MUST NOT COMPILE, and a run-time test can only observe code that did.
 *
 *   1. The two illegal-state inputs are unions, so `{}`, both-branches-at-once,
 *      and a git source without a pinned ref are compile errors rather than a
 *      400 the caller discovers after shipping.
 *   2. JobEvent is a discriminated union, so switching on `type` narrows `data`
 *      with no cast — the line that used to read `data: Record<string, unknown>`
 *      in the payload of the headline docs example.
 *
 * Every `@ts-expect-error` below is an assertion in its own right: if the type
 * ever stops rejecting that shape, the directive becomes unused and tsc fails
 * the build. The test cannot silently rot into a no-op.
 */

import type {
  AgentInput,
  DatasetSource,
  JobEvent,
} from "../../src/hosted/types.ts";

// ---------------------------------------------------------------------------
// 1. DatasetSource — EITHER a pinned git repo OR a local directory
// ---------------------------------------------------------------------------

const gitSource: DatasetSource = {
  git_url: "https://github.com/acme/corpus.git",
  git_ref: "v1.0.0",
};
const dirSource: DatasetSource = { directory: "./corpus" };

// @ts-expect-error an empty publish source does not compile
const emptySource: DatasetSource = {};

// @ts-expect-error git_url together with directory does not compile
const bothSources: DatasetSource = {
  git_url: "https://github.com/acme/corpus.git",
  git_ref: "v1.0.0",
  directory: "./corpus",
};

// @ts-expect-error a git source without git_ref does not compile — an unpinned import is not reproducible
const unpinnedSource: DatasetSource = {
  git_url: "https://github.com/acme/corpus.git",
};

// ---------------------------------------------------------------------------
// 2. AgentInput — EXACTLY ONE source, plus the common fields
// ---------------------------------------------------------------------------

const scriptAgent: AgentInput = {
  name: "my-agent",
  run_command: "my-agent --headless",
  install_script: "curl -fsSL https://acme.dev/install.sh | sh",
};
const dirAgent: AgentInput = {
  name: "my-agent",
  run_command: "my-agent --headless",
  directory: "./agent",
};

// @ts-expect-error install_script together with directory does not compile
const bothAgentSources: AgentInput = {
  name: "my-agent",
  run_command: "my-agent --headless",
  install_script: "sh install.sh",
  directory: "./agent",
};

// @ts-expect-error an agent with no source at all does not compile
const sourcelessAgent: AgentInput = {
  name: "my-agent",
  run_command: "my-agent --headless",
};

// ---------------------------------------------------------------------------
// 3. JobEvent — switching on `type` narrows `data`
// ---------------------------------------------------------------------------

function narrows(event: JobEvent): string {
  switch (event.type) {
    case "trial.settled": {
      // No cast, no optional chaining: task_name is a string on this member.
      const taskName: string = event.data.task_name;
      const status: string = event.data.status;
      // reward is optional and nullable ONLY on the scored path.
      const reward: number | null | undefined = event.data.reward;
      // attempt_phase appears when the settle happened mid-phase.
      const phase: string | null | undefined = event.data.attempt_phase;
      return `${taskName} ${status} ${reward ?? "-"} ${phase ?? "-"}`;
    }
    case "job.created": {
      const datasets: { name: string; version: string }[] = event.data.datasets;
      const trialCount: number = event.data.trial_count;
      return `${datasets.length} ${trialCount}`;
    }
    case "job.completed": {
      const jobId: string = event.data.job_id;
      return jobId;
    }
    case "trial.spend": {
      const lowerBound: number = event.data.live_spent_usd;
      return String(lowerBound);
    }
    default:
      return event.type;
  }
}

function rejectsWrongField(event: JobEvent): void {
  if (event.type === "job.created") {
    // @ts-expect-error job.created carries no trial_id — the union says so
    const trialId: string = event.data.trial_id;
  }
  if (event.type === "trial.running") {
    // @ts-expect-error trial.running carries no reward
    const reward: number = event.data.reward;
  }
}

// Reference every binding so `noUnusedLocals` cannot fire instead of the
// directives above doing their job.
void [
  gitSource,
  dirSource,
  emptySource,
  bothSources,
  unpinnedSource,
  scriptAgent,
  dirAgent,
  bothAgentSources,
  sourcelessAgent,
  narrows,
  rejectsWrongField,
];

console.log("=== Hosted SDK Type-Level Tests ===");
console.log("  ✓ compiled: every @ts-expect-error above rejected an illegal shape");
console.log("\nAll type-level assertions are enforced by tsc (npm run type-check).");
