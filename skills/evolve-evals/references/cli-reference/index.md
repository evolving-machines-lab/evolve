---
title: "CLI reference"
description: "Run evaluations, inspect results, and manage the resources around them."
---

Use `evolve` to run evaluations in the cloud. Add `--help` to any command for its options.

```bash
evolve run --help
evolve job list --json
```

**[Run an evaluation](/cli-reference/run)**

Select tasks, agents, models, and a spend cap.

**[Inspect results](/cli-reference/job)**

Read scores, compare jobs, and inspect trials.

**[Check and analyze](/cli-reference/check)**

Check task quality or analyze completed traces.

**[Read files and logs](/cli-reference/filesystem)**

Browse a running sandbox or its captured files.

## Choose a command

| You want to… | Command |
| --- | --- |
| Start an evaluation | [`run`](/cli-reference/run), also `job start` |
| Inspect or act on a job | [`job`](/cli-reference/job) |
| Inspect or act on one trial | [`trial`](/cli-reference/trial) |
| Analyze completed traces | [`analyze`](/cli-reference/analyze) |
| Read analysis runs | [`analysis`](/cli-reference/analysis) |
| Check tasks and read reports | [`check`](/cli-reference/check) |
| Browse or publish tasks | [`dataset`](/cli-reference/dataset) |
| Import completed results | [`upload`](/cli-reference/upload) |
| Register a custom agent | [`agent`](/cli-reference/agent) |
| Upload skills for evaluated agents | [`skill`](/cli-reference/skill) |
| Read the bundled agent manual | [`skills`](/cli-reference/skills) |
| Check identity or manage teams | [`auth`](/cli-reference/auth) |
| Store environment secrets | [`secrets`](/cli-reference/secrets) |
| Inspect managed-agent sessions | [`session`](/cli-reference/session) |

`skill` and `skills` are different: one manages uploaded content; the other reads the manual shipped with your CLI.

## Global options

Put options after the command, as in `evolve job list --json`.

| Option | Meaning |
| --- | --- |
| `--json` | Machine-readable output. The shape depends on the command; see [Output](#output). |
| `--api-key <key>` | Override `EVOLVE_API_KEY`. |
| `--base-url <url>` | Override `EVOLVE_DASHBOARD_URL`, otherwise use the Evolve dashboard API. |
| `-h`, `--help` | Show help for the command. |

`evolve --version` or `evolve -v` prints the installed version. Bare `evolve` prints help.

## List options

Paged lists return **one page**. Pass the returned cursor to read the next.

```bash
evolve job list --limit 20 --json
evolve job list --cursor "$NEXT_CURSOR" --json
```

| Option | Meaning |
| --- | --- |
| `-l`, `--limit <n>` | Page size. |
| `--cursor <cursor>` | Read the next page. |
| `--columns <keys>` | Comma-separated column names, in the order you want. |
| `--columns all` | Show every available column. |
| `--columns help` | List available columns without an API request. |
| `-q`, `--quiet` | Print only IDs, or the resource's name where it has no ID column. |
| `--no-trunc` | Keep full cell text in terminal tables. |
| `--no-headers` | Omit the header from piped TSV output. |

These options apply to paged `list` commands, `job trials`, `job tasks`, and `job imports`. `auth org list` and `secrets list` use the formatting options only. The local `skills list` has its own simpler output.

### Scope

`job list`, `analysis list`, `check list`, `session list`, `agent list`, and `skill list` accept `--scope`.

| Value | Records selected |
| --- | --- |
| `my` | Records you created. Default. |
| `shared` | Other users’ records available through your organizations or supported email shares. |
| `org` | Records across your organizations, including your own. |

Email shares apply to jobs, analyses, checks, and sessions. Analyses follow the ownership and sharing of their source job.

Use full IDs when opening records from another scope. Prefix lookup usually searches your own records.

## IDs and values

Most positional UUIDs accept an unambiguous prefix of at least eight characters. A full ID avoids the extra lookup requests.

**Note:** Use **full trial IDs** with `analyze --trial` and `job retry --trial`. Import IDs must also be copied in full.

A trial prefix may require reading the trials of every job in scope. On large accounts, prefer the full ID from `evolve job trials "$JOB_ID"`.

Repeat a repeatable flag once per value. Do not combine short flags.

```bash
evolve run -d harbor-examples@1.0 -a codex -m gpt-5.6-luna \
  -i 'hello-*' -x '*-slow' --max-trial-spend 0.30 --max-retries 0
```

Values may begin with `-`. If a value is also a recognized option, use `--flag=value` to make it explicit.

### Aliases

`jobs`, `trials`, `analyses`, `sessions`, and `datasets` alias their singular nouns. `secret` aliases `secrets`. `ls` aliases `list`, including `files ls` and `auth org ls`.

`agents` is reserved and is not an alias of `agent`. `skills` is not an alias of `skill`.

## Output

| Command shape | Output with `--json` |
| --- | --- |
| Ordinary read or list | One JSON object or page. Multiple `job show` IDs return an array. |
| Run, analysis, or check with `--watch` | One JSON record per line: accepted, progress, final. |
| Dataset publish/watch | One JSON record per line while watching. |
| Upload or `job import --watch` | One final job or error object. |
| Trace or `logs --follow` | One event or log line per JSON record. |
| File or archive to stdout | Base64 data with a byte count. Without `--json`, raw bytes. |

Without `--json`, lists use aligned tables in a terminal and tab-separated rows when piped. `-q` is command-specific: on lists it selects IDs; during a watch it suppresses progress.

Runtime and API errors print an error object under `--json`, plus a human message on stderr. Usage errors print only to stderr. A partially completed `job stop` can print its partial result before an error.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command succeeded. An accepted asynchronous request may still be running. |
| `1` | Runtime/API failure, watched job cancelled or failed, or an analysis/task-check execution failed. |
| `2` | Invalid command usage or launch quota refusal. |

A completed job can contain failed trials. A check criterion marked `fail` is a quality finding; an errored checker is an execution failure. `check show` also returns `1` when a task checker failed.

For API error codes, see [Errors](/sdk-reference/errors).
