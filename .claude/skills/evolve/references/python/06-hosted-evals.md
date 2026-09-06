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
    n_concurrent_trials=4,      # (optional) parallel trials, default 4, ceiling 150
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

Every job response is the same shape, whatever produced it. `start()`, `get()`, `cancel()`, `resume()`, `retry()`, `regrade()` and each row of `list()` carry the same fields, so a job card renders from any of them without your knowing which call it came from. `counts` is entity cardinality — the parts a job is made of — and `trials` is the one "how many" structure: a total plus a status histogram that names every status, zeros included, so a status bar never needs the enum hardcoded. `job_name` is a user-facing label — pass one or take the server's.

### Money

`max_trial_spend_usd` caps what a single trial may spend on model calls, and it is the only spend limit the platform enforces: every trial runs on its own freshly minted gateway key, and the cap is that key's budget. Leave it out and the platform applies its published default ($200 per trial). The response always reports the cap that actually applied — `job.max_trial_spend_usd` — so an omitted one is never a mystery.

There is no job-wide budget. A job's real ceiling is its trial count times that cap **times the attempts the retry policy allows**: infrastructure failures re-run automatically ([Automatic retries](#automatic-retries)), and each attempt is minted its own full per-trial cap — a retry is a fresh run, not a discounted one. So the ceiling is `max_trial_spend_usd × trials × (retry['max_retries'] + 1)`, which with the fleet default of 2 retries is three times the single-attempt product. The response states it for you as `job.worst_case_spend_usd`, so the number you approve before a large matrix starts running is the honest one. Your account credit balance is the hard backstop underneath: when the balance runs out, spending stops mid-job whatever the caps say, and starting a job while the balance is already at zero is refused up front with a `402 insufficient_credits`. A trial that exhausts its own cap is not a failure — the agent just runs out of budget, and the trial is still scored on whatever it produced.

