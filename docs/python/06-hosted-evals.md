# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY` (see [Getting Started → Gateway Mode](./01-getting-started.md#gateway-mode-evolve_api_key)). Evolve runs the tasks, agents, and verifiers on managed infrastructure — you start a job and read results.

Four nouns cover the whole surface, used everywhere and without exception:

- A **dataset** is a named, versioned set of tasks.
- A **job** is one run: datasets × agents × attempts.
- A **trial** is one attempt of one task by one agent. Trial ids are globally addressable — no call needs the job id to reach a trial.
- An **agent** is the thing that attempts a task: a harness plus a model. You can register your own.

Each noun has a client, plus one for identity — five standalone factories, no `Evolve` instance needed:

```python
from evolve import agents, auth, datasets, jobs, trials

catalog = datasets()   # the shared dataset catalog
mine = agents()        # your own registered agents
evals = jobs()         # your jobs
t = trials()           # globally addressable trials
who = auth()           # identity: who am I, which key
```

All five read `EVOLVE_API_KEY` from the environment, or accept `HostedClientConfig(api_key=..., base_url=...)`. Every client is an async context manager (`async with jobs() as evals:`), and every method is `async`. A hosted request never follows a redirect that would carry the API key somewhere else: the Python SDK refuses every HTTP redirect outright and surfaces the 3xx as the error it is, and the TypeScript SDK's `fetch` strips `Authorization` on any cross-origin redirect — either way, the key only ever reaches the host you configured.

If you would rather configure once, `hosted()` is the same clients behind one door:

```python
from evolve import hosted

evolve = hosted()                            # or hosted(HostedClientConfig(api_key=...))
catalog = await evolve.datasets.list()
job = await evolve.jobs.start(datasets=[...], agents=[...])
```

It is called `hosted()` rather than `evolve()` because `Evolve` is already the local-sandbox class in this package, and two names a shift key apart doing unrelated things is a trap worth avoiding. The clients are built on first access, so `evolve.meta()` — the one call that needs no credentials — works before an API key is set.

Job and trial ids are UUIDs. Ids minted before the switch use an older alphabet and remain valid everywhere — every id-taking call accepts them — so treat ids as opaque strings and never parse their shape.

---

## Start a job

Pick datasets from the catalog:

```python
page = await catalog.list()                     # one page of datasets + active versions
async for dataset in catalog.list():            # or walk the whole catalog
    ...

deep_swe = await catalog.get('deep-swe@1.1')    # one version: task list + timeouts
active = await catalog.get_active('deep-swe')   # active READY version, guaranteed runnable
# get_active() raises NoActiveVersionError when nothing is runnable yet
```

Every collection on this surface is the same page: `items`, `next_cursor`, `has_more`, paged with `limit`/`cursor`. `next_cursor` means one thing everywhere — pass it back for the next page, and `None` means there is no next page. Both list calls hand you a value you can either `await` for a single page or `async for` to walk every row, fetching pages as it goes. `list(search=...)` filters the catalog by free text over name and description, server-side.

