---
title: "Trials"
description: "Inspect one attempt, from its reward to its trace and files."
---

**Note:**

For every method’s inputs, return values, and language differences, see the [trials method reference](/sdk-reference/methods/trials).

A trial is one task, one agent/model arm, and one attempt. Get its id from `jobs.trials(jobId)`; its record includes the parent `job_id`.

## Read the result

```ts TypeScript
import { trials } from "@evolvingmachines/evolve";

const client = trials();
const trial = await client.get(trialId);
console.log(trial.status, trial.reward, trial.exception_info);
```

```python Python
from evolve import trials

client = trials()
trial = await client.get(trial_id)
print(trial.status, trial.reward, trial.exception_info)
```

| Read | What it tells you |
| --- | --- |
| `status`, `attempt_phase` | Whether it is waiting, running, scoring, or settled; the current execution phase |
| `reward`, `verifier_result` | Primary reward and the verifier's full rewards map |
| `exception_info` | Why a trial ended with an exception |
| `agent_info` | Harness, version, model, and effort |
| `usage`, `spend_source` | Metered usage and whether the reading is final |
| `analysis` | Latest trace-analysis result, when present |
| `sandbox_provider`, `sandbox_id` | Where it actually ran |
| `n_retries`, `retries` | Automatic retry history |

A reward of `0` is a scored result. A missing reward is not automatically zero. See [statuses and nullable values](/sdk-reference/types).

## Read the trace

```ts TypeScript
for await (const event of client.traceEvents(trialId)) {
  console.log(event.seq, event.type, event.data);
}
```

```python Python
async for event in client.trace_events(trial_id):
    print(event.seq, event.type, event.data)
```

This drains stored events. It does not remain connected waiting for future events.

| Method | Returns |
| --- | --- |
| `trace(id, options)` | One page of `TraceEvent` records |
| `traceEvents(id, options)` / `trace_events(id, ...)` | Async iterator over matching stored events |

Both accept `cursor`, `limit`, `type`, `grep`, and `tail`. TypeScript uses one options object; Python uses keywords. `grep` is a case-insensitive POSIX regex over event type and content. `tail` selects the newest matching events; the server caps it at 10,000.

### Read per-call model usage

Use `gatewayUsageOf` / `gateway_usage_of` to find the gateway's token and cost readings. Other events, including the harness's own usage reports, return null / `None`.

```ts TypeScript
import { gatewayUsageOf, trials } from "@evolvingmachines/evolve";

for await (const event of trials().traceEvents(trialId)) {
  const call = gatewayUsageOf(event);
  if (call) console.log(call.callId, call.usage.costUsd);
}
```

```python Python
from evolve import gateway_usage_of, trials

async for event in trials().trace_events(trial_id):
    call = gateway_usage_of(event)
    if call is not None:
        print(call["callId"], call["usage"]["costUsd"])
```

| Field | Meaning |
| --- | --- |
| `promptTokens` | Input tokens, including cached and cache-written tokens |
| `completionTokens` | Output tokens |
| `cachedTokens` | Cached portion of input tokens |
| `costUsd` | Cost recorded by the gateway |

These fields live under `call.usage` / `call["usage"]`. Do not add the harness's usage to these readings: they describe the same run from different sources. Use the trial's `usage` for its aggregate reading.

## Read stored artifacts

```ts TypeScript
const atif = await client.artifact(trialId, "trace-atif");
const verifier = await client.artifact(trialId, "verifier");
const home = await client.artifact(trialId, "agent-home");
```

```python Python
atif = await client.artifact(trial_id, "trace-atif")
verifier = await client.artifact(trial_id, "verifier")
home = await client.artifact(trial_id, "agent-home")
```

| Stream | Result |
| --- | --- |
| `trace-atif` | Normalized ATIF trajectory as JSON text |
| `trace-stdout` | Harness stdout |
| `trace-stderr` | Harness stderr |
| `verifier` | Verifier output |
| `agent-home` | Map of captured sandbox paths to text |
| `trajectory` | Reserved native-session selector; availability is not guaranteed |

Missing stored content returns null / `None`. `trace-parsed` belongs to `trace`; `filesystem` belongs to the [filesystem client](/sdk-reference/filesystem).

## Read individual files

```text
Stored trial result tree
├── config.json
├── result.json
├── agent/
│   ├── trajectory.json
│   └── … harness output
├── verifier/
│   └── … verifier output
└── artifacts/
    └── … collected files
```

The actual files depend on what was produced and retained. Use `files()` to discover them.

```ts TypeScript
const page = await client.files(trialId, { limit: 200 });
const bytes = await client.file(trialId, "result.json");
const prefix = await client.file(trialId, "result.json", { start: 0, end: 1023 });
```

```python Python
page = await client.files(trial_id, limit=200)
content = await client.file(trial_id, "result.json")
prefix = await client.file(trial_id, "result.json", start=0, end=1023)
```

`files` accepts `limit` and `cursor`. `file` returns `Buffer` / `bytes`; byte ranges accept `start`, inclusive `end`, or `suffix` for the last N bytes. A suffix takes precedence.

These are stored result files. To browse sandbox paths, use `client.filesystem(trialId)` and the [filesystem methods](/sdk-reference/filesystem).

## Stop, retry, or regrade

| Action | TypeScript | Python | Returns |
| --- | --- | --- | --- |
| Stop selected runs | `stop([trialId])` | `stop([trial_id])` | Batch result |
| Run the attempt again | `retry(trialId, { idempotencyKey })` | `retry(trial_id, idempotency_key=...)` | New linked job |
| Re-run its eligible verifier | `regrade(trialId)` | `regrade(trial_id)` | New linked job |

`stop` accepts up to 100 trial or analysis ids. Its response separates `stopped`, `stopped_analyses`, `already_terminal`, and `not_found`. Check each group; one missing id does not erase the rest of the result.

Retry requires a settled trial. Regrade requires retained inputs from an eligible separate verifier. [Job operations](/sdk-reference/jobs#cancel-or-run-selected-work-again) describe the differences.
