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

If you would rather configure once, `hosted()` is the same three clients behind one door:

```python
from evolve import hosted

client = hosted()                       # or hosted(HostedClientConfig(api_key=...))
catalog = await client.benchmarks.list()
job = await client.jobs.run(...)
```

It is called `hosted()` rather than `evolve()` because `Evolve` is already the local-sandbox class in this package, and two names a shift key apart doing unrelated things is a trap worth avoiding. The three clients are built on first access, so `client.meta()` — the one call that needs no credentials — works before an API key is set.

---

## Run a job

Browse the catalog, then run. A bare benchmark name resolves server-side to the active `READY` version — the one benchmark-version state that accepts jobs (see [Statuses](#statuses)):

```python
from evolve import benchmarks, jobs, JobAgent

async with benchmarks() as catalog:
    page = await catalog.list()                     # one page of the catalog
    print([bench.name for bench in page.items])
    async for bench in catalog.list():              # or walk it all
        print(bench.name)

    active = await catalog.get_active('deep-swe')   # raises NoActiveVersionError when none
    print(active.version, [task.task_key for task in active.tasks.items])

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
    print(job.id, job.status)     # QUEUED
    print(job.benchmark)          # 'deep-swe@1.1' — the resolved version, echoed back
    print(job.counts)             # JobCounts(agents=2, tasks=2) — entity cardinality
    print(job.trials.total)       # 4
    print(job.trials.by_status)   # {'QUEUED': 4, 'RUNNING': 0, 'SCORED': 0, ...} — every status
```

Every collection on this surface is the same page: `items`, `next_cursor`, `has_more`, paged with `limit=`/`cursor=`. `next_cursor` means one thing everywhere — pass it back for the next page, and `None` means there is no next page. Every list call hands you a value you can either await for a single page or `async for` to walk every row, fetching pages as it goes.

Tasks expose public fields only — `task_key`, `agent_timeout_sec`, `verifier_timeout_sec`, and `providers`, the per-provider capability verdict ([Where it runs](#where-it-runs)). Instructions, environments, and tests never leave the server.

`run()` keyword arguments:

| Keyword | Default | What it does |
|---------|---------|--------------|
| `benchmark` | required | `'name'` (active `READY` version) or `'name@version'` |
| `agents` | required | list of `JobAgent(harness=..., model=..., harness_version=None, reasoning_effort=None)` |
| `tasks` | all tasks | task keys to run |
| `runs_per_task` | `1` | runs per task × agent |
| `concurrency` | `4` | parallel trials; ceiling 16 |
| `max_trial_spend_usd` | `200` | hard model-spend cap (USD) for EACH trial |
| `sandbox_provider` | `'e2b'` | see [Where it runs](#where-it-runs) |
| `idempotency_key` | none | safe-retry key (below) |

Every job response is the same shape, whatever produced it. `run()`, `get()`, `cancel()`, `rerun_failed()` and each row of `list()` carry the same fields, so a job card renders from any of them without your knowing which call it came from. `counts` is entity cardinality — the parts a job is made of — and `trials` is the one "how many" structure: a total plus a status histogram that names every status, zeros included, so a status bar never needs the enum hardcoded.

`max_trial_spend_usd` caps what a single trial may spend on model calls, and it is the only spend limit the platform enforces: every trial runs on its own freshly minted gateway key, and the cap is that key's budget. Leave it out and the platform applies $200 per trial. The response always reports the cap that actually applied — `job.max_trial_spend_usd` — so an omitted one is never a mystery.

There is no job-wide budget, which means a job's real ceiling is simply its trial count times that cap. The response states it for you as `job.worst_case_spend_usd`, so you can see what a large matrix commits you to before it starts running. Your account credit balance is the hard backstop underneath all of it: when the balance runs out, spending stops mid-job whatever the caps say, and creating a job while the balance is already at zero is refused up front with a `402 insufficient_credits`. A trial that exhausts its own cap is not a failure — the harness just runs out of budget, and the trial is still scored on whatever it produced.

Runs on your own provider key are the one exception to the credit ledger. When a [managed BYO provider key](./01-getting-started.md#managed-byo-provider-keys) is enabled for the model's provider (Anthropic and OpenAI today), the trial's model calls bill your provider account directly and draw no Evolve credits — the per-trial cap still meters and bounds the trial exactly as before.

The exception is about who pays for model calls, not about the gate at the door. The zero-balance check runs on every job create and every `rerun_failed()`, BYOK included, so an account sitting at zero is refused with `402 insufficient_credits` even when the run would have drawn nothing. Keep a non-zero balance if you run BYOK-only.

A job expands to `tasks × agents × runs_per_task` trials, each in its own sandbox. `concurrency` is how many of them run at once: four by default, sixteen at the ceiling, and every one of those numbers is published under `limits['job']['concurrency']` in the [capability document](#what-the-platform-supports) rather than only here.

Three ceilings bound that expansion, and all three refuse at create rather than partway through: at most **8 distinct agents** after de-duplication and at most **100 `runs_per_task`**, each a `400 invalid_input`, and a total matrix of at most **10,000 trials**, which is `400 job_too_large`. They are published as `limits['job']['maxAgents']`, `['maxRunsPerTask']` and `['maxTrials']`, so a form can check a sweep before it POSTs. `sandbox_provider` (optional, default `'e2b'`) picks where those sandboxes run — see [Where it runs](#where-it-runs). Valid harness + model pairs are listed once in [Getting Started → Harness and Model Pairing](./01-getting-started.md#harness-and-model-pairing). `harness` also accepts a harness you registered yourself — see [Bring your own harness](#bring-your-own-harness).

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

`reasoning_effort` is the other per-agent knob, and it belongs to the comparison rather than to the run:

```python
agents=[
    JobAgent(
        harness='codex',
        model='gpt-5.5',
        reasoning_effort='high',    # (optional) omit to take the platform default, 'medium'
    ),
],
```

The accepted values are `'off'`, `'minimal'`, `'low'`, `'medium'`, `'high'`, `'xhigh'`, `'max'` and `'thinking'`, published as `limits['job']['reasoningEfforts']` with the omitted-value default as `limits['job']['defaultReasoningEffort']`. Read both from the [capability document](#what-the-platform-supports) rather than from this sentence: effort changes the score, so a client comparing two jobs has to know what an omitted value meant in each of them.

Effort is part of an agent system's identity, alongside the harness, the model and the version pin. The same harness and model at `'low'` and at `'high'` are two distinct systems — they de-duplicate separately, they each consume one of the eight agent slots, and every trial echoes the effort back on `trial.agent`. A `None` there means the agent declared none and took the platform default, not that it ran at no effort at all.

Not every harness can honor one, and a request naming an effort a harness cannot apply is refused at creation with a `400 invalid_input` rather than accepted and quietly dropped. Recording `'high'` against a CLI that never received the flag would put a claim in the benchmark record that did not happen:

- `claude`, `codex`, `droid` and `opencode` take a level, and the value reaches the CLI as one.
- `kimi` can express only thinking on or off, so it accepts `'off'`, `'minimal'`, `'medium'` and `'thinking'`, and refuses every other level.
- `gemini` and `qwen` take no effort input at all, so naming any effort for them is refused.

Each harness publishes which of the three it is as `effort_support`, so a picker greys the control out instead of discovering the refusal after a POST. Omitting the field is always accepted, `gemini` and `qwen` included — the refusal is about a value that could not be applied, never about the field existing.

A harness you registered yourself is never refused, because the platform makes no claim about what someone else's CLI accepts. It is also never handed the value: the [run contract](#the-run-contract) gives your command six environment keys and effort is not among them, so an effort set here is recorded on the agent system and reaches nothing. Put the flag in your own `run_command`.

Retrying with the same `idempotency_key` returns the original job instead of creating a duplicate:

```python
job = await evals.run(
    ...,
    idempotency_key='nightly-2026-07-23',
)
print(job.idempotent_replay)   # True on a replay
```

A key on its own is not enough to make a request idempotent, so the server also fingerprints the request behind it. Repeat the same request with the same key and you get the original job back; send a *different* request under a key you have already used and it is refused with a `409 idempotency_key_reused` rather than handed yesterday's job while you believe a new run started. Use a fresh key for a genuinely new run.

---

## Watch it live

`watch()` consumes the job's server-sent event stream — replayed from the beginning, resumed with `Last-Event-ID` on reconnect (exponential backoff), completing on the terminal event. It hands back a handle you can use either way: `await` it for the final job, or `async for` it for each event.

```python
async for event in evals.watch(job.id):
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

Pick one form per handle — both drive the same stream. Attaching late loses nothing (the stream replays), and a disconnect resumes from the last seen sequence number: no gaps, no duplicates.

This is the same shape `list()` has always had here, and the same shape the TypeScript SDK's `jobs().watch()` returns. It used to be two methods (`watch()` and `watch_iter()`), which made this SDK disagree with TypeScript and with its own pagination idiom at once. `watch_iter()` still works and is a thin alias; prefer `async for … in watch(...)`.

---

## Read the results

```python
# One job: size, status histogram, mean reward, spend
detail = await evals.get(job.id)
print(detail.counts)                      # JobCounts(agents=2, tasks=2) — entity cardinality
print(detail.trials.total, detail.trials.by_status)   # 20, {'SCORED': 12, 'RUNNING': 3, ...}
print(detail.mean_reward)                 # mean over SCORED trials; None until something scores
print(detail.spent_usd, '/', detail.worst_case_spend_usd)
print(detail.failure)                     # why it FAILED — None on every job today

# Your jobs, newest first — await one page, or iterate them all
page = await evals.list(limit=50)         # page.next_cursor continues
async for item in evals.list():
    print(item.id, item.benchmark, item.status, item.mean_reward, item.spent_usd)
```

A failed job says why on `failure`, as `code` + `message` — the same grammar an API error uses, under a different key so that a client checking for `error` stays correct on a healthy read. It rides on list rows too, so a dashboard shows the reason without a detail call per row. In practice you will not see it fire: `FAILED` is a [reserved job status](#statuses) that nothing sets today, so `failure` is `None` on every job. Read `trials.by_status` for where a job actually went wrong.

Iterate trials (pages fetched for you), or `await` one page. `status` filters, e.g. to the failures behind a rerun decision:

```python
async for trial in evals.trials(job.id):
    print(trial.task_key, trial.agent.model, trial.run_number, trial.status, trial.reward)

page = await evals.trials(
    job.id,
    limit=100,
) # .items, .next_cursor, .has_more

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

Read per-trial spend from the trial itself. `spend_source='measured'` is the platform's settled figure and the only final one. `'measured_provisional'` is a real reading taken before the gateway finished writing this trial's spend — a lower bound that can only move UP, finalized within about half an hour of the trial settling. `'assumed_cap'` means spend could not be measured at all, so the per-trial cap is reported conservatively. Fresh trials commonly show one of the latter two for a few minutes; wait for `'measured'` before treating a number as final. `spent_usd=None` means the trial never ran — a queued or cancelled trial — and is not the same as `0`, which is a real measurement and appears when no gateway key was ever minted:

```python
print(detail.spent_usd, detail.spend_source)
```

Read spend from `spent_usd`, never from `model_usage`. `model_usage` is the open-ended per-harness blob: `max_trial_spend_usd` is the cap *that* trial's key carried (which can differ from the job's cap today), and everything else — bundle identity, token counts, and on trials settled by an earlier executor a historical `cost_usd` — lands in `model_usage.extra` under snake_cased keys. That leftover cost is a usage fact the harness reported, not the platform's spend answer, and only `spent_usd` carries `spend_source` to tell you how it was arrived at.

```python
if detail.model_usage:
    print(detail.model_usage.max_trial_spend_usd)   # history, not this job's cap
    extra = detail.model_usage.extra
    print(extra.get('network_mode'),                # 'no-network' | 'allowlist' | 'public'
          extra.get('network_policy_source'))       # 'explicit' | 'legacy_allow_internet' | 'upstream_default'
```

`network_mode` is what the agent could reach, and `network_policy_source` is where that came
from — `'upstream_default'` means the task declared nothing and the omitted-means-public rule
applied. Compare rewards only across trials that agree on both: an agent with internet access ran
a different experiment from a sealed one.

While a trial is still in flight there is a mid-run reading as well, on two fields of its own:

```python
print(detail.live_spent_usd, detail.live_spend_at)   # 3.41  '2026-07-24T18:22:05.113Z'
```

Read them together or not at all. `live_spent_usd` is a **lagging lower bound**, never the trial's cost: the gateway settles spend 40–70 seconds behind the calls that incurred it, and the platform samples the trial's key roughly every two minutes, so the number is always behind and `live_spend_at` is how far behind. Render it as "at least $3.41, as of 90s ago" — never as "current cost".

The rest of its behavior follows from that:

- **`None` is "no reading yet", never `$0`.** A zero from the gateway means nothing has settled, not that the trial was free, so a zero is skipped rather than written.
- **It is never part of a total.** `job.spent_usd` sums settled trials only, and folding a live reading into it would double-count the moment that trial settles.
- **It stops moving when the trial does.** Nothing writes it once the row is terminal, so what remains is the last mid-run sample — stale by construction. On a terminal trial read `spent_usd` and `spend_source`; that is the settled truth, and it is the only one.
- **Built-in harnesses only.** A custom harness runs your own command with no live poll around it, so its trials go from `None` straight to a settled `spent_usd`.

The same reading reaches a watcher as a `trial.spend` event carrying `trialId`, `taskKey` and `liveSpentUsd`. It is emitted only when a sample actually landed on a live trial, so a poll that raced the settle never fires one.

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
    cursor=str(last_seq),
    limit=500,
)
print(page.items, page.next_cursor, page.has_more)
```

`trial_trace_events()` drains the currently available trace, then stops — `next_cursor` is `None` once you are caught up, which is how the drain knows. A trace cursor is a position in the seq timeline, so to follow an in-flight trial later, keep the last event's `seq` and resume with `cursor=str(last_seen_seq)`.

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

# Read it back by the REGRADE's id: QUEUED → RUNNING → COMPLETED
done = await evals.get_regrade(bulk.id, limit=100)
for result in done.results.items:
    print(result.task_key, result.source_reward, '→', result.reward,
          result.reward_delta)   # reward − source_reward, the per-trial delta
```

All three return a `RegradeJob`. A per-trial regrade holds one result; a per-job regrade holds one per selected source trial. `results` is one object named for the collection: `total` and `by_status` cover the whole job, `items`/`next_cursor`/`has_more` are the page you asked for — a regrade of a 10,000-trial job is not one response. Poll `get_regrade()` until `status` is `'COMPLETED'`; `results.by_status` is the running histogram, derived from the whole result set rather than the page in hand.

`get_regrade()` takes the **regrade's** id — the one `regrade()` and `regrade_trial()` return, and the one their `Location` header names. To find a regrade you no longer hold the id for, or to see every regrade of a job, list them:

```python
# Every regrade of one job, newest first
async for regrade in evals.list_regrades(job_id=job.id):
    print(regrade.id, regrade.status, regrade.results.total)

# Or one page at a time
page = await evals.list_regrades(limit=20)
```

Naming a job you do not own returns an empty page rather than a 404 — a list never reveals whether someone else's id exists.

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
    print(aggregate.benchmark, aggregate.mean_reward,
          f'{aggregate.coverage.scored}/{aggregate.coverage.total} scored',
          aggregate.spent_usd)

for row in comparison.task_matrix:
    if not row.disagreement:
        continue
    for cell in row.cells:
        print(row.task_key, cell.status, cell.mean_reward)
        # cell.status: a trial status, 'MIXED' (trials disagree), or 'MISSING' (no trials)
```

Mean rewards cover `SCORED` trials only; `coverage` is always reported so a high mean over few scored trials stays visible. Zero is a reward, never a gap.

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

Two delivery shapes, not three: `to=` streams straight to disk and returns the saved path, and omitting it returns the bytes. The TypeScript SDK also offers `stream: true` for a raw response stream; Python has no equivalent, so pass `to=` for anything large enough that you would not want it in memory. `format='harbor'` composes with either shape.

---

## CLI

Python ships no separate CLI. The TypeScript package's `evolve-evals` binary (`npx evolve-evals ...`) covers the full surface from any shell — see [TypeScript → Hosted Evals → CLI](../typescript/06-hosted-evals.md#cli).

---

## What the platform supports

Everything a client would otherwise hardcode — the legal harness names, the status enums, the limits, the error codes — is one public, cacheable document. It needs no API key.

```python
from evolve import meta

doc = await meta()

# A model picker, without a hardcoded table
for harness in doc.harnesses:
    print(harness.name, harness.default_model, len(harness.models))
```

`GET /api/meta` is the wire form. Every field is derived from the module that enforces it, so a published limit and an enforced limit cannot drift apart, and a new harness appears here the moment the platform can run it.

What is in it:

**`harnesses`** — every built-in, with `default_model` and the full `models` list for a picker, `runnable` (and `reason` when it is not), `version_pinnable`, and `latest_version` for a "your pin is out of date" badge. `default_model` is a suggestion, not a server-side default: `doc.limits['job']['modelRequired']` is `True`, and a job that omits `model` is refused. `effort_support` is the same idea for the effort control — `'level'`, `'binary'` or `'none'`, exactly as [Run a job](#run-a-job) describes them — so a form can offer the right control, or none, instead of learning the harness's limits from a refusal. For a `'binary'` harness the acceptable spellings are published as `limits['job']['binaryEffortValues']`, so a picker can narrow its options instead of offering eight values the server will refuse six of.

**`sandbox_providers`** — each provider's real resource ceilings and, in `refuses`, the capabilities it will not run with the reason the runner itself would give.

**`platform_constraints`** — a top-level list of its own, holding the refusals that apply on *every* provider, so "runs nowhere" is distinguishable from "runs somewhere else".

**`network_modes`** — the three modes a task may declare, which is exactly the list a "Network modes" filter needs. They are explained in [What runs](#network-modes).

**`statuses`** — the job, trial, import, regrade-job, regrade-result, and benchmark-version vocabularies, each with its `terminal` members marked. A watcher stops on `terminal`; a status bar renders `values` without hardcoding the enum.

**`limits`** — five keys. `'job'` carries every create-time bound: `maxAgents`, `maxRunsPerTask`, `maxTrials`, `concurrency` (default and ceiling), `defaultMaxTrialSpendUsd`, `defaultSandboxProvider`, `modelRequired`, and `defaultSizing`. Four more are the values a run inherits when nothing declares one: `reasoningEfforts` and `defaultReasoningEffort` are the effort vocabulary and the omitted-value default from [Run a job](#run-a-job), and `defaultAgentTimeoutSec` (3600) and `defaultVerifierTimeoutSec` (600) are the phase wall-clocks a task falls back to when its own `task.toml` declares none — a task that declares `agent.timeout_sec` or `verifier.timeout_sec` always wins, so these fill in rather than cap. They are published because nothing else on the document says how long a trial may run. `'pagination'` is three separate scopes with three different pairs — `collections`, `benchmarkTasks`, and `regradeResults` each publish their own `default` and `max`, so read the one for the collection you are paging rather than applying a single pair everywhere. `'uploads'` holds the two archive size caps, `'benchmarkNames'` the name pattern and length bounds, and `'maxItemsNamedInErrorMessage'` sits at the top level: it is how many offending items a refusal names in its English sentence before "and N more", which is why `err.details` exists.

**`error_codes`** — the whole vocabulary below, in one list.

**`custom_harnesses`** — the registration rules, so a form can validate before it POSTs: the name pattern, the size caps, the reserved names and reserved env keys, and `maxPerUser`, the per-account registration ceiling. That ceiling lives here rather than under `limits` because it belongs to the same rules a registration form already reads.

`limits` and `custom_harnesses` are plain dicts with the wire's own camelCase keys — `doc.limits['job']['concurrency']['max']`, `doc.custom_harnesses['maxPerUser']`. They are nested configuration you read by key, not objects you construct, and a dataclass per level would be five classes to edit every time the server adds a field — the exact coupling this document exists to remove.

`statuses` is the exception, and the one place to read carefully: it is a dict *of dataclasses*. The outer keys are the wire's own (`'job'`, `'trial'`, `'import'`, `'regradeJob'`, `'regradeResult'`, `'benchmarkVersion'`), but each value is a `StatusVocabulary` you reach by attribute — `doc.statuses['job'].values`, `.terminal`, `.description`. Subscripting it like a dict raises `TypeError`.

`schema_version` moves when a field is added, removed, or changes meaning — never when a value changes. Pin behavior to it, not to a deploy date. Responses carry an `ETag` and `Cache-Control: public, max-age=300, stale-while-revalidate=300`; send the ETag back as `If-None-Match` and a matching document answers `304` with no body.

---

## Errors

Every failure is one shape:

```python
from evolve import EvolveAPIError

try:
    await evals.run(benchmark='deep-swe', agents=agents, sandbox_provider='modal')
except EvolveAPIError as err:
    if err.code == 'provider_unsupported':
        # Every refused task, with its reason. Not a sentence to regex.
        refused = err.details['refusedTasks']
        print(f"{len(refused)} tasks cannot run on {err.details['provider']}")
```

- **`code`** is the stable identifier. `HOSTED_ERROR_CODES` and `is_hosted_error_code()` are exported, and `HostedErrorCode` is a `Literal` you can annotate with so a type checker catches `'insufficient_creidts'`. A server newer than your SDK may send a code the list does not have, which is why `code` stays a plain `str`.
- **`str(err)`** is the human sentence, and it may be shortened. **`err.details`** never is. When a refusal says "and 8 more", all of them are in `details` — that is the rule, and it is why `details` exists.
- **`err.param`** names the input that was wrong — a body path (`agents[0].harness`), a query parameter (`limit`), or a multipart part (`runCommand`) — so a form can highlight one field instead of showing a banner. It is a wire name handed through unconverted, so it stays camelCase even though the keyword you passed was `run_command`.
- **`err.retry_after_sec`** is set on `429` and `503`, read from the body first and the `Retry-After` header second.
- **`err.request_id`** identifies the failure server-side. Quote it in a support thread.

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
- `public` — open internet.

**A task that declares no mode gets `public`**, which is Harbor's own default and therefore ours. That is worth knowing before you assume a sealed box: only `no-network` makes the per-trial spend cap a hard boundary, because only then is the gateway the sole route out. See [What keeps a trial inside its budget](#the-run-contract).

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
for task in bench.tasks.items:
    verdict = task.providers['modal']   # TaskProviderVerdict(ok=..., reason=...)
    if not verdict.ok:
        print(task.task_key, 'cannot run on modal:', verdict.reason)
```

Creating a job whose selected tasks include one refused on the chosen provider is rejected with a `400 provider_unsupported` naming the tasks and each task's reason, rather than accepted and billed until it fails.

The verdict is narrower than the full set of things a provider can decline, and knowing where the line falls saves you a confusing trial. Three refusals are decided from the task's stored spec, so they are in `providers` and they are what a job creation checks against:

- **Multi-container tasks run on `e2b` and `daytona`.** Modal cannot run them today — the task's `providers['modal']` verdict names the reason, and the task stays runnable on the other two providers.
- **Multi-container + `no-network` is declined on every provider** for now. Run those tasks with an `allowlist` or `public` network policy.
- **Sizing above a provider's ceiling** refuses on that provider only — see [Compute sizing](#compute-sizing).

The rest are decided when the sandbox is actually created, so they surface as a trial that ends `INFRASTRUCTURE_ERROR` with the reason in its `failure_detail` rather than as a `400` at creation. There are two, and both are Daytona-and-Modal specifics you can check yourself before choosing a provider:

- **Daytona serves IP-based allowlists only.** Its network filter takes IPv4 addresses and CIDRs, capped at 10 entries — a cap that also has to fit the address the agent uses to reach its model, so a task's own list gets slightly fewer. A task whose `allowlist` names a hostname, or needs more than the cap, fails on Daytona when its sandbox is created. Run it on e2b or Modal, which serve hostname allowlists. Daytona serves `no-network` and `public` normally.
- **Modal caps every sandbox at 24 hours.** A task whose timeout exceeds the cap fails fast when its sandbox is created — never truncated mid-run.

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
        # `failure`, not `error` — `error` is the key the FAILURE ENVELOPE uses,
        # so a client checking for it stays correct on a healthy read of a
        # failed import. Same grammar as a job's `failure`.
        print(done.failure.code, done.failure.message)   # "2/113 task(s) failed to parse"
        for failed in done.failure.failures:
            print(failed.task_key, failed.error)
```

```python
# Lost the id? List your imports — await one page, or walk them all.
async for job in catalog.list_imports(status='FAILED'):
    print(job.id, job.benchmark_name, job.version, job.failure.message if job.failure else None)

# Narrow to one benchmark's import history, newest first
history = await catalog.list_imports(benchmark='my-bench', limit=20)
```

`list_imports()` takes `status=` and `benchmark=` as filters and `limit=`/`cursor=` for paging, and returns the same `BenchmarkImport` shape the `202` did — so a row renders without a follow-up read.

`get_import(id)` is the single read behind all of this, and it is what you want when you are not blocking: it returns one `BenchmarkImport` — status, `task_count`, and `failure` once there is one. `watch_import()` is a poll loop over it, so reach for `get_import()` when you are driving your own scheduler or rendering a status chip on request rather than holding a coroutine open. A terminal import stays readable indefinitely, id included.

Every lane resolves to the same thing — a Harbor-layout directory — and is held to the same rules. The corpus root is a directory whose `tasks/` subdirectory holds one directory per task, or the tasks directory itself. Provenance is recorded per lane: the resolved commit for a git import, the sha256 of the exact uploaded bytes for a directory. On the wire an import is `multipart/form-data`: `benchmarkName` and `version` as named parts, and either `gitUrl` + `ref` or the gzipped corpus as a `file` part — the SDK produces it for you — and uploads past the compressed-size cap (512 MB by default) are refused with a `413 import_too_large`. The metadata parts come first, so a name owned by someone else is refused with a `409 benchmark_name_taken` before the upload is received rather than after.

### Deleting one

A benchmark name is a global resource, and a typo used to squat one permanently. `delete()` takes it back:

```python
await catalog.delete('my-bnech')   # 204, and the archived solutions go with it
```

The rules are worth knowing before you reach for it:

- **You must own it.** A platform-curated benchmark is refused with `benchmark_not_owned`; a name you cannot see reads as a plain not-found, exactly like a name that does not exist, so the route cannot be used to discover what other accounts have.
- **A referenced benchmark is never deleted.** If any job ran against it, you get `409 benchmark_in_use`, and `err.details['sampleJobIds']` names some of the jobs blocking it (with `err.details['jobCount']` for how many there are). There is no cascade and no force: a job's meaning is "this agent scored 0.42 on *these* tasks", and deleting the tasks would leave a number that refers to nothing. Delete the jobs first if you mean it.
- **Versions, tasks, and the private solutions archive go with it.** Mirrored task images do not — they are content-addressed and shared with any other benchmark pinning the same image.

### When upstream moves

A benchmark imported from git records what it was built from, and the platform periodically re-resolves where that ref points now. The answer rides on the benchmark:

```python
bench = await catalog.get('my-bench')

if bench.upstream and bench.upstream.moved:
    print(f'{bench.upstream.ref} has moved past {bench.upstream.current_commit}')
    # → import a NEW version when you want it; nothing happens automatically
```

```python
UpstreamStatus(
    ref='main',                     # what the active version was imported from
    current_commit='a1b2c3…',       # what it was built from
    latest_commit='d4e5f6…',        # where the ref points now (None if the check failed)
    moved=True,                     # branch on this
    behind_by=None,                 # see below
    checked_at='2026-07-24T…',      # None before the first check
    error=None,                     # why the last check failed
)
```

Four things this deliberately does **not** do:

- **It never imports.** A new version is always an immutable row you create, with `catalog.import_benchmark()`. Watching produces a fact, never an action.
- **It never modifies an existing version.** A version is what it was built from, permanently.
- **`upstream` is `None`, not "up to date", when there is nothing to watch** — an uploaded corpus, a seeded one, one imported before provenance was recorded, or one imported at an exact commit sha. That last case is the one that surprises people: a commit pin is the *most* reproducible way to import, and a pinned commit cannot move, so there is no question to ask the remote and no badge to show. Import from a branch or tag if you want the watch. `None` always means nobody checked.
- **`behind_by` is always `None` today.** Counting commits between two SHAs needs the commit graph, i.e. a real fetch from the remote per benchmark per check. The check is a single reference advertisement (`git ls-remote`) precisely so it can be cheap, and `moved` is what a badge actually needs. The field stays in the shape so a host comparison API could fill it later without a wire change.

A failed check keeps the last known `latest_commit` and sets `error`: a network blip should not quietly erase an update that is genuinely available. Show "could not check", never "up to date".

The same idea covers harnesses from the other direction: a job records the `harness_version` it pinned, and `meta().harnesses[].latest_version` is the newest published one. Compare the two for a "your pin is out of date" badge — one cached lookup for every job, rather than a registry round trip per job read.

The `evolve-evals` CLI prints one quiet line under `benchmarks` and `benchmarks get` for each benchmark whose ref has moved — naming the benchmark, its active version, and the ref — and nothing at all when nothing moved. It never offers to import for you, because importing builds an immutable version and that is a decision. When you want the new version, it is the ordinary import command with a new version label:

```bash
npx evolve-evals import --git https://github.com/acme/my-bench.git --ref main \
    --name my-bench --version 1.1 --watch
```

The notice never appears in `--json` output; the same fact is on the `upstream` field there.

What happens next:

- **All-or-nothing parse.** Every task is parsed before anything lands; one bad task fails the whole import, with each failure named in `failure.failures`. No partial corpus ever exists.
- **Strict by design.** Every `task.toml` field is either honored or the import is refused with the field and reason named — a task never silently runs on weaker semantics than it declares. Notably not yet supported: multi-step tasks (`[[steps]]`) and GPU tasks.
- **Environments are prepared at import.** Dockerfile-defined environments are built once; multi-container service images are resolved and pinned so runs are reproducible.
- **The activation gate certifies every task** before the version can activate:
  - **gold** — the task's reference solution (`solution/`) is pushed through the real agent-side + verifier path and must score exactly `1.0`. Proof the task is solvable as written.
  - **no-op** — an empty submission goes straight to the verifier and must *not* score `1.0`. A task a do-nothing agent passes measures nothing.

`COMPLETED` is the import job's terminal success: the corpus landed as a benchmark version, visible in the catalog (`catalog.get('my-bench@1.0')`) in state `VALIDATING`. Activation is a separate, operator-run step — importing never triggers it. The version stays `VALIDATING` until the gate passes in full and promotes it to `READY`, the one state that accepts jobs; watch the state through `catalog.get()`. `run()` against any other state raises a `409 version_not_ready` naming it.

Be clear-eyed about what that means for you today: there is no SDK method, CLI verb or dashboard button that requests activation. A version you import sits at `VALIDATING` until Evolve runs the gate for it, so ask us to activate it — quote the benchmark name and version — rather than polling and waiting for a state change that nothing on your side can cause. Self-serve activation is coming; until it lands this is the one step in the chapter that is not in your hands. Once `READY`:

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
- Timeouts are optional: agent defaults to 3600 s, verifier to 600 s, both published as `limits['job']['defaultAgentTimeoutSec']` and `limits['job']['defaultVerifierTimeoutSec']`. A declared `timeout_sec` always wins — the corpus is the authority on how long its own task needs, and the fallback never shortens one.
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

"Never both" is checked before anything leaves your process: `create()` and `upsert()` raise `ValueError` when you pass both sources or neither. The TypeScript SDK expresses that same rule as a union type, so there it is a compile error instead — the promise is identical, only the moment it is kept differs.

`import_benchmark()` is looser, and worth knowing: it raises only when you name *no* usable source (neither `directory` nor a complete `git_url` + `ref`). Pass a `directory` and a git source together and it does not complain — the directory wins and the git source is ignored. The TypeScript SDK does reject that combination at compile time, so this is the one place the two SDKs genuinely differ. Pass exactly one.

Read and remove them the same way:

```python
registered = await harnesses.list()      # one page of your harnesses (async for walks them all)
one = await harnesses.get('acme-cli')    # name, source, run_command, env, timestamps
await harnesses.delete('acme-cli')       # past jobs keep the harness they recorded

# Change one WITHOUT a window where it stops existing:
await harnesses.upsert(
    'acme-cli',
    run_command='acme-cli --headless --v2',
    install_script='curl -fsSL https://acme.dev/install.sh | sh',
)
```

Both upload lanes — a harness and a benchmark corpus — send `multipart/form-data`: the metadata travels as named parts and the bytes as a `file` part. The SDK builds that for you, and it is why nothing sensitive rides a URL: a run command and a set of environment values in a query string end up in every access log and proxy buffer between you and the server.

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
- A custom harness is **versioned by its registered content** — the install source, the `run_command` and the declared `env`, together — so `harness_version` on an agent using it is rejected. Change any of the three and you get a new recorded version and a new bundle digest.
- **`upsert()` is how you change one.** `delete()` then `create()` leaves a window where the harness does not exist, and anything naming it in that window — a scripted job, a colleague's run — fails with "no such harness" for a change that was only ever meant to be an edit. `upsert()` is one call: the name holds the old registration or the new one, never nothing. It creates when the name is free (`201`, with `Location`) and replaces when it is not (`200`), and replacing consumes no new registration slot, so you can still fix a broken run command at the ceiling. It is a full REPLACEMENT, not a patch: every field comes from the call, so an omitted `env` becomes empty and the source switches wholesale.
- **You may register up to 25 harnesses.** Past that, registration is refused with `custom_harness_limit_reached`; delete one to make room. Each registration is a full CLI the platform builds and caches for you.

**What keeps a trial inside its budget — and when it does not.** The spend cap is enforced on the gateway key, so model traffic through `$EVOLVE_GATEWAY_BASE_URL` is metered and capped. What confines traffic to that route is the **task's network policy**, not the harness. Under `no-network` the box reaches the gateway and nothing else, and the cap is a hard guarantee. Under `allowlist` or `public` a harness *can* reach a provider directly with a key of its own, and that traffic is neither metered nor capped.

Read that second sentence with [Network modes](#network-modes) in hand, because `public` is what a task gets when it declares no policy at all. If you care about the cap being airtight, run against tasks that declare `network_mode = "no-network"` — do not assume it. Registration refuses credential-shaped `env` keys, but that is a guardrail against the obvious mistake, not a boundary.

What you give up versus a built-in:

- **No live trace events.** There is no output parser for an unknown CLI, so `trial_trace()` stays empty for these trials.
- **No live spend reading.** `live_spent_usd` stays `None` and no `trial.spend` event fires; the trial goes straight to a settled `spent_usd`.
- **No `reasoning_effort`.** An effort set on the agent is recorded but never reaches your command — the run contract's six keys are the whole environment. Put the flag in the `run_command`.

Everything else is identical: the patch is collected, the verifier scores it, and artifacts, timings, settled spend and status are recorded exactly as for a built-in harness.

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
| `FAILED` | terminal, and **reserved** — see below |

`FAILED` is in the vocabulary and declared terminal, but nothing on the server sets it and nothing emits a `job.failed` event. A job that goes wrong does so one trial at a time: the trials land in `INFRASTRUCTURE_ERROR` or `SCORING_ERROR` and the job still reaches `COMPLETED`. So `job.failure` is `None` on every job you will read today. Handle `FAILED` if you are switching exhaustively over the enum — the capability document lists it and it may become reachable — but do not build a failure banner and expect to see it fire; the histogram in `job.trials.by_status` is where a job's trouble actually shows.

**Trial** — a valid reward (including 0) is `SCORED`; a verifier crash or out-of-domain reward is `SCORING_ERROR`, never a fabricated zero:

| Status | Meaning |
|--------|---------|
| `QUEUED` | waiting for a sandbox slot |
| `RUNNING` | agent phase in progress |
| `SCORING` | agent finished; verifier running |
| `SCORED` | valid reward recorded (`reward` set; 0 counts) |
| `SCORING_ERROR` | verifier crashed or returned an out-of-domain reward — read `failure_phase`, then `failure_detail` |
| `INFRASTRUCTURE_ERROR` | trial lost before a result was recorded — read `failure_phase`, then `rerun_failed()` |
| `INDETERMINATE` | the outcome could not be determined |
| `CANCELLED` | cancelled before settling |

`SCORING_ERROR` is the one status a task author has to act on, so it says which of four things went wrong. `failure_phase` carries the machine-readable cause and `failure_detail` carries a sentence plus the last few kilobytes of the verifier's own stdout and stderr — the tail, because a grader prints its progress first and its traceback last. The box those bytes came from is destroyed seconds later, so this is the only record of them.

| `failure_phase` | What happened |
|--------|---------|
| `verifier_timeout` | the verifier command hit its wall-clock budget and was killed — raise `verifier_timeout_sec` on the task, or make the grader cheaper |
| `verifier_crash` | the verifier exited non-zero, or never reported an exit status at all; the excerpt usually names the missing module or failed assertion |
| `reward_out_of_range` | the verifier finished and wrote a number, but not one in `[0, 1]` — `-1` is the conventional crash sentinel, and a reward above 1 usually means a rubric was summed rather than normalized |
| `reward_unparseable` | the verifier claimed success and wrote something that is not a score: malformed JSON, no `reward` key, or an empty `reward.txt` |

The verifier's exit takes precedence over the reward's shape, because a killed grader leaves a truncated `reward.json` and reporting that as `reward_unparseable` would send you to debug your JSON instead of your timeout. Nothing is lost by the ordering — `failure_detail` always states both.

Regrade results use the same four values in the same field, and the `failure_detail` on a list row is truncated to 2000 characters; fetch the trial itself for the whole excerpt.

**Import** (`BenchmarkImport.status`) — the SAME four words a job uses, because an import is a job:

| Status | Meaning |
|--------|---------|
| `QUEUED` | accepted; the corpus row exists and nothing has started |
| `RUNNING` | cloning or extracting, then parsing and building the environment |
| `COMPLETED` | terminal — the corpus landed as a benchmark version |
| `FAILED` | terminal — read `failure` |

It used to spell these `IMPORTING → IMPORTED | FAILED`. Nothing published depended on that, and a third status vocabulary is exactly what forces a status chip to carry a translation table forever.

A terminal import stays readable. A successful import used to start answering `404` the moment its version was superseded, telling a watcher holding a week-old id that the import never happened — it `COMPLETED`, and the catalog moving on afterwards does not unmake that.

**Regrade job** (`RegradeJob.status`) — shorter than a job's, because a regrade cannot be cancelled:

| Status | Meaning |
|--------|---------|
| `QUEUED` | accepted; eligible source trials selected, nothing re-scored yet |
| `RUNNING` | verifiers re-running |
| `COMPLETED` | terminal — every selected trial has settled, whatever it settled as |

**Regrade result** (`RegradeResult.status`) — the SAME reward law as a trial, minus the states a regrade cannot reach (there is no agent phase, so no `SCORING`, and nothing to cancel):

| Status | Meaning |
|--------|---------|
| `QUEUED` | waiting for a verifier slot |
| `RUNNING` | verifier re-running against the source trial's recorded inputs |
| `SCORED` | valid reward recorded (`reward` set; 0 counts) |
| `SCORING_ERROR` | verifier crashed or returned an out-of-domain reward — read `failure_phase`, then `failure_detail` |
| `INFRASTRUCTURE_ERROR` | verifier box lost before a durable verdict |
| `INDETERMINATE` | the verifier wrote no reward file |

A `COMPLETED` regrade job is not a claim that every result `SCORED` — read `by_status` on `regrade.results` for that, exactly as with a job's trials.

**Benchmark version** (`BenchmarkVersion.state`) — the catalog's lifecycle, distinct from the import job's statuses above:

```
DRAFT → IMPORTING → BUILDING → VALIDATING → READY
```

with `FAILED` and `ARCHIVED` as off-ramps: a failed parse or environment build lands `FAILED` before `VALIDATING` is ever reached, and `ARCHIVED` shelves a version that has been moved past. An import lands a version at `VALIDATING`; the activation gate (gold + no-op, above) then promotes it — `READY` is the only state that accepts jobs.

---

## Types

These are the shapes the surface actually returns. Most of the names below are importable from `evolve` and can be annotated with — `Job`, `JobCounts`, `TrialTally`, `Trial`, `TrialDetail`, `JobEvent`, `Benchmark`, `Task`, `BenchmarkImport`, `ImportFailure`, `CustomHarness`, `RegradeJob`, `RegradeResult`, `UpstreamStatus`, `CapabilityDocument`, `StatusVocabulary`, and the concrete page classes `JobPage` / `TrialPage` / `TrialTracePage` / `BenchmarkImportPage`.

Two things below are written out for reading rather than importing. `Page` is the shape every collection shares, not a class you can import — import the concrete page class for the collection you are paging. And the per-event `data` payloads inside `JobEvent` are plain dicts, so they have no class at all.

That last one has a consequence worth stating plainly: a `JobEvent`'s `data` is the wire payload exactly as it arrived, so its keys stay camelCase (`trialId`, not `trial_id`). The same is true of `TrialTraceEvent.data`, of `err.details`, and of the nested dicts inside the capability document. Everywhere else this SDK converts to snake_case for you.

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
    reasoning_effort: str | None = None   # 'off' | 'minimal' | 'low' | 'medium' | 'high' |
                                          # 'xhigh' | 'max' | 'thinking'. None = the platform
                                          # default ('medium'); PART OF THE AGENT'S IDENTITY,
                                          # so two efforts are two systems. An effort the
                                          # harness cannot apply -> invalid_input

@dataclass
class Page:                               # the shape EVERY collection shares, top
    items: list                           # level or nested. Not importable: use the
    next_cursor: str | None               # concrete JobPage / TrialPage / TaskPage /
    has_more: bool                        # TrialTracePage / BenchmarkImportPage / …

@dataclass
class JobCounts:                          # Job.counts — entity cardinality only,
    agents: int                           # the parts a job is made of. Nothing here
    tasks: int                            # has a status; TrialTally holds the "how many"

@dataclass
class TrialTally:
    total: int
    by_status: dict[str, int]             # EVERY trial status, zeros included

@dataclass
class JobFailure:                         # why a job FAILED — never the key `error`
    code: str
    message: str

@dataclass
class Job:                                # ONE shape from every call, nothing optional
    id: str
    status: str                           # job status above
    benchmark: str                        # 'name@version'
    agents: list[JobAgent]
    runs_per_task: int
    concurrency: int
    max_trial_spend_usd: float            # the per-trial cap that applied: yours, or the default
    worst_case_spend_usd: float           # trials x the cap — the most this job can cost
    sandbox_provider: str                 # 'e2b' | 'daytona' | 'modal'
    spent_usd: float                      # what the trials have spent so far
    counts: JobCounts                     # agents, tasks — entity cardinality only
    trials: TrialTally                    # total + the status histogram
    mean_reward: float | None             # mean over SCORED trials; None when none
    failure: JobFailure | None            # why it FAILED, or None
    source_job_id: str | None             # set on rerun_failed() jobs
    idempotent_replay: bool               # True when an Idempotency-Key replayed
    created_at: str
    updated_at: str

@dataclass
class JobEvent:                           # watch()
    seq: int                              # monotonic; the watch resume position
    type: str                             # one of the nine names below
    data: dict                            # payload; keys are the WIRE's camelCase

# What `data` holds, per `type`. Ten names, closed:
#
#   'job.created'     benchmark (resolved 'name@version'), taskCount, agents,
#                     runsPerTask, concurrency, maxTrialSpendUsd,
#                     sandboxProvider, trialCount
#   'job.running'     jobId
#   'job.cancelling'  jobId, cancelledTrials (queued trials cancelled outright),
#                     activeTrials (still in flight, winding down)
#   'job.cancelled'   jobId, cancelledTrials (the total across request + settle)
#   'job.completed'   jobId, undispatched (always 0; kept for wire compatibility)
#   'job.failed'      jobId — RESERVED; no server path emits it today
#   'trial.running'   trialId, taskKey
#   'trial.scoring'   trialId, capturedBytes (agent stdout kept for the detail)
#   'trial.spend'     trialId, taskKey, liveSpentUsd — a mid-run LOWER BOUND,
#                     built-in harnesses only; never the trial's cost
#   'trial.settled'   trialId, taskKey, status — always; plus reward on the
#                     scored path (zero is a reward), failurePhase on a failure,
#                     and attemptId/attemptPhase only when the REAPER settled it

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
    failure_detail: str | None            # truncated to 2000 chars in list rows; full via trial()
    phase_timings_ms: dict | None         # {'agent_ms': ..., 'verify_ms': ...}
    model_usage: ModelUsage | None        # per-harness detail; read spend from spent_usd
    sandbox_provider: str | None          # where the trial executed; None until it has
    verifier_mode: str | None             # 'separate' | 'shared'
    spent_usd: float | None               # None = never ran (NOT 0, which is a measurement)
    spend_source: str | None              # 'measured' | 'assumed_cap'
    live_spent_usd: float | None          # mid-run LOWER BOUND; None = no reading yet
    live_spend_at: str | None             # when that reading was taken — show its age
    resolved_harness_version: str | None  # harness version actually used
    session_ref: str | None               # agent session/trace reference
    created_at: str
    updated_at: str

@dataclass
class TrialDetail(Trial):                 # trial(id, trial_id)
    job_id: str                           # failure_detail is untruncated here

@dataclass
class ModelUsage:                         # open-ended per-harness detail
    max_trial_spend_usd: float | None     # the cap THIS trial's key carried (history)
    extra: dict                           # bundle identity, token counts, and on older
                                          # trials a historical cost_usd — snake_cased
                                          # keys; spend is trial.spent_usd, not this

@dataclass
class TrialTraceEvent:
    seq: int                              # resume position — pass as cursor=
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
class RegradeResultsPage:                 # how many, and one page of them
    total: int                            # results in the WHOLE job, not this page
    by_status: dict[str, int]             # EVERY regrade status, zeros included
    items: list[RegradeResult]
    next_cursor: str | None
    has_more: bool

@dataclass
class RegradeJob:                         # regrade() / regrade_trial() / get_regrade() / list_regrades()
    id: str
    source_job_id: str                    # the job the source trials belong to
    status: str                           # 'QUEUED' | 'RUNNING' | 'COMPLETED' — derived from
                                          # the WHOLE result set, never from one page
    sandbox_provider: str                 # where the verifier boxes run
    results: RegradeResultsPage
    created_at: str
    updated_at: str
    filter: RegradeFilter | None = None

@dataclass
class UpstreamStatus:                     # where the git source points NOW
    ref: str                              # what the active version was imported from
    current_commit: str                   # what it was built from
    latest_commit: str | None             # where the ref points now; None = last check failed
    moved: bool                           # branch on this
    behind_by: int | None                 # always None — see "When upstream moves"
    checked_at: str | None                # None before the first check
    error: str | None                     # why the last check failed

@dataclass
class Benchmark:                          # catalog.list() / catalog.get(ref)
    name: str
    title: str | None
    description: str | None
    active_version: BenchmarkVersion | None
    upstream: UpstreamStatus | None           # None = nothing to watch, NEVER "up to date"
    versions: list[BenchmarkVersion] | None   # get() only, newest first
    selected_version: BenchmarkVersion | None # get() only — the tasks' provenance
    tasks: TaskPage | None                    # get() only; page with limit=/cursor=
    created_at: str | None                    # get() only
    updated_at: str | None                    # get() only
    # ActiveBenchmark (get_active) is the same shape with version + tasks non-optional

@dataclass
class TaskPage:                           # Benchmark.tasks — a page of Task rows
    items: list[Task]
    next_cursor: str | None
    has_more: bool

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
    status: str                           # 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
    benchmark_name: str
    version: str
    failure: ImportFailure | None         # never `error` on a 200 body
    task_count: int | None                # tasks parsed, once counted
    created_at: str | None
    updated_at: str | None

@dataclass
class ImportFailure:                      # BenchmarkImport.failure
    code: str                             # 'import_failed' when none was recorded
    message: str                          # e.g. '2/113 task(s) failed to parse'
    failures: list[BenchmarkImportFailure]  # per-task, when the corpus was reachable

@dataclass
class BenchmarkImportFailure:             # one row of ImportFailure.failures
    task_key: str
    error: str

@dataclass
class CustomHarness:                      # harnesses.list() / get() / create()
    name: str                             # the value you pass as agents[].harness
    source: str                           # 'install_script' | 'tarball'
    run_command: str                      # run headless with `sh -c` at the task directory
    env: dict[str, str]                   # injected at RUN time; cannot override contract keys
    created_at: str
    updated_at: str
```

`custom_harnesses().create()` and `.upsert()` take `name` and `run_command`, plus EXACTLY ONE of `install_script` (the script itself) or `directory` (a local directory, tarred and uploaded); `env` is optional. Passing both or neither raises `ValueError` before the call leaves your process. `import_benchmark()` only raises when no usable source is named at all — see [Already in Harbor format](#already-in-harbor-format).

### Error codes

The shape an error arrives in is described once, under [Errors](#errors); this is the vocabulary that fills its `code`. The same list is published as `error_codes` in the [capability document](#what-the-platform-supports), so a client can check its own branches against the server's.

Codes you will actually branch on: `benchmark_not_found` (also what another account's private benchmark reads as), `benchmark_version_not_found`, `benchmark_name_taken` (409 — the import name belongs to someone else), `import_too_large` (413), `no_active_version`, `version_not_ready`, `unknown_task_keys`, `provider_unsupported`, `job_not_found`, `job_not_terminal`, `no_failed_runs`, `trial_not_found`, `harness_version_not_found`, `insufficient_credits` (402 — the account is out of credits; add some and retry), `job_too_large` (400 — the trial matrix exceeds `limits['job']['maxTrials']`; the message states the count it would have created), `rate_limited` (retry after the `Retry-After` header), `invalid_api_key`, and `invalid_input` (which is also what the per-agent and per-`runs_per_task` ceilings refuse with).

[Regrades](#regrade) add three: `regrade_source_ineligible` (409 — the source trial recorded no verifier inputs; the message names why), `no_regradable_runs` (409 — a whole-job regrade found nothing eligible), and `regrade_not_found`.

[Custom harnesses](#bring-your-own-harness) add their own: `custom_harness_not_found` (also what another owner's name reads as), `custom_harness_name_taken`, `custom_harness_name_reserved` (the name collides with a built-in harness), `custom_harness_source_required` (neither an install script nor a tarball), `custom_harness_source_conflict` (both), `custom_harness_invalid_env` (declared env tries to override a run-contract key), `custom_harness_invalid_name`, `custom_harness_too_large`, and `custom_harness_limit_reached` (the per-account registration ceiling).

Three more come from the shapes above: `idempotency_key_reused` (409 — the key already stands for a different request), `invalid_multipart` (400 — an upload that is not `multipart/form-data`, or is malformed), and `invalid_cursor` (400 — a malformed `cursor` on a paged read).
