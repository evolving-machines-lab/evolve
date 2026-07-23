# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY`. Evolve runs the benchmark tasks, agents, and verifiers on managed infrastructure; you submit an evaluation and read results.

Hosted evals run agent systems (harness + model) against versioned benchmarks on Evolve's infrastructure. Two standalone clients cover the whole surface — no `Evolve` instance needed:

- `benchmarks()` — the shared benchmark catalog: list, inspect, and import benchmarks.
- `evaluations()` — create evaluations, watch progress live, inspect task runs and traces, compare, and export results.

```ts
import { benchmarks, evaluations } from "@evolvingmachines/sdk";

const b = benchmarks();   // Uses EVOLVE_API_KEY (or pass { apiKey, dashboardUrl })
const e = evaluations();
```

## Quickstart

Run `deep-swe` with two agent systems, watch it live, then export the results archive:

```ts
import { evaluations, benchmarks } from "@evolvingmachines/sdk";

// 1. Pick a benchmark from the catalog
const deepSwe = await benchmarks().get("deep-swe"); // active version + task list
console.log(deepSwe.activeVersion?.version, deepSwe.tasks?.length);

// 2. Create the evaluation
const e = evaluations();
const evaluation = await e.run({
    benchmark: "deep-swe@1.1",
    agentSystems: [
        { harness: "codex", model: "gpt-5.5" },
        { harness: "claude", model: "fable" },
    ],
    runsPerTask: 1,
    concurrency: 4,
    maxModelSpendUsd: 25,
});
console.log(evaluation.id, evaluation.status); // "QUEUED"

// 3. Watch until terminal (SSE stream with automatic resume)
const final = await e.watch(evaluation.id, {
    onEvent: (event) => console.log(event.seq, event.type, event.data),
});
console.log(final.status, final.taskRunCounts, final.spentUsd);

// 4. Inspect task runs and export the full research archive
const page = await e.taskRuns(evaluation.id);
for (const run of page.taskRuns) {
    console.log(run.taskKey, run.agentSystem.harness, run.status, run.score);
}

const path = await e.export(evaluation.id, { to: "./results" });
console.log("Saved:", path); // ./results/evaluation-<id>-export.json.gz
```

---

## Evaluation Inputs

`evaluations().run()` takes six inputs, plus an optional per-run spend cap:

| Input | Required | Description |
|-------|----------|-------------|
| `benchmark` | yes | Benchmark reference `"name@version"` (e.g. `"deep-swe@1.1"`) |
| `agentSystems` | yes | Array of `{ harness, model, harnessVersion? }` to evaluate |
| `tasks` | no | Task keys to run — omit to run every task of the version |
| `runsPerTask` | no | Runs per task × agent system (default: 1) |
| `concurrency` | no | Parallel task runs (default: 1) |
| `maxModelSpendUsd` | yes | Hard model-spend cap in USD for the whole evaluation |
| `maxModelSpendUsdPerTaskRun` | no | Model-spend cap in USD for each individual task run |

An evaluation expands to `tasks × agentSystems × runsPerTask` task runs. Each task run executes in its own sandbox with a capped, revocable model credential; spend is tracked against both caps.

```ts
interface AgentSystem {
    harness: string;          // e.g. "codex", "claude"
    model: string;            // e.g. "gpt-5.5", "fable"
    harnessVersion?: string;  // (optional) pin a harness version; omit for the platform default
}
```

The harness version actually used for a run is reported back on the task run detail (`harnessVersionResolved`), so unpinned runs remain reproducible after the fact.

### Idempotency

`run()` and `rerunFailed()` accept an `Idempotency-Key`. Retrying with the same key returns the original evaluation (marked `idempotentReplay: true`) instead of creating a duplicate:

```ts
const evaluation = await e.run(input, { idempotencyKey: "nightly-2026-07-22" });
```

---

## Statuses

**Evaluation** (`Evaluation.status`):

| Status | Meaning |
|--------|---------|
| `QUEUED` | Accepted, waiting for dispatch |
| `RUNNING` | Task runs are executing |
| `CANCELLING` | `cancel()` requested; in-flight runs are winding down |
| `COMPLETED` | Terminal — all task runs settled |
| `CANCELLED` | Terminal — cancelled before completion |
| `FAILED` | Terminal — the evaluation itself failed (see `error`) |

