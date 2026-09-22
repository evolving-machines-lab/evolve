---
title: "Jobs"
description: "Submit evaluations, follow progress, and work with results."
---

**Note:** For every method’s inputs, return values, and language differences, see the [jobs method reference](/sdk-reference/methods/jobs).

A job runs selected tasks against one or more agent/model combinations. Each combination is an **arm**. Each attempt is a **trial**.

```text
  Selected tasks
× Agent/model arms
× Attempts
= Trials
```

## Start a job

```ts TypeScript
import { jobs } from "@evolvingmachines/evolve";

const client = jobs();
const job = await client.start({
  datasets: [{
    name: "harbor-examples",
    version: "1.0",
    task_names: ["hello-world"],
  }],
  agents: [{ name: "codex", model_name: "gpt-5.6-luna" }],
  max_trial_spend_usd: 0.50,
  retry: { max_retries: 0 },
});
```

```python Python
from evolve import jobs

client = jobs()
job = await client.start(
    datasets=[{
        "name": "harbor-examples",
        "version": "1.0",
        "task_names": ["hello-world"],
    }],
    agents=[{"name": "codex", "model_name": "gpt-5.6-luna"}],
    max_trial_spend_usd=0.50,
    retry={"max_retries": 0},
)
```

`start` returns the accepted `Job`. Read `job.id` to address it later.

### Required inputs

| Input | Fields |
| --- | --- |
| `datasets` | One or more selectors. Required: `name`. Optional: `version`, `task_names`, `exclude_task_names`, `n_tasks`. Omitted version selects the active version. Filters accept glob patterns; the cap applies after filters. |
| `agents` | One or more arms. Required: `name`, `model_name`. Optional: `version`, `reasoning_effort`, `kwargs`, `preset`, `skills`. Use [capabilities](/sdk-reference/meta) for supported values. |

Python also accepts `DatasetSelector` and `AgentArm` dataclass instances in these lists.

### Run settings

