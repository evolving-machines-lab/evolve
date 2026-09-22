---
title: "evolve job"
description: "Inspect results, compare runs, and control or repeat evaluations."
---

Start with the job ID printed by `evolve run`, or find it in the list. Examples below use `$JOB_ID` for that ID.

```bash
evolve job list
evolve job show "$JOB_ID"
evolve job trials "$JOB_ID"
```

## Inspect results

### Jobs

```bash
evolve job list --search hello
evolve job list --kind all --scope org
evolve job show "$JOB_ID" --json
```

| Option for `job list` | Meaning |
| --- | --- |
| `--search <text>` | Match job names and dataset names. |
| `--kind <job\|check\|all>` | Evaluations, task checks, or both. Default `job`. |
| `--scope <my\|shared\|org>` | Which records to list. Default `my`. |

`job show` accepts one or more IDs. With `--json`, one ID returns an object; several return an array.

### Trials

```bash
evolve job trials "$JOB_ID" --status INFRASTRUCTURE_ERROR,SCORING_ERROR
evolve job trials "$JOB_ID" --dataset harbor-examples
```

| Option for `job trials` | Meaning |
| --- | --- |
| `--status <statuses>` | Comma-separated trial statuses. |
| `--dataset <name>` | Select one dataset in the job. |

Statuses: `QUEUED`, `RUNNING`, `SCORING`, `SCORED`, `SCORING_ERROR`, `INFRASTRUCTURE_ERROR`, `BUDGET`, `INDETERMINATE`, `CANCELLED`.

Open an individual result with [`evolve trial show`](/cli-reference/trial).

### Tasks

```bash
evolve job tasks "$JOB_ID"
```

One row per task: trial count, statuses, reward, spend, and available task-check information.

`job list`, `job trials`, and `job tasks` accept the shared [paging and formatting options](/cli-reference/index#list-options): `--limit`, `--cursor`, `--columns`, `--quiet`, `--no-trunc`, and `--no-headers`.

A `COMPLETED` job can include failed trials. Inspect the trial statuses as well as the aggregate score.

## Compare jobs

Supply two to ten job IDs.

```bash
evolve job compare "$JOB_ID" "$OTHER_JOB_ID"
```

## Search traces

Search across the job's trial traces. `$JOB_ID` comes from `job list` or `run`.

```bash
evolve job grep "$JOB_ID" 'permission denied'
evolve job grep "$JOB_ID" 'permission denied' --type tool_call --json
```

| Option | Meaning |
| --- | --- |
| `--type <event-type>` | Match only this exact event type. |
| `-l`, `--limit <n>` | Trial match groups per page. Default `50`, maximum `200`. |
| `--cursor <cursor>` | Continue from the returned `nextCursor`. |

## Stop work

### Whole job

```bash
evolve job cancel "$JOB_ID"
```

Request cancellation. The returned job may still be winding down.

### One dataset

```bash
evolve job stop "$JOB_ID" --dataset harbor-examples
```

Stop that dataset's trials while keeping the rest of the job. `--dataset <name>` is required.

Output separates stopped trials, already-terminal trials, and missing IDs. If a batch fails, the partial report names how many outcomes remain unreported.

For individual trials, use [`trial stop`](/cli-reference/trial#stop-a-trial).

## Run again

Each command creates a new linked job. It leaves the source results intact.

| Command | Work repeated |
| --- | --- |
| `evolve job resume "$JOB_ID"` | Failed or stopped trials selected by the resume policy. |
| `evolve job retry "$JOB_ID"` | All trials of a settled source job. |
| `evolve job retry "$JOB_ID" --failed-only` | Trials in `SCORING_ERROR`, `INFRASTRUCTURE_ERROR`, `BUDGET`, or `INDETERMINATE`. |
| `evolve job retry "$JOB_ID" --trial "$TRIAL_ID"` | Exactly the selected settled trial. Repeat `--trial` for more. |
| `evolve job regrade "$JOB_ID"` | The recorded verifier, using stored inputs. No replacement verifier. |

### Selection options and requirements

**Resume** accepts `-f, --filter-error-type <type>`. Repeat it to select exception types.

**Retry** accepts either `--failed-only` or `-t, --trial <id>`, not both. Copy full trial IDs from `evolve job trials "$JOB_ID"`; these flags do not expand prefixes. Explicit settled trials can be retried while other trials in the source job are still running.

**Regrade** accepts `--status <s1,s2,...>` and `--task <name>`. It requires eligible stored verifier inputs; shared-verifier, multi-step, and judge-backed trials cannot be regraded through this command. See [Trials](/core-concepts/trials).

Uploaded jobs cannot be resumed, retried, or regraded. Their original execution ran outside Evolve.

Start a new evaluation with `evolve job start` or its shorter form, [`evolve run`](/cli-reference/run).

## Download results

```bash
evolve job download "$JOB_ID" -o results/
```

```text
results/
└── job-<id>/
    ├── config.json
    ├── result.json
    ├── evolve.json          Evolve's record
    └── <trial folders>/
```

| Option | Meaning |
| --- | --- |
| `-o`, `--output-dir <dir>` | Parent directory. Default: current directory. |
| `--overwrite` | Allow replacing an existing job folder. |

The download uses the Harbor job layout, with additional `evolve.json` records.

## Share results

Only the creator can manage a job's shares.

```bash Create access
evolve job share "$JOB_ID" --link
evolve job share "$JOB_ID" --email colleague@example.com
```

```bash Inspect or remove access
evolve job shares "$JOB_ID"
evolve job unshare "$JOB_ID" --link
evolve job unshare "$JOB_ID" --email colleague@example.com
```

Both `share` and `unshare` require `--link`, repeatable `--email <address>`, or both. Email sharing sends the recipient a link. Revoking a link disables it; enabling sharing later creates a new link.

See [Sharing](/core-concepts/sharing) for access rules.

## Read an upload's progress

[`evolve upload`](/cli-reference/upload) prints an import ID before the imported job is ready.

```bash
evolve job imports --status RUNNING
evolve job import "$IMPORT_ID" --watch
```

| Command | Options |
| --- | --- |
| `job imports` | Shared list options; `--status <QUEUED\|RUNNING\|COMPLETED\|FAILED>`. |
| `job import <id>` | `--watch` to follow it to a job or failure. Use the full import ID. |

`job import --watch --json` prints one final job or error document.

## Delete a job

```bash
evolve job delete "$JOB_ID"
```

The command asks before permanent deletion. For noninteractive use, pass `-y` or `--yes`.

**Warning:**

Deleting a job removes its stored trials, traces, analyses, and files. Only the creator can delete it, and the job must be eligible for deletion.

[Global options](/cli-reference/index#global-options) apply to every command.
