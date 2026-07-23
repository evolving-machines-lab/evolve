# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY` (see [Getting Started → Gateway Mode](./01-getting-started.md#gateway-mode-evolve_api_key)). Evolve runs the benchmark tasks, agents, and verifiers on managed infrastructure; you submit an evaluation and read results.

Hosted evals run agent systems (harness + model) against versioned benchmarks on Evolve's infrastructure. Two standalone clients cover the whole surface — no `Evolve` instance needed:

- `benchmarks()` — the shared benchmark catalog: list, inspect, and import benchmarks.
- `evaluations()` — create evaluations, watch progress live, inspect task runs and traces, compare, and export results.

```ts
import { benchmarks, evaluations } from "@evolvingmachines/sdk";

const catalog = benchmarks();   // Uses EVOLVE_API_KEY (or pass { apiKey, baseUrl })
const evals = evaluations();
```

## Quickstart

Run `deep-swe` with two agent systems, watch it to completion, then export the results archive:

```ts
import { evaluations } from "@evolvingmachines/sdk";

const evals = evaluations();

// 1. Create the evaluation — a bare benchmark name resolves server-side
//    to the benchmark's active READY version
const evaluation = await evals.run({
    benchmark: "deep-swe",             // or pin a version: "deep-swe@1.1"
    agentSystems: [
        { harness: "codex", model: "gpt-5.5" },
        { harness: "claude", model: "fable" },
    ],
    runsPerTask: 1,
    concurrency: 4,
    maxModelSpendUsd: 25,
});
console.log(evaluation.id, evaluation.status); // "QUEUED"
console.log(evaluation.benchmark);             // "deep-swe@1.1" — the resolved version, echoed back

// 2. Watch until terminal — await the final evaluation
const final = await evals.watch(evaluation.id);
console.log(final.status, final.taskRunCounts, final.spentUsd);

// 3. Inspect task runs (auto-paginates) and export the full research archive
for await (const run of evals.taskRuns(evaluation.id)) {
    console.log(run.taskKey, run.agentSystem.harness, run.status, run.score);
}

const path = await evals.export(evaluation.id, { to: "./results" });
console.log("Saved:", path); // ./results/evaluation-<id>-export.json.gz
```

---

## Evaluation Inputs

`evaluations().run()` takes a benchmark reference, the agent systems to evaluate, and a hard spend cap; everything else is optional:

