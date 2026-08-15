# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY` (see [Getting Started → Gateway Mode](./01-getting-started.md#gateway-mode-evolve_api_key)). Evolve runs the tasks, agents, and verifiers on managed infrastructure — you start a job and read results.

Four nouns cover the whole surface, used everywhere and without exception:

- A **dataset** is a named, versioned set of tasks.
- A **job** is one run: datasets × agents × attempts.
- A **trial** is one attempt of one task by one agent. Trial ids are globally addressable — no call needs the job id to reach a trial.
- An **agent** is the thing that attempts a task: a harness plus a model. You can register your own.

Each noun has a client, plus one for identity — five standalone factories, no `Evolve` instance needed:

```ts
import { agents, auth, datasets, jobs, trials } from "@evolvingmachines/sdk";

const catalog = datasets();   // the shared dataset catalog
const mine = agents();        // your own registered agents
const evals = jobs();         // your jobs
const t = trials();           // globally addressable trials
const who = auth();           // identity: who am I, which key
```

All five read `EVOLVE_API_KEY` from the environment, or accept `{ apiKey, baseUrl }`. A hosted request never follows a redirect that would carry the API key somewhere else: the Python SDK refuses every HTTP redirect outright and surfaces the 3xx as the error it is, and the TypeScript SDK's `fetch` strips `Authorization` on any cross-origin redirect — either way, the key only ever reaches the host you configured.

If you would rather configure once, `hosted()` is the same clients behind one door:

```ts
import { hosted } from "@evolvingmachines/sdk";

const evolve = hosted();                       // or hosted({ apiKey, baseUrl })
const catalog = await evolve.datasets.list();
const job = await evolve.jobs.start({ /* … */ });
```

It is called `hosted()` rather than `evolve()` because `Evolve` is already the local-sandbox class in this package, and two exports a shift key apart doing unrelated things is a trap worth avoiding. The clients are built on first access, so `evolve.meta()` — the one call that needs no credentials — works before an API key is set.

Job and trial ids are UUIDs. Ids minted before the switch use an older alphabet and remain valid everywhere — every id-taking call accepts them — so treat ids as opaque strings and never parse their shape.

---

## Start a job

Pick datasets from the catalog:

```ts
const page = await catalog.list();                    // one page of datasets + active versions
for await (const dataset of catalog.list()) { /* … */ } // or walk the whole catalog

const deepSwe = await catalog.get("deep-swe@1.1");    // one version: task list + timeouts
const active = await catalog.getActive("deep-swe");   // active READY version, guaranteed runnable
// getActive() throws NoActiveVersionError when nothing is runnable yet
```

Every collection on this surface is the same page: `{ items, nextCursor, hasMore }`, paged with `{ limit, cursor }`. `nextCursor` means one thing everywhere — pass it back for the next page, and `null` means there is no next page. Both list calls hand you a value you can either await for a single page or iterate to walk every row, fetching pages as it goes. `list({ search })` filters the catalog by free text over name and description, server-side.

