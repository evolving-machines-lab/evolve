# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY`. Evolve runs the benchmark tasks, agents, and verifiers on managed infrastructure; you submit an evaluation and read results.

Hosted evals run agent systems (harness + model) against versioned benchmarks on Evolve's infrastructure. Two standalone clients cover the whole surface — no `Evolve` instance needed:

- `benchmarks()` — the shared benchmark catalog: list, inspect, and import benchmarks.
- `evaluations()` — create evaluations, watch progress live, inspect task runs and traces, compare, and export results.

```ts
import { benchmarks, evaluations } from "@evolvingmachines/sdk";

const catalog = benchmarks();   // Uses EVOLVE_API_KEY (or pass { apiKey, dashboardUrl })
const evals = evaluations();
```

## Quickstart

Run `deep-swe` with two agent systems, watch it live, then export the results archive:

```ts
import { benchmarks, evaluations } from "@evolvingmachines/sdk";

// Bind the clients once, then reuse them
const catalog = benchmarks();
const evals = evaluations();

// 1. Resolve the benchmark's active version (throws if none is active)
const deepSwe = await catalog.getActive("deep-swe");
console.log(deepSwe.version, deepSwe.tasks.length); // version + tasks always present

// 2. Create the evaluation
const evaluation = await evals.run({
    benchmark: `deep-swe@${deepSwe.version}`,
    agentSystems: [
        { harness: "codex", model: "gpt-5.5" },
        { harness: "claude", model: "fable" },
    ],
    runsPerTask: 1,
    concurrency: 4,
    maxModelSpendUsd: 25,
});
console.log(evaluation.id, evaluation.status); // "QUEUED"

// 3. Watch until terminal — iterate the live event stream (auto-resumes)
for await (const event of evals.watch(evaluation.id)) {
    console.log(event.seq, event.type, event.data);
}
const final = await evals.get(evaluation.id);
console.log(final.status, final.taskRunCounts, final.spentUsd);

// 4. Inspect task runs (auto-paginates) and export the full research archive
for await (const run of evals.taskRuns(evaluation.id)) {
    console.log(run.taskKey, run.agentSystem.harness, run.status, run.score);
}

const path = await evals.export(evaluation.id, { to: "./results" });
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

Pair each `harness` with a model from its own family — the harness and model together form one agent system, and some harnesses only accept native models. Notably the `qwen` harness must run a Qwen-native model (Qwen Code injects the DashScope-only `enable_thinking` parameter, which OpenAI-family models reject with a `400`), and the `opencode` harness takes `openrouter/…` model ids. See [Getting Started → Harness and Model Pairing](./01-getting-started.md#harness-and-model-pairing) for the full rules.

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
// [{ name, displayTitle, description, activeVersion: { version, state, taskCount } }]

// One benchmark: all versions + the selected version's task list
const bench = await catalog.get("deep-swe");           // active version's tasks
const pinned = await catalog.get("deep-swe@1.0");      // specific version
const same = await catalog.get("deep-swe", { version: "1.0" }); // equivalent
```

`get()` returns `versions` (newest first), `tasksVersion`, and `tasks`. Tasks expose public fields only — `taskKey`, `agentTimeoutSec`, `verifierTimeoutSec`. Instructions, environments, and tests never leave the server.

### getActive

`getActive(name)` resolves a benchmark's active version to a runnable shape. Unlike `get()`, `version` and `tasks` are non-optional — it throws `NoActiveVersionError` when the benchmark has no active version, so you never branch on a missing active version:

```ts
import { NoActiveVersionError } from "@evolvingmachines/sdk";

const active = await catalog.getActive("deep-swe");
console.log(active.version, active.tasks.length); // both always present
const evaluation = await evals.run({ benchmark: `deep-swe@${active.version}`, /* … */ });
```

Use `get()` for the full multi-version detail with optional fields; `getActive()` for the happy path of running the current version.

### import / getImport / watchImport

Import a benchmark from a git repository into the shared catalog. The import runs server-side as a parse → validate pipeline that lands the new version at `VALIDATING`; a separate conformance activation gate owns the promotion to `READY`:

