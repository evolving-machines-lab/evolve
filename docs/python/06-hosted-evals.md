# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY` (see [Getting Started → Gateway Mode](./01-getting-started.md#gateway-mode-evolve_api_key)). Evolve runs the benchmark tasks, agents, and verifiers on managed infrastructure; you submit an evaluation and read results.

Two standalone clients cover the whole surface — no `Evolve` instance needed:

```python
from evolve import benchmarks, evaluations

catalog = benchmarks()    # shared benchmark catalog
evals = evaluations()     # create, watch, and read evaluations
```

Both read `EVOLVE_API_KEY` (or take `HostedClientConfig(api_key=..., base_url=...)`) and work standalone or as `async with` context managers.

---

## Run an evaluation

Browse the catalog, then run. A bare benchmark name resolves server-side to the active `READY` version:

```python
from evolve import benchmarks, evaluations, AgentSystem

async with benchmarks() as catalog:
    print([bench.name for bench in await catalog.list()])

    active = await catalog.get_active('deep-swe')   # raises NoActiveVersionError when none
    print(active.version, [task.task_key for task in active.tasks])

async with evaluations() as evals:
    evaluation = await evals.run(
        benchmark='deep-swe',                       # or pin a version: 'deep-swe@1.1'
        agent_systems=[
            AgentSystem(
                harness='codex',
                model='gpt-5.5',
            ),
            AgentSystem(
                harness='claude',
                model='fable',
            ),
        ],
        concurrency=4,
        max_model_spend_usd=25,
    )
    print(evaluation.id, evaluation.status)   # QUEUED
    print(evaluation.benchmark)               # 'deep-swe@1.1' — the resolved version, echoed back
```

`run()` keyword arguments:

