---
title: "evolve analysis"
description: "Read an analysis result, transcript, or stored files."
---

Use [`evolve analyze`](/cli-reference/analyze) to start analyses. Use `evolve analysis` to read them.

```bash
evolve analysis list --job "$JOB_ID"
evolve analysis show "$ANALYSIS_ID"
```

`$JOB_ID` is an evaluation job ID. `$ANALYSIS_ID` comes from the analysis list.

## List analyses

```bash
evolve analysis list --status failed --scope org
```

| Option | Meaning |
| --- | --- |
| `--job <job-id>` | Analyses for this job. |
| `--status <statuses>` | Comma-separated `queued`, `running`, `completed`, or `failed`. |
| `--scope <my\|shared\|org>` | Records to list. Default `my`. |

All shared [list options](/cli-reference/index#list-options) apply: `--limit`, `--cursor`, `--columns`, `--quiet`, `--no-trunc`, `--no-headers`.

## Show the result

```bash
evolve analysis show "$ANALYSIS_ID" --json
```

`show`, `trace`, and `download` also accept a **trial ID**, which selects that trial's latest analysis. An analysis ID selects that specific run.

Prefixes must identify only one analysis or analyzed trial. Use a full ID when a prefix is ambiguous.

## Read the transcript

```bash
evolve analysis trace "$ANALYSIS_ID"
evolve analysis trace "$ANALYSIS_ID" --since 200
```

`--since <n>` skips N transcript events. This command reads the available transcript and exits; it does not follow live output. With `--json`, events are printed one per line.

## Download

```bash
evolve analysis download "$ANALYSIS_ID" -o analyses/
```

The archive contains the analyzer's run in a Harbor-compatible trial folder, plus an `evolve.json` record.

| Option | Meaning |
| --- | --- |
| `-o`, `--output-dir <dir>` | Parent folder. Default `analyses/`. |
| `--overwrite` | Allow replacing an existing folder. |
| `--stream <artifact>` | Print one artifact: `analysis`, `trace-parsed`, `trace-stdout`, `trace-stderr`, or `agent-home`. |
| `--since <n>` | With `--stream trace-parsed`, skip the first N events. |

`--stream` cannot be combined with output directory or overwrite.

```bash
evolve analysis download "$ANALYSIS_ID" --stream analysis
evolve analysis download "$ANALYSIS_ID" --stream trace-stderr
```

## Files and live output

Use the shared [filesystem reference](/cli-reference/filesystem) for `analysis files`, `analysis logs`, and `analysis procs`.

**Note:**

These filesystem and log commands require an **analysis ID**. They do not select an analysis from a trial ID.

[Global options](/cli-reference/index#global-options) apply.
