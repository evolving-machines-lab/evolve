# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY`. Evolve runs the benchmark tasks, agents, and verifiers on managed infrastructure; you submit an evaluation and read results.

Hosted evals run agent systems (harness + model) against versioned benchmarks on Evolve's infrastructure. Two standalone clients cover the whole surface — no `Evolve` instance needed:

- `benchmarks()` — the shared benchmark catalog: list, inspect, and import benchmarks.
- `evaluations()` — create evaluations, watch progress, inspect task runs and traces, compare, and export results.

```python
from evolve import benchmarks, evaluations

catalog = benchmarks()   # Uses EVOLVE_API_KEY (or HostedClientConfig(api_key=..., dashboard_url=...))
evals = evaluations()
```

Both clients are usable directly or as async context managers (`async with evaluations() as evals:`).

Python's `watch()` differs from TypeScript's in one way: it **polls** `get()` until the evaluation is terminal, where the TypeScript SDK streams the SSE event feed with per-event callbacks. `watch()` returns the final evaluation; `watch_iter()` async-iterates the evaluation's state as it changes. For a live *event* stream from a Python script, use the [`evolve-evals` CLI](#cli) with `--watch --json`.

## Quickstart

Run `deep-swe` with two agent systems, watch it, then export the results archive:

```python
import asyncio
from evolve import benchmarks, evaluations, AgentSystem

async def main():
    # Bind the catalog client once
    catalog = benchmarks()

    # 1. Resolve the benchmark's active version (raises NoActiveVersionError if none)
    deep_swe = await catalog.get_active('deep-swe')
    print(deep_swe.version, len(deep_swe.tasks))  # version + tasks always present

    async with evaluations() as evals:
        # 2. Create the evaluation
        evaluation = await evals.run(
            benchmark=f'deep-swe@{deep_swe.version}',
            agent_systems=[
                AgentSystem(harness='codex', model='gpt-5.5'),
                AgentSystem(harness='claude', model='fable'),
            ],
            runs_per_task=1,
            concurrency=4,
            max_model_spend_usd=25,
        )
        print(evaluation.id, evaluation.status)  # 'QUEUED'

        # 3. Watch until terminal — iterate state changes (polls get())
        async for state in evals.watch_iter(evaluation.id):
            print(state.status, state.task_run_counts)
        final = await evals.get(evaluation.id)
        print(final.status, final.spent_usd)

        # 4. Inspect task runs (auto-paginates) and export the full research archive
        async for run in evals.task_runs(evaluation.id):
            print(run.task_key, run.agent_system.harness, run.status, run.score)

        path = await evals.export(evaluation.id, to='./results')
        print('Saved:', path)  # ./results/evaluation-<id>-export.json.gz

asyncio.run(main())
```

---

## Evaluation Inputs

`evaluations().run()` takes six inputs, plus an optional per-run spend cap — all keyword arguments:

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

