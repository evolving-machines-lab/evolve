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

Browse the catalog, then run. A bare benchmark name resolves server-side to the active `READY` version — the one benchmark-version state that accepts evaluations (see [Statuses](#statuses)):

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

Tasks expose public fields only — `task_key`, `agent_timeout_sec`, `verifier_timeout_sec`, and `providers`, the per-provider capability verdict ([Where it runs](#where-it-runs)). Instructions, environments, and tests never leave the server.

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
| `sandbox_provider` | `'e2b'` | see [Where it runs](#where-it-runs) |
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

Both forms consume the evaluation's server-sent event stream — replayed from the beginning, resumed with `Last-Event-ID` on reconnect (exponential backoff), completing on the terminal event. Iterate the events, or block for the final evaluation:

```python
async for event in evals.watch_iter(evaluation.id):
    # event.seq  — monotonic sequence number
    # event.type — 'evaluation.created' | 'task_run.settled' | 'evaluation.completed' | ...
    print(event.seq, event.type, event.data)

final = await evals.watch(
    evaluation.id,
    on_event=lambda event: print(event.type, event.data),   # optional per-event callback
    timeout_s=3600,               # (optional) raises TimeoutError past the deadline
    reconnect_delay_s=1.0,        # (optional) initial backoff, default 1 s
    max_reconnect_delay_s=30.0,   # (optional) backoff ceiling, default 30 s
)
print(final.status, final.mean_score, final.spent_usd)
```

`watch_iter()` takes the same `timeout_s` and backoff keywords. Attaching late loses nothing (the stream replays), and a disconnect resumes from the last seen sequence number — no gaps, no duplicates.

---

## Read the results

```python
# One evaluation: size, status histogram, mean score, spend
detail = await evals.get(evaluation.id)
print(detail.task_run_counts)             # {'SCORED': 12, 'RUNNING': 3, 'QUEUED': 5}
print(detail.mean_score)                  # mean over SCORED runs; None until something scores
print(detail.spent_usd, '/', detail.max_model_spend_usd)

# Your evaluations, newest first
async for item in evals.list():
    print(item.id, item.benchmark, item.status, item.mean_score, item.spent_usd)
```

Iterate task runs (pages fetched for you), or `await` one page. `status` filters, e.g. to the failures behind a rerun decision:

```python
async for run in evals.task_runs(evaluation.id):
    print(run.task_key, run.agent_system.model, run.run_number, run.status, run.score)

page = await evals.task_runs(
    evaluation.id,
    limit=100,
) # .task_runs, .next_cursor

failures = await evals.task_runs(
    evaluation.id,
    status=['INFRASTRUCTURE_ERROR', 'SCORING_ERROR'],
)
```

Fetch one run's full detail — untruncated `failure_detail`, plus the harness version actually used:

```python
detail = await evals.task_run(
    evaluation.id,
    run.id,
)
print(detail.failure_phase, detail.failure_detail)
print(detail.sandbox_provider, detail.verifier_mode)   # where the run and its verifier executed
print(detail.resolved_harness_version)
print(detail.metrics)             # named sub-scores
print(detail.phase_timings_ms)    # {'agent_ms': ..., 'verify_ms': ...}
```

Read per-run spend from `model_usage` — one money vocabulary everywhere: caps are `max_model_spend*`, actuals are `spent_usd`. `spend_source='measured'` is platform-measured spend; `'assumed_cap'` means spend could not be measured yet, so the value conservatively assumes the run's cap:

```python
if detail.model_usage:
    print(detail.model_usage.spent_usd, detail.model_usage.spend_source)
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

### Cancel / rerun failures

```python
await evals.cancel(evaluation.id)   # idempotent; a terminal evaluation is a no-op

# New linked evaluation of only the failed (and never-dispatched) runs
rerun = await evals.rerun_failed(
    evaluation.id,
    idempotency_key='rerun-1',
)
print(rerun.source_evaluation_id)   # → evaluation.id
```

`rerun_failed()` requires a terminal source evaluation. Scored runs are never re-executed.

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
          [(cell.status, cell.mean_score) for cell in row.cells])
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

Python ships no separate CLI. The TypeScript package's `evolve-evals` binary (`npx evolve-evals ...`) covers the full surface from any shell — see [TypeScript → Hosted Evals → CLI](../typescript/06-hosted-evals.md#cli).

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

Both are supported; the task picks (Harbor's `environment_mode`). The mode that ran is recorded on every task run as `verifier_mode`.

### Compute sizing

Tasks declare `cpus`, `memory_mb`, and `storage_mb`, and get exactly that. A provider whose ceiling is below the declaration **refuses the run** — named in the per-task provider verdicts below and in the run's `failure_detail` — rather than silently provisioning less. Current ceilings:

| Provider | Max vCPUs | Max memory | Disk |
|----------|-----------|------------|------|
| `e2b` | 8 | 8192 MB | fixed 20 GB |
| `daytona` | 4 | 8192 MB | sized per task, up to 10 GB |
| `modal` | 16 | 32768 MB | fixed 512 GB |

A task sized above *every* ceiling is rejected at import — it could run nowhere without running smaller than declared.

---

## Where it runs

Every task run executes in its own sandbox. Pick the provider per evaluation — the same task image, network policy, and agent command run unchanged:

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

An unknown value is rejected with a `400` at creation — never a silent fallback. Once chosen, the provider is fixed for the evaluation's life; `rerun_failed()` inherits it.

Not every task can run everywhere. The catalog tells you **before any money is spent** — every task carries a per-provider verdict:

```python
bench = await catalog.get('my-bench@1.0')
for task in bench.tasks or []:
    verdict = task.providers['modal']   # TaskProviderVerdict(ok=..., reason=...)
    if not verdict.ok:
        print(task.task_key, 'cannot run on modal:', verdict.reason)
```

Creating an evaluation whose selected tasks include one refused on the chosen provider is rejected with a `400 provider_unsupported` naming the tasks and each task's reason — never accepted and left to fail mid-run.

What the verdicts encode today:

- **Multi-container tasks run on `e2b` and `daytona`.** Modal cannot run them today — the task's `providers['modal']` verdict names the reason, and the task stays runnable on the other two providers.
- **Multi-container + `no-network` is declined on every provider** for now. Run those tasks with an `allowlist` or `public` network policy.
- **Daytona serves IP-based allowlists only.** Its network filter takes IPv4 addresses and CIDRs, capped at 10 entries — a cap that also has to fit the address the agent uses to reach its model, so a task's own list gets slightly fewer. A task whose allowlist names a hostname is refused on Daytona with the reason — run it on e2b or Modal, which serve hostname allowlists.
- **Modal caps every sandbox at 24 hours.** A task whose timeout exceeds the cap fails fast when its sandbox is created (read the run's `failure_detail`) — never truncated mid-run.
- **Sizing above a provider's ceiling** refuses on that provider only — see [Compute sizing](#compute-sizing).

---

## Bring your own benchmark

Any repo of tasks in Harbor format runs on the hosted stack: point at it, import it, let the activation gate certify it, run it. A benchmark in another format gets converted *into* Harbor format first — the layout is small, and a complete task fits on one screen (below).

> Imports require the `ADMIN` role — any other caller receives a `403`. The source is a git repository pinned to a ref.

### Already in Harbor format

```python
async with benchmarks() as catalog:
    job = await catalog.import_benchmark(
        git_url='https://github.com/acme/my-bench.git',
        ref='v1.0.0',
        benchmark_name='my-bench',
        version='1.0',                # the version label for the imported corpus
    )

    done = await catalog.watch_import(
        job.id,
        on_status=lambda j: print(j.status, j.task_count),
        poll_interval_s=2.0,          # (optional) default 2 s
        timeout_s=1800,               # (optional) raises TimeoutError past the deadline
    )
    if done.status == 'FAILED':
        print(done.error.message)     # e.g. "2/113 task(s) failed to parse"
        for failure in done.error.failures:
            print(failure.task_key, failure.error)
```

What happens next:

- **All-or-nothing parse.** Every task is parsed before anything lands; one bad task fails the whole import, with each failure named in `error.failures`. No partial corpus ever exists.
- **Strict by design.** Every `task.toml` field is either honored or the import is refused with the field and reason named — a task never silently runs on weaker semantics than it declares. Notably not yet supported: multi-step tasks (`[[steps]]`) and GPU tasks.
- **Environments are prepared at import.** Dockerfile-defined environments are built once; multi-container service images are resolved and pinned so runs are reproducible.
- **The activation gate certifies every task** before the version can activate:
  - **gold** — the task's reference solution (`solution/`) is pushed through the real agent-side + verifier path and must score exactly `1.0`. Proof the task is solvable as written.
  - **no-op** — an empty submission goes straight to the verifier and must *not* score `1.0`. A task a do-nothing agent passes measures nothing.

`IMPORTED` is the import job's terminal success: the corpus landed as a benchmark version, visible in the catalog (`catalog.get('my-bench@1.0')`) in state `VALIDATING`. Activation is a separate, operator-run step — importing never triggers it. The version stays `VALIDATING` until the gate passes in full and promotes it to `READY`, the one state that accepts evaluations; watch the state through `catalog.get()`. `run()` against any other state raises a `409 version_not_ready` naming it. Once `READY`:

```python
evaluation = await evals.run(
    benchmark='my-bench@1.0',
    agent_systems=[
        AgentSystem(
            harness='codex',
            model='gpt-5.5',
        ),
    ],
    max_model_spend_usd=25,
)
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

**Benchmark version** — `DRAFT → IMPORTING → BUILDING → VALIDATING → READY`, with `FAILED` and `ARCHIVED` as off-ramps: a failed parse or environment build lands `FAILED` before `VALIDATING` is ever reached, and `ARCHIVED` shelves a version that has been moved past. An import lands a version at `VALIDATING`; the activation gate (gold + no-op, above) then promotes it. Only `READY` versions accept evaluations. (The import job's own statuses are `IMPORTING → IMPORTED | FAILED`.)

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
    sandbox_provider: str                 # 'e2b' | 'daytona' | 'modal'
    spent_usd: float
    counts: EvaluationCounts              # agent_systems, tasks, task_runs
    created_at: str
    max_model_spend_usd_per_task_run: float | None
    task_run_counts: dict | None          # histogram by task-run status (get/list)
    mean_score: float | None              # mean over SCORED runs; None when none (get/list)
    agent_systems: list[AgentSystem] | None   # get() only
    error: str | None                     # get() only
    updated_at: str | None                # get() only
    source_evaluation_id: str | None      # set on rerun_failed() evaluations
    idempotent_replay: bool               # True when an Idempotency-Key replayed

@dataclass
class EvaluationEvent:                    # watch() / watch_iter()
    seq: int                              # monotonic; the watch resume position
    type: str                             # 'task_run.settled', 'evaluation.completed', ...
    data: dict

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
    sandbox_provider: str | None          # where the run executed; None until it has
    verifier_mode: str | None             # 'separate' | 'shared'
    resolved_harness_version: str | None  # harness version actually used
    session_ref: str | None               # agent session/trace reference
    created_at: str
    updated_at: str

@dataclass
class TaskRunDetail(TaskRun):             # task_run(id, run_id)
    evaluation_id: str                    # failure_detail is untruncated here

@dataclass
class ModelUsage:                         # one money vocabulary: caps are
    spent_usd: float | None               # max_model_spend*, actuals are spent_usd
    spend_source: str | None              # 'measured' | 'assumed_cap'
    max_model_spend_usd: float | None     # the per-run cap that applied to this run
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
    selected_version: BenchmarkVersion | None # get() only — the tasks' provenance
    tasks: list[Task] | None                  # get() only
    # ActiveBenchmark (get_active) is the same shape with version + tasks non-optional

@dataclass
class BenchmarkVersion:                   # one shape on every surface
    version: str
    state: str                            # benchmark version state above
    created_at: str
    task_count: int

@dataclass
class TaskProviderVerdict:
    ok: bool
    reason: str | None                    # the limitation, when ok is False

@dataclass
class Task:
    task_key: str
    agent_timeout_sec: int
    verifier_timeout_sec: int
    providers: dict[str, TaskProviderVerdict]  # where the task can run

@dataclass
class BenchmarkImport:
    id: str
    status: str                           # 'IMPORTING' | 'IMPORTED' | 'FAILED'
    benchmark_name: str
    version: str
    error: BenchmarkImportError | None    # .message + .failures[(task_key, error)]
    task_count: int | None
```

### Errors

Every API failure raises `EvolveAPIError` — the server's own sentence as the message, plus a stable machine-readable code to branch on:

```python
from evolve import EvolveAPIError

try:
    await evals.run(benchmark='deep-swe', agent_systems=[...], max_model_spend_usd=25)
except EvolveAPIError as error:
    print(error.status)   # e.g. 409
    print(error.code)     # e.g. 'version_not_ready', 'provider_unsupported', 'rate_limited'
    print(error)          # 'Benchmark version deep-swe@1.2 is in state VALIDATING; ...'
```

Codes you will actually branch on: `benchmark_not_found`, `benchmark_version_not_found`, `no_active_version`, `version_not_ready`, `unknown_task_keys`, `provider_unsupported`, `evaluation_not_found`, `evaluation_not_terminal`, `no_failed_runs`, `task_run_not_found`, `rate_limited`, `invalid_api_key`, and `invalid_input`.

> To operate this lifecycle yourself on your own infrastructure, see [Runtime → Task Sandboxes & Credential Lifecycle](./03-runtime.md#task-sandboxes--credential-lifecycle).
