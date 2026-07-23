# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY` (see [Getting Started → Gateway Mode](./01-getting-started.md#gateway-mode-evolve_api_key)). Evolve runs the benchmark tasks, agents, and verifiers on managed infrastructure — you submit an evaluation and read results.

Two standalone clients cover the whole surface — no `Evolve` instance needed:

```ts
import { benchmarks, evaluations } from "@evolvingmachines/sdk";

const catalog = benchmarks();   // the shared benchmark catalog
const evals = evaluations();    // your evaluations
```

Both read `EVOLVE_API_KEY` from the environment, or accept `{ apiKey, baseUrl }`.

---

## Run an evaluation

Pick a benchmark from the catalog:

```ts
const allBenchmarks = await catalog.list();          // every benchmark + its active version
const deepSwe = await catalog.get("deep-swe@1.1");   // one version: task list + timeouts
const active = await catalog.getActive("deep-swe");  // active version, guaranteed runnable
// getActive() throws NoActiveVersionError when nothing is runnable yet
```

Tasks expose public fields only — `taskKey`, `agentTimeoutSec`, `verifierTimeoutSec`. Instructions, environments, and tests never leave the server.

Then create the evaluation. `benchmark`, `agentSystems`, and `maxModelSpendUsd` are required:

```ts
const evaluation = await evals.run({
    benchmark: "deep-swe",              // bare name = active version; "deep-swe@1.1" pins one
    agentSystems: [
        { harness: "codex", model: "gpt-5.5" },
        { harness: "claude", model: "fable" },
    ],
    tasks: ["task-001", "task-002"],    // (optional) default: every task of the version
    runsPerTask: 1,                     // (optional) default 1
    concurrency: 4,                     // (optional) parallel task runs, default 1
    maxModelSpendUsd: 25,               // hard model-spend cap for the whole evaluation
    maxModelSpendUsdPerTaskRun: 2,      // (optional) cap per task run
});

console.log(evaluation.status);        // "QUEUED"
console.log(evaluation.benchmark);     // "deep-swe@1.1" — the resolved version, echoed back
console.log(evaluation.counts);        // { agentSystems: 2, tasks: 2, taskRuns: 4 }
```

