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
const active = await catalog.getActive("deep-swe");  // active READY version, guaranteed runnable
// getActive() throws NoActiveVersionError when nothing is runnable yet
```

`READY` is the one benchmark-version state that accepts evaluations — see [Statuses](#statuses). Tasks expose public fields only — `taskKey`, `agentTimeoutSec`, `verifierTimeoutSec`, and `providers`, the per-provider capability verdict ([Where it runs](#where-it-runs)). Instructions, environments, and tests never leave the server.

Then create the evaluation. `benchmark`, `agentSystems`, and `maxModelSpendUsd` are required:

```ts
const evaluation = await evals.run({
    benchmark: "deep-swe",              // bare name = active version; "deep-swe@1.1" pins one
    agentSystems: [
        {
            harness: "codex",
            model: "gpt-5.5",
        },
        {
            harness: "claude",
            model: "fable",
        },
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

An evaluation expands to `tasks × agentSystems × runsPerTask` task runs, each in its own sandbox. `sandboxProvider` (optional, default `"e2b"`) picks where those sandboxes run — see [Where it runs](#where-it-runs). Valid harness + model pairs are the same as everywhere in the SDK — see [Getting Started → Harness and Model Pairing](./01-getting-started.md#harness-and-model-pairing).

Retries are safe — pass an idempotency key and a retry returns the original evaluation instead of creating a duplicate:

```ts
const retry = await evals.run(
    {
        benchmark: "deep-swe",
        agentSystems: [{ harness: "codex", model: "gpt-5.5" }],
        maxModelSpendUsd: 25,
    },
    { idempotencyKey: "nightly-2026-07-23" },
);
console.log(retry.idempotentReplay);   // true when the key replayed an existing evaluation
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
console.log(final.status, final.taskRunCounts, final.meanScore, final.spentUsd);
```

Options apply in every form — abort or tune backoff on an iterated watch the same way; `onEvent` fires regardless:

```ts
const controller = new AbortController();

const final = await evals.watch(
    evaluation.id,
    {
        onEvent: (event) => console.log(event.type, event.data),
        signal: controller.signal,     // (optional) abort the watch
        reconnectDelayMs: 1_000,       // (optional) initial backoff, default 1s
        maxReconnectDelayMs: 30_000,   // (optional) backoff ceiling, default 30s
    },
);
```

- The stream replays from the beginning, so attaching late loses nothing.
- On disconnect it resumes from the last sequence number with exponential backoff — no gaps, no duplicates.
- Once the evaluation reaches a terminal status, the handle resolves with the final `Evaluation`.

---

## Read the results

```ts
// One evaluation: size, status histogram, mean score, spend
const detail = await evals.get(evaluation.id);
console.log(detail.taskRunCounts);                  // { SCORED: 12, RUNNING: 3, QUEUED: 5 }
console.log(detail.meanScore);                      // mean over SCORED runs; null until something scores
console.log(detail.spentUsd, "/", detail.maxModelSpendUsd);

// Your evaluations, newest first — await one page, or iterate them all
const page = await evals.list({ limit: 50 });       // page.nextCursor continues
for await (const item of evals.list()) {
    console.log(item.id, item.status, item.benchmark, item.meanScore);
}
```

Task runs paginate the same way — await a page or iterate across pages. `status` filters, e.g. to the failures behind a rerun decision:

```ts
for await (const run of evals.taskRuns(evaluation.id)) {
    console.log(run.taskKey, run.agentSystem.harness, run.status, run.score);
}

const failures = await evals.taskRuns(evaluation.id, {
    status: ["INFRASTRUCTURE_ERROR", "SCORING_ERROR"],
});
```

One task run in depth:

```ts
const run = await evals.taskRun(
    evaluation.id,
    runId,
);
console.log(run.score, run.metrics);                 // reward + named sub-scores
console.log(run.phaseTimingsMs);                     // { agentMs, verifyMs }
console.log(run.modelUsage?.spentUsd, run.modelUsage?.spendSource);
console.log(run.sandboxProvider, run.verifierMode);  // where the run and its verifier executed
console.log(run.resolvedHarnessVersion);             // harness version actually used
console.log(run.failurePhase, run.failureDetail);    // untruncated in this response
```

> **Reading spend:** `spendSource: "measured"` is platform-measured model spend; `"assumed_cap"` means the run's spend could not be measured yet, so the per-run cap is reported conservatively (`modelUsage.maxModelSpendUsd`). Fresh runs can briefly show the cap while metering catches up.

Fetch a run's recorded event timeline:

```ts
for await (const event of evals.taskRunTraceEvents(
    evaluation.id,
    runId,
)) {
    console.log(event.seq, event.type, event.data);
}

// Or page manually — resume later from the last seen seq
const trace = await evals.taskRunTrace(
    evaluation.id,
    runId,
    { limit: 500 },
);
const more = await evals.taskRunTrace(
    evaluation.id,
    runId,
    { after: trace.nextAfter! },
);
```

`taskRunTraceEvents()` drains the currently available trace, then stops. To follow an in-flight run, resume with `{ after: lastSeenSeq }`.

### Cancel / rerun failures

```ts
await evals.cancel(evaluation.id);    // idempotent; a terminal evaluation is a no-op

// New linked evaluation of only the failed (and never-dispatched) runs
const rerun = await evals.rerunFailed(
    evaluation.id,
    { idempotencyKey: "rerun-1" },
);
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
        console.log(row.taskKey, cell.status, cell.meanScore);
        // cell.status: TaskRunStatus, "MIXED" (runs disagree), or "MISSING" (no runs)
    }
}
```

Mean scores cover `SCORED` runs only; `coverage` is always reported so a high mean over few scored runs stays visible. Zero is a score, never a gap.

---

## Export

Download the full research archive (gzipped JSON) of a terminal evaluation:

```ts
const buffer = await evals.export(evaluation.id); // Buffer (default)
const path = await evals.export(
    evaluation.id,
    { to: "./results" },
); // save; returns file path
const stream = await evals.export(
    evaluation.id,
    { stream: true },
); // raw response stream

// Harbor job-layout bundle instead of the canonical archive
const harborPath = await evals.export(
    evaluation.id,
    {
        to: "./results",
        format: "harbor",
    },
);
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
npx evolve-evals task-runs <id> --status INFRASTRUCTURE_ERROR,SCORING_ERROR
npx evolve-evals task-run <id> <run-id>
npx evolve-evals trace <id> <run-id> --after 100
npx evolve-evals compare <id> <id>
npx evolve-evals cancel <id>
npx evolve-evals rerun-failed <id>
npx evolve-evals export <id> --to ./results --format harbor
npx evolve-evals benchmarks
npx evolve-evals benchmarks get deep-swe@1.1
```

- Human-readable tables by default; `--json` emits machine-readable JSON (NDJSON for `--watch` streams).
- Credentials: `$EVOLVE_API_KEY`, or `--api-key`; `--base-url` targets a non-default deployment.
- Exit codes: `0` success (with `--watch`: `COMPLETED` / import `IMPORTED`), `1` runtime failure (with `--watch`: `FAILED` or `CANCELLED`), `2` usage error.

Benchmark imports have their own subcommand — `npx evolve-evals import …` — shown in [Bring your own benchmark](#bring-your-own-benchmark).

---

## What runs

Any benchmark in Harbor task format. Three environment shapes, all first-class:

- **Single-container** — the task pins a Docker image; agent and verifier run in it.
- **Dockerfile-built** — the task ships `environment/Dockerfile`; Evolve builds the image once at import.
- **Multi-container** — the task ships `environment/docker-compose.yaml`; its service containers (databases, brokers, APIs) run alongside the agent's `main` container.

A task also declares *how* it must run, and every declaration is honored as written. A provider that cannot honor one refuses the run with the reason named — nothing ever silently runs on weaker semantics than the task declares.

### Network modes

Tasks declare the agent sandbox's network access:

- `no-network` — sealed; the agent reaches nothing but its model.
- `allowlist` — only the hosts the task names.
- `public` — open internet (Harbor's default when a task declares nothing).

The **verifier never gets network**, in any mode — it always runs sealed, regardless of what the task declares.

### Verifier modes

- `separate` — the verifier boots a pristine copy of the task environment and judges the collected submission. Nothing the agent left behind can touch the verdict.
- `shared` — the verifier command runs inside the agent's sandbox, after the agent finishes and its credentials are revoked.

Both are supported; the task picks (Harbor's `environment_mode`). The mode that ran is recorded on every task run as `verifierMode`.

### Compute sizing

Tasks declare `cpus`, `memory_mb`, and `storage_mb`, and get exactly that. A provider whose ceiling is below the declaration **refuses the run** — named in the per-task provider verdicts below and in the run's `failureDetail` — rather than silently provisioning less. Current ceilings:

| Provider | Max vCPUs | Max memory | Disk |
|----------|-----------|------------|------|
| `e2b` | 8 | 8192 MB | fixed 20 GB |
| `daytona` | 4 | 8192 MB | sized per task, up to 10 GB |
| `modal` | 16 | 32768 MB | fixed 512 GB |

A task sized above *every* ceiling is rejected at import — it could run nowhere without running smaller than declared.

---

## Where it runs

Every task run executes in its own sandbox. Pick the provider per evaluation — the same task image, network policy, and agent command run unchanged:

```ts
const evaluation = await evals.run({
    benchmark: "swe-bench-verified@1.0",
    agentSystems: [
        {
            harness: "codex",
            model: "gpt-5.5",
        },
    ],
    maxModelSpendUsd: 25,
    sandboxProvider: "daytona",   // "e2b" (default) | "daytona" | "modal"
});
```

An unknown value is rejected with a `400` at creation — never a silent fallback. Once chosen, the provider is fixed for the evaluation's life; `rerunFailed()` inherits it.

Not every task can run everywhere. The catalog tells you **before any money is spent** — every task carries a per-provider verdict:

```ts
const bench = await catalog.get("my-bench@1.0");
for (const task of bench.tasks ?? []) {
    const verdict = task.providers.modal;   // { ok: true } | { ok: false, reason }
    if (!verdict.ok) console.log(task.taskKey, "cannot run on modal:", verdict.reason);
}
```

Creating an evaluation whose selected tasks include one refused on the chosen provider is rejected with a `400 provider_unsupported` naming the tasks and each task's reason — never accepted and left to fail mid-run.

What the verdicts encode today:

- **Multi-container tasks run on `e2b` and `daytona`.** Modal cannot run them today — the task's `providers.modal` verdict names the reason, and the task stays runnable on the other two providers.
- **Multi-container + `no-network` is declined on every provider** for now. Run those tasks with an `allowlist` or `public` network policy.
- **Daytona serves IP-based allowlists only.** Its network filter takes IPv4 addresses and CIDRs, capped at 10 entries — a cap that also has to fit the address the agent uses to reach its model, so a task's own list gets slightly fewer. A task whose allowlist names a hostname is refused on Daytona with the reason — run it on e2b or Modal, which serve hostname allowlists.
- **Modal caps every sandbox at 24 hours.** A task whose timeout exceeds the cap fails fast when its sandbox is created (read the run's `failureDetail`) — never truncated mid-run.
- **Sizing above a provider's ceiling** refuses on that provider only — see [Compute sizing](#compute-sizing).

---

## Bring your own benchmark

Any repo of tasks in Harbor format runs on the hosted stack: point at it, import it, let the activation gate certify it, run it. A benchmark in another format gets converted *into* Harbor format first — the layout is small, and a complete task fits on one screen (below).

> Imports require the `ADMIN` role — any other caller receives a `403`. The source is a git repository pinned to a ref.

### Already in Harbor format

```ts
const job = await catalog.import({
    source: {
        gitUrl: "https://github.com/acme/my-bench.git",
        ref: "v1.0.0",
    },
    benchmarkName: "my-bench",
    version: "1.0",               // the version label for the imported corpus
});

// Block until IMPORTED or FAILED
const done = await catalog.watchImport(
    job.id,
    {
        onStatus: (importJob) => console.log(importJob.status, importJob.taskCount),
        pollIntervalMs: 2_000,        // (optional) default 2s
    },
);

if (done.status === "FAILED") {
    console.log(done.error?.message);              // e.g. "2/113 task(s) failed to parse"
    for (const failure of done.error?.failures ?? []) {
        console.log(failure.taskKey, failure.error);
    }
}
```

```bash
npx evolve-evals import \
    --git https://github.com/acme/my-bench.git \
    --ref v1.0.0 \
    --name my-bench \
    --version 1.0 \
    --watch
npx evolve-evals import status <id>
```

What happens next:

- **All-or-nothing parse.** Every task is parsed before anything lands; one bad task fails the whole import, with each failure named in `error.failures`. No partial corpus ever exists.
- **Strict by design.** Every `task.toml` field is either honored or the import is refused with the field and reason named — a task never silently runs on weaker semantics than it declares. Notably not yet supported: multi-step tasks (`[[steps]]`) and GPU tasks.
- **Environments are prepared at import.** Dockerfile-defined environments are built once; multi-container service images are resolved and pinned so runs are reproducible.
- **The activation gate certifies every task** before the version can activate:
  - **gold** — the task's reference solution (`solution/`) is pushed through the real agent-side + verifier path and must score exactly `1.0`. Proof the task is solvable as written.
  - **no-op** — an empty submission goes straight to the verifier and must *not* score `1.0`. A task a do-nothing agent passes measures nothing.

`IMPORTED` is the import job's terminal success: the corpus landed as a benchmark version, visible in the catalog (`catalog.get("my-bench@1.0")`) in state `VALIDATING`. Activation is a separate, operator-run step — importing never triggers it. The version stays `VALIDATING` until the gate passes in full and promotes it to `READY`, the one state that accepts evaluations; watch the state through `catalog.get()`. `evals.run()` against any other state is rejected with a `409 version_not_ready` naming it. Once `READY`:

```ts
const evaluation = await evals.run({
    benchmark: "my-bench@1.0",
    agentSystems: [
        {
            harness: "codex",
            model: "gpt-5.5",
        },
    ],
    maxModelSpendUsd: 25,
});
```

### Not in Harbor format yet

Convert it. A benchmark is a repo with one directory per task under `tasks/`; the directory name is the task key. A minimal complete task:

```
my-bench/
└── tasks/
    └── greeting-fix/
        ├── task.toml
        ├── instruction.md
        ├── pre_artifacts.sh        # collects the agent's work after the run
        ├── environment/
        │   ├── Dockerfile          # built at import — or pin docker_image in task.toml
        │   └── greet.py
        ├── tests/
        │   └── test.sh             # verifier entrypoint — writes the reward
        └── solution/
            └── solve.sh            # reference solution, run by the activation gate
```

`task.toml` — the declarations from [What runs](#what-runs), honored as written:

```toml
schema_version = "1.4"

[environment]
cpus = 2
memory_mb = 4096
storage_mb = 10240
network_mode = "no-network"    # or "allowlist" (+ allowed_hosts), or "public"

[agent]
timeout_sec = 900

[verifier]
timeout_sec = 300
environment_mode = "shared"    # or "separate"
```

`instruction.md` — what the agent is asked to do:

```markdown
`greet.py` in /app misspells its greeting. Fix it so `python greet.py`
prints exactly `Hello, world!`. Keep the CLI unchanged.
```

`environment/Dockerfile` — `environment/` is the build context. The agent works in `/app`, and its git state is the submission, so seed a git baseline:

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY greet.py .
RUN git init -q && git add -A \
    && git -c user.name=bench -c user.email=bench@local commit -qm "base"
```

```python
# environment/greet.py — the planted bug
print("Helo, world!")
```

`pre_artifacts.sh` — runs in the agent sandbox after the agent finishes; captures the work as a patch:

```bash
#!/bin/bash
set -uo pipefail
mkdir -p /logs/artifacts
git diff --binary "$(git rev-list --max-parents=0 HEAD)" HEAD > /logs/artifacts/model.patch
```

Before the script runs, the platform commits any work the agent left uncommitted — the baseline→HEAD diff captures the agent's edits whether or not the agent ever ran `git commit`.

`tests/test.sh` — the verifier entrypoint. The reward file is the verdict, never the exit code: write a number in `[0, 1]` to `reward.txt`, or `reward.json` with `{"reward": ...}` plus named sub-scores:

```bash
#!/bin/bash
mkdir -p /logs/verifier
cd /app
if [ "$(python greet.py)" = "Hello, world!" ]; then
    echo 1.0 > /logs/verifier/reward.txt
else
    echo 0.0 > /logs/verifier/reward.txt
fi
```

`solution/solve.sh` — the reference solution the activation gate runs; it must earn a `1.0`:

```bash
#!/bin/bash
sed -i 's/Helo/Hello/' /app/greet.py
```

That's the whole format. The rules that matter when converting:

- `task.toml`, `instruction.md`, `pre_artifacts.sh`, and `tests/test.sh` are required. `tests/grader.py`, `tests/config.json`, and `tests/test.patch` ride along when present. A `tests/Dockerfile` is accepted only while it stays trivial (`FROM`, `COPY`, `WORKDIR`, `LABEL`, and permission-only `RUN chmod` lines) — the verifier uploads the test files onto the task image instead of building this Dockerfile, so anything richer is refused. Any other file under `tests/` is rejected — it would silently never reach the verifier.
- The environment is `environment/Dockerfile` (built at import), a pinned `docker_image` (the registry must be approved for imports, and the tag pinned — never `:latest`), or `environment/docker-compose.yaml` for multi-container tasks (the agent runs in the `main` service).
- Timeouts are optional: agent defaults to 1800 s, verifier to 600 s.
- `solution/` (`solve.sh`, or a `solution.patch` to apply) is what the gate certifies with — without it the version cannot reach `READY`.

Then import and run it — exactly the [Harbor-format flow above](#already-in-harbor-format).

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

**Benchmark version** (`BenchmarkVersion.state`) — the catalog's lifecycle, distinct from the import job's `IMPORTING → IMPORTED | FAILED`:

```
DRAFT → IMPORTING → BUILDING → VALIDATING → READY
```

with `FAILED` and `ARCHIVED` as off-ramps: a failed parse or environment build lands `FAILED` before `VALIDATING` is ever reached, and `ARCHIVED` shelves a version that has been moved past. An import lands a version at `VALIDATING`; the activation gate (gold + no-op, above) then promotes it — `READY` is the only state that accepts evaluations.

---

## Types

```ts
type EvalSandboxProvider = "e2b" | "daytona" | "modal";

interface AgentSystem {
    harness: string;             // "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode" | "droid"
    model: string;               // a model of that harness's family
    harnessVersion?: string | null;  // pin a harness version; null when unpinned
}

type TaskProviderVerdict = { ok: true } | { ok: false; reason: string };

interface Task {
    taskKey: string;
    agentTimeoutSec: number;
    verifierTimeoutSec: number;
    providers: Record<EvalSandboxProvider, TaskProviderVerdict>;  // where the task can run
}

interface BenchmarkVersion {             // one shape on every surface
    version: string;
    state: BenchmarkVersionState;        // the benchmark-version lifecycle above
    createdAt: string;
    taskCount: number;
}

interface Benchmark {                    // catalog.list() / catalog.get(ref)
    name: string;
    title: string | null;
    description: string | null;
    activeVersion: BenchmarkVersion | null;
    versions?: BenchmarkVersion[];       // get() only, newest first
    selectedVersion?: BenchmarkVersion | null;  // get() only — the tasks' provenance
    tasks?: Task[];                      // get() only
    // ActiveBenchmark (getActive) is the same shape with version + tasks non-optional
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
    sandboxProvider: EvalSandboxProvider;
    spentUsd: number;
    counts: { agentSystems: number; tasks: number; taskRuns: number };
    taskRunCounts?: Partial<Record<TaskRunStatus, number>>;  // get/list
    meanScore?: number | null;               // get/list; mean over SCORED runs, null when none
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
    sandboxProvider: EvalSandboxProvider | null;  // where the run executed; null until it has
    verifierMode: "separate" | "shared" | null;   // where the verifier ran
    resolvedHarnessVersion: string | null;   // harness version actually used
    sessionRef: string | null;               // agent session/trace reference
    createdAt: string;
    updatedAt: string;
}

interface TaskRunDetail extends TaskRun {    // evals.taskRun(id, runId)
    evaluationId: string;                    // failureDetail is untruncated here
}

interface ModelUsage {                       // one money vocabulary: caps are
    spentUsd?: number;                       // maxModelSpend*, actuals are spentUsd
    spendSource?: "measured" | "assumed_cap";
    maxModelSpendUsd?: number;               // the per-run cap that applied to this run
    [key: string]: unknown;                  // open map: harness-specific keys may appear
}

interface EvaluationEvent {
    seq: number;                             // monotonic; the watch resume position
    type: string;                            // "task_run.settled", "evaluation.completed", ...
    data: Record<string, unknown>;
}

interface TaskRunTraceEvent {
    seq: number;                             // resume position for { after }
    type: string;
    data: Record<string, unknown>;
}

interface BenchmarkImport {
    id: string;
    status: "IMPORTING" | "IMPORTED" | "FAILED";
    benchmarkName: string;
    version: string;
    taskCount?: number;                      // tasks parsed, once counted
    error?: { message: string; failures?: { taskKey: string; error: string }[] } | null;
}
```

### Errors

Every API failure throws `EvolveApiError` — the server's own sentence as the message, plus a stable machine-readable code to branch on:

```ts
import { EvolveApiError } from "@evolvingmachines/sdk";

try {
    await evals.run(input);
} catch (error) {
    if (error instanceof EvolveApiError) {
        console.log(error.status);   // e.g. 409
        console.log(error.code);     // e.g. "version_not_ready", "provider_unsupported", "rate_limited"
        console.log(error.message);  // "Benchmark version deep-swe@1.2 is in state VALIDATING; ..."
    }
}
```

Codes you will actually branch on: `benchmark_not_found`, `benchmark_version_not_found`, `no_active_version`, `version_not_ready`, `unknown_task_keys`, `provider_unsupported`, `evaluation_not_found`, `evaluation_not_terminal`, `no_failed_runs`, `task_run_not_found`, `rate_limited` (retry after the `Retry-After` header), `invalid_api_key`, and `invalid_input`.

> To operate this lifecycle yourself on your own infrastructure, see [Runtime → Task Sandboxes & Credential Lifecycle](./03-runtime.md#task-sandboxes--credential-lifecycle).