Runs on your own provider key are the one exception to the credit ledger. When a [managed BYO provider key](./01-getting-started.md#managed-byo-provider-keys) is enabled for the model's provider, the trial's model calls bill your provider account directly and draw no Evolve credits — the per-trial cap still meters and bounds the trial exactly as before. The exception is about who pays, not about the gate at the door: the zero-balance check runs on every job create and every `resume()`, BYOK included, so keep a non-zero balance even if you run BYOK-only.

### Automatic retries

An infrastructure failure — a sandbox that died mid-run, a worker whose lease expired, a box that never booted — is usually the platform's weather, not a verdict on your task. Trials that settle `INFRASTRUCTURE_ERROR` are therefore put back on the queue automatically, up to `max_retries` times each (fleet default 2, published as `limits['job']['default_max_retries']` in the [capability document](#what-the-platform-supports)). No other status ever re-runs on its own: a scored zero, a `SCORING_ERROR`, an `INDETERMINATE` are verdicts about the run, and they stand.

The policy is Harbor's RetryConfig vocabulary, verbatim, passed as `retry` on `start()` — and the response echoes the **resolved** policy on every job body, so the row always states what it runs under:

```python
job = await evals.start(
    datasets=[{'name': 'deep-swe'}],
    agents=[{'name': 'codex', 'model_name': 'gpt-5.5'}],
    retry={
        'max_retries': 3,            # 0 turns retries off; omitted = fleet default (2)
        'include_exceptions': None,  # None, omitted, or [] = no filter
        'exclude_exceptions': ['AgentAuthenticationError'],  # wins over include
        'wait_multiplier': 2,        # backoff: min_wait_sec × multiplier^attempt, capped at max_wait_sec
        'min_wait_sec': 1,
        'max_wait_sec': 60,
    },
)
print(job.retry)                     # the RESOLVED policy, every field present
```

Both halves are typed. The dict you pass is `JobRetryConfigInput` (every key optional) and the echo on `job.retry` is `JobRetryConfig` (every key required — an older server that sends no policy reads as the retries-off policy with Harbor's defaults, so a key read never crashes on any server). At runtime both stay the plain dicts above; the classes only teach type checkers the keys. One naming note: Harbor and the platform spec call this pair `RetryConfig` / `RetryConfigInput`, but `evolve.RetryConfig` already names the [Swarm retry helper](05-swarm-pipeline.md) — an unrelated client-side shape (`max_attempts`, `backoff_ms`) — so the hosted pair carries the `Job` prefix and the two never shadow each other.

The include/exclude sets refine *within* the infrastructure class by exception name, exclude winning over include — Harbor's rule. A gateway credential refusal adjudicates as `AgentAuthenticationError` and a model that never served as `ModelNotFoundError`; everything else is `InfrastructureError`. Omitting `exclude_exceptions` keeps Harbor's default non-retryable set (auth refusals, timeouts, and the other failures that would re-fail identically). An **explicit** `'exclude_exceptions': None` is different from omitting the key: None turns exclusions off entirely — Harbor's own `None` semantics — so everything the include set admits is retried. `include_exceptions` has no such split: None, omitted, and the empty list `[]` all mean no filter — Harbor's include check treats the empty set exactly like `None`, so an empty list never means "retry nothing".

A retried trial keeps its receipts. `trial.n_retries` counts the requeues, and `trial.retries` lists each retired attempt with its exception, its spend, and its clocks — so a scored trial that took three attempts is auditable without archaeology, and the job's `stats['n_retries']` is the consumed-retry sum across all trials. Each attempt spends against its own full per-trial cap, and every retired attempt's real spend stays in the job total — which is why `worst_case_spend_usd` carries the `(max_retries + 1)` product ([Money](#money)).

The budget can also end early. Two consecutive infrastructure failures with the **same signature** break the circuit: the retry the policy would have scheduled is refused, the trial stays terminal, and whatever remains of `max_retries` goes unspent. A signature is the class of fault, read from the typed failure phase alone and never from message text — `sandbox_death` (the box ceased to exist mid-run), `provider_create_failure` (the box never came up), `stream_disconnect` (the run's event stream ended without the harness ever speaking). The failure's own words stay first on the trial's `exception_info.exception_message` and the verdict — the signature and the count — is appended after them, never in their place; the job stream carries `trial.retry_circuit_broken` with `signature`, `consecutive`, `failure_phase`, `retries_unused` and `exception_message` (the last failure in its own words). The reason is arithmetic: a dead provider-and-region combination answers the same way every time, so it should cost minutes, not a whole retry budget's worth of timeouts. Three guarantees keep it from eating real transients — the **first** failure of any signature always retries, **alternating** signatures never accumulate (the streak resets on any non-matching failure), and the breaker runs strictly after the `max_retries` and include/exclude adjudication, so it can only ever shorten the budget, never extend it.

On the stream, a requeue emits `trial.retrying` right after the `trial.settled` that recorded the failure — a failed `trial.settled` carries `exception_message`, the failure in its own words, beside `exception_type`; a cancel (`CancelledError`) carries the type alone. That means **`trial.settled` is not final** for a trial the policy may still re-run: a watcher that treats it as terminal must check for a following `trial.retrying` on the same trial. From the CLI, `-r/--max-retries` and the repeatable `--retry-include`/`--retry-exclude` set the same fields, merging field-by-field over a `--config` file's `retry` object ([CLI](#cli)).

### Timeout multipliers

Every task declares its own wall-clocks (`agent_timeout_sec`, `verifier_timeout_sec` — or inherits the platform fill-ins). Sometimes one job legitimately needs more room on the same tasks — a slower model, a deliberately thorough effort setting — and editing the corpus for one run would change what every other run means. Harbor's answer is a per-run multiplier, and this platform carries it verbatim: five flat keyword arguments on `start()`, named exactly like Harbor's `--timeout-multiplier` flags.

```python
job = await evals.start(
    datasets=[{'name': 'deep-swe'}],
    agents=[{'name': 'codex', 'model_name': 'gpt-5.5'}],
    timeout_multiplier=2,              # every phase: declared × 2 (default 1.0; < 1 shrinks)
    verifier_timeout_multiplier=3,     # overrides the global for the verifier only
)
print(job.timeout_multiplier)           # 2 — the resolved global
print(job.verifier_timeout_multiplier)  # 3 — this phase overrides it
print(job.agent_timeout_multiplier)     # None — the global applies
```

The semantics are Harbor's exactly. The worker multiplies the **task-declared** timeout at the point each phase timeout is armed: the agent budget (`agent_timeout_sec × multiplier`), the verifier budget in both verifier modes (and the judge credential lifetime sized from it), the harness-install budget (the agent-setup phase), and the image-readiness wait (the environment-build phase — tasks here carry prebuilt images, so that wait is what the build knob stretches). A phase-specific argument overrides the global one for its phase; everything else inherits the global. The task itself is never rewritten — the same task runs unstretched in every other job, and the dataset stays comparable across runs.

Every multiplier must be greater than 0 and at most the published ceiling — `limits['job']['max_timeout_multiplier']` in the [capability document](#what-the-platform-supports) (10 unless the fleet changes it), with the default beside it as `default_timeout_multiplier` (1.0). An absurd value is refused at create with a typed `invalid_input` naming the bound, never silently clamped. The multipliers are part of the request identity (an `Idempotency-Key` replay with a different multiplier is a `409` — the runs would execute under different clocks), and derived jobs (`resume()`, `retry()`) inherit them verbatim. From the CLI the same five knobs are `--timeout-multiplier`, `--agent-timeout-multiplier`, `--verifier-timeout-multiplier`, `--agent-setup-timeout-multiplier` and `--environment-build-timeout-multiplier`, each overriding its field over a `--config` file ([CLI](#cli)).

### Shape and ceilings

A job expands to `tasks × agents × n_attempts` trials, each in its own sandbox. `n_concurrent_trials` is how many run at once. The ceilings — distinct agent arms per job, attempts per task, total trials — all refuse at create rather than partway through, and every one of them is published under `limits['job']` in the [capability document](#what-the-platform-supports) rather than only here, so a form can check a sweep before it POSTs. `sandbox_provider` (optional, default `"daytona"`) picks where the sandboxes run — see [Where it runs](#where-it-runs).

`agent_env` and `verifier_env` inject environment values into every agent or verifier run. They are pass-through slots: the client sends them verbatim and the server owns acceptance — refused where unsupported, never silently dropped. The platform honors exactly two `verifier_env` keys — `REWARDKIT_JUDGE` and `REWARDKIT_MODEL`, rewardkit's per-run judge override ([LLM judges](#llm-judges)); every other key, and all of `agent_env`, is refused at create with a message naming that pair.

`secrets` attaches env secrets to every agent run. References (`{'name': ..., 'label': ..., 'as': ...}`) point at stored secrets — never values on the wire. Secrets live on the platform's Secrets surface under a `(name, label)` identity, so several values of one name can exist side by side (`API_KEY` at `staging` and at `prod`); an omitted `label` takes the `default`-labeled row when one exists, the single row when exactly one exists, and refuses as the typed `secret_ambiguous` (naming the labels) when several match and none is `default` — a job never guesses which secret it runs with. `as` renames the env var inside the sandbox, and names the trial's own credential contract owns (the `EVOLVE_` prefix, every built-in harness's gateway and vendor credential/routing slots — including the whole `KIMI_MODEL_*` family — the model env pins, and the judge-override pair) are refused. Inline entries (`{'name': ..., 'value': ..., 'delivery': ..., 'label': ..., 'as': ...}`) are the same vault through a convenience door: the value is saved as a normal env secret first (`delivery` is required — no silent default; `label` defaults to `default`) and the job then stores only the reference — the stored job never contains a value. A `(name, label)` identity that already exists splits on proof: an inline entry restating the stored row byte-for-byte (same value, same delivery) attaches it exactly like a reference — a retry of the same request converges instead of colliding with its own first attempt — while a different value or delivery refuses as the typed `secret_exists` (attach it by reference or pick a label; inline values never overwrite). Every stored env secret carries a **delivery mode**: `brokered` means the value never enters any sandbox (the managed-agents egress-proxy machinery, for header-based HTTPS APIs), `direct` means the raw value is placed in the sandbox environment (URL-parameter keys, gRPC, websockets). Eval trials deliver exactly the **direct** mode — the value enters the trial env and is scrubbed at the credential seal, before hidden tests enter; host/path/method scoping does not apply to a direct secret in any lane. Attaching a brokered secret refuses at create as the typed `secret_brokered_unsupported` — save the secret as direct or use the managed-agents lane; never a silent downgrade.

### Agent arms

An agent arm is `name` plus `model_name` plus two optional identity fields. `name` is a built-in (`claude`, `codex`, `gemini`, `qwen`, `kimi`, `opencode`, `droid`) or an agent you registered yourself ([Bring your own agent](#bring-your-own-agent)); `model_name` is always required — the server applies no model default. Model names are the SDK's own, harness by harness: the `claude` harness takes the four short aliases from the model table — `haiku`, `opus`, `sonnet`, `fable` — and every other harness takes its canonical names from that same table (`gpt-5.5` for `codex`, `claude-fable-5` for `droid`, the `openrouter/…` ids for `opencode`). The table and the pairing rules live in [Getting Started → Agent Reference](./01-getting-started.md#agent-reference).

Pin an agent version when you need the comparison to hold still across weeks:

```python
agents=[
    {'name': 'codex', 'model_name': 'gpt-5.5', 'version': '0.29.0'},
],
```

Omitting it resolves the agent's latest published version **once, at job creation**, and stamps it on the arm: every trial of the job installs that same version — a vendor release mid-job can never split one job across two agent versions — and the job body echoes the stamped version on `agents[].version`, so what will run is visible from the moment of create. Either way the version that actually ran is recorded on every trial as `agent_info.version`, so a trial is always attributable after the fact. Resolution failures are loud, never a silent fallback: an unresolvable pin is refused at creation (`agent_version_not_found`), a failed latest lookup refuses the creation too (`agent_version_unresolvable`, 502 — retry the create), and a pin on a registered agent is refused as well — registered agents are versioned by their own content, so there is no separate version axis to pin.

`reasoning_effort` is the other identity field, and it belongs to the comparison rather than to the run. The accepted values are published as `limits['job']['reasoning_efforts']` in the [capability document](#what-the-platform-supports). An omitted effort resolves to the **agent's own default** — not the document's platform-wide `default_reasoning_effort` — and that resolved value is stamped as arm identity: trials echo it on `agent_info.reasoning_effort`, and the job's `evals` keys carry it as the `__effort` segment even though the job never declared one (a claude arm with no effort settles under `…__high`, a kimi arm under `…__max`). Effort changes the score, so a client comparing two jobs must read the stamped value, never assume what an omitted one meant. Effort is part of an arm's identity alongside the agent, the model, and the version pin: the same agent and model at `low` and at `high` are two distinct systems — they de-duplicate separately, they each consume an arm slot, and every trial echoes the effort back on `agent_info.reasoning_effort`. An effort the agent cannot apply is refused at creation with a `400 invalid_input` rather than accepted and quietly dropped — recording `high` against a CLI that never received the flag would put a claim in the record that did not happen. Each capability entry publishes `effort_support`, so a picker can grey the control out instead of discovering the refusal after a POST.

### Skills

An arm can carry skills — folders of instructions the harness discovers natively, the same `SKILL.md` format the SDK's `skills=` option mounts locally. `skills` is a list of reference strings on the arm, and like effort it is **part of the arm's identity**: the same agent and model with different skills are two arms.

```python
agents=[AgentArm(
    name='claude',
    model_name='fable',
    skills=[
        'skills.sh/vercel-labs/agent-skills/frontend-design',  # one named skill from a skills.sh-listed repo
        'anthropics/skills@main',                              # a GitHub repo, pinned to a branch, tag, or commit
        'upload:6f6f1f36-…',                                   # a skill uploaded to the platform
        'name:frontend-design',                                # your skill name — a moving pointer
    ],
)],
```

A skill **name** works like a managed secret's name: it is unique to you and always points at the **latest** upload of that name. Uploading the same name with different content creates a new record and moves the pointer (old records keep their immutable `upload:<id>` handles; finished jobs' `skill_locks` never rewrite). `name:<skill-name>` resolves server-side at job creation to the name's current record and is pinned as that record's `upload:<id>` — an unknown name is the typed `skill_name_not_found`. The CLI manages the catalog too: `evolve skill list | upload <dir> | show <id-or-name:…> | delete <id>`.

Git references are **pinned at job creation** — each one resolved once to its exact commit and stored in pinned spelling — so a moving branch can never make two trials of one job run different skill content. A raw filesystem path is refused by the server (a hosted job cannot read your disk): upload the folder first and reference `upload:<id>`. The `skills()` client does that — `upload(directory)` packs and stores the folder content-addressed under its folder name (re-uploading identical content under the same name answers the existing record), `list()`, `get(id)` (including the SKILL.md text) and `delete(id)` manage the catalog, and a delete is refused with `skill_in_use` while a running job references the upload.

Every run records what actually mounted: once the arm's first trial resolves its skills, the job's arms carry `skill_locks` — one `SkillLock` per skill with its name, pinned source, content digest, and for git-backed skills the repo URL and exact commit. The trial detail page shows the same pins. A skill that cannot be fetched at run time is an infrastructure error on the trial, never a score.

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

One caveat for watchers that key off `trial.settled`: it is not final for a trial the [auto-retry policy](#automatic-retries) may still re-run. When an infrastructure failure is retried, a `trial.retrying` event follows the `trial.settled` that recorded it, and the trial runs again — treat a settle as that trial's last word only when no `trial.retrying` follows it.

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

### The one-home `usage` reading

The pair above answers the money half; `trial.usage` answers the whole question in one object — spend so far plus the token breakdown, from the same ledger records, with a `provisional` flag saying whether the numbers can still grow:

```python
print(trial.usage)
# UsageReading(provisional=True, spent_usd=3.41, input_tokens=2181733,
#              cached_input_tokens=1965214, output_tokens=8177, as_of='2026-07-31T18:22:05.113Z')
```

While the trial runs the reading is `provisional: true` and ticks as the ledger batches in; at settle the settled figures replace the live ones under the same keys, and `provisional` flips to `false` once the lane is confirmed (`spend_source` `"measured"`). `None` means the meter never answered — never a fabricated zero. The object's keys are identical on the managed-agents session surfaces (`sessions()` `SessionInfo.usage`), so one renderer covers a trial and a session unchanged. The CLI reads it too: `evolve trial show` prints a `tokens` row and the trial list's `SPENT` column states a running trial's floor as `at least $X`.

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

`list(search=...)` is a server-side free-text filter over the job name and its dataset names; `list(scope='shared')` lists your organizations' jobs that teammates created instead of your own (Harbor's `--scope`; the default is `my` — see [`--scope`](#cli)). `stats` is the aggregate block, typed as `JobStats` — a `TypedDict`, so at runtime it is still the plain wire dict, read by key, and the class only teaches type checkers the keys: progress counters (cumulative, Harbor-style: errored trials are a subset of completed, cancelled a subset of errored — the disjoint breakdown is `trials.by_status`), token totals (`n_input_tokens` includes cache tokens; `n_cache_tokens` and `n_output_tokens` beside it), measured `cost_usd` — the whole model bill, with the judge share itemized beside it as `judge_cost_usd` (see [LLM judges](#llm-judges)) — the two honesty counters `n_unmeasured_trials` and `n_unmeasured_judge_trials`, which say how many settled trials that total cannot account for because nobody measured their spend (a plain count, never None; 0 means every settled trial's spend was read, not that the total has stopped moving — a `'measured_provisional'` figure is still a floor), and `evals` — per-(agent, model, dataset) statistics keyed `agent__model__effort__dataset` — the dataset ref is always the LAST `__` segment, which is where Harbor-compatible readers recover it. The effort segment is always there, inserted before the dataset: a declared effort stamps itself, an omitted one stamps the agent's default (`__high`, `__max`, …) — see [Agent arms](#agent-arms). A failed job says why on `failure`, as a `JobFailure(code, message)` — the same grammar an API error uses, under a different key so that "error means this request failed" stays true on a healthy read. In practice you will not see it fire: `FAILED` is a [reserved job status](#statuses) that nothing sets today; read `trials.by_status` for where a job actually went wrong.

### pass@k

When a job runs a task more than once, each evals group also carries `pass_at_k` — how likely it is that *k* attempts contain at least one success. The platform computes it; there is nothing to configure and no code of yours to run.

```python
from evolve import pass_at_k

for group in pass_at_k(detail):
    for point in group.points:
        print(group.evals_key, f"pass@{point.k}", f"{point.value:.3f}")
# codex__gpt-5.5__high__deep-swe@1.1 pass@2 0.833
# codex__gpt-5.5__high__deep-swe@1.1 pass@4 1.000
```

`pass_at_k(job)` reads `job.stats['evals'][key]['pass_at_k']` — on the wire a map of k (as a string, the way JSON keys always are) to a value in `[0, 1]` — and hands it back as sorted numbers. Nothing is requested and nothing is recomputed.

The number is the standard unbiased estimator, `1 - C(n-c, k) / C(n, k)` per task, averaged over the group's tasks. The k values are the powers of two and the multiples of five up to the group's *sparsest* task's attempt count, because every task has to be able to answer every k — so a single-attempt job has no pass@k at all. An attempt that produced no reward, because it errored or was cancelled, counts as a failed attempt; dropping it would quietly inflate every number.

A group answers with an empty map for one of three reasons, and the reader simply leaves that group out:

- its rewards are not binary — pass@k over partial credit would be an invented statistic, so one non-binary or multi-key reward disqualifies the whole group;
- no k is small enough to be eligible;
- attempts are still in flight. The statistic appears once every attempt of the group has settled, so an attempt that has not run yet is never counted as a failure.

The same numbers ride in the job's [download archive](#download-the-archive), inside `result.json`; a live read and the archive of the same job never disagree.

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

Every phase's wall-clock is a **start/stop pair**, never a duration: `environment_setup`, `agent_setup`, `agent_execution`, and `verifier` are each a `TimingInfo(started_at, finished_at)`, either bound `None` while the phase has not reached it. Durations you compute yourself keep their provenance — you always know which clock produced them. `verifier` is the verifier **command** window — the graded command alone, and not the work that prepared it — so read it against `verifier_timeout_sec` and nothing else.

Four finer pairs sit beside the phase pairs and are **not** a partition of them — never sum the two sets. `queue_wait` is the time the trial sat claimable before a worker began it (for a retried trial it restarts at the retry's own backoff deadline, so a failed first attempt is never billed to the second attempt's wait; its open bound is a database clock and its close a worker clock, so a sub-second wait can read marginally negative — published raw rather than laundered). `harness_bundle` brackets fetching the agent's install bundle, and its companion `harness_bundle_cache_hit` tells you what the number means: `True` explains a pair of milliseconds, `False` on a pair of minutes is a real build this trial waited out (a miss that *built* also carries the upload that shares the result with the fleet; a trial that joined another's build, or fetched a ready result from the store, pays neither). `image_prepare` brackets readying the task's machine image on the provider — real work on E2B and Daytona, and **near-zero on Modal by design** (Modal does that work inside sandbox creation instead, where `environment_setup` records it), so never compare this field across providers raw. `shared_verify_setup` is the **shared-mode** verify's preparation — the judge key mint, the rewardkit bundle resolve and upload, the test-file uploads, the env write — and it ends exactly where `verifier` begins, so the two never overlap. It is published because its absence is what misled: that segment used to be reported inside `verifier`, which made a judge task whose setup ran for minutes look like a verifier command ignoring its own timeout. It is `None` on separate-mode trials (no such segment exists), on multi-step trials (which verify per step and report no trial-level verifier window), and on anything that settled before the pair was recorded — never a zero-length pair standing in for work that did not happen. All four are additive: older readers that ignore them lose nothing.

> **Reading spend:** `spend_source` is the lane the figure came from, and only `'measured'` is final. `'measured_provisional'` is a real reading taken inside the gateway's asynchronous spend flush — an honest floor that a deferred pass later confirms or raises into `'measured'`. `'assumed_cap'` means nobody measured this trial's spend; the number it holds is zero — a placeholder, never an observation (the platform under-bills rather than publish an invented figure), and the deferred pass replaces it when a real reading lands. So a read taken shortly after settle can show `'measured_provisional'`, or `'assumed_cap'` with `$0` — treat anything but `'measured'` as not yet final. `agent_result.cost_usd is None` means the trial never ran — a queued or cancelled trial — and is not the same as `0`, which is a real measurement. `trial.max_trial_spend_usd` is the cap *this* trial's key carried, which can differ from the job's current cap on rows settled before a change. A [judge-enabled task](#llm-judges)'s verifier spends on its own key, itemized apart: `judge_result.cost_usd` with its own `judge_spend_source` lane (same three-lane rules), None on every trial where no judge ever ran — and `agent_result.cost_usd` stays the agent's alone, so the trial's whole bill is the sum.

> **Reading failures:** `status` is the primary key for failure classes; `exception_info` is the detail — `exception_type` is one of the platform's stable failure names (`ScoringError`, `InfrastructureError`, `CancelledError`, `IncompleteTrialError`), `exception_message` is truncated to 2000 characters on list rows and full on the detail route, and `exception_traceback` rides along when one was recorded.

`attempt_phase` answers the question `RUNNING` alone cannot: which step the trial is in (`prepare`, `build`, `boot`, `install`, `agent`, `verify`, `persist`), so a polling caller can tell a slow environment build from a slow agent.

A trial the [auto-retry policy](#automatic-retries) re-ran carries its history: `n_retries` counts the requeues, and `retries` lists each retired attempt — `attempt_number`, its `exception_info`, its `cost_usd` (real spend the job total includes), and its clocks. The trial body itself always describes the **final** attempt; the lineage is where the earlier ones live.

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

Beside the parsed trace, every trial archives its raw record, and one vocabulary names the pieces everywhere — API, SDK, CLI, and the dashboard's download menu:

| Name | What it is |
|------|------------|
| `trace-parsed` | The parsed event timeline — what `trace()` / `trace_events()` page |
| `trace-stdout` | The agent process's stdout, byte for byte |
| `trace-stderr` | The agent process's stderr, byte for byte |
| `trace-atif` | The normalized trajectory — an ATIF v1.7 document built from the parsed trace; for an uploaded trial, the archive's own `agent/trajectory.json` served verbatim |
| `trajectory` | Reserved: the harness's own native session file (not served yet — the server answers not-found until its wave lands) |
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

`trace-atif` is the normalized view of the same run: one **ATIF v1.7** document (Harbor's Agent Trajectory Interchange Format — the strict interchange schema its trainer and analysis tooling read), built server-side from the stored parsed trace — for an uploaded trial, the archive's own `agent/trajectory.json` served verbatim, never rebuilt. The instruction opens it as the first `user` step, each agent turn carries its message, reasoning, tool calls and their observed results, and `final_metrics` states the trial's token totals and measured cost. It answers on the same `{log}` envelope as the raw logs — the string is the JSON document — and None keeps the same meaning: nothing was stored (or the id is a regrade result, whose agent half belongs to its immutable source trial). It is the same document the job archive places at Harbor's own path `agent/trajectory.json`; the separate `trajectory` name stays reserved for a different artifact — the harness's own native session file.

The CLI speaks the same words. `evolve trial download <trial-id> --stream <name>` prints one artifact to stdout. Without `--stream` the trial is written out whole under `<dir>/<trial-id>/`, and the layout is **Harbor's trial tree** — Harbor's own names and folders, not the artifact names in the table above:

```
config.json               trial identity: task + agent, in Harbor vocabulary
result.json               status, reward, verifier verdict, exception,
                          agent_result, phase clocks
agent/trajectory.json     the normalized ATIF trajectory
agent/stdout.log          the harness process's raw streams
agent/stderr.log
agent/trace-parsed.jsonl  the parsed event trace — Evolve's own artifact, riding
                          inside agent/ because Harbor has no slot for it, and a
                          Harbor reader ignores it
agent/sessions/...        the agent CLI's home folder in its VISIBLE shape
                          (`codex/...`, never `root/.codex/...`)
verifier/test-stdout.txt  the stored verifier log
verifier/reward.json      the rewards map, when the verifier produced one
exception.txt             when the trial carries an exception
evolve.json               the platform's own record: gateway cost and tokens per
                          lane, provider, `user_id`, regrade lineage
```

An artifact the trial never recorded is an **absent file**, never an empty placeholder — Harbor's own law, so listing the directory is an honest inventory of what the run produced.

The **job archive** writes more per trial than a single-trial download can: `lock.json` (the resolved trial inputs), `trial.log` (the lifecycle summary), `artifacts/` with its `manifest.json`, the raw `verifier/reward.txt` (the exact bytes the grader wrote, when one was captured), and — on multi-step trials — the per-step rewards under `steps/<step_name>/verifier/`. They are built from records outside the trial's own tree — dataset and arm state, server-side capture, and a separate artifact store — so download the job when you need the complete tree.

`result.json` states `agent_result.cost_usd` **only when the gateway measured one** — the same law the job archive follows. A trial whose spend is still a floor, or was never measured at all, states `null` there rather than a figure no meter produced; `evolve.json` carries the raw number next to the `spend_source` lane that qualifies it. Tokens are always stated: they were counted either way.

The CLI states the same thing in one cell, because it has only one. A measured reading prints plainly (`$0.06`), a provisional one prints as the lower bound it is (`at least $0.06`), and a trial nobody measured prints `-`. It applies everywhere a figure appears without its lane: the `spent` and `spent (judge)` rows of `evolve trial show`, and the `SPENT` column of every trial listing.

A freshly settled trial is normally unmeasured for its first few minutes while the gateway's spend log catches up, so `-` there means "not read yet", not "free". A **job** total is different in kind — it is real metered money, but every unmeasured trial folded a zero into the sum, so it prints as `at least $X` whenever the job reports trials its total cannot account for. A plain job figure means "no shortfall we can prove", which is not the same as final.

This tree is assembled on your machine out of the trial's own artifacts, which is why it is not identical to the per-trial directories inside [the job archive](#download-the-archive): the server builds those, so they also carry `lock.json`, `trial.log` and `artifacts/`, and they have no `agent/trace-parsed.jsonl`. `evolve job download` adds an `evolve.json` of its own — one at the job root, one in every trial directory.

The two modes are exclusive, and `--cursor`/`--limit` page only `--stream trace-parsed` — the CLI refuses any other mix as a usage error instead of letting one flag silently win.

This archive belongs to hosted evals: trials are scoring evidence. A managed agent session keeps its parsed transcript download; its raw stream lives in the SDK's local session log and its home folder inside your own sandbox.

---

## Inspect a run without downloading it

A trial's record can be large, and the question you actually have is usually narrow: which events mention this error, what did the verifier print at the end, does any trial in this job hit that stack trace. All three are answered on the server, so nothing has to come down first.

### Filter one trial's trace

`trace()` and `trace_events()` take three filters, and each one composes with the cursor instead of replacing it:

```python
# type — an exact event type, not a pattern
calls = await t.trace(trial_id, type='tool.call')

# grep — case-insensitive POSIX regex over the event's type AND its content
denied = await t.trace(trial_id, grep='permission denied')

# tail — only the last N matching events
ending = await t.trace(trial_id, tail=50)

# and they combine; paging still runs through the filtered set
async for event in t.trace_events(trial_id, grep='Traceback', tail=20):
    print(event.seq, event.type)
```

`grep` is Postgres's own regex engine, so a plain string is a plain substring match, exactly like `grep` itself; an invalid pattern comes back as a typed `invalid_input` refusal naming `grep`, never a `500`. A filter narrows which events exist on the timeline and nothing else: the cursor still means "seq strictly greater than", `next_cursor` still pages through the filtered set, and events always arrive oldest-first. `tail` is a floor on that same timeline rather than a reversed ordering, so `tail` plus paging drains exactly the last N matches, in order. The bounds: `type` at most 100 characters, `grep` at most 512, `tail` between 1 and 10000, and `limit` up to 1000 (default 200).

### Grep every trial of a job

One pattern, one pass over the whole job:

```python
hits = await evals.grep(job.id, 'CUDA out of memory')
for group in hits.items:
    print(group.trial_id, group.task_name, group.match_count)
    for event in group.events:
        print('   ', event.seq, event.type)
```

Matches group per trial: `match_count` is that trial's exact total, never truncated, and `events` carries the first five matching events as a sample. A trial with no match produces no group, so an empty page means the pattern appears nowhere in the job. Groups order by trial id, `next_cursor` is where the next page resumes, and `limit` defaults to 50 with a maximum of 200. `type` narrows the same way it does on a single trial's trace.

The scan is bounded per request rather than per job, so a sparse pattern over a very large job can answer with a short page and `has_more` still true — keep paging. A pattern too expensive to evaluate is refused as a typed `invalid_input` on `q` that says to narrow it: add `type`, anchor the pattern, or grep one trial's own trace. The full match list for any single trial is exactly that follow-up — same pattern, same engine, same answer.

### List and read a trial's stored files

The files a trial left behind can be listed, and read by the byte, so the tail of a 200 MB log costs a range request instead of a download:

```python
listing = await t.files(trial_id)
for file in listing.items:
    print(file.path, file.size_bytes)

whole = await t.file(trial_id, 'agent/stdout.log')                      # bytes
head = await t.file(trial_id, 'agent/stdout.log', start=0, end=65535)
last = await t.file(trial_id, 'agent/stdout.log', suffix=4096)          # last 4 KB
```

The listing pages like every other collection (`limit` default 200, maximum 1000) and orders by path; an empty listing is a normal answer for a trial that stored nothing. A range that selects nothing inside the file is refused, and asking for a whole file above the server's unranged ceiling is refused with both the file's size and that ceiling — in either case the answer is to ask for a range.

Those two are **SDK-only today**: there is no `evolve trial files` and no `evolve trial read`. The trace side does have CLI verbs:

```bash
evolve trial trace <trial-id> --grep 'permission denied' --tail 50
evolve trial trace <trial-id> --type tool.call --limit 500
evolve job grep <id> 'CUDA out of memory'
evolve job grep <id> 'Traceback' --type agent.error --cursor <cursor>
```

`evolve trial trace` drains the filtered trace for you, so its `--limit` is the size of each page it fetches, not a total. `evolve job grep` prints a single page — one line per matching trial, with its sampled events — and names the cursor to resume from when more trials match.

When you do want the bytes on disk after all, [the job archive](#download-the-archive) and `evolve trial download` are still there.

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

`stop()` kills each trial's sandbox and settles the trial with its spend read from the gateway. Every requested id appears in exactly one of the four lists. Ids may mix eval trials and trace analyses — stopping a running [analysis](#analyze) settles it `failed` (failure phase `stopped`) and reports it under `stopped_analyses`, its own list because `stopped` carries Trial rows. Ids belonging to someone else land in `not_found` — existence is never leaked — and already-terminal trials are reported as such and left untouched, so the call is idempotent. One request takes up to 100 ids. A stopped trial rejoins the run by default on [`resume()`](#resume) once its job is terminal.

The CLI adds one convenience on top: `evolve job stop <id> --dataset <name>` stops one dataset's trials and leaves the job — and every other dataset — running. It is pure sugar over surfaces that already exist (the job's `datasets`, the trial list's `dataset` filter, and the stop door), pages its batch under the 100-id cap, and merges the reports into one outcome. Every one of the dataset's trials is named to the door — deliberately not pre-filtered to live ones — so the report stays honest: a dataset whose trials have all settled reports them under `already_terminal`, and an empty report means exactly one thing, a dataset with no trials at all. Naming the whole slice is what that honesty costs: one stop request per 100 trials even when every one of them has already settled, so a big fully-settled dataset sends the requests a live-only pre-filter would have skipped, and a request that fails mid-batch — a 429 on the third of fifty — ends the command there. What it does not do is lose the half that landed: the trials already stopped are dead server-side and this report is the only place their ids exist, so the report prints first, marked partial with the count of trials no answer came back for and that unanswered batch named by trial position (`partial: true` and `unreported` under `--json`), and only then does the rate limit print and the command exit 1. Rerunning the same command finishes the rest and returns the already-dead under `already_terminal`. Stopping a dataset the job never spanned is a refusal, not an empty no-op — silence would read as "nothing was running".

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

## Retry

`retry()` is the manual verb beside resume's automatic one, and the two answer different questions on purpose. Resume answers *"finish what broke"* — it picks up failures and stopped work, and never touches a scored trial. Retry answers *"run THESE again"*: you choose the trials, and a scored trial is a legitimate target — a flaky task, a changed world, one more sample. Like resume, it creates a **new linked job** inheriting the source's config; the source is never mutated, and the new job's `source_jobs` records `action='retry'`:

```python
# The whole job again (source must be terminal)
again = await evals.retry(job.id)
print(again.source_jobs)   # [SourceJob(action='retry', type='hub', job_id=job.id)]

# Only the failed trials (SCORING_ERROR, INFRASTRUCTURE_ERROR, INDETERMINATE)
await evals.retry(job.id, failed_only=True)

# Exactly these trials — all-or-nothing, and the JOB may still be running:
# a settled trial's facts are final, so it can retry the moment it settles
await evals.retry(job.id, trial_ids=[trial_a, trial_b])

# One trial, from the trials client — the same operation, addressed by the
# trial you are holding
one_more = await t.retry(trial_id)
```

The selection is `trial_ids` XOR `failed_only` — both together is a `400` contradiction. In `trial_ids` mode every named trial must be **settled** (`SCORED`, `SCORING_ERROR`, `INFRASTRUCTURE_ERROR`, `INDETERMINATE`, or `CANCELLED`); a still-live id refuses the whole request with `409 trial_not_settled`, and an id that is not this job's refuses it with `404 trial_not_found` — a partial retry that silently dropped half the selection would read as a full one. The whole-job and `failed_only` modes require a terminal source (`409 job_not_terminal` — on a live job the selection would change under the request), and `failed_only` with nothing failed answers `409 no_failed_trials`; stopped (`CANCELLED`) trials are not failures — name them in `trial_ids`, or use `resume()`, which exists for exactly that.

Both doors take an `idempotency_key`. The fingerprint covers the **resolved selection** under this verb's own namespace: two retries of one source selecting different trials are different requests, the trial door and the job door replay each other for the identical one-trial request, and a create or resume key can never replay a retry.

One deviation from Harbor is deliberate and named: Harbor's hosted `trial retry` re-opens the *same* job with fresh pending attempts. Here a finished job is immutable — its numbers are settled and separately citable — so the retry is a new job linked via `source_jobs`, exactly like resume and regrade.

---

## Regrade

A regrade re-runs **only the verifier**. The trial's recorded submission — the patch and artifacts captured when it ran — is restored into a fresh `separate` verifier sandbox — booted under the verifier network policy recorded with those inputs, the same egress the original verifier ran with — and scored again; the agent phase is never re-run, and the source trial is never modified. Use it when a verifier was fixed or tightened and you want the same agent work re-scored under it, without paying for a single new agent run.

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

The verifier always re-runs `separate`, under the verifier [network policy](#network-modes) recorded with the source trial's verifier inputs — a regrade neither widens nor narrows the egress the original verifier ran with, so a trial whose verifier ran sealed is re-scored sealed, and one whose task declared `public` for its verifier is re-scored with open egress. Compare the regrade job's trials against the source job's — same task names, same shapes — to read the deltas.

---

## Analyze

Harbor's `harbor analyze`, hosted: rubric-driven trace analysis of a finished job's trials. For each trial an analyzer agent (claude-code, Harbor's default analyze agent, in its own sealed sandbox) reads the trial's recorded tree — the trajectory, the logs, the original task — and rules every criterion of a rubric `pass`, `fail`, or `not_applicable`, with a written explanation and a 3–5 sentence summary of what happened. Use it to catch reward hacking, to audit whether task instructions were sufficient, or to run any read-the-evidence question over a whole job at once:

```python
# Analyze a terminal job under the defaults
# (deepseek-v4-flash-vision at effort high; rubric: reward_hacking, task_specification)
queued = await evals.analyze(job.id)               # returns at once — THE RESPONSE IS THE JOB
print(queued.stats['analysis'])
# {'n_completed': 0, 'n_failed': 0, 'n_pending': 40, 'cost_usd': None, 'checks': {}}

settled = await evals.watch_analysis(job.id)       # follow the wave to its settled end
print(settled.stats['analysis'])
# {'n_completed': 40, 'n_failed': 0, 'n_pending': 0, 'cost_usd': 0.71,
#  'checks': {'reward_hacking': {'n_pass': 38, 'n_fail': 2, 'n_not_applicable': 0}, …}}

# Each trial carries its own result
async for trial in evals.trials(job.id):
    if not trial.analysis or not trial.analysis['checks']:
        continue
    for name, check in trial.analysis['checks'].items():
        if check['outcome'] == 'fail':
            print(trial.task_name, name, check['explanation'])
```

Analyses are not a separate resource. `analyze()` returns the moment the wave is accepted — the ordinary job body, `stats['analysis']['n_pending']` counting the queued batch — and does not wait; each trial then serves its latest analysis as `trial.analysis` (Harbor's AnalyzeResult verbatim — `summary`, `checks` keyed by criterion, `estimated_cost_usd` — plus provenance: the model and rubric this analysis ran under, its status, its typed failure when it failed), and the job aggregates them as `stats['analysis']`. `watch_analysis()` is the follow, a separate call on purpose (Harbor's hosted launch submits and returns; the wait is its own poll): analyses have no event stream, so it polls the job until nothing is pending — 2 s between reads while the tally moves, backing off to 30 s while it stands still — firing `on_stats` on every tally change (`timeout_s` bounds the whole watch, like `watch_import`).

A custom model or rubric is Harbor's own pair of knobs; the reasoning effort is the platform's own lever beside them:

```python
await evals.analyze(
    job.id,
    model_name='glm-5.3',                    # must be on the claude roster (meta())
    reasoning_effort='low',                  # the arms' effort vocabulary, applied to the analyzer
    rubric={
        'criteria': [{
            'name': 'tool_misuse',             # snake_case; keys the result's checks
            'description': 'Did the agent use its tools destructively?',
            'guidance': 'Read the tool calls. FAIL if any command deleted files outside the workspace.',
        }],
    },
)
```

The rubric is Harbor's `{'criteria': [{'name', 'description', 'guidance'}]}` shape, frozen into the wave at accept: every stored result is validated against exactly that criteria set, and a result missing a criterion (or inventing one) is a stored typed **failure**, never a partial pass. A rubric with unknown keys, empty or duplicate criteria, or out-of-bounds lengths is refused at accept with `400 invalid_rubric` naming the problem; an off-roster model refuses `invalid_input` with the roster in the message. `sandbox_provider` chooses where the analyzer box runs — a provider from the job lineup (`e2b | daytona | modal`, an unknown value refused `invalid_input` naming it); omitted, the platform's analysis default applies (daytona), and either way the resolved `job.analyze['sandbox_provider']` echoes the provider in force.

The prompt is Harbor's third knob — `-p/--prompt <file>`, "Prompt file for the evaluator agent. Uses built-in default if not specified." Its text replaces the built-in analyzer prompt as the instruction the analyzer reads first; pass the file's text as `prompt`:

```python
from pathlib import Path

await evals.analyze(
    job.id,
    prompt=Path('prompt.txt').read_text(),   # the file's text, sent as is
)
```

A prompt file looks like Harbor's own `analyze.txt`. Three tokens are rendered for you — `{trial_path}` (where the trial's tree sits in the analyzer's sandbox), `{task_section}` (the task's paths, or Harbor's sentence for an unavailable task) and `{criteria_guidance}` (one line per rubric criterion). An unknown `{token}` renders empty, `{{` and `}}` write a literal brace, and any other brace text is left as written (Harbor's Python renderer would render it empty, convert it or raise there — `{ x }` empty, `{x!r}` quoted, `{"a": 1}` an error). The output contract (write `analysis.json` matching the rubric's schema) is appended after your text exactly as Harbor appends it, so a custom prompt shapes *how* the analyzer reads the evidence and can never opt out of the deliverable:

```text
Judge only whether the agent gamed its reward. The trial is at {trial_path};
read {trial_path}/agent/trajectory.json step by step before deciding.

{task_section}

Guidance:
{criteria_guidance}
```

The prompt is stored as given and frozen into the wave like the rubric — `trial.analysis['prompt']` serves the text each analysis ran under (`None` = the built-in), and the resolved `job.analyze['prompt']` echoes the policy. An empty prompt, one over 32,000 characters, or one carrying a NUL character is refused at accept with `400 invalid_input` naming `analyze.prompt` and the bound.
`reasoning_effort` is the same effort an agent arm takes on `start()` (`AgentArm.reasoning_effort`), applied to the analyzer — it runs the claude harness, so it accepts exactly what a claude arm accepts (`meta().analyze['reasoning_efforts']`; an unknown value refuses `invalid_input` with the list). Omitted, each model has its own default, published as `meta().analyze['models'][i]['default_reasoning_effort']`: `'high'` on `deepseek-v4-flash-vision`, `'low'` on `glm-5.3-flash` (the platform's ruling for a model whose thinking Z.ai documents as forced, with no levels), and the claude harness default elsewhere. The effort is passed to the analyzer explicitly every time and recorded on the result as `trial.analysis['reasoning_effort']`, so two waves can always be compared on what they were asked for. Harbor's `harbor analyze` has no effort option — this is the platform's existing run-time vocabulary applied to one more agent run it hosts.

Analysis can also run **embedded**: create the job with `analyze` and each trial is analyzed automatically the moment it settles, so a long sweep finishes with its analyses already in place. Presence of the argument is the switch — `{}` means "analyze with all defaults" — and the job body echoes the resolved policy as `job.analyze`:

```python
sweep = await evals.start(
    datasets=[{'name': 'deep-swe'}],
    agents=[AgentArm(name='codex', model_name='gpt-5.5')],
    analyze={},                         # every settling trial is analyzed, defaults
)
print(sweep.analyze)                    # {'model_name': 'deepseek-v4-flash-vision', 'rubric': {…}, 'prompt': None, 'reasoning_effort': 'high', 'sandbox_provider': 'daytona'}
```

Calling `analyze()` again — a different rubric, a different model — is the **re-analysis** path: a fresh wave runs once the previous one has settled (one wave at a time; `409 analysis_already_running` meanwhile), and each trial then serves its newest analysis, earlier ones staying stored as the audit record. The whole-job preconditions are typed too: `409 job_not_terminal` on a live job, `409 no_analyzable_trials` when every trial is `CANCELLED` — cancelled trials are never analyzed, embedded or manual.

Money stays separate by law: the analyzer runs on its own capped gateway key, and its spend is its own metered line — `trial.analysis['estimated_cost_usd']` per trial, `stats['analysis']['cost_usd']` for the job — never blended into `agent_result.cost_usd` or `stats['cost_usd']`. Failures are stored typed (`analysis['failure'] = {'phase', 'message'}` — a validation failure preserves every validator reason; an infrastructure failure names its stage), and a worker death mid-analysis is reaped to `failed`, never left `running` forever.

Two deviations from Harbor are deliberate and named. Harbor's `harbor analyze` is a client-side command over a local job directory; here the analysis runs **server-side** and lands on the trial body instead of a local `analysis.json` — same rubric grammar, same result shape, no download required. And the embedded `analyze` trigger has no Harbor equivalent — their analyze is always a manual follow-up; `analyze()` is that manual verb, the create-time switch is the extension.

### Reading one analysis run

An analysis is itself an agent run — the analyzer boots in its own sandbox, reads the trial's tree, and leaves its own record: a transcript, raw stdout/stderr, a session home, and the verdict document. That record is readable by analysis id (the id is on `trial.analysis['id']`, and `evolve trial show` prints it on the `analysis` row) — **the per-run reads through the TypeScript SDK's `analyses()` client and the CLI today; the Python `analyses()` client speaks the contract's one analyses door, the list**. The CLI covers the per-run reads without any Python code:

```bash
evolve analysis show <analysis-id>                       # the verdict document, human-rendered (--json = the wire object)
evolve analysis trace <analysis-id> --since 200          # the analyzer's transcript; --since resumes
evolve analysis download <analysis-id> -o analyses/      # the whole run: analysis.json + agent/ streams + evolve.json
evolve analysis download <analysis-id> --stream trace-stdout   # or: analysis | trace-parsed | trace-stderr | agent-home
```

`show` serves the verdict for **every** analysis — a `failed` one carries its typed failure where `trial.analysis` on the trial body only ever shows the latest wave; earlier analyses stay readable here by their own ids. `trace` answers everything after `--since` in one read (there is no server-side paging); an id that names a trial or a regrade refuses with the species named rather than answering with the wrong run's events. The stream selectors speak the trial surface's null grammar — an unstored artifact is stated as absent, never printed empty — and refuse a trial or regrade id the same way, never answering with the wrong run's bytes; an analysis run stores no verifier log and no ATIF trajectory, so those selectors are refused typed rather than answered null.

One boundary is deliberate and recorded: these per-run reads ride the dashboard's traces feed, which is not part of the OpenAPI contract (the feed is the trace viewer's own plane; the contract-side verdict remains `trial.analysis`). The **list** is on the contract: `analyses().list()` (`GET /api/analyses`) is the catalog of every analysis you may read, newest first and cursor-paged, each row the same `TrialAnalysis` dict carrying `trial_id`, `job_id`, and `task_name` — the run it judged — so a headless round is list, then read each. `job=` narrows to one job's trials, `status=` to the analysis's own lowercase ladder, and `scope='shared'` lists analyses of your organizations' jobs that teammates created (see [`--scope`](#cli) below); both SDKs speak it. Every row listed under either scope resolves on every read: a teammate's analysis opens on `evolve analysis show`, `trace` and `download` exactly as your own does, because the per-run doors open to the job's creator and to every member of its organization — the law `job show` and `trial show` already follow. An id you may not read answers exactly as one that does not exist: the typed `trial_not_found` (a 404) every trial door speaks, never a hint that the run is someone else's.

```python
from evolve import analyses

async with analyses() as a:
    async for analysis in a.list(job=job.id, status=['failed']):
        print(analysis['task_name'], analysis['failure'])
```

Saved whole, the run lands as `analysis.json` at the root (Harbor's name for the per-trial analysis artifact — their analyzer writes it into the analyzed trial's directory; here the tree IS the analysis run), the analyzer's streams and visible session home under `agent/`, and `evolve.json` carrying what Harbor's shape has no slot for: the analyzed trial/job/task, the analyzer's own sandbox, and its metered spend and tokens. Absent artifacts are absent files.

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

The archive unpacks to Harbor's job layout — at the job level `config.json`, `lock.json` (the resolved job inputs, per-trial locks included), `result.json` and `job.log` (a deterministic lifecycle summary; Harbor's own tooling detects a job directory by this file), plus one directory per trial holding its `config.json`, `lock.json` (the resolved trial inputs — task ref and digest, agent, environment, verifier), `result.json` (a multi-step trial's carries `step_results`, Harbor's StepResult shape), `trial.log` (the trial's own lifecycle summary — status, phases, exception, rewards), the normalized ATIF trajectory at `agent/trajectory.json`, the raw streams at `agent/stdout.log` / `agent/stderr.log`, the agent CLI's home folder (the `agent-home` artifact) under `agent/sessions/` — the same slot Harbor's own agents keep session state in — the verifier's console at `verifier/test-stdout.txt`, its rewards at `verifier/reward.json` (rebuilt from the stored numbers, canonical JSON) with the RAW `verifier/reward.txt` beside it — the exact bytes the grader wrote, present only when one was captured, never a rebuilt stand-in — per-step rewards at `steps/<step_name>/verifier/reward.json` on multi-step trials only, `exception.txt` when the trial carries one, and the collected artifacts under `artifacts/`, each mirrored at its absolute source path minus the root anchor exactly as Harbor lays them out (the agent's patch plus the task's manifest entries; separate-mode trials only — shared mode collects nothing out of the agent's box), with `artifacts/manifest.json` always present stating what was collected and from where (`[]` when the trial recorded nothing) — an artifact the trial never stored is an absent file, never an empty placeholder, while the layout's record files (`config.json`, `lock.json`, `result.json`, `trial.log`, `artifacts/manifest.json`) are present for every trial. The counters inside the job-level `result.json` are the same cumulative, Harbor-style numbers the live API reports on `stats` (errored trials are a subset of completed, cancelled a subset of errored), and each evals group also states `pass_at_k` — the same numbers a live read reports (see [pass@k](#passk)). The archive and a live read of the same terminal job never disagree.

The record files are Harbor's own vocabulary, and everything Evolve-specific rides under an `x_evolve` key Harbor's parsers ignore — the job's `config.json` and `result.json` and every trial's `config.json` and `result.json` each carry one, with the exact shapes published in the contract (`spec/openapi.yaml`, the `JobArchive*Extension` / `TrialArchive*Extension` schemas). Money reconciles from the extension, not from the Harbor-native field: a trial's authoritative spend is `x_evolve.spentUsd` with its `spendSource` lane, and `agent_result.cost_usd` states only a measured model spend (`None` otherwise). Two more extensions ride the job config's `agents` entries: `x_reasoning_effort` and `x_preset`, each omitted when the arm declared none.

---

## Upload a job

The download's inverse, and Harbor's `harbor upload` in reverse: `upload()` takes the job directory their CLI takes — `result.json` and `config.json` at the root, one subdirectory per trial — and hands it to the platform for ingest as a first-class **terminal** job, private to you (Harbor's own default: "on new uploads, private"). A directory a real `harbor run` produced, or one `evolve job download` unpacked, uploads as-is; so does the un-unpacked `.tar.gz` itself, and so does a public https URL of one. The door only moves the archive into storage and answers **202 with a job import** — the pollable record of the ingest — and a worker does the work off the request path, so a 4 GB upload never slows anyone else down; `upload()` returns that import, and `watch_import()` follows it to the ingested job (the CLI does both by default):

```bash
harbor run --dataset terminal-bench@2.0 --agent claude-code ...   # a local run
evolve upload jobs/2026-08-27__12-00-00 -d terminal-bench@2.0     # → accepted, followed to a terminal job here
evolve analyze <new-id>                                            # works on it unchanged
```

```python
async with jobs() as evals:
    imported = await evals.upload(
        './jobs/2026-08-27__12-00-00',
        dataset='terminal-bench@2.0',           # optional: link trials to a published version
    )
    print(imported.status)                      # 'QUEUED' — accepted; a worker ingests it
    settled = await evals.watch_import(
        imported.id,
        on_status=lambda i: print(i.status),    # QUEUED → RUNNING → COMPLETED | FAILED
    )
    if settled.status == 'FAILED':
        raise RuntimeError(settled.failure.code)  # e.g. 'not_a_job_dir'
    uploaded = await evals.get(settled.job_id)
    print(uploaded.status)                      # 'COMPLETED' — a record, on arrival
    print(uploaded.upload.original_job_id)      # what the archive's own files called it

    await evals.analyze(uploaded.id)            # the reason to upload at all

    # The server fetches a public archive itself — no local bytes:
    await evals.upload(archive_url='https://example.com/results/job.tar.gz')
```

The archive is packed to a **temporary file on disk** and streamed from there — never held in memory, whatever the folder's size — and over 256 MiB it rides the same resumable chunked door datasets use automatically (a dropped link resumes from the last acknowledged chunk; `on_registered` hands you the import id before the first byte moves, so `evolve job import <id> --watch` can attach from anywhere). `on_upload_progress` is the client-side transfer reading. The import's `failure` carries the same typed codes the door once answered synchronously, one hop later — a script that branched on `code` keeps working; a script that expected a synchronous HTTP status moves to the watch.

What lands is the trials' **verbatim facts**, never a re-judgment: a rewarded trial arrives `SCORED` with its rewards untouched, a trial whose result carries no rewards arrives `INDETERMINATE` (a missing verdict is stated as missing, never scored 0), and an errored trial keeps its exception. When present, `agent/trajectory.json`, `agent/stdout.log`, `agent/stderr.log`, `verifier/test-stdout.txt` and `verifier/reward.txt` are stored byte-for-byte in the same slots native trials use — `agent/sessions/` (the harness's native session home; hub archives carry the claude session transcripts there) lands in the stored agent-home slot, and the hub's CLI-output file (`agent/claude-code.txt` and per-harness siblings) fills the stdout slot when `agent/stdout.log` is absent — so the [trial artifact surfaces](#trial-artifacts--the-raw-record) and the analyzer read them with no special casing. Trace events are derived at ingest, raw-first through the platform's own per-harness parsers when the transcript format is recognized, else from the trajectory document, so the trace surfaces serve uploaded trials natively. Agent identity is stored as display labels — harnesses this platform does not run included: an uploaded job is a record, not execution config. The archive itself is a transport buffer, deleted once the import settles: every ingested artifact lives in its native slot, and the job download rebuilds the archive from them.

`dataset='name'` or `'name@version'` links the uploaded trials to a published dataset version by task name — matched trials analyze against the real task content; unmatched or unhinted trials analyze through the analyzer's task-not-available branch, exactly Harbor's fallback for a trial without a local task directory. A registry-qualified task name (Harbor's `org/name` form — what hub-downloaded jobs carry) matches and keys by its **leaf**, Harbor's own precedent; the full qualified form stays verbatim in the trial's provenance. The hint's grammar is checked at the door; a hint you cannot use (an unknown dataset, a version that is not READY) fails the import typed, in the job-create vocabulary.

The ingested job — read at `job_id` once the import completes — is the ordinary Job shape with one extra field: `upload` carries the provenance echo (`original_job_id` and `original_job_name` — what the archive's own record files said about themselves, each null when they said nothing — plus `uploaded_at`). It is null on every job this platform executed. An uploaded job is a **record, not a run**: resume, retry and regrade refuse it (`job_uploaded`, 409); analyze works on it unchanged.

**Execution honesty**, stated wherever the record could be mistaken for a run. An uploaded job's `sandbox_provider` is `None` at both the job and trial level — the record executed on no platform sandbox, and the closed provider vocabulary gains no fake member for it; sandbox ids are absent for the same reason. The CLI renders that provider cell as `ported` — a word derived from the upload provenance, never a stored value. Each trial carries its own provenance echo, `trial.upload`: the archive's own trial id and name, the task name verbatim, and `reported_agent_result` — the uploader's own token and cost figures, labeled REPORTED and served for the reader. They never populate the platform-metered fields (`agent_result`, `usage`, `spend_source`), which stay `None` because this platform's meter never saw the run — `trial show` keeps the reported rows visually apart from the metered ones. The job aggregates the same claims once at ingest as `upload.reported_totals` (each total `None` when no trial reported it — a zero would be a claim — with `n_trials_reporting` as the partial-reporting honesty count), and `stats['cost_usd']` and the token stats stay `None` the same way; `job show` renders that figure in the spent slot itself as `reported $X.XX (N/M trials reporting)`, and `job list`'s SPENT cell shows the compact `reported $X.XX` — labeled in both, never blended with metered spend. Analysis you run on an uploaded job still meters normally: the analyzer's spend stays its own metered line, exactly as on a native job.

The SDK applies Harbor's directory gate client-side with their own sentences (`… does not contain result.json` / `config.json`) before packing anything, and the worker holds the same line as `not_a_job_dir` on the import. The caps are published on the [capability document](#what-the-platform-supports) under `limits.uploads`: `job_archive_bytes` (the compressed cap — 8 GiB — `upload_too_large` at the door on the declared size; the decompressed footprint is bounded at four times it at ingest), `job_trials` (2,000; `job_too_large`), `job_trial_file_bytes` (per stored trial file, `invalid_trial` — which also names a trial whose `result.json` fails Harbor's TrialResult shape), and `job_trial_session_bytes` (the total cap on one trial's `agent/sessions/` tree, `invalid_trial` past it, naming the trial and the cap).

Re-uploading an archive whose job you already uploaded fails the import **typed** (`job_already_uploaded`): the duplicate is detected by you plus the archive result.json's own job id, and the failure's `details` name your existing job. Where Harbor's re-upload updates the same hub row, our trial rows carry analyses and analysis history that silent replacement would destroy — Harbor's hub rows have no such children — so the platform refuses instead of updating in place (recorded deviation). A different user uploading the same archive gets their own private copy, and an archive whose result.json states no id is undetectable and uploads fresh. To replace a job outright, [delete it](#delete-a-job) and upload again — deleting the job frees its duplicate lock. Uploads of one organization are ingested under its `max_concurrent_imports` — the same ceiling dataset publishes wait under, one count for both kinds — so a second upload queues behind the first (or behind a publish) rather than slowing anyone else down; both SDKs' `list_imports`/`listImports` and `evolve job imports` find an import again after its id was lost.

A deliberate **subset** of Harbor's verb, each gap recorded with its reason. No `--public`/`--private` and no `--share-org`/`--share-user`/`--org`: there is no public-job or sharing surface here yet — uploads are private, and the flags adopt Harbor's exact names when Teams lands. No `--concurrency`: Harbor's flag parallelizes per-trial uploads because their protocol uploads trial by trial; ours is one archive per import (one POST under 256 MiB, a resumable session above it), so the flag would have nothing real to do. `--from <url>` is the platform's own word — the dataset publish verb's fetched-source flag — not Harbor's; a hub job source (`harbor job download <uuid>`, then `evolve upload <dir>`) is not yet a server-side arm. Per-trial `lock.json` is not required or ingested, and `artifacts/`, `steps/` content, other `agent/` files that map to no native slot, and any prior `analysis.json` are not ingested in v1 — a prior analysis is never imported, matching the analyzer's own never-read-your-own-analysis exclusion.

---

## Delete a job

Permanent, and total: `delete()` destroys one of your jobs with everything that hangs off it — trials, trace events, analyses, and every stored trace object (trajectories, raw streams, verifier logs, analyzer streams, stored files). Harbor's own verb is `harbor hub job delete` ("Permanently delete Hub jobs you own, including their trials"); where their hub delete leaves uploaded archives behind in storage, this platform purges the stored objects too (recorded deviation).

```python
async with jobs() as evals:
    receipt = await evals.delete(job.id)
    print(receipt.trials_deleted, receipt.analyses_deleted)  # what was destroyed, counted
```

The response is the receipt — `job_id`, `trials_deleted`, `analyses_deleted`: what went, counted.

**Creator-only.** Org members may operate a job (cancel, retry), never destroy its record: a member who did not create the job is refused (`org_forbidden`, 403), and an id outside your reach answers 404 — existence never leaks. Harbor's rule is the same ("only the owner can delete a job").

**Terminal only — never a delete under a live worker.** A QUEUED/RUNNING/CANCELLING job refuses `job_not_terminal` (409; cancel first — Harbor's "a hosted job must have finished"). The same law covers work still riding the job's rows: a queued or running analysis wave refuses `analysis_already_running` (409; one wave at a time — wait for it to settle), and a live regrade derived from this job refuses `job_not_terminal` with the regrade jobs to wait for in `details['regrade_job_ids']` — a regrade is a job on this wire, and that job is the one not yet terminal.

What stays: regrade JOB rows (who asked for a regrade, and when, deliberately outlives a deleted source), a derived job's `source_jobs` entry, which keeps naming the deleted id as history, and — for a native job — the model gateway's own ledger, which remains the billing truth. A regrade job id is itself not deletable here (`job_not_found`, 404): a regrade's results are deleted from the traces surface.

Delete works on uploaded and native jobs alike, and deleting an uploaded job frees its duplicate lock — **delete-then-reupload is the replace path** for an [uploaded job](#upload-a-job).

The CLI mirrors Harbor's confirm posture: `evolve job delete <id>` names the job and asks before destroying anything, `--yes`/`-y` skips the prompt (a non-interactive stdin without `--yes` refuses rather than guessing), and `--json` prints the receipt:

```bash
evolve job delete cme12ab34            # names the job, then asks — [y/N]
evolve job delete cme12ab34 --yes      # no prompt; prints the receipt counts
evolve job delete cme12ab34 -y --json  # {"job_id":"…","trials_deleted":12,"analyses_deleted":3}
```

---

## CLI

The SDK's TypeScript package ships the `evolve` binary — a thin shell over the SDK clients, and nothing in it needs Python. The grammar is noun-verb: `evolve <noun> <verb>`. Three commands also stand on their own at the top level, as in Harbor's CLI: `run`, taking `job start`'s flags and documenting itself as `evolve run`; `analyze`, the [trace-analysis verb](#analyze); and `upload`, the [job-directory ingest](#upload-a-job) (`evolve upload <job_dir>`, with `-d/--dataset` as the task-linkage hint and `--from <url>` for a public archive the server fetches itself — it follows the import to the ingested job and prints the record and the analyze hint; `--no-wait` prints the import instead, and `evolve job import <id> --watch` re-attaches to it from anywhere). Singular nouns are canonical; `job`, `trial`, `analysis` and `dataset` also answer to their plurals as hidden aliases, as does `ls` for `list`. The plural `agents` is deliberately not an alias — that word is reserved for the managed-agents CLI and refuses with the reason, so use the singular `evolve agent` for eval agent arms.

```
job      start | list | show | trials | tasks | compare | cancel | delete | stop | resume | retry | regrade | download | grep | imports | import
trial    show | trace | download | retry | regrade | stop
analysis list | show | trace | download
session  list | show
dataset  list | show | publish | watch | download | activate
skill    list | upload | show | delete
agent    list | show | add | remove
auth     status | org list | org show
secrets  set | list | delete
```

The commands below are written as `evolve …`, which is what the binary is called once the package is installed:

```bash
npm install @evolvingmachines/sdk
npx evolve --help          # inside a project that has the package
```

A one-off run without installing needs the package named explicitly — `npx --package=@evolvingmachines/sdk evolve --help` — because a bare `npx evolve` would fetch an unrelated package of that name from the public registry.

Start a job with the short flags — each one mirrors a field of the create body:

```bash
evolve run \
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

`-i/--include-task-name` and `-x/--exclude-task-name` filter task names by glob and `-l/--n-tasks` caps each dataset's count after filters — all three are stamped onto every dataset selector, so a glob that matches nothing in one dataset simply filters nothing there. `--effort <value>` sets the reasoning effort on **every** arm, verbatim; an agent that cannot honor it is refused by the server rather than silently skipped, so a mixed sweep that needs per-arm efforts belongs in the SDK. `--skill <ref>` (repeatable) mounts skills on **every** arm the same way — `skills.sh/<owner>/<repo>[/<skill>]`, `org/repo[@ref]`, an https git URL, `upload:<id>`, `name:<skill-name>` (your moving name pointer, resolved server-side), or a local folder, which the CLI uploads to the platform first and swaps for its `upload:<id>` handle (`--print-config` still shows the path you typed). `--agent-env` / `--verifier-env` take `KEY=VALUE`, repeatable. `--secret NAME[@LABEL][=ENVNAME]` (repeatable) attaches one of your stored env secrets to every agent run — a reference, never a value: `NAME` is the stored secret's name, `@LABEL` picks a labeled row (omitted = the `default` row, or the only row; several labels with no `default` is refused as ambiguous), and `=ENVNAME` renames the env var inside the sandbox. `--secret-inline "NAME[@LABEL]:DELIVERY=VALUE"` (repeatable) saves `VALUE` into your vault as an env secret and attaches it in one step — `DELIVERY` is `brokered` or `direct` and sits before the `=` so everything after the first `=` is the value, byte-for-byte; `@LABEL` defaults to `default`, and an existing `(NAME, LABEL)` secret splits on proof, exactly as an inline entry does in the SDK: restating it byte-for-byte (same value, same delivery) attaches it, so re-running the same command converges instead of colliding with its own first attempt, while a different value or delivery refuses as `secret_exists` (attach it with `--secret` or pick a label). The job stores only the reference, never the value. `-r/--max-retries` caps [automatic infrastructure-error retries](#automatic-retries) per trial (0 turns them off), and the repeatable `--retry-include`/`--retry-exclude` refine which exception names retry; with `-c/--config`, the file's `retry` object is the base and each flag overrides its own field — Harbor's merge rule. `--timeout-multiplier` stretches (or shrinks) every task-declared timeout for this job's runs, and the four phase flags — `--agent-timeout-multiplier`, `--verifier-timeout-multiplier`, `--agent-setup-timeout-multiplier`, `--environment-build-timeout-multiplier` — each override it for their phase ([Timeout multipliers](#timeout-multipliers)); same field-by-field merge over a `--config` file. `--job-name` labels the run. A flag's value may itself begin with `-` — a glob like `-x '-*'`, a negative number, a bare `-` — and is taken as the value; only a token that spells another flag of the same command is refused, and that refusal shows the `--flag=value` form that states the intent.

`--ak key=value` (repeatable, alias `--agent-kwarg`) is Harbor's agent-kwarg channel, stamped on **every** arm like `--effort`. The key the platform delivers is `config`: `--ak 'config=./settings.json'` reads the local file (JSON, or TOML for a Codex config) and sends its parsed content inline — the server never reads a client path — and `--ak 'config={"permissions":{"deny":["WebSearch"]}}'` passes the document straight. In the sandbox it becomes the harness's native settings file (Claude: a settings JSON layered in via `--settings`; Codex: the base `~/.codex/config.toml`), with your document as the base and the platform's routing, MCP, model and effort stamps on top — so a config can tune permissions or tool behavior, never where model traffic goes. Acceptance is typed, never silent: an unrecognized kwarg key refuses `agent_kwarg_unsupported`, `config` on an agent without native-config support (only `claude` and `codex` have it — each capability entry publishes `supports_config`) refuses `agent_config_unsupported`, and a config key touching billing, base URLs, provider routing, or env injection refuses `agent_config_key_refused` naming the keys. The accepted config is part of the arm's identity: the same agent and model with two configs are two arms, and job bodies echo `kwargs` on each arm.

`--preset <name>` is the plain-words door to the same channel, stamped on **every** arm. Two presets exist: `no-internet` turns off the vendor's server-side web tools — Claude gets a settings `permissions.deny` for WebSearch/WebFetch, Codex gets `-c web_search=disabled` on its command line — enforcement is harness configuration, exactly as Harbor delivers it. Note what that does and does not do: the preset turns off the vendor's **server-side** web tools through harness settings — it does not seal the sandbox network, and what the box itself can reach is still governed by the task's declared [network mode](#network-modes). `pinned-context` pins one fixed effective context window (200000 tokens; Claude via `autoCompactWindow`, Codex via `-c model_context_window`) so vendor-side window tuning never confounds a comparison. A preset is stamped on top of any `--ak config` document and wins where they disagree — a user config cannot undo a guarantee. Acceptance is typed, never silent: an unknown name refuses `invalid_input` listing the vocabulary, and a preset on an agent that cannot guarantee it (each capability entry publishes `presets`; only `claude` and `codex` today) refuses `agent_preset_unsupported` — never a run silently missing its guarantee. The preset is part of the arm's identity, and job bodies echo `preset` on each arm.

For a run you will repeat, put the body in a file. `-c/--config` loads YAML or JSON **in the spec's own vocabulary** — the same field names as `jobs().start()` — and explicit flags override its fields; `--print-config` prints the resolved body and exits without spending anything, the dry-run a paid remote run deserves. The YAML is real YAML, read by the standard `yaml` parser with PyYAML's semantics — the 1.1 schema, so `yes`/`on` read as booleans, a comment never lands inside a value, the apostrophe in `job_name: brando's run  # nightly` is a letter and the comment still strips, and a flow mapping like `- {name: claude, model_name: opus}` is one whole sequence item. That 1.1 schema is pinned rather than defaulted, so a `%YAML 1.1` or `%YAML 1.2` directive at the top of the file changes nothing about how the values under it read — PyYAML's resolver has no other mode either — while a version the parser does not know, like `%YAML 1.3`, refuses with its line number rather than being guessed at (PyYAML would read on; a refusal beats a guess in a file that spends money). Numbers follow PyYAML's pattern too, which is narrower than the 1.1 spec's in two places. A float needs a dot, and an exponent needs a sign, so `1.5e+3` is the number 1500 while `e3`, `1e3` and `5e-3` stay the text you typed — an ordinary build tag like `BUILD_TAG: e3` is a string, not a number that resolves to nothing. An integer may not be zero-padded, so `08`, `-09` and a clock-shaped `0:0` or `08:00` stay text as well, while `012` is still octal 10 and `12:30` is still 750. One strictness is the library's own and not PyYAML's: a flow collection written across several lines inside a block collection must keep its continuation lines indented past that block, so `agent_env: {A: 1,` with `B: 2}` back at the parent's indentation is refused with its line number — indent the continuation and it reads. Four things refuse with a line-numbered error instead of parsing quietly: a second document in the file, an unresolvable `!tag`, an unknown `%YAML` version directive, and a duplicate key (last-value-wins is a silent corruption a config file cannot afford). The shape of the body is not hand-kept anywhere: the file validates against the **contract itself** — the `JobCreate` schema in `spec/openapi.yaml`, shipped inside the package, and every shape it references (`DatasetSelector`, `AgentArmInput`, the `sandbox_provider` enum) — so a field the spec grows is accepted with zero CLI changes, and an unknown key is refused **by name at every level**, with the allowed keys listed. The file may be partial — `-d` and `-a`/`-m` can supply what it omits — so the top-level `datasets`/`agents` are not demanded of the file itself, but the keys **inside** an entry are: a selector needs its `name`, an agent arm its `name` and `model_name` (the server applies no model default). Types read out of the same schema, refused at the keyboard: `datasets`/`agents` entries are objects (a bare name like `datasets: [deep-swe]` is refused by element, never spread into characters), strings are strings — an unquoted `version: 1.10` is refused rather than shipped as the number 1.1, which names a different dataset version — `n_attempts`, `n_concurrent_trials` and `n_tasks` are integers, and the spec's stated constraints hold before any round trip: `sandbox_provider` one of `e2b | daytona | modal`, `n_attempts` 1-100, `n_concurrent_trials` 1-150, `n_tasks` at least 1, at most 8 agent arms, `job_name` at most 200 characters. A schema refusal names the config path, the file **and the line**, and the spec shape that ruled — `--config: datasets[0].version in nightly.yaml:5 must be a string, not a number — quote it (version: "...") [spec: DatasetSelector.version]` — so the fix is findable from the message alone (a JSON config refuses the same laws, just without a line: JSON keeps no positions). On top of the schema sit the wire laws only YAML can trip: any value YAML resolves past what a JSON body can carry — a bare `2026-08-02` date, `.inf`, `.nan`, `!!binary`, `!!set` — is refused instead of rewritten on the way out — as is a value that contains ITSELF, which two lines of valid YAML can write (`agent_env: &a` over `  X: *a`) and no JSON body can carry, named by its key and file rather than left to exhaust the reader. That last one is the quiet corruption: `JSON.stringify` does not refuse a Date, it turns it into an ISO string, and `job_name` is a plain string to the server, so a date-shaped name would be ACCEPTED and the job would carry a name nobody wrote (quote the value to keep it text). What stays the server's to judge is what only the server knows: whether a name exists. A config file reads like this:

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
evolve job start -c nightly.yaml --print-config   # inspect the exact body
evolve job start -c nightly.yaml --watch          # then run it
```

The read side, worked through:

```bash
evolve job list --limit 20 --search nightly
evolve job list --scope shared              # your organizations' jobs that teammates created
evolve job show <id> [id...]               # incl. a pass@k block, once attempts settle
evolve job trials <id> --status INFRASTRUCTURE_ERROR,SCORING_ERROR
evolve job trials <id> --dataset deep-swe
evolve job tasks <id>                      # per-task rollup
evolve job compare <id> <id>
evolve job cancel <id>
evolve job stop <id> --dataset deep-swe    # one dataset's live trials
evolve job resume <id> -f InfrastructureError
evolve job retry <id> --failed-only        # or -t <trial-id> (repeatable), or bare for the whole job
evolve job regrade <id> --task task-001
evolve job download <id> -o results/       # unpacks the job tree to results/job-<id>/
evolve job grep <id> 'out of memory'       # every trial's trace, one pass

evolve analyze <id>                        # trace analysis, the defaults; returns at once with the queued batch
evolve analyze <id> --watch                # …and follows the wave to its settled end
evolve analyze <id> -m glm-5.3 -r rubric.toml
evolve analyze <id> -m glm-5.3-flash --effort low   # the analyzer's effort, run's own flag
evolve analyze <id> -p prompt.txt          # Harbor's prompt file replaces the built-in analyzer prompt

evolve upload jobs/2026-08-27__12-00-00 -d deep-swe@1.1   # ingest a Harbor job dir as a terminal job (follows the import)
evolve upload --from https://example.com/job.tar.gz --no-wait   # the server fetches it; prints the import
evolve job import <import-id> --watch                    # re-attach to an upload's ingest
evolve job imports --status RUNNING                      # your uploads in flight

evolve trial show <trial-id>
evolve trial trace <trial-id> --grep 'permission denied' --tail 50
evolve trial download <trial-id> --stream trace-stdout
evolve trial download <trial-id> -o trials/
evolve trial retry <trial-id>
evolve trial regrade <trial-id>
evolve trial stop <trial-id> [trial-id...]

evolve analysis list --job <id> --status failed   # every analysis run, with the trial/job/task it judged; --scope shared for your teams'
evolve analysis show <analysis-id>         # the analyzer's verdict document (id: trial show's analysis row, or analysis list)
evolve analysis trace <analysis-id>        # the analyzer's own transcript; --since resumes
evolve analysis download <analysis-id> --stream trace-stdout   # or save whole with -o

evolve session list --state ended --tag-prefix qa-   # your managed-agent sessions (the SDK's .run() records)
evolve session show <session-id>

evolve dataset list -q
evolve dataset show deep-swe@1.1
evolve auth status
evolve auth org list --search acme          # the organizations you belong to; --search narrows by slug, display name or role
evolve auth org show acme                   # one organization: role, members, quota and live usage
```

`evolve analyze <job-id>` is [Analyze](#analyze) end to end, in `run`'s shape: it POSTs the wave and returns at once with the job block — the `analysis` row carrying the queued tally — and the re-attach hint (`Follow it with: evolve job show <id>`); `--json` alone prints the accepted job body. `--watch` follows the wave to its settled end (analyses have no event stream, so the follow is the SDK's poll: 2 s between reads, backing off to 30 s while nothing changes), then prints one row per analyzed trial — the criterion outcomes, the analyzer's own cost, a summary excerpt — with every failed analysis shown typed below the table. `-m/--model`, `-r/--rubric <file>`, `-p/--prompt <file>` and `-e/--env <provider>` are Harbor's own four knobs (their cli/analyze.py); the rubric file is TOML, YAML, or JSON in Harbor's `{criteria}` shape (a `[[criteria]]` entry per criterion in TOML), parsed at the keyboard with unknown fields refused by name — the server still owns the bounds; the prompt file is read verbatim and sent as text (see [Analyze](#analyze) for the tokens it may use), an empty file refused at the keyboard. `-e` is re-aimed with the verb itself: Harbor's flag picks a local environment type (docker, daytona); here it picks which **hosted** provider's sandbox the analyzer boots — there is no local backend server-side — defaulting to the platform's analysis default, daytona. `--effort <value>` is `run`'s own flag applied to the analyzer (the one option beyond Harbor's four, a recorded hosted extension): the server's effort vocabulary, refused by name when unknown, defaulting per model (`high` on `deepseek-v4-flash-vision`, `low` on `glm-5.3-flash`). Under `--watch`, `-q` suppresses the progress lines and `--json` emits NDJSON envelopes (`analysis.accepted`, `analysis.stats` per tally change, `analysis.final` carrying the job and the analyzed trials). Exit codes are `run`'s: 0 on the accepted wave without `--watch`; with `--watch`, 0 only when every analysis completed — a wave with failed analyses exits 1, Harbor's own law. On `job start` / `run`, `--analyze` arms the embedded trigger (each trial analyzed as it settles; bare `--analyze` = all defaults), with `--analyze-model`, `--analyze-rubric <file>`, `--analyze-prompt <file>`, `--analyze-provider <provider>` and `--analyze-effort <value>` as the passthrough set — any of them implies `--analyze`, and over a `-c` config file's `analyze` object each flag overrides its own field, the retry merge rule. `job show` then carries an `analyze` row (the resolved policy) and an `analysis` row (the tally plus the analyzer's own spend, with a per-criterion line each); `trial show` prints the trial's latest analysis in full — verdicts with their explanations, the summary, the typed failure when there is one.

Output follows one precedence everywhere: human tables on a TTY, tab-separated rows when piped, `--json` for the machine shape (NDJSON for `--watch` streams), and `-q` for ids-only lists (on `job start --watch`, `-q` suppresses the event log and prints the final block only). `--columns` chooses and orders list columns (`--columns help` names them; for `job list` they are `id`, `name`, `status`, `datasets`, `agents`, `trials`, `spent`, `started` — the money column's key is `spent`, not `cost`; for `analysis list` they are `id`, `status`, `task`, `job`, `trial`, `model`, `attempts`, `spent`, `created`, `finished`; for `session list` they are `id`, `tag`, `agent`, `model`, `provider`, `sandbox`, `state`, `runtime`, `cost`, `steps`, `created`, `ended`), `--no-trunc` disables cell truncation, `--no-headers` drops the header row from piped output. `--limit` and `--cursor` page every listing the same way.

`--scope` on `job list` and `analysis list` is Harbor's own knob (`harbor hub job list --scope`): `my` — what you created, the default — or `shared` — your organizations' rows that teammates created, exactly the rows `job show` already opens for you as a member and not one more. Harbor's third value, `all`, adds public jobs; nothing hosted is public, so `all` is refused by name rather than quietly meaning both. An API key carries its owner's membership and nothing else: there is no wider view. A **headless QA round** is one walk: `evolve job list -q`, `evolve job trials <id>`, `evolve analysis list --job <id>` and `evolve analysis show` on each, `evolve session list` for the managed-agent side — every listing pages the same way, and every id printed under `my` (the default) resolves on its `show`. Under `--scope shared` every id printed resolves too: `analysis show`, `trace` and `download` open a teammate's run the way `job show` and `trial show` already do — read access is shared across an organization, while deleting a job stays with its creator. An id outside your organizations answers `trial_not_found` (exit 1), the same typed refusal a nonexistent id gets. Sessions carry no `--scope`: a session has one owner and no organization, so `my` is the only visibility there is.

`job show` ends with a **pass@k** block — one line per evals group, each k to three decimals — whenever the platform has numbers to show. Groups that cannot answer are simply absent from it, and a job with nothing computed prints no block at all; `--json` always carries the raw `stats.evals[].pass_at_k`.

Wherever a verb takes a **job id**, an unambiguous prefix of at least 8 characters works too: `job show aabbccdd` is `job show aabbccdd-…` when exactly one of your jobs starts that way. The CLI resolves the prefix against the job list of the scope the verb names (`--scope`; your own by default) before calling the server — the wire always carries the full id — and refuses loudly when the prefix matches nothing or more than one job. Trial ids are not prefix-resolved; trial verbs take full ids.

A rate limit is a delay, not a mystery: a `429` prints one line naming the limit and the server's `Retry-After` delay (exit 1), and the SDK's watch loops honor that delay and keep watching instead of dying mid-poll.

Closed sets are validated at the keyboard: a typo in `--stream`, `--status`, or `run`'s `-e/--env` is a usage error naming the legal values, never a round trip. The analyzer's provider knobs (`analyze -e`, `--analyze-provider`) deliberately ride to the server instead: their lineup is the server's roster, and its `invalid_input` refusal names it — no client-side copy to drift.

Credentials: `$EVOLVE_API_KEY`, or `--api-key`; `--base-url` targets a non-default deployment. Exit codes: `0` success (with `--watch`: the job `COMPLETED`, or a publish SETTLED — the version `READY`, built and, on a dataset you own, active), `1` runtime failure (with `--watch`: `FAILED` or `CANCELLED`; for a publish, a version that settled `FAILED` or could not be confirmed settled in time), `2` usage error, and — Harbor's own exit for it — a quota refusal: a job the owning organization's queue cannot take prints `Launch quota exceeded: hosted quota exceeded: …` and exits 2 (see [Organizations and quotas](#organizations-and-quotas)).

### Signing in

Today the credential story is one step: create an API key in the dashboard and export it as `EVOLVE_API_KEY`. `auth().status()` then tells you who the platform thinks you are — your user, your email, and a descriptor of the key in use (the secret is never returned):

```python
status = await who.status()
print(status.user_id, status.email, status.key.label)
```

`auth login` — the browser sign-in flow that mints the key for you — lands with the auth release. Key listing and revocation are already in the contract and served; their SDK and CLI verbs arrive with the same release.

The key descriptor's `last_used_at` is in the shape but nothing updates it yet: it stays `None` even on the key making the request. Read it as "not recorded", never as "this key is unused".

Dataset publishing and agent registration have their own subcommands — shown in [Bring your own dataset](#bring-your-own-dataset) and [Bring your own agent](#bring-your-own-agent).

### Organizations and quotas

Every job, dataset and analysis belongs to an organization — today your personal one: the API accepts an `org` on a job or a publish, but the SDK and CLI do not name one yet (that lands with the rest of the team-accounts wave). `auth org list` is Harbor's own verb (`harbor auth org list`): the organizations you belong to, with your role in each. `--search <text>` narrows it the way Harbor's does — a case-insensitive match over the slug, the display name and your role. `auth org show <slug>` is the hosted extension: one organization in depth — your role, the member count, and the organization's **quota** beside its live **usage**:

```bash
evolve auth org list
evolve auth org show acme
```

```
slug                     acme
display name             Acme
personal                 no
role                     member
members                  3
created                  2026-08-01T00:00:00.000Z
concurrent trials        2/16
queued trials            40/10000
concurrent imports       0/1
concurrent analyses      1/4
concurrent sessions      0/4
e2b sandbox ceiling      100
daytona sandbox ceiling  200
modal sandbox ceiling    60
month spend              $12.50 / no budget (as of 2026-08-15T11:58:00.000Z)
```

```python
from evolve import orgs

mine = await orgs().list()                     # GET /api/orgs — personal org first
acme = await orgs().get("acme")                # GET /api/orgs/acme
print(acme.role, acme.member_count)
print(acme.usage.queued_trials, "/", acme.quota.max_queued_trials)
```

`hosted().orgs` carries the same client behind the front door.

The quota is nine ceilings, every one shown **effective** — the value the platform administrator set for the organization, else the fleet default. `max_queued_trials` is the one that refuses: a job whose trials would not fit in the organization's queue is not accepted. Everything else waits — `max_concurrent_trials` (trials running at once), `max_concurrent_imports`, `max_concurrent_analyses` — or is metered by the gateway (`monthly_budget_usd`, `None` = no monthly budget, your credits stay the only backstop — a number is the organization's ceiling on metered model spend per UTC calendar month — the gateway's own window, reset on the 1st at 00:00 UTC — enforced by the gateway on every key the platform mints for the organization's work, and a run the gateway refuses on it settles typed rather than scored — the trial ends `INFRASTRUCTURE_ERROR` with `exception_info.exception_message` starting `team:` and carrying the gateway's own sentence (the downloaded job archive records the cause as `x_evolve.failurePhase: budget_exhausted` in the trial's `result.json`; a trace analysis refused the same way fails with `failure.phase` `budget_exhausted`); the same shape with `user:` when the account's credits run out, and with `other:` when a gateway budget above the run that the platform did not set for your organization — the fleet's own global stop — is exhausted; never retried automatically, and `job resume` picks such trials up once the budget is raised). `max_concurrent_sessions` is recorded and read back but not yet enforced by the managed box-create doors. The three `max_concurrent_sandboxes_e2b` / `_daytona` / `_modal` ceilings bound the organization's sandboxes in flight on each provider — trials, trace analyses, regrade verifiers and managed sessions together; work beyond one waits, `0` pauses the organization on that provider only, and an organization with no value of its own reads back the platform's fleet ceiling for that provider, which is then the only bound. On the other ceilings a `0` pauses that kind of work for the whole organization — job creates are refused at `max_queued_trials` 0, and its trials, imports or analyses wait at a 0 on theirs; `monthly_budget_usd` 0 pauses at the gateway; `max_concurrent_sessions` 0 pauses nothing yet. Quotas are set only by the platform administrator, from the dashboard — never with an API key and never through the SDK, so there is no verb for it here.

The refusal is Harbor's own shape: a `429` with code `quota_exceeded`, a message that starts `hosted quota exceeded:`, and `details` naming the quota, its limit, what is used, what the job asked for, and the organization. There is no `Retry-After` — the wait is not a number the server knows. The CLI prints `Launch quota exceeded: …` and exits 2, as Harbor's does; `--json` carries the envelope.

```python
try:
    await evals.start(datasets=[DatasetSelector(name="deep-swe")],
                      agents=[AgentArm(name="claude", model_name="opus")])
except EvolveAPIError as err:
    if err.code == "quota_exceeded":
        d = err.details or {}
        print(f"{d['org']}: {d['used']}/{d['limit']} {d['quota']}, this job needed {d['requested']} more")
```

`usage` is what is happening now: trials in flight and queued, imports and analyses a worker holds, open sessions (a session belongs to its creator's personal organization, so a shared organization always reads 0), and `month_spend_usd` — the gateway's own month-to-date spend for the organization (UTC calendar month, reset on the 1st), the same number its monthly budget is enforced against, as the platform last copied it from the gateway; `month_spend_as_of` says when. It is `None` when the platform holds no copy it may serve — the organization has not been metered yet, or the month just rolled and the gateway has not reset — never 0 for "unknown"; `org show` prints `unavailable` then.

### Env secrets

`--secret` and `--secret-inline` attach secrets to a run; `evolve secrets` is the store they attach from — the same vault the dashboard's **Secrets** page writes, reached with your API key instead of a browser session. It is the one plural-canonical noun in the grammar (the word names the surface, not one record), and `secret` answers as a hidden alias.

```bash
# Store one — piping the value keeps it out of shell history and the process list
printf %s "$GITHUB_TOKEN" | evolve secrets set GITHUB_TOKEN \
    --delivery brokered \
    --allowed-host api.github.com --allowed-path-prefix / --allowed-method GET

# --value is the other channel, and --label puts a second value beside the first
evolve secrets set STRIPE_KEY --label staging --delivery direct --value sk_test_123

evolve secrets list                            # metadata only — values never leave the server
evolve secrets list -q                         # name[:label], one per line
evolve secrets delete STRIPE_KEY --label staging
```

`--delivery` is required on every write, with no default, because the two modes put the value in different places. **`brokered`** means the value never enters a sandbox: the run receives an opaque placeholder and the egress proxy swaps the real value in on requests to the hosts you allowed. **`direct`** means the raw value is placed in the sandbox environment as-is. A brokered write therefore needs the scoping triple — `--allowed-host` (a hostname or a wildcard like `*.example.com`), `--allowed-path-prefix`, `--allowed-method`, each repeatable — and a direct write refuses it, since a value sitting loose in the environment cannot be held to a host list. Eval trials deliver **direct** secrets only ([Shape and ceilings](#shape-and-ceilings)), so store secrets for this lane as direct and keep brokered ones for managed agents.

Names are env-var-shaped (`[A-Z_][A-Z0-9_]{0,127}`, uppercased for you) and the `EVOLVE_` prefix is reserved; labels are at most 80 characters of `[A-Za-z0-9._-]`, and an omitted label is `default`. A value is at most **190 bytes of UTF-8** — API keys and tokens fit, a certificate or a private key does not and belongs in the task or agent image. `--value` and piped stdin are the only two channels, one trailing newline is stripped from the pipe (so a plain `echo` does not silently store a `\n`), and a terminal with neither is a usage error rather than a hang.

Collisions follow the same converge-on-proof law `--secret-inline` does, for the same reason: restating a stored `(name, label)` byte-for-byte succeeds — and is the one place `--delivery` and the allowlists can be re-shaped — while a different value is refused as `secret_exists` (409). Rotate by `delete` then `set`, or store the new value under another label. `delete` resolves an omitted label exactly as attaching does (the `default` row, else the single row, else `secret_ambiguous` naming every label), and deleting revokes every runtime grant riding the row.

Two things this door will not do. A **read-only API key** may `list` but not `set` or `delete` — the refusal is `read_only_key` (403) — so a key handed to CI to read results cannot rewrite what your runs authenticate with. And **LLM provider keys (BYOK) cannot be stored here at all**: a provider key decides whose account pays for model traffic, which is a billing decision, so those stay on the signed-in dashboard where a human is present to make it. The same three operations are on the SDK client, `managed_secrets()` — see [Managed Secrets](02-configuration.md#managed-secrets).

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

- **`agents`** — every built-in, with `effort_support` (what the agent does with `reasoning_effort`: `'level'` — the value reaches the CLI as a level; `'binary'` — thinking on/off only, values outside `limits['job']['binary_effort_values']` are refused; `'none'` — no effort input at all, naming one is refused), `default_effort` (the pinned default an omitted effort takes; `None` for `'none'`), `runnable` plus `reason` (a registered agent the platform must refuse says why), `default_model` and `models` (the picker's option list — the API still requires an explicit model), `supports_config` (whether `kwargs['config']` reaches it), `presets` (the named settings presets it can guarantee), `version_pinnable`, and `latest_version` for a "your pin is out of date" badge (`None` means "not known right now", never "up to date").
- **`agent_registration`** — the rules a bring-your-own registration must satisfy: name pattern and length, size caps, `max_per_user`, the reserved built-in names, and the reserved env keys the platform owns. A plain dict with the wire's own keys.
- **`sandbox_providers`** — each provider's real resource ceilings and, in `refuses`, the capabilities it will not run with the reason the runner itself would give. **`platform_constraints`** beside it holds the refusals that apply on *every* provider, so "runs nowhere" is distinguishable from "runs somewhere else".
- **`managed_providers`** — the managed sandbox doors this deployment serves; a different question from the eval lane. Each entry's `agent_sessions` says whether the door carries a full SDK agent session; all three doors do today, Modal included — the Modal door serves commands *and* the file quartet, proven end to end — so a `false` there with a "no filesystem operations" reason is a stale value, not a capability statement. §Managed Sandboxes in the configuration chapter is the authoritative description of what each door serves.
- **`network_modes`** — the three modes a task may declare ([What runs](#what-runs)).
- **`statuses`** — the job, trial, import, and dataset-version vocabularies, each with its `terminal` members marked. A watcher stops on `terminal`; a status bar renders `values` without hardcoding the enum.
- **`limits`** — `limits['job']` carries every create-time bound (`max_agents`, `max_n_attempts`, `max_trials`, `n_concurrent_trials` default and ceiling, `default_max_trial_spend_usd`, `default_sandbox_provider`, `default_sizing`, `model_required`, the effort vocabulary, and the phase wall-clocks a task inherits when its own config declares none — `default_agent_timeout_sec` 3600, `default_verifier_timeout_sec` 600; a task that declares its own always wins — and the timeout-multiplier pair, `default_timeout_multiplier` 1.0 with `max_timeout_multiplier` as the create-time ceiling). `compare` bounds the compare fan-out; `pagination` publishes a `default`/`max` pair per collection scope; `uploads` holds every upload cap — the dataset-corpus, agent-tarball and skill archive sizes, the per-user skill-record ceiling, and the [job upload](#upload-a-job)'s four (`job_archive_bytes`, `job_trials`, `job_trial_file_bytes`, `job_trial_session_bytes`); `dataset_names` the name pattern and length bounds; and `max_items_named_in_error_message` is how many offending items a refusal names in its English sentence before "and N more" — which is why `details` exists.
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
- **`retry_after_sec`** is set on `429` and `503`, read from the body first and the `Retry-After` header second. One `429` deliberately carries none: `quota_exceeded`, the organization's queue ceiling ([Organizations and quotas](#organizations-and-quotas)) — the wait is not a number the server knows.
- **`request_id`** identifies the failure server-side. Quote it in a support thread. Every API response — success or failure — carries the same identifier in its `x-request-id` header, and an error body repeats it as `request_id`; the attribute on the raised error is that value, so the id in your logs matches the id in the server's.

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

What the **verifier** can reach depends on its [verifier mode](#verifier-modes) and on the task's own verifier declaration. A `shared`-mode verifier runs inside the agent's own sandbox, so it sees exactly the network the task's policy granted that box — sealed under `no-network`, the named hosts under `allowlist`, the open internet under `public`, which real shared-mode verifiers routinely use to install their test toolchain at verify time; a `[verifier] network_mode` that differs from that baseline is refused at import by name, because nothing would enforce it there. A `separate`-mode verifier box boots under the **task's declared verifier policy**, resolved the way the task format defines it: the `network_mode` (or legacy `allow_internet`) of its `[verifier.environment]` table, or a copy of the `[environment]` policy when the task declares no verifier environment — so a task that declares nothing gets a `public` verifier box, exactly like its agent box — with a `[verifier] network_mode` phase override winning over either. The platform does not seal a separate verifier on its own: a task that wants its verifier sealed declares `no-network` on `[verifier.environment]`, and a task that declares `public` there runs its verifier — test files, reference answers and all — with open egress. Read a third-party task's verifier declaration before trusting its verdicts. A verifier `allowlist` the job's provider cannot express is refused at job creation, and again before the box boots, naming what cannot be enforced; tasks imported before the platform honored the verifier declaration keep the sealed verifier box they were imported with until they are re-imported; and a [regrade](#regrade) re-runs under the policy recorded with the source trial. A [judge-enabled task](#llm-judges)'s verifier can additionally reach the platform's model gateway in every mode — the gateway is its own door, granted independently of the policy, and for a `no-network` box it is the only one. Judge-enabled runs also get uv managed for them: the platform pre-stages a uv cache in the verifier, and when the box the verifier runs in is sealed — a `separate` run whose resolved verifier policy is `no-network`, or a `shared` run under `no-network` — it sets `UV_OFFLINE=1`, so a uv-based test setup answers from that cache and a miss fails fast with uv's own offline error instead of hanging against a network it cannot reach; in a box with task-granted network — `allowlist` or `public`, in either mode — the variable is not set and uv may fetch. Verifiers without a judge get neither the cache nor the variable. Each trial records the mode it ran under and where that decision came from in `agent_result.metadata` — compare rewards only across trials that agree on both, because an agent with internet access ran a different experiment from a sealed one.

### Verifier modes

- `separate` — the verifier boots a pristine copy of the task environment and judges the collected submission. Nothing the agent left behind can touch the verdict. A separate-mode task must also say what carries over: a top-level `artifacts = [...]` list in `task.toml` naming the absolute paths the agent's work lives at. Those files are collected from the agent sandbox and re-materialized at the same paths in the verifier's pristine copy — without the list the verifier judges an environment the agent never touched, and even the gold solution scores 0.
- `shared` — the verifier command runs inside the agent's sandbox, after the agent finishes and its credentials are revoked.

Both are supported; the task picks (`environment_mode` in its config). The mode that ran is recorded on every trial as `verifier_environment_mode` — and it decides [regrade eligibility](#regrade).

### LLM judges

A verifier can grade with a language model. The task asks for the credential the way Harbor tasks already do — an environment template in `task.toml`:

```toml
[verifier.env]
ANTHROPIC_API_KEY = "${ANTHROPIC_API_KEY}"
```

Harbor resolves that template from the machine's own environment and hands the raw provider key into the sandbox. This platform honors the same task file without ever doing that: at verify start the trial mints a **distinct, short-lived gateway credential** — scoped to the requested key's model family only, capped with its own budget, revoked the moment scoring ends — and the requested variable resolves to it. The matching base-URL variable is set alongside automatically, so `litellm`-style clients (including Harbor's `rewardkit`, which is available offline in the verifier box — a `test.sh` running `uvx --from harbor-rewardkit… rewardkit /tests` works unchanged, with no network) call the platform's gateway without the task changing a line. The recognized templates are `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` and their base-URL companions (`ANTHROPIC_API_BASE`, `ANTHROPIC_BASE_URL`, `OPENAI_API_BASE`, `OPENAI_BASE_URL`), and each is honored only as the **entire** value — `"Bearer ${ANTHROPIC_API_KEY}"` is refused at import rather than delivered as a bare credential with the prefix dropped, so let the verifier add any prefix itself. Any other `${VAR}` template resolves to its declared default: `${JUDGE_MODEL:-o3-mini-2025-01-31}` imports as that model name, which is upstream's own fallback and is simply literal text here. That too is honored only as the **entire** value — `"prefix ${VAR:-x}"` is refused, because substituting the default into part of a value would drop the text around it. A non-judge template with **no** default (`${VLM_API_KEY}`) is refused at import — there is no host environment to resolve it from.

Judge model selection is Harbor-exact: the platform never chooses a judge model. Your rubric names one exactly as it would under Harbor, and when it names nothing, `rewardkit`'s own library default (`anthropic/claude-sonnet-4-6`) applies — applied by the library inside the box, never injected by the platform; a verifier that names no model anywhere fails the same way it would on Harbor. Judge calls travel the gateway's normal provider routes on the trial's judge credential, whose model scope is the family of the key the task requested — `ANTHROPIC_API_KEY` admits Anthropic models, `OPENAI_API_KEY` admits OpenAI models — so a model outside the requested family is refused by the key, exactly as an agent's key refuses a model outside its arm. If your account [brings its own provider key](./01-getting-started.md#managed-byo-provider-keys), judge calls ride the same provider preference as every other call, pinned to your key's provider — the gateway can never swap your injected key for another vendor's.

Swap the judge per run without touching the task: the job's `verifier_env` slot honors exactly two keys — rewardkit's own override variables, the same pair Harbor users set with `--ve`. `REWARDKIT_JUDGE` overwrites the rubric's `[judge].judge` field; `REWARDKIT_MODEL` overwrites its `[judge].model` field when the judge is an agent (e.g. `claude-code`, `codex`). Both are delivered into the verifier environment in both verifier modes, over any value the task declared under the same name, and derived jobs (resume, retry) inherit the pair verbatim. Every other `verifier_env` key is refused at create, naming this pair.

```python
job = await evals.start(
    datasets=[{'name': 'judged-swe'}],
    agents=[{'name': 'codex', 'model_name': 'gpt-5.5'}],
    verifier_env={
        'REWARDKIT_JUDGE': 'claude-code',
        'REWARDKIT_MODEL': 'anthropic/claude-sonnet-4-6',
    },
)
```

From the CLI it is Harbor's own flag: `--ve REWARDKIT_JUDGE=claude-code --ve REWARDKIT_MODEL=anthropic/claude-sonnet-4-6`.

The judge's money is measured at the gateway off its own key — never taken from anything the verifier reports — and itemized apart from the agent's everywhere: `judge_result` / `judge_spend_source` on the trial, `stats['judge_cost_usd']` on the job (a share of `stats['cost_usd']`, which is the whole bill). Works in both verifier modes. Judge-enabled tasks are not regradable yet — the regrade lane refuses them with a typed error instead of re-scoring without a judge.

### Multi-step tasks

A task can walk the agent through **ordered steps in one shared environment**. The layout is the task format's own: a `steps/` directory holds one sub-directory per step in place of the root `instruction.md`, `tests/` and `solution/`, and a `[[steps]]` entry in `task.toml` declares each step in order. `environment/` stays at the root — the environment is built once and shared, and the container filesystem persists from step to step, which is how later steps build on earlier work.

```
tasks/migrate-then-prove/
├── task.toml                # [[steps]] entries, one per step, in order
├── environment/             # built ONCE, shared by every step
│   └── Dockerfile
├── tests/                   # optional shared helpers every step's verifier can use
└── steps/
    ├── 01-migrate/
    │   ├── instruction.md
    │   ├── tests/           # this step's verifier files, merged over the shared tests/
    │   └── workdir/         # optional files landed before the step; its setup.sh runs first
    └── 02-prove/
        ├── instruction.md
        └── tests/
```

Each step carries its own instruction, its own verifier (`tests/` merged over the task-level `tests/`), an optional `workdir/` upload whose reserved `setup.sh` runs before the step's agent starts, its own [readiness healthcheck](#healthchecks-and-the-agent-user), its own `[steps.agent]` / `[steps.verifier]` `timeout_sec` overriding the task-level values, its own `[steps.verifier].env` (the [judge-credential templates](#llm-judges) included), and its own per-step `artifacts` list. The step's verifier runs when the step ends, so a multi-step trial produces one verifier result per executed step.

```toml
multi_step_reward_strategy = "mean"    # "mean" (default) or "final"

[[steps]]
name = "01-migrate"
min_reward = 0.5                       # score below this and the trial stops here

[[steps]]
name = "02-prove"

[steps.agent]
timeout_sec = 600                      # this step's override of the task-level timeout
```

Two declarations shape the score. **`multi_step_reward_strategy`** rolls the per-step results into the trial's reward: `"mean"` — the default — takes per-key means across the steps that produced a verifier result, and `"final"` takes the last executed step's result verbatim. **`min_reward`** on a step ends the trial early when the step under-scores: a number gates the primary `reward` key, a map gates each named key. Separately from both, a step that raises without producing a verifier result ends the trial where it stands — later steps never run — and a step whose healthcheck fails does the same.

What each step recorded lands on the trial as `step_results`, in execution order: the step's name, its verifier result, its timing pairs, and its exception when the step raised. A trial that stopped early carries only the steps that ran; a single-step trial carries null there — "this trial has no steps", never "it ran zero of them" ([Types](#types)). An [automatic retry](#automatic-retries) restarts the whole trial from the first step in a fresh environment — there is no partial-step resume.

Three per-step declarations are refused at import with the reason named rather than approximated: a per-step `user`, per-step network declarations, and a per-step verifier environment or mode — every step inherits the task-level [verifier mode](#verifier-modes) and runs against the task's one environment. And the two halves of the layout must agree, both ways: `[[steps]]` without a `steps/` directory, a `steps/` directory without `[[steps]]`, and a `steps/` sub-directory no entry declares are each named at import — a step nobody declared must not sit on disk looking like it runs.

### Task environment variables

A task's `[environment.env]` table is honored, and its two value kinds do different things:

```toml
[environment.env]
APP_MODE = "ci"                        # literal — lands in the box as written
GITHUB_TOKEN = "${GITHUB_TOKEN}"       # template — a secret THIS job must attach
LOG_LEVEL = "${LOG_LEVEL:-info}"       # template with fallback — the attached value, else "info"
```

A **literal** value is delivered into the agent's environment exactly as written — it is dataset content, readable by everyone the dataset is published to, so it must never be a secret. A **template** — `${VAR}`, the whole value, nothing around it — is a request for a secret. The task format resolves templates from the environment of the machine that launched the run; a managed trial has no such machine, and the obvious substitute — reading `VAR` from your vault — is one this platform deliberately refuses. A dataset and the job running it routinely belong to **different people**: a public `task.toml` could declare `X = "${AWS_SECRET_ACCESS_KEY:-none}"`, a vault lookup would hand that dataset's author your live credential, and the fallback would hide that it ever happened. So a template resolves only against the secrets **attached to the job** — the `secrets` slot on the job body ([Shape and ceilings](#shape-and-ceilings)), the same [env secrets](#env-secrets) the CLI attaches with `--secret`. Attaching is one deliberate act per secret per job — this platform's translation of exporting the variable in your own shell.

The mechanics: a template matches an attached secret by its **env name** — the attachment's `as`, defaulting to the secret's stored name — so `as` lets a vault entry called anything satisfy a task's `${GITHUB_TOKEN}`. `${VAR:-default}` is the attached value when the job carries one and the literal default when it does not — safe under attachment, because the fallback can only ever substitute for a secret you chose not to attach. A job that cannot satisfy a selected task's templates is refused at create as the typed `secret_not_attached`, naming the variable — never accepted and then failed per-trial. And only a whole-value template is a reference — the format's own rule. A value that embeds `${...}` inside a larger string is refused at import: this platform does not interpolate inside strings, and storing the value as a literal would deliver the template text itself into the box. Write the reference as the whole value, or state a literal.

One delivery boundary to know: the table is delivered when the agent starts, not at container creation, so the agent and every process it spawns read the variables — a build step does not, while [the image's supervised start process](#healthchecks-and-the-agent-user) receives the literal values overlaid on the image's own config `Env`. And a [readiness healthcheck](#healthchecks-and-the-agent-user) sees the table only in one task shape — the split is spelled out in that section.

### MCP servers

A task can hand its agent MCP tools: `[[environment.mcp_servers]]` entries are registered into the harness's **native** MCP configuration alongside any servers the arm itself carries, so the agent discovers them the way that harness discovers any MCP server.

```toml
[[environment.mcp_servers]]
name = "docs-search"
transport = "streamable-http"          # or "sse" (the default when omitted); "http" is accepted as a spelling
url = "http://mcp-server:8000/mcp"     # a compose service — reachable with no egress

[[environment.mcp_servers]]
name = "sqlite"
transport = "stdio"                    # launched inside the box by the harness
command = "uvx"
args = ["mcp-server-sqlite", "--db-path", "/app/data.db"]
```

A `stdio` server declares a `command` (and `args`); the harness launches it as a child process, so it inherits the task's [`[environment.env]`](#task-environment-variables) variables — there is deliberately no `env` field on a server, because one door into the box's environment is enough. A remote server (`sse`, `streamable-http`) declares an `http`/`https` `url`; a credential written into the URL's authority (`user:token@host`) is refused at import, because a `task.toml` is published content and a secret in it is a published secret.

A remote server must also be **reachable under the task's own declarations**, and that is checked at import rather than discovered as a dead tool at run time. Three shapes pass: a URL addressing the agent's own container (the `localhost` family — something the task's image starts itself), a URL addressing a [compose service](#what-runs) by name (resolved inside the sandbox, no egress involved), and a public host the task's [network policy](#network-modes) admits — `public`, or an `allowlist` naming the host (IPv4 and CIDR entries match IP-addressed URLs). Anything else is refused naming the server and the contradiction — an agent that meets a dead endpoint scores as if the tool simply did not help, which is the silent failure the refusal exists to prevent. One limit is named rather than papered over: a `stdio` command's own network use cannot be read off a string at import, so a stdio server that fetches itself from a package index (`npx …`, `uvx …`) imports under a `no-network` task and then fails at run time when the sealed box refuses its download — bake such servers into the task image.

### Healthchecks and the agent user

The image's own start command and two `task.toml` declarations govern the box the agent lands in — what is running when the agent arrives, when it is ready, and who the agent is inside it.

**The image's `ENTRYPOINT` runs.** A task image that starts a service — a database, an HTTP API, a daemon the instruction assumes is listening — runs it here exactly as upstream's Docker start would: the start command is resolved at import from the image's own configuration (a built task's after the build, a prebuilt `docker_image`'s from its registry — inherited entrypoints, shell forms, and a `${BASE}` build argument with a default all resolved the same way), and the platform launches it inside the box as a **supervised process** before the agent is installed, under the image's config `Env` overlaid with the task's [`[environment.env]`](#task-environment-variables) literals, at the config `WorkingDir`, as the config `User`. Keep-alive entrypoints start nothing, as always: `["sleep", "infinity"]`, a shell with or without login flags, `["tail", "-f", "/dev/null"]`, an empty `ENTRYPOINT`, and any of these behind a `tini`/`dumb-init` shim. An inherited `CMD` is deliberately not judged — every keep-alive convention replaces `CMD`, so `FROM python:3.12-slim` (whose `CMD` is `python3`) is not a service task. Supervised means watched: a process that exits before the agent starts fails the trial **typed**, with its exit code and last output — never an agent scoring against a service that silently died — and a process found dead *after* the agent ran is recorded on the trial rather than passing without a word. One shape still refuses at import with the reason named: a task that verifies in a **separate** box booted from an image whose config starts a process — the platform launches an image's start command in the agent box only, so the tests would run without whatever it serves. Verify in `shared` mode, or give the verifier its own `tests/Dockerfile` and reset the command there (`ENTRYPOINT []`). If a prebuilt image's registry cannot be read — an unreachable host, a private image, an image published for no `linux/amd64` platform — the import fails naming the image and the step, because "we could not look" and "there is nothing there" are not the same answer.

**`[environment.healthcheck]`** keeps a slow-starting environment from meeting the agent too early: the command runs after the environment starts and before the agent is installed, with Docker `HEALTHCHECK` semantics, and the agent starts only once it exits `0`.

```toml
[environment.healthcheck]
command = "curl -fsS http://localhost:8000/health"
interval_sec = 5           # every field below command is optional; these are the defaults
timeout_sec = 30
start_period_sec = 0
start_interval_sec = 5
retries = 3
```

Exit `0` ends the wait immediately. Inside `start_period_sec` a failure does not count toward `retries` and the next attempt waits `start_interval_sec`; after that grace, consecutive failures count and attempts are spaced by `interval_sec`, each attempt bounded by `timeout_sec`. Reaching `retries` fails the trial **before any agent spend** — a box that never became ready surfaces as an infrastructure failure with the check named, never as a zero that looks like a wrong answer. The whole gate is additionally bounded by a budget derived from the declared numbers, so a broken check cannot hang a trial. A [multi-step task](#multi-step-tasks) may declare one per step as well — checked after the step's `setup.sh`, before the step's agent.

One visibility rule before writing a check that reads your own variables: whether the command sees [`[environment.env]`](#task-environment-variables) depends on the task's shape. On a **multi-container** task the literal values are visible — they ride the compose bring-up the check executes under. On a **single-container** task they are not: the table is delivered with the agent, which does not exist yet when the check runs. Template (`${VAR}`) values are visible to no healthcheck in any shape — a secret is never written where it could outlive the credential seal. Point the check at the service, not at the env table.

**`[agent] user`** declares who the agent runs as:

```toml
[agent]
user = "dev"
```

The agent — and only the agent — runs as that user: `whoami` inside the agent's session prints `dev`, while everything the platform does around it (environment start, verification, artifact collection) keeps the box's default. The user must exist in the task's image — create it in the Dockerfile (`RUN useradd -m dev`) — and a preflight proves the account, its home, and the switch itself before the agent starts, so a missing user is a typed infrastructure refusal before any model spend, never an agent that silently ran as root against a task that asked for someone else. Declare a **name**, not a bare uid — a numeric uid is refused at import so the agent gets its own home. Omitted, `root`, and `0` all mean the image's default — and the image's default is honored: an `environment/Dockerfile` whose final stage sets a non-root `USER` imports, and that user **is** the agent's user when `task.toml` declares none, delivered through the same in-box switch and proven by the same preflight (upstream's own rule — its container exec carries no `-u` flag, so the image's `USER` applies). An explicit `[agent] user` wins over the Dockerfile's, `root`/`0` included. Two Dockerfile `USER` forms the switch cannot honor refuse at import naming the file: a numeric uid (declare the user by name so the agent gets its own home) and a `USER app:group` form (the switch enters the account with its primary group). `[verifier] user` stays a refusal with the reason named — the verifier always runs as root here.

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
    sandbox_provider='daytona',   # "e2b" | "daytona" (default) | "modal"
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

- **Daytona's allowlist carries one kind of entry per sandbox, and the task's shape picks the kind.** A single-container task gets the IP list: IPv4 addresses and CIDRs, capped at 10 entries — a cap that also has to fit the address the agent uses to reach its model, so the task's own list gets slightly fewer — and an `allowlist` naming a hostname fails on Daytona when the sandbox is created. A multi-container task gets the hostname list instead, because its images are pulled from registry hostnames and Daytona will not carry an IP list and a hostname list on the same sandbox: its `allowlist` must name hostnames (a `*.` prefix wildcard covers a domain and its subdomains), capped at 20 entries that also have to fit the model address and the registry endpoints, and there an IP or CIDR entry is what fails at creation. Either failure names the entry and the fix. Run what Daytona refuses on e2b or Modal, which serve both kinds together. Daytona serves `no-network` and `public` normally.
- **Modal caps every sandbox at 24 hours.** A task whose timeout exceeds the cap fails fast when its sandbox is created — never truncated mid-run.

### GPU tasks

A task can declare GPUs the same way it declares CPUs — `gpus` and `gpu_types` in its `task.toml` `[environment]` section, the standard task-format fields. The catalog shows the requirement on every task (`task.gpus`, `task.gpu_types`; `gpu_types` `None` means any type is acceptable), and the platform pays for GPU compute at launch — a GPU trial draws your credits for its model calls exactly like any other, never for the GPU itself.

Modal is the provider that reserves GPUs today, so a GPU task **runs on Modal no matter which provider the job picked** — e2b offers no GPU machines at any tier, and this Daytona tier provisions none (the platform re-checks Daytona's live quota on a timer, so a raised tier turns Daytona GPU on without a release). That re-route is a recorded fact, not a silent one, in three places:

- The task's `providers` verdict says it up front: `TaskProviderVerdict(ok=True, degrades_to='modal', reason=…)` on a provider that would hand the trial to Modal. `ok` keeps its meaning — a job stamped there still runs the task.
- The trial says where it actually ran: `trial.sandbox_provider` is the outcome, and `trial.sandbox_provider_degrade` carries `{'from', 'to', 'reason'}` when it differs from the job's request. Every other trial answers `None` there.
- The [capability document](#what-the-platform-supports) publishes each provider's `gpus` block (supported, per-container ceiling, where it degrades and why) and the platform-wide `gpu_concurrency_cap`.

Because GPU compute is platform-paid, the fleet runs a **GPU concurrency cap**: at most `gpu_concurrency_cap` GPU trials in flight at once, across all jobs. A queued GPU trial past the cap simply waits for a slot — it is never refused for waiting. A GPU count no provider can allocate (above Modal's per-container ceiling) is refused at import with the numbers, so such a task never reaches a job at all.

**What the GPU time was worth.** Every settled GPU trial states its compute as an estimate: the measured sandbox lifetime (observed boot to observed kill) multiplied by a versioned rate card — the provider's own published list price per GPU-second, with the pricing page and the date it was read recorded on the figure. It arrives as `trial.gpu_cost` (a dict with the wire's own keys) and, summed per job, as `stats['gpu_cost_usd']`, and it is deliberately a **separate labeled figure**: it is never added into `agent_result.cost_usd` or `stats['cost_usd']`, which are metered model spend. When no honest number exists the platform says so instead of guessing — `gpu_cost['unpriced_reason']` names why (a run whose worker died has no measured lifetime; a task that accepts *any* GPU type has no single list price) and `estimate_usd` stays None. A GPU trial that provably never booted a sandbox reports a real `estimate_usd: 0`. Non-GPU trials carry no `gpu_cost` at all — CPU sandbox time is not priced today. The CLI shows the same pair: `evolve trial show` prints a `gpu compute (est.)` row with the full audit sentence, and `evolve job show` prints the job's summed estimate beside — never inside — its `spent` row.

### Not yet supported

Three task shapes the platform does not run today. The last is **refused at import**, with the declaration and the reason named, because a task that runs without it would score a zero that looks exactly like a wrong answer. The first two are shapes nothing in the task package identifies, so they import and run — the limit is recorded here rather than enforced, and it is a real one. (Service images started by the `ENTRYPOINT` and non-root Dockerfile `USER`s, both refusals in earlier releases, now import and run — see [the box the agent lands in](#healthchecks-and-the-agent-user).)

- **Computer-use and desktop tasks.** Nothing in the task package marks a task as computer-use: upstream it is a run-time choice of agent and environment, not a task-config field, and a category or tag is free-form author text. A task whose instruction assumes a desktop imports and runs, and a coding agent with no display scores zero on it. Only the pieces such a task usually also declares are refused by name — `[environment].os` other than Linux.
- **Run-level trajectory seeding.** Upstream's `--load-trajectory` / `--resume-trajectory` is a *run* input — a job flag naming a recorded session or ATIF file — and no job surface carries it here yet: such a run starts fresh, exactly as upstream runs the same task without the flag (a trajectory file shipped inside `environment/` is a demonstration artifact, which upstream's own examples say in their `task.toml`). **Task-level** seeding, by contrast, is supported: a `trajectory.json` beside `instruction.md` (or in the first step's directory of a multi-step task) is validated at import as a strict ATIF document and seeded into the agent's session before the run, on the harnesses that can load one — `claude` and `codex`, upstream's own capability set. On any other harness the trial refuses **typed, before any model spend**, naming the harness. `[agent] load_trajectory` / `resume_trajectory` keys in `task.toml` refuse by name — they are trial-level fields upstream too, silently ignored by its task config; the task-level spelling is the file, not a key.
- **Verifier scripts whose PEP-723 header needs a package index.** A `# /// script` header asks `uv` to build the script's environment at verify time. When the verifier runs in a sealed box — a `separate` verifier whose resolved [verifier policy](#network-modes) is `no-network`, or a `shared` verifier on a `no-network` task — there is no index to reach, and the refusal names what the box can actually resolve: a task that requests an LLM-judge credential gets an offline bundle carrying `harbor-rewardkit` and its `litellm` dependency, and a task that requests no judge gets no bundle at all and can resolve nothing. Two cases are deliberately left alone: a verifier, in either mode, whose box runs under `allowlist` or `public`, which granted the network its header needs and resolves exactly as it does upstream; and a `tests/` tree where no file invokes `uv run` or `uvx`, where the header is inert metadata that plain `python3` ignores.
---

## Bring your own dataset

Any corpus in the task layout runs on the hosted stack: point at it, publish it, run it. A corpus in another format gets converted *into* the layout first — it is small, and a complete task fits on one screen (below).

What you publish is **private to your account**. It never appears in anyone else's catalog, and another account asking for its name reads a plain `404 dataset_not_found` — existence is never leaked. Your own `catalog.list()` shows the shared platform datasets plus your own. A name belongs to its first publisher: re-publishing a name you own extends that dataset with a new version, while publishing a name owned by anyone else — a platform dataset or another account's private one — is refused with a `409 dataset_name_taken`.

### Publishing

Publish from a git repository pinned to a ref, upload a local corpus directory, or hand the platform a fetchable source — a public tarball URL or a Harbor hub package ([below](#publishing-from-a-fetchable-source)) — the same corpus, the same pipeline, the same rules every way.

A git ref must be **pinned**: a full 40-hex commit sha, or a tag. A tag is resolved to the commit it points at when the publish is accepted, the sha is stored, and the import verifies the tag still points there — a tag re-pointed in between fails loudly instead of importing different bytes. A branch name is refused with `unpinned_git_ref`, and the refusal's `details` carry the commit the branch points at right now, so pinning it is one copy-paste:

```python
# From a git repository, pinned to a ref
publish_job = await catalog.publish(
    git_url='https://github.com/acme/my-swe.git',
    git_ref='v1.0.0',             # a tag or a full commit sha — always PINNED
    name='my-swe',
    version='1.0',                # the version label for the published corpus
)

# A corpus living in ONE SUBFOLDER of a bigger repository: add git_path.
# The server fetches just that folder (git sparse checkout) and imports it as
# the corpus root. The path is POSIX, relative to the repository root; a path
# that is not a directory at the pinned ref fails the import loudly.
subfolder_publish = await catalog.publish(
    git_url='https://github.com/acme/benchmarks.git',
    git_ref='v2.1.0',
    git_path='datasets/my-swe',
    name='my-swe',
    version='2.1',
)

# From a local directory — tarred + gzipped deterministically on the client and uploaded
local_publish = await catalog.publish(
    directory='./my-swe',
    name='my-swe',
    version='1.0',
    # (optional) client-side upload progress, measured on the stream itself
    # as archive bytes flush onto the wire — no server call. Fires per chunk
    # from the uploader thread; keep it cheap and throttle any rendering.
    on_upload_progress=lambda sent_bytes, total_bytes: print(f'upload {sent_bytes}/{total_bytes}'),
)

# Everything in the directory is packed, dotfiles included ('.gitignore',
# '.dockerignore', '.env.example', '.config/'), and an executable script stays
# executable. Only '.git', '.DS_Store' and '.venv' are left out, and symlinks
# are never packed. The same directory always produces the same bytes, so the
# tarball's sha256 — the version's source identity on the server — is
# reproducible.

# Size changes the transport, never the result: an archive over 256 MiB
# rides a resumable chunked upload automatically (6 MiB verified chunks —
# Harbor's own chunk size — with the whole-archive sha256 checked
# server-side at the end), so a dropped connection resumes from the last
# acknowledged chunk instead of restarting a multi-GB transfer from zero.
# Nothing to configure and no new flag: the same publish() call, the same
# 202 back.
#
# A rate limit mid-transfer is a delay, not a failure: a 429 or 503 on any
# request of the chunked door is waited out — the server's Retry-After,
# never more than 60 s per wait — and the same chunk goes again from the
# same offset, at most three waits per request. Only a limit still standing
# after those waits ends the publish, as the typed EvolveAPIError it is.

# A chunked publish that names its version explicitly also REGISTERS FIRST:
# the import exists — pollable, listed, visible on the dashboard — from the
# moment the upload session opens, not only when the last byte lands. While
# the corpus is still streaming it reads status QUEUED with
# receiving=True (the marker drops to False the instant the upload
# completes and the publish is accepted), and the id is handed to you right
# away through the optional on_registered callback (fires from the uploader
# thread, like on_upload_progress) — the SAME id the 202 carries at the
# end, so a watcher can attach mid-upload, from this process or any other
# machine (`evolve dataset watch <id>`):
#
#   on_registered=lambda import_id: print(f'watch it: {import_id}')
#
# Nothing is registered when the corpus manifest supplies name/version (the
# server cannot know them before the bytes arrive) or when that version
# label already has a row — the publish then appears at the 202, exactly as
# before. A registered upload that is abandoned (deleted, or expired) takes
# its pre-arrival import with it: watchers get not-found, never a
# forever-QUEUED ghost.

# Block until the publish SETTLES: the version READY (at least one task
# built — and, on a dataset you own, already the ACTIVE one) or FAILED.
# COMPLETED means READY: the import IS the whole platform build, so the
# settle phase is one confirming read.
done = await catalog.watch_import(
    publish_job.id,
    on_status=lambda imp: print(imp.status, imp.task_count),
    # Live build progress, at the server's own write cadence (phase
    # boundaries + coarse intervals): the current phase of five —
    # extracting | parsing | building | copying | verifying — per-phase
    # done/total, banked-vs-new image counts, and the publish's CodeBuild
    # copy-build minutes.
    on_progress=lambda p, imp: print(p.phase, f'{p.phases[-1].done}/{p.phases[-1].total}'),
    on_version=lambda v, d: print(v.state),
    poll_interval_s=2.0,          # (optional) default 2s
    settle_timeout_s=1800.0,      # (optional) settle-phase backstop, default 30min
)

# The settled record stays on the import: wall-clock per phase
# (started_at/completed_at on each entry), images built / mirrored / banked
# (banked = already in the registry, nothing copied), CodeBuild copy minutes.
print(done.progress.images if done.progress else None,
      done.progress.codebuild if done.progress else None)

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

`get_import(id)` is the single read behind the import phase — status, `task_count`, `failure` once there is one, and `warnings`. `watch_import()` polls it to a terminal import status, then keeps polling `get()` until the version settles (the settle phase above), so reach for `get_import()` when you drive your own scheduler. A terminal import stays readable, id included, for as long as its dataset exists — deleting the dataset takes its import records with it, and a later `get_import` answers the same not-found as an id that never existed.

A watch whose settle read cannot land ends with the typed `ImportSettleError` (`code='settle_timeout'`) when the `settle_timeout_s` backstop elapses — a bound on the wait, not a verdict on the publish, and rare by construction: `COMPLETED` means the version is `READY`, so the settle phase normally confirms in one read. The same deadline bounds the watch's 429/503 patience, so a server that answers nothing but rate limits still ends the wait typed instead of hanging it. When the error's `state` reads `FAILED` the version did settle and the budget was spent retrying the final import read through rate limits — read the failure with `get_import(import_id)`. The error carries the last observed `state`.

`warnings` is worth reading even on success: an import whose warnings include `no_solutions_archived` produced a version that permanently lacks its reference-solution record — the record operator verification tooling reads, never a gate. The version still publishes, activates, and runs; the warning exists so that permanent gap is visible instead of silent.

```bash
evolve dataset publish \
    --git https://github.com/acme/my-swe.git --ref v1.0.0 \
    --name my-swe --version 1.0 --watch
evolve dataset publish \
    --git https://github.com/acme/benchmarks.git --ref v2.1.0 --path datasets/my-swe \
    --name my-swe --version 2.1 --watch     # one subfolder of a bigger repository
evolve dataset publish --dir ./my-swe --name my-swe --version 1.0 --watch
```

A publish never has to be babysat by the terminal that started it. `evolve dataset watch` re-attaches to a publish and renders exactly the follow `--watch` renders (everything from the 202 on) — after the CLI exited, from another machine, or from a teammate's shell:

```bash
evolve dataset watch my-swe        # the dataset's newest queued/running publish
evolve dataset watch cmt9x…        # or the import id itself
```

Large uploads make the id available from the very start: an archive over the chunked-upload threshold registers its import the moment the upload session opens, the CLI prints `Registered import <id> — re-attach anytime with: evolve dataset watch <id>`, and until the corpus finishes arriving the import reads `QUEUED (receiving)` — visible in `dataset list`, `dataset show`, and the dashboard alike. A name with no live publish refuses and names the newest settled import instead; `--json` streams the same follow events as `publish --watch` — everything from the 202 on — opened with `import.attached`; the transfer's own `upload.progress` lines belong to the publishing process and never appear here. If the upload behind a receiving import is abandoned, the import is removed with it and the watch ends saying so — never a forever-QUEUED ghost.

The transfer itself reports as it goes, in both renderings. Human mode prints `upload <sent>/<total> (P%)` once per 10% of the archive; `--json --watch` prints the same steps as `upload.progress` events — `{"kind":"upload.progress","sent_bytes":…,"total_bytes":…,"elapsed_sec":…}`, at most eleven lines per publish, all of them before `import.created` — so a piped consumer watches a multi-GB corpus move instead of waiting blind for the 202. `sent_bytes` and `total_bytes` are the SDK's own upload counter, the numbers `on_upload_progress` hands you; `elapsed_sec` counts from the moment the corpus was handed to the SDK, packing and hashing included. Non-watch `--json` stays one document and prints no progress. Harbor's `harbor upload` shows the same M-of-N and elapsed columns in a live terminal display and has no machine-readable stream; the event is the recorded deviation, so `--json` holds on this verb too.

Every lane resolves to the same thing — a task-layout directory — and is held to the same rules. The corpus root is a directory whose `tasks/` subdirectory holds one directory per task, or the tasks directory itself. Provenance is recorded per lane on the version's `source`: `DatasetVersionGitSource(ref, commit, git_url, path)` for a git publish (the resolved commit), `DatasetVersionArchiveSource(digest)` for a directory (the sha256 of the exact uploaded bytes), `DatasetVersionArchiveUrlSource(archive_url, digest)` for a fetched tarball and `DatasetVersionHubSource(hub_package, digest)` for a hub package — every digest spelled `sha256:<hex>`. On the wire a publish is `multipart/form-data` — the SDK produces it for you — and uploads past the compressed-size cap are refused with a `413 import_too_large`. The metadata parts come first, so a name owned by someone else is refused with the `409` before the upload is received rather than after. A git source must be an `https://` url: the import runs on a worker with no ssh client, so `ssh://` and `git@` remotes are refused at validation rather than failing inside the job — for a private repository, put a token in the https url. A git publish may name one repository subfolder (`git_path` / `--path`) and the platform fetches just that folder via git sparse checkout — the subfolder becomes the corpus root, the recorded provenance keeps the path beside the resolved commit, and a path that is not a directory at the pinned ref fails the import loudly rather than landing an empty version.

### Pre-flight: check a corpus before uploading it

A directory publish runs a **pre-flight** first, automatically: the client collects just the corpus's metadata files — every task's `task.toml`, plus `dataset.toml` when the corpus ships one, a few kilobytes — and the platform runs the same parse guards and per-provider capability stamps the import runs, before any corpus byte moves. Refusals come back as the importer's own sentences, so what you fix is exactly what a real publish would have refused after the upload:

```bash
evolve dataset check ./my-swe    # standalone dry run: verdict per task, exit 1 on any refusal

evolve dataset publish --dir ./my-swe --name my-swe --version 1.0
# Pre-flight (importer harbor-import/16): 200 tasks — 198 ok, 2 refused
#   broken-task REFUSED: environment.docker_image "python:latest" is a mutable :latest tag — ...
#   pinned-verifier NOTE tests_dockerfile_not_built: tests/Dockerfile, if the task ships one, is not built: verifier image pinned — upstream semantics ...
#
# Nothing was uploaded. Fix the refused tasks, or pass --skip-preflight to publish anyway
# (a refused task then lands FAILED at import).
```

```python
answer = await d.preflight(directory='./my-swe')
answer.tasks_refused        # 0 when the corpus is clean
answer.tasks[0].providers   # where each task can run — GPU, sizing and network verdicts per provider
answer.tasks[0].notes       # typed notes the toml decides — a NOTE is not a refusal; the task imports
```

The answer is honestly partial: a `task.toml` alone cannot prove everything — the Dockerfile, the compose file and the tests tree are only read at import — so the reply names what it checked and what it deferred, and an all-ok pre-flight means "nothing decidable from the task configs refuses", not a guarantee the build succeeds. A `NOTE` is the other kind of answer: not a refusal but a fact the config alone already settles — today, that a `separate` verifier pinning a `docker_image` will boot that image as-is and never build a `tests/Dockerfile` (see [the task format](#not-in-the-task-layout-yet)); the same note lands on the task itself once it is published. Nothing is written by a pre-flight, ever. `--skip-preflight` uploads without the check; a git publish has nothing local to check and skips it naturally.

### Publishing from a fetchable source

Two more sources move **zero bytes from your machine** — the platform fetches the corpus itself. `archive_url` points at a public https tarball of a corpus directory; `hub_package` names a public package on the Harbor hub, in Harbor's own reference grammar:

```python
# A public tarball the platform downloads itself
from_url = await catalog.publish(
    archive_url='https://github.com/acme/my-swe/releases/download/v1/corpus.tar.gz',
    name='my-swe',
    version='1.0',                # both required: the fetch happens server-side, after the 202
)

# A Harbor hub package: org/name[@ref] — no ref means the latest tag, a number
# is a revision, sha256:<digest> pins exact content. name/version may be
# omitted: they default to the package's short name and its resolved revision.
from_hub = await catalog.publish(hub_package='cookbook/hello-world')
from_hub.name      # "hello-world"
from_hub.version   # "3" — the revision the reference resolved to
```

```bash
evolve dataset publish --from https://static.example/corpus.tar.gz --name my-swe --version 1.0 --watch
evolve dataset publish --from hub:cookbook/hello-world --watch
evolve dataset publish --from hub:cookbook/test@sha256:51b00e00… --watch   # digest-pinned
```

A hub reference is resolved when the publish is **accepted**, and the resolved content digest is what the platform later fetches by — the same pinning rule as a git tag, so a hub tag moved after your 202 can never deliver different bytes. A task package imports as a one-task dataset; a dataset package fetches every member task the hub pins by digest — and every fetched archive is verified against the hub's own digest with Harbor's exact content-hash recipe before anything lands. A reference the hub does not show — nonexistent, or private — is refused with `hub_package_not_found` (the platform reads the hub anonymously; private packages need credentials, which are not supported yet), and a hub that cannot be reached at accept time is `hub_unreachable` (502): nothing was created, retry the publish.

Both fetched sources are **public only**: `archive_url` must be https, resolve to a public host, and carry no credentials in the URL — authenticated sources are a planned follow-up. The fetched bytes pass exactly the validation and size caps an uploaded archive does, plus one earlier gate: where the source declares its size up front (the hub publishes per-file sizes; a server's `Content-Length` counts too), a corpus over the cap is refused before the download spends anything.

The tarball may wrap the corpus in one top-level directory — the shape every GitHub and GitLab archive URL and a `tar -czf <dir>` tarball produce — and the platform reads inside it, so a repository's archive URL publishes as-is:

```bash
evolve dataset publish --from https://github.com/harbor-framework/benchmark-template/archive/5cb860aab849e1b3a542beef82d50295212fc532.tar.gz --name template --version 1.0 --watch
```

The published version records where it came from: `dataset show template --json` answers `latest_version.source` as `{"kind": "archive_url", "archive_url": ..., "digest": ...}` (in Python, a `DatasetVersionArchiveUrlSource`), the digest being `sha256:<hex>` over the bytes that were fetched; a hub publish records a `DatasetVersionHubSource` with the reference as you gave it and the hub content hash the import was pinned to.

### The dataset manifest (dataset.toml)

A corpus that carries Harbor's dataset manifest — a `dataset.toml` beside the task directories or at the corpus root — imports what the **manifest** says, not what happens to be on disk:

- **The manifest drives selection.** Only the tasks it names under `[[tasks]]` are imported; a task directory it does not list is left out, and a task it names that the checkout does not contain fails the publish (`manifest_task_missing`) — a dataset must never silently import smaller under the same name.
- **Every pinned digest is verified.** Each `[[tasks]]` entry pins a `sha256:` content digest, and the platform recomputes it with Harbor's exact per-task content-hash recipe (same file set, same ordering, same `.gitignore` filtering). A mismatch fails the publish (`manifest_digest_mismatch`) naming every divergent task with the pinned and the computed digest — the corpus is not the one the manifest's author published, and nothing unpinned ever lands. `[[files]]` digests are held to the same rule.
- **Metadata lands with it.** The `[dataset]` description reaches the catalog row, and every version carries the manifest identity it imported under — `version.manifest` is a `DatasetManifestMetadata` (`name`, `version`, `description`, `authors`, `keywords`, `task_count`; `None` when the corpus had no manifest). `evolve dataset show` prints it under the dataset header.
- **A `metric.py` custom metric is refused** (`custom_metric_not_supported`): custom metric scripts are not supported yet, and importing a dataset while ignoring the script that defines its scoring would report numbers its author never declared.

The manifest also makes `name` and `version` optional for a **directory** publish — the platform derives the name from the manifest's `org/name` (the segment after the `/`) and the version from `[dataset].version`, and explicit values always win:

```python
# dataset.toml carries [dataset] name = "acme/my-swe", version = "1.0"
from_manifest = await catalog.publish(directory='./my-swe')
from_manifest.name      # 'my-swe' — derived from the manifest
from_manifest.version   # '1.0'
```

```bash
evolve dataset publish --dir ./my-swe --watch   # name/version from dataset.toml
```

A **git** publish still requires both: the repository is only cloned server-side after the publish is accepted, long after the 202 has promised a name.

What happens next:

- **Every task builds independently — the partial-publish model.** The publish accepts the whole corpus, and each task parses and builds on its own: a task that survives ends `READY`, a task that does not ends `FAILED` with a typed reason, and the other tasks are unaffected. This deliberately **supersedes the earlier all-or-nothing law**, under which one bad task failed the whole publish and no partial corpus ever existed — one broken Dockerfile no longer holds the other hundred tasks hostage. Parse-level refusals (schema/capability) land as per-task marks in the same vocabulary as build failures. The version fails wholesale only when **no** task survived (`all_tasks_failed_to_build`), on a corpus-level refusal (the manifest gates above), or on a platform-infrastructure failure.
- **Strict by design.** Every task-config field is either honored or the publish is refused with the field and reason named — a task never silently runs on weaker semantics than it declares. GPU declarations (`gpus`, `gpu_types`) are honored — see [GPU tasks](#gpu-tasks); a GPU count no provider can allocate is refused at import with the numbers. Multi-step `[[steps]]` tasks, `[environment.env]` variables, MCP servers, readiness healthchecks, and `[agent] user` all import and run — see [What runs](#what-runs).
- **Task images are built at import — the import is the whole platform build.** Dockerfile-defined environments are built once into the platform registry and multi-container service images are resolved and pinned — all before the version can complete, which is exactly why job creation refuses any version short of `READY`. Each sandbox provider builds its own boot artifact from those images lazily, at the first trial on it (cached provider-side for every trial after) — so the first trial on a new image legitimately takes 1–3 minutes longer. That is the provider build, not a hang.

`COMPLETED` is the import's terminal success, and it means `READY`: the build settled with **at least one task ready** — the version is runnable, visible in the catalog (`catalog.get('my-swe@1.0')`), and — on a dataset you own — already the dataset's **active** version. A publish is finished when its import completes: nothing else to call, and the bare name in a job already resolves to what you just published. On the version object, `task_count` counts the READY (runnable) tasks and `n_failed_tasks` the rest; when any task failed, the import carries the `tasks_failed_to_build` warning. A publish that fails wholesale — no task survived, a corpus-level refusal, or an infrastructure failure — lands the version in state `FAILED` with the structured reason on the import's `failure`, and changes nothing else: the dataset keeps serving whatever it served before. Job creation against any state short of `READY` is rejected with a `409 version_not_ready` naming it.

**Reading the per-task outcomes.** The dataset detail's `failed_tasks` lists every failed task of the shown version with its typed reason (`{code, step, message}` — the one failure grammar for parse refusals and build failures alike), and the per-task build route answers the full detail: the failing-step excerpt and the full build-log pointer. `evolve dataset show name@version` renders both the counts and the reasons; `evolve dataset publish --watch` prints every task's outcome once the build settles (outcomes are recorded in one step when the version settles, not streamed mid-build) and ends with the plain summary — `built N of M tasks — K failed to build` — instead of dying on the first failure.

**Running a partially built version.** A whole-dataset (or glob) job runs the READY tasks, and the job body says so plainly in `build_exclusions` — one entry per affected dataset with the sentence to show (`note`), the counts, and the sorted failed names; silent truncation is forbidden. `n_tasks_selected` is what the filters matched before any `n_tasks` cap and `n_tasks_ran` what actually ran, so the note has two forms: uncapped, "ran N of M tasks — K failed to build"; under an `n_tasks` cap, "selection matched M tasks: K failed to build: …; ran R (n_tasks cap)" — the run was short for two separate reasons and the sentence keeps them apart. Explicitly **naming** a failed task at job create refuses typed (`task_failed_to_build`), quoting the task's own build failure: the refusal's `details.failed_tasks` carries every named one as `{task_name, failure: {code, step, message}}` — the same entry shape as the dataset detail's `failed_tasks` — never a silent skip of a task you asked for by name. Fixing a failed task is a re-publish: versions are immutable, so the fix is a new version.

Reference solutions (`solution/`) are archived at publish when the corpus ships them — they are the version's permanent reference-solution record (the checkout is deleted after import), used by operator verification tooling. They gate nothing: a corpus that ships none, or only some, still publishes and activates, and the import's `warnings` say exactly which record the version will permanently lack (`no_solutions_archived`, `partial_solutions_archived`, or `solutions_archiving_disabled`).

One more warning is neither an absence nor a failure: `tests_dockerfile_not_built` names the READY tasks whose `tests/Dockerfile` the verifier never builds — their verifier image is pinned, or shared, exactly as Harbor runs them (see [the task format](#not-in-the-task-layout-yet)). Each such task carries the same fact as a `tests_dockerfile_not_built` entry on its `notes`, and `evolve dataset show` lists it in a NOTES column with the sentence below the table.

### Activating

What you publish is activated for you, so the reason to call this yourself is to point a dataset's bare name at a **different** version — back to an older one, or on to a version you published but did not keep as the default. It is one call, on a version you own:

```python
await catalog.activate('my-swe', '1.0')
```

```bash
evolve dataset activate my-swe 1.0
```

From then on `{'name': 'my-swe'}` in a job resolves to that version, and asking for the version that is already active succeeds without changing anything. A version still building refuses with the typed `409 version_not_ready` naming its state — nothing to do but let the publish finish, since it lands `READY` and active on its own. Activating is refused with `version_not_activatable` for a version in a dead state (`FAILED`, or archived).

### Getting your corpus back

The platform keeps the exact package a version was published from, and its owner can download it:

```python
data = await catalog.download('my-swe@1.0')            # bytes
path = await catalog.download('my-swe@1.0', to='.')    # saved file path
```

```bash
evolve dataset download my-swe@1.0 -o corpora/
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

`upstream` also carries the same provenance for the **active** version: `git_url` (userinfo stripped — an embedded token never reaches the wire), the requested `ref`, the resolved commit (`current_commit`), and the repository subfolder (`path`, `None` for the repository root). But provenance is not an active-version privilege — **every** version carries its own `source` object whatever its state, so a version that FAILED (which can never activate) still says exactly which bytes it imported. `source` is one dataclass per publish kind, each carrying its `kind` in the publish request's own words: `DatasetVersionGitSource` (`kind='git'`: `git_url`, `ref`, `commit`, `path` — for an annotated tag, `commit` is the peeled commit the clone landed on, never the tag object), `DatasetVersionArchiveSource` (`kind='archive'`: `digest`, an uploaded directory), `DatasetVersionArchiveUrlSource` (`kind='archive_url'`: `archive_url`, `digest`, a fetched tarball) and `DatasetVersionHubSource` (`kind='hub_package'`: `hub_package` as you gave it, `digest` — the hub content hash the import was pinned to). It is `None` only when nothing readable was recorded — a version published before provenance was kept, or an older `archive_url` / `hub_package` version whose locator was not stored at the time — never a fabricated value. Beside the provenance ride the watch fields: where the ref points now (`latest_commit`, `None` when the last check failed), `acked_commit` (the newest commit a local version already exists for), `moved` (the field a badge branches on), `checked_at`, `error` (why the last check failed — show "could not check", never "up to date"), and `auto_import`.

It is `None`, not "up to date", when the active version did not come from a git remote — an uploaded corpus, or one published before provenance was recorded. A version pinned to an exact commit sha serves its provenance with the watch at rest (`latest_commit`/`checked_at`/`error` `None`, `moved` `False`): a pin cannot move, and nothing checks one. A tag keeps the watch — a re-pointed tag is an update worth a badge. A failed check keeps the last known answer and sets `error`: a network blip should not quietly erase an update that is genuinely available.

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
            └── solve.sh            # reference solution, archived at publish
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

`tests/test.sh` — the verifier entrypoint. The reward file is the verdict, never the exit code: write a number in `[0, 1]` to `reward.txt`, or `reward.json` with the score under `"reward"` plus named sub-scores. When `reward.json` has no `"reward"` key but exactly one numeric value, that value is the score — the primary-reward convention. A `reward.json` carrying **several** named scores and no `"reward"` key is also a valid verdict: the trial settles `SCORED` with every named score recorded as its metrics and **no primary reward** — job aggregates skip the null primary, and the task's evals group is excluded from [pass@k](#passk) (a pass rate invented over partial credit would be worse than none):

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

`solution/solve.sh` — the reference solution, archived at publish for operator verification tooling (a correct one earns a `1.0`):

```bash
#!/bin/bash
sed -i 's/Helo/Hello/' /app/greet.py
```

That's the whole format. The rules that matter when converting:

- `task.toml`, `instruction.md`, and `tests/test.sh` are required — a task without `tests/test.sh` fails its import by name. `pre_artifacts.sh` is optional: write one when you want to decide exactly what the agent's work looks like on its way out of the sandbox (the one above turns it into a patch), and when it is absent the platform supplies a minimal collect step and the `artifacts` manifest carries the work instead. `tests/grader.py`, `tests/config.json`, and `tests/test.patch` have named roles, and any other file under `tests/` is carried onto the verifier beside them — a helper like `tests/test_pool.py` lands next to `test.sh` and is runnable from it.
- `tests/Dockerfile` is built for real exactly when Harbor would build it: a `separate` verifier whose own environment declares no `docker_image` — `[verifier.environment]` without one, or no such table on a task that builds from `environment/Dockerfile` — gets a verifier image built from `tests/`, so grader dependencies installed there are genuinely present. A `separate` verifier whose environment **pins** a `docker_image` boots that image as-is and the Dockerfile is never built, which is what Harbor does too: the pin may be the task's own image (the test files are then uploaded onto it) or a distinct verifier image (it owns `/tests`, nothing is uploaded — the shape the Harbor hub publishes, with the verifier image it built from that very Dockerfile). That distinct verifier image is honored on multi-container tasks too: the verifier runs in a plain container booted from it, beside — never inside — the task's compose project, which is what Harbor does with the same task. A `shared` verifier runs inside the agent box and never builds it either. The task imports on every one of these shapes; when the Dockerfile is present and not built, the task carries the `tests_dockerfile_not_built` note (in `dataset show`, on the task's `notes`, and in the import's `warnings`) — a dependency the recipe would install has to be in the image already, and the note is how you learn that before a verdict does.
- The environment is `environment/Dockerfile` (built at import), a pinned `docker_image`, or `environment/docker-compose.yaml` for multi-container tasks (the agent runs in the `main` service). Any valid public image reference works for `docker_image` — Docker Hub, GHCR, ECR Public, or any other registry a pull can reach without credentials — with the tag pinned, never `:latest`. A reference that does not parse as an image reference is refused at import with the reference named; a reference that parses but cannot be pulled surfaces as an infrastructure error naming the pull, never as a task that quietly scores zero.
- Timeouts are optional: agent defaults to 3600 s, verifier to 600 s, both published as `limits['job']['default_agent_timeout_sec']` and `default_verifier_timeout_sec`. A declared `timeout_sec` always wins — the corpus is the authority on how long its own task needs, and the fallback never shortens one.
- `solution/` (`solve.sh`, or a `solution.patch` to apply) is archived at publish as the version's permanent reference-solution record — it gates nothing. A corpus that ships none anywhere (or only some) still publishes and activates; the import's `warnings` name the missing record — see [Publishing](#publishing).

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
evolve agent add acme-cli \
    --install-script ./install.sh \
    --run "acme-cli --headless" \
    --agent-env ACME_PROFILE=bench
evolve agent list
evolve agent show acme-cli
evolve agent remove acme-cli
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
| `QUEUED` | Accepted; the row exists and nothing has started. Covers two moments, told apart by `receiving`: `True` = a register-first upload whose corpus is still streaming (the platform waits on the client), `False` = waiting for a worker |
| `RUNNING` | The whole build: clone/extract, parse, image builds into the platform registry |
| `COMPLETED` | Terminal — the version is `READY` (built, runnable, and on your own dataset already active) |
| `FAILED` | Terminal — read `failure` |

A terminal import stays readable. A successful import used to start answering `404` the moment its version was superseded, telling a watcher holding a week-old id that the import never happened — it `COMPLETED`, and the catalog moving on afterwards does not unmake that. The one import that CAN vanish is a `receiving` one whose upload was abandoned: nothing was ever published, so the row is removed and a watcher reads not-found.

**Dataset version** (`DatasetVersion.state`) — the catalog's lifecycle, distinct from the import's statuses above:

```
DRAFT → RECEIVING → IMPORTING → BUILDING → READY
```

`RECEIVING` is the register-first pre-arrival state — the row a chunked upload creates at its session open, so a multi-GiB publish is visible while it streams; it moves to `IMPORTING` the moment the upload completes and the publish is accepted, and an abandoned upload removes it.

with `FAILED` and `ARCHIVED` as off-ramps: a failed parse or image build lands `FAILED` (the structured reason on the import's `failure`), and `ARCHIVED` shelves a version that has been moved past. `BUILDING` is the whole build — parse, task images into the platform registry — and every task builds independently (the partial-publish model, which supersedes the earlier all-or-nothing law where `READY` meant every task image was in the registry): `READY` now means the build settled with at least one task ready, `task_count` counting the runnable tasks and `n_failed_tasks` the rest. It is the only state that accepts jobs — a job on a partially built version runs the READY tasks and says so in `build_exclusions`; and on a dataset you own the same step that lands it also makes it the one bare names resolve to, with nothing left to call. Each sandbox provider builds its own boot artifact from that image at the first trial on it (cached provider-side for every trial after), so nothing per-provider is built at publish. [`activate()`](#activating) is how you later point that name at a different `READY` version. The one exception is a platform-curated dataset, which has no owner: its versions land `READY` but wait for an operator to promote them, since its default is not any account's to move.

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

@dataclass
class UsageReading:                               # the one-home usage reading — same keys on session surfaces
    provisional: bool                             # True while every number can still grow
    spent_usd: Optional[float]                    # None = the money was never measured
    input_tokens: Optional[int]                   # INCLUDES the cached share
    cached_input_tokens: Optional[int]
    output_tokens: Optional[int]
    as_of: Optional[str]                          # when the reading was taken
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
    skills: List[str]               # skill references — identity too; git refs pinned at create
    skill_locks: Optional[List[SkillLock]]  # what actually mounted; server-stamped, echo-only

@dataclass
class SkillLock:                    # provenance of one mounted skill
    name: str
    source: str                     # the pinned reference the content came from
    digest: str                     # "sha256:<hex>" over the folder
    git_url: Optional[str]
    git_commit_id: Optional[str]

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
    worst_case_spend_usd: float     # cap × trials × (max_retries + 1) — stated, never left to you
    retry: JobRetryConfig           # the RESOLVED auto-retry policy, every field present
    analyze: Optional[AnalyzeConfig]  # the resolved embedded-analysis policy; None = the create named none
    timeout_multiplier: float       # the RESOLVED global multiplier (1.0 when none sent)
    agent_timeout_multiplier: Optional[float]              # None = the global applies
    verifier_timeout_multiplier: Optional[float]
    agent_setup_timeout_multiplier: Optional[float]
    environment_build_timeout_multiplier: Optional[float]
    sandbox_provider: Optional[EvalSandboxProvider]  # None exactly on an uploaded job — nothing executed
    counts: JobCounts               # agents + tasks — entity cardinality only
    n_total_trials: int
    trials: TrialTally              # total + zeros-included by_status histogram
    stats: JobStats                 # counters, token totals, measured cost_usd, evals
    failure: Optional[JobFailure]   # never the key `error`
    source_jobs: List[SourceJob]    # provenance of a derived job; empty on originals
    is_regrade: bool
    upload: Optional[UploadProvenance]  # None on every job this platform executed
    idempotent_replay: bool
    started_at: str
    updated_at: str
    finished_at: Optional[str]      # None while live

@dataclass
class UploadProvenance:             # Job.upload — the ingest's provenance echo
    original_job_id: Optional[str]  # the archive result.json's own id; None = it stated none
    original_job_name: Optional[str]  # the archive config.json's own job_name
    uploaded_at: str
    reported_totals: Optional[ReportedTotals]  # the trials' REPORTED figures summed at ingest — never metered

@dataclass
class ReportedTotals:               # each total None when no trial reported it (a zero would be a claim)
    cost_usd: Optional[float]
    n_input_tokens: Optional[int]
    n_cache_tokens: Optional[int]
    n_output_tokens: Optional[int]
    n_trials_reporting: int         # against n_total_trials — the partial-reporting honesty count

class JobStats(TypedDict, total=False):   # the wire dict itself, keys typed; every key optional
    # Cumulative, Harbor-style: errored is a subset of completed, cancelled a
    # subset of errored; the disjoint breakdown rides trials.by_status.
    n_completed_trials: int
    n_errored_trials: int
    n_running_trials: int
    n_pending_trials: int
    n_cancelled_trials: int
    n_retries: int                        # consumed auto-retries, summed across trials
    evals: Dict[str, AgentDatasetStats]   # keyed agent__model(__effort)__dataset — dataset last
    n_input_tokens: Optional[int]         # cache included; None until recorded
    n_cache_tokens: Optional[int]
    n_output_tokens: Optional[int]
    cost_usd: Optional[float]             # the WHOLE model bill (agent + judge); None before any settled
    gpu_cost_usd: Optional[float]         # summed GPU compute ESTIMATE — separate, never inside cost_usd
    judge_cost_usd: Optional[float]       # the judge share of cost_usd; 0 with no judge tasks
    n_unmeasured_trials: int              # settled trials cost_usd cannot account for; a count, never None
    n_unmeasured_judge_trials: int        # the judge half of the same fact
    analysis: Optional[JobAnalysisStats]  # the trace-analysis aggregate; None = never analyzed

class JobAnalysisStats(TypedDict):        # stats['analysis'] — LATEST analysis per trial
    n_completed: int
    n_failed: int                         # stored typed failures, never silent absences
    n_pending: int
    cost_usd: Optional[float]             # the analyzer's own metered line — never inside cost_usd
    checks: Dict[str, Dict[str, int]]     # per criterion: n_pass, n_fail, n_not_applicable

class AgentDatasetStats(TypedDict, total=False):   # one evals group
    n_trials: int                         # trials that produced a rewards map
    n_errors: int                         # trials carrying exception_info
    metrics: List[Dict[str, Any]]         # a mean entry per arm today
    pass_at_k: Dict[str, float]           # k (as a string) -> value; {} = cannot answer
    reward_stats: Dict[str, Dict[str, List[str]]]   # reward key -> value -> trial ids
    exception_stats: Dict[str, List[str]]           # exception type -> trial ids

@dataclass
class PassAtKPoint:                 # one pass@k number
    k: int                          # how many attempts the estimate is over
    value: float                    # in [0, 1]

@dataclass
class PassAtKGroup:                 # one evals group's curve
    evals_key: str
    points: List[PassAtKPoint]      # ascending by k; never empty

def pass_at_k(job: Job) -> List[PassAtKGroup]:  # reads job.stats['evals'], sorted, numeric
    ...

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
class JudgeResult:                  # the judge half of a trial's model bill
    n_input_tokens: Optional[int]   # measured at the gateway off the judge key —
    n_cache_tokens: Optional[int]   # never anything the verifier reported
    n_output_tokens: Optional[int]
    cost_usd: Optional[float]       # the judge share alone; the trial's bill is the sum

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
    judge_result: Optional[JudgeResult]           # the judge share, itemized; None == no judge ever ran
    analysis: Optional[TrialAnalysis]             # the LATEST trace analysis; None = never analyzed
    environment_setup: Optional[TimingInfo]       # the four phase timing pairs
    agent_setup: Optional[TimingInfo]
    agent_execution: Optional[TimingInfo]
    verifier: Optional[TimingInfo]                # the COMMAND window alone; read against verifier_timeout_sec
    queue_wait: Optional[TimingInfo]              # finer pairs beside the four — not a partition of them
    harness_bundle: Optional[TimingInfo]
    image_prepare: Optional[TimingInfo]           # ~0 on Modal by design; its work lands in environment_setup
    shared_verify_setup: Optional[TimingInfo]     # shared-mode verify prep; ends where verifier begins; None otherwise
    harness_bundle_cache_hit: Optional[bool]      # True explains ms; False on minutes = a real build; None = unrecorded
    step_results: Optional[List[Dict[str, Any]]]  # per-step results, execution order; None =
                                                  #   single-step trial. Keys per entry: step_name,
                                                  #   agent_result, verifier_result, exception_info,
                                                  #   agent_execution, verifier
    spend_source: Optional[SpendSource]
    judge_spend_source: Optional[SpendSource]     # the judge figure's lane; None == no judge ever ran
    live_spent_usd: Optional[float]               # mid-run LOWER BOUND; cleared at settle
    usage: Optional[UsageReading]                 # the one-home reading — see Live cost and live tokens
    live_spend_at: Optional[str]
    max_trial_spend_usd: Optional[float]          # the cap THIS trial's key carried
    sandbox_provider: Optional[EvalSandboxProvider]
    gpu_cost: Optional[Dict[str, Any]]            # GPU compute ESTIMATE; keys: estimate_usd,
                                                  #   unpriced_reason (exactly one set), provider,
                                                  #   gpu_type (the device priced), declared_gpu_types,
                                                  #   resolved_gpu_types (what the request carried),
                                                  #   attached_gpu_type (the provider's reported pin),
                                                  #   gpu_count, duration_sec, rate_usd_per_gpu_sec,
                                                  #   rate_card {version, source, source_date},
                                                  #   measured_from, measured_to.
                                                  # None on non-GPU trials; never inside cost_usd
    sandbox_id: Optional[str]                     # agent box id; None when none booted
    verifier_sandbox_id: Optional[str]            # None in shared mode or before verify
    verifier_environment_mode: Optional[VerifierEnvironmentMode]
    attempt_phase: Optional[AttemptPhase]         # which step a RUNNING trial is in
    n_retries: int                                # auto-retries consumed; 0 = never retried
    retries: List[TrialRetry]                     # retired attempts, oldest first; [] = never retried
    session_ref: Optional[str]
    upload: Optional[TrialUploadProvenance]       # None on every trial this platform executed
    started_at: Optional[str]
    finished_at: Optional[str]

@dataclass
class TrialUploadProvenance:        # trial.upload — the archive's own record of THIS trial
    original_trial_id: Optional[str]   # the archive trial result.json's own id
    original_trial_name: str           # the trial directory the archive carried
    original_task_name: str            # VERBATIM, possibly org/name; task_name serves the leaf
    reported_agent_result: Optional[ReportedAgentResult]

@dataclass
class ReportedAgentResult:          # the uploader's OWN figures — REPORTED, never platform-metered
    n_input_tokens: Optional[int]
    n_cache_tokens: Optional[int]
    n_output_tokens: Optional[int]
    cost_usd: Optional[float]

@dataclass
class TrialRetry:                   # one retired attempt — the receipts a retry keeps
    attempt_number: int             # 1-based dispatch number within the trial
    exception_info: ExceptionInfo   # why that attempt failed
    cost_usd: Optional[float]       # REAL spend the job total includes
    started_at: Optional[str]
    settled_at: Optional[str]       # when its failure settled (and the retry was scheduled)

class RubricCriterion(TypedDict):   # Harbor's {name, description, guidance}, verbatim
    name: str                       # snake_case; keys the result's checks
    description: str
    guidance: str                   # what the analyzer is instructed with

class Rubric(TypedDict):
    criteria: List[RubricCriterion]

class AnalyzeConfigInput(TypedDict, total=False):  # analyze() kwargs, and start(analyze=...)
    model_name: str                 # Harbor's --model; default deepseek-v4-flash-vision
    rubric: Rubric                  # Harbor's --rubric; default reward_hacking + task_specification
    prompt: str                     # Harbor's -p/--prompt file text; default: the built-in analyze.txt
    reasoning_effort: str           # the arms' effort vocabulary (meta().analyze['reasoning_efforts']); default per model
    sandbox_provider: EvalSandboxProvider  # where the analyzer box runs; default: the platform's analysis default (daytona)

class AnalyzeConfig(TypedDict):     # the RESOLVED policy, echoed as Job.analyze
    model_name: str
    rubric: Rubric
    prompt: Optional[str]           # the prompt template as stored; None = the built-in
    reasoning_effort: str           # as stored when the create named one; else the model's default of the day
    sandbox_provider: EvalSandboxProvider  # as stored when the create named one; else the default of the day

class AnalysisCheck(TypedDict):     # one criterion's verdict — Harbor's QualityCheckModel
    outcome: str                    # 'pass' | 'fail' | 'not_applicable'
    explanation: str                # the analyzer's rationale, citing trial evidence

class TrialAnalysis(TypedDict):     # Trial.analysis — Harbor's AnalyzeResult + provenance
    id: str
    status: str                     # 'queued' | 'running' | 'completed' | 'failed'
    model_name: str                 # the pair THIS analysis ran under
    reasoning_effort: Optional[str]  # what the analyzer was asked for; None only on rows from before it was stamped
    rubric: Rubric
    prompt: Optional[str]           # the template THIS analysis ran under, frozen at enqueue; None = the built-in
    summary: Optional[str]          # 3–5 sentences; None until completed
    checks: Optional[Dict[str, AnalysisCheck]]   # keys exactly the rubric's criterion names
    estimated_cost_usd: Optional[float]  # the analyzer's OWN spend — never in the trial's bill
    usage: Optional[UsageReading]        # the one-home reading — ticks while it runs, provisional; settled figures stay estimated_cost_usd
    failure: Optional[AnalysisFailure]   # {phase, message}; non-None exactly when failed
    created_at: str
    finished_at: Optional[str]

@dataclass
class StopResponse:                 # trials().stop() — every id in exactly one list
    stopped: List[Trial]            # killed and settled, with their settled rows
    stopped_analyses: List[TrialAnalysis]  # stopped trace analyses (failed, phase 'stopped')
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
    type: str                       # "job.created" | "trial.settled" | "trial.retrying" | …
    data: Dict[str, Any]            # the payload, keys in the wire's vocabulary
    # trial.settled data: trial_id, task_name, status, reward (scored path),
    # exception_type + exception_message (failures; a cancel carries the type
    # alone), attempt_phase.
    # trial.retrying follows the trial.settled of the failure it retries — so
    # trial.settled is NOT final for a trial the retry policy may still re-run
    # (see Automatic retries). Its data: trial_id, task_name, retry (1-based),
    # max_retries, delay_sec, exception_type.

@dataclass
class Dataset:                      # datasets().list() / get(ref)
    name: str
    title: Optional[str]
    description: Optional[str]
    active_version: Optional[DatasetVersion]   # None = bare-name job refs refuse
    versions: Optional[List[DatasetVersion]]   # get() only, newest first
    selected_version: Optional[DatasetVersion] # get() only — the tasks' provenance
    tasks: Optional[TaskPage]                  # get() only; page with limit/cursor
    upstream: Optional[UpstreamStatus]         # provenance + watch; None = no git source, NEVER "up to date"
    created_at: Optional[str]                  # get() only
    updated_at: Optional[str]                  # get() only
    # ActiveDataset (get_active) is the same shape with version + tasks guaranteed

@dataclass
class DatasetVersion:               # one shape on every surface
    version: str
    state: str                      # the lifecycle above
    created_at: str
    task_count: int
    source: Optional[DatasetVersionSource]  # THIS version's provenance, per publish kind; None = nothing recorded

DatasetVersionSource = Union[       # served on EVERY version, active or not; one dataclass per publish kind
    DatasetVersionGitSource, DatasetVersionArchiveSource,
    DatasetVersionArchiveUrlSource, DatasetVersionHubSource]

@dataclass
class DatasetVersionGitSource:      # a git publish (kind == 'git')
    ref: str                        # exactly as requested: a sha, a tag, or (legacy) a branch
    commit: str                     # the RESOLVED sha — for an annotated tag, the peeled commit
    git_url: Optional[str]          # userinfo stripped; None only if the stored url is unparseable
    path: Optional[str]             # repository subfolder; None = repository root

@dataclass
class DatasetVersionArchiveSource:  # an uploaded directory (kind == 'archive')
    digest: str                     # sha256:<hex> over the uploaded bytes

@dataclass
class DatasetVersionArchiveUrlSource:  # a fetched tarball (kind == 'archive_url')
    archive_url: str                # the url as given
    digest: str                     # sha256:<hex> over the fetched bytes

@dataclass
class DatasetVersionHubSource:      # a Harbor hub package (kind == 'hub_package')
    hub_package: str                # the reference as given: org/name or org/name@ref
    digest: str                     # the hub content hash the import was pinned to

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
    receiving: bool                 # True = QUEUED with the corpus still uploading (register-first)
    name: str                       # dataset the import creates or extends
    version: str
    failure: Optional[DatasetImportFailure]    # never `error` on a 200 body
    warnings: List[ImportWarning]   # e.g. no_solutions_archived → no reference-solution record
    task_count: Optional[int]
    created_at: Optional[str]
    updated_at: Optional[str]

@dataclass
class JobImportSource:              # where an upload's archive came from
    type: str                       # "archive" (the uploaded bytes, sha256) | "archive_url" (the public https url the worker downloads) | "hub" (RESERVED — Harbor's hub job source; no door accepts it yet)
    sha256: Optional[str]
    url: Optional[str]
    job_id: Optional[str]

@dataclass
class JobImportProgress:            # the worker's own statement, written at phase boundaries only
    phase: str                      # "fetching" | "extracting" | "validating" | "ingesting"
    started_at: str
    phases: List[JobImportPhaseProgress]  # name, started_at, completed_at — None while a phase runs, and forever on the phase a FAILED import died in

@dataclass
class JobImportFailure:             # the upload codes (not_a_job_dir, invalid_archive, invalid_trial, …) plus import_failed / import_lease_expired
    code: str
    message: str
    details: Optional[Dict[str, Any]]  # e.g. existing_job_id on job_already_uploaded, trial on invalid_trial

@dataclass
class JobImport:                    # upload() returns it; get_import() / watch_import() / list_imports() read it
    id: str
    status: str                     # QUEUED | RUNNING | COMPLETED | FAILED — the same four words a dataset import speaks
    receiving: bool                 # True exactly while the archive is still arriving through its resumable session
    source: Optional[JobImportSource]   # None while a session is still receiving
    dataset: Optional[str]          # the dataset hint as given (name or name@version)
    job_id: Optional[str]           # the ingested Job, from COMPLETED on; None again if that job was deleted
    n_trials_uploaded: Optional[int]    # from COMPLETED on (Harbor's own spelling)
    failure: Optional[JobImportFailure]  # non-None exactly when FAILED
    progress: Optional[JobImportProgress]  # None until the worker's first report
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

[Regrades](#regrade) add `regrade_source_ineligible` (409 — the source trial recorded no verifier inputs; the message names why) and `no_regradable_trials` (409 — a whole-job regrade found nothing eligible). [Analyze](#analyze) adds `invalid_rubric` (400 — unknown keys named, empty or duplicate criteria, a criterion missing a field, or bounds exceeded), `analysis_already_running` (409 — one wave at a time; retry once the running wave settles), and `no_analyzable_trials` (409 — every trial `CANCELLED`). [Stopping](#stopping-work) adds `invalid_ids` (400 — a stop batch that is empty or over the 100-id cap).

[Uploading a job](#upload-a-job) answers 202 with a job import, so its deep refusals arrive on the import's `failure` rather than as HTTP statuses — the same codes, one hop later: `not_a_job_dir` (the archive is not a Harbor job directory: no `result.json`/`config.json` at its root, or they do not parse), `invalid_archive` (an unreadable tar, unsafe paths, links or devices), `invalid_trial` (one trial directory cannot be ingested; the failure names the trial and the reason), `upload_too_large` (the decompressed footprint over its cap, or an `archive_url` whose archive is over the compressed cap — settled on the first attempt, the download never repeated; distinct from `import_too_large`, which belongs to dataset corpora), `job_too_large` (more trials than the cap), `job_already_uploaded` (you already uploaded this archive's job, detected by the archive result.json's own id; `details` name the existing job), the dataset-hint codes, `import_failed` (an `archive_url` the server answers 4xx for or that redirects off public https — settled on the first attempt, never retried; or the platform's own transient failure — a timeout, a reset, a 5xx — after its attempt budget), and `import_lease_expired` (the worker was lost three times). The door itself still refuses typed: `upload_too_large` (413 — the declared or streamed archive over the compressed cap), `too_many_concurrent_job_uploads` (429 — the server is already moving its bound of archives into storage), and `invalid_input` (400 — two sources at once, a bad hint, an `archive_url` that is not public https). Reading an import someone else owns, or an unknown id, is `job_import_not_found` (404, never 403). `job_uploaded` (409) is resume, retry or regrade on an uploaded job, which is a record of a run that happened elsewhere; analyze is deliberately not among the refusers.

[Registered agents](#bring-your-own-agent) add their own: `agent_not_found` (also what another owner's name reads as), `agent_name_taken`, `agent_name_reserved` (the name collides with a built-in), `agent_source_required` (neither an install script nor a tarball), `agent_source_conflict` (both), `agent_invalid_env` (declared env tries to override a run-contract key), `agent_invalid_name`, `agent_too_large`, and `agent_limit_reached` (the per-account ceiling).

[Datasets](#bring-your-own-dataset) add `dataset_not_owned`, `dataset_in_use` (409 — jobs reference it; `details` names a sample), `package_not_retained`, `package_missing` (410), `upstream_not_watchable` (the auto-import toggle on a dataset with no moving ref), and `unpinned_git_ref` (a git publish whose ref is a branch name or otherwise not pinned — pass a full commit sha or a tag; for a branch, the refusal's `details.commit` is the sha to use).

Three more come from the shapes above: `idempotency_key_reused` (409 — the key already stands for a different request), `invalid_multipart` (400 — an upload that is not `multipart/form-data`, or is malformed), and `invalid_cursor` (400 — a malformed `cursor` on a paged read).
