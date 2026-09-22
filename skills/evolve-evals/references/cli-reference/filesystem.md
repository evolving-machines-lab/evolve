---
title: "Files, logs, and processes"
description: "Inspect a running sandbox, captured files, or a published task package."
---

The same read commands work for trials, analysis runs, and individual task checks.

| Resource | Command prefix | ID source |
| --- | --- | --- |
| Evaluation trial | `evolve trial` | `evolve job trials "$JOB_ID"` |
| Analysis run | `evolve analysis` | `evolve analysis list` |
| Task check | `evolve check` | `evolve check show "$CHECK_ID" --json` |

Use the corresponding full ID as `$TRIAL_ID`, `$ANALYSIS_ID`, or `$TASK_CHECK_ID` below.

## Choose a resource

### Trial

```bash
evolve trial files status "$TRIAL_ID"
evolve trial files list "$TRIAL_ID" /
evolve trial files cat "$TRIAL_ID" /app/result.txt
evolve trial files search "$TRIAL_ID" 'error' --path /app
evolve trial files changes "$TRIAL_ID"
evolve trial files archive "$TRIAL_ID" --path /app -o archives/
evolve trial logs "$TRIAL_ID" --stream agent --follow
evolve trial procs "$TRIAL_ID"
```

### Analysis

```bash
evolve analysis files status "$ANALYSIS_ID"
evolve analysis files list "$ANALYSIS_ID" /
evolve analysis files cat "$ANALYSIS_ID" /app/analysis.json
evolve analysis files search "$ANALYSIS_ID" 'error' --path /app
evolve analysis files changes "$ANALYSIS_ID"
evolve analysis files archive "$ANALYSIS_ID" --path /app -o archives/
evolve analysis logs "$ANALYSIS_ID" --stream agent --follow
evolve analysis procs "$ANALYSIS_ID"
```

Use an analysis ID, not the evaluated trial's ID.

### Task check

```bash
evolve check files status "$TASK_CHECK_ID"
evolve check files list "$TASK_CHECK_ID" /
evolve check files cat "$TASK_CHECK_ID" /app/task/task.toml
evolve check files search "$TASK_CHECK_ID" 'error' --path /app
evolve check files changes "$TASK_CHECK_ID"
evolve check files archive "$TASK_CHECK_ID" --path /app -o archives/
evolve check logs "$TASK_CHECK_ID" --stream agent --follow
evolve check procs "$TASK_CHECK_ID"
```

Use the individual task-check ID, not the parent check ID.

The file paths above are examples. List the folder first and choose a path that exists in your run.

## Live or captured?

`files status` reports what is available.

| State | What you can inspect |
| --- | --- |
| `live` | Files in the running sandbox. |
| `capturing` | Capture is still being written. |
| `captured` | The stored file tree. |
| `none` | No live sandbox or available capture. |

Reads normally choose the available source. Add `--source live` or `--source capture` to require one; an unavailable source returns an error.

**Note:**

A capture is not a full copy of the original image. Unchanged image files can appear in listings without stored bytes. Reading one returns `not_captured`. Search also excludes files whose bytes were not captured.

## Browse and read

| Command | Options |
| --- | --- |
| `files status <id>` | No command-specific options. |
| `files list <id> [path]` | Path defaults to `/`; `--source`; `-l, --limit` (default `500`, max `1000`); `--cursor <name>`. |
| `files cat <id> <path>` | `--source`; `--range <bytes=a-b>`. |

`files ls` is an alias of `files list`. Listing cursors come from `next_cursor`.

### Byte ranges and binary output

| Range | Selects |
| --- | --- |
| `bytes=0-1023` | The first 1024 bytes. |
| `bytes=1024-` | Everything from byte 1024 onward. |
| `bytes=-1024` | The last 1024 bytes. |

`files cat` writes raw bytes. Redirect them to a local file when needed.

```bash
evolve trial files cat "$TRIAL_ID" /app/result.txt > result.txt
```

With `--json`, the response contains base64 `data`, `encoding`, `bytes`, and `path`.

## Search and changes

| Command | Options |
| --- | --- |
| `files search <id> <text>` | `--path <folder>` (default `/`); `--regex`; `-l, --limit` (default `200`, max `1000`); `--source`. |
| `files changes <id>` | `--phase <setup\|agent\|verifier\|all>` (default `all`); `-l, --limit` (default `500`, max `1000`); `--cursor <path>`; `--source`. |

Search reports file paths, line numbers, and snippets. Narrow `--path` when searching the whole sandbox is unnecessary.

Changes report created, modified, and removed files by execution phase.

## Download a subtree

```bash
evolve trial files archive "$TRIAL_ID" --path /app -o archives/
```

| Option | Meaning |
| --- | --- |
| `--path <path>` | Subtree to archive. Default `/`. |
| `--source <live\|capture>` | Require a specific source. |
| `-o`, `--output-dir <dir>` | Save the `.tar.gz` file and print its path. |

Without an output directory, the command writes archive bytes to stdout. With `--json`, those bytes are base64; when saving to disk, JSON returns the saved path.

## Logs

```bash
evolve trial logs "$TRIAL_ID" --stream agent --follow
```

| Option | Meaning |
| --- | --- |
| `--stream <name>` | Required: `agent`, `verifier`, or `system`. |
| `-f`, `--follow` | Keep printing new lines while the sandbox lives. |
| `-l`, `--limit <n>` | Lines per page without follow. Default and maximum `1000`. |
| `--cursor <seq>` | Resume after this line sequence. |

`system` is recorded only when the job enabled `--system-log`. `setup` and `metrics` are accepted stream names but are not recorded today.

Without follow, JSON is a page of lines. With follow, each line is a separate JSON record. `--limit` does not limit a follow stream.

## Processes

`procs <id>` reads the running sandbox's process list. It accepts only [global options](/cli-reference/index#global-options) and is unavailable after the sandbox ends.

## Published task files

These commands read the **task package**, not a trial sandbox. Pin the dataset version.

```bash
evolve dataset files status harbor-examples@1.0 hello-world
evolve dataset files list harbor-examples@1.0 hello-world /
evolve dataset files cat harbor-examples@1.0 hello-world /instruction.md
```

| Command | Options |
| --- | --- |
| `dataset files status <name@version> <task>` | No command-specific options. |
| `dataset files list <name@version> <task> [path]` | Path defaults to `/`; `-l, --limit` (default `500`, max `1000`); `--cursor <name>`. |
| `dataset files cat <name@version> <task> <path>` | `--range <bytes=a-b>`. |

Task-package reads have no live/capture selector. All commands accept [global options](/cli-reference/index#global-options).
