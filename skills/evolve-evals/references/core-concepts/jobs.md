---
title: "Jobs"
description: "Run a task set across agents and models. Follow each attempt to its result."
---

A job runs selected tasks against one or more **agent arms**. An arm is an agent, model, and configuration you want to evaluate.

```text
3 selected tasks
× 2 agent arms
× 2 attempts
= 12 trials
```

Each of the three tasks runs twice in Arm A and twice in Arm B.

## Start a job

```bash
evolve run \
  -d harbor-examples@1.0 -i hello-world \
  -a codex -m gpt-5.6-luna \
  --max-trial-spend 1 -r 0 \
  --watch
```

| Choose | Flag | Meaning |
| --- | --- | --- |
| Task set | `-d name@version` | Repeat for several datasets. |
| Agent | `-a codex` | The harness that runs the model. |
| Model | `-m model` | Repeat to compare models with the same harness. |
| Attempts | `-k 2` | Attempts per task and arm. Default: 1. |
| Parallel trials | `-n 4` | Job concurrency. Default: 4; maximum: 150. |
| Label | `--job-name nightly` | A readable name. The job ID remains its identity. |

Use a [config file](#config-files) to compare different harnesses in one job.

## Narrow the task set

```text
1. Select dataset version
          ↓
2. Include names matching -i
          ↓
3. Remove names matching -x
          ↓
4. Keep up to -l tasks per dataset
```

`-i` and `-x` accept task-name globs. Quote them so your shell does not expand them.

```bash
evolve run -d my-dataset@1.0 -a codex -m gpt-5.6-luna \
  -i 'auth-*' -x 'auth-legacy' -l 20 \
  --max-trial-spend 2 -r 0 --watch
```

## Watch it

With `--watch`, the CLI follows events until the job finishes. Without it, the CLI returns the accepted job immediately.

Use the returned ID as `$JOB_ID`:

```bash
evolve job show "$JOB_ID"
evolve job trials "$JOB_ID"
evolve job tasks "$JOB_ID"
```

**Note:** **Accepted** means the job was created. **Completed** means every trial settled. Neither means every trial succeeded.

## Spend and retries

Set `--max-trial-spend` to cap each trial attempt’s **agent** model spend. The response records the resolved cap and its model-spend estimate for the full job:

```text
worst_case_spend_usd
  = per-trial cap
  × trial count
  × (1 + max_retries)
```

| Cost | Where to read it |
| --- | --- |
| Job model spend, including retired retry attempts | `stats.cost_usd` |
| Verifier judge spend, included in that total | `stats.judge_cost_usd` |
| Trace analysis spend, separate from trial spend | `stats.analysis.cost_usd` |
| GPU compute estimate, separate from model spend | `stats.gpu_cost_usd` |

An LLM verifier judge has its own cap: the smaller of the agent cap and $5. Its spend is additional to the estimate above. Analysis also has a separate budget.

The fleet defaults are $200 per trial and 2 infrastructure retries; deployment settings can change them. The job response records the values used. There is no job-wide spend-cap setting.

A trial that reaches its own cap proceeds to verification. An account, team, or platform budget refusal is a separate `BUDGET` outcome.

### Automatic retries and capacity waits

`-r 0` disables configured infrastructure retries. With retries enabled, only eligible `INFRASTRUCTURE_ERROR` trials rerun automatically. Each retry receives a fresh per-trial cap; previous spend remains in the job total.

`--retry-include` and `--retry-exclude` filter exception types. Exclusions win. The same infrastructure failure twice in a row can stop retries early.

A provider that cannot allocate a sandbox can cause a **capacity wait**, even with `-r 0`. Capacity waits use a separate bounded wait budget and do not consume configured retries.

## Read the results

```bash
evolve job trials "$JOB_ID" --status INFRASTRUCTURE_ERROR,SCORING_ERROR
evolve job compare "$JOB_ID" "$OTHER_JOB_ID"
evolve job list --search nightly
```

Results are grouped by agent arm and dataset. Compare 2–10 jobs at once.

### How to read pass@k

pass@k estimates the chance of at least one successful attempt among `k` attempts, averaged across tasks.

It appears for settled groups with one binary reward per trial. Missing rewards count as failures for this statistic; the trial's own reward remains absent. Non-binary or multi-key rewards do not produce pass@k.

Available `k` values are powers of two and multiples of five up to the smallest per-task attempt count. A single-attempt group has no pass@k.

## Statuses

| Status | Meaning |
| --- | --- |
| `QUEUED` | Accepted; waiting for dispatch. |
| `RUNNING` | Trials are being processed. |
| `CANCELLING` | Cancellation requested; active trials are stopping. |
| `COMPLETED` | All trials settled. Some may have errors. |
| `CANCELLED` | The job was cancelled. |
| `FAILED` | Reserved in the API; the current worker does not assign it. |

Read [trial statuses](/core-concepts/trials#statuses) to understand individual outcomes.

## Derive a new job

Each command below creates a new job linked through `source_jobs`. The original result stays intact.

| Action | Runs again | Selects |
| --- | --- | --- |
| **Resume** | Agent and verifier | Failed or stopped trials from a finished job. |
| **Retry** | Agent and verifier | All, failed, or explicitly selected settled trials. Scored trials are allowed. |
| **Regrade** | Verifier only | Eligible trials with recorded verifier inputs. |

```bash
evolve job resume "$JOB_ID"
evolve job retry "$JOB_ID" --failed-only
evolve job retry "$JOB_ID" -t "$TRIAL_ID"
evolve job regrade "$JOB_ID" --task hello-world
```

Use full trial IDs with `-t`. Named settled trials can be retried while other trials in the source job are running. Whole-job retry and resume require a finished source.

### Regrade eligibility

Regrade re-runs the recorded verifier snapshot on retained inputs. It does not accept a replacement verifier or pick up edits to the task's tests.

Regrade needs recorded inputs from a separate verifier environment. Shared-verifier, multi-step, and LLM-judge tasks are not supported for regrade.

A whole-job regrade skips ineligible trials and refuses if none remain. A single-trial regrade reports the reason it is ineligible. Uploaded jobs cannot be resumed, retried, or regraded.

## Stop, cancel, delete

| Command | Effect |
| --- | --- |
| `evolve job cancel "$JOB_ID"` | Stop the whole job. |
| `evolve job stop "$JOB_ID" --dataset my-dataset` | Stop trials from one dataset. Other trials continue. |
| `evolve job delete "$JOB_ID" --yes` | Permanently remove the finished job and its stored results. |

Deletion is restricted to the creator. Active analyses or derived regrades can prevent deletion until they finish.

## Share

```bash
evolve job share "$JOB_ID" --link
```

Share by link or email. Recipients get read access; see [Sharing](/core-concepts/sharing).

## Download

```bash
evolve job download "$JOB_ID" -o results/
```

This unpacks a Harbor-format job directory under `results/job-<id>/`, with job records and one folder per trial. See [Trial outputs](/core-concepts/trial-outputs).

## Config files

Use YAML or JSON for a repeatable comparison:

```yaml comparison.yaml
datasets:
  - name: harbor-examples
    version: "1.0"
    task_names: [hello-world]
agents:
  - name: codex
    model_name: gpt-5.6-luna
  - name: claude
    model_name: fable
n_attempts: 2
max_trial_spend_usd: 1
retry:
  max_retries: 0
```

```bash
evolve run -c comparison.yaml --print-config
evolve run -c comparison.yaml --watch
```

`--print-config` shows the request without submitting it. It does not resolve every server default or validate server acceptance. Use `--org` for team ownership.

**[Run reference](/cli-reference/run)**

Flags, configuration overrides, and output modes.

**[Inspect a trial](/core-concepts/trials)**

Read the score, failure, and trace.
