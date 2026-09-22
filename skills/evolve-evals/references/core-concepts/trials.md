---
title: "Trials"
description: "Inspect one agent's attempt: what it did, what it earned, and why it stopped."
---

A **trial** is one attempt at one task by one agent arm. Its ID works on its own; you do not need to supply the parent job ID.

Use an ID from `evolve job trials "$JOB_ID"` as `$TRIAL_ID`:

```bash
evolve trial show "$TRIAL_ID"
```

## Follow the attempt

```text
1. QUEUED
   Wait for dispatch
         ↓
2. RUNNING
   Prepare → build → boot
   → install → run the agent
         ↓
3. SCORING
   Run the verifier
         ↓
4. Settle
   Record reward, exception,
   spend, and files
```

This is the normal execution path. A trial can stop earlier with an error, budget refusal, or cancellation. `attempt_phase` distinguishes slow preparation from agent work or verification.

## Statuses

| Status | What it tells you |
| --- | --- |
| `QUEUED` | Waiting to run. |
| `RUNNING` | Execution is in progress. Check `attempt_phase`. |
| `SCORING` | The verifier is evaluating the result. |
| `SCORED` | A valid reward map was recorded. Zero is a real score. |
| `SCORING_ERROR` | The verifier output was invalid or verification failed. |
| `INFRASTRUCTURE_ERROR` | Infrastructure prevented a reliable result. Eligible failures may retry. |
| `BUDGET` | An account, team, or platform budget refused execution. |
| `INDETERMINATE` | No reliable scoring outcome was recorded. |
| `CANCELLED` | The trial was stopped. |

**Note:**

A missing reward is not zero. A multi-key reward map without a primary reward can be `SCORED` while the scalar `reward` is null; inspect `verifier_result.rewards`.

### Find the cause

| Read | Use it for |
| --- | --- |
| `exception_info` | Failure type and explanation. |
| `attempt_phase` | The current stage of execution. |
| `n_retries` and `retries` | Automatic retries and earlier outcomes. |
| `sandbox_provider_degrade` | Why the actual provider differs from the requested one. |
| `step_results` | Per-step outcomes for a multi-step task. |

For `BUDGET`, restore the relevant credits or budget before [resuming the job](/core-concepts/jobs#derive-a-new-job).

## The trace

The trace shows the prompt, messages, tool calls, and results. Search one trial or the whole job:

```bash
evolve trial trace "$TRIAL_ID"
evolve trial trace "$TRIAL_ID" --grep 'permission denied' --tail 50
evolve job grep "$JOB_ID" 'permission denied'
```

| Filter | Meaning |
| --- | --- |
| `--type` | Exact event type. |
| `--grep` | Case-insensitive regular expression. |
| `--tail` | Last N matching events. |
| `--cursor` | Continue after an event position. |
| `--json` | Full events, one JSON object per line. |

`trial trace` reads the stored events available now. It does not stay connected for future events. Use the [dashboard viewer](/dashboard/trial-viewer) for an updating trace.

## Spend

| Field | Reading |
| --- | --- |
| `live_spent_usd` | Spend so far while running; a lower bound. |
| `agent_result.cost_usd` | Recorded agent spend after settlement. |
| `spend_source` | Whether the reading is final or provisional. |
| `judge_result` | Verifier judge spend and usage. |
| `usage` | Gateway token and cost accounting. |

`measured` is final. `measured_provisional` can increase. `assumed_cap` means spend was not measured; its stored zero is a placeholder, not proof of a free run.

## Artifacts

```bash
evolve trial download "$TRIAL_ID" --stream verifier
evolve trial download "$TRIAL_ID" --stream trace-atif
```

The verifier log explains grading. The ATIF trajectory provides a portable conversation record. Raw stdout, stderr, and captured agent-home files are also available.

## Download the trial tree

```bash
evolve trial download "$TRIAL_ID" -o trials/
```

The CLI saves `trials/<trial-id>/`. See [Trial outputs](/core-concepts/trial-outputs#the-trial-directory) for the tree and the difference from a full job archive.

## Act on one trial

| Command | Result |
| --- | --- |
| `evolve trial retry "$TRIAL_ID"` | New job that reruns this settled trial. |
| `evolve trial regrade "$TRIAL_ID"` | New job that reruns only an eligible verifier. |
| `evolve trial stop "$TRIAL_ID"` | Stop this live trial; leave its job running. |

Retry and regrade create new records. They do not replace the source result. Read [eligibility and selection rules](/core-concepts/jobs#derive-a-new-job) before using them.

**[Trial outputs](/core-concepts/trial-outputs)**

Files, traces, and the captured filesystem.

**[Trial reference](/cli-reference/trial)**

Every inspection and control command.
