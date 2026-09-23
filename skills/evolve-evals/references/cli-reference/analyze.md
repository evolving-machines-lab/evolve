---
title: "evolve analyze"
description: "Evaluate completed trial traces against a rubric."
---

Start an analysis for a finished job. Use the job ID from `evolve job list` as `$JOB_ID`.

```bash
evolve analyze "$JOB_ID" --watch
```

Each selected trial gets its own analysis run. Read those runs with [`evolve analysis`](/cli-reference/analysis).

## Inspect the defaults

```bash
evolve analyze --show-defaults
evolve analyze --show-defaults --json
```

This returns the current model, reasoning effort, sandbox provider, prompt, and rubric. Defaults mode takes no job ID or other analysis options.

## Select trials

### Failing results

```bash
evolve analyze "$JOB_ID" --failing --n-trials 20 --watch
```

### Specific trials

```bash
evolve job trials "$JOB_ID" --json
evolve analyze "$JOB_ID" --trial "$TRIAL_ID" --watch
```

Copy the **full trial ID** into `$TRIAL_ID`. This flag does not expand prefixes.

| Option | Meaning |
| --- | --- |
| `-t`, `--trial <trial-id>` | Select a trial in the job. Repeatable; full IDs required. |
| `--passing` | Only trials with reward `1.0`. |
| `--failing` | Eligible settled trials other than `SCORED` with reward exactly `1.0`. Includes missing rewards and execution errors. |
| `-l`, `--n-trials <n>` | Maximum selected trials, after filters. |
| `-n`, `--n-concurrent <n>` | Concurrent analyses, `1`–`150`. If omitted, use your organization's ceiling. |

Cancelled trials are excluded. `--passing` and `--failing` cannot be combined. The server validates trial membership and eligibility. A job can have only one active analysis wave at a time.

## Customize the analysis

```bash
evolve analyze "$JOB_ID" \
  --rubric rubric.toml \
  --prompt prompt.txt \
  --watch
```

| Option | Meaning |
| --- | --- |
| `-m`, `--model <name>` | Analyzer model. |
| `--effort <value>` | Reasoning effort. |
| `-r`, `--rubric <path>` | TOML, YAML, or JSON rubric. |
| `-p`, `--prompt <path>` | Text file replacing the default prompt. |
| `-e`, `--env <provider>` | Sandbox provider for analysis. |
| `--show-defaults` | Print the default policy and exit. |

A rubric contains a `criteria` list. Every criterion needs `name`, `description`, and `guidance`.

```toml rubric.toml
[[criteria]]
name = "uses_evidence"
description = "The final answer is supported by observed results."
guidance = "Check whether the trace supports the claims in the final answer."
```

For prompt placeholders, rubric rules, and results, see [Analyze](/core-concepts/analyze).

## Wait and read results

| Option | Meaning |
| --- | --- |
| `--watch` | Wait until the selected analyses settle. |
| `-q`, `--quiet` | With watch, suppress intermediate progress. |

Without watch, the command returns the accepted job. With `--watch --json`, it prints `analysis.accepted`, progress records, and `analysis.final`.

```bash
evolve analysis list --job "$JOB_ID"
evolve trial show "$TRIAL_ID"
```

A failed analysis execution produces exit code `1`. A rubric criterion marked `fail` is a finding, not an execution error.

To analyze automatically during a new evaluation, use [`run --analyze`](/cli-reference/run). [Global options](/cli-reference/index#global-options) apply.
