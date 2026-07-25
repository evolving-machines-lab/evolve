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
 *      and a git source without a ref are compile errors rather than a 400 the
 *      caller discovers after shipping.
 *   2. JobEvent is a discriminated union, so switching on `type` narrows `data`
 *      with no cast — the line that used to read `data: Record<string, unknown>`
 *      in the payload of the headline docs example.
 *
 * Every `@ts-expect-error` below is an assertion in its own right: if the type
 * ever stops rejecting that shape, the directive becomes unused and tsc fails
 * the build. The test cannot silently rot into a no-op.
 */

import type {
  BenchmarkImportSource,
  CustomHarnessInput,
  JobEvent,
} from "../../src/hosted/types.ts";

// ---------------------------------------------------------------------------
// 1. BenchmarkImportSource — EITHER a pinned git repo OR a local directory
// ---------------------------------------------------------------------------

const gitSource: BenchmarkImportSource = {
  gitUrl: "https://github.com/acme/corpus.git",
  ref: "v1.0.0",
};
const dirSource: BenchmarkImportSource = { directory: "./corpus" };

// @ts-expect-error an empty import source does not compile
const emptySource: BenchmarkImportSource = {};

// @ts-expect-error gitUrl together with directory does not compile
const bothSources: BenchmarkImportSource = {
  gitUrl: "https://github.com/acme/corpus.git",
  ref: "v1.0.0",
  directory: "./corpus",
};

// @ts-expect-error a git source without ref does not compile — an unpinned import is not reproducible
const unpinnedSource: BenchmarkImportSource = {
  gitUrl: "https://github.com/acme/corpus.git",
};

// ---------------------------------------------------------------------------
// 2. CustomHarnessInput — EXACTLY ONE source, plus the common fields
// ---------------------------------------------------------------------------

const scriptHarness: CustomHarnessInput = {
  name: "my-harness",
  runCommand: "my-harness --headless",
  installScript: "curl -fsSL https://acme.dev/install.sh | sh",
};
const dirHarness: CustomHarnessInput = {
  name: "my-harness",
  runCommand: "my-harness --headless",
  directory: "./harness",
};

// @ts-expect-error installScript together with directory does not compile
const bothHarnessSources: CustomHarnessInput = {
  name: "my-harness",
  runCommand: "my-harness --headless",
  installScript: "sh install.sh",
  directory: "./harness",
};

// @ts-expect-error a harness with no source at all does not compile
const sourcelessHarness: CustomHarnessInput = {
  name: "my-harness",
  runCommand: "my-harness --headless",
};

// ---------------------------------------------------------------------------
// 3. JobEvent — switching on `type` narrows `data`
// ---------------------------------------------------------------------------

function narrows(event: JobEvent): string {
  switch (event.type) {
    case "trial.settled": {
      // No cast, no optional chaining: taskKey is a string on this member.
      const taskKey: string = event.data.taskKey;
      const status: string = event.data.status;
      // reward is optional and nullable ONLY on the scored path.
      const reward: number | null | undefined = event.data.reward;
      return `${taskKey} ${status} ${reward ?? "-"}`;
    }
    case "job.created": {
      const benchmark: string = event.data.benchmark;
      const trialCount: number = event.data.trialCount;
      return `${benchmark} ${trialCount}`;
    }
    case "job.completed": {
      const jobId: string = event.data.jobId;
      return jobId;
    }
    case "trial.scoring": {
      const bytes: number = event.data.capturedBytes;
      return String(bytes);
    }
    default:
      return event.type;
  }
}

function rejectsWrongField(event: JobEvent): void {
  if (event.type === "job.created") {
    // @ts-expect-error job.created carries no trialId — the union says so
    const trialId: string = event.data.trialId;
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
  scriptHarness,
  dirHarness,
  bothHarnessSources,
  sourcelessHarness,
  narrows,
  rejectsWrongField,
];

console.log("=== Hosted SDK Type-Level Tests ===");
console.log("  ✓ compiled: every @ts-expect-error above rejected an illegal shape");
console.log("\nAll type-level assertions are enforced by tsc (npm run type-check).");