| Input | Required | Description |
|-------|----------|-------------|
| `benchmark` | yes | `"name@version"` for a pinned run, or a bare `"name"` — resolved server-side to the active `READY` version. Responses always echo the resolved `"name@version"`; a bare name with no active version is rejected with a `400` naming the activation requirement |
| `tasks` | no | Task keys to run — omit to run every task of the version |
| `agentSystems` | yes | Array of `{ harness, model, harnessVersion? }` to evaluate |
| `runsPerTask` | no | Runs per task × agent system (default: 1) |
| `concurrency` | no | Parallel task runs (default: 1) |
| `maxModelSpendUsd` | yes | Hard model-spend cap in USD for the whole evaluation |
| `maxModelSpendUsdPerTaskRun` | no | Model-spend cap in USD for each individual task run |
| `sandboxProvider` | no | `"e2b"` (default) \| `"daytona"` \| `"modal"` — see [Sandbox Providers](#sandbox-providers) |

An evaluation expands to `tasks × agentSystems × runsPerTask` task runs. Each task run executes in its own sandbox with a capped, revocable model credential; spend is tracked against both caps.

```ts
interface AgentSystem {
    harness: string;          // "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode" | "droid"
    model: string;            // a model of that harness's family, e.g. "gpt-5.5" for codex
    harnessVersion?: string;  // (optional) pin a harness version; omit for the platform default
}
```

`harness` is one of `"claude"`, `"codex"`, `"gemini"`, `"qwen"`, `"kimi"`, `"opencode"`, or `"droid"`, and `model` comes from that harness's own family — for example `claude` + `"fable"`, `codex` + `"gpt-5.5"`, `gemini` + `"gemini-3.1-pro-preview"`, `qwen` + `"qwen3.7-max"`, `kimi` + `"kimi-k2.6"`, `opencode` + `"openrouter/anthropic/claude-sonnet-4.6"`, `droid` + `"gpt-5.5"`. Some harnesses only accept native models: the `qwen` harness must run a Qwen-native model (Qwen Code injects the DashScope-only `enable_thinking` parameter, which OpenAI-family models reject with a `400`), and the `opencode` harness takes `openrouter/…` model ids. See [Getting Started → Harness and Model Pairing](./01-getting-started.md#harness-and-model-pairing) for the full rules.

The harness version actually used for a run is reported back on the task run detail (`resolvedHarnessVersion`), so unpinned runs remain reproducible after the fact.

### Idempotency

`run()` and `rerunFailed()` accept an `Idempotency-Key`. Retrying with the same key returns the original evaluation (marked `idempotentReplay: true`) instead of creating a duplicate:

```ts
const evaluation = await evals.run(input, { idempotencyKey: "nightly-2026-07-22" });
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

**Benchmark version** (`BenchmarkVersion.state`): `DRAFT` → `IMPORTING` → `BUILDING` → `VALIDATING` → `READY` (runnable), with `FAILED` and `ARCHIVED` as the off-ramps. An import lands a new version at `VALIDATING`; the `VALIDATING` → `READY` promotion is the conformance activation gate's alone (see [import](#import--getimport--watchimport)), and only `READY` versions accept evaluations.

---

## Benchmarks Client

```ts
import { benchmarks } from "@evolvingmachines/sdk";
const catalog = benchmarks();
```

### list / get

```ts
// Every benchmark with its active version
const allBenchmarks = await catalog.list();
// [{ name, title, description, activeVersion: { version, state, taskCount } }]

// One benchmark: all versions + the selected version's task list
const bench = await catalog.get("deep-swe");           // active version's tasks
const pinned = await catalog.get("deep-swe@1.0");      // specific version
```

`get()` returns `versions` (newest first), `tasksVersion`, and `tasks`. Tasks expose public fields only — `taskKey`, `agentTimeoutSec`, `verifierTimeoutSec`. Instructions, environments, and tests never leave the server.

### getActive

`getActive(name)` resolves a benchmark's active version to a runnable shape. Unlike `get()`, `version` and `tasks` are non-optional — it throws `NoActiveVersionError` when the benchmark has no active version, so you never branch on a missing active version:

```ts
import { NoActiveVersionError } from "@evolvingmachines/sdk";

const active = await catalog.getActive("deep-swe");
console.log(active.version, active.tasks.length); // both always present
```

Use `get()` for the full multi-version detail with optional fields, and `getActive()` to inspect the runnable version and its task list before an evaluation. To simply run the active version, `evals.run({ benchmark: "deep-swe", … })` resolves it server-side — no catalog call needed.

### import / getImport / watchImport

Import a benchmark from a git repository into the shared catalog. The import runs server-side as a parse → validate pipeline that lands the new version at `VALIDATING`; a separate conformance activation gate owns the promotion to `READY`:

```ts
const job = await catalog.import({
    source: { gitUrl: "https://github.com/org/my-benchmark.git", ref: "v1.2.0" },
    benchmarkName: "my-benchmark",
    version: "1.2",              // (optional) omit to let the server assign one
});
console.log(job.id, job.status); // accepted for processing

// Poll one import job
const importJob = await catalog.getImport(job.id);
console.log(importJob.status, importJob.taskCount, importJob.error);

// Or block until the import reaches a terminal status ("READY" or "FAILED")
const done = await catalog.watchImport(job.id, {
    onStatus: (importJob) => console.log(importJob.status),  // (optional) fires on every status change
    pollIntervalMs: 2_000,                     // (optional) default 2s
});
```

An import runs in two stages. The **importer** clones the pinned git source, parses the corpus, and lands the new version at `VALIDATING` (or `FAILED`, with `error` populated) — it never promotes to `READY`. Promotion is a separate **conformance activation** gate: for every task it runs the corpus' held-out gold solution through the real agent-and-verifier path and pushes an empty no-op patch straight to the verifier, then records a per-task activation verdict. A version is activated to `READY` only when every task's gold solution scores exactly `1.0` and its no-op does **not** — a task a do-nothing agent can pass measures nothing. A gold solution that passes only on a retry is flagged flaky (still eligible unless the gate runs in strict mode); a task where gold or the no-op check yields no usable score blocks activation.

Because promotion is a distinct step, `watchImport()` resolves when the version reaches `READY` (activation succeeded) or `FAILED`; a freshly imported version rests at `VALIDATING` until the activation gate runs. Only `READY` versions accept evaluations — `evaluations().run()` rejects a non-`READY` benchmark and `getActive()` throws `NoActiveVersionError` until a version is activated.

Imports require an admin account: only users with the `ADMIN` role may import, and any other caller receives `403`. Archive-upload and Harbor Hub sources are part of the typed surface but not accepted by the server yet — git is the supported source.

---

## Evaluations Client

```ts
import { evaluations } from "@evolvingmachines/sdk";
const evals = evaluations();
```

### run / get / list

```ts
const evaluation = await evals.run({
    benchmark: "deep-swe@1.1",
    agentSystems: [{ harness: "codex", model: "gpt-5.5" }],
    maxModelSpendUsd: 25,
});

// Detail: agent systems + evaluation size + task-run status counts + spend
const detail = await evals.get(evaluation.id);
console.log(detail.counts);         // { agentSystems: 1, tasks: 20, taskRuns: 20 }
console.log(detail.taskRunCounts);  // { SCORED: 12, RUNNING: 3, QUEUED: 5 }
console.log(detail.spentUsd, "/", detail.maxModelSpendUsd);

// Your evaluations, newest first — await one page (cursor-paged)
const page = await evals.list({ limit: 50 });
const next = await evals.list({ cursor: page.nextCursor! });

// ...or iterate every evaluation across all pages — cursors are walked for you
for await (const item of evals.list()) {
    console.log(item.id, item.status);
}
```

`list()` returns a dual-use handle: `await` it for a single `EvaluationPage`, or `for await` it to walk every evaluation across cursor pages.

### taskRuns / taskRun

```ts
// Await one page (cursor-paged) — totalCount included
const runs = await evals.taskRuns(evaluation.id, { limit: 100 });
console.log(runs.totalCount);

// ...or iterate every task run across all pages — cursors are walked for you
for await (const run of evals.taskRuns(evaluation.id)) {
    console.log(run.taskKey, run.status, run.score);
}

// Full detail for one task run (failureDetail untruncated here)
const run = await evals.taskRun(evaluation.id, runs.taskRuns[0].id);
console.log(run.status, run.score, run.metrics);         // reward + named sub-scores
console.log(run.phaseTimingsMs);                          // { agentMs, verifyMs }
console.log(run.modelUsage?.spendUsd, run.modelUsage?.spendSource); // "key_info" | "assumed_cap"
console.log(run.resolvedHarnessVersion);                  // harness version actually used for the run
console.log(run.sessionRef);                              // reference to the agent session/trace
console.log(run.failurePhase, run.failureDetail);         // populated on failures
```

**Reading spend.** `modelUsage.spendUsd` is the run's measured model spend, and `spendSource` says how it was measured: `"key_info"` means the number was read back from metering, `"assumed_cap"` means metering had not reported yet and the value conservatively assumes the run's cap. Metering can lag on some model routes, so a fresh run may briefly show the assumed cap (or zero) — the run's trace and token counts are the reliable engagement signal in the meantime.

### taskRunTrace / taskRunTraceEvents

Fetch the recorded event trace of a single task run — a seq-ordered timeline, paged by sequence number:

```ts
// Page manually: pass nextAfter back as { after } to continue
const page = await evals.taskRunTrace(evaluation.id, runId, { limit: 500 });
for (const event of page.events) {
    console.log(event.seq, event.type, event.data);
}
const next = await evals.taskRunTrace(evaluation.id, runId, { after: page.nextAfter! });

// Or iterate — pages are fetched under the hood
for await (const event of evals.taskRunTraceEvents(evaluation.id, runId)) {
    console.log(event.seq, event.type, event.data);
}
```

`taskRunTraceEvents()` drains the currently available trace, then stops. To poll an in-flight run incrementally, resume later with `{ after: lastSeenSeq }`.

### watch

`watch()` returns a dual-use handle over the evaluation's server-sent event feed. Iterate it for the live events, or await it for the final evaluation — both drive the same stream, so pick one form per call.

```ts
// Iterate the events as they arrive
for await (const event of evals.watch(evaluation.id)) {
    // event.seq  — monotonic sequence number (resume position)
    // event.type — "evaluation.created" | "task_run.settled" | "evaluation.completed" | ...
    // event.data — event payload
    if (event.type === "task_run.settled") updateProgress(event.data);
}

// Or await the same handle for the final Evaluation once it reaches a terminal status
const final = await evals.watch(evaluation.id);
console.log(final.status, final.taskRunCounts);
```

The callback form is equivalent and carries the reconnect/abort controls — `onEvent` fires in every form:

```ts
const controller = new AbortController();

const done = await evals.watch(evaluation.id, {
    onEvent: (event) => {
        if (event.type === "task_run.settled") updateProgress(event.data);
    },
    signal: controller.signal,     // (optional) abort the watch
    reconnectDelayMs: 1_000,       // (optional) initial reconnect backoff (default 1s)
    maxReconnectDelayMs: 30_000,   // (optional) backoff ceiling (default 30s)
});
```

- Replays the stream from the beginning, so you see every event even when you attach late.
- On disconnect it resumes from the last sequence number (`Last-Event-ID`) with exponential backoff — no gaps, no duplicates from the caller's perspective.
- After the stream ends, a final drain reconnect delivers any tail events written while the terminal status was being recorded, then the handle resolves with the final `Evaluation`.

### cancel / rerunFailed

```ts
// Request cancellation — idempotent; cancelling a terminal evaluation is a no-op
await evals.cancel(evaluation.id);

// New linked evaluation of only the failed (and never-dispatched) task runs
const rerun = await evals.rerunFailed(evaluation.id, { idempotencyKey: "rerun-1" });
console.log(rerun.sourceEvaluationId); // → evaluation.id
```

`rerunFailed()` requires a terminal source evaluation. Scored runs are never re-executed; the rerun contains only runs that failed or never dispatched.

### compare

Compare 2–5 of your evaluations side by side — per-evaluation aggregates plus a per-task matrix (disagreement rows first):

```ts
const comparison = await evals.compare([evalA.id, evalB.id]);

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
const buffer = await evals.export(evaluation.id);

// Save to a directory — returns the file path
const path = await evals.export(evaluation.id, { to: "./results" });

// Raw response stream (for piping)
const stream = await evals.export(evaluation.id, { stream: true });

// Harbor job-layout bundle instead of the canonical archive
const harborPath = await evals.export(evaluation.id, { to: "./results", format: "harbor" });
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

# Import a benchmark from git and poll it to READY
npx evolve-evals import \
    --git https://github.com/acme/my-bench.git \
    --ref main \
    --name my-bench \
    --watch
npx evolve-evals import status <id>

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

- Run flags mirror the input contract in order: `--benchmark <name[@version]>` (bare name = active version), `--tasks <k1,k2,…>`, `--system <harness:model[:version]>` (repeatable — one per agent system), `--runs <n>`, `--concurrency <n>`, `--max-spend <usd>`, `--max-spend-per-run <usd>`, `--provider <e2b|daytona|modal>`, `--watch`.
- `import` wraps [`benchmarks().import()`](#import--getimport--watchimport): `--git` + `--ref` + `--name` are required, `--version` optional (server-assigned when omitted). With `--watch` it polls the job and prints a line on each status change until `READY` or `FAILED`; `import status <id>` shows one job.
- Human-readable tables by default; `--json` emits machine-readable JSON (NDJSON for `--watch` event streams).
- Credentials: `$EVOLVE_API_KEY` (or `--api-key`). `--base-url` overrides the API endpoint when you are pointed at a non-default deployment.
- Exit codes: `0` success (with `--watch`: evaluation `COMPLETED` / import `READY`), `1` runtime/API failure (with `--watch`: `FAILED` or `CANCELLED`), `2` usage error.

---

## Sandbox Providers

Every task run executes in its own isolated sandbox. Three providers are available — E2B (the default), Daytona, and Modal — and the optional `sandboxProvider` input picks one per evaluation. The same benchmark image, network policy, and agent command run unchanged on all three, and your Evolve API key is the only credential involved on any of them. (Managed agent *sessions* choose their provider through SDK configuration — see [Configuration → Sandbox Providers](./02-configuration.md#sandbox-providers); evaluations choose theirs here, per run.)

```typescript
const evaluation = await evals.run({
    benchmark: "swe-bench-verified@1.0",
    agentSystems: [{ harness: "codex", model: "gpt-5.5" }],
    maxModelSpendUsd: 25,
    sandboxProvider: "daytona",   // "e2b" (default) | "daytona" | "modal"
});
```

From the CLI, pass `--provider`:

```bash
evolve-evals run --benchmark swe-bench-verified@1.0 --system codex:gpt-5.5 --max-spend 25 --provider daytona
```

Omit the field to accept the default (`e2b`); an unknown value is rejected at creation with a `400`, never a silent fallback, so a typo cannot bill the wrong account. Once chosen, the provider is fixed for the evaluation's life — every task run, and any `rerunFailed()` of it, runs on it.

Two provider differences can affect which one fits a benchmark:

- **Daytona** enforces task network allowlists as kernel-level IPv4 CIDR rules: hostnames are resolved to IPs when the sandbox is created and pinned for its life, so a destination that rotates DNS (many CDNs and cloud APIs do) can become unreachable mid-run; IPv6, ports, and wildcards are rejected, and a policy caps at 10 entries. A benchmark whose tasks need broad or hostname-based egress belongs on E2B or Modal.
- **Modal** caps every sandbox at 24 hours. A task whose timeout would exceed the cap is rejected with `ModalSandboxLifetimeError` at creation — never silently truncated mid-run.

Everything else — pulling task images, executing as root, provider accounts, credentials, and health monitoring — works identically across the three and is Evolve's responsibility, not yours.

---

## Type Reference

```ts
type EvalSandboxProvider = "e2b" | "daytona" | "modal";

interface ActiveBenchmark {                  // benchmarks().getActive(name)
    name: string;
    title: string | null;
    description: string | null;
    activeVersion: BenchmarkVersion;         // always present (getActive throws otherwise)
    version: string;                         // active version string (non-optional)
    tasks: Task[];                           // active version's tasks (non-optional)
    versions: BenchmarkVersion[];            // all versions, newest first
    createdAt: string;
    updatedAt: string;
}

interface Evaluation {
    id: string;
    status: EvaluationStatus;
    benchmark: string;                       // "name@version"
    agentSystems?: AgentSystem[];            // get() only
    runsPerTask: number;
    concurrency: number;
    maxModelSpendUsd: number;
    maxModelSpendUsdPerTaskRun?: number;     // per-task-run cap, when one was set
    sandboxProvider?: EvalSandboxProvider;   // sandbox provider this evaluation runs on
    spentUsd: number;
    createdAt: string;
    counts: { agentSystems: number; tasks: number; taskRuns: number }; // every shape
    taskRunCounts?: Partial<Record<TaskRunStatus, number>>; // get/list
    benchmarkVersionState?: BenchmarkVersionState; // get() only
    error?: string | null;                   // get() only
    updatedAt?: string;                      // get() only
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
    resolvedHarnessVersion: string | null;   // harness version actually used; null until resolved
    // failureDetail is untruncated in the detail response
}

type SpendSource = "key_info" | "assumed_cap";

interface ModelUsage {
    spendUsd?: number;              // measured model spend for the run, in USD
    spendSource?: SpendSource;      // "key_info" (read from gateway) or "assumed_cap" (conservative fallback)
    maxBudgetUsd?: number;
    resolvedHarnessVersion?: string; // resolved harness version actually used for the run
    [key: string]: unknown;         // open map: harness-specific keys may appear
}

type BenchmarkImportStatus = "IMPORTING" | "BUILDING" | "VALIDATING" | "READY" | "FAILED";

interface BenchmarkImport {                  // benchmarks().import() / getImport() / watchImport()
    id: string;
    status: BenchmarkImportStatus;           // terminal: "READY", "FAILED"
    benchmarkName?: string;                  // create responses
    version?: string;                        // create responses
    error?: BenchmarkImportError | null;     // structured failure detail when status is "FAILED"
    taskCount?: number;                      // tasks parsed, once counted (getImport())
}

interface BenchmarkImportError {
    message: string;                         // what went wrong, e.g. "2/113 task(s) failed to parse"
    failures?: { taskKey: string; error: string }[]; // per-task parse/validation failures
}

interface EvaluationEvent {
    seq: number;                   // SSE id — the resume position
    type: string;                  // "evaluation.created", "task_run.settled", "evaluation.completed", ...
    data: Record<string, unknown>;
}
```
