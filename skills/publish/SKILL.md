---
name: publish
description: Publish a dataset of Harbor-format tasks to Evolve, or upload a finished job folder — a Harbor job, or Evolve SDK runs packed as one. Use when the user wants to publish, upload, or share tasks, datasets/benchmarks, or job results on Evolve.
metadata:
  internal: true
---

Help the user publish a dataset of tasks to Evolve, or upload a job they ran elsewhere.
Walk them through each step, checking prerequisites and confirming before running
commands that upload.

## Prerequisites

1. **The CLI**: `npm install -g @evolvingmachines/evolve`; `evolve --version` succeeds.

2. **API key**: create a key on the dashboard's API keys page
   (https://dashboard.evolvingmachines.ai/api-keys) and export it. Every command reads
   `EVOLVE_API_KEY`.
   ```bash
   export EVOLVE_API_KEY="<your key>"
   evolve auth status
   ```
   `auth status` prints who the platform thinks you are and which key is in use.

3. **Task layout**: a dataset is a folder of task directories, each with `task.toml`,
   `instruction.md`, `tests/test.sh`, and an `environment/` folder unless `task.toml`
   names a prebuilt `docker_image` (`evolve skills get create-task` has the format). The
   directory name is the task's name: letters, digits, `.`, `_` and `-`, at most 128
   characters, starting with a letter or digit; use lowercase (Harbor's convention). A
   `dataset.toml` manifest at the root is optional.

## Publishing a dataset

What you publish is private to your organization. There are no tags and no visibility
flag.

### 1. Check the folder first

```bash
evolve dataset check "<path/to/tasks>"
```

A dry run: the pre-flight sends each task's `task.toml`, and the `dataset.toml` if there
is one, to the server, which answers with a verdict per task and writes nothing. A refused
task names the field to fix. `evolve check "<path/to/tasks>" --watch` goes further: it
reads each task and, when it can, runs its environment, reference solution and verifier,
then rules on a rubric.

### 2. Publish

From a local directory:

```bash
evolve dataset publish \
  --dir "<path/to/tasks>" \
  --name "<dataset>" \
  --version 1.0 \
  --watch
```

When the folder carries a `dataset.toml` manifest, `--name` and `--version` come from it
and may be omitted. The pre-flight runs automatically before the upload;
`--skip-preflight` uploads without it, and a task the check would have refused then fails
at import instead.

From a git repository:

```bash
evolve dataset publish \
  --git https://github.com/acme/my-swe.git \
  --ref v1.0.0 \
  --name "<dataset>" \
  --version 1.0 \
  --watch
```

`--ref` must be pinned: a tag, or a full 40-character commit sha. A branch name is
refused. `--path <subfolder>` imports one folder of a larger repository.

From a source the server fetches itself:

```bash
evolve dataset publish --from hub:cookbook/hello-world --watch
```

`--from` takes a public https tarball URL, or `hub:org/name[@ref]` for a public package on
the Harbor hub. For a hub package the name and version default to the package's own.

### 3. Follow the publish

`--watch` follows the publish until the version is `READY` or `FAILED`. Each task builds
on its own, so one broken task does not block the others; `--watch` ends with how many
built. If the terminal is gone, re-attach from any machine:

```bash
evolve dataset watch "<dataset>"
```

The version lands `READY` when at least one task built, and `FAILED` only when none did.
On your own dataset, `READY` also makes the version active, so the bare name runs it.

## After publishing

```bash
evolve dataset show "<dataset>@1.0"                       # versions, tasks, timeouts, providers per task
evolve run -d "<dataset>@1.0" -a codex -m gpt-5.5 --watch   # run a job on it
```

Each publish creates a version, named `<dataset>@<version>`; a bare name means the active
version. To point the bare name at a different `READY` version:

```bash
evolve dataset activate "<dataset>" 1.0
```

The owner of a dataset can download the original package back:

```bash
evolve dataset download "<dataset>@1.0" -o corpora/
```

## Uploading a job you ran elsewhere

A job run elsewhere, in the Harbor job layout, uploads as a finished job. Its trials,
traces and rewards become a job you read like any other. Before packing a folder by
hand — runs made with the Evolve SDK, or any other runner — read what a trial folder
and its `result.json` must hold: `evolve skills get evals core-concepts/upload`. The
score lives in `result.json` as `verifier_result.rewards`; without it a trial arrives
with no score.

```bash
evolve upload "<path/to/job-dir>" -d "<dataset>@1.0"
```

`upload` takes the job directory, or its `.tar.gz`. With `--from <url>` it takes instead
a public https URL of the archive, which the server fetches itself. `-d name[@version]`
links the uploaded trials to a published dataset version by task name. The command
follows the import until the job exists; `--no-wait` returns at once with the import id.

```bash
evolve job imports --status RUNNING
evolve job import <import-id> --watch
```

`job imports` lists your uploads, newest first. `job import --watch` re-attaches to one and
follows it to the job, or to its typed failure.
