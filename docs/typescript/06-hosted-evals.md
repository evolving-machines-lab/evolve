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

`READY` is the one benchmark-version state that accepts jobs — see [Statuses](#statuses). Tasks expose public fields only — `taskKey`, `agentTimeoutSec`, `verifierTimeoutSec`, and `providers`, the per-provider capability verdict ([Where it runs](#where-it-runs)). Instructions, environments, and tests never leave the server.

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
    concurrency: 4,                     // (optional) parallel trials, default 1
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

A job expands to `tasks × agents × runsPerTask` trials, each in its own sandbox. `sandboxProvider` (optional, default `"e2b"`) picks where those sandboxes run — see [Where it runs](#where-it-runs). Valid harness + model pairs are the same as everywhere in the SDK — see [Getting Started → Harness and Model Pairing](./01-getting-started.md#harness-and-model-pairing). `harness` also accepts a harness you registered yourself — see [Bring your own harness](#bring-your-own-harness).

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
    if (event.type === "trial.settled") updateProgress(event.data);
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
console.log(detail.failure);                        // why it FAILED, or null

// Your jobs, newest first — await one page, or iterate them all
const jobPage = await evals.list({ limit: 50 });    // jobPage.nextCursor continues
for await (const item of evals.list()) {
    console.log(item.id, item.status, item.benchmark, item.meanReward);
}
```

A failed job says why on `failure`, as `{ code, message }` — the same grammar an API error uses, under a different key so that `if (body.error) throw` stays correct on a healthy read. It rides on list rows too, so a dashboard shows the reason without a detail call per row.

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
console.log(trial.modelUsage?.spentUsd, trial.modelUsage?.spendSource);
console.log(trial.sandboxProvider, trial.verifierMode); // where the trial and its verifier executed
console.log(trial.resolvedHarnessVersion);             // harness version actually used
console.log(trial.failurePhase, trial.failureDetail);  // untruncated in this response
```

> **Reading spend:** `spendSource: "measured"` is platform-measured model spend; `"assumed_cap"` means the trial's spend could not be measured yet, so the per-trial cap is reported conservatively (`modelUsage.maxTrialSpendUsd`). Fresh trials can briefly show the cap while metering catches up.

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

// Read it back: QUEUED → RUNNING → COMPLETED, one result per source trial
const done = await evals.regradeJob(bulk.id, { limit: 100 });
for (const result of done.results.items) {
    console.log(result.taskKey, result.sourceReward, "→", result.reward,
        result.rewardDelta);  // reward − sourceReward, the per-trial delta
}
```

All three return a `RegradeJob`. A per-trial regrade holds one result; a per-job regrade holds one per selected source trial. `results` is one object named for the collection: `total` and `byStatus` cover the whole job, `items`/`nextCursor`/`hasMore` are the page you asked for — a regrade of a 10,000-trial job is not one response. Poll `regradeJob()` until `status` is `COMPLETED`; `results.byStatus` is the running histogram, and it is derived from the whole result set rather than the page in hand.

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
- `--runs <n>` — runs per task × agent (default 1)
- `--concurrency <n>` — parallel trials (default 1)
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
- Exit codes: `0` success (with `--watch`: `COMPLETED` / import `IMPORTED`), `1` runtime failure (with `--watch`: `FAILED` or `CANCELLED`), `2` usage error.

Benchmark imports and harness registration have their own subcommands — `npx evolve-evals import …` and `npx evolve-evals custom-harnesses add …` — shown in [Bring your own benchmark](#bring-your-own-benchmark) and [Bring your own harness](#bring-your-own-harness).

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

Creating a job whose selected tasks include one refused on the chosen provider is rejected with a `400 provider_unsupported` naming the tasks and each task's reason — never accepted and left to fail mid-run.

What the verdicts encode today:

- **Multi-container tasks run on `e2b` and `daytona`.** Modal cannot run them today — the task's `providers.modal` verdict names the reason, and the task stays runnable on the other two providers.
- **Multi-container + `no-network` is declined on every provider** for now. Run those tasks with an `allowlist` or `public` network policy.
- **Daytona serves IP-based allowlists only.** Its network filter takes IPv4 addresses and CIDRs, capped at 10 entries — a cap that also has to fit the address the agent uses to reach its model, so a task's own list gets slightly fewer. A task whose allowlist names a hostname is refused on Daytona with the reason — run it on e2b or Modal, which serve hostname allowlists.
- **Modal caps every sandbox at 24 hours.** A task whose timeout exceeds the cap fails fast when its sandbox is created (read the trial's `failureDetail`) — never truncated mid-run.
- **Sizing above a provider's ceiling** refuses on that provider only — see [Compute sizing](#compute-sizing).

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

// Block until IMPORTED or FAILED
const done = await catalog.watchImport(
    importJob.id,
    {
        onStatus: (benchmarkImport) => console.log(benchmarkImport.status, benchmarkImport.taskCount),
        pollIntervalMs: 2_000,        // (optional) default 2s
    },
);

if (done.status === "FAILED") {
    console.log(done.error?.message);              // e.g. "2/113 task(s) failed to parse"
    for (const failure of done.error?.failures ?? []) {
        console.log(failure.taskKey, failure.error);
    }
}
```

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

Every lane resolves to the same thing — a Harbor-layout directory — and is held to the same rules. The corpus root is a directory whose `tasks/` subdirectory holds one directory per task, or the tasks directory itself. Provenance is recorded per lane: the resolved commit for a git import, the sha256 of the exact uploaded bytes for a directory. On the wire an import is `multipart/form-data`: `benchmarkName` and `version` as named parts, and either `gitUrl` + `ref` or the gzipped corpus as a `file` part — the SDK produces it for you — and uploads past the compressed-size cap (512 MB by default) are refused with a `413 import_too_large`. The metadata parts come first, so a name owned by someone else is refused with a `409 benchmark_name_taken` before the upload is received rather than after.

What happens next:

- **All-or-nothing parse.** Every task is parsed before anything lands; one bad task fails the whole import, with each failure named in `error.failures`. No partial corpus ever exists.
- **Strict by design.** Every `task.toml` field is either honored or the import is refused with the field and reason named — a task never silently runs on weaker semantics than it declares. Notably not yet supported: multi-step tasks (`[[steps]]`) and GPU tasks.
- **Environments are prepared at import.** Dockerfile-defined environments are built once; multi-container service images are resolved and pinned so runs are reproducible.
- **The activation gate certifies every task** before the version can activate:
  - **gold** — the task's reference solution (`solution/`) is pushed through the real agent-side + verifier path and must score exactly `1.0`. Proof the task is solvable as written.
  - **no-op** — an empty submission goes straight to the verifier and must *not* score `1.0`. A task a do-nothing agent passes measures nothing.

`IMPORTED` is the import job's terminal success: the corpus landed as a benchmark version, visible in the catalog (`catalog.get("my-bench@1.0")`) in state `VALIDATING`. Activation is a separate, operator-run step — importing never triggers it. The version stays `VALIDATING` until the gate passes in full and promotes it to `READY`, the one state that accepts jobs; watch the state through `catalog.get()`. `evals.run()` against any other state is rejected with a `409 version_not_ready` naming it. Once `READY`:

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
- Timeouts are optional: agent defaults to 1800 s, verifier to 600 s.
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
- A custom harness is **versioned by its registered content** — the install source, the `runCommand` and the declared `env`, together — so `harnessVersion` on an agent using it is rejected. Change any of the three and you get a new recorded version and a new bundle digest; re-register (delete, then create) to change what runs.
- **You may register up to 25 harnesses.** Past that, registration is refused with `custom_harness_limit_reached`; delete one to make room. Each registration is a full CLI the platform builds and caches for you.

**What keeps a trial inside its budget.** The spend cap is enforced on the gateway key, so model traffic that goes through `$EVOLVE_GATEWAY_BASE_URL` is metered and capped. What confines traffic to that route is the **task's network policy**, not the harness: under `no-network` — the default — the box can reach the gateway and nothing else, and the cap is a hard guarantee. On a task declaring `allowlist` or `public`, a harness *can* reach a provider directly, and that traffic is neither metered nor capped. Registration refuses credential-shaped `env` keys, but that is a guardrail against the obvious mistake, not a boundary.

What you give up versus a built-in:

- **No live trace events.** There is no output parser for an unknown CLI, so `trialTrace()` stays empty for these trials. Everything else is identical: the patch is collected, the verifier scores it, and artifacts, timings, spend and status are recorded exactly as for a built-in harness.

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
| `FAILED` | Terminal — the job itself failed; read `error` |

**Trial** (`Trial.status`) — a valid reward, including 0, is `SCORED`; a failure is never reported as a fabricated zero:

| Status | Meaning |
|--------|---------|
| `QUEUED` | Waiting for a sandbox slot |
| `RUNNING` | Agent phase in progress |
| `SCORING` | Agent finished; verifier running |
| `SCORED` | Valid reward recorded in `reward` |
| `SCORING_ERROR` | Verifier crashed or returned an out-of-domain reward — read `failureDetail` |
| `INFRASTRUCTURE_ERROR` | Trial lost before a result was recorded — read `failurePhase`, then `rerunFailed()` |
| `INDETERMINATE` | The platform cannot tell whether the trial completed |
| `CANCELLED` | Cancelled before settling |

**Benchmark version** (`BenchmarkVersion.state`) — the catalog's lifecycle, distinct from the import job's `IMPORTING → IMPORTED | FAILED`:

```
DRAFT → IMPORTING → BUILDING → VALIDATING → READY
```

with `FAILED` and `ARCHIVED` as off-ramps: a failed parse or environment build lands `FAILED` before `VALIDATING` is ever reached, and `ARCHIVED` shelves a version that has been moved past. An import lands a version at `VALIDATING`; the activation gate (gold + no-op, above) then promotes it — `READY` is the only state that accepts jobs.

---

## Types

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

interface Benchmark {                    // catalog.list() / catalog.get(ref)
    name: string;
    title: string | null;
    description: string | null;
    activeVersion: BenchmarkVersion | null;
    versions?: BenchmarkVersion[];       // get() only, newest first
    selectedVersion?: BenchmarkVersion | null;  // get() only — the tasks' provenance
    tasks?: Page<Task>;                  // get() only; page with { limit, cursor }
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
    modelUsage: ModelUsage | null;
    sandboxProvider: EvalSandboxProvider | null;  // where the trial executed; null until it has
    verifierMode: "separate" | "shared" | null;   // where the verifier ran
    resolvedHarnessVersion: string | null;   // harness version actually used
    sessionRef: string | null;               // agent session/trace reference
    createdAt: string;
    updatedAt: string;
}

interface TrialDetail extends Trial {        // evals.trial(id, trialId)
    jobId: string;                           // failureDetail is untruncated here
}

interface ModelUsage {                       // one money vocabulary: caps are
    spentUsd?: number;                       // the cap is maxTrialSpendUsd, actuals are spentUsd
    spendSource?: "measured" | "assumed_cap";
    maxTrialSpendUsd?: number;               // the per-trial cap that applied to this trial
    [key: string]: unknown;                  // open map: harness-specific keys may appear
}

interface JobEvent {
    seq: number;                             // monotonic; the watch resume position
    type: string;                            // "trial.settled", "job.completed", ...
    data: Record<string, unknown>;
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

interface RegradeJob {                       // regrade() / regradeTrial() / regradeJob()
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

interface BenchmarkImportSource {            // benchmarks().import() — EITHER git OR directory
    gitUrl?: string;                         // a git repository URL — pair with ref
    ref?: string;                            // a pinned branch, tag, or commit — pair with gitUrl
    directory?: string;                      // a local Harbor-layout corpus, tarred + uploaded
}

interface BenchmarkImport {
    id: string;
    status: "IMPORTING" | "IMPORTED" | "FAILED";
    benchmarkName: string;
    version: string;
    taskCount?: number;                      // tasks parsed, once counted
    error?: { message: string; failures?: { taskKey: string; error: string }[] } | null;
}

interface CustomHarness {                    // harnesses.list() / get() / create()
    name: string;                            // the value you pass as agents[].harness
    source: "install_script" | "tarball";    // how the executables were produced
    runCommand: string;                      // run headless with `sh -c` at the task directory
    env: Record<string, string>;             // injected at RUN time; cannot override contract keys
    createdAt: string;
    updatedAt: string;
}

interface CustomHarnessInput {               // harnesses.create()
    name: string;
    installScript?: string;                  // the script itself — EITHER this
    directory?: string;                      // OR a local directory (tarred + uploaded)
    runCommand: string;
    env?: Record<string, string>;
}
```

### Errors

Every API failure throws `EvolveApiError` — the server's own sentence as the message, plus a stable machine-readable code to branch on:

```ts
import { EvolveApiError } from "@evolvingmachines/sdk";

try {
    await evals.run(input);
} catch (error) {
    if (error instanceof EvolveApiError) {
        console.log(error.status);   // e.g. 409
        console.log(error.code);     // e.g. "version_not_ready", "provider_unsupported", "rate_limited"
        console.log(error.message);  // "Benchmark version deep-swe@1.2 is in state VALIDATING; ..."
    }
}
```

Codes you will actually branch on: `benchmark_not_found` (also what another account's private benchmark reads as), `benchmark_version_not_found`, `benchmark_name_taken` (409 — the import name belongs to someone else), `import_too_large` (413), `no_active_version`, `version_not_ready`, `unknown_task_keys`, `provider_unsupported`, `job_not_found`, `job_not_terminal`, `no_failed_runs`, `trial_not_found`, `harness_version_not_found`, `insufficient_credits` (402 — the account is out of credits; add some and retry), `rate_limited` (retry after the `Retry-After` header), `invalid_api_key`, and `invalid_input`.

[Regrades](#regrade) add three: `regrade_source_ineligible` (409 — the source trial recorded no verifier inputs; the message names why), `no_regradable_runs` (409 — a whole-job regrade found nothing eligible), and `regrade_not_found`.

[Custom harnesses](#bring-your-own-harness) add their own: `custom_harness_not_found` (also what another owner's name reads as), `custom_harness_name_taken`, `custom_harness_name_reserved` (the name collides with a built-in harness), `custom_harness_source_required` (neither an install script nor a tarball), `custom_harness_source_conflict` (both), `custom_harness_invalid_env` (declared env tries to override a run-contract key), `custom_harness_invalid_name`, `custom_harness_too_large`, and `custom_harness_limit_reached` (the per-account registration ceiling).

Three more come from the shapes above: `idempotency_key_reused` (409 — the key already stands for a different request), `invalid_multipart` (400 — an upload that is not `multipart/form-data`, or is malformed), and `invalid_cursor` (400 — a malformed `cursor` on a paged read).