An evaluation expands to `tasks × agentSystems × runsPerTask` task runs, each in its own sandbox. Valid harness + model pairs are the same as everywhere in the SDK — see [Getting Started → Harness and Model Pairing](./01-getting-started.md#harness-and-model-pairing).

> **Retries are safe** — pass an idempotency key and a retry returns the original evaluation (`idempotentReplay: true`) instead of creating a duplicate:

```ts
await evals.run(input, { idempotencyKey: "nightly-2026-07-23" });
```

---

## Watch it live

`watch()` is a dual-use handle over the evaluation's event stream. Iterate it for live events, or await it for the final evaluation — pick one form per call:

```ts
// Iterate events as they arrive
for await (const event of evals.watch(evaluation.id)) {
    // event.seq  — monotonic sequence number
    // event.type — "evaluation.created" | "task_run.settled" | "evaluation.completed" | ...
    if (event.type === "task_run.settled") updateProgress(event.data);
}

// Or await the final Evaluation
const final = await evals.watch(evaluation.id);
console.log(final.status, final.taskRunCounts, final.spentUsd);
```

Options apply in every form — abort or tune backoff on an iterated watch the same way; `onEvent` fires regardless:

```ts
const controller = new AbortController();

const final = await evals.watch(evaluation.id, {
    onEvent: (event) => console.log(event.type, event.data),
    signal: controller.signal,     // (optional) abort the watch
    reconnectDelayMs: 1_000,       // (optional) initial backoff, default 1s
    maxReconnectDelayMs: 30_000,   // (optional) backoff ceiling, default 30s
});
```

- The stream replays from the beginning, so attaching late loses nothing.
- On disconnect it resumes from the last sequence number with exponential backoff — no gaps, no duplicates.
- Once the evaluation reaches a terminal status, the handle resolves with the final `Evaluation`.

---

## Read the results

```ts
// One evaluation: size, status histogram, spend
const detail = await evals.get(evaluation.id);
console.log(detail.taskRunCounts);                  // { SCORED: 12, RUNNING: 3, QUEUED: 5 }
console.log(detail.spentUsd, "/", detail.maxModelSpendUsd);

// Your evaluations, newest first — await one page, or iterate them all
const page = await evals.list({ limit: 50 });       // page.nextCursor continues
for await (const item of evals.list()) {
    console.log(item.id, item.status, item.benchmark);
}
```

Task runs paginate the same way — await a page or iterate across pages:

```ts
for await (const run of evals.taskRuns(evaluation.id)) {
    console.log(run.taskKey, run.agentSystem.harness, run.status, run.score);
}
```

One task run in depth:

```ts
const run = await evals.taskRun(evaluation.id, runId);
console.log(run.score, run.metrics);                 // reward + named sub-scores
console.log(run.phaseTimingsMs);                     // { agentMs, verifyMs }
console.log(run.modelUsage?.spendUsd, run.modelUsage?.spendSource);
console.log(run.resolvedHarnessVersion);             // harness version actually used
console.log(run.failurePhase, run.failureDetail);    // untruncated in this response
```

> **Reading spend:** `spendSource: "measured"` is platform-measured model spend; `"assumed_cap"` means the run's spend could not be measured yet, so the per-run cap is reported conservatively. Fresh runs can briefly show the cap while metering catches up.

Fetch a run's recorded event timeline:

```ts
for await (const event of evals.taskRunTraceEvents(evaluation.id, runId)) {
    console.log(event.seq, event.type, event.data);
}

// Or page manually — resume later from the last seen seq
const trace = await evals.taskRunTrace(evaluation.id, runId, { limit: 500 });
const more = await evals.taskRunTrace(evaluation.id, runId, { after: trace.nextAfter! });
```

`taskRunTraceEvents()` drains the currently available trace, then stops. To follow an in-flight run, resume with `{ after: lastSeenSeq }`.

### Cancel / rerun failures

```ts
await evals.cancel(evaluation.id);    // idempotent; a terminal evaluation is a no-op

// New linked evaluation of only the failed (and never-dispatched) runs
const rerun = await evals.rerunFailed(evaluation.id, { idempotencyKey: "rerun-1" });
console.log(rerun.sourceEvaluationId); // → evaluation.id
```

`rerunFailed()` requires a terminal source evaluation. Scored runs are never re-executed.

---

## Compare

Compare 2–5 of your evaluations side by side — per-evaluation aggregates plus a per-task matrix, disagreement rows first:

```ts
const comparison = await evals.compare([evalA.id, evalB.id]);

for (const aggregate of comparison.evaluations) {
    console.log(aggregate.benchmark, aggregate.meanScore,
        `${aggregate.coverage.scored}/${aggregate.coverage.total} scored`, aggregate.spentUsd);
}

for (const row of comparison.taskMatrix) {
    if (!row.disagreement) continue;
    for (const cell of row.cells) {
        console.log(row.taskKey, cell.status, cell.score);
        // cell.status: TaskRunStatus, "MIXED" (runs disagree), or "MISSING" (no runs)
    }
}
```

Mean scores cover `SCORED` runs only; `coverage` is always reported so a high mean over few scored runs stays visible. Zero is a score, never a gap.

---

## Export

Download the full research archive (gzipped JSON) of a terminal evaluation:

```ts
const buffer = await evals.export(evaluation.id);                    // Buffer (default)
const path = await evals.export(evaluation.id, { to: "./results" }); // save; returns file path
const stream = await evals.export(evaluation.id, { stream: true });  // raw response stream

// Harbor job-layout bundle instead of the canonical archive
const harborPath = await evals.export(evaluation.id, { to: "./results", format: "harbor" });
```

`format: "harbor"` composes with any delivery shape (`Buffer`, `to`, or `stream`).

---

## CLI

The SDK ships an `evolve-evals` binary — a thin shell over `benchmarks()` / `evaluations()`:

```bash
npx evolve-evals run \
    --benchmark deep-swe@1.1 \
    --system codex:gpt-5.5 \
    --system claude:fable \
    --concurrency 4 \
    --max-spend 25 \
    --watch
```

Run flags, in the order you decide them:

- `--benchmark <name[@version]>` — required; bare name = active version
- `--tasks <k1,k2,…>` — default: every task of the version
- `--system <harness:model[:version]>` — required; repeat once per agent system
- `--runs <n>` — runs per task × system (default 1)
- `--concurrency <n>` — parallel task runs (default 1)
- `--max-spend <usd>` — required; evaluation-wide model-spend cap
- `--max-spend-per-run <usd>` — per-task-run cap
- `--provider <e2b|daytona|modal>` — default `e2b`
- `--watch` — stream events until the evaluation finishes

The rest of the surface:

```bash
npx evolve-evals list --limit 20
npx evolve-evals get <id>
npx evolve-evals task-runs <id>
npx evolve-evals cancel <id>
npx evolve-evals rerun-failed <id>
npx evolve-evals export <id> --to ./results --format harbor
npx evolve-evals benchmarks
npx evolve-evals benchmarks get deep-swe@1.1
```

- Human-readable tables by default; `--json` emits machine-readable JSON (NDJSON for `--watch` streams).
- Credentials: `$EVOLVE_API_KEY`, or `--api-key`; `--base-url` targets a non-default deployment.
- Exit codes: `0` success (with `--watch`: `COMPLETED` / import `READY`), `1` runtime failure (with `--watch`: `FAILED` or `CANCELLED`), `2` usage error.

---

## Choose a sandbox provider

Every task run executes in its own sandbox. Pick the provider per evaluation — the same benchmark image, network policy, and agent command run unchanged on all three:

```ts
const evaluation = await evals.run({
    benchmark: "swe-bench-verified@1.0",
    agentSystems: [{ harness: "codex", model: "gpt-5.5" }],
    maxModelSpendUsd: 25,
    sandboxProvider: "daytona",   // "e2b" (default) | "daytona" | "modal"
});
```

```bash
npx evolve-evals run --benchmark swe-bench-verified@1.0 --system codex:gpt-5.5 --max-spend 25 --provider daytona
```

An unknown value is rejected with a `400` at creation — never a silent fallback. Once chosen, the provider is fixed for the evaluation's life; `rerunFailed()` inherits it.

Two provider differences worth knowing before you pick:

- **Daytona** enforces task network allowlists as kernel-level IPv4 rules: hostnames resolve to IPs at sandbox creation and stay pinned, so destinations that rotate DNS can become unreachable mid-run. IPv6 and wildcards are rejected; a policy caps at 10 entries.
- **Modal** caps every sandbox at 24 hours. A task whose timeout exceeds the cap fails fast when its sandbox is created (read the run's `failureDetail`) — never truncated mid-run.

---

## Import a benchmark (admin)

> Imports require the `ADMIN` role — any other caller receives `403`. Git is the supported source today; archive and Harbor Hub sources are reserved in the typed surface and throw `NotImplementedError`.

```ts
const job = await catalog.import({
    source: { gitUrl: "https://github.com/acme/my-bench.git", ref: "v1.2.0" },
    benchmarkName: "my-bench",
    version: "1.2",               // (optional) server-assigned when omitted
});

// Block until READY or FAILED
const done = await catalog.watchImport(job.id, {
    onStatus: (importJob) => console.log(importJob.status, importJob.taskCount),
    pollIntervalMs: 2_000,        // (optional) default 2s
});
console.log(done.status, done.error?.message);   // per-task failures in done.error.failures
```

```bash
npx evolve-evals import --git https://github.com/acme/my-bench.git --ref main --name my-bench --watch
npx evolve-evals import status <id>
```

Evolve validates every task before a version becomes runnable: only `READY` versions accept evaluations. `evals.run()` rejects any other state with a `409` naming it; a bare name with no active version is a `400`.

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
| `FAILED` | Terminal — the evaluation itself failed; read `error` |

**Task run** (`TaskRun.status`) — a valid reward, including 0, is `SCORED`; a failure is never reported as a fabricated zero:

| Status | Meaning |
|--------|---------|
| `QUEUED` | Waiting for a sandbox slot |
| `RUNNING` | Agent phase in progress |
| `SCORING` | Agent finished; verifier running |
| `SCORED` | Valid reward recorded in `score` |
| `SCORING_ERROR` | Verifier crashed or returned an out-of-domain reward — read `failureDetail` |
| `INFRASTRUCTURE_ERROR` | Run lost before a result was recorded — read `failurePhase`, then `rerunFailed()` |
| `INDETERMINATE` | The platform cannot tell whether the run completed |
| `CANCELLED` | Cancelled before settling |

**Benchmark version** (`BenchmarkVersion.state`):

```
DRAFT → IMPORTING → BUILDING → VALIDATING → READY
                                    ↓
                                 FAILED
```

`ARCHIVED` shelves a version that has been moved past; like every non-`READY` state, it accepts no evaluations.

---

## Types

```ts
type EvalSandboxProvider = "e2b" | "daytona" | "modal";

interface AgentSystem {
    harness: string;             // "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode" | "droid"
    model: string;               // a model of that harness's family
    harnessVersion?: string | null;  // pin a harness version; null when unpinned
}

interface Evaluation {
    id: string;
    status: EvaluationStatus;
    benchmark: string;                       // "name@version"
    agentSystems?: AgentSystem[];            // get() only
    runsPerTask: number;
    concurrency: number;
    maxModelSpendUsd: number;
    maxModelSpendUsdPerTaskRun?: number;     // when one was set
    sandboxProvider?: EvalSandboxProvider;
    spentUsd: number;
    counts: { agentSystems: number; tasks: number; taskRuns: number };
    taskRunCounts?: Partial<Record<TaskRunStatus, number>>;  // get/list
    benchmarkVersionState?: BenchmarkVersionState;           // get() only
    error?: string | null;                   // get() only
    sourceEvaluationId?: string;             // present on rerun-failed evaluations
    idempotentReplay?: boolean;              // true when a key replayed an existing evaluation
    createdAt: string;
    updatedAt?: string;                      // get() only
}

interface TaskRun {
    id: string;
    taskKey: string;
    agentSystem: AgentSystem;
    runNumber: number;                       // 1-based
    status: TaskRunStatus;
    score: number | null;                    // null until scored
    metrics: Record<string, number> | null;  // named sub-scores from reward.json
    failurePhase: string | null;
    failureDetail: string | null;            // truncated to 2000 chars in list responses
    phaseTimingsMs: Record<string, number> | null;  // { agentMs, verifyMs }
    modelUsage: ModelUsage | null;
    sessionRef: string | null;               // agent session/trace reference
    createdAt: string;
    updatedAt: string;
}

interface TaskRunDetail extends TaskRun {    // evals.taskRun(id, runId)
    evaluationId: string;
    resolvedHarnessVersion: string | null;   // failureDetail is untruncated here
}

interface ModelUsage {
    spendUsd?: number;                       // model spend in USD
    spendSource?: "measured" | "assumed_cap";
    maxBudgetUsd?: number;
    [key: string]: unknown;                  // open map: harness-specific keys may appear
}

interface EvaluationEvent {
    seq: number;                             // monotonic; the watch resume position
    type: string;                            // "task_run.settled", "evaluation.completed", ...
    data: Record<string, unknown>;
}

interface BenchmarkImport {
    id: string;
    status: "IMPORTING" | "BUILDING" | "VALIDATING" | "READY" | "FAILED";
    benchmarkName?: string;
    version?: string;
    taskCount?: number;                      // tasks parsed, once counted
    error?: { message: string; failures?: { taskKey: string; error: string }[] } | null;
}
```

> To operate this lifecycle yourself on your own infrastructure, see [Runtime → Task Sandboxes & Credential Lifecycle](./03-runtime.md#task-sandboxes--credential-lifecycle).