`READY` is the one dataset-version state that accepts jobs — see [Statuses](#statuses). Tasks expose public fields only — `task_name`, `agent_timeout_sec`, `verifier_timeout_sec`, and `providers`, the per-provider capability verdict ([Where it runs](#where-it-runs)). Instructions, environments, and tests never leave the server — with one deliberate exception, the dataset's own owner downloading the package they published ([Getting your corpus back](#getting-your-corpus-back)).

Then start the job. `datasets` is a **list** — one job can span several — and only `datasets` and `agents` are required:

```ts
const job = await evals.start({
    datasets: [
        { name: "deep-swe" },                    // bare name = active version
        { name: "frontier-swe", version: "1.2" } // or pin one
    ],
    agents: [
        { name: "codex", model_name: "gpt-5.5" },
        { name: "claude", model_name: "fable" },
    ],
    n_attempts: 1,                // (optional) attempts per task × agent arm, default 1
    n_concurrent_trials: 4,       // (optional) parallel trials, default 4, ceiling 150
    max_trial_spend_usd: 25,      // (optional) hard model-spend cap for EACH trial
});

console.log(job.status);          // "QUEUED"
console.log(job.datasets);        // [{ name: "deep-swe", version: "1.1" }, …] — resolved, echoed back
console.log(job.counts);          // { agents: 2, tasks: 214 } — entity cardinality
console.log(job.trials.total);    // 428
console.log(job.trials.byStatus); // { QUEUED: 428, RUNNING: 0, SCORED: 0, … } — every status, zeros included
```

Each dataset selector can also narrow its own task set: `task_names` and `exclude_task_names` are glob patterns over task names, and `n_tasks` caps the count after filtering — so a smoke run over the first twenty tasks of each dataset is a selector field, not a fork of the dataset:

```ts
datasets: [
    { name: "deep-swe", task_names: ["auth-*"], n_tasks: 20 },
],
```

Every job response is the same shape, whatever produced it. `start()`, `get()`, `cancel()`, `resume()`, `retry()`, `regrade()` and each row of `list()` carry the same fields, so a job card renders from any of them without your knowing which call it came from. `counts` is entity cardinality — the parts a job is made of — and `trials` is the one "how many" structure: a total plus a status histogram that names every status, zeros included, so a status bar never needs the enum hardcoded. `job_name` is a user-facing label — pass one or take the server's.

### Money

`max_trial_spend_usd` caps what a single trial may spend on model calls, and it is the only spend limit the platform enforces: every trial runs on its own freshly minted gateway key, and the cap is that key's budget. Leave it out and the platform applies its published default ($200 per trial). The response always reports the cap that actually applied — `job.max_trial_spend_usd` — so an omitted one is never a mystery.

There is no job-wide budget. A job's real ceiling is its trial count times that cap **times the attempts the retry policy allows**: infrastructure failures re-run automatically ([Automatic retries](#automatic-retries)), and each attempt is minted its own full per-trial cap — a retry is a fresh run, not a discounted one. So the ceiling is `max_trial_spend_usd × trials × (retry.max_retries + 1)`, which with the fleet default of 2 retries is three times the single-attempt product. The response states it for you as `job.worst_case_spend_usd`, so the number you approve before a large matrix starts running is the honest one. Your account credit balance is the hard backstop underneath: when the balance runs out, spending stops mid-job whatever the caps say, and starting a job while the balance is already at zero is refused up front with a `402 insufficient_credits`. A trial that exhausts its own cap is not a failure — the agent just runs out of budget, and the trial is still scored on whatever it produced.

Runs on your own provider key are the one exception to the credit ledger. When a [managed BYO provider key](./01-getting-started.md#managed-byo-provider-keys) is enabled for the model's provider, the trial's model calls bill your provider account directly and draw no Evolve credits — the per-trial cap still meters and bounds the trial exactly as before. The exception is about who pays, not about the gate at the door: the zero-balance check runs on every job create and every `resume()`, BYOK included, so keep a non-zero balance even if you run BYOK-only.

### Automatic retries

An infrastructure failure — a sandbox that died mid-run, a worker whose lease expired, a box that never booted — is usually the platform's weather, not a verdict on your task. Trials that settle `INFRASTRUCTURE_ERROR` are therefore put back on the queue automatically, up to `max_retries` times each (fleet default 2, published as `limits.job.default_max_retries` in the [capability document](#what-the-platform-supports)). No other status ever re-runs on its own: a scored zero, a `SCORING_ERROR`, an `INDETERMINATE` are verdicts about the run, and they stand.

The policy is Harbor's RetryConfig vocabulary, verbatim, passed as `retry` on `start()` — and the response echoes the **resolved** policy on every job body, so the row always states what it runs under:

```ts
const job = await evals.start({
    datasets: [{ name: "deep-swe" }],
    agents: [{ name: "codex", model_name: "gpt-5.5" }],
    retry: {
        max_retries: 3,           // 0 turns retries off; omitted = fleet default (2)
        include_exceptions: null, // null, omitted, or [] = no filter
        exclude_exceptions: ["AgentAuthenticationError"],  // wins over include
        wait_multiplier: 2,       // backoff: min_wait_sec × multiplier^attempt, capped at max_wait_sec
        min_wait_sec: 1,
        max_wait_sec: 60,
    },
});
console.log(job.retry);           // the RESOLVED policy, every field present
```

The include/exclude sets refine *within* the infrastructure class by exception name, exclude winning over include — Harbor's rule. A gateway credential refusal adjudicates as `AgentAuthenticationError` and a model that never served as `ModelNotFoundError`; everything else is `InfrastructureError`. Omitting `exclude_exceptions` keeps Harbor's default non-retryable set (auth refusals, timeouts, and the other failures that would re-fail identically). An **explicit** `exclude_exceptions: null` is different from omitting it: null turns exclusions off entirely — Harbor's own `None` semantics — so everything the include set admits is retried. `include_exceptions` has no such split: null, omitted, and the empty array `[]` all mean no filter — Harbor's include check treats the empty set exactly like `None`, so an empty array never means "retry nothing".

A retried trial keeps its receipts. `trial.n_retries` counts the requeues, and `trial.retries` lists each retired attempt with its exception, its spend, and its clocks — so a scored trial that took three attempts is auditable without archaeology, and the job's `stats.n_retries` is the consumed-retry sum across all trials. Each attempt spends against its own full per-trial cap, and every retired attempt's real spend stays in the job total — which is why `worst_case_spend_usd` carries the `(max_retries + 1)` product ([Money](#money)).

The budget can also end early. Two consecutive infrastructure failures with the **same signature** break the circuit: the retry the policy would have scheduled is refused, the trial stays terminal, and whatever remains of `max_retries` goes unspent. A signature is the class of fault, read from the typed failure phase alone and never from message text — `sandbox_death` (the box ceased to exist mid-run), `provider_create_failure` (the box never came up), `stream_disconnect` (the run's event stream ended without the harness ever speaking). The trial's `exception_info.exception_message` is rewritten to name the signature and the count, and the job stream carries `trial.retry_circuit_broken` with `signature`, `consecutive`, `failure_phase` and `retries_unused`. The reason is arithmetic: a dead provider-and-region combination answers the same way every time, so it should cost minutes, not a whole retry budget's worth of timeouts. Three guarantees keep it from eating real transients — the **first** failure of any signature always retries, **alternating** signatures never accumulate (the streak resets on any non-matching failure), and the breaker runs strictly after the `max_retries` and include/exclude adjudication, so it can only ever shorten the budget, never extend it.

On the stream, a requeue emits `trial.retrying` right after the `trial.settled` that recorded the failure. That means **`trial.settled` is not final** for a trial the policy may still re-run: a watcher that treats it as terminal must check for a following `trial.retrying` on the same trial. From the CLI, `-r/--max-retries` and the repeatable `--retry-include`/`--retry-exclude` set the same fields, merging field-by-field over a `--config` file's `retry` object ([CLI](#cli)).

### Timeout multipliers

Every task declares its own wall-clocks (`agent_timeout_sec`, `verifier_timeout_sec` — or inherits the platform fill-ins). Sometimes one job legitimately needs more room on the same tasks — a slower model, a deliberately thorough effort setting — and editing the corpus for one run would change what every other run means. Harbor's answer is a per-run multiplier, and this platform carries it verbatim: five flat fields on `start()`, named exactly like Harbor's `--timeout-multiplier` flags.

```ts
const job = await evals.start({
    datasets: [{ name: "deep-swe" }],
    agents: [{ name: "codex", model_name: "gpt-5.5" }],
    timeout_multiplier: 2,               // every phase: declared × 2 (default 1.0; < 1 shrinks)
    verifier_timeout_multiplier: 3,      // overrides the global for the verifier only
});
console.log(job.timeout_multiplier);           // 2 — the resolved global
console.log(job.verifier_timeout_multiplier);  // 3 — this phase overrides it
console.log(job.agent_timeout_multiplier);     // null — the global applies
```

The semantics are Harbor's exactly. The worker multiplies the **task-declared** timeout at the point each phase timeout is armed: the agent budget (`agent_timeout_sec × multiplier`), the verifier budget in both verifier modes (and the judge credential lifetime sized from it), the harness-install budget (the agent-setup phase), and the image-readiness wait (the environment-build phase — tasks here carry prebuilt images, so that wait is what the build knob stretches). A phase-specific field overrides the global one for its phase; everything else inherits the global. The task itself is never rewritten — the same task runs unstretched in every other job, and the dataset stays comparable across runs.

Every multiplier must be greater than 0 and at most the published ceiling — `limits.job.max_timeout_multiplier` in the [capability document](#what-the-platform-supports) (10 unless the fleet changes it), with the default beside it as `default_timeout_multiplier` (1.0). An absurd value is refused at create with a typed `invalid_input` naming the bound, never silently clamped. The multipliers are part of the request identity (an `Idempotency-Key` replay with a different multiplier is a `409` — the runs would execute under different clocks), and derived jobs (`resume()`, `retry()`) inherit them verbatim. From the CLI the same five knobs are `--timeout-multiplier`, `--agent-timeout-multiplier`, `--verifier-timeout-multiplier`, `--agent-setup-timeout-multiplier` and `--environment-build-timeout-multiplier`, each overriding its field over a `--config` file ([CLI](#cli)).

### Shape and ceilings

A job expands to `tasks × agents × n_attempts` trials, each in its own sandbox. `n_concurrent_trials` is how many run at once. The ceilings — distinct agent arms per job, attempts per task, total trials — all refuse at create rather than partway through, and every one of them is published under `limits.job` in the [capability document](#what-the-platform-supports) rather than only here, so a form can check a sweep before it POSTs. `sandbox_provider` (optional, default `"daytona"`) picks where the sandboxes run — see [Where it runs](#where-it-runs).

`agent_env` and `verifier_env` inject environment values into every agent or verifier run. They are pass-through slots: the client sends them verbatim and the server owns acceptance — refused where unsupported, never silently dropped. The platform honors exactly two `verifier_env` keys — `REWARDKIT_JUDGE` and `REWARDKIT_MODEL`, rewardkit's per-run judge override ([LLM judges](#llm-judges)); every other key, and all of `agent_env`, is refused at create with a message naming that pair.

`secrets` attaches env secrets to every agent run. References (`{ name, label?, as? }`) point at stored secrets — never values on the wire. Secrets live on the platform's Secrets surface under a `(name, label)` identity, so several values of one name can exist side by side (`API_KEY` at `staging` and at `prod`); an omitted `label` takes the `default`-labeled row when one exists, the single row when exactly one exists, and refuses as the typed `secret_ambiguous` (naming the labels) when several match and none is `default` — a job never guesses which secret it runs with. `as` renames the env var inside the sandbox, and names the trial's own credential contract owns (the `EVOLVE_` prefix, every built-in harness's gateway and vendor credential/routing slots — including the whole `KIMI_MODEL_*` family — the model env pins, and the judge-override pair) are refused. Inline entries (`{ name, value, delivery, label?, as? }`) are the same vault through a convenience door: the value is saved as a normal env secret first (`delivery` is required — no silent default; `label` defaults to `default`) and the job then stores only the reference — the stored job never contains a value. A `(name, label)` identity that already exists splits on proof: an inline entry restating the stored row byte-for-byte (same value, same delivery) attaches it exactly like a reference — a retry of the same request converges instead of colliding with its own first attempt — while a different value or delivery refuses as the typed `secret_exists` (attach it by reference or pick a label; inline values never overwrite). Every stored env secret carries a **delivery mode**: `brokered` means the value never enters any sandbox (the managed-agents egress-proxy machinery, for header-based HTTPS APIs), `direct` means the raw value is placed in the sandbox environment (URL-parameter keys, gRPC, websockets). Eval trials deliver exactly the **direct** mode — the value enters the trial env and is scrubbed at the credential seal, before hidden tests enter; host/path/method scoping does not apply to a direct secret in any lane. Attaching a brokered secret refuses at create as the typed `secret_brokered_unsupported` — save the secret as direct or use the managed-agents lane; never a silent downgrade.

### Agent arms

An agent arm is `{ name, model_name }` plus two optional identity fields. `name` is a built-in (`claude`, `codex`, `gemini`, `qwen`, `kimi`, `opencode`, `droid`) or an agent you registered yourself ([Bring your own agent](#bring-your-own-agent)); `model_name` is always required — the server applies no model default. Model names are the SDK's own, harness by harness: the `claude` harness takes the four short aliases from the model table — `haiku`, `opus`, `sonnet`, `fable` — and every other harness takes its canonical names from that same table (`gpt-5.5` for `codex`, `claude-fable-5` for `droid`, the `openrouter/…` ids for `opencode`). The table and the pairing rules live in [Getting Started → Agent Reference](./01-getting-started.md#agent-reference).

Pin an agent version when you need the comparison to hold still across weeks:

```ts
agents: [
    { name: "codex", model_name: "gpt-5.5", version: "0.29.0" },
],
```

Omitting it resolves the agent's latest published version **once, at job creation**, and stamps it on the arm: every trial of the job installs that same version — a vendor release mid-job can never split one job across two agent versions — and the job body echoes the stamped version on `agents[].version`, so what will run is visible from the moment of create. Either way the version that actually ran is recorded on every trial as `agent_info.version`, so a trial is always attributable after the fact. Resolution failures are loud, never a silent fallback: an unresolvable pin is refused at creation (`agent_version_not_found`), a failed latest lookup refuses the creation too (`agent_version_unresolvable`, 502 — retry the create), and a pin on a registered agent is refused as well — registered agents are versioned by their own content, so there is no separate version axis to pin.

`reasoning_effort` is the other identity field, and it belongs to the comparison rather than to the run. The accepted values are published as `limits.job.reasoning_efforts` in the [capability document](#what-the-platform-supports). An omitted effort resolves to the **agent's own default** — not the document's platform-wide `default_reasoning_effort` — and that resolved value is stamped as arm identity: trials echo it on `agent_info.reasoning_effort`, and the job's `evals` keys carry it as the `__effort` segment even though the job never declared one (a claude arm with no effort settles under `…__high`, a kimi arm under `…__max`). Effort changes the score, so a client comparing two jobs must read the stamped value, never assume what an omitted one meant. Effort is part of an arm's identity alongside the agent, the model, and the version pin: the same agent and model at `low` and at `high` are two distinct systems — they de-duplicate separately, they each consume an arm slot, and every trial echoes the effort back on `agent_info.reasoning_effort`. An effort the agent cannot apply is refused at creation with a `400 invalid_input` rather than accepted and quietly dropped — recording `high` against a CLI that never received the flag would put a claim in the record that did not happen. Each capability entry publishes `effort_support`, so a picker can grey the control out instead of discovering the refusal after a POST.

### Skills

An arm can carry skills — folders of instructions the harness discovers natively, the same `SKILL.md` format `.withSkills()` mounts locally. `skills` is a list of reference strings on the arm, and like effort it is **part of the arm's identity**: the same agent and model with different skills are two arms.

```ts
agents: [
    {
        name: "claude",
        model_name: "fable",
        skills: [
            "skills.sh/vercel-labs/agent-skills/frontend-design",  // one named skill from a skills.sh-listed repo
            "anthropics/skills@main",                              // a GitHub repo, pinned to a branch, tag, or commit
            "upload:6f6f1f36-…",                                   // a skill uploaded to the platform
            "name:frontend-design",                                // your skill name — a moving pointer
        ],
    },
],
```

A skill **name** works like a managed secret's name: it is unique to you and always points at the **latest** upload of that name. Uploading the same name with different content creates a new record and moves the pointer (old records keep their immutable `upload:<id>` handles; finished jobs' `skill_locks` never rewrite). `name:<skill-name>` resolves server-side at job creation to the name's current record and is pinned as that record's `upload:<id>` — an unknown name is the typed `skill_name_not_found`. The CLI manages the catalog too: `evolve skill list | upload <dir> | show <id-or-name:…> | delete <id>`.

Git references are **pinned at job creation** — each one resolved once to its exact commit and stored in pinned spelling — so a moving branch can never make two trials of one job run different skill content. A raw filesystem path is refused by the server (a hosted job cannot read your disk): upload the folder first and reference `upload:<id>`. The `skills()` client does that — `upload(directory)` packs and stores the folder content-addressed under its folder name (re-uploading identical content under the same name answers the existing record), `list()`, `get(id)` (including the SKILL.md text) and `delete(id)` manage the catalog, and a delete is refused with `skill_in_use` while a running job references the upload.

Every run records what actually mounted: once the arm's first trial resolves its skills, the job's arms carry `skill_locks` — one lock per skill with its name, pinned source, content digest, and for git-backed skills the repo URL and exact commit. The trial detail page shows the same pins. A skill that cannot be fetched at run time is an infrastructure error on the trial, never a score.

### Idempotency

Retries are safe — pass an idempotency key and a retry returns the original job instead of creating a duplicate:

```ts
const retry = await evals.start(
    {
        datasets: [{ name: "deep-swe" }],
        agents: [{ name: "codex", model_name: "gpt-5.5" }],
        max_trial_spend_usd: 25,
    },
    { idempotencyKey: "nightly-2026-07-31" },
);
console.log(retry.idempotent_replay);   // true when the key replayed an existing job
```

A key on its own is not enough, so the server also fingerprints the request behind it. Repeat the same request with the same key and you get the original job back; send a *different* request under a used key and it is refused with a `409 idempotency_key_reused` rather than handed yesterday's job while you believe a new run started. Use a fresh key for a genuinely new run.

---

## Watch it live

`watch()` is a dual-use handle over the job's event stream. Iterate it for live events, or await it for the final job — pick one form per call:

```ts
// Iterate events as they arrive
for await (const event of evals.watch(job.id)) {
    // event.seq  — monotonic sequence number
    // event.type — "job.created" | "trial.settled" | "job.completed" | …
    if (event.type === "trial.settled") {
        // JobEvent is a discriminated union: switching on `type` narrows
        // `data`, so task_name and status are typed here with no cast.
        updateProgress(event.data.task_name, event.data.status, event.data.reward);
    }
}

// Or await the final Job
const final = await evals.watch(job.id);
console.log(final.status, final.trials.byStatus, final.stats.cost_usd);
```

Options apply in every form — abort or tune backoff on an iterated watch the same way; `onEvent` fires regardless:

```ts
const controller = new AbortController();

const final = await evals.watch(job.id, {
    onEvent: (event) => console.log(event.type, event.data),
    signal: controller.signal,     // (optional) abort the watch
    reconnectDelayMs: 1_000,       // (optional) initial backoff, default 1s
    maxReconnectDelayMs: 30_000,   // (optional) backoff ceiling, default 30s
});
```

The stream replays from the beginning, so attaching late loses nothing. The parser honors every line terminator the SSE grammar names — CRLF, LF, and a lone CR — even when one arrives split across network chunks. On disconnect it resumes from the last sequence number with exponential backoff — no gaps, no duplicates. Once the job reaches a terminal status, the handle resolves with the final `Job`.

One caveat for watchers that key off `trial.settled`: it is not final for a trial the [auto-retry policy](#automatic-retries) may still re-run. When an infrastructure failure is retried, a `trial.retrying` event follows the `trial.settled` that recorded it, and the trial runs again — treat a settle as that trial's last word only when no `trial.retrying` follows it.

### Live cost and live tokens

While a trial runs, its spend is readable before anything settles, on two fields that travel together:

```ts
console.log(trial.live_spent_usd, trial.live_spend_at);  // 3.41  "2026-07-31T18:22:05.113Z"
```

Two mechanisms feed that number, and knowing both tells you how fresh it is. Every non-streaming model call reports its own cost the moment its response headers arrive, and the platform accumulates those readings per trial — flushed to the record at most once every 5 seconds, so the figure starts moving within seconds of the first completed call. Underneath it, the gateway's spend ledger — the settled log of what each key actually spent — is read about every 30 seconds and can only raise the figure. The same 30-second ledger read carries **token counts** beside the money, so live token numbers move on that cadence.

Read the pair together or not at all, and hold on to the rules that follow from what it is:

- **It is a lagging lower bound, never the trial's cost.** Render it as "at least $3.41, as of that timestamp" — never as "current cost".
- **`null` is "no reading yet", never `$0`.** Zero from the ledger means nothing has settled, not that the trial was free.
- **It only climbs, and it is cleared at settle.** On a terminal trial read `agent_result.cost_usd` and `spend_source`; those are the settled truth, and the only one.
- **It is never part of a total.** `stats.cost_usd` sums settled trials only; folding a live reading in would double-count the moment that trial settles.
- **Built-in agents only.** A registered agent runs your own command with no live poll around it, so its trials go from `null` straight to a settled cost.

The same reading reaches a watcher as a `trial.spend` event carrying `trial_id`, `task_name` and `live_spent_usd` — and, when the ledger sample carried them, the token sums. It is emitted only when a sample actually landed on a live trial, so a poll that raced the settle never fires one.

---

## Read the results

```ts
// One job: size, status histogram, stats, spend
const detail = await evals.get(job.id);
console.log(detail.trials.total, detail.trials.byStatus);  // 428, { SCORED: 301, RUNNING: 3, … }
console.log(detail.stats.cost_usd);                        // measured spend across settled trials
console.log(detail.stats.n_input_tokens, detail.stats.n_output_tokens);  // token totals
console.log(detail.failure);                               // why it FAILED — null on every job today

// Your jobs, newest first — await one page, or iterate them all
const jobPage = await evals.list({ limit: 50 });           // jobPage.nextCursor continues
for await (const item of evals.list({ search: "nightly" })) {
    console.log(item.id, item.job_name, item.status, item.stats.cost_usd);
}
```

`list({ search })` is a server-side free-text filter over the job name and its dataset names. `stats` is the aggregate block: progress counters (cumulative, Harbor-style: errored trials are a subset of completed, cancelled a subset of errored — the disjoint breakdown is `trials.byStatus`), token totals (`n_input_tokens` includes cache tokens; `n_cache_tokens` and `n_output_tokens` beside it), measured `cost_usd` — the whole model bill, with the judge share itemized beside it as `judge_cost_usd` (see [LLM judges](#llm-judges)) — and `evals` — per-(agent, model, dataset) statistics keyed `agent__model__effort__dataset` — the dataset ref is always the LAST `__` segment, which is where Harbor-compatible readers recover it. The effort segment is always there, inserted before the dataset: a declared effort stamps itself, an omitted one stamps the agent's default (`__high`, `__max`, …) — see [Agent arms](#agent-arms). A failed job says why on `failure`, as `{ code, message }` — the same grammar an API error uses, under a different key so that `if (body.error) throw` stays correct on a healthy read. In practice you will not see it fire: `FAILED` is a [reserved job status](#statuses) that nothing sets today; read `trials.byStatus` for where a job actually went wrong.

### pass@k

When a job runs a task more than once, each evals group also carries `pass_at_k` — how likely it is that *k* attempts contain at least one success. The platform computes it; there is nothing to configure and no code of yours to run.

```ts
import { passAtK } from "@evolvingmachines/sdk";

for (const group of passAtK(detail)) {
    for (const point of group.points) {
        console.log(group.evals_key, `pass@${point.k}`, point.value.toFixed(3));
    }
}
// codex__gpt-5.5__high__deep-swe@1.1 pass@2 0.833
// codex__gpt-5.5__high__deep-swe@1.1 pass@4 1.000
```

`passAtK(job)` reads `stats.evals[key].pass_at_k` — on the wire a map of k (as a string, the way JSON keys always are) to a value in `[0, 1]` — and hands it back as sorted numbers. Nothing is requested and nothing is recomputed.

The number is the standard unbiased estimator, `1 - C(n-c, k) / C(n, k)` per task, averaged over the group's tasks. The k values are the powers of two and the multiples of five up to the group's *sparsest* task's attempt count, because every task has to be able to answer every k — so a single-attempt job has no pass@k at all. An attempt that produced no reward, because it errored or was cancelled, counts as a failed attempt; dropping it would quietly inflate every number.

A group answers with an empty map for one of three reasons, and the reader simply leaves that group out:

- its rewards are not binary — pass@k over partial credit would be an invented statistic, so one non-binary or multi-key reward disqualifies the whole group;
- no k is small enough to be eligible;
- attempts are still in flight. The statistic appears once every attempt of the group has settled, so an attempt that has not run yet is never counted as a failure.

The same numbers ride in the job's [download archive](#download-the-archive), inside `result.json`; a live read and the archive of the same job never disagree.

### Trials

Trials page the same way — await a page or iterate across pages. `status` filters, and on a multi-dataset job `dataset` narrows to one dataset's trials:

```ts
for await (const trial of evals.trials(job.id)) {
    console.log(trial.task_name, trial.agent_info.name, trial.status, trial.reward);
}

const failures = await evals.trials(job.id, {
    status: ["INFRASTRUCTURE_ERROR", "SCORING_ERROR"],
});
const oneLane = await evals.trials(job.id, { dataset: "deep-swe" });
```

### Per-task rollup

Between the job body and the trial list sits `tasks()` — one row per distinct task, with its trial tally, mean reward, and cost, so you can see which tasks drag without fetching every trial:

```ts
for await (const row of evals.tasks(job.id)) {
    console.log(row.task_name, row.source, row.mean_reward, row.cost_usd);
    // row.trials = { total, byStatus } — the same tally shape as the job's
}
```

`source` names the dataset the task came from — the disambiguator a multi-dataset job needs.

### One trial in depth

A trial id is globally addressable — `trials().get(trialId)` needs no job id; the body carries `job_id` as the reverse pointer:

```ts
const trial = await t.get(trialId);

console.log(trial.reward);                        // primary reward; null until scored, 0 is a reward
console.log(trial.verifier_result?.rewards);      // the named rewards map behind it
console.log(trial.agent_result?.cost_usd, trial.spend_source);   // settled spend, and how we know
console.log(trial.agent_result?.n_input_tokens,   // token counts (input includes cache)
            trial.agent_result?.n_cache_tokens,
            trial.agent_result?.n_output_tokens);
console.log(trial.agent_execution);               // { started_at, finished_at } — a timing pair
console.log(trial.sandbox_provider, trial.verifier_environment_mode);
console.log(trial.agent_info.version);            // agent version actually used
console.log(trial.attempt_phase);                 // which step a RUNNING trial is in
console.log(trial.exception_info?.exception_type, // why it failed, when it did
            trial.exception_info?.exception_message);  // untruncated in this response
```

Every phase's wall-clock is a **start/stop pair**, never a duration: `environment_setup`, `agent_setup`, `agent_execution`, and `verifier` are each `{ started_at, finished_at }`, either bound null while the phase has not reached it. Durations you compute yourself keep their provenance — you always know which clock produced them.

Three finer pairs sit beside those four and are **not** a partition of them — never sum the two sets. `queue_wait` is the time the trial sat claimable before a worker began it (for a retried trial it restarts at the retry's own backoff deadline, so a failed first attempt is never billed to the second attempt's wait; its open bound is a database clock and its close a worker clock, so a sub-second wait can read marginally negative — published raw rather than laundered). `harness_bundle` brackets fetching the agent's install bundle, and its companion `harness_bundle_cache_hit` tells you what the number means: `true` explains a pair of milliseconds, `false` on a pair of minutes is a real build this trial waited out (a miss that *built* also carries the upload that shares the result with the fleet; a trial that joined another's build, or fetched a ready result from the store, pays neither). `image_prepare` brackets readying the task's machine image on the provider — real work on E2B and Daytona, and **near-zero on Modal by design** (Modal does that work inside sandbox creation instead, where `environment_setup` records it), so never compare this field across providers raw. All three are additive: older readers that ignore them lose nothing.

> **Reading spend:** `spend_source` is the lane the figure came from, and only `"measured"` is final. `"measured_provisional"` is a real reading taken inside the gateway's asynchronous spend flush — an honest floor that a deferred pass later confirms or raises into `"measured"`. `"assumed_cap"` means nobody measured this trial's spend; the number it holds is zero — a placeholder, never an observation (the platform under-bills rather than publish an invented figure), and the deferred pass replaces it when a real reading lands. So a read taken shortly after settle can show `"measured_provisional"`, or `"assumed_cap"` with `$0` — treat anything but `"measured"` as not yet final. `agent_result.cost_usd: null` means the trial never ran — a queued or cancelled trial — and is not the same as `0`, which is a real measurement. `trial.max_trial_spend_usd` is the cap *this* trial's key carried, which can differ from the job's current cap on rows settled before a change. A [judge-enabled task](#llm-judges)'s verifier spends on its own key, itemized apart: `judge_result.cost_usd` with its own `judge_spend_source` lane (same three-lane rules), null on every trial where no judge ever ran — and `agent_result.cost_usd` stays the agent's alone, so the trial's whole bill is the sum.

> **Reading failures:** `status` is the primary key for failure classes; `exception_info` is the detail — `exception_type` is one of the platform's stable failure names (`ScoringError`, `InfrastructureError`, `CancelledError`, `IncompleteTrialError`), `exception_message` is truncated to 2000 characters on list rows and full on the detail route, and `exception_traceback` rides along when one was recorded.

`attempt_phase` answers the question `RUNNING` alone cannot: which step the trial is in (`prepare`, `build`, `boot`, `install`, `agent`, `verify`, `persist`), so a polling caller can tell a slow environment build from a slow agent.

A trial the [auto-retry policy](#automatic-retries) re-ran carries its history: `n_retries` counts the requeues, and `retries` lists each retired attempt — `attempt_number`, its `exception_info`, its `cost_usd` (real spend the job total includes), and its clocks. The trial body itself always describes the **final** attempt; the lineage is where the earlier ones live.

### The trace

Fetch a trial's recorded event timeline:

```ts
for await (const event of t.traceEvents(trialId)) {
    console.log(event.seq, event.type, event.data);
}

// Or page manually — the same envelope as every collection
const trace = await t.trace(trialId, { limit: 500 });
const more = await t.trace(trialId, { cursor: trace.nextCursor! });
```

The first event of every trace (`seq` 0) is the task instruction itself, carried as `_prompt` — a trace read on its own opens with the prompt rather than mid-conversation. `traceEvents()` drains the currently available trace, then stops — `nextCursor` is `null` once you are caught up, which is how the drain knows. A trace cursor is a position in the seq timeline, so to follow an in-flight trial later, keep the last event's `seq` and resume with `{ cursor: String(lastSeenSeq) }`.

---

## Trial artifacts — the raw record

Beside the parsed trace, every trial archives its raw record, and one vocabulary names the pieces everywhere — API, SDK, CLI, and the dashboard's download menu:

| Name | What it is |
|------|------------|
| `trace-parsed` | The parsed event timeline — what `trace()` / `traceEvents()` page |
| `trace-stdout` | The agent process's stdout, byte for byte |
| `trace-stderr` | The agent process's stderr, byte for byte |
| `trace-atif` | The normalized trajectory — an ATIF v1.7 document built from the parsed trace |
| `trajectory` | Reserved: the harness's own native session file (not served yet — the server answers not-found until its wave lands) |
| `agent-home` | The CLI's whole home folder, collected after the run |
| `verifier` | Everything the scoring step printed |

The raw ones come from `artifact()`:

```ts
const stdout = await t.artifact(trialId, "trace-stdout");   // string | null
const stderr = await t.artifact(trialId, "trace-stderr");   // string | null
const grader = await t.artifact(trialId, "verifier");       // string | null
const home   = await t.artifact(trialId, "agent-home");     // Record<path, text> | null
```

`trace-stdout` and `trace-stderr` are the referee whenever the parsed trace looks wrong. `agent-home` is the agent CLI's entire home folder (`/root/.claude`, `/root/.codex`, …) collected whole after the run, subagent transcripts included by construction, keyed by sandbox path. Null is a normal answer, never an error: the trial never stored that artifact (it was cancelled early, the agent wrote nothing, or the trace was purged).

`trace-atif` is the normalized view of the same run: one **ATIF v1.7** document (Harbor's Agent Trajectory Interchange Format — the strict interchange schema its trainer and analysis tooling read), built server-side from the stored parsed trace. The instruction opens it as the first `user` step, each agent turn carries its message, reasoning, tool calls and their observed results, and `final_metrics` states the trial's token totals and measured cost. It answers on the same `{log}` envelope as the raw logs — the string is the JSON document — and null keeps the same meaning: nothing was stored (or the id is a regrade result, whose agent half belongs to its immutable source trial). It is the same document the job archive places at Harbor's own path `agent/trajectory.json`; the separate `trajectory` name stays reserved for a different artifact — the harness's own native session file.

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

This tree is assembled on your machine out of the trial's own artifacts, which is why it is not identical to the per-trial directories inside [the job archive](#download-the-archive): the server builds those, so they also carry `lock.json`, `trial.log` and `artifacts/`, and they have no `agent/trace-parsed.jsonl`. `evolve job download` adds an `evolve.json` of its own — one at the job root, one in every trial directory.

The two modes are exclusive, and `--cursor`/`--limit` page only `--stream trace-parsed` — the CLI refuses any other mix as a usage error instead of letting one flag silently win.

This archive belongs to hosted evals: trials are scoring evidence. A managed agent session keeps its parsed transcript download; its raw stream lives in the SDK's local session log and its home folder inside your own sandbox.

---

## Inspect a run without downloading it

A trial's record can be large, and the question you actually have is usually narrow: which events mention this error, what did the verifier print at the end, does any trial in this job hit that stack trace. All three are answered on the server, so nothing has to come down first.

### Filter one trial's trace

`trace()` and `traceEvents()` take three filters, and each one composes with the cursor instead of replacing it:

```ts
// type — an exact event type, not a pattern
const calls = await t.trace(trialId, { type: "tool.call" });

// grep — case-insensitive POSIX regex over the event's type AND its content
const denied = await t.trace(trialId, { grep: "permission denied" });

// tail — only the last N matching events
const ending = await t.trace(trialId, { tail: 50 });

// and they combine; paging still runs through the filtered set
for await (const event of t.traceEvents(trialId, { grep: "Traceback", tail: 20 })) {
    console.log(event.seq, event.type);
}
```

`grep` is Postgres's own regex engine, so a plain string is a plain substring match, exactly like `grep` itself; an invalid pattern comes back as a typed `invalid_input` refusal naming `grep`, never a `500`. A filter narrows which events exist on the timeline and nothing else: the cursor still means "seq strictly greater than", `nextCursor` still pages through the filtered set, and events always arrive oldest-first. `tail` is a floor on that same timeline rather than a reversed ordering, so `tail` plus paging drains exactly the last N matches, in order. The bounds: `type` at most 100 characters, `grep` at most 512, `tail` between 1 and 10000, and `limit` up to 1000 (default 200).

### Grep every trial of a job

One pattern, one pass over the whole job:

```ts
const hits = await evals.grep(job.id, "CUDA out of memory");
for (const group of hits.items) {
    console.log(group.trial_id, group.task_name, group.match_count);
    for (const event of group.events) console.log("   ", event.seq, event.type);
}
```

Matches group per trial: `match_count` is that trial's exact total, never truncated, and `events` carries the first five matching events as a sample. A trial with no match produces no group, so an empty page means the pattern appears nowhere in the job. Groups order by trial id, `nextCursor` is where the next page resumes, and `limit` defaults to 50 with a maximum of 200. `type` narrows the same way it does on a single trial's trace.

The scan is bounded per request rather than per job, so a sparse pattern over a very large job can answer with a short page and `hasMore` still true — keep paging. A pattern too expensive to evaluate is refused as a typed `invalid_input` on `q` that says to narrow it: add `type`, anchor the pattern, or grep one trial's own trace. The full match list for any single trial is exactly that follow-up — same pattern, same engine, same answer.

### List and read a trial's stored files

The files a trial left behind can be listed, and read by the byte, so the tail of a 200 MB log costs a range request instead of a download:

```ts
const listing = await t.files(trialId);
for (const file of listing.items) console.log(file.path, file.size_bytes);

const whole = await t.file(trialId, "agent/stdout.log");                          // Buffer
const head  = await t.file(trialId, "agent/stdout.log", { start: 0, end: 65535 });
const last  = await t.file(trialId, "agent/stdout.log", { suffix: 4096 });        // last 4 KB
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

```ts
await evals.cancel(job.id);    // idempotent; a terminal job is a no-op

const report = await t.stop([trialA, trialB]);
console.log(report.stopped.map((r) => r.id));  // killed and settled by this request
console.log(report.already_terminal);          // were already done; untouched
console.log(report.not_found);                 // not yours or not real — never distinguished
```

`stop()` kills each trial's sandbox and settles the trial with its spend read from the gateway. Every requested id appears in exactly one of the three lists. Ids belonging to someone else land in `not_found` — existence is never leaked — and already-terminal trials are reported as such and left untouched, so the call is idempotent. One request takes up to 100 ids. A stopped trial rejoins the run by default on [`resume()`](#resume) once its job is terminal.

The CLI adds one convenience on top: `evolve job stop <id> --dataset <name>` stops one dataset's trials and leaves the job — and every other dataset — running. It is pure sugar over surfaces that already exist (the job's `datasets[]`, the trial list's `dataset` filter, and the stop door), pages its batch under the 100-id cap, and merges the reports into one outcome. Every one of the dataset's trials is named to the door — deliberately not pre-filtered to live ones — so the report stays honest: a dataset whose trials have all settled reports them under `already_terminal`, and an empty report means exactly one thing, a dataset with no trials at all. Naming the whole slice is what that honesty costs: one stop request per 100 trials even when every one of them has already settled, so a big fully-settled dataset sends the requests a live-only pre-filter would have skipped, and a request that fails mid-batch — a 429 on the third of fifty — ends the command there. What it does not do is lose the half that landed: the trials already stopped are dead server-side and this report is the only place their ids exist, so the report prints first, marked partial with the count of trials no answer came back for and that unanswered batch named by trial position (`partial: true` and `unreported` under `--json`), and only then does the rate limit print and the command exit 1. Rerunning the same command finishes the rest and returns the already-dead under `already_terminal`. Stopping a dataset the job never spanned is a refusal, not an empty no-op — silence would read as "nothing was running".

---

## Resume

`resume()` takes a terminal job and creates a **new linked job** holding fresh trials for the source's failed and stopped work. The source is never mutated — it stays separately citable, and the new job's `source_jobs` records where it came from:

```ts
const followUp = await evals.resume(job.id, undefined, { idempotencyKey: "resume-1" });
console.log(followUp.source_jobs);   // [{ action: "resume", type: "hub", job_id: job.id }]
```

By default the platform resumes its standard failure set — `ScoringError`, `InfrastructureError`, `IncompleteTrialError` — plus stopped trials and the still-queued trials of a cancelled source. A stopped trial settles `CANCELLED` with exception type `CancelledError`, so a stop is never a dead end: `resume()` picks the stopped work back up without being asked. Narrow the set by exception type when you mean something more surgical:

```ts
await evals.resume(job.id, { filter_error_types: ["InfrastructureError"] });
```

`resume()` requires a terminal source job (`409 job_not_terminal` otherwise) and answers `409 no_failed_trials` when nothing qualifies. Scored trials are never re-executed.

---

## Retry

`retry()` is the manual verb beside resume's automatic one, and the two answer different questions on purpose. Resume answers *"finish what broke"* — it picks up failures and stopped work, and never touches a scored trial. Retry answers *"run THESE again"*: you choose the trials, and a scored trial is a legitimate target — a flaky task, a changed world, one more sample. Like resume, it creates a **new linked job** inheriting the source's config; the source is never mutated, and the new job's `source_jobs` records `action: "retry"`:

```ts
// The whole job again (source must be terminal)
const again = await evals.retry(job.id);
console.log(again.source_jobs);   // [{ action: "retry", type: "hub", job_id: job.id }]

// Only the failed trials (SCORING_ERROR, INFRASTRUCTURE_ERROR, INDETERMINATE)
await evals.retry(job.id, { failed_only: true });

// Exactly these trials — all-or-nothing, and the JOB may still be running:
// a settled trial's facts are final, so it can retry the moment it settles
await evals.retry(job.id, { trial_ids: [trialA, trialB] });

// One trial, from the trials client — the same operation, addressed by the
// trial you are holding
const oneMore = await t.retry(trialId);
```

The selection is `trial_ids` XOR `failed_only` — both together is a `400` contradiction. In `trial_ids` mode every named trial must be **settled** (`SCORED`, `SCORING_ERROR`, `INFRASTRUCTURE_ERROR`, `INDETERMINATE`, or `CANCELLED`); a still-live id refuses the whole request with `409 trial_not_settled`, and an id that is not this job's refuses it with `404 trial_not_found` — a partial retry that silently dropped half the selection would read as a full one. The whole-job and `failed_only` modes require a terminal source (`409 job_not_terminal` — on a live job the selection would change under the request), and `failed_only` with nothing failed answers `409 no_failed_trials`; stopped (`CANCELLED`) trials are not failures — name them in `trial_ids`, or use `resume()`, which exists for exactly that.

Both doors take an `Idempotency-Key` (the `{ idempotencyKey }` option). The fingerprint covers the **resolved selection** under this verb's own namespace: two retries of one source selecting different trials are different requests, the trial door and the job door replay each other for the identical one-trial request, and a create or resume key can never replay a retry.

One deviation from Harbor is deliberate and named: Harbor's hosted `trial retry` re-opens the *same* job with fresh pending attempts. Here a finished job is immutable — its numbers are settled and separately citable — so the retry is a new job linked via `source_jobs`, exactly like resume and regrade.

---

## Regrade

A regrade re-runs **only the verifier**. The trial's recorded submission — the patch and artifacts captured when it ran — is restored into a fresh, sealed verifier sandbox and scored again; the agent phase is never re-run, and the source trial is never modified. Use it when a verifier was fixed or tightened and you want the same agent work re-scored under it, without paying for a single new agent run.

**The response is a job.** A regrade is an ordinary job whose `source_jobs` records `action: "regrade"` and whose `is_regrade` is true — you watch it, list its trials, and read its stats with the same calls as any other job, and it shows up in `list()` like any other job:

```ts
// Every regradable trial of a terminal job — optionally narrowed
const regrade = await evals.regrade(job.id, {
    statuses: ["SCORED"],        // (optional) only source trials in these statuses
    task_name: "task-001",       // (optional) only source trials of this task
});
console.log(regrade.is_regrade, regrade.source_jobs);   // true, [{ action: "regrade", … }]

const rescored = await evals.watch(regrade.id);          // an ordinary job watch

// One trial — from the trials client, no job id needed
const single = await t.regrade(trialId);
```

Eligibility is defined by the record, not by intent: a trial is regradable only if it **recorded its verifier inputs** when it settled. Settled `separate`-mode trials record them; nothing else does. Three consequences: shared-mode trials can never be regraded (their verifier inspected the live agent sandbox, which no longer exists); in-flight trials are not yet regradable; and trials that settled before the platform began recording verifier inputs are permanently ineligible. A single-trial regrade of an ineligible source is refused with `409 regrade_source_ineligible` naming the reason; a whole-job regrade requires a terminal source (`409 job_not_terminal`), selects only the eligible trials, and answers `409 no_regradable_trials` when there are none.

The verifier always re-runs `separate` — and a `separate` verifier box is always sealed, whatever [network mode](#network-modes) the task declares. Compare the regrade job's trials against the source job's — same task names, same shapes — to read the deltas.

---

## Compare

Compare 2–10 of your jobs side by side — per-job aggregates plus a per-task matrix, disagreement rows first:

```ts
const comparison = await evals.compare([jobA.id, jobB.id]);

for (const aggregate of comparison.jobs) {
    console.log(aggregate.id, aggregate.mean_reward,
        `${aggregate.coverage.scored}/${aggregate.coverage.total} scored`, aggregate.cost_usd);
}

for (const row of comparison.taskMatrix) {
    if (!row.disagreement) continue;
    for (const cell of row.cells) {
        console.log(row.task_name, cell.status, cell.mean_reward);
        // cell.status: a TrialStatus, "MIXED" (trials disagree), or "MISSING" (no trials)
    }
}
```

Mean rewards cover `SCORED` trials only; `coverage` is always reported so a high mean over few scored trials stays visible. Zero is a reward, never a gap.

---

## Download the archive

Download the full results archive (gzipped, deterministic bytes) of a terminal job:

```ts
const buffer = await evals.download(job.id);                    // Buffer (default)
const path = await evals.download(job.id, { to: "./results" }); // save; returns file path
const stream = await evals.download(job.id, { stream: true });  // raw response stream
```

The Buffer and `{ to }` shapes are verified against the response's length and, when the server states one, its digest; `{ stream: true }` hands you the raw bytes to verify yourself.

The archive unpacks to Harbor's job layout — a job-level `config.json` and `result.json`, plus one directory per trial holding its `config.json`, `lock.json` (the resolved trial inputs — task ref and digest, agent, environment, verifier), `result.json`, `trial.log` (a deterministic lifecycle summary — status, phases, exception, rewards), the normalized ATIF trajectory at `agent/trajectory.json`, the raw streams at `agent/stdout.log` / `agent/stderr.log`, the agent CLI's home folder (the `agent-home` artifact) under `agent/sessions/` — the same slot Harbor's own agents keep session state in — the verifier's console at `verifier/test-stdout.txt`, its rewards at `verifier/reward.json`, `exception.txt` when the trial carries one, and the collected artifacts under `artifacts/`, each mirrored at its absolute source path minus the root anchor exactly as Harbor lays them out (the agent's patch plus the task's manifest entries; separate-mode trials only — shared mode collects nothing out of the agent's box), with `artifacts/manifest.json` always present stating what was collected and from where (`[]` when the trial recorded nothing) — an artifact the trial never stored is an absent file, never an empty placeholder. The counters inside the job-level `result.json` are the same cumulative, Harbor-style numbers the live API reports on `stats` (errored trials are a subset of completed, cancelled a subset of errored), and each evals group also states `pass_at_k` — the same numbers a live read reports (see [pass@k](#passk)). The archive and a live read of the same terminal job never disagree.

The record files are Harbor's own vocabulary, and everything Evolve-specific rides under an `x_evolve` key Harbor's parsers ignore — the job's `config.json` and `result.json` and every trial's `config.json` and `result.json` each carry one, with the exact shapes published in the contract (`spec/openapi.yaml`, the `JobArchive*Extension` / `TrialArchive*Extension` schemas). Money reconciles from the extension, not from the Harbor-native field: a trial's authoritative spend is `x_evolve.spentUsd` with its `spendSource` lane, and `agent_result.cost_usd` states only a measured model spend (null otherwise). Two more extensions ride the job config's `agents` entries: `x_reasoning_effort` and `x_preset`, each omitted when the arm declared none.

---

## CLI

The SDK ships an `evolve` binary — a thin shell over the five clients. The grammar is noun-verb: `evolve <noun> <verb>`. `run` also stands on its own at the top level, taking `job start`'s flags and documenting itself as `evolve run`. Singular nouns are canonical; `job`, `trial` and `dataset` also answer to their plurals as hidden aliases, as does `ls` for `list`. The plural `agents` is deliberately not an alias — that word is reserved for the managed-agents CLI and refuses with the reason, so use the singular `evolve agent` for eval agent arms.

```
job      start | list | show | trials | tasks | compare | cancel | stop | resume | retry | regrade | download | grep
trial    show | trace | download | retry | regrade | stop
dataset  list | show | publish | download | activate
skill    list | upload | show | delete
agent    list | show | add | remove
auth     status
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

evolve trial show <trial-id>
evolve trial trace <trial-id> --grep 'permission denied' --tail 50
evolve trial download <trial-id> --stream trace-stdout
evolve trial download <trial-id> -o trials/
evolve trial retry <trial-id>
evolve trial regrade <trial-id>
evolve trial stop <trial-id> [trial-id...]

evolve dataset list -q
evolve dataset show deep-swe@1.1
evolve auth status
```

Output follows one precedence everywhere: human tables on a TTY, tab-separated rows when piped, `--json` for the machine shape (NDJSON for `--watch` streams), and `-q` for ids-only lists (on `job start --watch`, `-q` suppresses the event log and prints the final block only). `--columns` chooses and orders list columns (`--columns help` names them; for `job list` they are `id`, `name`, `status`, `datasets`, `agents`, `trials`, `spent`, `started` — the money column's key is `spent`, not `cost`), `--no-trunc` disables cell truncation, `--no-headers` drops the header row from piped output. `--limit` and `--cursor` page every listing the same way.

`job show` ends with a **pass@k** block — one line per evals group, each k to three decimals — whenever the platform has numbers to show. Groups that cannot answer are simply absent from it, and a job with nothing computed prints no block at all; `--json` always carries the raw `stats.evals[].pass_at_k`.

Wherever a verb takes a **job id**, an unambiguous prefix of at least 8 characters works too: `job show aabbccdd` is `job show aabbccdd-…` when exactly one of your jobs starts that way. The CLI resolves the prefix against your own job list before calling the server — the wire always carries the full id — and refuses loudly when the prefix matches nothing or more than one job. Trial ids are not prefix-resolved; trial verbs take full ids.

A rate limit is a delay, not a mystery: a `429` prints one line naming the limit and the server's `Retry-After` delay (exit 1), and the SDK's watch loops honor that delay and keep watching instead of dying mid-poll.

Closed sets are validated at the keyboard: a typo in `--stream`, `--status`, or `-e/--env` is a usage error naming the legal values, never a round trip.

Credentials: `$EVOLVE_API_KEY`, or `--api-key`; `--base-url` targets a non-default deployment. Exit codes: `0` success (with `--watch`: the job `COMPLETED`, or a publish `COMPLETED`), `1` runtime failure (with `--watch`: `FAILED` or `CANCELLED`), `2` usage error.

### Signing in

Today the credential story is one step: create an API key in the dashboard and export it as `EVOLVE_API_KEY`. `auth status` then tells you who the platform thinks you are — your user, your email, and a descriptor of the key in use (the secret is never returned):

```bash
evolve auth status
```

`auth login` — the browser sign-in flow that mints the key for you — lands with the auth release. Key listing and revocation are already in the contract and served; their SDK and CLI verbs arrive with the same release.

The key descriptor's `last_used_at` is in the shape but nothing updates it yet: it stays `null` even on the key making the request. Read it as "not recorded", never as "this key is unused".

Dataset publishing and agent registration have their own subcommands — shown in [Bring your own dataset](#bring-your-own-dataset) and [Bring your own agent](#bring-your-own-agent).

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

Two things this door will not do. A **read-only API key** may `list` but not `set` or `delete` — the refusal is `read_only_key` (403) — so a key handed to CI to read results cannot rewrite what your runs authenticate with. And **LLM provider keys (BYOK) cannot be stored here at all**: a provider key decides whose account pays for model traffic, which is a billing decision, so those stay on the signed-in dashboard where a human is present to make it. The same three operations are on the SDK client, `Evolve.managedSecrets()` — see [Managed Secrets](02-configuration.md#managed-secrets).

---

## What the platform supports

Everything a client would otherwise hardcode — the legal agent names, the status enums, the limits, the error codes — is one public, cacheable document. It needs no API key, so a signed-out page can populate its own agent picker:

```ts
import { meta } from "@evolvingmachines/sdk";

// `meta` is exported from the package root, and is also `hosted().meta()` —
// the same document either way.
const doc = await meta();

for (const agent of doc.agents) {
    console.log(agent.name, agent.effort_support, agent.latest_version);
}
```

`GET /api/meta` is the wire form. Every field is derived from the module that enforces it, so a published limit and an enforced limit cannot drift apart, and a new agent appears here the moment the platform can run it. What is in it:

- **`agents`** — every built-in, with `effort_support` (what the agent does with `reasoning_effort`: `'level'` — the value reaches the CLI as a level; `'binary'` — thinking on/off only, values outside `limits.job.binary_effort_values` are refused; `'none'` — no effort input at all, naming one is refused), `default_effort` (the pinned default an omitted effort takes; null for `'none'`), `runnable` plus `reason` (a registered agent the platform must refuse says why), `default_model` and `models` (the picker's option list — the API still requires an explicit model), `supports_config` (whether `kwargs.config` reaches it), `presets` (the named settings presets it can guarantee), `version_pinnable`, and `latest_version` for a "your pin is out of date" badge (null means "not known right now", never "up to date").
- **`agent_registration`** — the rules a bring-your-own registration must satisfy: name pattern and length, size caps, `max_per_user`, the reserved built-in names, and the reserved env keys the platform owns.
- **`sandbox_providers`** — each provider's real resource ceilings and, in `refuses`, the capabilities it will not run with the reason the runner itself would give. **`platform_constraints`** beside it holds the refusals that apply on *every* provider, so "runs nowhere" is distinguishable from "runs somewhere else".
- **`managed_providers`** — the managed sandbox doors this deployment serves; a different question from the eval lane. Each entry's `agent_sessions` says whether the door carries a full SDK agent session; all three doors do today, Modal included — the Modal door serves commands *and* the file quartet, proven end to end — so a `false` there with a "no filesystem operations" reason is a stale value, not a capability statement. §Managed Sandboxes in the configuration chapter is the authoritative description of what each door serves.
- **`network_modes`** — the three modes a task may declare ([What runs](#what-runs)).
- **`statuses`** — the job, trial, import, and dataset-version vocabularies, each with its `terminal` members marked. A watcher stops on `terminal`; a status bar renders `values` without hardcoding the enum.
- **`limits`** — `job` carries every create-time bound (`max_agents`, `max_n_attempts`, `max_trials`, `n_concurrent_trials` default and ceiling, `default_max_trial_spend_usd`, `default_sandbox_provider`, `default_sizing`, `model_required`, the effort vocabulary, and the phase wall-clocks a task inherits when its own config declares none — `default_agent_timeout_sec` 3600, `default_verifier_timeout_sec` 600; a task that declares its own always wins — and the timeout-multiplier pair, `default_timeout_multiplier` 1.0 with `max_timeout_multiplier` as the create-time ceiling). `compare` bounds the compare fan-out; `pagination` publishes a `default`/`max` pair per collection scope; `uploads` holds the two archive size caps; `dataset_names` the name pattern and length bounds; and `max_items_named_in_error_message` is how many offending items a refusal names in its English sentence before "and N more" — which is why `details` exists.
- **`error_codes`** — the whole vocabulary from [Error codes](#error-codes), in one array. **`import_warning_codes`** beside it lists the warnings an import can carry.

`schema_version` moves when a field is added, removed, or changes meaning — never when a value changes. Pin behavior to it, not to a deploy date. Responses carry an `ETag` and `Cache-Control: public, max-age=300, stale-while-revalidate=300`; send the ETag back as `If-None-Match` and a matching document answers `304` with no body.

---

## Errors

Every failure is one shape:

```ts
import { EvolveApiError } from "@evolvingmachines/sdk";

try {
    await evals.start({
        datasets: [{ name: "deep-swe" }],
        agents: [{ name: "codex", model_name: "gpt-5.5" }],
        sandbox_provider: "modal",
    });
} catch (err) {
    if (err instanceof EvolveApiError && err.code === "provider_unsupported") {
        // Every refused task, with its reason. Not a sentence to regex.
        const { provider, refused_tasks } = err.details as {
            provider: string;
            refused_tasks: { task_name: string; reason: string }[];
        };
        console.log(`${refused_tasks.length} tasks cannot run on ${provider}`);
    }
}
```

- **`code`** is the stable identifier, typed as a closed union, so `err.code === "insufficient_creidts"` is a compile error rather than a branch that silently never runs. `HOSTED_ERROR_CODES` and `isHostedErrorCode()` are exported for runtime checks; a server newer than your SDK may send a code the union does not list, which is why `code` widens to `string`.
- **`message`** is the human sentence, and it may be shortened. **`details`** never is. When a refusal says "and 8 more", all of them are in `details` — that is the rule, and it is why `details` exists.
- **`param`** names the input that was wrong — a body path (`agents[0].name`), a query parameter (`limit`), or a multipart part — so a form can highlight one field instead of showing a banner. It is filled when the server can name one field; today the `invalid_input` family typically arrives without it, so treat `param` as an enhancement to act on when present, never a field to rely on — the `message` and `details` carry the refusal either way.
- **`retryAfterSec`** is set on `429` and `503`, read from the body first and the `Retry-After` header second (a cross-origin browser fetch cannot always see the header).
- **`requestId`** identifies the failure server-side. Quote it in a support thread. Every API response — success or failure — carries the same identifier in its `x-request-id` header, and an error body repeats it as `request_id`; `requestId` on the thrown error is that value, so the id in your logs matches the id in the server's.

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

What the **verifier** can reach is decided by its [verifier mode](#verifier-modes), not by a network rule of its own. A `shared`-mode verifier runs inside the agent's own sandbox, so it sees exactly the network the task's policy granted that box — sealed under `no-network`, the named hosts under `allowlist`, the open internet under `public`, which real shared-mode verifiers routinely use to install their test toolchain at verify time. A `separate`-mode verifier box is **always sealed**, whatever the task declares — no task input can open it, and every [regrade](#regrade) runs there. A [judge-enabled task](#llm-judges)'s verifier can additionally reach the platform's model gateway in every mode — the gateway is its own door, granted independently of the policy, and for a sealed `separate` box it is the only one. Judge-enabled runs also get uv managed for them: the platform pre-stages a uv cache in the verifier, and when the box the verifier runs in is sealed — every `separate` run, and a `shared` run under `no-network` — it sets `UV_OFFLINE=1`, so a uv-based test setup answers from that cache and a miss fails fast with uv's own offline error instead of hanging against a network it cannot reach; in a `shared` box with task-granted network the variable is not set and uv may fetch. Verifiers without a judge get neither the cache nor the variable. Each trial records the mode it ran under and where that decision came from in `agent_result.metadata` — compare rewards only across trials that agree on both, because an agent with internet access ran a different experiment from a sealed one.

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

```ts
const job = await evals.start({
    datasets: [{ name: "judged-swe" }],
    agents: [{ name: "codex", model_name: "gpt-5.5" }],
    verifier_env: {
        REWARDKIT_JUDGE: "claude-code",
        REWARDKIT_MODEL: "anthropic/claude-sonnet-4-6",
    },
});
```

From the CLI it is Harbor's own flag: `--ve REWARDKIT_JUDGE=claude-code --ve REWARDKIT_MODEL=anthropic/claude-sonnet-4-6`.

The judge's money is measured at the gateway off its own key — never taken from anything the verifier reports — and itemized apart from the agent's everywhere: `judge_result` / `judge_spend_source` on the trial, `stats.judge_cost_usd` on the job (a share of `stats.cost_usd`, which is the whole bill). Works in both verifier modes. Judge-enabled tasks are not regradable yet — the regrade lane refuses them with a typed error instead of re-scoring without a judge.

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

```ts
const job = await evals.start({
    datasets: [{ name: "swe-bench-verified", version: "1.0" }],
    agents: [{ name: "codex", model_name: "gpt-5.5" }],
    max_trial_spend_usd: 25,
    sandbox_provider: "daytona",   // "e2b" | "daytona" (default) | "modal"
});
```

An unknown value is rejected with a `400` at creation — never a silent fallback. Once chosen, the provider is fixed for the job's life; `resume()` inherits it.

Not every task can run everywhere. The catalog tells you **before any money is spent** — every task carries a per-provider verdict:

```ts
const dataset = await catalog.get("my-swe@1.0");
for (const task of dataset.tasks?.items ?? []) {
    const verdict = task.providers.modal;   // { ok: true } | { ok: false, reason }
    if (!verdict.ok) console.log(task.task_name, "cannot run on modal:", verdict.reason);
}
```

Starting a job whose selected tasks include one refused on the chosen provider is rejected with a `400 provider_unsupported` naming the tasks and each task's reason, rather than accepted and billed until it fails.

The verdict is narrower than the full set of things a provider can decline, and knowing where the line falls saves you a confusing trial. Three refusals are decided from the task's stored spec, so they are in `providers` and they are what a job creation checks against:

- **Multi-container tasks run on `e2b` and `daytona`.** Modal cannot run them today — the task's `providers.modal` verdict names the reason, and the task stays runnable on the other two.
- **Multi-container + `no-network` is declined on every provider** for now. Run those tasks with an `allowlist` or `public` network policy.
- **Sizing above a provider's ceiling** refuses on that provider only — see [Compute sizing](#compute-sizing).

The rest are decided when the sandbox is actually created, so they surface as a trial that ends `INFRASTRUCTURE_ERROR` with the reason in its failure detail rather than as a `400` at creation. There are two, and both are Daytona-and-Modal specifics you can check yourself before choosing a provider:

- **Daytona serves IP-based allowlists only.** Its network filter takes IPv4 addresses and CIDRs, capped at 10 entries — a cap that also has to fit the address the agent uses to reach its model, so a task's own list gets slightly fewer. A task whose `allowlist` names a hostname, or needs more than the cap, fails on Daytona when its sandbox is created. Run it on e2b or Modal, which serve hostname allowlists. Daytona serves `no-network` and `public` normally.
- **Modal caps every sandbox at 24 hours.** A task whose timeout exceeds the cap fails fast when its sandbox is created — never truncated mid-run.

### GPU tasks

A task can declare GPUs the same way it declares CPUs — `gpus` and `gpu_types` in its `task.toml` `[environment]` section, the standard task-format fields. The catalog shows the requirement on every task (`task.gpus`, `task.gpu_types`; `gpu_types` `null` means any type is acceptable), and the platform pays for GPU compute at launch — a GPU trial draws your credits for its model calls exactly like any other, never for the GPU itself.

Modal is the provider that reserves GPUs today, so a GPU task **runs on Modal no matter which provider the job picked** — e2b offers no GPU machines at any tier, and this Daytona tier provisions none (the platform re-checks Daytona's live quota on a timer, so a raised tier turns Daytona GPU on without a release). That re-route is a recorded fact, not a silent one, in three places:

- The task's `providers` verdict says it up front: `{ ok: true, degrades_to: "modal", reason }` on a provider that would hand the trial to Modal. `ok` keeps its meaning — a job stamped there still runs the task.
- The trial says where it actually ran: `trial.sandbox_provider` is the outcome, and `trial.sandbox_provider_degrade` carries `{ from, to, reason }` when it differs from the job's request. Every other trial answers `null` there.
- The [capability document](#what-the-platform-supports) publishes each provider's `gpus` block (supported, per-container ceiling, where it degrades and why) and the platform-wide `gpu_concurrency_cap`.

Because GPU compute is platform-paid, the fleet runs a **GPU concurrency cap**: at most `gpu_concurrency_cap` GPU trials in flight at once, across all jobs. A queued GPU trial past the cap simply waits for a slot — it is never refused for waiting. A GPU count no provider can allocate (above Modal's per-container ceiling) is refused at import with the numbers, so such a task never reaches a job at all.

**What the GPU time was worth.** Every settled GPU trial states its compute as an estimate: the measured sandbox lifetime (observed boot to observed kill) multiplied by a versioned rate card — the provider's own published list price per GPU-second, with the pricing page and the date it was read recorded on the figure. It arrives as `trial.gpu_cost` and, summed per job, as `stats.gpu_cost_usd`, and it is deliberately a **separate labeled figure**: it is never added into `agent_result.cost_usd` or `stats.cost_usd`, which are metered model spend. When no honest number exists the platform says so instead of guessing — `gpu_cost.unpriced_reason` names why (a run whose worker died has no measured lifetime; a task that accepts *any* GPU type has no single list price) and `estimate_usd` stays null. A GPU trial that provably never booted a sandbox reports a real `estimate_usd: 0`. Non-GPU trials carry no `gpu_cost` at all — CPU sandbox time is not priced today. The CLI shows the same pair: `evolve trial show` prints a `gpu compute (est.)` row with the full audit sentence, and `evolve job show` prints the job's summed estimate beside — never inside — its `spent` row.

### Not yet supported

Four task shapes the platform does not run today. The first and the last are **refused at import**, with the declaration and the reason named, because a task that runs without them would score a zero that looks exactly like a wrong answer. The middle two are shapes nothing in the task package identifies, so they import and run — the limit is recorded here rather than enforced, and it is a real one.

- **Services started by the image's `ENTRYPOINT`.** The task image is booted through the sandbox provider's own init and every later command arrives by `exec`, so an `ENTRYPOINT` that starts a database, an HTTP API, or any other daemon never runs, and the agent finds nothing listening. This is refused at import from **both** places the declaration can live: an `ENTRYPOINT`/`CMD` written in the final stage of the task's own `environment/Dockerfile`, and — read from the image's own configuration in its registry — a prebuilt `docker_image`'s entrypoint or the one a built task inherits from its base (`FROM postgres:16` declaring nothing itself). Keep-alive forms import normally: `["sleep", "infinity"]`, a shell with or without login flags, `["tail", "-f", "/dev/null"]`, an empty `ENTRYPOINT`, and any of these behind a `tini`/`dumb-init` shim. An inherited **`CMD`** is deliberately not judged — every keep-alive convention replaces `CMD`, upstream Harbor's included, so `FROM python:3.12-slim` (whose `CMD` is `python3`) is not a service task. Declare a real service in `environment/docker-compose.yaml`, where every service is started for real. If the registry cannot be read — an unreachable host, a private image, or an image published for no `linux/amd64` platform — the import fails naming the image and the step, because "we could not look" and "there is nothing there" are not the same answer. (Upstream Harbor behaves the same way on the three providers this platform runs on, and offers one affordance we do not: a `keepalive` environment argument that lets an author opt back into the image's own entrypoint on Modal.)
- **Computer-use and desktop tasks.** Nothing in the task package marks a task as computer-use: upstream it is a run-time choice of agent and environment, not a task-config field, and a category or tag is free-form author text. A task whose instruction assumes a desktop imports and runs, and a coding agent with no display scores zero on it. Only the pieces such a task usually also declares are refused by name — `[environment].os` other than Linux, and MCP servers.
- **Trajectory seeding.** Seeding an agent's session from a recorded trajectory before it starts is a run-time flag upstream, not a task property, and a task that expects a seeded session carries no marker saying so (a trajectory file shipped inside `environment/` is a demonstration artifact, which upstream's own examples say in their `task.toml`). Such a task imports, runs with an empty session, and scores what an unseeded agent earns.
- **Verifier scripts whose PEP-723 header needs a package index.** A `# /// script` header asks `uv` to build the script's environment at verify time. When the verifier runs in a sealed box — a `separate` verifier always, or a `shared` verifier on a `no-network` task — there is no index to reach, and the refusal names what the box can actually resolve: a task that requests an LLM-judge credential gets an offline bundle carrying `harbor-rewardkit` and its `litellm` dependency, and a task that requests no judge gets no bundle at all and can resolve nothing. Two cases are deliberately left alone: a `shared` verifier on a task declaring `allowlist` or `public`, which granted the network its header needs and resolves exactly as it does upstream; and a `tests/` tree where no file invokes `uv run` or `uvx`, where the header is inert metadata that plain `python3` ignores.
---

## Bring your own dataset

Any corpus in the task layout runs on the hosted stack: point at it, publish it, let the activation gate certify it, run it. A corpus in another format gets converted *into* the layout first — it is small, and a complete task fits on one screen (below).

What you publish is **private to your account**. It never appears in anyone else's catalog, and another account asking for its name reads a plain `404 dataset_not_found` — existence is never leaked. Your own `catalog.list()` shows the shared platform datasets plus your own. A name belongs to its first publisher: re-publishing a name you own extends that dataset with a new version, while publishing a name owned by anyone else — a platform dataset or another account's private one — is refused with a `409 dataset_name_taken`.

### Publishing

Publish from a git repository pinned to a ref, or upload a local corpus directory — the same corpus, the same pipeline, the same rules either way.

A git ref must be **pinned**: a full 40-hex commit sha, or a tag. A tag is resolved to the commit it points at when the publish is accepted, the sha is stored, and the import verifies the tag still points there — a tag re-pointed in between fails loudly instead of importing different bytes. A branch name is refused with `unpinned_git_ref`, and the refusal's `details` carry the commit the branch points at right now, so pinning it is one copy-paste:

```ts
// From a git repository, pinned to a ref
const publishJob = await catalog.publish({
    source: {
        git_url: "https://github.com/acme/my-swe.git",
        git_ref: "v1.0.0",        // a tag or a full commit sha — always PINNED
    },
    name: "my-swe",
    version: "1.0",               // the version label for the published corpus
});

// A corpus living in ONE SUBFOLDER of a bigger repository: add `git_path`.
// The server fetches just that folder (git sparse checkout) and imports it as
// the corpus root. The path is POSIX, relative to the repository root; a path
// that is not a directory at the pinned ref fails the import loudly.
const subfolderPublish = await catalog.publish({
    source: {
        git_url: "https://github.com/acme/benchmarks.git",
        git_ref: "v2.1.0",
        git_path: "datasets/my-swe",
    },
    name: "my-swe",
    version: "2.1",
});

// From a local directory — tarred + gzipped deterministically on the client and uploaded
const localPublish = await catalog.publish({
    source: { directory: "./my-swe" },
    name: "my-swe",
    version: "1.0",
});

// Everything in the directory is packed, dotfiles included (`.gitignore`,
// `.dockerignore`, `.env.example`, `.config/`), and an executable script stays
// executable. Only `.git`, `.DS_Store` and `.venv` are left out, and symlinks
// are never packed. The same directory always produces the same bytes, so the
// tarball's sha256 — the version's source identity on the server — is
// reproducible.

// Block until COMPLETED or FAILED
const done = await catalog.watchImport(publishJob.id, {
    onStatus: (imp) => console.log(imp.status, imp.task_count),
    pollIntervalMs: 2_000,        // (optional) default 2s
});

if (done.status === "FAILED") {
    // `failure`, not `error` — `error` is the key the failure envelope uses, so
    // `if (body.error) throw` stays correct on a healthy read of a failed import.
    console.log(done.failure?.code, done.failure?.message);  // "2/113 task(s) failed to parse"
    for (const failed of done.failure?.failures ?? []) {
        console.log(failed.task_name, failed.error);
    }
}

// Lost the id? List your imports — await one page, or walk them all.
for await (const imp of catalog.listImports({ status: "FAILED" })) {
    console.log(imp.id, imp.name, imp.version, imp.failure?.message);
}

// Narrow to one dataset's publish history, newest first
const history = await catalog.listImports({ dataset: "my-swe", limit: 20 });
```

`getImport(id)` is the single read behind all of this — status, `task_count`, `failure` once there is one, and `warnings`. `watchImport()` is a poll loop over it, so reach for `getImport()` when you drive your own scheduler. A terminal import stays readable, id included, for as long as its dataset exists — deleting the dataset takes its import records with it, and a later `getImport` answers the same not-found as an id that never existed.

`warnings` is worth reading even on success: an import whose warnings include `no_solutions_archived` produced a version that can never be activated through this API (`version_not_activatable`) — an import that will never become runnable must not look identical to one that will.

```bash
evolve dataset publish \
    --git https://github.com/acme/my-swe.git --ref v1.0.0 \
    --name my-swe --version 1.0 --watch
evolve dataset publish \
    --git https://github.com/acme/benchmarks.git --ref v2.1.0 --path datasets/my-swe \
    --name my-swe --version 2.1 --watch     # one subfolder of a bigger repository
evolve dataset publish --dir ./my-swe --name my-swe --version 1.0 --watch
```

Every lane resolves to the same thing — a task-layout directory — and is held to the same rules. The corpus root is a directory whose `tasks/` subdirectory holds one directory per task, or the tasks directory itself. Provenance is recorded per lane: the resolved commit for a git publish, the sha256 of the exact uploaded bytes for a directory. On the wire a publish is `multipart/form-data` — the SDK produces it for you — and uploads past the compressed-size cap are refused with a `413 import_too_large`. The metadata parts come first, so a name owned by someone else is refused with the `409` before the upload is received rather than after. A git source must be an `https://` url: the import runs on a worker with no ssh client, so `ssh://` and `git@` remotes are refused at validation rather than failing inside the job — for a private repository, put a token in the https url. A git publish may name one repository subfolder (`git_path` / `--path`) and the platform fetches just that folder via git sparse checkout — the subfolder becomes the corpus root, the recorded provenance keeps the path beside the resolved commit, and a path that is not a directory at the pinned ref fails the import loudly rather than landing an empty version.

### The dataset manifest (dataset.toml)

A corpus that carries Harbor's dataset manifest — a `dataset.toml` beside the task directories or at the corpus root — imports what the **manifest** says, not what happens to be on disk:

- **The manifest drives selection.** Only the tasks it names under `[[tasks]]` are imported; a task directory it does not list is left out, and a task it names that the checkout does not contain fails the publish (`manifest_task_missing`) — a dataset must never silently import smaller under the same name.
- **Every pinned digest is verified.** Each `[[tasks]]` entry pins a `sha256:` content digest, and the platform recomputes it with Harbor's exact per-task content-hash recipe (same file set, same ordering, same `.gitignore` filtering). A mismatch fails the publish (`manifest_digest_mismatch`) naming every divergent task with the pinned and the computed digest — the corpus is not the one the manifest's author published, and nothing unpinned ever lands. `[[files]]` digests are held to the same rule.
- **Metadata lands with it.** The `[dataset]` description reaches the catalog row, and every version carries the manifest identity it imported under — `version.manifest` is `{ name, version, description, authors, keywords, task_count }` (null when the corpus had no manifest). `evolve dataset show` prints it under the dataset header.
- **A `metric.py` custom metric is refused** (`custom_metric_not_supported`): custom metric scripts are not supported yet, and importing a dataset while ignoring the script that defines its scoring would report numbers its author never declared.

The manifest also makes `name` and `version` optional for a **directory** publish — the platform derives the name from the manifest's `org/name` (the segment after the `/`) and the version from `[dataset].version`, and explicit values always win:

```ts
// dataset.toml carries [dataset] name = "acme/my-swe", version = "1.0"
const fromManifest = await catalog.publish({ source: { directory: "./my-swe" } });
fromManifest.name;     // "my-swe" — derived from the manifest
fromManifest.version;  // "1.0"
```

```bash
evolve dataset publish --dir ./my-swe --watch   # name/version from dataset.toml
```

A **git** publish still requires both: the repository is only cloned server-side after the publish is accepted, long after the 202 has promised a name.

What happens next:

- **All-or-nothing parse.** Every task is parsed before anything lands; one bad task fails the whole publish, with each failure named in `failure.failures`. No partial corpus ever exists.
- **Strict by design.** Every task-config field is either honored or the publish is refused with the field and reason named — a task never silently runs on weaker semantics than it declares. GPU declarations (`gpus`, `gpu_types`) are honored — see [GPU tasks](#gpu-tasks); a GPU count no provider can allocate is refused at import with the numbers. Notably not yet supported: multi-step tasks (`step_results` is a declared placeholder on the wire, always null today).
- **Environments are prepared at import.** Dockerfile-defined environments are built once; multi-container service images are resolved and pinned so runs are reproducible.
- **The activation gate certifies every task** before the version goes live:
  - **gold** — the task's reference solution (`solution/`) is pushed through the real agent-side + verifier path and must score exactly `1.0`. Proof the task is solvable as written.
  - **no-op** — an empty submission goes straight to the verifier and must *not* score `1.0`. A task a do-nothing agent passes measures nothing.

`COMPLETED` is the import's terminal success: the corpus landed as a dataset version, visible in the catalog (`catalog.get("my-swe@1.0")`) in state `VALIDATING`. The gate then runs, and a version that passes it in full reaches `READY` — the one state that accepts jobs — and becomes the dataset's active version in the same step. A publish is therefore finished when its gate passes: nothing else to call, and `{ name: "my-swe" }` in a job already resolves to what you just published. A version that fails its gate terminally lands in state `FAILED`, with the reason attached: every version row carries a `gate` field — `{ status, attempts, code, message, failed_tasks, failed_task_count }`, where `failed_tasks` names each ineligible task with the gate's own reasons (`[{ task_name, outcome, reasons }]`, the first 25) and `failed_task_count` is the true total, so a gate that failed more than 25 tasks is never under-reported by the list's length — and `evolve dataset show` prints a failed gate as its own line (`version 1.0 activation gate FAILED: <the server's reason>`) followed by one indented line per failed task (`  starter-task: gold run produced no usable score …`), so a dead publish is never mistaken for one still validating and the cause is on the page, not just the count. The failure changes nothing else — the dataset keeps serving whatever it served before. `evals.start()` against any other state is rejected with a `409 version_not_ready` naming it.

The gate is queued work, and the queue says so: within seconds of the import completing, the version's `gate` field shows `PENDING`. Each worker proves one version's gate at a time, and a single gate run can take minutes to hours of real sandbox work, so a `PENDING` gate may wait while another version's gate finishes ahead of it. `PENDING` means scheduled and waiting; `RUNNING` means your tasks are being proven right now. Neither means stuck.

Two gate rules worth knowing before your first publish:

- **The gold run must write a reward file.** The gate scores the reference solution through the real verifier, and the verifier's verdict is exactly Harbor's contract: `tests/test.sh` writes `/logs/verifier/reward.json` — one flat JSON object of named numeric scores (the singular flat dict form; no nesting, no strings) — or `/logs/verifier/reward.txt` holding one number. `reward.json` wins when both exist; neither file is a verifier error, and a gold run that produces no usable score fails the gate.
- **Harbor's starter template gate-fails by design.** The `harbor task init` scaffold imports cleanly, but its stub `tests/test.sh` is comments only and writes no reward file — so its gold run produces no score and the gate fails with a message saying exactly that. Fill in the tests (make them write the reward file) and republish; the stub is a scaffold to complete, not a runnable task.

### Activating

What you publish is activated for you, so the reason to call this yourself is to point a dataset's bare name at a **different** version — back to an older one, or on to a version you published but did not keep as the default. It is one call, on a version you own:

```ts
await catalog.activate("my-swe", "1.0");
```

```bash
evolve dataset activate my-swe 1.0
```

From then on `{ name: "my-swe" }` in a job resolves to that version, and asking for the version that is already active succeeds without changing anything. While the version's activation gate is still scheduled or running the API answers 202 `gate_running` — a healthy "not yet", deliberately not the error envelope — and the SDK raises it as the typed `GateRunningError`: `err.gate` carries the gate's progress (`{ status, tasks, unverified, ineligible }`), and there is normally nothing to do but wait, because a gate that passes activates the version itself. Once the gate has landed, activating is refused with `version_not_ready` for a version whose gate failed (the gate's failure detail rides `details.gate_failure`), and with `version_not_activatable` for a version that can never activate (no reference solutions were archived — the import's `warnings` told you at publish time).

### Getting your corpus back

The platform keeps the exact package a version was published from, and its owner can download it:

```ts
const bytes = await catalog.download("my-swe@1.0");             // Buffer
const path = await catalog.download("my-swe@1.0", { to: "." }); // saved file path
const stream = await catalog.download("my-swe@1.0", { stream: true });
```

```bash
evolve dataset download my-swe@1.0 -o corpora/
```

Reach for `{ to }` on anything sizeable: the default shape buffers the whole package in memory, and a corpus can be hundreds of megabytes. The ref is `"name"` (the active version's package) or `"name@version"`. You get back the gzipped tarball you uploaded, or, for a git publish, the checked-out tree packed at import time. Either way it is the whole corpus directory: the task config, `instruction.md`, `tests/`, `environment/`, and your `solution/`.

**This is the one call that returns task files, and it returns them only to you.** Ownership is a single equality — the dataset's owner is the caller — with no admin path and no exception for platform-curated datasets, which have no owner and so cannot be downloaded by anyone. Somebody else's dataset answers not-found, the same answer a made-up name gets, because a `403` that only appears for real names is a way to discover which names are real.

The server re-hashes the stored bytes and compares them against the digest recorded at import before it sends anything, and echoes the verified value in a digest header. The SDK then re-checks that header against the bytes it actually received and throws `EvolveDigestMismatchError` if they disagree — so the chain is closed at both ends, storage and wire. The to-disk shape hashes while streaming and deletes the file rather than leaving one that looks like your corpus and is not. Only `{ stream: true }` is unverified, because you hold the bytes, not the SDK; read the header and hash as you go.

Two edge cases are named codes, not mysteries: a version published before packages were retained answers `package_not_retained`, and a version whose stored object has since gone answers `410 package_missing` — both terminal, both fixed only by re-publishing. This is also the only way to recover the task config file: the importer parses it into environment specs and keeps a digest, so it exists nowhere else on the server.

### Deleting one

A dataset name is a global resource, and a typo used to squat one permanently. `delete()` takes it back:

```ts
await catalog.delete("my-sew");   // 204, and the archived solutions go with it
```

The rules are worth knowing before you reach for it:

- **You must own it.** A platform-curated dataset is refused with `dataset_not_owned`; a name you cannot see reads as a plain not-found, exactly like a name that does not exist, so the route cannot be used to discover what other accounts have.
- **A referenced dataset is never deleted.** If any job ran against it, you get `409 dataset_in_use`, and `details` names the blocking job ids. There is no cascade and no force: a job's meaning is "this agent scored 0.42 on *these* tasks", and deleting the tasks would leave a number that refers to nothing. Delete the jobs first if you mean it.
- **Versions, tasks, and the private solutions archive go with it.** Mirrored task images do not — they are content-addressed and shared with any other dataset pinning the same image.

### When upstream moves

A dataset published from git records what it was built from, and the platform periodically re-resolves where that ref points now. The answer rides on the dataset:

```ts
const dataset = await catalog.get("my-swe");

if (dataset.upstream?.moved) {
    console.log(`${dataset.upstream.ref} has moved past ${dataset.upstream.current_commit}`);
}
```

`upstream` also carries the same provenance for the **active** version: `git_url` (userinfo stripped — an embedded token never reaches the wire), the requested `ref`, the resolved commit (`current_commit`), and the repository subfolder (`path`, null for the repository root). But provenance is not an active-version privilege — **every** git-imported version carries its own `source` object (`{git_url, ref, commit, path}`) whatever its state, so a version whose activation gate FAILED (which can never activate) still says exactly which bytes it imported; for an annotated tag, `commit` is the peeled commit the clone landed on, never the tag object. A version that did not come from a git remote serves `source: null` — never a fabricated value. Beside the provenance ride the watch fields: where the ref points now (`latest_commit`, null when the last check failed), `acked_commit` (the newest commit a local version already exists for), `moved` (the field a badge branches on), `checked_at`, `error` (why the last check failed — show "could not check", never "up to date"), and `auto_import`.

It is `null`, not "up to date", when the active version did not come from a git remote — an uploaded corpus, or one published before provenance was recorded. A version pinned to an exact commit sha serves its provenance with the watch at rest (`latest_commit`/`checked_at`/`error` null, `moved` false): a pin cannot move, and nothing checks one. A tag keeps the watch — a re-pointed tag is an update worth a badge. A failed check keeps the last known answer and sets `error`: a network blip should not quietly erase an update that is genuinely available.

By default, watching produces a fact, never an action — a new version is always an immutable row **you** create with `publish()`. The one exception is opt-in:

```ts
await catalog.update("my-swe", { upstream_auto_import: true });
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

`tests/test.sh` — the verifier entrypoint. The reward file is the verdict, never the exit code: write a number in `[0, 1]` to `reward.txt`, or `reward.json` with the score under `"reward"` plus named sub-scores. When `reward.json` has no `"reward"` key but exactly one numeric value, that value is the score — the primary-reward convention:

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
- The environment is `environment/Dockerfile` (built at import), a pinned `docker_image`, or `environment/docker-compose.yaml` for multi-container tasks (the agent runs in the `main` service). Any valid public image reference works for `docker_image` — Docker Hub, GHCR, ECR Public, or any other registry a pull can reach without credentials — with the tag pinned, never `:latest`. A reference that does not parse as an image reference is refused at import with the reference named; a reference that parses but cannot be pulled surfaces as an infrastructure error naming the pull, never as a task that quietly scores zero.
- Timeouts are optional: agent defaults to 3600 s, verifier to 600 s, both published as `limits.job.default_agent_timeout_sec` and `default_verifier_timeout_sec`. A declared `timeout_sec` always wins — the corpus is the authority on how long its own task needs, and the fallback never shortens one.
- `solution/` (`solve.sh`, or a `solution.patch` to apply) is what the gate certifies with — without it the version cannot reach `READY`.

Then publish and run it — exactly the [flow above](#publishing).

---

## Bring your own agent

The built-in agents are not the boundary. Register your own CLI once, and its name becomes usable in job `agents[].name` exactly like a built-in:

```ts
const mine = agents();

await mine.create({
    name: "acme-cli",                                               // the name you will pass in arms
    install_script: "curl -fsSL https://acme.dev/install.sh | sh",  // the script itself, not a path
    run_command: "acme-cli --headless",
    env: { ACME_PROFILE: "bench" },                                 // (optional) injected at run time
});

const job = await evals.start({
    datasets: [{ name: "deep-swe" }],
    agents: [{ name: "acme-cli", model_name: "gpt-5.5" }],
    max_trial_spend_usd: 25,
});
```

An agent that is not a one-line install ships as a directory instead — tarred deterministically on the client and uploaded:

```ts
await mine.create({
    name: "acme-cli",
    directory: "./agents/acme-cli",   // EITHER directory OR install_script, never both
    run_command: "acme-cli --headless",
});
```

Read, replace, and remove them the same way:

```ts
const registered = await mine.list();          // one page of your agents
for await (const a of mine.list()) { /* … */ } // or walk them all
const one = await mine.get("acme-cli");        // name, source, run_command, env, timestamps
await mine.delete("acme-cli");                 // past jobs keep the agent they recorded

// Change one WITHOUT a window where it stops existing:
await mine.upsert("acme-cli", {
    run_command: "acme-cli --headless --v2",
    install_script: "curl -fsSL https://acme.dev/install.sh | sh",
});
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
- **The registration ceiling is published** as `agent_registration.max_per_user` in the capability document. Past it, registration is refused with `agent_limit_reached`; delete one to make room.

**What keeps a trial inside its budget — and when it does not.** The spend cap is enforced on the gateway key, so model traffic through `$EVOLVE_GATEWAY_BASE_URL` is metered and capped. What confines traffic to that route is the **task's network policy**, not the agent. Under `no-network` the box reaches the gateway and nothing else, and the cap is a hard guarantee. Under `allowlist` or `public` an agent *can* reach a provider directly with a key of its own, and that traffic is neither metered nor capped.

Read that second sentence with [Network modes](#network-modes) in hand, because `public` is what a task gets when it declares no policy at all. If you care about the cap being airtight, run against tasks that declare `network_mode = "no-network"` — do not assume it. Registration refuses credential-shaped `env` keys, but that is a guardrail against the obvious mistake, not a boundary.

What you give up versus a built-in:

- **No live trace events.** There is no output parser for an unknown CLI, so the parsed trace stays empty for these trials.
- **No live spend or token reading.** `live_spent_usd` stays `null` and no `trial.spend` event fires; the trial goes straight to a settled cost.
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

`FAILED` is in the vocabulary and declared terminal, but nothing on the server sets it and nothing emits a `job.failed` event. A job that goes wrong does so one trial at a time: the trials land in `INFRASTRUCTURE_ERROR` or `SCORING_ERROR` and the job still reaches `COMPLETED`. So `job.failure` is null on every job you will read today. Handle `FAILED` if you are switching exhaustively over the enum — the capability document lists it and it may become reachable — but do not build a failure banner and expect to see it fire; the histogram in `job.trials.byStatus` is where a job's trouble actually shows.

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

with `FAILED` and `ARCHIVED` as off-ramps: a failed parse or environment build lands `FAILED` before `VALIDATING` is ever reached, a terminal activation-gate failure lands `FAILED` from `VALIDATING` (with the gate's reason on the version's `gate` field, printed by `dataset show`), and `ARCHIVED` shelves a version that has been moved past. An import lands a version at `VALIDATING`; the activation gate (gold + no-op, above) then certifies it and promotes what it certifies — a version that passes reaches `READY`, the only state that accepts jobs, and becomes the one bare names resolve to, with nothing left to call. [`activate()`](#activating) is how you later point that name at a different `READY` version. The one exception is a platform-curated dataset, which has no owner: its versions are certified the same way but sit at `VALIDATING` with a passing gate until an operator promotes them, since its default is not any account's to move.

All four vocabularies, with their terminal members marked, are published under `statuses` in the [capability document](#what-the-platform-supports) — render from there, not from these tables.

---

## Types

These are the shapes the surface actually returns, all exported from the package root. The closed sets are runtime values as well as types where a client needs the list — `TRIAL_STATUSES`, `EVAL_SANDBOX_PROVIDERS`, `TRIAL_ARTIFACT_STREAMS`, `HOSTED_ERROR_CODES` — each derived from the same spec the server is held to.

```ts
type JobStatus = "QUEUED" | "RUNNING" | "CANCELLING" | "COMPLETED" | "CANCELLED" | "FAILED";
type TrialStatus =
    | "QUEUED" | "RUNNING" | "SCORING" | "SCORED"
    | "SCORING_ERROR" | "INFRASTRUCTURE_ERROR" | "INDETERMINATE" | "CANCELLED";
type EvalSandboxProvider = "e2b" | "daytona" | "modal";
type SpendSource = "measured" | "measured_provisional" | "assumed_cap";
type VerifierEnvironmentMode = "shared" | "separate";
type AttemptPhase = "prepare" | "build" | "boot" | "install" | "agent" | "verify" | "persist";

interface DatasetSelector {              // one dataset a job runs
    name: string;                        // bare name = active version
    version?: string;
    task_names?: string[];               // include filter — glob patterns
    exclude_task_names?: string[];       // exclude filter — glob patterns
    n_tasks?: number;                    // cap AFTER filters
}

interface AgentArmInput {                // one agent arm of a job
    name: string;                        // built-in or registered
    model_name: string;                  // always required; no server default
    version?: string | null;             // pin; omitted = resolve latest
    reasoning_effort?: string | null;    // PART OF THE ARM'S IDENTITY
    skills?: string[] | null;            // skill references — identity too; git refs pinned at create
}

interface SkillLock {                    // provenance of one mounted skill
    name: string;
    source: string;                      // the pinned reference the content came from
    digest: string;                      // "sha256:<hex>" over the folder
    git_url: string | null;
    git_commit_id: string | null;
}

interface JobCreate {                    // jobs().start()
    job_name?: string;
    datasets: DatasetSelector[];
    agents: AgentArmInput[];
    n_attempts?: number;                 // default 1
    n_concurrent_trials?: number;        // default 4, ceiling 150
    max_trial_spend_usd?: number;        // the ONLY spend enforcement
    sandbox_provider?: EvalSandboxProvider;
    agent_env?: Record<string, string>;      // pass-through; server owns acceptance
    verifier_env?: Record<string, string>;
}

interface Page<T> {                      // every collection, top level or nested
    items: T[];
    nextCursor: string | null;           // pass back as { cursor }; null = no next page
    hasMore: boolean;
}

// Every list() and watch() returns a DUAL-USE handle: await it for one page (or
// the final job), or `for await` it to iterate. The handle is a full promise —
// `.then()`, `.catch()`, and `.finally()` all work — and however many of them
// you use, it issues exactly one request underneath.
interface Awaitable<T> extends PromiseLike<T> {
    catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R>;
    finally(onfinally?: (() => void) | null): Promise<T>;
}

interface Job {                          // ONE shape from every call
    id: string;
    job_name: string;
    status: JobStatus;
    datasets: DatasetRef[];              // resolved { name, version } pairs
    agents: AgentArm[];                  // echoed arms (requested pin; null = took latest)
    n_attempts: number;
    n_concurrent_trials: number;
    max_trial_spend_usd: number;         // the resolved per-trial cap
    worst_case_spend_usd: number;        // cap × trials × (retry.max_retries + 1) — stated, never left to you
    retry: RetryConfig;                  // the RESOLVED auto-retry policy, every field present
    timeout_multiplier: number;          // the RESOLVED global multiplier (1.0 when none sent)
    agent_timeout_multiplier: number | null;             // null = the global applies
    verifier_timeout_multiplier: number | null;
    agent_setup_timeout_multiplier: number | null;
    environment_build_timeout_multiplier: number | null;
    sandbox_provider: EvalSandboxProvider;
    counts: { agents: number; tasks: number };   // entity cardinality only
    n_total_trials: number;
    trials: { total: number; byStatus: Record<TrialStatus, number> };  // zeros included
    stats: JobStats;                     // counters, token totals, measured cost_usd, evals
    failure: { code: string; message: string } | null;   // never the key `error`
    source_jobs: SourceJob[];            // provenance of a derived job; empty on originals
    is_regrade: boolean;
    idempotent_replay: boolean;
    started_at: string;
    updated_at: string;
    finished_at: string | null;          // null while live
}

interface JobStats {
    // Cumulative, Harbor-style: errored is a subset of completed, cancelled a
    // subset of errored; the disjoint breakdown rides trials.byStatus.
    n_completed_trials?: number;
    n_errored_trials?: number;
    n_running_trials?: number;
    n_pending_trials?: number;
    n_cancelled_trials?: number;
    n_retries?: number;                  // consumed auto-retries, summed across trials
    evals?: Record<string, AgentDatasetStats>;   // keyed agent__model(__effort)__dataset — dataset last
    n_input_tokens?: number | null;      // cache included; null until recorded
    n_cache_tokens?: number | null;
    n_output_tokens?: number | null;
    cost_usd?: number | null;            // the WHOLE model bill (agent + judge); null before any settled
    gpu_cost_usd?: number | null;        // summed GPU compute ESTIMATE — separate, never inside cost_usd
    judge_cost_usd?: number | null;      // the judge share of cost_usd; 0 with no judge tasks
}

interface AgentDatasetStats {            // one evals group
    n_trials?: number;                   // trials that produced a rewards map
    n_errors?: number;                   // trials carrying exception_info
    metrics?: Record<string, unknown>[]; // a mean entry per arm today
    pass_at_k?: Record<string, number>;  // k (as a string) -> value; {} = cannot answer
}

interface PassAtKPoint { k: number; value: number }
interface PassAtKGroup { evals_key: string; points: PassAtKPoint[] }
declare function passAtK(job: Job): PassAtKGroup[];   // reads stats.evals, sorted, numeric

interface TimingInfo {                   // a phase wall-clock: a PAIR, never a duration
    started_at: string | null;
    finished_at: string | null;
}

interface AgentInfo {                    // the agent that ran a trial
    name: string;
    version: string | null;              // the version actually RESOLVED and used
    model_info: { name: string; provider?: string | null };
    reasoning_effort?: string | null;
}

interface AgentResult {                  // what the agent phase produced and consumed
    n_input_tokens?: number | null;      // includes cache tokens
    n_cache_tokens?: number | null;
    n_output_tokens?: number | null;
    cost_usd?: number | null;            // settled spend; null never means $0
    rollout_details?: Record<string, unknown>[] | null;  // reserved; null today
    metadata?: Record<string, unknown> | null;   // bundle digest, network mode + source, …
}

interface JudgeResult {                  // the judge half of a trial's model bill
    n_input_tokens?: number | null;      // measured at the gateway off the judge key —
    n_cache_tokens?: number | null;      // never anything the verifier reported
    n_output_tokens?: number | null;
    cost_usd?: number | null;            // the judge share alone; the trial's bill is the sum
}

interface ExceptionInfo {                // why a trial failed, when it did
    exception_type: string;              // ScoringError | InfrastructureError | …
    exception_message: string;           // truncated to 2000 chars on list rows
    exception_traceback?: string;
    occurred_at: string;
}

interface Trial {                        // list rows and detail, one shape
    id: string;
    job_id: string;                      // the reverse pointer
    task_name: string;
    source: string;                      // the dataset the task came from
    agent_info: AgentInfo;
    attempt: number;                     // 1..n_attempts
    status: TrialStatus;
    reward: number | null;               // primary reward; zero is a reward
    verifier_result: { rewards?: Record<string, number> | null } | null;
    exception_info: ExceptionInfo | null;
    agent_result: AgentResult | null;
    judge_result?: JudgeResult | null;   // the judge share, itemized; null == no judge ever ran
    environment_setup: TimingInfo | null;    // the four phase timing pairs
    agent_setup: TimingInfo | null;
    agent_execution: TimingInfo | null;
    verifier: TimingInfo | null;
    queue_wait: TimingInfo | null;           // finer pairs beside the four — not a partition of them
    harness_bundle: TimingInfo | null;
    image_prepare: TimingInfo | null;        // ~0 on Modal by design; its work lands in environment_setup
    harness_bundle_cache_hit: boolean | null; // true explains ms; false on minutes = a real build; null = unrecorded
    step_results: StepResult[] | null;   // multi-step placeholder; null today
    spend_source: SpendSource | null;
    judge_spend_source?: SpendSource | null;  // the judge figure's lane; null == no judge ever ran
    live_spent_usd: number | null;       // mid-run LOWER BOUND; cleared at settle
    live_spend_at: string | null;
    max_trial_spend_usd: number | null;  // the cap THIS trial's key carried
    sandbox_provider: EvalSandboxProvider | null;
    gpu_cost?: TrialGpuCost | null;      // GPU compute ESTIMATE; null on non-GPU trials, never in cost_usd
    sandbox_id: string | null;           // agent box id; null when none booted
    verifier_sandbox_id: string | null;  // null in shared mode or before verify
    verifier_environment_mode: VerifierEnvironmentMode | null;
    attempt_phase: AttemptPhase | null;  // which step a RUNNING trial is in
    n_retries: number;                   // auto-retries consumed; 0 = never retried
    retries: TrialRetry[];               // retired attempts, oldest first; [] = never retried
    session_ref: string | null;
    started_at: string | null;
    finished_at: string | null;
}

interface TrialRetry {                   // one retired attempt — the receipts a retry keeps
    attempt_number: number;              // 1-based dispatch number within the trial
    exception_info: ExceptionInfo;       // why that attempt failed
    cost_usd: number | null;             // REAL spend the job total includes
    started_at: string | null;
    settled_at: string | null;           // when its failure settled (and the retry was scheduled)
}

interface TrialGpuCost {                 // GPU trials only; exactly one of the first two is set
    estimate_usd: number | null;         // measured lifetime x rate; a provable never-booted run is a real 0
    unpriced_reason: string | null;      // why no number exists — never a guess
    provider: EvalSandboxProvider;
    gpu_type: string | null;             // the rate card's billing name; null when 'any'/unknown
    declared_gpu_type: string;           // the task's own spelling
    gpu_count: number;
    duration_sec: number | null;         // measured sandbox lifetime
    rate_usd_per_gpu_sec: number | null; // the applied list price
    rate_card: { version: number; source: string | null; source_date: string | null };
    measured_from: string | null;        // observed sandbox birth
    measured_to: string | null;          // observed sandbox end
}

interface StopResponse {                 // trials().stop() — every id in exactly one list
    stopped: Trial[];                    // killed and settled, with their settled rows
    already_terminal: string[];
    not_found: string[];                 // not real or not yours — never distinguished
}

interface JobTaskRollup {                // jobs().tasks() rows
    task_name: string;
    source: string;                      // the dataset the task came from
    trials: { total: number; byStatus: Record<TrialStatus, number> };
    mean_reward: number | null;          // over SCORED trials; zero is a reward
    cost_usd: number | null;
}

// A discriminated union on `type` and ONLY on `type`: several event types carry
// identically shaped payloads, so payload shape can never route a reader.
type JobEvent =
    | { seq: number; type: "job.created";    data: JobCreatedData }
    | { seq: number; type: "job.running";    data: { job_id: string } }
    | { seq: number; type: "job.cancelling"; data: { job_id: string; cancelled_trials: number; active_trials: number } }
    | { seq: number; type: "job.cancelled";  data: { job_id: string; cancelled_trials: number } }
    | { seq: number; type: "job.completed";  data: { job_id: string } }
    | { seq: number; type: "job.failed";     data: { job_id: string } }   // reserved; nothing emits it yet
    | { seq: number; type: "trial.running";  data: { trial_id: string; task_name: string } }
    | { seq: number; type: "trial.scoring";  data: { trial_id: string; captured_bytes?: number } }
    | { seq: number; type: "trial.spend";    data: { trial_id: string; task_name: string; live_spent_usd: number;
                                                     n_input_tokens?: number; n_cache_tokens?: number; n_output_tokens?: number } }
    | { seq: number; type: "trial.settled";  data: TrialSettledData }
    | { seq: number; type: "trial.retrying"; data: TrialRetryingData };

interface TrialSettledData {
    trial_id: string;
    task_name: string;                   // on EVERY trial.settled, no exceptions
    status: TrialStatus;
    reward?: number | null;              // scored path only; zero is a reward
    exception_type?: string;             // failures only
    attempt_phase?: AttemptPhase | null; // present when the settle happened mid-phase
}

// Follows the trial.settled of the failure it retries — so trial.settled is
// NOT final for a trial the retry policy may still re-run (see Automatic
// retries).
interface TrialRetryingData {
    trial_id: string;
    task_name: string;
    retry: number;                       // which retry this is (1-based)
    max_retries: number;                 // the policy's budget, for "retry 2/3" displays
    delay_sec: number;                   // the backoff before it is claimable again
    exception_type: string;              // the failure that triggered the retry
}

interface Dataset {                      // datasets().list() / get(ref)
    name: string;
    title: string | null;
    description: string | null;
    active_version: DatasetVersion | null;   // null = bare-name job refs refuse
    versions?: DatasetVersion[];         // get() only, newest first
    selected_version?: DatasetVersion | null;    // get() only — the tasks' provenance
    tasks?: Page<Task>;                  // get() only; page with { limit, cursor }
    upstream: UpstreamStatus | null;     // provenance + watch; null = no git source, NEVER "up to date"
    created_at?: string;                 // get() only
    updated_at?: string;                 // get() only
    // ActiveDataset (getActive) is the same shape with version + tasks non-optional
}

interface DatasetVersion {
    version: string;
    state: DatasetVersionState;          // the lifecycle above
    created_at: string;
    task_count: number;
    source: DatasetVersionSource | null; // THIS version's git provenance; null = not a git import
    gate: DatasetVersionGate | null;     // null = no gate scheduled (or an older server)
}

interface DatasetVersionSource {         // served on EVERY git-imported version, active or not
    git_url: string | null;              // userinfo stripped; null only if the stored url is unparseable
    ref: string;                         // exactly as requested: a sha, a tag, or (legacy) a branch
    commit: string;                      // the RESOLVED sha — for an annotated tag, the peeled commit
    path: string | null;                 // repository subfolder; null = repository root
}

interface DatasetVersionGate {           // the activation gate's progress
    status: string;                      // PENDING | RUNNING | PASSED | FAILED
    attempts: number;
    code: string | null;                 // set on failure, e.g. "gate_failed"
    message: string | null;              // the human reason, set on failure
    failed_tasks: DatasetVersionGateFailedTask[];  // the ineligible tasks, first 25
    failed_task_count: number;           // the TRUE total behind the 25-task cap
}

interface DatasetVersionGateFailedTask {
    task_name: string;
    outcome: string | null;              // FAIL, or ERROR (no usable score)
    reasons: string[];                   // the gate's own sentences
}

interface Task {                         // public fields only
    task_name: string;
    agent_timeout_sec: number;
    verifier_timeout_sec: number;
    providers: Record<EvalSandboxProvider, TaskProviderVerdict>;  // where it can run
    gate: TaskGate | null;               // this task's gate verdict; null until it ran
}

interface TaskGate {                     // the per-task half of the version's gate
    outcome: string;                     // PASS | FLAKY | FAIL | ERROR
    flaky: boolean;
    reasons: string[];                   // human-readable; empty on PASS
    ran_at: string | null;
}

type TaskProviderVerdict = { ok: true } | { ok: false; reason: string };

type DatasetSource =                     // publish() — EITHER git OR directory
    | { git_url: string; git_ref: string; directory?: never }   // ref REQUIRED: sha or tag
    | { directory: string; git_url?: never; git_ref?: never };

interface DatasetImport {
    id: string;
    status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";   // the job vocabulary
    name: string;                        // dataset the import creates or extends
    version: string;
    failure: DatasetImportFailure | null;    // never `error` on a 200 body
    warnings: ImportWarning[];           // e.g. no_solutions_archived → not activatable
    task_count?: number;
    created_at?: string;
    updated_at?: string;
}

interface Agent {                        // agents().list() / get() / create()
    name: string;                        // the value you pass in job arms
    source: "install_script" | "tarball";
    run_command: string;                 // run headless with `sh -c` at the task directory
    env: Record<string, string>;         // injected at RUN time; cannot override contract keys
    created_at: string;
    updated_at: string;
}

interface AuthStatus {                   // auth().status()
    user_id: string;
    email: string | null;
    key: { id: string; label: string | null; created_at: string; last_used_at: string | null };
}
```

### Error codes

The shape an error arrives in is described once, under [Errors](#errors); this is the vocabulary that fills its `code`. The same list is published as `error_codes` in the [capability document](#what-the-platform-supports), so a client can check its own switch against the server's, and both SDKs hold their unions to the contract's enum byte-exactly in their test suites.

Codes you will actually branch on: `dataset_not_found` (also what another account's private dataset reads as), `dataset_version_not_found`, `dataset_name_taken` (409 — the name belongs to someone else), `import_too_large` (413), `no_active_version`, `version_not_ready`, `version_not_activatable`, `unknown_task_names`, `no_tasks` (the selectors filtered every task away), `provider_unsupported`, `job_not_found`, `job_not_terminal`, `no_failed_trials`, `trial_not_found`, `agent_version_not_found`, `insufficient_credits` (402 — add credits and retry), `job_too_large` (400 — the trial matrix exceeds the published ceiling; the message states the count it would have created), `rate_limited` (retry after `retryAfterSec`), `invalid_api_key`, and `invalid_input` (which is also what the per-arm and per-attempt ceilings refuse with).

[Regrades](#regrade) add `regrade_source_ineligible` (409 — the source trial recorded no verifier inputs; the message names why) and `no_regradable_trials` (409 — a whole-job regrade found nothing eligible). [Stopping](#stopping-work) adds `invalid_ids` (400 — a stop batch that is empty or over the 100-id cap).

[Registered agents](#bring-your-own-agent) add their own: `agent_not_found` (also what another owner's name reads as), `agent_name_taken`, `agent_name_reserved` (the name collides with a built-in), `agent_source_required` (neither an install script nor a tarball), `agent_source_conflict` (both), `agent_invalid_env` (declared env tries to override a run-contract key), `agent_invalid_name`, `agent_too_large`, and `agent_limit_reached` (the per-account ceiling).

[Datasets](#bring-your-own-dataset) add `dataset_not_owned`, `dataset_in_use` (409 — jobs reference it; `details` names a sample), `package_not_retained`, `package_missing` (410), `upstream_not_watchable` (the auto-import toggle on a dataset with no moving ref), and `unpinned_git_ref` (a git publish whose ref is a branch name or otherwise not pinned — pass a full commit sha or a tag; for a branch, the refusal's `details.commit` is the sha to use).

Three more come from the shapes above: `idempotency_key_reused` (409 — the key already stands for a different request), `invalid_multipart` (400 — an upload that is not `multipart/form-data`, or is malformed), and `invalid_cursor` (400 — a malformed `cursor` on a paged read).
