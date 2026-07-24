# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY` (see [Getting Started → Gateway Mode](./01-getting-started.md#gateway-mode-evolve_api_key)). Evolve runs the benchmark tasks, agents, and verifiers on managed infrastructure; you submit a job and read results.

Three standalone clients cover the whole surface — no `Evolve` instance needed:

```python
from evolve import benchmarks, custom_harnesses, jobs

catalog = benchmarks()          # shared benchmark catalog
harnesses = custom_harnesses()  # your own private harnesses
evals = jobs()                  # create, watch, and read jobs
```

All three read `EVOLVE_API_KEY` (or take `HostedClientConfig(api_key=..., base_url=...)`) and work standalone or as `async with` context managers.

---

## Run a job

Browse the catalog, then run. A bare benchmark name resolves server-side to the active `READY` version — the one benchmark-version state that accepts jobs (see [Statuses](#statuses)):

```python
from evolve import benchmarks, jobs, JobAgent

async with benchmarks() as catalog:
    print([bench.name for bench in await catalog.list()])

    active = await catalog.get_active('deep-swe')   # raises NoActiveVersionError when none
    print(active.version, [task.task_key for task in active.tasks])

async with jobs() as evals:
    job = await evals.run(
        benchmark='deep-swe',                       # or pin a version: 'deep-swe@1.1'
        agents=[
            JobAgent(
                harness='codex',
                model='gpt-5.5',
            ),
            JobAgent(
                harness='claude',
                model='fable',
            ),
        ],
        concurrency=4,
        max_trial_spend_usd=25,
    )
    print(job.id, job.status)   # QUEUED
    print(job.benchmark)        # 'deep-swe@1.1' — the resolved version, echoed back
```

Tasks expose public fields only — `task_key`, `agent_timeout_sec`, `verifier_timeout_sec`, and `providers`, the per-provider capability verdict ([Where it runs](#where-it-runs)). Instructions, environments, and tests never leave the server.

`run()` keyword arguments:

| Keyword | Default | What it does |
|---------|---------|--------------|
| `benchmark` | required | `'name'` (active `READY` version) or `'name@version'` |
| `agents` | required | list of `JobAgent(harness=..., model=..., harness_version=None)` |
| `tasks` | all tasks | task keys to run |
| `runs_per_task` | `1` | runs per task × agent |
| `concurrency` | `1` | parallel trials |
| `max_trial_spend_usd` | `200` | hard model-spend cap (USD) for EACH trial |
| `sandbox_provider` | `'e2b'` | see [Where it runs](#where-it-runs) |
| `idempotency_key` | none | safe-retry key (below) |

`max_trial_spend_usd` caps what a single trial may spend on model calls, and it is the only spend limit the platform enforces: every trial runs on its own freshly minted gateway key, and the cap is that key's budget. Leave it out and the platform applies $200 per trial. The response always reports the cap that actually applied — `job.max_trial_spend_usd` — so an omitted one is never a mystery.

There is no job-wide budget, which means a job's real ceiling is simply its trial count times that cap. The response states it for you as `job.worst_case_spend_usd`, so you can see what a large matrix commits you to before it starts running. Your account credit balance is the hard backstop underneath all of it: when the balance runs out, spending stops mid-job whatever the caps say, and creating a job while the balance is already at zero is refused up front with a `402 insufficient_credits`. A trial that exhausts its own cap is not a failure — the harness just runs out of budget, and the trial is still scored on whatever it produced.

Runs on your own provider key are the one exception to the credit ledger. When a [managed BYO provider key](./01-getting-started.md#managed-byo-provider-keys) is enabled for the model's provider (Anthropic and OpenAI today), the trial's model calls bill your provider account directly and draw no Evolve credits — the per-trial cap still meters and bounds the trial exactly as before.

A job expands to `tasks × agents × runs_per_task` trials, each in its own sandbox. Valid harness + model pairs are listed once in [Getting Started → Harness and Model Pairing](./01-getting-started.md#harness-and-model-pairing). `harness` also accepts a harness you registered yourself — see [Bring your own harness](#bring-your-own-harness).

Pin a harness version when you need the comparison to hold still across weeks:

```python
agents=[
    JobAgent(
        harness='codex',
        model='gpt-5.5',
        harness_version='0.29.0',   # (optional) omit to resolve the latest at dispatch
    ),
],
```

Omitting it keeps the resolve-latest behavior; either way the version that actually ran is recorded on every trial as `resolved_harness_version`, so a trial is always attributable after the fact.

A pin is never silently downgraded to the latest — it is checked at creation and rejected three ways:

- **Not an exact version** (a range, a tag, `latest`) — `400 invalid_input`, naming the need for an exact version. Pins exist to hold a comparison still, and a range cannot.
- **Exact but not published** — `404 harness_version_not_found`.
- **A pin on a custom harness** — `400 invalid_input`. Custom harnesses are versioned by the content of their own source, so there is no separate version axis to pin; re-register to change what runs.

One harness resolves later than the others: installer-sourced `kimi` accepts any well-formed exact pin at creation, because its vendor publishes no version index to check against. The builder's version probe enforces it instead, so a bad `kimi` pin surfaces as a failed trial rather than a `400`.

Retrying with the same `idempotency_key` returns the original job instead of creating a duplicate:

```python
job = await evals.run(
    ...,
    idempotency_key='nightly-2026-07-23',
)
print(job.idempotent_replay)   # True on a replay
```

---

## Watch it live

Both forms consume the job's server-sent event stream — replayed from the beginning, resumed with `Last-Event-ID` on reconnect (exponential backoff), completing on the terminal event. Iterate the events, or block for the final job:

```python
async for event in evals.watch_iter(job.id):
    # event.seq  — monotonic sequence number
    # event.type — 'job.created' | 'trial.settled' | 'job.completed' | ...
    print(event.seq, event.type, event.data)

final = await evals.watch(
    job.id,
    on_event=lambda event: print(event.type, event.data),   # optional per-event callback
    timeout_s=3600,               # (optional) raises TimeoutError past the deadline
    reconnect_delay_s=1.0,        # (optional) initial backoff, default 1 s
    max_reconnect_delay_s=30.0,   # (optional) backoff ceiling, default 30 s
)
print(final.status, final.mean_reward, final.spent_usd)
```

`watch_iter()` takes the same `timeout_s` and backoff keywords. Attaching late loses nothing (the stream replays), and a disconnect resumes from the last seen sequence number — no gaps, no duplicates.

---

## Read the results

```python
# One job: size, status histogram, mean reward, spend
detail = await evals.get(job.id)
print(detail.trial_counts)                # {'SCORED': 12, 'RUNNING': 3, 'QUEUED': 5}
print(detail.mean_reward)                 # mean over SCORED trials; None until something scores
print(detail.spent_usd, '/', detail.worst_case_spend_usd)

# Your jobs, newest first
async for item in evals.list():
    print(item.id, item.benchmark, item.status, item.mean_reward, item.spent_usd)
```

Iterate trials (pages fetched for you), or `await` one page. `status` filters, e.g. to the failures behind a rerun decision:

```python
async for trial in evals.trials(job.id):
    print(trial.task_key, trial.agent.model, trial.run_number, trial.status, trial.reward)

page = await evals.trials(
    job.id,
    limit=100,
) # .trials, .next_cursor

failures = await evals.trials(
    job.id,
    status=['INFRASTRUCTURE_ERROR', 'SCORING_ERROR'],
)
```

Fetch one trial's full detail — untruncated `failure_detail`, plus the harness version actually used:

```python
detail = await evals.trial(
    job.id,
    trial.id,
)
print(detail.failure_phase, detail.failure_detail)
print(detail.sandbox_provider, detail.verifier_mode)   # where the trial and its verifier executed
print(detail.resolved_harness_version)
print(detail.metrics)             # named sub-scores
print(detail.phase_timings_ms)    # {'agent_ms': ..., 'verify_ms': ...}
```

Read per-trial spend from `model_usage` — one money vocabulary everywhere: the cap is `max_trial_spend_usd`, actuals are `spent_usd`. `spend_source='measured'` is platform-measured spend; `'assumed_cap'` means spend could not be measured yet, so the value conservatively assumes the trial's cap:

```python
if detail.model_usage:
    print(detail.model_usage.spent_usd, detail.model_usage.spend_source)
```

Stream a trial's recorded event trace; resume later from the last seen `seq`:

```python
async for event in evals.trial_trace_events(
    job.id,
    trial.id,
):
    print(event.seq, event.type, event.data)

page = await evals.trial_trace(
    job.id,
    trial.id,
    after=last_seq,
    limit=500,
)
```

### Cancel / rerun failures

```python
await evals.cancel(job.id)   # idempotent; a terminal job is a no-op

# New linked job of only the failed (and never-dispatched) trials
rerun = await evals.rerun_failed(
    job.id,
    idempotency_key='rerun-1',
)
print(rerun.source_job_id)   # → job.id
```

`rerun_failed()` requires a terminal source job. Scored trials are never re-executed.

---

## Regrade

A regrade re-runs **only the verifier**. The trial's recorded submission — the patch and artifacts captured when it ran — is restored into a fresh, sealed verifier sandbox and scored again; the agent phase is never re-run, and the source trial is never modified. Use it when a verifier was fixed or tightened and you want the same agent work re-scored under it, without paying for a single new agent run.

```python
# One trial
single = await evals.regrade_trial(job.id, trial.id)

# Every regradable trial of a terminal job — optionally narrowed
bulk = await evals.regrade(
    job.id,
    status=['SCORED'],        # (optional) only source trials in these statuses
    task_key='task-001',      # (optional) only source trials of this task
)

# Read it back: QUEUED → RUNNING → COMPLETED, one result per source trial
done = await evals.regrade_job(bulk.id)
for result in done.results or []:
    print(result.task_key, result.source_reward, '→', result.reward,
          result.reward_delta)   # reward − source_reward, the per-trial delta
```

All three return a `RegradeJob`. A per-trial regrade holds one result; a per-job regrade holds one per selected source trial. Poll `regrade_job()` until `status` is `'COMPLETED'` — `counts.by_status` is the running histogram.

### Eligibility

Regradability is defined by the record, not by intent: a trial is regradable only if it **recorded its verifier inputs** when it settled. Settled `separate`-mode trials record them; nothing else does. That one gate has three consequences:

- **Shared-mode trials can never be regraded.** Their verifier inspected the live agent sandbox, which no longer exists — there is nothing faithful to re-run.
- **In-flight trials (`QUEUED`, `RUNNING`, `SCORING`) are not yet regradable** — they have not settled, so nothing is recorded.
- **Trials that settled before the platform began recording verifier inputs are permanently ineligible.** The inputs were never captured, and cannot be reconstructed after the fact.

A single-trial regrade of an ineligible source is refused with a `409 regrade_source_ineligible` naming the specific reason. A whole-job regrade requires a terminal source job (`409 job_not_terminal` otherwise), selects only the eligible trials, and is refused with a `409 no_regradable_runs` when there are none.

### Reading a regrade

Every `RegradeResult` carries the comparison you actually want:

- `source_reward` and `source_status` — immutable snapshots of the source trial, taken when the regrade was created. The source trial's own row is untouched.
- `reward` and `metrics` — what the fresh verifier run produced.
- `reward_delta` — `reward − source_reward` when both are real numbers, else `None`.
- `verifier_digest` — a content digest of the verifier that ran, the "verifier version". A digest equal to the source trial's own verifier means the regrade reproduces the recorded verdict; a different digest means a genuine prediction of what the new verifier scores.

Result statuses mirror the trial reward law: a valid reward (including 0) is `SCORED`; a verifier crash or out-of-domain reward is `SCORING_ERROR`; a missing reward file is `INDETERMINATE`; a verifier box lost before a durable verdict is `INFRASTRUCTURE_ERROR`. The verifier always runs `separate` and sealed; `sandbox_provider` on the regrade job names where its verifier boxes run — the source job's provider.

The same surface is on the CLI:

```bash
npx evolve-evals regrade <id>                       # whole job
npx evolve-evals regrade <id> <trial-id>            # one trial
npx evolve-evals regrade <id> --status SCORED --task task-001
npx evolve-evals regrade-job <regrade-job-id>       # rewards, deltas, lineage
```

`--status` and `--task` apply to a whole-job regrade only; passing them with a trial id is a usage error.

---

## Compare

Compare 2–5 of your jobs side by side — per-job aggregates plus a per-task matrix, disagreement rows first:

```python
comparison = await evals.compare([baseline.id, candidate.id])

for aggregate in comparison.jobs:
    print(aggregate.id, aggregate.mean_reward,
          f'{aggregate.coverage.scored}/{aggregate.coverage.total} scored')

for row in comparison.task_matrix:
    print(row.task_key, row.disagreement,
          [(cell.status, cell.mean_reward) for cell in row.cells])
```

Means cover `SCORED` trials only; coverage is always reported so a high mean over few scored trials stays visible. A cell's status is `'MIXED'` when its trials disagree and `'MISSING'` when the job has no trials for that task.

---

## Export

Download the research archive (gzipped JSON) of a terminal job:

```python
archive_path = await evals.export(
    job.id,
    to='./results',
) # saved file path
harbor_path = await evals.export(
    job.id,
    to='./results',
    format='harbor',
) # Harbor job layout
archive_bytes = await evals.export(job.id) # bytes in memory
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

A task also declares *how* it must run, and every declaration is honored as written. A provider that cannot honor one refuses the trial with the reason named — nothing ever silently runs on weaker semantics than the task declares.

### Network modes

Tasks declare the agent sandbox's network access:

- `no-network` — sealed; the agent reaches nothing but its model.
- `allowlist` — only the hosts the task names.
- `public` — open internet (Harbor's default when a task declares nothing).

The **verifier never gets network**, in any mode — it always runs sealed, regardless of what the task declares.

### Verifier modes

- `separate` — the verifier boots a pristine copy of the task environment and judges the collected submission. Nothing the agent left behind can touch the verdict.
- `shared` — the verifier command runs inside the agent's sandbox, after the agent finishes and its credentials are revoked.

Both are supported; the task picks (Harbor's `environment_mode`). The mode that ran is recorded on every trial as `verifier_mode`.

### Compute sizing

Tasks declare `cpus`, `memory_mb`, and `storage_mb`, and get exactly that. A provider whose ceiling is below the declaration **refuses the trial** — named in the per-task provider verdicts below and in the trial's `failure_detail` — rather than silently provisioning less. Current ceilings:

| Provider | Max vCPUs | Max memory | Disk |
|----------|-----------|------------|------|
| `e2b` | 8 | 8192 MB | fixed 20 GB |
| `daytona` | 4 | 8192 MB | sized per task, up to 10 GB |
| `modal` | 16 | 32768 MB | fixed 512 GB |

A task sized above *every* ceiling is rejected at import — it could run nowhere without running smaller than declared.

---

## Where it runs

Every trial executes in its own sandbox. Pick the provider per job — the same task image, network policy, and agent command run unchanged:

```python
job = await evals.run(
    benchmark='swe-bench-verified@1.0',
    agents=[
        JobAgent(
            harness='codex',
            model='gpt-5.5',
        ),
    ],
    max_trial_spend_usd=25,
    sandbox_provider='daytona',   # 'e2b' (default) | 'daytona' | 'modal'
)
```

An unknown value is rejected with a `400` at creation — never a silent fallback. Once chosen, the provider is fixed for the job's life; `rerun_failed()` inherits it.

Not every task can run everywhere. The catalog tells you **before any money is spent** — every task carries a per-provider verdict:

```python
bench = await catalog.get('my-bench@1.0')
for task in bench.tasks or []:
    verdict = task.providers['modal']   # TaskProviderVerdict(ok=..., reason=...)
    if not verdict.ok:
        print(task.task_key, 'cannot run on modal:', verdict.reason)
```

Creating a job whose selected tasks include one refused on the chosen provider is rejected with a `400 provider_unsupported` naming the tasks and each task's reason — never accepted and left to fail mid-run.

What the verdicts encode today:

- **Multi-container tasks run on `e2b` and `daytona`.** Modal cannot run them today — the task's `providers['modal']` verdict names the reason, and the task stays runnable on the other two providers.
- **Multi-container + `no-network` is declined on every provider** for now. Run those tasks with an `allowlist` or `public` network policy.
- **Daytona serves IP-based allowlists only.** Its network filter takes IPv4 addresses and CIDRs, capped at 10 entries — a cap that also has to fit the address the agent uses to reach its model, so a task's own list gets slightly fewer. A task whose allowlist names a hostname is refused on Daytona with the reason — run it on e2b or Modal, which serve hostname allowlists.
- **Modal caps every sandbox at 24 hours.** A task whose timeout exceeds the cap fails fast when its sandbox is created (read the trial's `failure_detail`) — never truncated mid-run.
- **Sizing above a provider's ceiling** refuses on that provider only — see [Compute sizing](#compute-sizing).

---

## Bring your own benchmark

Any corpus of tasks in Harbor format runs on the hosted stack: point at it, import it, let the activation gate certify it, run it. A benchmark in another format gets converted *into* Harbor format first — the layout is small, and a complete task fits on one screen (below).

What you import is **private to your account**. It never appears in anyone else's catalog, and another account asking for its name reads a plain `404 benchmark_not_found` — existence is never leaked. Your own `catalog.list()` shows the shared platform benchmarks plus your imports. A name belongs to its first importer: re-importing a name you own extends that benchmark with a new version (or refreshes one), while importing a name owned by anyone else — a platform benchmark or another account's private one — is refused with a `409 benchmark_name_taken`.

### Already in Harbor format

Import from a git repository pinned to a ref, or upload a local corpus directory — the same corpus, the same pipeline, the same rules either way:

```python
async with benchmarks() as catalog:
    # From a git repository, pinned to a ref
    import_job = await catalog.import_benchmark(
        git_url='https://github.com/acme/my-bench.git',
        ref='v1.0.0',                 # a branch, tag, or commit — always pinned
        benchmark_name='my-bench',
        version='1.0',                # the version label for the imported corpus
    )

    # Or from a local directory — tarred + gzipped deterministically and uploaded
    local_import = await catalog.import_benchmark(
        directory='./my-bench',
        benchmark_name='my-bench',
        version='1.0',
    )

    done = await catalog.watch_import(
        import_job.id,
        on_status=lambda j: print(j.status, j.task_count),
        poll_interval_s=2.0,          # (optional) default 2 s
        timeout_s=1800,               # (optional) raises TimeoutError past the deadline
    )
    if done.status == 'FAILED':
        print(done.error.message)     # e.g. "2/113 task(s) failed to parse"
        for failure in done.error.failures:
            print(failure.task_key, failure.error)
```

Every lane resolves to the same thing — a Harbor-layout directory — and is held to the same rules. The corpus root is a directory whose `tasks/` subdirectory holds one directory per task, or the tasks directory itself. Provenance is recorded per lane: the resolved commit for a git import, the sha256 of the exact uploaded bytes for a directory. On the wire a directory import is simply a gzipped tarball POSTed to the import endpoint — the SDK produces it for you — and uploads past the compressed-size cap (512 MB by default) are refused with a `413 import_too_large`.

What happens next:

- **All-or-nothing parse.** Every task is parsed before anything lands; one bad task fails the whole import, with each failure named in `error.failures`. No partial corpus ever exists.
- **Strict by design.** Every `task.toml` field is either honored or the import is refused with the field and reason named — a task never silently runs on weaker semantics than it declares. Notably not yet supported: multi-step tasks (`[[steps]]`) and GPU tasks.
- **Environments are prepared at import.** Dockerfile-defined environments are built once; multi-container service images are resolved and pinned so runs are reproducible.
- **The activation gate certifies every task** before the version can activate:
  - **gold** — the task's reference solution (`solution/`) is pushed through the real agent-side + verifier path and must score exactly `1.0`. Proof the task is solvable as written.
  - **no-op** — an empty submission goes straight to the verifier and must *not* score `1.0`. A task a do-nothing agent passes measures nothing.

`IMPORTED` is the import job's terminal success: the corpus landed as a benchmark version, visible in the catalog (`catalog.get('my-bench@1.0')`) in state `VALIDATING`. Activation is a separate, operator-run step — importing never triggers it. The version stays `VALIDATING` until the gate passes in full and promotes it to `READY`, the one state that accepts jobs; watch the state through `catalog.get()`. `run()` against any other state raises a `409 version_not_ready` naming it. Once `READY`:

```python
job = await evals.run(
    benchmark='my-bench@1.0',
    agents=[
        JobAgent(
            harness='codex',
            model='gpt-5.5',
        ),
    ],
    max_trial_spend_usd=25,
)
```

### Not in Harbor format yet

Convert it. A benchmark is a directory tree with one directory per task under `tasks/`; the directory name is the task key. A minimal complete task:

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

## Bring your own harness

The built-in harnesses (`claude`, `codex`, `gemini`, `qwen`, `kimi`, `opencode`, `droid`) are not the boundary. Register your own CLI once, and its name becomes usable in `agents[].harness` exactly like a built-in:

```python
from evolve import custom_harnesses, jobs, JobAgent

async with custom_harnesses() as harnesses:
    await harnesses.create(
        name='acme-cli',                                              # the name you will pass as harness
        install_script='curl -fsSL https://acme.dev/install.sh | sh', # the script itself, not a path
        run_command='acme-cli --headless',
        env={'ACME_PROFILE': 'bench'},                                # (optional) injected at run time
    )

async with jobs() as evals:
    job = await evals.run(
        benchmark='deep-swe',
        agents=[
            JobAgent(
                harness='acme-cli',
                model='gpt-5.5',
            ),
        ],
        max_trial_spend_usd=25,
    )
```

A harness that is not a one-line install ships as a directory instead — tarred deterministically on the client and uploaded:

```python
await harnesses.create(
    name='acme-cli',
    directory='./harnesses/acme-cli',   # EITHER directory OR install_script, never both
    run_command='acme-cli --headless',
)
```

Read and remove them the same way:

```python
registered = await harnesses.list()      # your harnesses only
one = await harnesses.get('acme-cli')    # name, source, run_command, env, timestamps
await harnesses.delete('acme-cli')       # past jobs keep the harness they recorded
```

The same surface is on the `evolve-evals` CLI — see [TypeScript → Bring your own harness](../typescript/06-hosted-evals.md#bring-your-own-harness).

Harnesses are private to their owner. Another account's name reads as `custom_harness_not_found`, never as a permission error — existence is never leaked.

### The run contract

Everything a custom harness can rely on, and nothing else. Your `run_command` runs headless with `sh -c` at the task's working directory, and:

- **The task instruction arrives twice, so read it whichever way your CLI prefers.** It is written to the command's **stdin**, and it is also on disk at the path in `$EVOLVE_INSTRUCTION_FILE`.
- **The model is reached through a gateway, not a provider.** `$EVOLVE_GATEWAY_BASE_URL` is an OpenAI-compatible base URL that **already ends in `/v1`** — never append it yourself — and `$EVOLVE_GATEWAY_API_KEY` is the credential for it. The same two values are also exported as `$OPENAI_BASE_URL` and `$OPENAI_API_KEY`, so a CLI that **reads its endpoint from the environment** works unchanged. A CLI that routes through a **config file** does not — see below.
- **`$EVOLVE_MODEL` names the model being evaluated** — the `model` of the agent this trial belongs to.
- **Your declared `env` is injected at run time only**, and it may **not** override those contract keys. An attempt to is rejected at registration with `custom_harness_invalid_env`, not silently dropped at run time. The six contract keys are `EVOLVE_GATEWAY_BASE_URL`, `EVOLVE_GATEWAY_API_KEY`, `EVOLVE_MODEL`, `EVOLVE_INSTRUCTION_FILE`, `OPENAI_BASE_URL` and `OPENAI_API_KEY`.

#### If your CLI routes through a config file

Env-only routing covers CLIs that read `OPENAI_BASE_URL`. Plenty do not: they want a config file, and they read it from a path in `$HOME`. Three of our own seven built-ins are in that group, so this is the common case and not an edge one.

Write that file **inside your `run_command`**, from the contract values. It cannot be written at install time: the install ran in a different sandbox entirely, and by the time your harness runs the box has no network to fetch anything with. `codex` is the worked example — this is what the platform itself does for the built-in:

```bash
# run_command for a codex-shaped CLI
mkdir -p ~/.codex && cat > ~/.codex/config.toml <<EOF
model_provider = "evolve"
[model_providers.evolve]
name = "evolve"
base_url = "$EVOLVE_GATEWAY_BASE_URL"
env_key = "EVOLVE_GATEWAY_API_KEY"
wire_api = "responses"
EOF
codex login --with-api-key <<< "$EVOLVE_GATEWAY_API_KEY"
codex exec --skip-git-repo-check -
```

If your CLI ignores `OPENAI_BASE_URL` and you do not do this, it will try to reach its vendor's own endpoint, find the box sealed, and burn the whole agent budget failing to connect.

How it is built, and what that costs you:

- The install script (or the uploaded tarball) runs once in a **throwaway builder sandbox that has internet and ZERO secrets**. Everything it fetches must therefore be **publicly fetchable** — a private registry that needs a token cannot be reached from there — and it must leave its executables in **`$PREFIX/bin`**.
- A custom harness is **versioned by its registered content** — the install source, the `run_command` and the declared `env`, together — so `harness_version` on an agent using it is rejected. Change any of the three and you get a new recorded version and a new bundle digest; re-register (delete, then create) to change what runs.
- **You may register up to 25 harnesses.** Past that, registration is refused with `custom_harness_limit_reached`; delete one to make room. Each registration is a full CLI the platform builds and caches for you.

**What keeps a trial inside its budget.** The spend cap is enforced on the gateway key, so model traffic that goes through `$EVOLVE_GATEWAY_BASE_URL` is metered and capped. What confines traffic to that route is the **task's network policy**, not the harness: under `no-network` — the default — the box can reach the gateway and nothing else, and the cap is a hard guarantee. On a task declaring `allowlist` or `public`, a harness *can* reach a provider directly, and that traffic is neither metered nor capped. Registration refuses credential-shaped `env` keys, but that is a guardrail against the obvious mistake, not a boundary.

What you give up versus a built-in:

- **No live trace events.** There is no output parser for an unknown CLI, so `trial_trace()` stays empty for these trials. Everything else is identical: the patch is collected, the verifier scores it, and artifacts, timings, spend and status are recorded exactly as for a built-in harness.

---

## Statuses

**Job** — `QUEUED → RUNNING (→ CANCELLING)`, then terminal:

| Status | Meaning |
|--------|---------|
| `QUEUED` | accepted, waiting for dispatch |
| `RUNNING` | trials executing |
| `CANCELLING` | `cancel()` requested; in-flight trials winding down |
| `COMPLETED` | terminal — all trials settled |
| `CANCELLED` | terminal — cancelled before completion |
| `FAILED` | terminal — the job itself failed (see `error`) |

**Trial** — a valid reward (including 0) is `SCORED`; a verifier crash or out-of-domain reward is `SCORING_ERROR`, never a fabricated zero:

| Status | Meaning |
|--------|---------|
| `QUEUED` | waiting for a sandbox slot |
| `RUNNING` | agent phase in progress |
| `SCORING` | agent finished; verifier running |
| `SCORED` | valid reward recorded (`reward` set; 0 counts) |
| `SCORING_ERROR` | verifier crashed or returned an out-of-domain reward |
| `INFRASTRUCTURE_ERROR` | sandbox failed before a result was recorded (see `failure_phase`) |
| `INDETERMINATE` | the outcome could not be determined |
| `CANCELLED` | cancelled before settling |

**Benchmark version** — `DRAFT → IMPORTING → BUILDING → VALIDATING → READY`, with `FAILED` and `ARCHIVED` as off-ramps: a failed parse or environment build lands `FAILED` before `VALIDATING` is ever reached, and `ARCHIVED` shelves a version that has been moved past. An import lands a version at `VALIDATING`; the activation gate (gold + no-op, above) then promotes it. Only `READY` versions accept jobs. (The import job's own statuses are `IMPORTING → IMPORTED | FAILED`.)

---

## Types

```python
@dataclass
class JobAgent:
    harness: str                          # a built-in ('claude' | 'codex' | 'gemini' | 'qwen' |
                                          # 'kimi' | 'opencode' | 'droid') or a registered custom harness
    model: str                            # from that harness's family — see Getting Started
    harness_version: str | None = None    # pin a harness version; None = resolve latest. Must be
                                          # EXACT (else invalid_input); unpublished ->
                                          # harness_version_not_found; a pin on a custom
                                          # harness -> invalid_input (content-versioned)

@dataclass
class Job:
    id: str
    status: str                           # job status above
    benchmark: str                        # 'name@version'
    runs_per_task: int
    concurrency: int
    max_trial_spend_usd: float            # the per-trial cap that applied: yours, or the default
    worst_case_spend_usd: float           # trials x the cap — the most this job can cost
    sandbox_provider: str                 # 'e2b' | 'daytona' | 'modal'
    spent_usd: float                      # what the trials have spent so far
    counts: JobCounts                     # agents, tasks, trials
    created_at: str
    trial_counts: dict | None             # histogram by trial status (get/list)
    mean_reward: float | None             # mean over SCORED trials; None when none (get/list)
    agents: list[JobAgent] | None         # get() only
    error: str | None                     # get() only
    updated_at: str | None                # get() only
    source_job_id: str | None             # set on rerun_failed() jobs
    idempotent_replay: bool               # True when an Idempotency-Key replayed

@dataclass
class JobEvent:                           # watch() / watch_iter()
    seq: int                              # monotonic; the watch resume position
    type: str                             # 'trial.settled', 'job.completed', ...
    data: dict

@dataclass
class Trial:
    id: str
    task_key: str
    agent: JobAgent
    run_number: int                       # 1-based
    status: str                           # trial status above
    reward: float | None                  # None until scored; 0 is a reward
    metrics: dict[str, float] | None      # named sub-scores
    failure_phase: str | None
    failure_detail: str | None            # truncated in list rows; full via trial()
    phase_timings_ms: dict | None         # {'agent_ms': ..., 'verify_ms': ...}
    model_usage: ModelUsage | None
    sandbox_provider: str | None          # where the trial executed; None until it has
    verifier_mode: str | None             # 'separate' | 'shared'
    resolved_harness_version: str | None  # harness version actually used
    session_ref: str | None               # agent session/trace reference
    created_at: str
    updated_at: str

@dataclass
class TrialDetail(Trial):                 # trial(id, trial_id)
    job_id: str                           # failure_detail is untruncated here

@dataclass
class ModelUsage:                         # one money vocabulary: the cap is
    spent_usd: float | None               # max_trial_spend_usd, actuals are spent_usd
    spend_source: str | None              # 'measured' | 'assumed_cap'
    max_trial_spend_usd: float | None     # the per-trial cap that applied to this trial
    extra: dict                           # harness-specific keys, snake_case

@dataclass
class TrialTraceEvent:
    seq: int                              # resume position for after=
    type: str
    data: dict

@dataclass
class RegradeResult:
    id: str
    source_trial_id: str                  # the source trial this regrade re-scored
    task_key: str
    status: str                           # 'QUEUED' | 'RUNNING' | 'SCORED' | 'SCORING_ERROR'
                                          # | 'INFRASTRUCTURE_ERROR' | 'INDETERMINATE'
    reward: float | None                  # the regrade's reward; None until scored
    metrics: dict[str, float] | None
    source_reward: float | None           # source-trial reward at regrade time (immutable snapshot)
    source_status: str                    # source-trial status at regrade time (immutable snapshot)
    reward_delta: float | None            # reward − source_reward when both are numbers, else None
    verifier_mode: str                    # always 'separate' — regrade only re-runs separate verifiers
    verifier_digest: str | None           # the verifier version that ran; None until it runs
    verifier_sandbox_id: str | None       # provider box id of the verifier sandbox (provenance)
    failure_phase: str | None
    failure_detail: str | None
    phase_timings_ms: dict | None
    created_at: str
    settled_at: str | None                # None while QUEUED/RUNNING

@dataclass
class RegradeFilter:                      # per-job selection, echoed back
    status: list[str] | None
    task_key: str | None

@dataclass
class RegradeJobCounts:
    results: int
    by_status: dict[str, int]             # histogram by regrade status

@dataclass
class RegradeJob:                         # regrade() / regrade_trial() / regrade_job()
    id: str
    source_job_id: str                    # the job the source trials belong to
    status: str                           # 'QUEUED' | 'RUNNING' | 'COMPLETED' — derived from results
    sandbox_provider: str                 # where the verifier boxes run
    counts: RegradeJobCounts
    created_at: str
    updated_at: str
    filter: RegradeFilter | None = None
    results: list[RegradeResult] | None = None  # present on create and regrade_job() reads

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

@dataclass
class CustomHarness:                      # harnesses.list() / get() / create()
    name: str                             # the value you pass as agents[].harness
    source: str                           # 'install_script' | 'tarball'
    run_command: str                      # run headless with `sh -c` at the task directory
    env: dict[str, str]                   # injected at RUN time; cannot override contract keys
    created_at: str
    updated_at: str
```

`custom_harnesses().create()` keyword arguments: `name` and `run_command` are required, plus EITHER `install_script` (the script itself) OR `directory` (a local directory, tarred and uploaded); `env` is optional.

### Errors

Every API failure raises `EvolveAPIError` — the server's own sentence as the message, plus a stable machine-readable code to branch on:

```python
from evolve import EvolveAPIError

try:
    await evals.run(benchmark='deep-swe', agents=[...], max_trial_spend_usd=25)
except EvolveAPIError as error:
    print(error.status)   # e.g. 409
    print(error.code)     # e.g. 'version_not_ready', 'provider_unsupported', 'rate_limited'
    print(error)          # 'Benchmark version deep-swe@1.2 is in state VALIDATING; ...'
```

Codes you will actually branch on: `benchmark_not_found` (also what another account's private benchmark reads as), `benchmark_version_not_found`, `benchmark_name_taken` (409 — the import name belongs to someone else), `import_too_large` (413), `no_active_version`, `version_not_ready`, `unknown_task_keys`, `provider_unsupported`, `job_not_found`, `job_not_terminal`, `no_failed_runs`, `trial_not_found`, `harness_version_not_found`, `insufficient_credits` (402 — the account is out of credits; add some and retry), `rate_limited` (retry after the `Retry-After` header), `invalid_api_key`, and `invalid_input`.

[Regrades](#regrade) add three: `regrade_source_ineligible` (409 — the source trial recorded no verifier inputs; the message names why), `no_regradable_runs` (409 — a whole-job regrade found nothing eligible), and `regrade_not_found`.

[Custom harnesses](#bring-your-own-harness) add their own: `custom_harness_not_found` (also what another owner's name reads as), `custom_harness_name_taken`, `custom_harness_name_reserved` (the name collides with a built-in harness), `custom_harness_source_required` (neither an install script nor a tarball), `custom_harness_source_conflict` (both), `custom_harness_invalid_env` (declared env tries to override a run-contract key), `custom_harness_invalid_name`, `custom_harness_too_large`, and `custom_harness_limit_reached` (the per-account registration ceiling).