```ts
const job = await catalog.import({
    source: { gitUrl: "https://github.com/org/my-benchmark.git", ref: "v1.2.0" },
    benchmarkName: "my-benchmark",
    version: "1.2",              // (optional) omit to let the server assign one
});
console.log(job.id, job.state);  // accepted for processing

// Poll one import job
const status = await catalog.getImport(job.id);
console.log(status.state, status.taskCount, status.error);

// Or block until the import reaches a terminal state ("READY" or "FAILED")
const done = await catalog.watchImport(job.id, {
    onState: (importJob) => console.log(importJob.state),  // (optional) fires on every state change
    pollIntervalMs: 2_000,                     // (optional) default 2s
});
```

An import runs in two stages. The **importer** clones the pinned git source, parses the corpus, and lands the new version at `VALIDATING` (or `FAILED`, with `error` populated) — it never promotes to `READY`. Promotion is a separate **conformance activation** gate: for every task it runs the corpus' held-out gold solution through the real agent-and-verifier path and pushes an empty no-op patch straight to the verifier, then records a per-task activation verdict. A version is activated to `READY` only when every task's gold solution scores exactly `1.0` and its no-op does **not** — a task a do-nothing agent can pass measures nothing. A gold solution that passes only on a retry is flagged flaky (still eligible unless the gate runs in strict mode); a task where gold or the no-op check yields no usable score blocks activation.

Because promotion is a distinct step, `watchImport()` resolves when the version reaches `READY` (activation succeeded) or `FAILED`; a freshly imported version rests at `VALIDATING` until the activation gate runs. Only `READY` versions accept evaluations — `evaluations().run()` rejects a non-`READY` benchmark and `getActive()` throws `NoActiveVersionError` until a version is activated.

Imports are gated per deployment: only user ids listed in `EVAL_IMPORT_ALLOWED_USER_IDS` may import, and when that variable is unset or empty imports are disabled for everyone (the call returns `403`). Archive-upload and Harbor Hub sources are part of the typed surface but not accepted by the server yet — git is the supported source.

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