**Task run** (`TaskRun.status`) — the scoring law: a valid reward (including 0) is `SCORED`; a verifier crash or out-of-domain reward is `SCORING_ERROR`, never a fabricated zero:

| Status | Meaning |
|--------|---------|
| `QUEUED` | Waiting for a sandbox slot |
| `RUNNING` | Agent phase in progress |
| `SCORING` | Agent finished; verifier running |
| `SCORED` | Verifier produced a valid reward (0 is a valid score) |
| `SCORING_ERROR` | Verifier crashed or returned an out-of-domain reward |
| `INFRASTRUCTURE_ERROR` | Sandbox lost before a durable artifact existed (see `failurePhase`) |
| `INDETERMINATE` | Dispatch/completion uncertainty — the platform cannot prove what happened |
| `CANCELLED` | Cancelled before settling |

**Benchmark version** (`BenchmarkVersion.state`): `DRAFT` → `IMPORTING` → `BUILDING` → `VALIDATING` → `READY` (runnable), with `FAILED` and `ARCHIVED` as the off-ramps.

---

## Benchmarks Client

```ts
import { benchmarks } from "@evolvingmachines/sdk";
const b = benchmarks();
```

### list / get

```ts
// Every benchmark with its active version
const catalog = await b.list();
// [{ name, displayTitle, description, activeVersion: { version, state, taskCount } }]

// One benchmark: all versions + the selected version's task list
const bench = await b.get("deep-swe");           // active version's tasks
const pinned = await b.get("deep-swe@1.0");      // specific version
const same = await b.get("deep-swe", { version: "1.0" }); // equivalent
```

`get()` returns `versions` (newest first), `tasksVersion`, and `tasks`. Tasks expose public fields only — `taskKey`, `agentTimeoutSec`, `verifierTimeoutSec`. Instructions, environments, and tests never leave the server.

### import / getImport / watchImport

Import a benchmark from a git repository into the shared catalog. The import runs server-side as a parse → validate → activate pipeline:

```ts
const job = await b.import({
    source: { gitUrl: "https://github.com/org/my-benchmark.git", ref: "v1.2.0" },
    benchmarkName: "my-benchmark",
    version: "1.2",              // (optional) omit to let the server assign one
});
console.log(job.id, job.state);  // accepted for processing

// Poll one import job
const status = await b.getImport(job.id);
console.log(status.state, status.taskCount, status.error);

// Or block until the import reaches a terminal state ("READY" or "FAILED")
const done = await b.watchImport(job.id, {
    onState: (imp) => console.log(imp.state),  // (optional) fires on every state change
    pollIntervalMs: 2_000,                     // (optional) default 2s
});
```

The import job's `state` follows the benchmark-version lifecycle above (`IMPORTING` → `BUILDING` → `VALIDATING` → `READY`, or `FAILED` with `error` populated). Archive-upload and Harbor Hub sources are part of the typed surface but not accepted by the server yet — git is the supported source.

---

## Evaluations Client

```ts
import { evaluations } from "@evolvingmachines/sdk";
const e = evaluations();
```

### run / get / list

```ts
const evaluation = await e.run({
    benchmark: "deep-swe@1.1",
    agentSystems: [{ harness: "codex", model: "gpt-5.5" }],
    maxModelSpendUsd: 25,
});

// Detail: agent systems + task-run status counts + spend
const detail = await e.get(evaluation.id);
console.log(detail.taskRunCounts);  // { SCORED: 12, RUNNING: 3, QUEUED: 5 }
console.log(detail.spentUsd, "/", detail.maxModelSpendUsd);

// Your evaluations, newest first (cursor-paged)
const page = await e.list({ limit: 50 });
const next = await e.list({ cursor: page.nextCursor! });
```

### taskRuns / taskRun

