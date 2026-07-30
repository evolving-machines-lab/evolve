# Hosted Evals

> **Gateway feature** — requires `EVOLVE_API_KEY` (see [Getting Started → Gateway Mode](./01-getting-started.md#gateway-mode-evolve_api_key)). Evolve runs the benchmark tasks, agents, and verifiers on managed infrastructure — you submit a job and read results.

Three standalone clients cover the whole surface — no `Evolve` instance needed:

```ts
import { benchmarks, customHarnesses, jobs } from "@evolvingmachines/sdk";

const catalog = benchmarks();        // the shared benchmark catalog
const harnesses = customHarnesses(); // your own private harnesses
const evals = jobs();                // your jobs
```

All three read `EVOLVE_API_KEY` from the environment, or accept `{ apiKey, baseUrl }`.

If you would rather configure once, `hosted()` is the same three clients behind one door:

```ts
import { hosted } from "@evolvingmachines/sdk";

const evolve = hosted();                    // or hosted({ apiKey, baseUrl })
const catalog = await evolve.benchmarks.list();
const job = await evolve.jobs.run({ /* … */ });
```

It is called `hosted()` rather than `evolve()` because `Evolve` is already the local-sandbox class in this package, and two exports a shift key apart doing unrelated things is a trap worth avoiding. The three clients are built on first access, so `evolve.meta()` — the one call that needs no credentials — works before an API key is set.

---

## Run a job

Pick a benchmark from the catalog:

```ts
const page = await catalog.list();                   // one page of benchmarks + active versions
for await (const bench of catalog.list()) { /* … */ }  // or walk the whole catalog

const deepSwe = await catalog.get("deep-swe@1.1");   // one version: task list + timeouts
const active = await catalog.getActive("deep-swe");  // active READY version, guaranteed runnable
// getActive() throws NoActiveVersionError when nothing is runnable yet
```

Every collection on this surface is the same page: `{ items, nextCursor, hasMore }`, paged with `{ limit, cursor }`. `nextCursor` means one thing everywhere — pass it back for the next page, and `null` means there is no next page. Both list calls hand you a value you can either await for a single page or iterate to walk every row, fetching pages as it goes.

`READY` is the one benchmark-version state that accepts jobs — see [Statuses](#statuses). Tasks expose public fields only — `taskKey`, `agentTimeoutSec`, `verifierTimeoutSec`, and `providers`, the per-provider capability verdict ([Where it runs](#where-it-runs)). Instructions, environments, and tests never leave the server — with one deliberate exception, the benchmark's own owner downloading the package they imported ([Getting your corpus back](#getting-your-corpus-back)).

Then create the job. Only `benchmark` and `agents` are required:

```ts
const job = await evals.run({
    benchmark: "deep-swe",              // bare name = active version; "deep-swe@1.1" pins one
    agents: [
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
    concurrency: 4,                     // (optional) parallel trials, default 4, ceiling 16
    maxTrialSpendUsd: 25,               // (optional) hard model-spend cap for EACH trial
});

console.log(job.status);        // "QUEUED"
console.log(job.benchmark);     // "deep-swe@1.1" — the resolved version, echoed back
console.log(job.counts);        // { agents: 2, tasks: 2 } — entity cardinality
console.log(job.trials.total);  // 4
console.log(job.trials.byStatus); // { QUEUED: 4, RUNNING: 0, SCORED: 0, … } — every status
```

Every job response is the same shape, whatever produced it. `run()`, `get()`, `cancel()`, `rerunFailed()` and each row of `list()` carry the same fields, so a job card renders from any of them without your knowing which call it came from. `counts` is entity cardinality — the parts a job is made of — and `trials` is the one "how many" structure: a total plus a status histogram that names every status, zeros included, so a status bar never needs the enum hardcoded.

`maxTrialSpendUsd` caps what a single trial may spend on model calls, and it is the only spend limit the platform enforces: every trial runs on its own freshly minted gateway key, and the cap is that key's budget. Leave it out and the platform applies $200 per trial. The response always reports the cap that actually applied — `job.maxTrialSpendUsd` — so an omitted one is never a mystery.

There is no job-wide budget, which means a job's real ceiling is simply its trial count times that cap. The response states it for you as `job.worstCaseSpendUsd`, so you can see what a large matrix commits you to before it starts running. Your account credit balance is the hard backstop underneath all of it: when the balance runs out, spending stops mid-job whatever the caps say, and creating a job while the balance is already at zero is refused up front with a `402 insufficient_credits`. A trial that exhausts its own cap is not a failure — the harness just runs out of budget, and the trial is still scored on whatever it produced.

Runs on your own provider key are the one exception to the credit ledger. When a [managed BYO provider key](./01-getting-started.md#managed-byo-provider-keys) is enabled for the model's provider (Anthropic and OpenAI today), the trial's model calls bill your provider account directly and draw no Evolve credits — the per-trial cap still meters and bounds the trial exactly as before.

The exception is about who pays for model calls, not about the gate at the door. The zero-balance check runs on every job create and every `rerunFailed()`, BYOK included, so an account sitting at zero is refused with `402 insufficient_credits` even when the run would have drawn nothing. Keep a non-zero balance if you run BYOK-only.

A job expands to `tasks × agents × runsPerTask` trials, each in its own sandbox. `concurrency` is how many of them run at once: four by default, sixteen at the ceiling, and every one of those numbers is published under `limits.job.concurrency` in the [capability document](#what-the-platform-supports) rather than only here.

Three ceilings bound that expansion, and all three refuse at create rather than partway through: at most **8 distinct agents** after de-duplication and at most **100 `runsPerTask`**, each a `400 invalid_input`, and a total matrix of at most **10,000 trials**, which is `400 job_too_large`. They are published as `limits.job.maxAgents`, `maxRunsPerTask` and `maxTrials`, so a form can check a sweep before it POSTs. `sandboxProvider` (optional, default `"e2b"`) picks where those sandboxes run — see [Where it runs](#where-it-runs). Valid harness + model pairs are the same as everywhere in the SDK — see [Getting Started → Harness and Model Pairing](./01-getting-started.md#harness-and-model-pairing). `harness` also accepts a harness you registered yourself — see [Bring your own harness](#bring-your-own-harness).

Pin a harness version when you need the comparison to hold still across weeks:

```ts
agents: [
    {
        harness: "codex",
        model: "gpt-5.5",
        harnessVersion: "0.29.0",   // (optional) omit to resolve the latest at dispatch
    },
],
```

Omitting it keeps the resolve-latest behavior; either way the version that actually ran is recorded on every trial as `resolvedHarnessVersion`, so a trial is always attributable after the fact.

A pin is never silently downgraded to the latest — it is checked at creation and rejected three ways:

- **Not an exact version** (a range, a tag, `latest`) — `400 invalid_input`, naming the need for an exact version. Pins exist to hold a comparison still, and a range cannot.
- **Exact but not published** — `404 harness_version_not_found`.
- **A pin on a custom harness** — `400 invalid_input`. Custom harnesses are versioned by the content of their own source, so there is no separate version axis to pin; re-register to change what runs.

One harness resolves later than the others: installer-sourced `kimi` accepts any well-formed exact pin at creation, because its vendor publishes no version index to check against. The builder's version probe enforces it instead, so a bad `kimi` pin surfaces as a failed trial rather than a `400`.

`reasoningEffort` is the other per-agent knob, and it belongs to the comparison rather than to the run:

```ts
agents: [
    {
        harness: "codex",
        model: "gpt-5.5",
        reasoningEffort: "high",    // (optional) omit to take the harness's own pinned default
    },
],
```

The accepted values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and `thinking`, published as `limits.job.reasoningEfforts`. What an omitted value means is per harness: each harness entry in the capability document publishes its own `defaultEffort` (today `high` for the graded harnesses, `max` for `kimi`, `thinking` for `qwen`), and the create door resolves an omitted effort to that pin and stores it on the record. Read it from the [capability document](#what-the-platform-supports) rather than from this sentence: effort changes the score, so a client comparing two jobs has to know what an omitted value meant in each of them.

Effort is part of an agent system's identity, alongside the harness, the model and the version pin. The same harness and model at `low` and at `high` are two distinct systems — they de-duplicate separately, they each consume one of the eight agent slots, and every trial echoes the effort back on `trial.agent`. A `null` there is reserved for harnesses where no effort applies at all — an omitted effort on a harness that takes one is resolved to the harness's pinned default at create, so the record always says what the CLI was actually asked.

Not every harness can honor one, and a request naming an effort a harness cannot apply is refused at creation with a `400 invalid_input` rather than accepted and quietly dropped. Recording `high` against a CLI that never received the flag would put a claim in the benchmark record that did not happen:

- `claude`, `codex`, `droid`, `opencode` and `kimi` take a graded level, and the value reaches the CLI as one (`kimi` runs at `max` when omitted — the Kimi K3 API's own default).
- `qwen` can express only thinking on or off, so it accepts the binary values (`thinking`, `off`, `minimal`, `medium`) and refuses every graded level above them.
- `gemini` takes no effort input at all, so naming any effort for it is refused.

Each harness publishes which of the three it is as `effortSupport`, so a picker greys the control out instead of discovering the refusal after a POST. Omitting the field is always accepted, `gemini` included — the refusal is about a value that could not be applied, never about the field existing.

A harness you registered yourself is never refused, because the platform makes no claim about what someone else's CLI accepts. It is also never handed the value: the [run contract](#the-run-contract) gives your command six environment keys and effort is not among them, so an effort set here is recorded on the agent system and reaches nothing. Put the flag in your own `runCommand`.

Retries are safe — pass an idempotency key and a retry returns the original job instead of creating a duplicate:

```ts
const retry = await evals.run(
    {
        benchmark: "deep-swe",
        agents: [{ harness: "codex", model: "gpt-5.5" }],
        maxTrialSpendUsd: 25,
    },
    { idempotencyKey: "nightly-2026-07-23" },
);
console.log(retry.idempotentReplay);   // true when the key replayed an existing job
```

A key on its own is not enough to make a request idempotent, so the server also fingerprints the request behind it. Repeat the same request with the same key and you get the original job back; send a *different* request under a key you have already used and it is refused with a `409 idempotency_key_reused` rather than handed yesterday's job while you believe a new run started. Use a fresh key for a genuinely new run.

---

## Watch it live

`watch()` is a dual-use handle over the job's event stream. Iterate it for live events, or await it for the final job — pick one form per call:

```ts
// Iterate events as they arrive
for await (const event of evals.watch(job.id)) {
    // event.seq  — monotonic sequence number
    // event.type — "job.created" | "trial.settled" | "job.completed" | ...
    if (event.type === "trial.settled") {
        // JobEvent is a discriminated union: switching on `type` narrows
        // `data`, so taskKey and status are typed here with no cast.
        updateProgress(event.data.taskKey, event.data.status, event.data.reward);
    }
}

// Or await the final Job
const final = await evals.watch(job.id);
console.log(final.status, final.trials.byStatus, final.meanReward, final.spentUsd);
```

Options apply in every form — abort or tune backoff on an iterated watch the same way; `onEvent` fires regardless:

```ts
const controller = new AbortController();

const final = await evals.watch(
    job.id,
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
- Once the job reaches a terminal status, the handle resolves with the final `Job`.

---

## Read the results

```ts
// One job: size, status histogram, mean reward, spend
const detail = await evals.get(job.id);
console.log(detail.trials.total, detail.trials.byStatus);  // 20, { SCORED: 12, RUNNING: 3, … }
console.log(detail.meanReward);                     // mean over SCORED trials; null until something scores
console.log(detail.spentUsd, "/", detail.worstCaseSpendUsd);
console.log(detail.failure);                        // why it FAILED — null on every job today

// Your jobs, newest first — await one page, or iterate them all
const jobPage = await evals.list({ limit: 50 });    // jobPage.nextCursor continues
for await (const item of evals.list()) {
    console.log(item.id, item.status, item.benchmark, item.meanReward);
}
```

A failed job says why on `failure`, as `{ code, message }` — the same grammar an API error uses, under a different key so that `if (body.error) throw` stays correct on a healthy read. It rides on list rows too, so a dashboard shows the reason without a detail call per row. In practice you will not see it fire: `FAILED` is a [reserved job status](#statuses) that nothing sets today, so `failure` is null on every job. Read `trials.byStatus` for where a job actually went wrong.

Trials paginate the same way — await a page or iterate across pages. `status` filters, e.g. to the failures behind a rerun decision:

```ts
for await (const trial of evals.trials(job.id)) {
    console.log(trial.taskKey, trial.agent.harness, trial.status, trial.reward);
}

const failures = await evals.trials(job.id, {
    status: ["INFRASTRUCTURE_ERROR", "SCORING_ERROR"],
});
```

One trial in depth:

```ts
const trial = await evals.trial(
    job.id,
    trialId,
);
console.log(trial.reward, trial.metrics);              // reward + named sub-scores
console.log(trial.phaseTimingsMs);                     // { agentMs, verifyMs }
console.log(trial.spentUsd, trial.spendSource);        // what it cost, and how we know
console.log(trial.sandboxProvider, trial.verifierMode); // where the trial and its verifier executed
console.log(trial.modelUsage.networkMode,              // "no-network" | "allowlist" | "public"
            trial.modelUsage.networkPolicySource);     // "explicit" | "legacy_allow_internet" | "upstream_default"
console.log(trial.resolvedHarnessVersion);             // harness version actually used
console.log(trial.failurePhase, trial.failureDetail);  // untruncated in this response
```

> **Reading spend:** `spendSource: "measured"` is the platform's settled figure and the only final one. `"measured_provisional"` is a real reading taken before the gateway finished writing this trial's spend — a lower bound that can only move UP, finalized within about half an hour of the trial settling. `"assumed_cap"` means spend could not be measured at all, so the per-trial cap is reported conservatively. Fresh trials commonly show one of the latter two for a few minutes; wait for `"measured"` before treating a number as final.
>
> Both fields live on the trial itself. `spentUsd: null` means the trial never ran — a queued or cancelled trial — and is not the same as `0`, which is a real measurement and appears when no gateway key was ever minted.
>
> Read spend from `spentUsd`, never from `modelUsage`. `modelUsage` is the open-ended per-harness blob: bundle identity, token counts, `maxTrialSpendUsd` (the cap *that* trial's key carried, which can differ from the job's cap today), and — on trials settled by an earlier executor — a historical `costUsd`. That leftover is a usage fact the harness reported, not the platform's spend answer, and only `spentUsd` carries `spendSource` to tell you how it was arrived at.

> **Reading the trial's egress:** `networkMode` is what the agent could reach, and
> `networkPolicySource` is where that came from — `"upstream_default"` means the task declared
> nothing and the omitted-means-public rule applied. Compare rewards only across trials that
> agree on both: an agent with internet access ran a different experiment from a sealed one.

While a trial is still in flight there is a mid-run reading as well, on two fields of its own:

```ts
console.log(trial.liveSpentUsd, trial.liveSpendAt);  // 3.41  "2026-07-24T18:22:05.113Z"
```

Read them together or not at all. `liveSpentUsd` is a **lagging lower bound**, never the trial's cost: the gateway settles spend 40–70 seconds behind the calls that incurred it, and the platform samples the trial's key roughly every two minutes, so the number is always behind and `liveSpendAt` is how far behind. Render it as "at least $3.41, as of 90s ago" — never as "current cost".

The rest of its behavior follows from that:

- **`null` is "no reading yet", never `$0`.** A zero from the gateway means nothing has settled, not that the trial was free, so a zero is skipped rather than written.
- **It is never part of a total.** `job.spentUsd` sums settled trials only, and folding a live reading into it would double-count the moment that trial settles.
- **It stops moving when the trial does.** Nothing writes it once the row is terminal, so what remains is the last mid-run sample — stale by construction. On a terminal trial read `spentUsd` and `spendSource`; that is the settled truth, and it is the only one.
- **Built-in harnesses only.** A custom harness runs your own command with no live poll around it, so its trials go from `null` straight to a settled `spentUsd`.

The same reading reaches a watcher as a `trial.spend` event carrying `trialId`, `taskKey` and `liveSpentUsd`. It is emitted only when a sample actually landed on a live trial, so a poll that raced the settle never fires one.

Fetch a trial's recorded event timeline:

```ts
for await (const event of evals.trialTraceEvents(
    job.id,
    trialId,
)) {
    console.log(event.seq, event.type, event.data);
}

// Or page manually — the same envelope as every collection
const trace = await evals.trialTrace(
    job.id,
    trialId,
    { limit: 500 },
);
const more = await evals.trialTrace(
    job.id,
    trialId,
    { cursor: trace.nextCursor! },
);
```

### Trial artifacts — the raw record

Beside the parsed trace, every trial archives its raw record, and one
vocabulary names the pieces everywhere — API, SDK, CLI, and the dashboard's
download menu:

```ts
const stdout = await evals.trialArtifact(job.id, trialId, "trace-stdout");   // string | null
const stderr = await evals.trialArtifact(job.id, trialId, "trace-stderr");   // string | null
const grader = await evals.trialArtifact(job.id, trialId, "verifier");       // string | null
const home   = await evals.trialArtifact(job.id, trialId, "agent-home");     // Record<path, text> | null
```

`trace-stdout` and `trace-stderr` are the harness process's streams, byte for
byte — the referee whenever the parsed trace looks wrong. `verifier` is
everything the scoring step printed. `agent-home` is the CLI's entire home
folder (`/root/.claude`, `/root/.codex`, ...) collected whole after the run,
subagent transcripts included by construction, keyed by sandbox path. Null is
a normal answer, never an error: the trial never stored that artifact (it was
cancelled early, the harness wrote nothing, or the trace was purged).

The CLI speaks the same words: `evolve-evals trace <job> <trial>
--stream trace-stdout` prints one artifact, and `--save <dir>` writes the
whole set — `trace-parsed.jsonl`, `trace-stdout.log`, `trace-stderr.log`,
`verifier.log`, and `agent-home/` with the folder tree preserved. On the wire
these are `?stream=` selectors on the trace route. The two modes are
exclusive, and `--cursor`/`--limit` page only the plain event listing — the
CLI refuses any mix as a usage error instead of letting one flag silently win.

This archive belongs to hosted evals: trials are scoring evidence. A managed
agent session keeps its parsed transcript download; its raw stream lives in
the SDK's local session log and its home folder inside your own sandbox.

The first event of every trace (`seq` 0) is the task instruction itself, carried as `_prompt` — a trace read on its own opens with the prompt rather than mid-conversation, the same promise Harbor's trajectories make.

`trialTraceEvents()` drains the currently available trace, then stops — `nextCursor` is `null` once you are caught up, which is how the drain knows. A trace cursor is a position in the seq timeline, so to follow an in-flight trial later, keep the last event's `seq` and resume with `{ cursor: String(lastSeenSeq) }`.

### Cancel / rerun failures

```ts
await evals.cancel(job.id);    // idempotent; a terminal job is a no-op

// New linked job of only the failed (and never-dispatched) trials
const rerun = await evals.rerunFailed(
    job.id,
    { idempotencyKey: "rerun-1" },
);
console.log(rerun.sourceJobId); // → job.id
```

`rerunFailed()` requires a terminal source job. Scored trials are never re-executed.

---

## Regrade

A regrade re-runs **only the verifier**. The trial's recorded submission — the patch and artifacts captured when it ran — is restored into a fresh, sealed verifier sandbox and scored again; the agent phase is never re-run, and the source trial is never modified. Use it when a verifier was fixed or tightened and you want the same agent work re-scored under it, without paying for a single new agent run.

```ts
// One trial
const single = await evals.regradeTrial(job.id, trialId);

// Every regradable trial of a terminal job — optionally narrowed
const bulk = await evals.regrade(job.id, {
    status: ["SCORED"],       // (optional) only source trials in these statuses
    taskKey: "task-001",      // (optional) only source trials of this task
});

// Read it back by the REGRADE's id: QUEUED → RUNNING → COMPLETED
const done = await evals.getRegrade(bulk.id, { limit: 100 });
for (const result of done.results.items) {
    console.log(result.taskKey, result.sourceReward, "→", result.reward,
        result.rewardDelta);  // reward − sourceReward, the per-trial delta
}
```

All three return a `RegradeJob`. A per-trial regrade holds one result; a per-job regrade holds one per selected source trial. `results` is one object named for the collection: `total` and `byStatus` cover the whole job, `items`/`nextCursor`/`hasMore` are the page you asked for — a regrade of a 10,000-trial job is not one response. Poll `getRegrade()` until `status` is `COMPLETED`; `results.byStatus` is the running histogram, and it is derived from the whole result set rather than the page in hand.

`getRegrade()` takes the **regrade's** id — the one `regrade()` and `regradeTrial()` return, and the one their `Location` header names. To find a regrade you no longer hold the id for, or to see every regrade of a job, list them:

```ts
// Every regrade of one job, newest first
for await (const regrade of evals.listRegrades({ jobId: job.id })) {
    console.log(regrade.id, regrade.status, regrade.results.total);
}

// Or one page at a time
const page = await evals.listRegrades({ limit: 20 });
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

- `sourceReward` and `sourceStatus` — immutable snapshots of the source trial, taken when the regrade was created. The source trial's own row is untouched.
- `reward` and `metrics` — what the fresh verifier run produced.
- `rewardDelta` — `reward − sourceReward` when both are real numbers, else `null`.
- `verifierDigest` — a content digest of the verifier that ran, the "verifier version". A digest equal to the source trial's own verifier means the regrade reproduces the recorded verdict; a different digest means a genuine prediction of what the new verifier scores.

Result statuses mirror the trial reward law: a valid reward (including 0) is `SCORED`; a verifier crash or out-of-domain reward is `SCORING_ERROR`; a missing reward file is `INDETERMINATE`; a verifier box lost before a durable verdict is `INFRASTRUCTURE_ERROR`. The verifier always runs `separate` and sealed; `sandboxProvider` on the regrade job names where its verifier boxes run — the source job's provider.

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

```ts
const comparison = await evals.compare([jobA.id, jobB.id]);

for (const aggregate of comparison.jobs) {
    console.log(aggregate.benchmark, aggregate.meanReward,
        `${aggregate.coverage.scored}/${aggregate.coverage.total} scored`, aggregate.spentUsd);
}

for (const row of comparison.taskMatrix) {
    if (!row.disagreement) continue;
    for (const cell of row.cells) {
        console.log(row.taskKey, cell.status, cell.meanReward);
        // cell.status: TrialStatus, "MIXED" (trials disagree), or "MISSING" (no trials)
    }
}
```

Mean rewards cover `SCORED` trials only; `coverage` is always reported so a high mean over few scored trials stays visible. Zero is a reward, never a gap.

---

## Export

Download the full research archive (gzipped JSON) of a terminal job:

```ts
const buffer = await evals.export(job.id); // Buffer (default)
const path = await evals.export(
    job.id,
    { to: "./results" },
); // save; returns file path
const stream = await evals.export(
    job.id,
    { stream: true },
); // raw response stream

// Harbor job-layout bundle instead of the canonical archive
const harborPath = await evals.export(
    job.id,
    {
        to: "./results",
        format: "harbor",
    },
);
```

`format: "harbor"` composes with any delivery shape (`Buffer`, `to`, or `stream`).

---

## CLI

The SDK ships an `evolve-evals` binary — a thin shell over `benchmarks()` / `jobs()`:

```bash
npx evolve-evals run \
    --benchmark deep-swe@1.1 \
    --agent codex:gpt-5.5 \
    --agent claude:fable \
    --concurrency 4 \
    --max-trial-spend 25 \
    --watch
```

Run flags, in the order you decide them:

- `--benchmark <name[@version]>` — required; bare name = active version
- `--tasks <k1,k2,…>` — default: every task of the version
- `--agent <harness:model[:version]>` — required; repeat once per agent. The optional third part pins the harness version (`codex:gpt-5.5:0.29.0`); omit it to resolve the latest
- `--effort <value>` — reasoning effort for **every** agent in the run, applied verbatim; an agent whose harness cannot honor it is refused by the server rather than silently skipped, so a mixed sweep that needs per-agent efforts belongs in the SDK. Omit it to take the platform default
- `--runs <n>` — runs per task × agent (default 1)
- `--concurrency <n>` — parallel trials (default 4, ceiling 16)
- `--max-trial-spend <usd>` — model-spend cap for each trial (default: the platform's $200)
- `--provider <e2b|daytona|modal>` — default `e2b`
- `--watch` — stream events until the job finishes

The rest of the surface:

```bash
npx evolve-evals list --limit 20
npx evolve-evals get <id>
npx evolve-evals trials <id> --status INFRASTRUCTURE_ERROR,SCORING_ERROR
npx evolve-evals trial <id> <trial-id>
npx evolve-evals trace <id> <trial-id> --cursor 100
npx evolve-evals compare <id> <id>
npx evolve-evals cancel <id>
npx evolve-evals rerun-failed <id>
npx evolve-evals regrade <id> [trial-id]
npx evolve-evals regrade-job <regrade-job-id>
npx evolve-evals export <id> --to ./results --format harbor
npx evolve-evals benchmarks
npx evolve-evals benchmarks get deep-swe@1.1
npx evolve-evals custom-harnesses
npx evolve-evals custom-harnesses get acme-cli
npx evolve-evals custom-harnesses remove acme-cli
```

- `--limit` and `--cursor` page every listing the same way — `list`, `trials`, `trace`, `benchmarks`, `benchmarks get` (its task list), `custom-harnesses`, and `regrade-job`.
- Human-readable tables by default; `--json` emits machine-readable JSON (NDJSON for `--watch` streams).
- Credentials: `$EVOLVE_API_KEY`, or `--api-key`; `--base-url` targets a non-default deployment.
- Exit codes: `0` success (with `--watch`: `COMPLETED`, for a job or an import alike), `1` runtime failure (with `--watch`: `FAILED` or `CANCELLED`), `2` usage error.

Benchmark imports and harness registration have their own subcommands — `npx evolve-evals import …` and `npx evolve-evals custom-harnesses add …` — shown in [Bring your own benchmark](#bring-your-own-benchmark) and [Bring your own harness](#bring-your-own-harness).

---

## What the platform supports

Everything a client would otherwise hardcode — the legal harness names, the status enums, the limits, the error codes — is one public, cacheable document. It needs no API key, so a signed-out page can populate its own harness picker.

```ts
import { meta } from "@evolvingmachines/sdk";

// `meta` is exported from the package root, and is also `hosted().meta()` —
// the same document either way. Use the standalone form when you have no
// client to hand, which on a signed-out page is the usual case.
const { harnesses, sandboxProviders, statuses, limits, errorCodes } = await meta();

// A model picker, without a hardcoded table
for (const harness of harnesses) {
    console.log(harness.name, harness.defaultModel, harness.models.length);
}
```

`GET /api/meta` is the wire form. Every field is derived from the module that enforces it, so a published limit and an enforced limit cannot drift apart, and a new harness appears here the moment the platform can run it.

What is in it:

**`harnesses`** — every built-in, with `defaultModel` and the full `models` list for a picker, `runnable` (and `reason` when it is not), `versionPinnable`, and `latestVersion` for a "your pin is out of date" badge. `defaultModel` is a suggestion, not a server-side default: `limits.job.modelRequired` is `true`, and a job that omits `model` is refused. `effortSupport` is the same idea for the effort control — `"level"`, `"binary"` or `"none"`, exactly as [Run a job](#run-a-job) describes them — so a form can offer the right control, or none, instead of learning the harness's limits from a refusal. For a `"binary"` harness the acceptable spellings are published as `limits.job.binaryEffortValues`, so a picker can narrow its options instead of offering eight values the server will refuse six of.

**`sandboxProviders`** — each provider's real resource ceilings and, in `refuses`, the capabilities it will not run with the reason the runner itself would give.

**`platformConstraints`** — a top-level list of its own, holding the refusals that apply on *every* provider, so "runs nowhere" is distinguishable from "runs somewhere else".

**`networkModes`** — the three modes a task may declare, which is exactly the list a "Network modes" filter needs. They are explained in [What runs](#network-modes).

**`statuses`** — the job, trial, import, regrade-job, regrade-result, and benchmark-version vocabularies, each with its `terminal` members marked. A watcher stops on `terminal`; a status bar renders `values` without hardcoding the enum.

**`limits`** — five keys. `job` carries every create-time bound: `maxAgents`, `maxRunsPerTask`, `maxTrials`, `concurrency` (default and ceiling), `defaultMaxTrialSpendUsd`, `defaultSandboxProvider`, `modelRequired`, and `defaultSizing`. Four more are the values a run inherits when nothing declares one: `reasoningEfforts` and `defaultReasoningEffort` are the effort vocabulary and the omitted-value default from [Run a job](#run-a-job), and `defaultAgentTimeoutSec` (3600) and `defaultVerifierTimeoutSec` (600) are the phase wall-clocks a task falls back to when its own `task.toml` declares none — a task that declares `agent.timeout_sec` or `verifier.timeout_sec` always wins, so these fill in rather than cap. They are published because nothing else on the document says how long a trial may run. `pagination` is three separate scopes with three different pairs — `collections`, `benchmarkTasks`, and `regradeResults` each publish their own `default` and `max`, so read the one for the collection you are paging rather than applying a single pair everywhere. `uploads` holds the two archive size caps, `benchmarkNames` the name pattern and length bounds, and `maxItemsNamedInErrorMessage` sits at the top level: it is how many offending items a refusal names in its English sentence before "and N more", which is why `details` exists.

**`errorCodes`** — the whole vocabulary below, in one array.

**`customHarnesses`** — the registration rules, so a form can validate before it POSTs: the name pattern, the size caps, the reserved names and reserved env keys, and `maxPerUser`, the per-account registration ceiling. That ceiling lives here rather than under `limits` because it belongs to the same rules a registration form already reads.

`schemaVersion` moves when a field is added, removed, or changes meaning — never when a value changes. Pin behavior to it, not to a deploy date. Responses carry an `ETag` and `Cache-Control: public, max-age=300, stale-while-revalidate=300`; send the ETag back as `If-None-Match` and a matching document answers `304` with no body.

---

## Errors

Every failure is one shape:

```ts
import { EvolveApiError } from "@evolvingmachines/sdk";

try {
    await evals.run({
        benchmark: "deep-swe",
        agents: [{ harness: "codex", model: "gpt-5.5" }],
        sandboxProvider: "modal",
    });
} catch (err) {
    if (err instanceof EvolveApiError && err.code === "provider_unsupported") {
        // Every refused task, with its reason. Not a sentence to regex.
        const { provider, refusedTasks } = err.details as {
            provider: string;
            refusedTasks: { taskKey: string; reason: string }[];
        };
        console.log(`${refusedTasks.length} tasks cannot run on ${provider}`);
    }
}
```

- **`code`** is the stable identifier, typed as a closed union, so `err.code === "insufficient_creidts"` is a compile error rather than a branch that silently never runs. `HOSTED_ERROR_CODES` and `isHostedErrorCode()` are exported for runtime checks; a server newer than your SDK may send a code the union does not list, which is why `code` widens to `string`.
- **`message`** is the human sentence, and it may be shortened. **`details`** never is. When a refusal says "and 8 more", all of them are in `details` — that is the rule, and it is why `details` exists.
- **`param`** names the input that was wrong — a body path (`agents[0].harness`), a query parameter (`limit`), or a multipart part (`runCommand`) — so a form can highlight one field instead of showing a banner.
- **`retryAfterSec`** is set on `429` and `503`, read from the body first and the `Retry-After` header second (a cross-origin browser fetch cannot always see the header).
- **`requestId`** identifies the failure server-side. Quote it in a support thread.

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

Both are supported; the task picks (Harbor's `environment_mode`). The mode that ran is recorded on every trial as `verifierMode`.

### Compute sizing

Tasks declare `cpus`, `memory_mb`, and `storage_mb`, and get exactly that. A provider whose ceiling is below the declaration **refuses the trial** — named in the per-task provider verdicts below and in the trial's `failureDetail` — rather than silently provisioning less. Current ceilings:

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
const job = await evals.run({
    benchmark: "swe-bench-verified@1.0",
    agents: [
        {
            harness: "codex",
            model: "gpt-5.5",
        },
    ],
    maxTrialSpendUsd: 25,
    sandboxProvider: "daytona",   // "e2b" (default) | "daytona" | "modal"
});
```

An unknown value is rejected with a `400` at creation — never a silent fallback. Once chosen, the provider is fixed for the job's life; `rerunFailed()` inherits it.

Not every task can run everywhere. The catalog tells you **before any money is spent** — every task carries a per-provider verdict:

```ts
const bench = await catalog.get("my-bench@1.0");
for (const task of bench.tasks?.items ?? []) {
    const verdict = task.providers.modal;   // { ok: true } | { ok: false, reason }
    if (!verdict.ok) console.log(task.taskKey, "cannot run on modal:", verdict.reason);
}
```

Creating a job whose selected tasks include one refused on the chosen provider is rejected with a `400 provider_unsupported` naming the tasks and each task's reason, rather than accepted and billed until it fails.

The verdict is narrower than the full set of things a provider can decline, and knowing where the line falls saves you a confusing trial. Three refusals are decided from the task's stored spec, so they are in `providers` and they are what a job creation checks against:

- **Multi-container tasks run on `e2b` and `daytona`.** Modal cannot run them today — the task's `providers.modal` verdict names the reason, and the task stays runnable on the other two providers.
- **Multi-container + `no-network` is declined on every provider** for now. Run those tasks with an `allowlist` or `public` network policy.
- **Sizing above a provider's ceiling** refuses on that provider only — see [Compute sizing](#compute-sizing).

The rest are decided when the sandbox is actually created, so they surface as a trial that ends `INFRASTRUCTURE_ERROR` with the reason in its `failureDetail` rather than as a `400` at creation. There are two, and both are Daytona-and-Modal specifics you can check yourself before choosing a provider:

- **Daytona serves IP-based allowlists only.** Its network filter takes IPv4 addresses and CIDRs, capped at 10 entries — a cap that also has to fit the address the agent uses to reach its model, so a task's own list gets slightly fewer. A task whose `allowlist` names a hostname, or needs more than the cap, fails on Daytona when its sandbox is created. Run it on e2b or Modal, which serve hostname allowlists. Daytona serves `no-network` and `public` normally.
- **Modal caps every sandbox at 24 hours.** A task whose timeout exceeds the cap fails fast when its sandbox is created — never truncated mid-run.

---

## Bring your own benchmark

Any corpus of tasks in Harbor format runs on the hosted stack: point at it, import it, let the activation gate certify it, run it. A benchmark in another format gets converted *into* Harbor format first — the layout is small, and a complete task fits on one screen (below).

What you import is **private to your account**. It never appears in anyone else's catalog, and another account asking for its name reads a plain `404 benchmark_not_found` — existence is never leaked. Your own `catalog.list()` shows the shared platform benchmarks plus your imports. A name belongs to its first importer: re-importing a name you own extends that benchmark with a new version (or refreshes one), while importing a name owned by anyone else — a platform benchmark or another account's private one — is refused with a `409 benchmark_name_taken`.

### Already in Harbor format

Import from a git repository pinned to a ref, or upload a local corpus directory — the same corpus, the same pipeline, the same rules either way:

```ts
// From a git repository, pinned to a ref
const importJob = await catalog.import({
    source: {
        gitUrl: "https://github.com/acme/my-bench.git",
        ref: "v1.0.0",            // a branch, tag, or commit — always pinned
    },
    benchmarkName: "my-bench",
    version: "1.0",               // the version label for the imported corpus
});

// From a local directory — tarred + gzipped deterministically on the client and uploaded
const localImport = await catalog.import({
    source: { directory: "./my-bench" },
    benchmarkName: "my-bench",
    version: "1.0",
});

// Block until COMPLETED or FAILED
const done = await catalog.watchImport(
    importJob.id,
    {
        onStatus: (benchmarkImport) => console.log(benchmarkImport.status, benchmarkImport.taskCount),
        pollIntervalMs: 2_000,        // (optional) default 2s
    },
);

if (done.status === "FAILED") {
    // `failure`, not `error` — `error` is the key the FAILURE ENVELOPE uses, so
    // `if (body.error) throw` has to stay correct on a healthy read of a failed
    // import. Same grammar as a job's `failure`.
    console.log(done.failure?.code, done.failure?.message);  // "2/113 task(s) failed to parse"
    for (const failed of done.failure?.failures ?? []) {
        console.log(failed.taskKey, failed.error);
    }
}

// Lost the id? List your imports — await one page, or walk them all.
for await (const job of catalog.listImports({ status: "FAILED" })) {
    console.log(job.id, job.benchmarkName, job.version, job.failure?.message);
}

// Narrow to one benchmark's import history, newest first
const history = await catalog.listImports({ benchmark: "my-bench", limit: 20 });
```

`listImports()` takes `status` and `benchmark` as filters and `limit`/`cursor` for paging, and returns the same `BenchmarkImport` shape the `202` did — so a row renders without a follow-up read.

`getImport(id)` is the single read behind all of this, and it is what you want when you are not blocking: it returns one `BenchmarkImport` — status, `taskCount`, and `failure` once there is one. `watchImport()` is a poll loop over it, so reach for `getImport()` when you are driving your own scheduler or rendering a status chip on request rather than holding a process open. A terminal import stays readable indefinitely, id included.

```bash
npx evolve-evals import \
    --git https://github.com/acme/my-bench.git \
    --ref v1.0.0 \
    --name my-bench \
    --version 1.0 \
    --watch
npx evolve-evals import --dir ./my-bench --name my-bench --version 1.0 --watch
npx evolve-evals import status <id>
```

Every lane resolves to the same thing — a Harbor-layout directory — and is held to the same rules. The corpus root is a directory whose `tasks/` subdirectory holds one directory per task, or the tasks directory itself. Provenance is recorded per lane: the resolved commit for a git import, the sha256 of the exact uploaded bytes for a directory. On the wire an import is `multipart/form-data`: `benchmarkName` and `version` as named parts, and either `gitUrl` + `ref` or the gzipped corpus as a `file` part — the SDK produces it for you — and uploads past the compressed-size cap (512 MB by default) are refused with a `413 import_too_large`. The metadata parts come first, so a name owned by someone else is refused with a `409 benchmark_name_taken` before the upload is received rather than after. A git source must be an `https://` url: the import runs on a worker with no ssh client, so `ssh://` and `git@` remotes are refused at validation rather than failing inside the job — for a private repository, put a token in the https url.

### Getting your corpus back

The platform keeps the exact package a version was imported from, and its owner can download it:

```ts
const bytes = await catalog.downloadPackage(job.id);            // Buffer
const path = await catalog.downloadPackage(job.id, { to: "." }); // saved file path
const stream = await catalog.downloadPackage(job.id, { stream: true });
```

```bash
npx evolve-evals download <import-id> --to ./restored
```

Reach for `{ to }` on anything sizeable: the default shape buffers the whole package in memory (the same trade `export()` makes), and a corpus can be 512 MB. The id is the import id — what `import()` returned and what `getImport()` polls. You get back the gzipped tarball you uploaded, or, for a git import, the checked-out tree packed at import time. Either way it is the whole corpus directory: `task.toml`, `instruction.md`, `tests/`, `environment/`, and your `solution/`.

**This is the one call that returns task files, and it returns them only to you.** Ownership is a single equality — the benchmark's owner is the caller — with no admin path and no exception for platform-curated benchmarks, which have no owner and so cannot be downloaded by anyone. Somebody else's import answers `import_not_found`, the same answer a made-up id gets, because a `403` that only appears for real ids is a way to discover which ids are real.

The server re-hashes the stored bytes and compares them against the digest recorded at import before it sends anything, and echoes the verified value in `x-package-sha256`. The SDK then re-checks that header against the bytes it actually received and throws `EvolveDigestMismatchError` if they disagree — so the chain is closed at both ends, storage and wire. The to-disk shape hashes while streaming and deletes the file rather than leaving one that looks like your corpus and is not. Only `{ stream: true }` is unverified, because you hold the bytes, not the SDK; read the header and hash as you go.

Three things are worth knowing before you rely on it. Versions imported before packages were retained have none, and it cannot be reconstructed: those answer `package_not_retained`, a different code from `import_not_found` so a client can say which happened. A version whose stored object has since gone answers `410 package_missing` — also terminal, also fixed only by re-importing. And this is the only way to recover `task.toml`: the importer parses it into environment specs and keeps a digest, so it exists nowhere else on the server.

### Deleting one

A benchmark name is a global resource, and a typo used to squat one permanently. `delete()` takes it back:

```ts
await catalog.delete("my-bnech");   // 204, and the archived solutions go with it
```

The rules are worth knowing before you reach for it:

- **You must own it.** A platform-curated benchmark is refused with `benchmark_not_owned`; a name you cannot see reads as a plain not-found, exactly like a name that does not exist, so the route cannot be used to discover what other accounts have.
- **A referenced benchmark is never deleted.** If any job ran against it, you get `409 benchmark_in_use`, and `details.sampleJobIds` names some of the jobs blocking it (with `details.jobCount` for how many there are). There is no cascade and no force: a job's meaning is "this agent scored 0.42 on *these* tasks", and deleting the tasks would leave a number that refers to nothing. Delete the jobs first if you mean it.
- **Versions, tasks, and the private solutions archive go with it.** Mirrored task images do not — they are content-addressed and shared with any other benchmark pinning the same image.

### When upstream moves

A benchmark imported from git records what it was built from, and the platform periodically re-resolves where that ref points now. The answer rides on the benchmark:

```ts
const bench = await catalog.get("my-bench");

if (bench.upstream?.moved) {
    console.log(`${bench.upstream.ref} has moved past ${bench.upstream.currentCommit}`);
    // → import a NEW version when you want it; nothing happens automatically
}
```

```
upstream: {
    ref: "main",                  // what the active version was imported from
    currentCommit: "a1b2c3…",     // what it was built from
    latestCommit: "d4e5f6…",      // where the ref points now (null if the check failed)
    moved: true,                  // branch on this
    behindBy: null,               // see below
    checkedAt: "2026-07-24T…",    // null before the first check
    error: null,                  // why the last check failed
}
```

Four things this deliberately does **not** do:

- **It never imports.** A new version is always an immutable row you create, with `catalog.import()`. Watching produces a fact, never an action.
- **It never modifies an existing version.** A version is what it was built from, permanently.
- **`upstream` is `null`, not "up to date", when there is nothing to watch** — an uploaded corpus, a seeded one, one imported before provenance was recorded, or one imported at an exact commit sha. That last case is the one that surprises people: a commit pin is the *most* reproducible way to import, and a pinned commit cannot move, so there is no question to ask the remote and no badge to show. Import from a branch or tag if you want the watch. Null always means nobody checked.
- **`behindBy` is always `null` today.** Counting commits between two SHAs needs the commit graph, i.e. a real fetch from the remote per benchmark per check. The check is a single reference advertisement (`git ls-remote`) precisely so it can be cheap, and `moved` is what a badge actually needs. The field stays in the shape so a host comparison API could fill it later without a wire change.

A failed check keeps the last known `latestCommit` and sets `error`: a network blip should not quietly erase an update that is genuinely available. Show "could not check", never "up to date".

The same idea covers harnesses from the other direction: a job records the `harnessVersion` it pinned, and `meta().harnesses[].latestVersion` is the newest published one. Compare the two for a "your pin is out of date" badge — one cached lookup for every job, rather than a registry round trip per job read.

The CLI prints one quiet line under `benchmarks` and `benchmarks get` for each benchmark whose ref has moved — naming the benchmark, its active version, and the ref — and nothing at all when nothing moved. It never offers to import for you, because importing builds an immutable version and that is a decision. When you want the new version, it is the ordinary import command with a new version label:

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

`COMPLETED` is the import job's terminal success: the corpus landed as a benchmark version, visible in the catalog (`catalog.get("my-bench@1.0")`) in state `VALIDATING`. Activation is a separate, operator-run step — importing never triggers it. The version stays `VALIDATING` until the gate passes in full and promotes it to `READY`, the one state that accepts jobs; watch the state through `catalog.get()`. `evals.run()` against any other state is rejected with a `409 version_not_ready` naming it.

Be clear-eyed about what that means for you today: there is no SDK method, CLI verb or dashboard button that requests activation. A version you import sits at `VALIDATING` until Evolve runs the gate for it, so ask us to activate it — quote the benchmark name and version — rather than polling and waiting for a state change that nothing on your side can cause. Self-serve activation is coming; until it lands this is the one step in the chapter that is not in your hands. Once `READY`:

```ts
const job = await evals.run({
    benchmark: "my-bench@1.0",
    agents: [
        {
            harness: "codex",
            model: "gpt-5.5",
        },
    ],
    maxTrialSpendUsd: 25,
});
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
- Timeouts are optional: agent defaults to 3600 s, verifier to 600 s, both published as `limits.job.defaultAgentTimeoutSec` and `limits.job.defaultVerifierTimeoutSec`. A declared `timeout_sec` always wins — the corpus is the authority on how long its own task needs, and the fallback never shortens one.
- `solution/` (`solve.sh`, or a `solution.patch` to apply) is what the gate certifies with — without it the version cannot reach `READY`.

Then import and run it — exactly the [Harbor-format flow above](#already-in-harbor-format).

---

## Bring your own harness

The built-in harnesses (`claude`, `codex`, `gemini`, `qwen`, `kimi`, `opencode`, `droid`) are not the boundary. Register your own CLI once, and its name becomes usable in `agents[].harness` exactly like a built-in:

```ts
const harnesses = customHarnesses();

await harnesses.create({
    name: "acme-cli",                                              // the name you will pass as `harness`
    installScript: "curl -fsSL https://acme.dev/install.sh | sh",  // the script itself, not a path
    runCommand: "acme-cli --headless",
    env: { ACME_PROFILE: "bench" },                                // (optional) injected at run time
});

const job = await evals.run({
    benchmark: "deep-swe",
    agents: [
        {
            harness: "acme-cli",
            model: "gpt-5.5",
        },
    ],
    maxTrialSpendUsd: 25,
});
```

A harness that is not a one-line install ships as a directory instead — tarred deterministically on the client and uploaded:

```ts
await harnesses.create({
    name: "acme-cli",
    directory: "./harnesses/acme-cli",   // EITHER directory OR installScript, never both
    runCommand: "acme-cli --headless",
});
```

Read and remove them the same way:

```ts
const registered = await harnesses.list();     // one page of your harnesses
for await (const h of harnesses.list()) { /* … */ }  // or walk them all
const one = await harnesses.get("acme-cli");   // name, source, runCommand, env, timestamps
await harnesses.delete("acme-cli");            // past jobs keep the harness they recorded

// Change one WITHOUT a window where it stops existing:
await harnesses.upsert("acme-cli", {
    runCommand: "acme-cli --headless --v2",
    installScript: "curl -fsSL https://acme.dev/install.sh | sh",
});
```

Both upload lanes — a harness and a benchmark corpus — send `multipart/form-data`: the metadata travels as named parts and the bytes as a `file` part. The SDK builds that for you, and it is why nothing sensitive rides a URL: a run command and a set of environment values in a query string end up in every access log and proxy buffer between you and the server.

```bash
npx evolve-evals custom-harnesses add \
    --name acme-cli \
    --install-script ./install.sh \
    --run "acme-cli --headless" \
    --env ACME_PROFILE=bench
npx evolve-evals custom-harnesses
npx evolve-evals custom-harnesses get acme-cli
npx evolve-evals custom-harnesses remove acme-cli
```

The CLI's `--install-script` names a **file**; its contents are what gets uploaded. `--dir` is the directory lane, and `--env KEY=VALUE` repeats once per variable.

Harnesses are private to their owner. Another account's name reads as `custom_harness_not_found`, never as a permission error — existence is never leaked.

### The run contract

Everything a custom harness can rely on, and nothing else. Your `runCommand` runs headless with `sh -c` at the task's working directory, and:

- **The task instruction arrives twice, so read it whichever way your CLI prefers.** It is written to the command's **stdin**, and it is also on disk at the path in `$EVOLVE_INSTRUCTION_FILE`.
- **The model is reached through a gateway, not a provider.** `$EVOLVE_GATEWAY_BASE_URL` is an OpenAI-compatible base URL that **already ends in `/v1`** — never append it yourself — and `$EVOLVE_GATEWAY_API_KEY` is the credential for it. The same two values are also exported as `$OPENAI_BASE_URL` and `$OPENAI_API_KEY`, so a CLI that **reads its endpoint from the environment** works unchanged. A CLI that routes through a **config file** does not — see below.
- **`$EVOLVE_MODEL` names the model being evaluated** — the `model` of the agent this trial belongs to.
- **Your declared `env` is injected at run time only**, and it may **not** override those contract keys. An attempt to is rejected at registration with `custom_harness_invalid_env`, not silently dropped at run time. The six contract keys are `EVOLVE_GATEWAY_BASE_URL`, `EVOLVE_GATEWAY_API_KEY`, `EVOLVE_MODEL`, `EVOLVE_INSTRUCTION_FILE`, `OPENAI_BASE_URL` and `OPENAI_API_KEY`.

#### If your CLI routes through a config file

Env-only routing covers CLIs that read `OPENAI_BASE_URL`. Plenty do not: they want a config file, and they read it from a path in `$HOME`. Three of our own seven built-ins are in that group, so this is the common case and not an edge one.

Write that file **inside your `runCommand`**, from the contract values. It cannot be written at install time: the install ran in a different sandbox entirely, and by the time your harness runs the box has no network to fetch anything with. `codex` is the worked example — this is what the platform itself does for the built-in:

```bash
# runCommand for a codex-shaped CLI
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
- A custom harness is **versioned by its registered content** — the install source, the `runCommand` and the declared `env`, together — so `harnessVersion` on an agent using it is rejected. Change any of the three and you get a new recorded version and a new bundle digest.
- **`upsert()` is how you change one.** `delete()` then `create()` leaves a window where the harness does not exist, and anything naming it in that window — a scripted job, a colleague's run — fails with "no such harness" for a change that was only ever meant to be an edit. `upsert()` is one call: the name holds the old registration or the new one, never nothing. It creates when the name is free (`201`, with `Location`) and replaces when it is not (`200`), and replacing consumes no new registration slot, so you can still fix a broken run command at the ceiling. It is a full REPLACEMENT, not a patch: every field comes from the call, so an omitted `env` becomes empty and the source switches wholesale.
- **You may register up to 25 harnesses.** Past that, registration is refused with `custom_harness_limit_reached`; delete one to make room. Each registration is a full CLI the platform builds and caches for you.

**What keeps a trial inside its budget — and when it does not.** The spend cap is enforced on the gateway key, so model traffic through `$EVOLVE_GATEWAY_BASE_URL` is metered and capped. What confines traffic to that route is the **task's network policy**, not the harness. Under `no-network` the box reaches the gateway and nothing else, and the cap is a hard guarantee. Under `allowlist` or `public` a harness *can* reach a provider directly with a key of its own, and that traffic is neither metered nor capped.

Read that second sentence with [Network modes](#network-modes) in hand, because `public` is what a task gets when it declares no policy at all. If you care about the cap being airtight, run against tasks that declare `network_mode = "no-network"` — do not assume it. Registration refuses credential-shaped `env` keys, but that is a guardrail against the obvious mistake, not a boundary.

What you give up versus a built-in:

- **No live trace events.** There is no output parser for an unknown CLI, so `trialTrace()` stays empty for these trials.
- **No live spend reading.** `liveSpentUsd` stays `null` and no `trial.spend` event fires; the trial goes straight to a settled `spentUsd`.
- **No `reasoningEffort`.** An effort set on the agent is recorded but never reaches your command — the run contract's six keys are the whole environment. Put the flag in the `runCommand`.

Everything else is identical: the patch is collected, the verifier scores it, and artifacts, timings, settled spend and status are recorded exactly as for a built-in harness.

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
| `RUNNING` | Agent phase in progress |
| `SCORING` | Agent finished; verifier running |
| `SCORED` | Valid reward recorded in `reward` |
| `SCORING_ERROR` | Verifier crashed or returned an out-of-domain reward — read `failurePhase`, then `failureDetail` |
| `INFRASTRUCTURE_ERROR` | Trial lost before a result was recorded — read `failurePhase`, then `rerunFailed()` |
| `INDETERMINATE` | The verifier produced no reward file at all — read `failurePhase`, then `failureDetail` |
| `CANCELLED` | Cancelled before settling |

`SCORING_ERROR` and `INDETERMINATE` are the two statuses a task author has to act on, so both say what went wrong. `failurePhase` carries the machine-readable cause and `failureDetail` carries a sentence plus the last few kilobytes of the verifier's own stdout and stderr — the tail, because a grader prints its progress first and its traceback last. The box those bytes came from is destroyed seconds later, so this is the only record of them.

| `failurePhase` | What happened |
|--------|---------|
| `verifier_timeout` | The verifier command hit its wall-clock budget and was killed. Raise `verifier_timeout_sec` on the task, or make the grader cheaper. |
| `verifier_crash` | The verifier exited non-zero, or never reported an exit status at all. The excerpt usually names the missing module or failed assertion. |
| `reward_out_of_range` | The verifier finished and wrote a number, but not one in `[0, 1]` — `-1` is the conventional crash sentinel, and a reward above 1 usually means a rubric was summed rather than normalized. |
| `reward_unparseable` | The verifier claimed success and wrote something that is not a score: malformed JSON, no `reward` key, or an empty `reward.txt`. |
| `reward_missing` | No reward file at all, which is `INDETERMINATE` rather than `SCORING_ERROR`. On its own it means a verifier that exited cleanly without writing a verdict; paired with `verifier_crash` or `verifier_timeout` it is the hard-crash case, and the excerpt is the only evidence of it. |

The verifier's exit takes precedence over the reward's shape, because a killed grader leaves a truncated `reward.json` and reporting that as `reward_unparseable` would send you to debug your JSON instead of your timeout. Nothing is lost by the ordering — `failureDetail` always states both.

Regrade results use the same five values in the same field, and the `failureDetail` on a list row is truncated to 2000 characters; fetch the trial itself for the whole excerpt.

**Import** (`BenchmarkImport.status`) — the SAME four words a job uses, because an import is a job:

| Status | Meaning |
|--------|---------|
| `QUEUED` | Accepted; the corpus row exists and nothing has started |
| `RUNNING` | Cloning or extracting, then parsing and building the environment |
| `COMPLETED` | Terminal — the corpus landed as a benchmark version |
| `FAILED` | Terminal — read `failure` |

It used to spell these `IMPORTING → IMPORTED | FAILED`. Nothing published depended on that, and a third status vocabulary is exactly what forces a status chip to carry a translation table forever.

A terminal import stays readable. A successful import used to start answering `404` the moment its version was superseded, telling a watcher holding a week-old id that the import never happened — it `COMPLETED`, and the catalog moving on afterwards does not unmake that.

**Regrade job** (`RegradeJob.status`) — shorter than a job's, because a regrade cannot be cancelled:

| Status | Meaning |
|--------|---------|
| `QUEUED` | Accepted; eligible source trials selected, nothing re-scored yet |
| `RUNNING` | Verifiers re-running |
| `COMPLETED` | Terminal — every selected trial has settled, whatever it settled as |

**Regrade result** (`RegradeResult.status`) — the SAME reward law as a trial, minus the states a regrade cannot reach (there is no agent phase, so no `SCORING`, and nothing to cancel):

| Status | Meaning |
|--------|---------|
| `QUEUED` | Waiting for a verifier slot |
| `RUNNING` | Verifier re-running against the source trial's recorded inputs |
| `SCORED` | Valid reward recorded in `reward` (0 counts) |
| `SCORING_ERROR` | Verifier crashed or returned an out-of-domain reward — read `failurePhase`, then `failureDetail` |
| `INFRASTRUCTURE_ERROR` | Verifier box lost before a durable verdict |
| `INDETERMINATE` | The verifier wrote no reward file |

A `COMPLETED` regrade job is not a claim that every result `SCORED` — read `byStatus` on `regrade.results` for that, exactly as with a job's trials.

**Benchmark version** (`BenchmarkVersion.state`) — the catalog's lifecycle, distinct from the import job's statuses above:

```
DRAFT → IMPORTING → BUILDING → VALIDATING → READY
```

with `FAILED` and `ARCHIVED` as off-ramps: a failed parse or environment build lands `FAILED` before `VALIDATING` is ever reached, and `ARCHIVED` shelves a version that has been moved past. An import lands a version at `VALIDATING`; the activation gate (gold + no-op, above) then promotes it — `READY` is the only state that accepts jobs.

---

## Types

These are the shapes the surface actually returns. Most of the names below are exported from the package root and can be imported and annotated with — `Job`, `Trial`, `TrialDetail`, `JobEvent`, `Benchmark`, `Task`, `BenchmarkImport`, `BenchmarkImportInput`, `BenchmarkImportSource`, `CustomHarness`, `CustomHarnessInput`, `CustomHarnessUpsertInput`, `RegradeJob`, `RegradeResult`, `UpstreamStatus`, `CapabilityDocument`, `Awaitable`, and the concrete page aliases `JobPage` / `TrialPage` / `TrialTracePage` / `BenchmarkImportPage`.

Three shapes below are written out for reading rather than importing, because the root does not export them: the generic `Page<T>` (import the concrete alias for the collection you are paging), the per-event `data` payloads inside `JobEvent` (you get them by narrowing on `type`, which is the point of the union), and `CustomHarnessSourceInput`, the bare either-or half of a harness registration — import `CustomHarnessInput` or `CustomHarnessUpsertInput`, which include it.

```ts
type EvalSandboxProvider = "e2b" | "daytona" | "modal";

interface JobAgent {
    harness: string;             // a built-in ("claude" | "codex" | "gemini" | "qwen" |
                                 // "kimi" | "opencode" | "droid") or a registered custom harness
    model: string;               // a model of that harness's family
    harnessVersion?: string | null;  // pin a harness version; omit/null = resolve latest.
                                     // Must be EXACT (else invalid_input); unpublished ->
                                     // harness_version_not_found; a pin on a custom
                                     // harness -> invalid_input (content-versioned)
    reasoningEffort?: string | null; // "off" | "minimal" | "low" | "medium" | "high" |
                                     // "xhigh" | "max" | "thinking". Omit/null = the
                                     // platform default ("medium"); PART OF THE AGENT'S
                                     // IDENTITY, so two efforts are two systems. An effort
                                     // the harness cannot apply -> invalid_input
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

interface Page<T> {                      // every collection, top level or nested
    items: T[];
    nextCursor: string | null;           // pass back as { cursor }; null = no next page
    hasMore: boolean;
}

// Every list() and watch() returns a DUAL-USE handle: await it for one page (or
// the final job), or `for await` it to iterate. The handle is a full promise —
// `.then()`, `.catch()`, and `.finally()` all work — and however many of them
// you use, it issues exactly one request underneath.
//
//   const page = await catalog.list();
//   const safe = await catalog.list().catch(() => null);
//   await catalog.list().finally(() => spinner.stop());
interface Awaitable<T> extends PromiseLike<T> {
    catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R>;
    finally(onfinally?: (() => void) | null): Promise<T>;
}

interface UpstreamStatus {               // where the git source points NOW
    ref: string;                         // what the active version was imported from
    currentCommit: string;               // what it was built from
    latestCommit: string | null;         // where the ref points now; null = last check failed
    moved: boolean;                      // branch on this
    behindBy: number | null;             // always null — see "When upstream moves"
    checkedAt: string | null;            // null before the first check
    error: string | null;                // why the last check failed
}

interface Benchmark {                    // catalog.list() / catalog.get(ref)
    name: string;
    title: string | null;
    description: string | null;
    activeVersion: BenchmarkVersion | null;
    upstream: UpstreamStatus | null;     // null = nothing to watch, NEVER "up to date"
    versions?: BenchmarkVersion[];       // get() only, newest first
    selectedVersion?: BenchmarkVersion | null;  // get() only — the tasks' provenance
    tasks?: Page<Task>;                  // get() only; page with { limit, cursor }
    createdAt?: string;                  // get() only
    updatedAt?: string;                  // get() only
    // ActiveBenchmark (getActive) is the same shape with version + tasks non-optional
}

interface Job {                              // ONE shape from every call, nothing optional
    id: string;
    status: JobStatus;
    benchmark: string;                       // "name@version"
    agents: JobAgent[];
    runsPerTask: number;
    concurrency: number;
    maxTrialSpendUsd: number;                // the per-trial cap that applied: yours, or the default
    worstCaseSpendUsd: number;               // trials x the cap — the most this job can cost
    sandboxProvider: EvalSandboxProvider;
    spentUsd: number;                        // what the trials have spent so far
    counts: { agents: number; tasks: number };   // entity cardinality only
    trials: { total: number; byStatus: Record<TrialStatus, number> };  // every status, zeros included
    meanReward: number | null;               // mean over SCORED trials, null when none
    failure: { code: string; message: string } | null;  // why it FAILED — never the key `error`
    sourceJobId: string | null;              // the job a rerun came from
    idempotentReplay: boolean;               // true when a key replayed an existing job
    createdAt: string;
    updatedAt: string;
}

interface Trial {
    id: string;
    taskKey: string;
    agent: JobAgent;
    runNumber: number;                       // 1-based
    status: TrialStatus;
    reward: number | null;                   // null until scored
    metrics: Record<string, number> | null;  // named sub-scores from reward.json
    failurePhase: string | null;
    failureDetail: string | null;            // truncated to 2000 chars in list responses
    phaseTimingsMs: Record<string, number> | null;  // { agentMs, verifyMs }
    modelUsage: ModelUsage | null;           // per-harness detail; read spend from spentUsd
    sandboxProvider: EvalSandboxProvider | null;  // where the trial executed; null until it has
    verifierMode: "separate" | "shared" | null;   // where the verifier ran
    sandboxId: string | null;                // agent box id; null until the box exists
    verifierSandboxId: string | null;        // verifier box id; null in shared mode or before verify
    spentUsd: number | null;                 // null = never ran (NOT zero, which is a measurement)
    spendSource: "measured" | "assumed_cap" | null;
    liveSpentUsd: number | null;             // mid-run LOWER BOUND; null = no reading yet
    liveSpendAt: string | null;              // when that reading was taken — show its age
    resolvedHarnessVersion: string | null;   // harness version actually used
    sessionRef: string | null;               // agent session/trace reference
    createdAt: string;
    updatedAt: string;
}

interface TrialDetail extends Trial {        // evals.trial(id, trialId)
    jobId: string;                           // failureDetail is untruncated here
}

interface ModelUsage {                       // open-ended per-harness detail
    maxTrialSpendUsd?: number;               // the cap THIS trial's key carried (history)
    [key: string]: unknown;                  // bundle identity, token counts, and on
                                             // older trials a historical costUsd —
                                             // spend is trial.spentUsd, not this
}

// A discriminated union: switch on `type` and `data` narrows, no cast needed.
type JobEvent =
    | { seq: number; type: "job.created";    data: JobCreatedData }
    | { seq: number; type: "job.running";    data: { jobId: string } }
    | { seq: number; type: "job.cancelling"; data: { jobId: string; cancelledTrials: number; activeTrials: number } }
    | { seq: number; type: "job.cancelled";  data: { jobId: string; cancelledTrials: number } }
    | { seq: number; type: "job.completed";  data: { jobId: string; undispatched: number } }
    | { seq: number; type: "job.failed";     data: { jobId: string } }   // reserved; nothing emits it yet
    | { seq: number; type: "trial.running";  data: { trialId: string; taskKey: string } }
    | { seq: number; type: "trial.scoring";  data: { trialId: string; capturedBytes: number } }
    | { seq: number; type: "trial.spend";    data: { trialId: string; taskKey: string; liveSpentUsd: number } }
    | { seq: number; type: "trial.settled";  data: TrialSettledData };

interface JobCreatedData {                   // the job's resolved inputs, echoed
    benchmark: string;                       // resolved "name@version", never your bare name
    taskCount: number;
    agents: JobAgent[];
    runsPerTask: number;
    concurrency: number;
    maxTrialSpendUsd: number;
    sandboxProvider: EvalSandboxProvider;
    trialCount: number;
}

interface TrialSettledData {
    trialId: string;
    taskKey: string;                         // on EVERY trial.settled, no exceptions
    status: TrialStatus;
    reward?: number | null;                  // scored path only; zero is a reward
    failurePhase?: string;                   // failures only
    attemptId?: string;                      // only when the REAPER settled it
    attemptPhase?: string | null;
}

interface TrialTraceEvent {
    seq: number;                             // resume position — pass as { cursor }
    type: string;
    data: Record<string, unknown>;
}

type RegradeStatus =                         // mirrors the trial reward law
    | "QUEUED" | "RUNNING"                   // in flight
    | "SCORED"                               // valid reward recorded (0 counts)
    | "SCORING_ERROR"                        // verifier crashed / out-of-domain reward
    | "INFRASTRUCTURE_ERROR"                 // verifier box lost before a durable verdict
    | "INDETERMINATE";                       // no reward file

interface RegradeOptions {                   // jobs().regrade(id, options)
    status?: TrialStatus[];                  // only source trials in these statuses
    taskKey?: string;                        // only source trials of this task
}

interface RegradeResult {
    id: string;
    sourceTrialId: string;                   // the source trial this regrade re-scored
    taskKey: string;
    status: RegradeStatus;
    reward: number | null;                   // the regrade's reward; null until scored
    metrics: Record<string, number> | null;
    sourceReward: number | null;             // source-trial reward at regrade time (immutable snapshot)
    sourceStatus: string;                    // source-trial status at regrade time (immutable snapshot)
    rewardDelta: number | null;              // reward − sourceReward when both are numbers, else null
    verifierMode: "separate" | "shared";     // always "separate" — regrade only re-runs separate verifiers
    verifierDigest: string | null;           // the verifier version that ran; null until it runs
    verifierSandboxId: string | null;        // provider box id of the verifier sandbox (provenance)
    failurePhase: string | null;
    failureDetail: string | null;
    phaseTimingsMs: Record<string, number> | null;
    createdAt: string;
    settledAt: string | null;                // null while QUEUED/RUNNING
}

interface RegradeJob {                       // regrade() / regradeTrial() / getRegrade() / listRegrades()
    id: string;
    sourceJobId: string;                     // the job the source trials belong to
    status: "QUEUED" | "RUNNING" | "COMPLETED";  // derived from the WHOLE result set
    sandboxProvider: EvalSandboxProvider;    // where the verifier boxes run
    filter: { status?: string[]; taskKey?: string } | null;  // per-job selection, or null
    // total/byStatus cover the whole job; items/nextCursor/hasMore are one page
    results: Page<RegradeResult> & {
        total: number;
        byStatus: Record<RegradeStatus, number>;
    };
    createdAt: string;
    updatedAt: string;
}

// A union, so `{}`, both branches at once, and a git source without a ref are
// all COMPILE errors rather than a 400 you discover after shipping.
type BenchmarkImportSource =              // benchmarks().import() — EITHER git OR directory
    | { gitUrl: string; ref: string; directory?: never }   // ref REQUIRED: unpinned is not reproducible
    | { directory: string; gitUrl?: never; ref?: never };  // a local Harbor-layout corpus, tarred + uploaded

interface BenchmarkImport {
    id: string;
    status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";   // the job vocabulary
    benchmarkName: string;
    version: string;
    failure: BenchmarkImportFailure | null;  // never `error` on a 200 body
    taskCount?: number;                      // tasks parsed, once counted
    createdAt?: string;
    updatedAt?: string;
}

interface BenchmarkImportFailure {           // BenchmarkImport.failure
    code: string;                            // "import_failed" when none was recorded
    message: string;                         // e.g. "2/113 task(s) failed to parse"
    failures?: { taskKey: string; error: string }[];  // per-task, when the corpus was reachable
}

interface CustomHarness {                    // harnesses.list() / get() / create()
    name: string;                            // the value you pass as agents[].harness
    source: "install_script" | "tarball";    // how the executables were produced
    runCommand: string;                      // run headless with `sh -c` at the task directory
    env: Record<string, string>;             // injected at RUN time; cannot override contract keys
    createdAt: string;
    updatedAt: string;
}

// Same union treatment: exactly one source, enforced by the compiler.
type CustomHarnessSourceInput =
    | { installScript: string; directory?: never }   // the script itself, not a path
    | { directory: string; installScript?: never };  // a local directory, tarred + uploaded

type CustomHarnessInput = CustomHarnessSourceInput & {   // harnesses.create()
    name: string;
    runCommand: string;
    env?: Record<string, string>;
};
```

### Error codes

The shape an error arrives in is described once, under [Errors](#errors); this is the vocabulary that fills its `code`. The same list is published as `errorCodes` in the [capability document](#what-the-platform-supports), so a client can check its own switch against the server's.

Codes you will actually branch on: `benchmark_not_found` (also what another account's private benchmark reads as), `benchmark_version_not_found`, `benchmark_name_taken` (409 — the import name belongs to someone else), `import_too_large` (413), `no_active_version`, `version_not_ready`, `unknown_task_keys`, `provider_unsupported`, `job_not_found`, `job_not_terminal`, `no_failed_runs`, `trial_not_found`, `harness_version_not_found`, `insufficient_credits` (402 — the account is out of credits; add some and retry), `job_too_large` (400 — the trial matrix exceeds `limits.job.maxTrials`; the message states the count it would have created), `rate_limited` (retry after the `Retry-After` header), `invalid_api_key`, and `invalid_input` (which is also what the per-agent and per-`runsPerTask` ceilings refuse with).

[Regrades](#regrade) add three: `regrade_source_ineligible` (409 — the source trial recorded no verifier inputs; the message names why), `no_regradable_runs` (409 — a whole-job regrade found nothing eligible), and `regrade_not_found`.

[Custom harnesses](#bring-your-own-harness) add their own: `custom_harness_not_found` (also what another owner's name reads as), `custom_harness_name_taken`, `custom_harness_name_reserved` (the name collides with a built-in harness), `custom_harness_source_required` (neither an install script nor a tarball), `custom_harness_source_conflict` (both), `custom_harness_invalid_env` (declared env tries to override a run-contract key), `custom_harness_invalid_name`, `custom_harness_too_large`, and `custom_harness_limit_reached` (the per-account registration ceiling).

Three more come from the shapes above: `idempotency_key_reused` (409 — the key already stands for a different request), `invalid_multipart` (400 — an upload that is not `multipart/form-data`, or is malformed), and `invalid_cursor` (400 — a malformed `cursor` on a paged read).