// Detail: agent systems + task-run status counts + spend
const detail = await evals.get(evaluation.id);
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
console.log(run.harnessVersionResolved);                  // harness version actually used for the run
console.log(run.sessionRef);                              // reference to the agent session/trace
console.log(run.failurePhase, run.failureDetail);         // populated on failures
```

**Reading spend.** `modelUsage.spendUsd` is LiteLLM's number — the only spend truth. Its `spendSource` is `"key_info"` when the value was read back from the gateway and `"assumed_cap"` when it falls back to the run's cap. Read-back can lag or be missing on the gemini-passthrough and OpenRouter routes, so a run's recorded spend may sit at the assumed cap (or zero) until spend-log reconciliation catches up — the task run's trace and token counts are the reliable engagement signal in the meantime.

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
// Primary form: iterate the events as they arrive
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

- `--system` is `harness:model[:version]`, repeatable — one per agent system.
- `import` wraps [`benchmarks().import()`](#import--getimport--watchimport): `--git` + `--ref` + `--name` are required, `--version` optional (server-assigned when omitted). With `--watch` it polls the job and prints a status line on each state change until `READY` or `FAILED`; `import status <id>` shows one job.
- Human-readable tables by default; `--json` emits machine-readable JSON (NDJSON for `--watch` event streams).
- Credentials: `$EVOLVE_API_KEY` (or `--api-key`), dashboard URL via `$EVOLVE_DASHBOARD_URL` (or `--url`).
- Exit codes: `0` success (with `--watch`: evaluation `COMPLETED` / import `READY`), `1` runtime/API failure (with `--watch`: `FAILED` or `CANCELLED`), `2` usage error.

---

## Sandbox Providers

Hosted eval task runs and managed agent sessions run on the same three sandbox providers — E2B, Daytona, and Modal. Managed sessions resolve a provider from env (Configuration → [Sandbox Providers](./02-configuration.md#sandbox-providers)); eval task runs resolve one from `EVAL_SANDBOX_PROVIDER` on the eval worker. All three honor the same provider-neutral create options (image, `user`/`homeDir`, outbound network policy, timeout), so one benchmark image and one network policy run unchanged across every provider. The honest differences:

| Capability | E2B | Daytona | Modal |
|------------|-----|---------|-------|
| `EVAL_SANDBOX_PROVIDER` value | `e2b` (default) | `daytona` | `modal` |
| Run agent as root | Native `user: "root"` | Image `USER` (root by default); no per-exec user switch | Native execution user is root |
| Outbound allowlist | Hostnames, IPs, CIDRs | Kernel IPv4 CIDRs only, ≤ 10 entries | Hostnames, IPs, CIDRs |
| Sandbox-death signal | Webhook | Webhook (Svix-style) | Polling sweep (no webhooks) |
| Private image registry | Template build | Pre-registered dashboard Registries | Modal Secret via `imageSecretName` |
| Max lifetime | Provider timeout | Provider timeout | Hard 24h cap |

- **E2B** is the baseline: native run-as-root, hostname/IP/CIDR allowlists, and webhook death signals, with nothing to set up beyond `E2B_API_KEY`.
- **Daytona** enforces its network allowlist as kernel-level IPv4 CIDRs only. Hostnames are resolved to IPs at create time and pinned for the sandbox's life, so a destination that rotates DNS (many CDNs and cloud APIs do) is silently blocked afterward; IPv6, ports, and wildcards are rejected, and the list caps at 10 entries. Private-registry images (e.g. AWS ECR) need their registry pre-registered on the Daytona dashboard **Registries** page before creation — there is no per-call pull secret — and images must be `linux/amd64` pinned to a tag or digest (a floating `latest` is rejected). With no per-exec user switch, eval task runs omit `user` (relying on the image's root `USER`) and pin `homeDir` to `/root`.
- **Modal** hard-caps sandbox lifetime at 24 hours (a longer timeout throws `ModalSandboxLifetimeError` — checkpoint and resume for longer work), emits no death webhooks so the platform reconciles Modal sandboxes with a polling sweep, and pulls private-registry images on Modal's own infrastructure: AWS ECR and GCP Artifact Registry images need a Modal Secret, named via `imageSecretName`, holding read-only registry credentials, because the worker's own AWS/GCP env never reaches the pull.

### Selecting the eval provider

The eval worker reads `EVAL_SANDBOX_PROVIDER` once per phase: unset or empty means `e2b`; `daytona` and `modal` select those providers; any other value is a loud error, never a silent fallback, so a typo cannot bill the wrong account. Flip it only when nothing is in flight — sandbox ids recorded on in-flight runs belong to the provider that created them, and the orphan reaper kills with the currently selected provider. Provider credentials come from the worker environment, the same law as `E2B_API_KEY`: `DAYTONA_API_KEY` for Daytona; `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` (plus `MODAL_IMAGE_SECRET_NAME` for private task images) for Modal.

### Operator setup

Running the managed providers yourself means wiring each provider's sandbox-death signal so a dead sandbox settles its session, browser sessions, and runtime tokens. E2B posts a signed webhook out of the box. Daytona posts a Svix-style signed webhook — register the Dashboard endpoint with Daytona and set `DAYTONA_WEBHOOK_SECRET`; the Dashboard reaches Daytona's API through the gateway's signed `/internal/daytona` pass-through (Evolve API keys never call `/internal/*` directly). Modal has no webhooks — set `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` so the reconcile sweep can poll sandbox liveness, and drive Modal through the Dashboard's Evolve-key-only broker routes at `/api/providers/modal/sandboxes`.

---

## Type Reference

```ts
interface ActiveBenchmark {                  // benchmarks().getActive(name)
    name: string;
    displayTitle: string | null;
    description: string | null;
    activeVersion: BenchmarkVersion;         // always present (getActive throws otherwise)
    version: string;                         // active version string (non-optional)
    tasks: Task[];                           // active version's tasks (non-optional)
    versions: BenchmarkVersion[];            // all versions, newest first
    tasksVersion: string | null;
    createdAt: string;
    updatedAt: string;
}

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