```ts
// Cursor-paged task-run listing
const runs = await e.taskRuns(evaluation.id, { limit: 100 });
console.log(runs.totalCount);

// Full detail for one task run (failureDetail untruncated here)
const run = await e.taskRun(evaluation.id, runs.taskRuns[0].id);
console.log(run.status, run.score, run.metrics);         // reward + named sub-scores
console.log(run.phaseTimingsMs);                          // { agentMs, verifyMs }
console.log(run.modelUsage?.spendUsd, run.modelUsage?.spendSource); // "key_info" | "assumed_cap"
console.log(run.harnessVersionResolved);                  // harness version actually used for the run
console.log(run.sessionRef);                              // reference to the agent session/trace
console.log(run.failurePhase, run.failureDetail);         // populated on failures
```

### taskRunTrace / taskRunTraceEvents

Fetch the recorded event trace of a single task run — a seq-ordered timeline, paged by sequence number:

```ts
// Page manually: pass nextAfter back as { after } to continue
const page = await e.taskRunTrace(evaluation.id, runId, { limit: 500 });
for (const event of page.events) {
    console.log(event.seq, event.type, event.data);
}
const next = await e.taskRunTrace(evaluation.id, runId, { after: page.nextAfter! });

// Or iterate — pages are fetched under the hood
for await (const event of e.taskRunTraceEvents(evaluation.id, runId)) {
    console.log(event.seq, event.type, event.data);
}
```

`taskRunTraceEvents()` drains the currently available trace, then stops. To poll an in-flight run incrementally, resume later with `{ after: lastSeenSeq }`.

### watch

Stream the evaluation's server-sent event feed and resolve with the final evaluation once it reaches a terminal status:

```ts
const controller = new AbortController();

const final = await e.watch(evaluation.id, {
    onEvent: (event) => {
        // event.seq  — monotonic sequence number (resume position)
        // event.type — "evaluation.created" | "task_run.settled" | "evaluation.completed" | ...
        // event.data — event payload
        if (event.type === "task_run.settled") updateProgress(event.data);
    },
    signal: controller.signal,     // (optional) abort the watch
    reconnectDelayMs: 1_000,       // (optional) initial reconnect backoff (default 1s)
    maxReconnectDelayMs: 30_000,   // (optional) backoff ceiling (default 30s)
});
```

- Replays the stream from the beginning, so `onEvent` sees every event even when you attach late.
- On disconnect it resumes from the last sequence number (`Last-Event-ID`) with exponential backoff — no gaps, no duplicates from the caller's perspective.
- After the stream ends, a final drain reconnect delivers any tail events written while the terminal status was being recorded, then `watch()` resolves with the final `Evaluation`.

### cancel / rerunFailed

```ts
// Request cancellation — idempotent; cancelling a terminal evaluation is a no-op
await e.cancel(evaluation.id);

// New linked evaluation of only the failed (and never-dispatched) task runs
const rerun = await e.rerunFailed(evaluation.id, { idempotencyKey: "rerun-1" });
console.log(rerun.sourceEvaluationId); // → evaluation.id
```

`rerunFailed()` requires a terminal source evaluation. Scored runs are never re-executed; the rerun contains only runs that failed or never dispatched.

### compare

Compare 2–5 of your evaluations side by side — per-evaluation aggregates plus a per-task matrix (disagreement rows first):

```ts
const comparison = await e.compare([evalA.id, evalB.id]);

// Aggregates: one per evaluation, in your id order
for (const agg of comparison.evaluations) {
    console.log(agg.benchmark, agg.agentSystems, agg.meanScore,
        `${agg.coverage.scored}/${agg.coverage.total} scored`, agg.spentUsd);
}

// Matrix: one row per task, one cell per evaluation
for (const row of comparison.taskMatrix) {
    if (!row.disagreement) continue;   // disagreement rows come first
    for (const cell of row.cells) {
        // cell.status: TaskRunStatus, "MIXED" (runs disagree), or "MISSING" (no runs)
        console.log(row.taskKey, cell.evaluationId, cell.status, cell.score);
    }
}
```

Mean scores cover `SCORED` runs only; `coverage` (`scored`/`total`) is always reported so a high mean over few scored runs stays visible. Zero is a score, never a gap.

### export

Download the full research archive (gzipped JSON) of a terminal evaluation:

