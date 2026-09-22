---
title: "evolve upload"
description: "Import completed evaluations into Evolve from a Harbor-format job folder."
---

Upload results from another machine or runner. Evolve imports their trials, rewards, and traces as a completed job.

```bash
evolve upload ./completed-job -d harbor-examples@1.0
```

The source must use the [supported job layout](/core-concepts/upload). A local directory needs `config.json` and `result.json` at its root.

For an SDK session log, use the [packaging walkthrough](/core-concepts/upload-sdk-session) first.

## Choose a source

### Directory

```bash
evolve upload ./completed-job
```

### Archive

```bash
evolve upload ./completed-job.tar.gz
```

### Public URL

```bash
evolve upload --from https://example.com/completed-job.tar.gz
```

Use one source per invocation. `--from` requires a public HTTPS URL.

## Options

| Option | Meaning |
| --- | --- |
| `-d`, `--dataset <name[@version]>` | Link imported trial tasks to a published dataset version by task name. |
| `--from <url>` | Have Evolve fetch a public job archive. Replaces the local path. |
| `--no-wait` | Return the import record without waiting for the completed job. |

Dataset linking makes the stored task available to later analysis. Review the report for unlinked tasks and skipped trial folders.

## Follow an import

By default, `upload` waits for the imported job. Use `--no-wait` when you want to reconnect later.

```bash
evolve upload ./completed-job --no-wait
evolve job imports --status RUNNING
evolve job import "$IMPORT_ID" --watch
```

Copy the complete import ID printed by `upload` into `$IMPORT_ID`.

With `--json`, the default command prints one final job document. With `--no-wait --json`, it prints the import record instead.

## Inspect the result

```bash
evolve job show "$JOB_ID"
evolve job trials "$JOB_ID"
evolve analyze "$JOB_ID" --watch
```

`$JOB_ID` is the ID of the imported job. Uploaded costs are reported by the source archive, not metered execution on Evolve. Uploaded jobs can be analyzed, but cannot be resumed, retried, or regraded.

[Global options](/cli-reference/index#global-options) apply.