`READY` is the one dataset-version state that accepts jobs — see [Statuses](#statuses). Tasks expose public fields only — `task_name`, `agent_timeout_sec`, `verifier_timeout_sec`, and `providers`, the per-provider capability verdict ([Where it runs](#where-it-runs)). Instructions, environments, and tests never leave the server — with one deliberate exception, the dataset's own owner downloading the package they published ([Getting your corpus back](#getting-your-corpus-back)).

Then start the job. `datasets` is a **list** — one job can span several — and only `datasets` and `agents` are required:

```python
job = await evals.start(
    datasets=[
        {'name': 'deep-swe'},                       # bare name = active version
        {'name': 'frontier-swe', 'version': '1.2'}, # or pin one
    ],
    agents=[
        {'name': 'codex', 'model_name': 'gpt-5.5'},
        {'name': 'claude', 'model_name': 'fable'},
    ],
    n_attempts=1,               # (optional) attempts per task × agent arm, default 1
    n_concurrent_trials=4,      # (optional) parallel trials, default 4, ceiling 16
    max_trial_spend_usd=25,     # (optional) hard model-spend cap for EACH trial
)

print(job.status)               # "QUEUED"
print(job.datasets)             # [DatasetRef(name='deep-swe', version='1.1'), …] — resolved, echoed back
print(job.counts)               # JobCounts(agents=2, tasks=214) — entity cardinality
print(job.trials.total)         # 428
print(job.trials.by_status)     # {'QUEUED': 428, 'RUNNING': 0, 'SCORED': 0, …} — every status, zeros included
```

`datasets` and `agents` take plain dicts or the `DatasetSelector` / `AgentArm` dataclasses — the same fields either way. Each dataset selector can also narrow its own task set: `task_names` and `exclude_task_names` are glob patterns over task names, and `n_tasks` caps the count after filtering — so a smoke run over the first twenty tasks of each dataset is a selector field, not a fork of the dataset:

```python
datasets=[
    {'name': 'deep-swe', 'task_names': ['auth-*'], 'n_tasks': 20},
],
```

Every job response is the same shape, whatever produced it. `start()`, `get()`, `cancel()`, `resume()`, `regrade()` and each row of `list()` carry the same fields, so a job card renders from any of them without your knowing which call it came from. `counts` is entity cardinality — the parts a job is made of — and `trials` is the one "how many" structure: a total plus a status histogram that names every status, zeros included, so a status bar never needs the enum hardcoded. `job_name` is a user-facing label — pass one or take the server's.

### Money

`max_trial_spend_usd` caps what a single trial may spend on model calls, and it is the only spend limit the platform enforces: every trial runs on its own freshly minted gateway key, and the cap is that key's budget. Leave it out and the platform applies its published default ($200 per trial). The response always reports the cap that actually applied — `job.max_trial_spend_usd` — so an omitted one is never a mystery.

There is no job-wide budget, which means a job's real ceiling is simply its trial count times that cap. The response states it for you as `job.worst_case_spend_usd`, so you can see what a large matrix commits you to before it starts running. Your account credit balance is the hard backstop underneath: when the balance runs out, spending stops mid-job whatever the caps say, and starting a job while the balance is already at zero is refused up front with a `402 insufficient_credits`. A trial that exhausts its own cap is not a failure — the agent just runs out of budget, and the trial is still scored on whatever it produced.

Runs on your own provider key are the one exception to the credit ledger. When a [managed BYO provider key](./01-getting-started.md#managed-byo-provider-keys) is enabled for the model's provider, the trial's model calls bill your provider account directly and draw no Evolve credits — the per-trial cap still meters and bounds the trial exactly as before. The exception is about who pays, not about the gate at the door: the zero-balance check runs on every job create and every `resume()`, BYOK included, so keep a non-zero balance even if you run BYOK-only.

### Shape and ceilings

A job expands to `tasks × agents × n_attempts` trials, each in its own sandbox. `n_concurrent_trials` is how many run at once. The ceilings — distinct agent arms per job, attempts per task, total trials — all refuse at create rather than partway through, and every one of them is published under `limits['job']` in the [capability document](#what-the-platform-supports) rather than only here, so a form can check a sweep before it POSTs. `sandbox_provider` (optional, default `"e2b"`) picks where the sandboxes run — see [Where it runs](#where-it-runs).

`agent_env` and `verifier_env` inject environment values into every agent or verifier run. They are pass-through slots: the client sends them verbatim and the server owns acceptance — refused where unsupported, never silently dropped.

### Agent arms

An agent arm is `name` plus `model_name` plus two optional identity fields. `name` is a built-in (`claude`, `codex`, `gemini`, `qwen`, `kimi`, `opencode`, `droid`) or an agent you registered yourself ([Bring your own agent](#bring-your-own-agent)); `model_name` is always required — the server applies no model default. Model names are the SDK's own, harness by harness: the `claude` harness takes the four short aliases from the model table — `haiku`, `opus`, `sonnet`, `fable` — and every other harness takes its canonical names from that same table (`gpt-5.5` for `codex`, `claude-fable-5` for `droid`, the `openrouter/…` ids for `opencode`). The table and the pairing rules live in [Getting Started → Agent Reference](./01-getting-started.md#agent-reference).

Pin an agent version when you need the comparison to hold still across weeks:

```python
agents=[
    {'name': 'codex', 'model_name': 'gpt-5.5', 'version': '0.29.0'},
],
```

Omitting it resolves the latest at dispatch; either way the version that actually ran is recorded on every trial as `agent_info.version`, so a trial is always attributable after the fact. A pin is never silently downgraded: an unresolvable pin is refused at creation (`agent_version_not_found`), and a pin on a registered agent is refused too — registered agents are versioned by their own content, so there is no separate version axis to pin.

`reasoning_effort` is the other identity field, and it belongs to the comparison rather than to the run. The accepted values are published as `limits['job']['reasoning_efforts']` in the [capability document](#what-the-platform-supports). An omitted effort resolves to the **agent's own default** — not the document's platform-wide `default_reasoning_effort` — and that resolved value is stamped as arm identity: trials echo it on `agent_info.reasoning_effort`, and the job's `evals` keys carry it as the `__effort` segment even though the job never declared one (a claude arm with no effort settles under `…__high`, a kimi arm under `…__max`). Effort changes the score, so a client comparing two jobs must read the stamped value, never assume what an omitted one meant. Effort is part of an arm's identity alongside the agent, the model, and the version pin: the same agent and model at `low` and at `high` are two distinct systems — they de-duplicate separately, they each consume an arm slot, and every trial echoes the effort back on `agent_info.reasoning_effort`. An effort the agent cannot apply is refused at creation with a `400 invalid_input` rather than accepted and quietly dropped — recording `high` against a CLI that never received the flag would put a claim in the record that did not happen. Each capability entry publishes `effort_support`, so a picker can grey the control out instead of discovering the refusal after a POST.

### Idempotency

Retries are safe — pass an idempotency key and a retry returns the original job instead of creating a duplicate:

```python
retry = await evals.start(
    datasets=[{'name': 'deep-swe'}],
    agents=[{'name': 'codex', 'model_name': 'gpt-5.5'}],
    max_trial_spend_usd=25,
    idempotency_key='nightly-2026-07-31',
)
print(retry.idempotent_replay)   # True when the key replayed an existing job
```

A key on its own is not enough, so the server also fingerprints the request behind it. Repeat the same request with the same key and you get the original job back; send a *different* request under a used key and it is refused with a `409 idempotency_key_reused` rather than handed yesterday's job while you believe a new run started. Use a fresh key for a genuinely new run.

---

## Watch it live

`watch()` is a dual-use handle over the job's event stream. Iterate it for live events, or await it for the final job — pick one form per call:

```python
# Iterate events as they arrive
async for event in evals.watch(job.id):
    # event.seq  — monotonic sequence number
    # event.type — "job.created" | "trial.settled" | "job.completed" | …
    if event.type == 'trial.settled':
        # event.data is the payload dict, keys in the wire's own vocabulary
        update_progress(event.data['task_name'], event.data['status'], event.data.get('reward'))

# Or await the final Job
final = await evals.watch(job.id)
print(final.status, final.trials.by_status, final.stats.get('cost_usd'))
```

Options apply in every form — tune backoff on an iterated watch the same way; `on_event` fires regardless:

```python
final = await evals.watch(
    job.id,
    on_event=lambda event: print(event.type, event.data),
    timeout_s=3600,                # (optional) give up after this long
    reconnect_delay_s=1.0,         # (optional) initial backoff, default 1s
    max_reconnect_delay_s=30.0,    # (optional) backoff ceiling, default 30s
)
```

The stream replays from the beginning, so attaching late loses nothing. The parser honors every line terminator the SSE grammar names — CRLF, LF, and a lone CR — even when one arrives split across network chunks. On disconnect it resumes from the last sequence number with exponential backoff — no gaps, no duplicates. Once the job reaches a terminal status, the handle resolves with the final `Job`.

### Live cost and live tokens

While a trial runs, its spend is readable before anything settles, on two fields that travel together:

```python
print(trial.live_spent_usd, trial.live_spend_at)  # 3.41  "2026-07-31T18:22:05.113Z"
```

Two mechanisms feed that number, and knowing both tells you how fresh it is. Every non-streaming model call reports its own cost the moment its response headers arrive, and the platform accumulates those readings per trial — flushed to the record at most once every 5 seconds, so the figure starts moving within seconds of the first completed call. Underneath it, the gateway's spend ledger — the settled log of what each key actually spent — is read about every 30 seconds and can only raise the figure. The same 30-second ledger read carries **token counts** beside the money, so live token numbers move on that cadence.

Read the pair together or not at all, and hold on to the rules that follow from what it is:

- **It is a lagging lower bound, never the trial's cost.** Render it as "at least $3.41, as of that timestamp" — never as "current cost".
- **`None` is "no reading yet", never `$0`.** Zero from the ledger means nothing has settled, not that the trial was free.
- **It only climbs, and it is cleared at settle.** On a terminal trial read `agent_result.cost_usd` and `spend_source`; those are the settled truth, and the only one.
- **It is never part of a total.** `stats['cost_usd']` sums settled trials only; folding a live reading in would double-count the moment that trial settles.
- **Built-in agents only.** A registered agent runs your own command with no live poll around it, so its trials go from `None` straight to a settled cost.

The same reading reaches a watcher as a `trial.spend` event carrying `trial_id`, `task_name` and `live_spent_usd` — and, when the ledger sample carried them, the token sums. It is emitted only when a sample actually landed on a live trial, so a poll that raced the settle never fires one.

---

## Read the results

```python
# One job: size, status histogram, stats, spend
detail = await evals.get(job.id)
print(detail.trials.total, detail.trials.by_status)   # 428, {'SCORED': 301, 'RUNNING': 3, …}
print(detail.stats.get('cost_usd'))                   # measured spend across settled trials
print(detail.stats.get('n_input_tokens'), detail.stats.get('n_output_tokens'))  # token totals
print(detail.failure)                                 # why it FAILED — None on every job today

# Your jobs, newest first — await one page, or iterate them all
job_page = await evals.list(limit=50)                 # job_page.next_cursor continues
async for item in evals.list(search='nightly'):
    print(item.id, item.job_name, item.status, item.stats.get('cost_usd'))
```

`list(search=...)` is a server-side free-text filter over the job name and its dataset names. `stats` is the aggregate block, a plain dict with the wire's own keys: progress counters, token totals (`n_input_tokens` includes cache tokens; `n_cache_tokens` and `n_output_tokens` beside it), measured `cost_usd`, and `evals` — per-(agent, model, dataset) statistics keyed `agent__model__dataset__effort`. The effort segment is always there: a declared effort stamps itself, an omitted one stamps the agent's default (`__high`, `__max`, …) — see [Agent arms](#agent-arms). A failed job says why on `failure`, as a `JobFailure(code, message)` — the same grammar an API error uses, under a different key so that "error means this request failed" stays true on a healthy read. In practice you will not see it fire: `FAILED` is a [reserved job status](#statuses) that nothing sets today; read `trials.by_status` for where a job actually went wrong.

### Trials

Trials page the same way — await a page or iterate across pages. `status` filters, and on a multi-dataset job `dataset` narrows to one dataset's trials:

```python
async for trial in evals.trials(job.id):
    print(trial.task_name, trial.agent_info.name, trial.status, trial.reward)

failures = await evals.trials(job.id, status=['INFRASTRUCTURE_ERROR', 'SCORING_ERROR'])
one_lane = await evals.trials(job.id, dataset='deep-swe')
```

### Per-task rollup

Between the job body and the trial list sits `tasks()` — one row per distinct task, with its trial tally, mean reward, and cost, so you can see which tasks drag without fetching every trial:

```python
async for row in evals.tasks(job.id):
    print(row.task_name, row.source, row.mean_reward, row.cost_usd)
    # row.trials — the same TrialTally shape as the job's
```

`source` names the dataset the task came from — the disambiguator a multi-dataset job needs.

### One trial in depth

A trial id is globally addressable — `trials().get(trial_id)` needs no job id; the body carries `job_id` as the reverse pointer:

```python
trial = await t.get(trial_id)

print(trial.reward)                          # primary reward; None until scored, 0 is a reward
print(trial.verifier_result.rewards if trial.verifier_result else None)
print(trial.agent_result.cost_usd if trial.agent_result else None, trial.spend_source)
print(trial.agent_result.n_input_tokens,     # token counts (input includes cache)
      trial.agent_result.n_cache_tokens,
      trial.agent_result.n_output_tokens)
print(trial.agent_execution)                 # TimingInfo(started_at=…, finished_at=…) — a timing pair
print(trial.sandbox_provider, trial.verifier_environment_mode)
print(trial.agent_info.version)              # agent version actually used
print(trial.attempt_phase)                   # which step a RUNNING trial is in
if trial.exception_info:                     # why it failed, when it did
    print(trial.exception_info.exception_type,
          trial.exception_info.exception_message)  # untruncated in this response
```

Every phase's wall-clock is a **start/stop pair**, never a duration: `environment_setup`, `agent_setup`, `agent_execution`, and `verifier` are each a `TimingInfo(started_at, finished_at)`, either bound `None` while the phase has not reached it. Durations you compute yourself keep their provenance — you always know which clock produced them.

> **Reading spend:** `spend_source` is the lane the figure came from, and only `'measured'` is final. `'measured_provisional'` is a real reading taken inside the gateway's asynchronous spend flush — an honest floor that a deferred pass later confirms or raises into `'measured'`. `'assumed_cap'` means nobody measured this trial's spend; the number it holds is zero — a placeholder, never an observation (the platform under-bills rather than publish an invented figure), and the deferred pass replaces it when a real reading lands. So a read taken shortly after settle can show `'measured_provisional'`, or `'assumed_cap'` with `$0` — treat anything but `'measured'` as not yet final. `agent_result.cost_usd is None` means the trial never ran — a queued or cancelled trial — and is not the same as `0`, which is a real measurement. `trial.max_trial_spend_usd` is the cap *this* trial's key carried, which can differ from the job's current cap on rows settled before a change.

> **Reading failures:** `status` is the primary key for failure classes; `exception_info` is the detail — `exception_type` is one of the platform's stable failure names (`ScoringError`, `InfrastructureError`, `CancelledError`, `IncompleteTrialError`), `exception_message` is truncated to 2000 characters on list rows and full on the detail route, and `exception_traceback` rides along when one was recorded.

`attempt_phase` answers the question `RUNNING` alone cannot: which step the trial is in (`prepare`, `build`, `boot`, `install`, `agent`, `verify`, `persist`), so a polling caller can tell a slow environment build from a slow agent.

### The trace

Fetch a trial's recorded event timeline:

```python
async for event in t.trace_events(trial_id):
    print(event.seq, event.type, event.data)

# Or page manually — the same envelope as every collection
trace = await t.trace(trial_id, limit=500)
more = await t.trace(trial_id, cursor=trace.next_cursor)
```

The first event of every trace (`seq` 0) is the task instruction itself, carried as `_prompt` — a trace read on its own opens with the prompt rather than mid-conversation. `trace_events()` drains the currently available trace, then stops — `next_cursor` is `None` once you are caught up, which is how the drain knows. A trace cursor is a position in the seq timeline, so to follow an in-flight trial later, keep the last event's `seq` and resume with `cursor=str(last_seen_seq)`.

---

## Trial artifacts — the raw record

Beside the parsed trace, every trial archives its raw record, and one six-name vocabulary names the pieces everywhere — API, SDK, CLI, and the dashboard's download menu:

| Name | What it is |
|------|------------|
| `trace-parsed` | The parsed event timeline — what `trace()` / `trace_events()` page |
| `trace-stdout` | The agent process's stdout, byte for byte |
| `trace-stderr` | The agent process's stderr, byte for byte |
| `trajectory` | The normalized-trajectory slot — in the vocabulary ahead of its server wave |
| `agent-home` | The CLI's whole home folder, collected after the run |
| `verifier` | Everything the scoring step printed |

The raw ones come from `artifact()`:

```python
stdout = await t.artifact(trial_id, 'trace-stdout')   # str | None
stderr = await t.artifact(trial_id, 'trace-stderr')   # str | None
grader = await t.artifact(trial_id, 'verifier')       # str | None
home = await t.artifact(trial_id, 'agent-home')       # dict[path, text] | None
```

`trace-stdout` and `trace-stderr` are the referee whenever the parsed trace looks wrong. `agent-home` is the agent CLI's entire home folder (`/root/.claude`, `/root/.codex`, …) collected whole after the run, subagent transcripts included by construction, keyed by sandbox path. `None` is a normal answer, never an error: the trial never stored that artifact (it was cancelled early, the agent wrote nothing, or the trace was purged).

`trajectory` is different: it is in the vocabulary **ahead of its server wave**. Until that wave lands, the route answers not-found for it, and the SDK and CLI report that as the API error it is — no silent empty answer. The name is published now so a client written today parses the slot the day it first fills.

The CLI speaks the same six words. `evolve-evals trial download <trial-id> --stream <name>` prints one artifact to stdout; without `--stream`, everything the trial recorded is saved under `<dir>/<trial-id>/` — `trace-parsed.jsonl`, `verifier.log`, `trace-stdout.log`, `trace-stderr.log`, and `agent-home/` with the folder tree preserved (`trajectory` joins the saved set when its wave lands). The two modes are exclusive, and `--cursor`/`--limit` page only `--stream trace-parsed` — the CLI refuses any other mix as a usage error instead of letting one flag silently win.

This archive belongs to hosted evals: trials are scoring evidence. A managed agent session keeps its parsed transcript download; its raw stream lives in the SDK's local session log and its home folder inside your own sandbox.

---

## Stopping work

Two verbs, two scopes. `cancel()` stops a **job**; `stop()` stops **trials** and leaves their job running:

```python
await evals.cancel(job.id)     # idempotent; a terminal job is a no-op

report = await t.stop([trial_a, trial_b])
print([r.id for r in report.stopped])   # killed and settled by this request
print(report.already_terminal)          # were already done; untouched
print(report.not_found)                 # not yours or not real — never distinguished
```

`stop()` kills each trial's sandbox and settles the trial with its spend read from the gateway. Every requested id appears in exactly one of the three lists. Ids belonging to someone else land in `not_found` — existence is never leaked — and already-terminal trials are reported as such and left untouched, so the call is idempotent. One request takes up to 100 ids. A stopped trial rejoins the run by default on [`resume()`](#resume) once its job is terminal.

The CLI adds one convenience on top: `evolve-evals job stop <id> --dataset <name>` stops one dataset's trials and leaves the job — and every other dataset — running. It is pure sugar over surfaces that already exist (the job's `datasets`, the trial list's `dataset` filter, and the stop door), pages its batch under the 100-id cap, and merges the reports into one outcome. Every one of the dataset's trials is named to the door — deliberately not pre-filtered to live ones — so the report stays honest: a dataset whose trials have all settled reports them under `already_terminal`, and an empty report means exactly one thing, a dataset with no trials at all. Naming the whole slice is what that honesty costs: one stop request per 100 trials even when every one of them has already settled, so a big fully-settled dataset sends the requests a live-only pre-filter would have skipped, and a request that fails mid-batch — a 429 on the third of fifty — ends the command there. What it does not do is lose the half that landed: the trials already stopped are dead server-side and this report is the only place their ids exist, so the report prints first, marked partial with the count of trials no answer came back for and that unanswered batch named by trial position (`partial: true` and `unreported` under `--json`), and only then does the rate limit print and the command exit 1. Rerunning the same command finishes the rest and returns the already-dead under `already_terminal`. Stopping a dataset the job never spanned is a refusal, not an empty no-op — silence would read as "nothing was running".

---

## Resume

`resume()` takes a terminal job and creates a **new linked job** holding fresh trials for the source's failed and stopped work. The source is never mutated — it stays separately citable, and the new job's `source_jobs` records where it came from:

```python
follow_up = await evals.resume(job.id, idempotency_key='resume-1')
print(follow_up.source_jobs)   # [SourceJob(action='resume', type='hub', job_id=job.id)]
```

By default the platform resumes its standard failure set — `ScoringError`, `InfrastructureError`, `IncompleteTrialError` — plus stopped trials and the still-queued trials of a cancelled source. A stopped trial settles `CANCELLED` with exception type `CancelledError`, so a stop is never a dead end: `resume()` picks the stopped work back up without being asked. Narrow the set by exception type when you mean something more surgical:

```python
await evals.resume(job.id, filter_error_types=['InfrastructureError'])
```

`resume()` requires a terminal source job (`409 job_not_terminal` otherwise) and answers `409 no_failed_trials` when nothing qualifies. Scored trials are never re-executed.

---

## Regrade

A regrade re-runs **only the verifier**. The trial's recorded submission — the patch and artifacts captured when it ran — is restored into a fresh, sealed verifier sandbox and scored again; the agent phase is never re-run, and the source trial is never modified. Use it when a verifier was fixed or tightened and you want the same agent work re-scored under it, without paying for a single new agent run.

**The response is a job.** A regrade is an ordinary job whose `source_jobs` records `action='regrade'` and whose `is_regrade` is true — you watch it, list its trials, and read its stats with the same calls as any other job, and it shows up in `list()` like any other job:

```python
# Every regradable trial of a terminal job — optionally narrowed
regrade = await evals.regrade(
    job.id,
    statuses=['SCORED'],         # (optional) only source trials in these statuses
    task_name='task-001',        # (optional) only source trials of this task
)
print(regrade.is_regrade, regrade.source_jobs)   # True, [SourceJob(action='regrade', …)]

rescored = await evals.watch(regrade.id)          # an ordinary job watch

# One trial — from the trials client, no job id needed
single = await t.regrade(trial_id)
```

Eligibility is defined by the record, not by intent: a trial is regradable only if it **recorded its verifier inputs** when it settled. Settled `separate`-mode trials record them; nothing else does. Three consequences: shared-mode trials can never be regraded (their verifier inspected the live agent sandbox, which no longer exists); in-flight trials are not yet regradable; and trials that settled before the platform began recording verifier inputs are permanently ineligible. A single-trial regrade of an ineligible source is refused with `409 regrade_source_ineligible` naming the reason; a whole-job regrade requires a terminal source (`409 job_not_terminal`), selects only the eligible trials, and answers `409 no_regradable_trials` when there are none.

The verifier always re-runs `separate` and sealed. Compare the regrade job's trials against the source job's — same task names, same shapes — to read the deltas.

---

## Compare

Compare 2–10 of your jobs side by side — per-job aggregates plus a per-task matrix, disagreement rows first:

```python
comparison = await evals.compare([job_a.id, job_b.id])

for aggregate in comparison.jobs:
    print(aggregate.id, aggregate.mean_reward,
          f'{aggregate.coverage.scored}/{aggregate.coverage.total} scored', aggregate.cost_usd)

for row in comparison.task_matrix:
    if not row.disagreement:
        continue
    for cell in row.cells:
        print(row.task_name, cell.status, cell.mean_reward)
        # cell.status: a trial status, "MIXED" (trials disagree), or "MISSING" (no trials)
```

Mean rewards cover `SCORED` trials only; `coverage` is always reported so a high mean over few scored trials stays visible. Zero is a reward, never a gap.

---

## Download the archive

Download the full results archive (gzipped, deterministic bytes) of a terminal job:

```python
data = await evals.download(job.id)                  # bytes (default)
path = await evals.download(job.id, to='./results')  # save; returns file path
```

Both shapes are verified — the bytes against the response's length and, when the server states one, its digest; the to-disk shape hashes while streaming and promotes the file only after the check. There is deliberately no stream shape here where the TypeScript SDK has one: the HTTP layer is urllib inside a worker thread, so a chunk iterator would hand out unverified bytes one thread hop at a time, while `to=` already streams to disk in constant memory. Pipe from the file.

---

## CLI

The SDK's TypeScript package ships the `evolve-evals` binary — a thin shell over the same five clients this chapter documents (`npx evolve-evals`, no Python required). The grammar is noun-verb: `evolve-evals <noun> <verb>`, with `run` as the one top-level shortcut (an alias of `job start`). Singular nouns are canonical; the plurals parse as hidden aliases, as does `ls` for `list`.

```
job      start | list | show | trials | tasks | compare | cancel | stop | resume | regrade | download
trial    show | download | regrade | stop
dataset  list | show | publish | download | activate
agent    list | show | add | remove
auth     status
```

Start a job with the short flags — each one mirrors a field of the create body:

```bash
npx evolve-evals run \
    -d deep-swe@1.1 \            # --dataset, repeatable; bare name = active version
    -d frontier-swe \
    -a codex \                   # --agent <name[@version]> — the @version pins
    -m gpt-5.5 \                 # --model, repeatable; each model is one arm
    -k 2 \                       # --n-attempts per task × arm
    -n 8 \                       # --n-concurrent trials
    -e daytona \                 # --env: sandbox provider (e2b | daytona | modal)
    --max-trial-spend 25 \
    --watch                      # stream events until the job finishes
```

`-i/--include-task-name` and `-x/--exclude-task-name` filter task names by glob and `-l/--n-tasks` caps each dataset's count after filters — all three are stamped onto every dataset selector, so a glob that matches nothing in one dataset simply filters nothing there. `--effort <value>` sets the reasoning effort on **every** arm, verbatim; an agent that cannot honor it is refused by the server rather than silently skipped, so a mixed sweep that needs per-arm efforts belongs in the SDK. `--agent-env` / `--verifier-env` take `KEY=VALUE`, repeatable. `--job-name` labels the run. A flag's value may itself begin with `-` — a glob like `-x '-*'`, a negative number, a bare `-` — and is taken as the value; only a token that spells another flag of the same command is refused, and that refusal shows the `--flag=value` form that states the intent.

For a run you will repeat, put the body in a file. `-c/--config` loads YAML or JSON **in the spec's own vocabulary** — the same field names as `jobs().start()` — and explicit flags override its fields; `--print-config` prints the resolved body and exits without spending anything, the dry-run a paid remote run deserves. The YAML is real YAML, read by the standard `yaml` parser with PyYAML's semantics — the 1.1 schema, so `yes`/`on` read as booleans, a comment never lands inside a value, the apostrophe in `job_name: brando's run  # nightly` is a letter and the comment still strips, and a flow mapping like `- {name: claude, model_name: opus}` is one whole sequence item. That 1.1 schema is pinned rather than defaulted, so a `%YAML 1.1` or `%YAML 1.2` directive at the top of the file changes nothing about how the values under it read — PyYAML's resolver has no other mode either — while a version the parser does not know, like `%YAML 1.3`, refuses with its line number rather than being guessed at (PyYAML would read on; a refusal beats a guess in a file that spends money). Numbers follow PyYAML's pattern too, which is narrower than the 1.1 spec's in two places. A float needs a dot, and an exponent needs a sign, so `1.5e+3` is the number 1500 while `e3`, `1e3` and `5e-3` stay the text you typed — an ordinary build tag like `BUILD_TAG: e3` is a string, not a number that resolves to nothing. An integer may not be zero-padded, so `08`, `-09` and a clock-shaped `0:0` or `08:00` stay text as well, while `012` is still octal 10 and `12:30` is still 750. One strictness is the library's own and not PyYAML's: a flow collection written across several lines inside a block collection must keep its continuation lines indented past that block, so `agent_env: {A: 1,` with `B: 2}` back at the parent's indentation is refused with its line number — indent the continuation and it reads. Four things refuse with a line-numbered error instead of parsing quietly: a second document in the file, an unresolvable `!tag`, an unknown `%YAML` version directive, and a duplicate key (last-value-wins is a silent corruption a config file cannot afford). The shape of the body is not hand-kept anywhere: the file validates against the **contract itself** — the `JobCreate` schema in `spec/openapi.yaml`, shipped inside the package, and every shape it references (`DatasetSelector`, `AgentArmInput`, the `sandbox_provider` enum) — so a field the spec grows is accepted with zero CLI changes, and an unknown key is refused **by name at every level**, with the allowed keys listed. The file may be partial — `-d` and `-a`/`-m` can supply what it omits — so the top-level `datasets`/`agents` are not demanded of the file itself, but the keys **inside** an entry are: a selector needs its `name`, an agent arm its `name` and `model_name` (the server applies no model default). Types read out of the same schema, refused at the keyboard: `datasets`/`agents` entries are objects (a bare name like `datasets: [deep-swe]` is refused by element, never spread into characters), strings are strings — an unquoted `version: 1.10` is refused rather than shipped as the number 1.1, which names a different dataset version — `n_attempts`, `n_concurrent_trials` and `n_tasks` are integers, and the spec's stated constraints hold before any round trip: `sandbox_provider` one of `e2b | daytona | modal`, `n_attempts` 1-100, `n_concurrent_trials` 1-16, `n_tasks` at least 1, at most 8 agent arms, `job_name` at most 200 characters. A schema refusal names the config path, the file **and the line**, and the spec shape that ruled — `--config: datasets[0].version in nightly.yaml:5 must be a string, not a number — quote it (version: "...") [spec: DatasetSelector.version]` — so the fix is findable from the message alone (a JSON config refuses the same laws, just without a line: JSON keeps no positions). On top of the schema sit the wire laws only YAML can trip: any value YAML resolves past what a JSON body can carry — a bare `2026-08-02` date, `.inf`, `.nan`, `!!binary`, `!!set` — is refused instead of rewritten on the way out — as is a value that contains ITSELF, which two lines of valid YAML can write (`agent_env: &a` over `  X: *a`) and no JSON body can carry, named by its key and file rather than left to exhaust the reader. That last one is the quiet corruption: `JSON.stringify` does not refuse a Date, it turns it into an ISO string, and `job_name` is a plain string to the server, so a date-shaped name would be ACCEPTED and the job would carry a name nobody wrote (quote the value to keep it text). What stays the server's to judge is what only the server knows: whether a name exists. A config file reads like this:

```yaml
# nightly.yaml
datasets:
  - name: deep-swe
    version: "1.1"
  - name: frontier-swe
agents:
  - name: codex
    model_name: gpt-5.5
  - name: claude
    model_name: fable
n_attempts: 2
max_trial_spend_usd: 25
```

```bash
npx evolve-evals job start -c nightly.yaml --print-config   # inspect the exact body
npx evolve-evals job start -c nightly.yaml --watch          # then run it
```

The read side, worked through:

```bash
npx evolve-evals job list --limit 20 --search nightly
npx evolve-evals job show <id> [id...]
npx evolve-evals job trials <id> --status INFRASTRUCTURE_ERROR,SCORING_ERROR
npx evolve-evals job trials <id> --dataset deep-swe
npx evolve-evals job tasks <id>                      # per-task rollup
npx evolve-evals job compare <id> <id>
npx evolve-evals job cancel <id>
npx evolve-evals job stop <id> --dataset deep-swe    # one dataset's live trials
npx evolve-evals job resume <id> -f InfrastructureError
npx evolve-evals job regrade <id> --task task-001
npx evolve-evals job download <id> -o results/

npx evolve-evals trial show <trial-id>
npx evolve-evals trial download <trial-id> --stream trace-stdout
npx evolve-evals trial download <trial-id> -o trials/
npx evolve-evals trial regrade <trial-id>
npx evolve-evals trial stop <trial-id> [trial-id...]

npx evolve-evals dataset list -q
npx evolve-evals dataset show deep-swe@1.1
npx evolve-evals auth status
```

Output follows one precedence everywhere: human tables on a TTY, tab-separated rows when piped, `--json` for the machine shape (NDJSON for `--watch` streams), and `-q` for ids-only lists (on `job start --watch`, `-q` suppresses the event log and prints the final block only). `--columns` chooses and orders list columns (`--columns help` names them; for `job list` they are `id`, `name`, `status`, `datasets`, `agents`, `trials`, `spent`, `started` — the money column's key is `spent`, not `cost`), `--no-trunc` disables cell truncation, `--no-headers` drops the header row from piped output. `--limit` and `--cursor` page every listing the same way.

Wherever a verb takes a **job id**, an unambiguous prefix of at least 8 characters works too: `job show aabbccdd` is `job show aabbccdd-…` when exactly one of your jobs starts that way. The CLI resolves the prefix against your own job list before calling the server — the wire always carries the full id — and refuses loudly when the prefix matches nothing or more than one job. Trial ids are not prefix-resolved; trial verbs take full ids.

A rate limit is a delay, not a mystery: a `429` prints one line naming the limit and the server's `Retry-After` delay (exit 1), and the SDK's watch loops honor that delay and keep watching instead of dying mid-poll.

Closed sets are validated at the keyboard: a typo in `--stream`, `--status`, or `-e/--env` is a usage error naming the legal values, never a round trip.

Credentials: `$EVOLVE_API_KEY`, or `--api-key`; `--base-url` targets a non-default deployment. Exit codes: `0` success (with `--watch`: the job `COMPLETED`, or a publish `COMPLETED`), `1` runtime failure (with `--watch`: `FAILED` or `CANCELLED`), `2` usage error.

### Signing in

Today the credential story is one step: create an API key in the dashboard and export it as `EVOLVE_API_KEY`. `auth().status()` then tells you who the platform thinks you are — your user, your email, and a descriptor of the key in use (the secret is never returned):

```python
status = await who.status()
print(status.user_id, status.email, status.key.label)
```

`auth login` — the browser sign-in flow that mints the key for you — lands with the auth release. Key listing and revocation are already in the contract and served; their SDK and CLI verbs arrive with the same release.

The key descriptor's `last_used_at` is in the shape but nothing updates it yet: it stays `None` even on the key making the request. Read it as "not recorded", never as "this key is unused".

Dataset publishing and agent registration have their own subcommands — shown in [Bring your own dataset](#bring-your-own-dataset) and [Bring your own agent](#bring-your-own-agent).

---

## What the platform supports

Everything a client would otherwise hardcode — the legal agent names, the status enums, the limits, the error codes — is one public, cacheable document. It needs no API key, so a signed-out page can populate its own agent picker:

```python
from evolve import meta

# `meta` is a module-level function, and is also `hosted().meta()` —
# the same document either way.
doc = await meta()

for agent in doc.agents:
    print(agent.name, agent.effort_support, agent.latest_version)
```

`GET /api/meta` is the wire form. Every field is derived from the module that enforces it, so a published limit and an enforced limit cannot drift apart, and a new agent appears here the moment the platform can run it. What is in it:

- **`agents`** — every built-in, with `effort_support` (whether `reasoning_effort` reaches it), `version_pinnable`, and `latest_version` for a "your pin is out of date" badge (`None` means "not known right now", never "up to date").
- **`agent_registration`** — the rules a bring-your-own registration must satisfy: name pattern and length, size caps, `max_per_user`, the reserved built-in names, and the reserved env keys the platform owns. A plain dict with the wire's own keys.
- **`sandbox_providers`** — each provider's real resource ceilings and, in `refuses`, the capabilities it will not run with the reason the runner itself would give. **`platform_constraints`** beside it holds the refusals that apply on *every* provider, so "runs nowhere" is distinguishable from "runs somewhere else".
- **`managed_providers`** — the managed sandbox doors this deployment serves; a different question from the eval lane. Each entry's `agent_sessions` says whether the door carries a full SDK agent session; all three doors do today, Modal included — the Modal door serves commands *and* the file quartet, proven end to end — so a `false` there with a "no filesystem operations" reason is a stale value, not a capability statement. §Managed Sandboxes in the configuration chapter is the authoritative description of what each door serves.
- **`network_modes`** — the three modes a task may declare ([What runs](#what-runs)).
- **`statuses`** — the job, trial, import, and dataset-version vocabularies, each with its `terminal` members marked. A watcher stops on `terminal`; a status bar renders `values` without hardcoding the enum.
- **`limits`** — `limits['job']` carries every create-time bound (`max_agents`, `max_n_attempts`, `max_trials`, `n_concurrent_trials` default and ceiling, `default_max_trial_spend_usd`, `default_sandbox_provider`, `default_sizing`, `model_required`, the effort vocabulary, and the phase wall-clocks a task inherits when its own config declares none — `default_agent_timeout_sec` 3600, `default_verifier_timeout_sec` 600; a task that declares its own always wins). `compare` bounds the compare fan-out; `pagination` publishes a `default`/`max` pair per collection scope; `uploads` holds the two archive size caps; `dataset_names` the name pattern and length bounds; and `max_items_named_in_error_message` is how many offending items a refusal names in its English sentence before "and N more" — which is why `details` exists.
- **`error_codes`** — the whole vocabulary from [Error codes](#error-codes), in one array. **`import_warning_codes`** beside it lists the warnings an import can carry.

`schema_version` moves when a field is added, removed, or changes meaning — never when a value changes. Pin behavior to it, not to a deploy date. Responses carry an `ETag` and `Cache-Control: public, max-age=300, stale-while-revalidate=300`; send the ETag back as `If-None-Match` and a matching document answers `304` with no body.

---

## Errors

Every failure is one shape:

```python
from evolve import EvolveAPIError

try:
    await evals.start(
        datasets=[{'name': 'deep-swe'}],
        agents=[{'name': 'codex', 'model_name': 'gpt-5.5'}],
        sandbox_provider='modal',
    )
except EvolveAPIError as err:
    if err.code == 'provider_unsupported':
        # Every refused task, with its reason. Not a sentence to regex.
        refused = (err.details or {}).get('refused_tasks', [])
        print(f'{len(refused)} tasks cannot run on modal')
```

- **`code`** is the stable identifier. `HOSTED_ERROR_CODES` (the runtime tuple), the `HostedErrorCode` Literal, and `is_hosted_error_code()` are exported so a type-checker catches a typo'd code the way the TypeScript compiler does; a server newer than your SDK may send a code the list does not know, so `err.is_known_code()` says which situation you are in.
- **`message`** (`str(err)`) is the human sentence, and it may be shortened. **`details`** never is. When a refusal says "and 8 more", all of them are in `details` — that is the rule, and it is why `details` exists.
- **`param`** names the input that was wrong — a body path (`agents[0].name`), a query parameter (`limit`), or a multipart part — so a form can highlight one field instead of showing a banner. It is filled when the server can name one field; today the `invalid_input` family typically arrives without it, so treat `param` as an enhancement to act on when present, never a field to rely on — the `message` and `details` carry the refusal either way.
- **`retry_after_sec`** is set on `429` and `503`, read from the body first and the `Retry-After` header second.
- **`request_id`** identifies the failure server-side. Quote it in a support thread.

---

## What runs

Any corpus in the platform's task layout ([the format](#not-in-the-task-layout-yet)). Three environment shapes, all first-class:

- **Single-container** — the task pins a Docker image; agent and verifier run in it.
- **Dockerfile-built** — the task ships `environment/Dockerfile`; Evolve builds the image once at import.
- **Multi-container** — the task ships `environment/docker-compose.yaml`; its service containers (databases, brokers, APIs) run alongside the agent's `main` container.

A task also declares *how* it must run, and every declaration is honored as written. A provider that cannot honor one refuses the trial with the reason named — nothing ever silently runs on weaker semantics than the task declares.

### Network modes

Tasks declare the agent sandbox's network access:

- `no-network` — sealed; the agent reaches nothing but its model.
- `allowlist` — only the hosts the task names.
- `public` — open internet.

**A task that declares no mode gets `public`** — the task format's own omission rule, honored as written. That is worth knowing before you assume a sealed box: only `no-network` makes the per-trial spend cap a hard boundary, because only then is the gateway the sole route out. See [What keeps a trial inside its budget](#the-run-contract).

The **verifier never gets network**, in any mode — it always runs sealed, regardless of what the task declares. Each trial records the mode it ran under and where that decision came from in `agent_result.metadata` — compare rewards only across trials that agree on both, because an agent with internet access ran a different experiment from a sealed one.

### Verifier modes

- `separate` — the verifier boots a pristine copy of the task environment and judges the collected submission. Nothing the agent left behind can touch the verdict. A separate-mode task must also say what carries over: a top-level `artifacts = [...]` list in `task.toml` naming the absolute paths the agent's work lives at. Those files are collected from the agent sandbox and re-materialized at the same paths in the verifier's pristine copy — without the list the verifier judges an environment the agent never touched, and even the gold solution scores 0.
- `shared` — the verifier command runs inside the agent's sandbox, after the agent finishes and its credentials are revoked.

Both are supported; the task picks (`environment_mode` in its config). The mode that ran is recorded on every trial as `verifier_environment_mode` — and it decides [regrade eligibility](#regrade).

### Compute sizing

Tasks declare `cpus`, `memory_mb`, and `storage_mb`, and get exactly that. A provider whose ceiling is below the declaration **refuses the trial** — named in the per-task provider verdicts and in the trial's failure detail — rather than silently provisioning less. Current ceilings:

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
job = await evals.start(
    datasets=[{'name': 'swe-bench-verified', 'version': '1.0'}],
    agents=[{'name': 'codex', 'model_name': 'gpt-5.5'}],
    max_trial_spend_usd=25,
    sandbox_provider='daytona',   # "e2b" (default) | "daytona" | "modal"
)
```

An unknown value is rejected with a `400` at creation — never a silent fallback. Once chosen, the provider is fixed for the job's life; `resume()` inherits it.

Not every task can run everywhere. The catalog tells you **before any money is spent** — every task carries a per-provider verdict:

```python
dataset = await catalog.get('my-swe@1.0')
for task in (dataset.tasks.items if dataset.tasks else []):
    verdict = task.providers['modal']   # TaskProviderVerdict(ok=…, reason=…)
    if not verdict.ok:
        print(task.task_name, 'cannot run on modal:', verdict.reason)
```

Starting a job whose selected tasks include one refused on the chosen provider is rejected with a `400 provider_unsupported` naming the tasks and each task's reason, rather than accepted and billed until it fails.

The verdict is narrower than the full set of things a provider can decline, and knowing where the line falls saves you a confusing trial. Three refusals are decided from the task's stored spec, so they are in `providers` and they are what a job creation checks against:

- **Multi-container tasks run on `e2b` and `daytona`.** Modal cannot run them today — the task's `providers['modal']` verdict names the reason, and the task stays runnable on the other two.
- **Multi-container + `no-network` is declined on every provider** for now. Run those tasks with an `allowlist` or `public` network policy.
- **Sizing above a provider's ceiling** refuses on that provider only — see [Compute sizing](#compute-sizing).

The rest are decided when the sandbox is actually created, so they surface as a trial that ends `INFRASTRUCTURE_ERROR` with the reason in its failure detail rather than as a `400` at creation. There are two, and both are Daytona-and-Modal specifics you can check yourself before choosing a provider:

- **Daytona serves IP-based allowlists only.** Its network filter takes IPv4 addresses and CIDRs, capped at 10 entries — a cap that also has to fit the address the agent uses to reach its model, so a task's own list gets slightly fewer. A task whose `allowlist` names a hostname, or needs more than the cap, fails on Daytona when its sandbox is created. Run it on e2b or Modal, which serve hostname allowlists. Daytona serves `no-network` and `public` normally.
- **Modal caps every sandbox at 24 hours.** A task whose timeout exceeds the cap fails fast when its sandbox is created — never truncated mid-run.

---

## Bring your own dataset

Any corpus in the task layout runs on the hosted stack: point at it, publish it, let the activation gate certify it, run it. A corpus in another format gets converted *into* the layout first — it is small, and a complete task fits on one screen (below).

What you publish is **private to your account**. It never appears in anyone else's catalog, and another account asking for its name reads a plain `404 dataset_not_found` — existence is never leaked. Your own `catalog.list()` shows the shared platform datasets plus your own. A name belongs to its first publisher: re-publishing a name you own extends that dataset with a new version, while publishing a name owned by anyone else — a platform dataset or another account's private one — is refused with a `409 dataset_name_taken`.

### Publishing

Publish from a git repository pinned to a ref, or upload a local corpus directory — the same corpus, the same pipeline, the same rules either way:

```python
# From a git repository, pinned to a ref
publish_job = await catalog.publish(
    git_url='https://github.com/acme/my-swe.git',
    git_ref='v1.0.0',             # a branch, tag, or commit — always pinned
    name='my-swe',
    version='1.0',                # the version label for the published corpus
)

# From a local directory — tarred + gzipped deterministically on the client and uploaded
local_publish = await catalog.publish(
    directory='./my-swe',
    name='my-swe',
    version='1.0',
)

# Everything in the directory is packed, dotfiles included ('.gitignore',
# '.dockerignore', '.env.example', '.config/'), and an executable script stays
# executable. Only '.git', '.DS_Store' and '.venv' are left out, and symlinks
# are never packed. The same directory always produces the same bytes, so the
# tarball's sha256 — the version's source identity on the server — is
# reproducible.

# Block until COMPLETED or FAILED
done = await catalog.watch_import(
    publish_job.id,
    on_status=lambda imp: print(imp.status, imp.task_count),
    poll_interval_s=2.0,          # (optional) default 2s
)

if done.status == 'FAILED':
    # `failure`, not `error` — `error` is the key the failure envelope uses, so
    # "error means this request failed" stays true on a healthy read of a failed import.
    print(done.failure.code, done.failure.message)   # "2/113 task(s) failed to parse"
    for failed in (done.failure.failures or []):
        print(failed.task_name, failed.error)

# Lost the id? List your imports — await one page, or walk them all.
async for imp in catalog.list_imports(status='FAILED'):
    print(imp.id, imp.name, imp.version, imp.failure.message if imp.failure else None)

# Narrow to one dataset's publish history, newest first
history = await catalog.list_imports(dataset='my-swe', limit=20)
```

`get_import(id)` is the single read behind all of this — status, `task_count`, `failure` once there is one, and `warnings`. `watch_import()` is a poll loop over it, so reach for `get_import()` when you drive your own scheduler. A terminal import stays readable, id included, for as long as its dataset exists — deleting the dataset takes its import records with it, and a later `get_import` answers the same not-found as an id that never existed.

`warnings` is worth reading even on success: an import whose warnings include `no_solutions_archived` produced a version that can never be activated through this API (`version_not_activatable`) — an import that will never become runnable must not look identical to one that will.

```bash
npx evolve-evals dataset publish \
    --git https://github.com/acme/my-swe.git --ref v1.0.0 \
    --name my-swe --version 1.0 --watch
npx evolve-evals dataset publish --dir ./my-swe --name my-swe --version 1.0 --watch
```

Every lane resolves to the same thing — a task-layout directory — and is held to the same rules. The corpus root is a directory whose `tasks/` subdirectory holds one directory per task, or the tasks directory itself. Provenance is recorded per lane: the resolved commit for a git publish, the sha256 of the exact uploaded bytes for a directory. On the wire a publish is `multipart/form-data` — the SDK produces it for you — and uploads past the compressed-size cap are refused with a `413 import_too_large`. The metadata parts come first, so a name owned by someone else is refused with the `409` before the upload is received rather than after. A git source must be an `https://` url: the import runs on a worker with no ssh client, so `ssh://` and `git@` remotes are refused at validation rather than failing inside the job — for a private repository, put a token in the https url.

What happens next:

- **All-or-nothing parse.** Every task is parsed before anything lands; one bad task fails the whole publish, with each failure named in `failure.failures`. No partial corpus ever exists.
- **Strict by design.** Every task-config field is either honored or the publish is refused with the field and reason named — a task never silently runs on weaker semantics than it declares. Notably not yet supported: multi-step tasks and GPU tasks.
- **Environments are prepared at import.** Dockerfile-defined environments are built once; multi-container service images are resolved and pinned so runs are reproducible.
- **The activation gate certifies every task** before the version goes live:
  - **gold** — the task's reference solution (`solution/`) is pushed through the real agent-side + verifier path and must score exactly `1.0`. Proof the task is solvable as written.
  - **no-op** — an empty submission goes straight to the verifier and must *not* score `1.0`. A task a do-nothing agent passes measures nothing.

`COMPLETED` is the import's terminal success: the corpus landed as a dataset version, visible in the catalog (`catalog.get('my-swe@1.0')`) in state `VALIDATING`. The gate then runs, and a version that passes it in full reaches `READY` — the one state that accepts jobs — and becomes the dataset's active version in the same step. A publish is therefore finished when its gate passes: nothing else to call, and `{'name': 'my-swe'}` in a job already resolves to what you just published. A version that fails its gate changes nothing — the dataset keeps serving whatever it served before. `evals.start()` against any other state is rejected with a `409 version_not_ready` naming it.

### Activating

What you publish is activated for you, so the reason to call this yourself is to point a dataset's bare name at a **different** version — back to an older one, or on to a version you published but did not keep as the default. It is one call, on a version you own:

```python
await catalog.activate('my-swe', '1.0')
```

```bash
npx evolve-evals dataset activate my-swe 1.0
```

From then on `{'name': 'my-swe'}` in a job resolves to that version, and asking for the version that is already active succeeds without changing anything. Activating is refused with `version_not_ready` while the import and gate still run, and with `version_not_activatable` for a version that can never activate (no reference solutions were archived — the import's `warnings` told you at publish time).

### Getting your corpus back

The platform keeps the exact package a version was published from, and its owner can download it:

```python
data = await catalog.download('my-swe@1.0')            # bytes
path = await catalog.download('my-swe@1.0', to='.')    # saved file path
```

```bash
npx evolve-evals dataset download my-swe@1.0 -o corpora/
```

Reach for `to=` on anything sizeable: the default shape buffers the whole package in memory, and a corpus can be hundreds of megabytes. The ref is `"name"` (the active version's package) or `"name@version"`. You get back the gzipped tarball you uploaded, or, for a git publish, the checked-out tree packed at import time. Either way it is the whole corpus directory: the task config, `instruction.md`, `tests/`, `environment/`, and your `solution/`.

**This is the one call that returns task files, and it returns them only to you.** Ownership is a single equality — the dataset's owner is the caller — with no admin path and no exception for platform-curated datasets, which have no owner and so cannot be downloaded by anyone. Somebody else's dataset answers not-found, the same answer a made-up name gets, because a `403` that only appears for real names is a way to discover which names are real.

The server re-hashes the stored bytes and compares them against the digest recorded at import before it sends anything, and echoes the verified value in a digest header. The SDK then re-checks that header against the bytes it actually received and raises `EvolveDigestMismatchError` if they disagree — so the chain is closed at both ends, storage and wire. The to-disk shape hashes while streaming and deletes the file rather than leaving one that looks like your corpus and is not. There is no unverified stream shape in Python — the same ruling as [Download the archive](#download-the-archive).

Two edge cases are named codes, not mysteries: a version published before packages were retained answers `package_not_retained`, and a version whose stored object has since gone answers `410 package_missing` — both terminal, both fixed only by re-publishing. This is also the only way to recover the task config file: the importer parses it into environment specs and keeps a digest, so it exists nowhere else on the server.

### Deleting one

A dataset name is a global resource, and a typo used to squat one permanently. `delete()` takes it back:

```python
await catalog.delete('my-sew')   # 204, and the archived solutions go with it
```

The rules are worth knowing before you reach for it:

- **You must own it.** A platform-curated dataset is refused with `dataset_not_owned`; a name you cannot see reads as a plain not-found, exactly like a name that does not exist, so the route cannot be used to discover what other accounts have.
- **A referenced dataset is never deleted.** If any job ran against it, you get `409 dataset_in_use`, and `details` names the blocking job ids. There is no cascade and no force: a job's meaning is "this agent scored 0.42 on *these* tasks", and deleting the tasks would leave a number that refers to nothing. Delete the jobs first if you mean it.
- **Versions, tasks, and the private solutions archive go with it.** Mirrored task images do not — they are content-addressed and shared with any other dataset pinning the same image.

### When upstream moves

A dataset published from git records what it was built from, and the platform periodically re-resolves where that ref points now. The answer rides on the dataset:

```python
dataset = await catalog.get('my-swe')

if dataset.upstream and dataset.upstream.moved:
    print(f'{dataset.upstream.ref} has moved past {dataset.upstream.current_commit}')
```

`upstream` carries the ref, the commit the active version was built from, where the ref points now (`latest_commit`, `None` when the last check failed), `moved` (the field a badge branches on), `checked_at`, `error` (why the last check failed — show "could not check", never "up to date"), and `auto_import`. It is `None`, not "up to date", when there is nothing to watch — an uploaded corpus, one imported at an exact commit sha (a pinned commit cannot move), or one published before provenance was recorded. A failed check keeps the last known answer and sets `error`: a network blip should not quietly erase an update that is genuinely available.

By default, watching produces a fact, never an action — a new version is always an immutable row **you** create with `publish()`. The one exception is opt-in:

```python
await catalog.update('my-swe', upstream_auto_import=True)
```

With `auto_import` on, a moved ref imports a new version automatically. It is refused (`upstream_not_watchable`) on a dataset with no moving git ref to follow, and `dataset_not_owned` on a platform dataset. The CLI prints one quiet line under `dataset list` and `dataset show` for each dataset whose ref has moved, and nothing at all when nothing moved; the notice never appears in `--json` output — the same fact is on the `upstream` field there.

### Not in the task layout yet

Convert it. A corpus is a directory tree with one directory per task under `tasks/`; the directory name is the task name. A minimal complete task:

```
my-swe/
└── tasks/
    └── greeting-fix/
        ├── task.toml
        ├── instruction.md
        ├── pre_artifacts.sh        # optional — collects the agent's work after the run
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

`pre_artifacts.sh` — optional, and runs in the agent sandbox after the agent finishes; captures the work as a patch:

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

- `task.toml`, `instruction.md`, and `tests/test.sh` are required — a task without `tests/test.sh` fails its import by name. `pre_artifacts.sh` is optional: write one when you want to decide exactly what the agent's work looks like on its way out of the sandbox (the one above turns it into a patch), and when it is absent the platform supplies a minimal collect step and the `artifacts` manifest carries the work instead. `tests/grader.py`, `tests/config.json`, and `tests/test.patch` have named roles, and any other file under `tests/` is carried onto the verifier beside them — a helper like `tests/test_pool.py` lands next to `test.sh` and is runnable from it.
- `tests/Dockerfile` is built for real whenever the verifier can own its own image: a `separate` verifier on a task that builds from `environment/Dockerfile` — no pinned `docker_image`, no compose — gets a verifier image built from `tests/`, so grader dependencies installed there are genuinely present. Everywhere else the verifier reuses the task image and the test files are uploaded onto it. The Dockerfile is not built on that path, so it is accepted only while it stays trivial (`FROM`, `COPY`, `WORKDIR`, `LABEL`, and permission-only `RUN chmod` lines) — a richer recipe's dependencies would be silently missing, so it is refused by name.
- The environment is `environment/Dockerfile` (built at import), a pinned `docker_image` (the registry must be approved for imports, and the tag pinned — never `:latest`), or `environment/docker-compose.yaml` for multi-container tasks (the agent runs in the `main` service).
- Timeouts are optional: agent defaults to 3600 s, verifier to 600 s, both published as `limits['job']['default_agent_timeout_sec']` and `default_verifier_timeout_sec`. A declared `timeout_sec` always wins — the corpus is the authority on how long its own task needs, and the fallback never shortens one.
- `solution/` (`solve.sh`, or a `solution.patch` to apply) is what the gate certifies with — without it the version cannot reach `READY`.

Then publish and run it — exactly the [flow above](#publishing).

---

## Bring your own agent

The built-in agents are not the boundary. Register your own CLI once, and its name becomes usable in job `agents[].name` exactly like a built-in:

```python
mine = agents()

await mine.create(
    name='acme-cli',                                                # the name you will pass in arms
    install_script='curl -fsSL https://acme.dev/install.sh | sh',   # the script itself, not a path
    run_command='acme-cli --headless',
    env={'ACME_PROFILE': 'bench'},                                  # (optional) injected at run time
)

job = await evals.start(
    datasets=[{'name': 'deep-swe'}],
    agents=[{'name': 'acme-cli', 'model_name': 'gpt-5.5'}],
    max_trial_spend_usd=25,
)
```

An agent that is not a one-line install ships as a directory instead — tarred deterministically on the client and uploaded:

```python
await mine.create(
    name='acme-cli',
    directory='./agents/acme-cli',   # EITHER directory OR install_script, never both
    run_command='acme-cli --headless',
)
```

Read, replace, and remove them the same way:

```python
registered = await mine.list()         # one page of your agents
async for a in mine.list():            # or walk them all
    ...
one = await mine.get('acme-cli')       # name, source, run_command, env, timestamps
await mine.delete('acme-cli')          # past jobs keep the agent they recorded

# Change one WITHOUT a window where it stops existing:
await mine.upsert(
    'acme-cli',
    run_command='acme-cli --headless --v2',
    install_script='curl -fsSL https://acme.dev/install.sh | sh',
)
```

Both upload lanes — an agent and a dataset corpus — send `multipart/form-data`: the metadata travels as named parts and the bytes as a `file` part. The SDK builds that for you, and it is why nothing sensitive rides a URL: a run command and a set of environment values in a query string end up in every access log and proxy buffer between you and the server.

```bash
npx evolve-evals agent add acme-cli \
    --install-script ./install.sh \
    --run "acme-cli --headless" \
    --agent-env ACME_PROFILE=bench
npx evolve-evals agent list
npx evolve-evals agent show acme-cli
npx evolve-evals agent remove acme-cli
```

The CLI's `--install-script` names a **file**; its contents are what gets uploaded. `--dir` is the directory lane, and `--agent-env KEY=VALUE` repeats once per variable.

Registered agents are private to their owner. Another account's name reads as `agent_not_found`, never as a permission error — existence is never leaked.

### The run contract

Everything a registered agent can rely on, and nothing else. Your `run_command` runs headless with `sh -c` at the task's working directory, and:

- **The task instruction arrives twice, so read it whichever way your CLI prefers.** It is written to the command's **stdin**, and it is also on disk at the path in `$EVOLVE_INSTRUCTION_FILE`.
- **The model is reached through a gateway, not a provider.** `$EVOLVE_GATEWAY_BASE_URL` is an OpenAI-compatible base URL that **already ends in `/v1`** — never append it yourself — and `$EVOLVE_GATEWAY_API_KEY` is the credential for it. The same two values are also exported as `$OPENAI_BASE_URL` and `$OPENAI_API_KEY`, so a CLI that **reads its endpoint from the environment** works unchanged. A CLI that routes through a **config file** does not — see below.
- **`$EVOLVE_MODEL` names the model being evaluated** — the `model_name` of the arm this trial belongs to.
- **Your declared `env` is injected at run time only**, and it may **not** override those contract keys. An attempt to is rejected at registration with `agent_invalid_env`, not silently dropped at run time. The six contract keys are `EVOLVE_GATEWAY_BASE_URL`, `EVOLVE_GATEWAY_API_KEY`, `EVOLVE_MODEL`, `EVOLVE_INSTRUCTION_FILE`, `OPENAI_BASE_URL` and `OPENAI_API_KEY`.

#### If your CLI routes through a config file

Env-only routing covers CLIs that read `OPENAI_BASE_URL`. Plenty do not: they want a config file, and they read it from a path in `$HOME`. Three of our own seven built-ins are in that group, so this is the common case and not an edge one.

Write that file **inside your `run_command`**, from the contract values. It cannot be written at install time: the install ran in a different sandbox entirely, and by the time your agent runs the box has no network to fetch anything with. `codex` is the worked example — this is what the platform itself does for the built-in:

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
- A registered agent is **versioned by its registered content** — the install source, the `run_command` and the declared `env`, together — so a `version` pin on an arm using it is rejected. Change any of the three and you get a new recorded version and a new bundle digest.
- **`upsert()` is how you change one.** `delete()` then `create()` leaves a window where the agent does not exist, and anything naming it in that window — a scripted job, a colleague's run — fails with "no such agent" for a change that was only ever meant to be an edit. `upsert()` is one call: the name holds the old registration or the new one, never nothing. It creates when the name is free and replaces when it is not, and replacing consumes no new registration slot, so you can still fix a broken run command at the ceiling. It is a full REPLACEMENT, not a patch: every field comes from the call, so an omitted `env` becomes empty and the source switches wholesale.
- **The registration ceiling is published** as `agent_registration['max_per_user']` in the capability document. Past it, registration is refused with `agent_limit_reached`; delete one to make room.

**What keeps a trial inside its budget — and when it does not.** The spend cap is enforced on the gateway key, so model traffic through `$EVOLVE_GATEWAY_BASE_URL` is metered and capped. What confines traffic to that route is the **task's network policy**, not the agent. Under `no-network` the box reaches the gateway and nothing else, and the cap is a hard guarantee. Under `allowlist` or `public` an agent *can* reach a provider directly with a key of its own, and that traffic is neither metered nor capped.

Read that second sentence with [Network modes](#network-modes) in hand, because `public` is what a task gets when it declares no policy at all. If you care about the cap being airtight, run against tasks that declare `network_mode = "no-network"` — do not assume it. Registration refuses credential-shaped `env` keys, but that is a guardrail against the obvious mistake, not a boundary.

What you give up versus a built-in:

- **No live trace events.** There is no output parser for an unknown CLI, so the parsed trace stays empty for these trials.
- **No live spend or token reading.** `live_spent_usd` stays `None` and no `trial.spend` event fires; the trial goes straight to a settled cost.
- **No `reasoning_effort`.** An effort set on the arm is recorded but never reaches your command — the run contract's six keys are the whole environment. Put the flag in the `run_command`.

Everything else is identical: the patch is collected, the verifier scores it, and artifacts, timing pairs, token counts, settled spend and status are recorded exactly as for a built-in.

---

## Statuses

**Job** (`Job.status`):

| Status | Meaning |
|--------|---------|
| `QUEUED` | Accepted, waiting for dispatch |
| `RUNNING` | Trials are executing |
| `CANCELLING` | `cancel()` requested; in-flight trials are winding down |
| `COMPLETED` | Terminal — all trials settled |
| `CANCELLED` | Terminal — cancelled before completion |
| `FAILED` | Terminal, and **reserved** — see below |

`FAILED` is in the vocabulary and declared terminal, but nothing on the server sets it and nothing emits a `job.failed` event. A job that goes wrong does so one trial at a time: the trials land in `INFRASTRUCTURE_ERROR` or `SCORING_ERROR` and the job still reaches `COMPLETED`. So `job.failure` is `None` on every job you will read today. Handle `FAILED` if you are switching exhaustively over the enum — the capability document lists it and it may become reachable — but do not build a failure banner and expect to see it fire; the histogram in `job.trials.by_status` is where a job's trouble actually shows.

**Trial** (`Trial.status`) — a valid reward, including 0, is `SCORED`; a failure is never reported as a fabricated zero:

| Status | Meaning |
|--------|---------|
| `QUEUED` | Waiting for a sandbox slot |
| `RUNNING` | Agent phase in progress — `attempt_phase` says which step |
| `SCORING` | Agent finished; verifier running |
| `SCORED` | Valid reward recorded in `reward` |
| `SCORING_ERROR` | Verifier crashed or returned an out-of-domain reward — read `exception_info` |
| `INFRASTRUCTURE_ERROR` | Trial lost before a result was recorded — read `exception_info`, then `resume()` |
| `INDETERMINATE` | The platform cannot tell whether the trial completed |
| `CANCELLED` | Cancelled before settling |

`SCORING_ERROR` and `INDETERMINATE` are the two statuses a task author has to act on, so both say what went wrong: `exception_info.exception_type` carries the stable failure name and `exception_message` a sentence plus the last few kilobytes of the verifier's own output — the tail, because a grader prints its progress first and its traceback last. The box those bytes came from is destroyed seconds later, so this is the only record of them.

**Import** (`DatasetImport.status`) — the SAME four words a job uses, because an import is a job:

| Status | Meaning |
|--------|---------|
| `QUEUED` | Accepted; the corpus row exists and nothing has started |
| `RUNNING` | Cloning or extracting, then parsing and building the environment |
| `COMPLETED` | Terminal — the corpus landed as a dataset version |
| `FAILED` | Terminal — read `failure` |

A terminal import stays readable. A successful import used to start answering `404` the moment its version was superseded, telling a watcher holding a week-old id that the import never happened — it `COMPLETED`, and the catalog moving on afterwards does not unmake that.

**Dataset version** (`DatasetVersion.state`) — the catalog's lifecycle, distinct from the import's statuses above:

```
DRAFT → IMPORTING → BUILDING → VALIDATING → READY
```

with `FAILED` and `ARCHIVED` as off-ramps: a failed parse or environment build lands `FAILED` before `VALIDATING` is ever reached, and `ARCHIVED` shelves a version that has been moved past. An import lands a version at `VALIDATING`; the activation gate (gold + no-op, above) then certifies it and promotes what it certifies — a version that passes reaches `READY`, the only state that accepts jobs, and becomes the one bare names resolve to, with nothing left to call. [`activate()`](#activating) is how you later point that name at a different `READY` version. The one exception is a platform-curated dataset, which has no owner: its versions are certified the same way but sit at `VALIDATING` with a passing gate until an operator promotes them, since its default is not any account's to move.

All four vocabularies, with their terminal members marked, are published under `statuses` in the [capability document](#what-the-platform-supports) — render from there, not from these tables.

---

## Types

These are the shapes the surface actually returns, all importable from `evolve`. Results are dataclasses with the wire's own `snake_case` field names; the closed vocabularies are `Literal` types — `JobStatus`, `TrialStatus`, `EvalSandboxProvider`, `SpendSource`, `VerifierEnvironmentMode`, `AttemptPhase`, `HostedErrorCode` — held to the same contract the server is, so a type-checker catches a typo'd status the way the TypeScript compiler does.

```python
JobStatus = Literal['QUEUED', 'RUNNING', 'CANCELLING', 'COMPLETED', 'CANCELLED', 'FAILED']
TrialStatus = Literal['QUEUED', 'RUNNING', 'SCORING', 'SCORED',
                      'SCORING_ERROR', 'INFRASTRUCTURE_ERROR', 'INDETERMINATE', 'CANCELLED']
EvalSandboxProvider = Literal['e2b', 'daytona', 'modal']
SpendSource = Literal['measured', 'measured_provisional', 'assumed_cap']
VerifierEnvironmentMode = Literal['shared', 'separate']
AttemptPhase = Literal['prepare', 'build', 'boot', 'install', 'agent', 'verify', 'persist']

@dataclass
class DatasetSelector:              # one dataset a job runs
    name: str                       # bare name = active version
    version: Optional[str]
    task_names: Optional[List[str]]           # include filter — glob patterns
    exclude_task_names: Optional[List[str]]   # exclude filter — glob patterns
    n_tasks: Optional[int]                    # cap AFTER filters

@dataclass
class AgentArm:                     # one agent arm of a job
    name: str                       # built-in or registered
    model_name: str                 # always required; no server default
    version: Optional[str]          # pin; omitted = resolve latest
    reasoning_effort: Optional[str] # PART OF THE ARM'S IDENTITY

# Pages: every collection answers items / next_cursor / has_more; the list
# handles are dual-use (await one page, or async-for every row).

@dataclass
class Job:                          # ONE shape from every call
    id: str
    job_name: str
    status: JobStatus
    datasets: List[DatasetRef]      # resolved (name, version) pairs
    agents: List[AgentArm]          # echoed arms (requested pin; None = took latest)
    n_attempts: int
    n_concurrent_trials: int
    max_trial_spend_usd: float      # the resolved per-trial cap
    worst_case_spend_usd: float     # trials × the cap — stated, never left to you
    sandbox_provider: EvalSandboxProvider
    counts: JobCounts               # agents + tasks — entity cardinality only
    n_total_trials: int
    trials: TrialTally              # total + zeros-included by_status histogram
    stats: Dict[str, Any]           # counters, token totals, measured cost_usd, evals
    failure: Optional[JobFailure]   # never the key `error`
    source_jobs: List[SourceJob]    # provenance of a derived job; empty on originals
    is_regrade: bool
    idempotent_replay: bool
    started_at: str
    updated_at: str
    finished_at: Optional[str]      # None while live

@dataclass
class TimingInfo:                   # a phase wall-clock: a PAIR, never a duration
    started_at: Optional[str]
    finished_at: Optional[str]

@dataclass
class AgentInfo:                    # the agent that ran a trial
    name: str
    version: Optional[str]          # the version actually RESOLVED and used
    model_info: ModelInfo           # name + optional provider
    reasoning_effort: Optional[str]

@dataclass
class AgentResult:                  # what the agent phase produced and consumed
    n_input_tokens: Optional[int]   # includes cache tokens
    n_cache_tokens: Optional[int]
    n_output_tokens: Optional[int]
    cost_usd: Optional[float]       # settled spend; None never means $0
    rollout_details: Optional[List[Dict[str, Any]]]   # reserved; None today
    metadata: Optional[Dict[str, Any]]   # bundle digest, network mode + source, …

@dataclass
class ExceptionInfo:                # why a trial failed, when it did
    exception_type: str             # ScoringError | InfrastructureError | …
    exception_message: str          # truncated to 2000 chars on list rows
    exception_traceback: Optional[str]
    occurred_at: str

@dataclass
class Trial:                        # list rows and detail, one shape
    id: str
    job_id: str                     # the reverse pointer
    task_name: str
    source: str                     # the dataset the task came from
    agent_info: AgentInfo
    attempt: int                    # 1..n_attempts
    status: TrialStatus
    reward: Optional[float]         # primary reward; zero is a reward
    verifier_result: Optional[VerifierResult]     # the named rewards map
    exception_info: Optional[ExceptionInfo]
    agent_result: Optional[AgentResult]
    environment_setup: Optional[TimingInfo]       # the four phase timing pairs
    agent_setup: Optional[TimingInfo]
    agent_execution: Optional[TimingInfo]
    verifier: Optional[TimingInfo]
    step_results: Optional[List[Dict[str, Any]]]  # multi-step placeholder; None today
    spend_source: Optional[SpendSource]
    live_spent_usd: Optional[float]               # mid-run LOWER BOUND; cleared at settle
    live_spend_at: Optional[str]
    max_trial_spend_usd: Optional[float]          # the cap THIS trial's key carried
    sandbox_provider: Optional[EvalSandboxProvider]
    sandbox_id: Optional[str]                     # agent box id; None when none booted
    verifier_sandbox_id: Optional[str]            # None in shared mode or before verify
    verifier_environment_mode: Optional[VerifierEnvironmentMode]
    attempt_phase: Optional[AttemptPhase]         # which step a RUNNING trial is in
    session_ref: Optional[str]
    started_at: Optional[str]
    finished_at: Optional[str]

@dataclass
class StopResponse:                 # trials().stop() — every id in exactly one list
    stopped: List[Trial]            # killed and settled, with their settled rows
    already_terminal: List[str]
    not_found: List[str]            # not real or not yours — never distinguished

@dataclass
class JobTaskRollup:                # jobs().tasks() rows
    task_name: str
    source: str                     # the dataset the task came from
    trials: TrialTally
    mean_reward: Optional[float]    # over SCORED trials; zero is a reward
    cost_usd: Optional[float]

@dataclass
class JobEvent:                     # one watch() event
    seq: int
    type: str                       # "job.created" | "trial.settled" | …
    data: Dict[str, Any]            # the payload, keys in the wire's vocabulary

@dataclass
class Dataset:                      # datasets().list() / get(ref)
    name: str
    title: Optional[str]
    description: Optional[str]
    active_version: Optional[DatasetVersion]   # None = bare-name job refs refuse
    versions: Optional[List[DatasetVersion]]   # get() only, newest first
    selected_version: Optional[DatasetVersion] # get() only — the tasks' provenance
    tasks: Optional[TaskPage]                  # get() only; page with limit/cursor
    upstream: Optional[UpstreamStatus]         # None = nothing to watch, NEVER "up to date"
    created_at: Optional[str]                  # get() only
    updated_at: Optional[str]                  # get() only
    # ActiveDataset (get_active) is the same shape with version + tasks guaranteed

@dataclass
class Task:                         # public fields only
    task_name: str
    agent_timeout_sec: int
    verifier_timeout_sec: int
    providers: Dict[str, TaskProviderVerdict]  # where it can run, per provider

@dataclass
class DatasetImport:
    id: str
    status: str                     # QUEUED | RUNNING | COMPLETED | FAILED — the job vocabulary
    name: str                       # dataset the import creates or extends
    version: str
    failure: Optional[DatasetImportFailure]    # never `error` on a 200 body
    warnings: List[ImportWarning]   # e.g. no_solutions_archived → not activatable
    task_count: Optional[int]
    created_at: Optional[str]
    updated_at: Optional[str]

@dataclass
class Agent:                        # agents().list() / get() / create()
    name: str                       # the value you pass in job arms
    source: str                     # "install_script" | "tarball"
    run_command: str                # run headless with `sh -c` at the task directory
    env: Dict[str, str]             # injected at RUN time; cannot override contract keys
    created_at: str
    updated_at: str

@dataclass
class AuthStatus:                   # auth().status()
    user_id: str
    email: Optional[str]
    key: ApiKey                     # id, label, created_at, last_used_at — never the secret
```

### Error codes

The shape an error arrives in is described once, under [Errors](#errors); this is the vocabulary that fills its `code`. The same list is published as `error_codes` in the [capability document](#what-the-platform-supports), so a client can check its own branches against the server's, and both SDKs hold their unions to the contract's enum byte-exactly in their test suites.

Codes you will actually branch on: `dataset_not_found` (also what another account's private dataset reads as), `dataset_version_not_found`, `dataset_name_taken` (409 — the name belongs to someone else), `import_too_large` (413), `no_active_version`, `version_not_ready`, `version_not_activatable`, `unknown_task_names`, `no_tasks` (the selectors filtered every task away), `provider_unsupported`, `job_not_found`, `job_not_terminal`, `no_failed_trials`, `trial_not_found`, `agent_version_not_found`, `insufficient_credits` (402 — add credits and retry), `job_too_large` (400 — the trial matrix exceeds the published ceiling; the message states the count it would have created), `rate_limited` (retry after `retry_after_sec`), `invalid_api_key`, and `invalid_input` (which is also what the per-arm and per-attempt ceilings refuse with).

[Regrades](#regrade) add `regrade_source_ineligible` (409 — the source trial recorded no verifier inputs; the message names why) and `no_regradable_trials` (409 — a whole-job regrade found nothing eligible). [Stopping](#stopping-work) adds `invalid_ids` (400 — a stop batch that is empty or over the 100-id cap).

[Registered agents](#bring-your-own-agent) add their own: `agent_not_found` (also what another owner's name reads as), `agent_name_taken`, `agent_name_reserved` (the name collides with a built-in), `agent_source_required` (neither an install script nor a tarball), `agent_source_conflict` (both), `agent_invalid_env` (declared env tries to override a run-contract key), `agent_invalid_name`, `agent_too_large`, and `agent_limit_reached` (the per-account ceiling).

[Datasets](#bring-your-own-dataset) add `dataset_not_owned`, `dataset_in_use` (409 — jobs reference it; `details` names a sample), `package_not_retained`, `package_missing` (410), and `upstream_not_watchable` (the auto-import toggle on a dataset with no moving ref).

Three more come from the shapes above: `idempotency_key_reused` (409 — the key already stands for a different request), `invalid_multipart` (400 — an upload that is not `multipart/form-data`, or is malformed), and `invalid_cursor` (400 — a malformed `cursor` on a paged read).