```ts
// Default: Buffer in memory
const buffer = await e.export(evaluation.id);

// Save to a directory — returns the file path
const path = await e.export(evaluation.id, { to: "./results" });

// Raw response stream (for piping)
const stream = await e.export(evaluation.id, { stream: true });

// Harbor job-layout bundle instead of the canonical archive
const harborPath = await e.export(evaluation.id, { to: "./results", format: "harbor" });
```

`format: "harbor"` selects the Harbor results-bundle layout and composes with any delivery shape (`Buffer`, `to`, or `stream`).

---

## CLI

The SDK ships an `evolve-evals` binary — a thin shell over `benchmarks()`/`evaluations()` for terminal use and scripts:

```bash
npx evolve-evals help                       # bundled with @evolvingmachines/sdk

# Browse the catalog
npx evolve-evals benchmarks
npx evolve-evals benchmarks get deep-swe@1.1

# Create an evaluation and stream events until it finishes
npx evolve-evals run \
    --benchmark deep-swe@1.1 \
    --system codex:gpt-5.5 \
    --system claude:fable \
    --concurrency 4 \
    --max-spend 25 \
    --max-spend-per-run 2 \
    --watch

# Inspect and manage
npx evolve-evals list --limit 20
npx evolve-evals get <id>
npx evolve-evals task-runs <id>
npx evolve-evals cancel <id>
npx evolve-evals rerun-failed <id>
npx evolve-evals export <id> --to ./results --format harbor
```

- `--system` is `harness:model[:version]`, repeatable — one per agent system.
- Human-readable tables by default; `--json` emits machine-readable JSON (NDJSON for `--watch` event streams).
- Credentials: `$EVOLVE_API_KEY` (or `--api-key`), dashboard URL via `$EVOLVE_DASHBOARD_URL` (or `--url`).
- Exit codes: `0` success (with `--watch`: evaluation `COMPLETED`), `1` runtime/API failure (with `--watch`: `FAILED` or `CANCELLED`), `2` usage error.

---

## Type Reference

```ts
interface Evaluation {
    id: string;
    status: EvaluationStatus;
    benchmark: string;                       // "name@version"
    runsPerTask: number;
    concurrency: number;
    maxModelSpendUsd: number;
    maxModelSpendUsdPerTaskRun?: number;     // per-task-run cap, when one was set
    spentUsd: number;
    createdAt: string;
    counts?: { agentSystems: number; tasks: number; taskRuns: number };
    taskRunCounts?: Partial<Record<TaskRunStatus, number>>;
    taskRunTotal?: number;                   // get() only
    agentSystems?: AgentSystem[];            // get() only
    benchmarkVersionState?: BenchmarkVersionState; // get() only
    error?: string | null;                   // get() only
    sourceEvaluationId?: string;             // present on rerun-failed evaluations
    idempotentReplay?: boolean;              // true when Idempotency-Key replayed an existing evaluation
}

interface TaskRun {
    id: string;
    taskKey: string;
    agentSystem: AgentSystem;
    runNumber: number;                       // 1-based
    status: TaskRunStatus;
    score: number | null;                    // reward-file score; null until scored
    metrics: Record<string, number> | null;  // named sub-scores from reward.json
    failurePhase: string | null;
    failureDetail: string | null;            // truncated to 2000 chars in list responses
    phaseTimingsMs: Record<string, number> | null; // { agentMs, verifyMs }
    modelUsage: ModelUsage | null;
    sessionRef: string | null;               // agent session/trace reference
    createdAt: string;
    updatedAt: string;
}

interface TaskRunDetail extends TaskRun {   // evaluations().taskRun(id, runId)
    evaluationId: string;
    harnessVersionResolved: string | null;   // harness version actually used; null until resolved
    // failureDetail is untruncated in the detail response
}

interface ModelUsage {
    spendUsd?: number;        // LiteLLM is the only spend truth
    spendSource?: string;     // "key_info" (read from gateway) or "assumed_cap" (conservative fallback)
    maxBudgetUsd?: number;
    harnessVersion?: string;  // resolved harness version actually used
}

interface EvaluationEvent {
    seq: number;                   // SSE id — the resume position
    type: string;                  // "evaluation.created", "task_run.settled", "evaluation.completed", ...
    data: Record<string, unknown>;
}
```