| Keyword | Default | What it does |
|---------|---------|--------------|
| `benchmark` | required | `'name'` (active `READY` version) or `'name@version'` |
| `agent_systems` | required | list of `AgentSystem(harness=..., model=..., harness_version=None)` |
| `max_model_spend_usd` | required | hard model-spend cap (USD) for the whole evaluation |
| `tasks` | all tasks | task keys to run |
| `runs_per_task` | `1` | runs per task × agent system |
| `concurrency` | `1` | parallel task runs |
| `max_model_spend_usd_per_task_run` | none | model-spend cap (USD) per task run |
| `sandbox_provider` | `'e2b'` | see [Choose a sandbox provider](#choose-a-sandbox-provider) |
| `idempotency_key` | none | safe-retry key (below) |

An evaluation expands to `tasks × agent_systems × runs_per_task` task runs, each in its own sandbox. Valid harness + model pairs are listed once in [Getting Started → Harness and Model Pairing](./01-getting-started.md#harness-and-model-pairing).

Retrying with the same `idempotency_key` returns the original evaluation instead of creating a duplicate:

```python
evaluation = await evals.run(
    ...,
    idempotency_key='nightly-2026-07-23',
)
print(evaluation.idempotent_replay)   # True on a replay
```

---

## Watch it live

Iterate the evaluation's state as it changes, or block for the final result. Both poll every 2 seconds (`poll_interval_s=`):

```python
async for state in evals.watch_iter(evaluation.id):
    print(state.status, state.task_run_counts)   # RUNNING {'SCORED': 12, 'RUNNING': 3, 'QUEUED': 5}

final = await evals.watch(
    evaluation.id,
    timeout_s=3600,
) # raises TimeoutError past the deadline
print(final.status, final.spent_usd)
```

For a live per-event stream (SSE), use the [CLI](#cli) with `--watch`.

Stop early with `cancel()` — idempotent, and a no-op on a terminal evaluation:

```python
await evals.cancel(evaluation.id)
```

---

## Read the results

Iterate task runs (pages fetched for you), or `await` one page:

```python
async for run in evals.task_runs(evaluation.id):
    print(run.task_key, run.agent_system.model, run.run_number, run.status, run.score)

page = await evals.task_runs(
    evaluation.id,
    limit=100,
) # .task_runs, .total_count, .next_cursor
```

Fetch one run's full detail — untruncated `failure_detail`, plus the harness version actually used:

```python
detail = await evals.task_run(
    evaluation.id,
    run.id,
)
print(detail.failure_phase, detail.failure_detail)
print(detail.resolved_harness_version)
print(detail.metrics)             # named sub-scores
print(detail.phase_timings_ms)    # {'agent_ms': ..., 'verify_ms': ...}
```

Read per-run spend from `model_usage`. `spend_source='measured'` is platform-measured spend; `'assumed_cap'` means spend could not be measured yet, so the value conservatively assumes the run's cap:

```python
if detail.model_usage:
    print(detail.model_usage.spend_usd, detail.model_usage.spend_source)
```

Stream a run's recorded event trace; resume later from the last seen `seq`:

```python
async for event in evals.task_run_trace_events(
    evaluation.id,
    run.id,
):
    print(event.seq, event.type, event.data)

page = await evals.task_run_trace(
    evaluation.id,
    run.id,
    after=last_seq,
    limit=500,
)
```

Rerun only the failed (and never-dispatched) runs of a terminal evaluation — scored runs are never re-executed:

```python
rerun = await evals.rerun_failed(
    evaluation.id,
    idempotency_key='rerun-1',
)
print(rerun.source_evaluation_id)   # → evaluation.id
```

List your evaluations, newest first:

```python
async for item in evals.list():
    print(item.id, item.benchmark, item.status, item.spent_usd)
```

---

## Compare

Compare 2–5 of your evaluations side by side — per-evaluation aggregates plus a per-task matrix, disagreement rows first:

```python
comparison = await evals.compare([baseline.id, candidate.id])

for aggregate in comparison.evaluations:
    print(aggregate.id, aggregate.mean_score,
          f'{aggregate.coverage.scored}/{aggregate.coverage.total} scored')

for row in comparison.task_matrix:
    print(row.task_key, row.disagreement,
          [(cell.status, cell.score) for cell in row.cells])
```

Means cover `SCORED` runs only; coverage is always reported so a high mean over few scored runs stays visible. A cell's status is `'MIXED'` when its runs disagree and `'MISSING'` when the evaluation has no runs for that task.

---

## Export

Download the research archive (gzipped JSON) of a terminal evaluation:

```python
archive_path = await evals.export(
    evaluation.id,
    to='./results',
) # saved file path
harbor_path = await evals.export(
    evaluation.id,
    to='./results',
    format='harbor',
) # Harbor job layout
archive_bytes = await evals.export(evaluation.id) # bytes in memory
```

---

## CLI

Python ships no separate CLI. The TypeScript package's `evolve-evals` binary (`npx evolve-evals ...`) covers the full surface from any shell — including live SSE event streaming with `--watch` — see [TypeScript → Hosted Evals → CLI](../typescript/06-hosted-evals.md#cli).

---

## Choose a sandbox provider

Every task run executes in its own isolated sandbox. Pick the provider per evaluation — an unknown value is rejected with a `400` at creation, and the choice is fixed for the evaluation's life (including `rerun_failed()`):

```python
evaluation = await evals.run(
    benchmark='swe-bench-verified@1.0',
    agent_systems=[
        AgentSystem(
            harness='codex',
            model='gpt-5.5',
        ),
    ],
    max_model_spend_usd=25,
    sandbox_provider='daytona',   # 'e2b' (default) | 'daytona' | 'modal'
)
```

Two differences worth knowing when picking:

- **Daytona** pins task network allowlists to IPv4 addresses resolved when the sandbox is created, so a destination that rotates DNS can become unreachable mid-run. Benchmarks needing broad or hostname-based egress belong on E2B or Modal.
- **Modal** caps every sandbox at 24 hours. A task whose timeout exceeds the cap fails fast when its sandbox is created — never truncated mid-run.

---

## Import a benchmark (admin)

Imports require the `ADMIN` role (anyone else receives a `403`); git is the supported source. Evolve validates every task before the version becomes runnable:

```python
async with benchmarks() as catalog:
    job = await catalog.import_benchmark(
        git_url='https://github.com/acme/my-benchmark.git',
        ref='v1.2.0',
        benchmark_name='my-benchmark',
        version='1.2',                # optional — omit to let the server assign one
    )

    done = await catalog.watch_import(
        job.id,
        on_status=lambda j: print(j.status),
    )
    if done.status == 'FAILED':
        print(done.error.message)     # e.g. "2/113 task(s) failed to parse"
        for failure in done.error.failures:
            print(failure.task_key, failure.error)
```

`watch_import()` returns at `READY` or `FAILED`; only `READY` versions accept evaluations. Inspect what landed with `catalog.get('my-benchmark@1.2')` — all versions plus the task list (`task_key`, `agent_timeout_sec`, `verifier_timeout_sec`; instructions, environments, and tests never leave the server).

---

## Statuses

**Evaluation** — `QUEUED → RUNNING (→ CANCELLING)`, then terminal:

| Status | Meaning |
|--------|---------|
| `QUEUED` | accepted, waiting for dispatch |
| `RUNNING` | task runs executing |
| `CANCELLING` | `cancel()` requested; in-flight runs winding down |
| `COMPLETED` | terminal — all task runs settled |
| `CANCELLED` | terminal — cancelled before completion |
| `FAILED` | terminal — the evaluation itself failed (see `error`) |

**Task run** — a valid reward (including 0) is `SCORED`; a verifier crash or out-of-domain reward is `SCORING_ERROR`, never a fabricated zero:

| Status | Meaning |
|--------|---------|
| `QUEUED` | waiting for a sandbox slot |
| `RUNNING` | agent phase in progress |
| `SCORING` | agent finished; verifier running |
| `SCORED` | valid reward recorded (`score` set; 0 counts) |
| `SCORING_ERROR` | verifier crashed or returned an out-of-domain reward |
| `INFRASTRUCTURE_ERROR` | sandbox failed before a result was recorded (see `failure_phase`) |
| `INDETERMINATE` | the outcome could not be determined |
| `CANCELLED` | cancelled before settling |

**Benchmark version** — `DRAFT → IMPORTING → BUILDING → VALIDATING → READY`, with `FAILED` and `ARCHIVED` as off-ramps. Only `READY` versions accept evaluations.

---

## Types

```python
@dataclass
class AgentSystem:
    harness: str                          # 'claude' | 'codex' | 'gemini' | 'qwen' | 'kimi' | 'opencode' | 'droid'
    model: str                            # from that harness's family — see Getting Started
    harness_version: str | None = None    # pin a harness version; None = platform default

@dataclass
class Evaluation:
    id: str
    status: str                           # evaluation status above
    benchmark: str                        # 'name@version'
    runs_per_task: int
    concurrency: int
    max_model_spend_usd: float
    spent_usd: float
    created_at: str
    max_model_spend_usd_per_task_run: float | None
    sandbox_provider: str | None          # 'e2b' | 'daytona' | 'modal'
    counts: dict | None                   # {'agent_systems': n, 'tasks': n, 'task_runs': n}
    task_run_counts: dict | None          # histogram by task-run status
    agent_systems: list[AgentSystem] | None   # get() only
    benchmark_version_state: str | None       # get() only
    error: str | None                     # get() only
    updated_at: str | None                # get() only
    source_evaluation_id: str | None      # set on rerun_failed() evaluations
    idempotent_replay: bool               # True when an Idempotency-Key replayed

@dataclass
class TaskRun:
    id: str
    task_key: str
    agent_system: AgentSystem
    run_number: int                       # 1-based
    status: str                           # task-run status above
    score: float | None                   # None until scored; 0 is a score
    metrics: dict[str, float] | None      # named sub-scores
    failure_phase: str | None
    failure_detail: str | None            # truncated in list rows; full via task_run()
    phase_timings_ms: dict | None         # {'agent_ms': ..., 'verify_ms': ...}
    model_usage: ModelUsage | None
    session_ref: str | None               # agent session/trace reference
    created_at: str
    updated_at: str

@dataclass
class TaskRunDetail(TaskRun):             # task_run(id, run_id)
    evaluation_id: str
    resolved_harness_version: str | None  # harness version actually used

@dataclass
class ModelUsage:
    spend_usd: float | None
    spend_source: str | None              # 'measured' | 'assumed_cap'
    max_budget_usd: float | None
    resolved_harness_version: str | None
    extra: dict                           # harness-specific keys, snake_case

@dataclass
class TaskRunTraceEvent:
    seq: int                              # resume position for after=
    type: str
    data: dict

@dataclass
class Benchmark:                          # catalog.list() / catalog.get(ref)
    name: str
    title: str | None
    description: str | None
    active_version: BenchmarkVersion | None
    versions: list[BenchmarkVersion] | None   # get() only, newest first
    tasks: list[Task] | None                  # get() only
    # ActiveBenchmark (get_active) is the same shape with version + tasks non-optional

@dataclass
class BenchmarkVersion:
    version: str
    state: str                            # benchmark version state above
    task_count: int
    created_at: str | None

@dataclass
class Task:
    task_key: str
    agent_timeout_sec: int
    verifier_timeout_sec: int

@dataclass
class BenchmarkImport:
    id: str
    status: str                           # 'IMPORTING' | 'BUILDING' | 'VALIDATING' | 'READY' | 'FAILED'
    benchmark_name: str | None
    version: str | None
    error: BenchmarkImportError | None    # .message + .failures[(task_key, error)]
    task_count: int | None
```
