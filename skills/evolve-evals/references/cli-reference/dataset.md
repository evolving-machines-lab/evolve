---
title: "evolve dataset"
description: "Find tasks, validate a corpus, and publish a version for evaluation."
---

A dataset version is a named collection of tasks. Jobs select `name@version`, or the active version when only the name is given.

```bash
evolve dataset list --search harbor-examples
evolve dataset show harbor-examples@1.0
```

## Browse the catalog

| Command | Options |
| --- | --- |
| `dataset list` | `--search <text>` matches names and descriptions; all shared [list options](/cli-reference/index#list-options). |
| `dataset show <name[@version]>` | `-l, --limit <n>` and `--cursor <cursor>` page the task list. |

The detail view includes versions, tasks, build failures, and provider information.

## Check before publishing

```bash
evolve dataset check ./tasks
```

This reads local task metadata and sends it to Evolve for validation. It does not publish the corpus or run the tasks.

For an agent-based quality check, use [`evolve check`](/cli-reference/check).

## Publish a version

Choose one source.

### Local directory

```bash
evolve dataset publish \
  --dir ./tasks \
  --name my-benchmark \
  --version 1.0 \
  --watch
```

A `dataset.toml` manifest can supply the name and version. Local publishing runs metadata preflight before uploading.

### Git repository

```bash
evolve dataset publish \
  --git https://github.com/acme/tasks.git \
  --ref v1.0.0 \
  --path benchmark \
  --name my-benchmark \
  --version 1.0 \
  --watch
```

Pin a tag or full commit SHA. Branch names are refused. Omit `--path` to use the repository root.

### Public archive

```bash
evolve dataset publish \
  --from https://example.com/tasks.tar.gz \
  --name my-benchmark \
  --version 1.0 \
  --watch
```

Evolve fetches the HTTPS archive. Supply both name and version.

### Harbor package

```bash
evolve dataset publish --from hub:cookbook/hello-world --watch
```

Import a public Harbor Hub package using `hub:org/name[@ref]`. Name and version may come from the package.

### Publish options

| Option | Meaning |
| --- | --- |
| `--dir <path>` | Local corpus directory. |
| `--git <url>` | Git repository URL. Requires `--ref`. |
| `--ref <tag\|sha>` | Pinned Git revision. |
| `--path <subfolder>` | Corpus folder within the Git repository. |
| `--from <source>` | Public HTTPS tarball or `hub:org/name[@ref]`. |
| `--name <name>` | Dataset name. Required for Git and HTTPS sources. |
| `--version <version>` | Version label. Required for Git and HTTPS sources. |
| `--org <name>` | Organization for a new dataset; otherwise the saved CLI default, then personal. |
| `--skip-preflight` | Skip metadata preflight for a local directory. |
| `--watch` | Follow the import and version build to completion. |

Do not combine source types. `--skip-preflight` skips the early check; it does not remove import validation.

## Follow the build

```text
1. Upload or fetch the corpus
                 ↓
2. Validate tasks and build environments
                 ↓
3. Settle the version
   ├── At least one task built → READY
   └── No task built          → FAILED
```

A `READY` version can contain failed tasks. The final report shows how many built and which failed. On your own dataset, the new ready version becomes active.

To reconnect while an import is running:

```bash
evolve dataset watch my-benchmark
```

To inspect a specific import, including one that has already settled, use its full ID:

```bash
evolve dataset watch "$IMPORT_ID"
```

`$IMPORT_ID` is printed during publishing. Watching by dataset name selects a live import; when none exists, the command returns `nothing_to_watch`.

With `--json`, watching prints progress records followed by `import.final`.

## Change the active version

```bash
evolve dataset activate my-benchmark 1.0
```

The chosen version must be `READY`. This changes what a bare `my-benchmark` selects; version-pinned jobs still use their selected version.

## Download the corpus

```bash
evolve dataset download my-benchmark@1.0 -o corpora/
```

`-o, --output-dir <dir>` sets the destination; the default is the current directory. This downloads the original stored corpus package. Access is limited to the dataset owner.

## Read one task's files

```bash
evolve dataset files list harbor-examples@1.0 hello-world /
evolve dataset files cat harbor-examples@1.0 hello-world /instruction.md
```

Use [`dataset files status/list/cat`](/cli-reference/filesystem#published-task-files) for package metadata, folder pagination, and byte ranges. These commands require an explicit dataset version.

[Global options](/cli-reference/index#global-options) apply. Next, [run a job](/cli-reference/run) against the published version.
