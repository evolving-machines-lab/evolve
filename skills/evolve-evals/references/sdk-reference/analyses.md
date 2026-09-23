---
title: "Analyses"
description: "Analyze trial traces, then inspect the verdict and the analyzer's own run."
---

**Note:**

For every method’s inputs, return values, and language differences, see the [analyses method reference](/sdk-reference/methods/analyses).

Analysis asks an agent to read a trial's evidence against a rubric. It produces criterion outcomes and explanations. It does not replace the verifier's reward.

```text
Trial trace + task + rubric
             │
             ▼
        Analyzer run
             │
             ▼
 Summary + criterion outcomes + evidence
```

## Start an analysis

Start work through the **jobs** client. Read analyzer runs through the **analyses** client.

```ts TypeScript
import { jobs, analyses } from "@evolvingmachines/evolve";

await jobs().analyze(jobId, { failing: true });
const job = await jobs().watchAnalysis(jobId);
console.log(job.stats.analysis);
```

```python Python
from evolve import jobs, analyses

await jobs().analyze(job_id, failing=True)
job = await jobs().watch_analysis(job_id)
print(job.stats.get("analysis"))
```

Manual analysis requires a terminal job. It returns immediately after queuing work. Only one analysis wave can run for that job at a time.

To analyze trials as they finish, pass `analyze: {}` / `analyze={}` when starting the job. Wait for job completion before calling the analysis watch.

### Configuration

The field names are the same in both languages. TypeScript passes an object; Python uses keyword arguments on `analyze()` or a dictionary inside job creation.

| Field | Purpose |
| --- | --- |
| `model_name` | Analyzer model |
| `reasoning_effort` | Effort supported by the analyzer |
| `sandbox_provider` | Analyzer's sandbox provider |
| `rubric` | `{criteria: [{name, description, guidance}, ...]}` |
| `prompt` | Replacement prompt template text |
| `n_concurrent` | Requested parallel analyses; integer 1–150, also bounded by team quota |
| `passing` | Only scored trials with primary reward exactly 1 |
| `failing` | Other analyzable trials |
| `n_trials` | Positive cap after selection |
| `trial_ids` | Explicit trial ids from this job; manual analysis only |

`passing` and `failing` cannot both be true. Cancelled trials are excluded. Explicit ids are filtered before the cap; unknown, duplicate, or empty ids are refused.

### Analysis watch options

| TypeScript | Python | Purpose |
| --- | --- | --- |
| `onStats` | `on_stats` | Called with the job when analysis tally changes |
| `pollIntervalMs` | `poll_interval_s` | Initial interval; default 2000 ms / 2 s |
| `signal` | `timeout_s` | Stop waiting / bound the Python wait |

Polling slows to at most 30 seconds while the tally stays unchanged. Call the watch after starting analysis; a job never analyzed can have a null tally indefinitely.

## Read current defaults

```ts TypeScript
const defaults = await analyses().defaults();
console.log(defaults.model_name, defaults.rubric, defaults.prompt);
```

```python Python
defaults = await analyses().defaults()
print(defaults["model_name"], defaults["rubric"], defaults["prompt"])
```

The response includes `model_name`, `rubric`, `prompt`, `reasoning_effort`, and `sandbox_provider`. The prompt is the editable template text.

A custom analyze prompt may use `{trial_path}`, `{task_section}`, and `{criteria_guidance}`. The required result schema is appended by the platform. See [analysis concepts](/core-concepts/analyze) for rubric design.

## Read verdicts

```ts TypeScript
for await (const result of analyses().list({ job: jobId })) {
  console.log(result.id, result.status, result.checks);
}
```

```python Python
async for result in analyses().list(job=job_id):
    print(result["id"], result["status"], result["checks"])
```

List options: `scope`, `job`, `status` list, `limit`, `cursor`. Status values are `queued`, `running`, `completed`, `failed`.

The latest analysis also appears on `trial.analysis`. Each criterion reports `pass`, `fail`, `not_applicable`, or `unknown`, with an explanation and evidence. Evolve derives no verdict from them; compute what you need from the criteria.

## Inspect the analyzer run

| Method | TypeScript | Python |
| --- | --- | --- |
| List runs | `list(options)` | `list(...)` |
| Read defaults | `defaults()` | `defaults()` |
| Download run | `download(analysisId, { to })` | `download(analysis_id, to=...)` |
| Browse sandbox files | `filesystem(analysisId)` | `filesystem(analysis_id)` |
| Read one verdict directly | `get(analysisId)` | Use list results or `trial.analysis` |
| Read analyzer transcript | `transcript(analysisId, { since })` | Not exposed |
| Read raw stored artifact | `artifact(analysisId, stream)` | Not exposed |

`analysisId` identifies the analyzer run, not the trial it read. `since` is an inclusive nonnegative event index; the transcript returns `events`, `total`, run metadata, and separate `gateway_calls`.

TypeScript artifact selectors are `trace-stdout`, `trace-stderr`, and `agent-home`. The first two return text or null; `agent-home` returns a file map or null.

Downloads return a wrapper-trial archive. See [filesystem and download options](/sdk-reference/filesystem).
