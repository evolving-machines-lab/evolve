# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY`. Evolve runs the benchmark tasks, agents, and verifiers on managed infrastructure; you submit an evaluation and read results.

Hosted evals run agent systems (harness + model) against versioned benchmarks on Evolve's infrastructure. Two standalone clients cover the whole surface — no `Evolve` instance needed:

- `benchmarks()` — the shared benchmark catalog: list, inspect, and import benchmarks.
- `evaluations()` — create evaluations, watch progress, inspect task runs and traces, compare, and export results.

```python
from evolve import benchmarks, evaluations

b = benchmarks()   # Uses EVOLVE_API_KEY (or HostedClientConfig(api_key=..., dashboard_url=...))
e = evaluations()
```

Both clients are usable directly or as async context managers (`async with evaluations() as e:`).

One documented difference from TypeScript: Python's `watch()` **polls** `get()` until the evaluation is terminal; the TypeScript SDK's `watch()` streams the SSE event feed with per-event callbacks. For live event streams from Python scripts, use the [`evolve-evals` CLI](#cli) with `--watch --json`.

## Quickstart

Run `deep-swe` with two agent systems, watch it, then export the results archive:

```python
import asyncio
from evolve import benchmarks, evaluations, AgentSystem

async def main():
    # 1. Pick a benchmark from the catalog
    deep_swe = await benchmarks().get('deep-swe')  # active version + task list
    print(deep_swe.active_version.version, len(deep_swe.tasks))

    async with evaluations() as e:
        # 2. Create the evaluation
        evaluation = await e.run(
            benchmark='deep-swe@1.1',
            agent_systems=[
                AgentSystem(harness='codex', model='gpt-5.5'),
                AgentSystem(harness='claude', model='fable'),
            ],
            runs_per_task=1,
            concurrency=4,
            max_model_spend_usd=25,
        )
        print(evaluation.id, evaluation.status)  # 'QUEUED'

        # 3. Watch until terminal (polls get(); on_change fires on status/count changes)
        final = await e.watch(
            evaluation.id,
            on_change=lambda ev: print(ev.status, ev.task_run_counts),
        )
        print(final.status, final.spent_usd)

        # 4. Inspect task runs and export the full research archive
        page = await e.task_runs(evaluation.id)
        for run in page.task_runs:
            print(run.task_key, run.agent_system.harness, run.status, run.score)

        path = await e.export(evaluation.id, to='./results')
        print('Saved:', path)  # ./results/evaluation-<id>-export.json.gz

asyncio.run(main())
```

---

## Evaluation Inputs

`evaluations().run()` takes the six-input contract plus one optional per-run cap (all keyword arguments):

| Input | Required | Description |
|-------|----------|-------------|
| `benchmark` | yes | Benchmark reference `'name@version'` (e.g. `'deep-swe@1.1'`) |
| `agent_systems` | yes | List of `AgentSystem(harness=..., model=..., harness_version=None)` |
| `tasks` | no | Task keys to run — omit to run every task of the version |
| `runs_per_task` | no | Runs per task × agent system (default: 1) |
| `concurrency` | no | Parallel task runs (default: 1) |
| `max_model_spend_usd` | yes | Hard model-spend cap in USD for the whole evaluation |
| `max_model_spend_usd_per_task_run` | no | Model-spend cap in USD for each individual task run |

An evaluation expands to `tasks × agent_systems × runs_per_task` task runs. Each task run executes in its own sandbox with a capped, revocable model credential; spend is tracked against both caps.

`run()` and `rerun_failed()` accept `idempotency_key=` — retrying with the same key returns the original evaluation (`idempotent_replay=True`) instead of creating a duplicate.

---

## Statuses

**Evaluation** (`Evaluation.status`): `QUEUED` → `RUNNING` (→ `CANCELLING`) → terminal `COMPLETED` / `CANCELLED` / `FAILED`.

**Task run** (`TaskRun.status`) — the scoring law: a valid reward (including 0) is `SCORED`; a verifier crash or out-of-domain reward is `SCORING_ERROR`, never a fabricated zero:

| Status | Meaning |
|--------|---------|
| `QUEUED` | Waiting for a sandbox slot |
| `RUNNING` | Agent phase in progress |
| `SCORING` | Agent finished; verifier running |
| `SCORED` | Verifier produced a valid reward (0 is a valid score) |
| `SCORING_ERROR` | Verifier crashed or returned an out-of-domain reward |
| `INFRASTRUCTURE_ERROR` | Sandbox lost before a durable artifact existed (see `failure_phase`) |
| `INDETERMINATE` | Dispatch/completion uncertainty — the platform cannot prove what happened |
| `CANCELLED` | Cancelled before settling |

**Benchmark version** (`BenchmarkVersion.state`): `DRAFT` → `IMPORTING` → `BUILDING` → `VALIDATING` → `READY` (runnable), with `FAILED` and `ARCHIVED` as the off-ramps.

---

## Benchmarks Client

```python
from evolve import benchmarks
b = benchmarks()

# Every benchmark with its active version
catalog = await b.list()
# [Benchmark(name=..., display_title=..., description=..., active_version=BenchmarkVersion(...))]

# One benchmark: all versions + the selected version's task list
bench = await b.get('deep-swe')                 # active version's tasks
pinned = await b.get('deep-swe@1.0')            # specific version
same = await b.get('deep-swe', version='1.0')   # equivalent
```

`get()` returns `versions` (newest first), `tasks_version`, and `tasks`. Tasks expose public fields only — `task_key`, `agent_timeout_sec`, `verifier_timeout_sec`. Instructions, environments, and tests never leave the server.

### import_benchmark / get_import / watch_import

Import a benchmark from a git repository into the shared catalog. The import runs server-side as a parse → validate → activate pipeline:

```python
job = await b.import_benchmark(
    {'git_url': 'https://github.com/org/my-benchmark.git', 'ref': 'v1.2.0'},
    benchmark_name='my-benchmark',
    version='1.2',              # (optional) omit to let the server assign one
)
print(job.id, job.state)        # accepted for processing

# Poll one import job
status = await b.get_import(job.id)
print(status.state, status.task_count, status.error)

# Or block until the import reaches a terminal state ('READY' or 'FAILED')
done = await b.watch_import(
    job.id,
    on_state=lambda j: print(j.state),  # (optional) fires on every state change
    poll_interval_s=2.0,                # (optional) default 2s
    timeout_s=1800,                     # (optional) raise TimeoutError after this long
)
```

The import job's `state` follows the benchmark-version lifecycle above (`IMPORTING` → `BUILDING` → `VALIDATING` → `READY`, or `FAILED` with `error` populated). Archive-upload and Harbor Hub sources are part of the typed surface but not accepted by the server yet — git is the supported source (other source kinds raise `NotImplementedError`).

---

## Evaluations Client

```python
from evolve import evaluations, AgentSystem
e = evaluations()
```

### run / get / list

```python
evaluation = await e.run(
    benchmark='deep-swe@1.1',
    agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
    max_model_spend_usd=25,
)

# Detail: agent systems + task-run status counts + spend
detail = await e.get(evaluation.id)
print(detail.task_run_counts)   # {'SCORED': 12, 'RUNNING': 3, 'QUEUED': 5}
print(detail.spent_usd, '/', detail.max_model_spend_usd)

# Your evaluations, newest first (cursor-paged)
page = await e.list(limit=50)
next_page = await e.list(cursor=page.next_cursor)
```

### task_runs / task_run

```python
# Cursor-paged task-run listing
runs = await e.task_runs(evaluation.id, limit=100)
print(runs.total_count)

for run in runs.task_runs:
    print(run.task_key, run.run_number, run.status, run.score)
    print(run.metrics)                    # named sub-scores from reward.json
    print(run.phase_timings_ms)           # {'agentMs': ..., 'verifyMs': ...}
    print(run.model_usage)                # spendUsd, spendSource, harnessVersion (resolved)
    print(run.session_ref)                # agent session/trace reference
    print(run.failure_phase, run.failure_detail)  # populated on failures

# Full detail for one task run (untruncated failure_detail)
detail = await e.task_run(evaluation.id, runs.task_runs[0].id)
print(detail.harness_version_resolved)    # harness version actually used
print(detail.session_ref)
```

### task_run_trace

Fetch the recorded event trace of a single task run (seq-paged):

```python
# Page manually...
page = await e.task_run_trace(evaluation.id, run_id, after=0, limit=500)
for event in page.events:
    print(event.seq, event.type, event.data)
# ...resume with after=page.next_after, or drain with the async iterator:
async for event in e.task_run_trace_events(evaluation.id, run_id):
    print(event.seq, event.type)
```

Pass the last seen `next_after` as `after=` to resume — the same pattern works for incremental polling while a run is still executing.

### watch

Polls `get()` until the evaluation reaches a terminal status:

```python
final = await e.watch(
    evaluation.id,
    on_change=lambda ev: print(ev.status, ev.task_run_counts),  # (optional) fires on status/count changes
    poll_interval_s=2.0,   # (optional) default 2s
    timeout_s=3600,        # (optional) raise TimeoutError after this long
)
```

### cancel / rerun_failed

```python
# Request cancellation — idempotent; cancelling a terminal evaluation is a no-op
await e.cancel(evaluation.id)

# New linked evaluation of only the failed (and never-dispatched) task runs
rerun = await e.rerun_failed(evaluation.id, idempotency_key='rerun-1')
print(rerun.source_evaluation_id)  # → evaluation.id
```

`rerun_failed()` requires a terminal source evaluation. Scored runs are never re-executed; the rerun contains only runs that failed or never dispatched.

### compare

Compare terminal evaluations side by side — per-evaluation aggregates plus a task-level matrix:

```python
comparison = await e.compare([eval_a.id, eval_b.id])

# Aggregates: one row per evaluation, in your id order
for row in comparison.evaluations:
    print(row.id, row.mean_score, f'{row.coverage.scored}/{row.coverage.total} scored')

# Matrix: one row per task, one cell per evaluation (disagreement rows first)
for row in comparison.task_matrix:
    print(row.task_key, row.disagreement, [(c.status, c.score) for c in row.cells])
```

Means cover `SCORED` runs only; coverage (`scored`/`total`) is always reported so a high mean over few scored runs is visible. A cell's `status` is `'MIXED'` when its runs disagree and `'MISSING'` when the evaluation has no runs for the task.

### export

Download the full research archive (gzipped JSON) of a terminal evaluation:

```python
# Default: bytes in memory
payload = await e.export(evaluation.id)

# Save to a directory — returns the file path
path = await e.export(evaluation.id, to='./results')

# Harbor job-layout bundle instead of the canonical archive
harbor_path = await e.export(evaluation.id, to='./results', format='harbor')
```

---

## CLI

The TypeScript package ships an `evolve-evals` binary usable from any environment with Node.js — including alongside Python projects. It covers run/list/get/task-runs/cancel/rerun-failed/export plus the benchmark catalog, and `--watch` streams live events (the SSE path Python's `watch()` does not use):

```bash
npx evolve-evals run --benchmark deep-swe@1.1 --system codex:gpt-5.5 --max-spend 25 --watch
npx evolve-evals task-runs <id> --json
npx evolve-evals export <id> --to ./results --format harbor
```

See [TypeScript → Hosted Evals → CLI](../typescript/06-hosted-evals.md#cli) for the full command reference.

---

## Type Reference

```python
@dataclass
class AgentSystem:
    harness: str                      # e.g. 'codex', 'claude'
    model: str                        # e.g. 'gpt-5.5', 'fable'
    harness_version: str | None       # pin a harness version; None = platform default

@dataclass
class Evaluation:
    id: str
    status: str                       # EvaluationStatus wire values
    benchmark: str                    # 'name@version'
    runs_per_task: int
    concurrency: int
    max_model_spend_usd: float
    max_model_spend_usd_per_task_run: float | None  # per-task-run cap, when one was set
    spent_usd: float
    created_at: str
    counts: dict | None               # {'agentSystems': n, 'tasks': n, 'taskRuns': n}
    task_run_counts: dict | None      # histogram by TaskRunStatus
    task_run_total: int | None        # get() only
    agent_systems: list[AgentSystem] | None  # get() only
    benchmark_version_state: str | None      # get() only
    error: str | None                 # get() only
    source_evaluation_id: str | None  # present on rerun-failed evaluations
    idempotent_replay: bool           # True when Idempotency-Key replayed an existing evaluation

@dataclass
class TaskRun:
    id: str
    task_key: str
    agent_system: AgentSystem
    run_number: int                   # 1-based
    status: str                       # TaskRunStatus wire values
    score: float | None               # reward-file score; None until scored
    metrics: dict[str, float] | None  # named sub-scores from reward.json
    failure_phase: str | None
    failure_detail: str | None        # truncated to 2000 chars in list responses
    phase_timings_ms: dict | None     # {'agentMs': ..., 'verifyMs': ...}
    model_usage: dict | None          # spendUsd, spendSource, maxBudgetUsd, harnessVersion
    session_ref: str | None           # agent session/trace reference
    created_at: str
    updated_at: str

@dataclass
class TaskRunDetail(TaskRun):         # task_run(id, run_id) — untruncated failure_detail
    evaluation_id: str
    harness_version_resolved: str | None  # harness version actually used; None until resolved

@dataclass
class TaskRunTraceEvent:
    seq: int                          # monotonic sequence number (the after= resume position)
    type: str
    data: dict

@dataclass
class TaskRunTracePage:
    events: list[TaskRunTraceEvent]
    next_after: int | None            # resume position; None at the start of an empty trace

@dataclass
class BenchmarkImport:
    id: str
    state: str                        # 'IMPORTING' | 'BUILDING' | 'VALIDATING' | 'READY' | 'FAILED'
    error: str | None                 # failure detail when state == 'FAILED'
    task_count: int | None            # tasks parsed, once counted

@dataclass
class EvaluationComparison:           # compare([ids])
    evaluations: list[ComparisonAggregate]  # id, benchmark, status, mean_score, coverage, spent_usd, agent_systems
    task_matrix: list[ComparisonTaskRow]    # task_key, disagreement, cells (evaluation_id, status, score, coverage)
```