Pair each `harness` with a model from its own family — the harness and model together form one agent system, and some harnesses only accept native models. Notably `harness='qwen'` must run a Qwen-native model (Qwen Code injects the DashScope-only `enable_thinking` parameter, which OpenAI-family models reject with a `400`), and `harness='opencode'` takes `openrouter/…` model ids. See [Getting Started → Harness and Model Pairing](./01-getting-started.md#harness-and-model-pairing) for the full rules.

`run()` and `rerun_failed()` accept `idempotency_key=` — retrying with the same key returns the original evaluation (`idempotent_replay=True`) instead of creating a duplicate.

---

## Statuses

**Evaluation** (`Evaluation.status`) — `QUEUED` → `RUNNING` (→ `CANCELLING`) → terminal `COMPLETED` / `CANCELLED` / `FAILED`:

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
| `INFRASTRUCTURE_ERROR` | Sandbox lost before a durable artifact existed (see `failure_phase`) |
| `INDETERMINATE` | Dispatch/completion uncertainty — the platform cannot prove what happened |
| `CANCELLED` | Cancelled before settling |

**Benchmark version** (`BenchmarkVersion.state`): `DRAFT` → `IMPORTING` → `BUILDING` → `VALIDATING` → `READY` (runnable), with `FAILED` and `ARCHIVED` as the off-ramps. An import lands a new version at `VALIDATING`; the `VALIDATING` → `READY` promotion is the conformance activation gate's alone (see [import_benchmark](#import_benchmark--get_import--watch_import)), and only `READY` versions accept evaluations.

---

## Benchmarks Client

```python
from evolve import benchmarks
catalog = benchmarks()

# Every benchmark with its active version
all_benchmarks = await catalog.list()
# [Benchmark(name=..., display_title=..., description=..., active_version=BenchmarkVersion(...))]

# One benchmark: all versions + the selected version's task list
bench = await catalog.get('deep-swe')                 # active version's tasks
pinned = await catalog.get('deep-swe@1.0')            # specific version
same = await catalog.get('deep-swe', version='1.0')   # equivalent

# The active version resolved to a runnable shape — version + tasks guaranteed
active = await catalog.get_active('deep-swe')
print(active.version, len(active.tasks))
```

`get()` returns `versions` (newest first), `tasks_version`, and `tasks`. Tasks expose public fields only — `task_key`, `agent_timeout_sec`, `verifier_timeout_sec`. Instructions, environments, and tests never leave the server.

`get_active(name)` resolves the active version to a runnable shape where `version` and `tasks` are non-optional; it raises `NoActiveVersionError` when the benchmark has no active version, so the happy path never branches on a missing version. Use `get()` for the full multi-version detail.

### import_benchmark / get_import / watch_import

Import a benchmark from a git repository into the shared catalog. The import runs server-side as a parse → validate pipeline that lands the new version at `VALIDATING`; a separate conformance activation gate owns the promotion to `READY`:

```python
job = await catalog.import_benchmark(
    {'git_url': 'https://github.com/org/my-benchmark.git', 'ref': 'v1.2.0'},
    benchmark_name='my-benchmark',
    version='1.2',              # (optional) omit to let the server assign one
)
print(job.id, job.state)        # accepted for processing

# Poll one import job
status = await catalog.get_import(job.id)
print(status.state, status.task_count, status.error)

# Or block until the import reaches a terminal state ('READY' or 'FAILED')
done = await catalog.watch_import(
    job.id,
    on_state=lambda import_job: print(import_job.state),  # (optional) fires on every state change
    poll_interval_s=2.0,                # (optional) default 2s
    timeout_s=1800,                     # (optional) raise TimeoutError after this long
)
```

An import runs in two stages. The **importer** clones the pinned git source, parses the corpus, and lands the new version at `VALIDATING` (or `FAILED`, with `error` populated) — it never promotes to `READY`. Promotion is a separate **conformance activation** gate: for every task it runs the corpus' held-out gold solution through the real agent-and-verifier path and pushes an empty no-op patch straight to the verifier, then records a per-task activation verdict. A version is activated to `READY` only when every task's gold solution scores exactly `1.0` and its no-op does **not** — a task a do-nothing agent can pass measures nothing. A gold solution that passes only on a retry is flagged flaky (still eligible unless the gate runs in strict mode); a task where gold or the no-op check yields no usable score blocks activation.

Because promotion is a distinct step, `watch_import()` resolves when the version reaches `READY` (activation succeeded) or `FAILED` (raising `TimeoutError` if `timeout_s` elapses first); a freshly imported version rests at `VALIDATING` until the activation gate runs. Only `READY` versions accept evaluations — `evaluations().run()` rejects a non-`READY` benchmark and `get_active()` raises `NoActiveVersionError` until a version is activated.

Imports are gated per deployment: only user ids listed in `EVAL_IMPORT_ALLOWED_USER_IDS` may import, and when that variable is unset or empty imports are disabled for everyone (the call returns `403`). Archive-upload and Harbor Hub sources are part of the typed surface but not accepted by the server yet — git is the supported source (other source kinds raise `NotImplementedError`).

---

## Evaluations Client

```python
from evolve import evaluations, AgentSystem
evals = evaluations()
```

### run / get / list

```python
evaluation = await evals.run(
    benchmark='deep-swe@1.1',
    agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
    max_model_spend_usd=25,
)

# Detail: agent systems + task-run status counts + spend
detail = await evals.get(evaluation.id)
print(detail.task_run_counts)   # {'SCORED': 12, 'RUNNING': 3, 'QUEUED': 5}
print(detail.spent_usd, '/', detail.max_model_spend_usd)

# Your evaluations, newest first — await one page (cursor-paged)
page = await evals.list(limit=50)
next_page = await evals.list(cursor=page.next_cursor)

# ...or iterate every evaluation across all pages (cursors walked for you)
async for item in evals.list():
    print(item.id, item.status)
```

`list()` returns a dual-use handle: `await` it for a single `EvaluationPage`, or `async for` it to walk every evaluation across cursor pages.

### task_runs / task_run

```python
# Await one page (cursor-paged) — total_count included
page = await evals.task_runs(evaluation.id, limit=100)
print(page.total_count)

# ...or iterate every task run across all pages (cursors walked for you)
async for run in evals.task_runs(evaluation.id):
    print(run.task_key, run.run_number, run.status, run.score)
    print(run.metrics)                    # named sub-scores from reward.json
    print(run.phase_timings_ms)           # {'agentMs': ..., 'verifyMs': ...}
    print(run.model_usage)                # spendUsd, spendSource, harnessVersion (resolved)
    print(run.session_ref)                # agent session/trace reference
    print(run.failure_phase, run.failure_detail)  # populated on failures

# Full detail for one task run (untruncated failure_detail)
detail = await evals.task_run(evaluation.id, page.task_runs[0].id)
print(detail.harness_version_resolved)    # harness version actually used
print(detail.session_ref)
```

**Reading spend.** `model_usage['spendUsd']` is LiteLLM's number — the only spend truth. Its `spendSource` is `'key_info'` when the value was read back from the gateway and `'assumed_cap'` when it falls back to the run's cap. Read-back can lag or be missing on the gemini-passthrough and OpenRouter routes, so a run's recorded spend may sit at the assumed cap (or zero) until spend-log reconciliation catches up — the task run's trace and token counts are the reliable engagement signal in the meantime.

### task_run_trace

Fetch the recorded event trace of a single task run (seq-paged):

```python
# Page manually...
page = await evals.task_run_trace(evaluation.id, run_id, after=0, limit=500)
for event in page.events:
    print(event.seq, event.type, event.data)
# ...resume with after=page.next_after, or drain with the async iterator:
async for event in evals.task_run_trace_events(evaluation.id, run_id):
    print(event.seq, event.type)
```

Pass the last seen `next_after` as `after=` to resume — the same pattern works for incremental polling while a run is still executing.

### watch / watch_iter

`watch()` polls `get()` until the evaluation reaches a terminal status and returns the final evaluation. `watch_iter()` is the async-iterator sibling — it yields the evaluation on every status/count change, then stops at the terminal state:

```python
# Iterate the evaluation's state as it changes
async for state in evals.watch_iter(evaluation.id):
    print(state.status, state.task_run_counts)

# Or block for the final evaluation, with an optional on_change callback
final = await evals.watch(
    evaluation.id,
    on_change=lambda ev: print(ev.status, ev.task_run_counts),  # (optional) fires on status/count changes
    poll_interval_s=2.0,   # (optional) default 2s
    timeout_s=3600,        # (optional) raise TimeoutError after this long
)
```

Both poll `get()`; for a live *event* stream (SSE), use the [`evolve-evals` CLI](#cli) with `--watch`.

### cancel / rerun_failed

```python
# Request cancellation — idempotent; cancelling a terminal evaluation is a no-op
await evals.cancel(evaluation.id)

# New linked evaluation of only the failed (and never-dispatched) task runs
rerun = await evals.rerun_failed(evaluation.id, idempotency_key='rerun-1')
print(rerun.source_evaluation_id)  # → evaluation.id
```

`rerun_failed()` requires a terminal source evaluation. Scored runs are never re-executed; the rerun contains only runs that failed or never dispatched.

### compare

Compare terminal evaluations side by side — per-evaluation aggregates plus a task-level matrix:

```python
comparison = await evals.compare([eval_a.id, eval_b.id])

# Aggregates: one row per evaluation, in your id order
for row in comparison.evaluations:
    print(row.id, row.mean_score, f'{row.coverage.scored}/{row.coverage.total} scored')

# Matrix: one row per task, one cell per evaluation (disagreement rows first)
for row in comparison.task_matrix:
    print(row.task_key, row.disagreement, [(cell.status, cell.score) for cell in row.cells])
```

Means cover `SCORED` runs only; coverage (`scored`/`total`) is always reported so a high mean over few scored runs is visible. A cell's `status` is `'MIXED'` when its runs disagree and `'MISSING'` when the evaluation has no runs for the task.

### export

Download the full research archive (gzipped JSON) of a terminal evaluation:

```python
# Default: bytes in memory
payload = await evals.export(evaluation.id)

# Save to a directory — returns the file path
path = await evals.export(evaluation.id, to='./results')

# Harbor job-layout bundle instead of the canonical archive
harbor_path = await evals.export(evaluation.id, to='./results', format='harbor')
```

---

## CLI

The TypeScript package ships an `evolve-evals` binary usable from any environment with Node.js — including alongside Python projects. It covers the full command set — run, list, get, task-runs, cancel, rerun-failed, and export — plus the benchmark catalog and git imports (`import` / `import status`), and `--watch` streams live events (the SSE path Python's `watch()` does not use):

```bash
npx evolve-evals run --benchmark deep-swe@1.1 --system codex:gpt-5.5 --max-spend 25 --watch
npx evolve-evals import --git https://github.com/acme/my-bench.git --ref main --name my-bench --watch
npx evolve-evals task-runs <id> --json
npx evolve-evals export <id> --to ./results --format harbor
```

See [TypeScript → Hosted Evals → CLI](../typescript/06-hosted-evals.md#cli) for the full command reference.

---

## Sandbox Providers

Hosted eval task runs and managed agent sessions run on the same three sandbox providers — E2B, Daytona, and Modal. Managed sessions resolve a provider from env (Configuration → [Sandbox Providers](./02-configuration.md#sandbox-providers)); eval task runs resolve one from `EVAL_SANDBOX_PROVIDER` on the eval worker. All three honor the same provider-neutral create options (image, `user`/`homeDir`, outbound network policy, timeout), so one benchmark image and one network policy run unchanged across every provider. The honest differences:

| Capability | E2B | Daytona | Modal |
|------------|-----|---------|-------|
| `EVAL_SANDBOX_PROVIDER` value | `e2b` (default) | `daytona` | `modal` |
| Run agent as root | Native `user='root'` | Image `USER` (root by default); no per-exec user switch | Native execution user is root |
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

```python
@dataclass
class AgentSystem:
    harness: str                      # e.g. 'codex', 'claude'
    model: str                        # e.g. 'gpt-5.5', 'fable'
    harness_version: str | None       # pin a harness version; None = platform default

@dataclass
class ActiveBenchmark:                 # benchmarks().get_active(name)
    name: str
    display_title: str | None
    description: str | None
    active_version: BenchmarkVersion  # always present (get_active raises otherwise)
    version: str                      # active version string (non-optional)
    tasks: list[Task]                 # active version's tasks (non-optional)
    versions: list[BenchmarkVersion]  # all versions, newest first
    tasks_version: str | None
    created_at: str | None
    updated_at: str | None
    # get_active() raises NoActiveVersionError when the benchmark has no active version

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