| Option | Meaning | When omitted |
| --- | --- | --- |
| `job_name` | A label for the run | Server-generated name |
| `org` | Owning organization slug or id | Client default, then personal organization |
| `n_attempts` | Attempts per task/arm; integer ≥1 | `1` |
| `n_concurrent_trials` | Requested parallel trials; `1`–`150` | `4` |
| `sandbox_provider` | Requested `e2b`, `daytona`, or `modal` | Current platform default |
| `max_trial_spend_usd` | Agent model-spend cap per trial attempt; must be >0 | Current platform default; fallback `$200` |
| `retry` | Automatic infrastructure retry policy | Current platform policy; fallback two retries |
| `analyze` | [Analyze each settled trial](/sdk-reference/analyses#start-an-analysis); `{}` enables defaults | Off |
| `system_log` | Capture sandbox system logs | Off |
| `secrets` | Stored secret references or inline values | No extra job secrets |
| `verifier_env` | Judge overrides: `REWARDKIT_JUDGE`, `REWARDKIT_MODEL` only | Task/default judge settings |

Organization and fleet capacity also constrain parallel work. A task may use another provider when the requested provider cannot support its requirements; read the trial for its actual provider.

### Timeout multipliers

All values are finite numbers greater than zero. They multiply task timeouts; they are not durations in seconds.

| Field | Applies to |
| --- | --- |
| `timeout_multiplier` | All phases without a specific override; default `1` |
| `agent_timeout_multiplier` | Agent execution |
| `verifier_timeout_multiplier` | Verification |
| `agent_setup_timeout_multiplier` | Harness installation/setup |
| `environment_build_timeout_multiplier` | Environment build |

A phase override replaces the global multiplier for that phase. Values that exceed the runtime's timer limit for the selected tasks are refused.

### Automatic retry policy

| Field | Rule |
| --- | --- |
| `max_retries` | Integer ≥0. `0` disables configured infrastructure retries. |
| `include_exceptions` | Exception names to include. Omitted, null, or `[]` means no include filter. |
| `exclude_exceptions` | Exclusions win over includes. Omitted keeps defaults; null or `[]` removes them. |
| `wait_multiplier` | Backoff multiplier; default `1` |
| `min_wait_sec` | Initial wait; default `1` second |
| `max_wait_sec` | Maximum wait; default `60` seconds |

Only eligible infrastructure failures enter this retry policy. Scoring errors and low rewards do not automatically rerun the agent. Each retry receives a fresh per-trial cap.

Provider capacity refusals have a separate bounded wait policy. They can wait even when `max_retries` is zero.

### Idempotency and unsupported input

Supply an idempotency key when repeating a submission must return the same accepted job:

Here, `config` is the job input shown above. `requestId` / `request_id` is a stable string you assign to this submission.

```ts TypeScript
const job = await client.start(config, { idempotencyKey: requestId });
```

```python Python
job = await client.start(**config, idempotency_key=request_id)
```

Use one stable request id for the same resolved request. Reusing it for a different request is refused.

`agent_env` appears in SDK signatures, but the current platform refuses nonempty values. Use [job secrets](/sdk-reference/secrets) for credentials or [registered-agent environment settings](/sdk-reference/agents) for a custom harness.

## Wait or show progress

```ts TypeScript
const finished = await client.watch(job.id, {
  onEvent: (event) => console.log(event.type),
});
```

```python Python
finished = await client.watch(
    job.id,
    on_event=lambda event: print(event.type),
)
```

The same handle can instead be consumed with `for await` / `async for` to receive events. Choose one style per handle. Job watches replay history and reconnect from the last event id.

| Watch option | TypeScript | Python |
| --- | --- | --- |
| Event callback | `onEvent` | `on_event` |
| Initial reconnect delay | `reconnectDelayMs` (default `1000`) | `reconnect_delay_s` (default `1`) |
| Maximum reconnect delay | `maxReconnectDelayMs` (default `30000`) | `max_reconnect_delay_s` (default `30`) |
| Stop waiting | `signal` | `timeout_s` |

A terminal job has finished scheduling/executing its trials. **Completed does not mean every trial passed.**

## Read and compare

```ts TypeScript
const job = await client.get(jobId);
for await (const trial of client.trials(jobId, { status: ["SCORING_ERROR"] })) {
  console.log(trial.id, trial.exception_info);
}
const tasks = await client.tasks(jobId);
const comparison = await client.compare([firstJobId, secondJobId]);
```

```python Python
job = await client.get(job_id)
async for trial in client.trials(job_id, status=["SCORING_ERROR"]):
    print(trial.id, trial.exception_info)
tasks = await client.tasks(job_id)
comparison = await client.compare([first_job_id, second_job_id])
```

Use full ids returned by create/list calls.

| Method | Options | Returns |
| --- | --- | --- |
| `get(id)` | None | `Job` |
| `list(...)` | `search`, `scope`, `kind`, `limit`, `cursor` | Paginated handle |
| `trials(id, ...)` | `status` list, `dataset`, `limit`, `cursor` | Trial handle |
| `tasks(id, ...)` | `limit`, `cursor` | Per-task rollup handle |
| `compare(ids)` | 2–10 distinct readable job ids | Job aggregates and task matrix |
| `grep(id, q, ...)` | `type`, `limit`, `cursor` | One page of matches grouped by trial |

List scope is `my`, `shared`, or `org`. Job list kind is `job` (default), `check`, or `all`; check rows have a different shape. Branch on `row.kind` before reading job-only fields.

`grep` searches parsed traces using a case-insensitive POSIX regular expression. See [trial traces](/sdk-reference/trials#read-the-trace) for per-trial filtering.

## Cancel or run selected work again

| Action | TypeScript | Python | Result |
| --- | --- | --- | --- |
| Cancel remaining work | `cancel(id)` | `cancel(id)` | Current job |
| Resume failed/stopped work | `resume(id, { filter_error_types })` | `resume(id, filter_error_types=[...])` | New linked job |
| Retry selected settled trials | `retry(id, { trial_ids })` | `retry(id, trial_ids=[...])` | New linked job |
| Retry failed trials | `retry(id, { failed_only: true })` | `retry(id, failed_only=True)` | New linked job |
| Retry all trials of a terminal job | `retry(id)` | `retry(id)` | New linked job |
| Re-run eligible verifiers | `regrade(id, { statuses, task_name })` | `regrade(id, statuses=[...], task_name=...)` | New linked job |

Resume requires a terminal source job. Explicit retry ids may select settled trials from a job still running. Do not combine `trial_ids` with `failed_only`.

Resume and retry accept the same idempotency option as start: a final options object in TypeScript, `idempotency_key` in Python. Regrade has no such SDK option.

Regrading uses the recorded verifier snapshot; it cannot replace the verifier or use edited tests. It needs retained inputs from an eligible separate verifier. Shared-verifier, judge-based, multi-step, and uploaded runs cannot be regraded. See [jobs](/core-concepts/jobs) for eligibility.

## Analyze traces

`analyze(id, ...)` starts a wave and returns immediately. `watchAnalysis` / `watch_analysis` waits for that wave. Configuration and examples are on [analyses](/sdk-reference/analyses).

For a job created with embedded analysis, wait for the job first, then its analyses. A still-running job can temporarily have zero pending analyses.

## Download or import results

```ts TypeScript
const path = await client.download(jobId, { to: "./results" });
const imported = await client.upload("./local-job");
const settled = await client.watchImport(imported.id);
console.log(settled.status, settled.job_id, settled.failure);
```

```python Python
path = await client.download(job_id, to="./results")
imported = await client.upload("./local-job")
settled = await client.watch_import(imported.id)
print(settled.status, settled.job_id, settled.failure)
```

Download requires a terminal job. Without `to`, it returns a `Buffer` / `bytes`; TypeScript also supports `{stream: true}`. See [transfer behavior](/sdk-reference/filesystem#download-options).

| Import method | Input/options |
| --- | --- |
| `upload(source, ...)` | Local job directory or archive path. TypeScript also accepts `{archive_url}`; Python takes `archive_url=` instead of a path. |
| Upload options | Optional `dataset`, upload progress callback, and import-registration callback. |
| `getImport` / `get_import` | Import id |
| `listImports` / `list_imports` | `status`, `limit`, `cursor` |
| `watchImport` / `watch_import` | TS: `onStatus`, `onProgress`, `pollIntervalMs`, `signal`. Python: `on_status`, `on_progress`, `poll_interval_s`, `timeout_s`. |

Callback names and timing use the same [upload/watch conventions as datasets](/sdk-reference/datasets#follow-a-publish). Uploaded results become a terminal record. They can be analyzed, but cannot be resumed, retried, or regraded.

## Share and delete

| Action | TypeScript | Python |
| --- | --- | --- |
| Enable an unlisted link | `share(id, { link: true })` | `share(id, link=True)` |
| Share with people | `share(id, { emails: ["person@example.com"] })` | `share(id, emails=["person@example.com"])` |
| Revoke either form | `unshare(id, { link, emails })` | `unshare(id, link=..., emails=...)` |
| Read share state | `shares(id)` | `shares(id)` |
| Permanently delete | `delete(id)` | `delete(id)` |

Sharing can send invitation email. Only the creator can manage shares or delete the job; team membership alone does not grant those actions. Deletion requires a terminal job with no running analysis or dependent regrade. The returned receipt counts deleted trials and analyses.
