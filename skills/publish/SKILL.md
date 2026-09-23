---
name: publish
description: Publish Harbor-format task datasets or upload existing results to Evolve, including recorded Evolve SDK runs packaged as jobs. Use when the user wants to publish a benchmark, upload tasks, or turn an SDK session into an evaluation job.
metadata:
  internal: true
---

# Publish to Evolve

Publish tasks for future evaluations, or import results from a run that already happened. Both workflows use Evolve.

| What the user has | Start here |
| --- | --- |
| A folder or repository of tasks | Publish a dataset below. For the task layout, read `evolve skills get create-task`. |
| A completed job folder or archive | Import results below. |
| A recorded Evolve SDK session | Read `evolve skills get evals core-concepts/upload-sdk-session` before packaging it. |

## Setup, when needed

Use the installed CLI; install only if missing: `npm install -g @evolvingmachines/evolve`. Confirm authentication with `evolve auth status`. If needed, set `EVOLVE_API_KEY` using a key from https://dashboard.evolvingmachines.ai/api-keys.

Publishing or importing is a remote mutation. Proceed when the user's request authorizes it; otherwise prepare the exact command and explain what it uploads. An upload request does not authorize emailing or sharing results. For explicit sharing requests, read `evolve skills get evals core-concepts/sharing`.

## Publish a dataset

### 1. Check the tasks

Inspect the task directories and any `dataset.toml`, then validate their metadata:

```bash
evolve dataset check ./tasks
```

This sends each `task.toml` and the optional manifest to Evolve. It does not publish the corpus or run the tasks. Fix refused fields before continuing.

For an agent-based quality review, use `evolve check ./tasks --watch`. This uploads tasks and incurs agent usage. Read the findings and trace: Evolve derives no verdict from the result, and `unknown` on the five execution criteria is not proof that the reference solution and verifier were executed successfully. See `evolve skills get evals core-concepts/check`.

### 2. Choose one source and publish

**Local directory**

```bash
evolve dataset publish \
  --dir ./tasks \
  --name my-benchmark \
  --version 1.0 \
  --watch
```

A `dataset.toml` can supply the name and version. Local publishing runs metadata preflight automatically; `--skip-preflight` skips that early check, not import validation.

**Git repository**

```bash
evolve dataset publish \
  --git https://github.com/acme/tasks.git \
  --ref v1.0.0 \
  --path benchmark \
  --name my-benchmark \
  --version 1.0 \
  --watch
```

Pin a tag or a full 40-character commit SHA. Branch names are refused. Omit `--path` to use the repository root.

**Public HTTPS archive**

```bash
evolve dataset publish \
  --from https://example.com/tasks.tar.gz \
  --name my-benchmark \
  --version 1.0 \
  --watch
```

Evolve fetches the archive. Both Git and HTTPS sources require an explicit name and version.

**Optional: import a public Harbor Hub package into Evolve**

```bash
evolve dataset publish \
  --from hub:cookbook/hello-world \
  --watch
```

`hub:org/name[@ref]` is an accepted source; the destination is Evolve. Name and version may come from the package. Keep this syntax when importing an actual Harbor package.

For a new dataset, add `--org <organization>` to select an organization. Otherwise, Evolve uses the saved `evolve auth org use` default, then your personal organization. An existing dataset keeps its organization; an explicit or saved default that conflicts is refused. See `evolve skills get evals cli-reference/dataset` for all options.

### 3. Follow the import and inspect the result

`--watch` follows the import and build. To reconnect, use the complete import ID printed by publishing:

```bash
evolve dataset watch "$IMPORT_ID"
evolve dataset show my-benchmark@1.0
```

`evolve dataset watch my-benchmark` also finds a live import. Use the import ID after it has settled.

A `READY` version needs at least one built task, but can contain failed tasks. Report the final state, name, version, built and failed counts, and failure reasons. A new ready version on your own dataset becomes active; a bare dataset name selects that active version.

### 4. Run or manage the version

When the user wants an evaluation, select the harness and model, then run the pinned version:

```bash
evolve run \
  --dataset my-benchmark@1.0 \
  --agent codex \
  --model "<model>" \
  --watch
```

Replace `<model>` with the selected model. Read `evolve skills get evals cli-reference/run` for job settings.

| Need | Command |
| --- | --- |
| Point the bare name at another `READY` version | `evolve dataset activate my-benchmark 1.0` |
| Download the original corpus package as its owner | `evolve dataset download my-benchmark@1.0 -o corpora/` |
| Fix tasks after a partial build | Publish the corrected corpus under a new version. |

## Import results

### 1. Prepare the job folder

An existing Harbor-format job folder can be uploaded directly. Before packaging another runner's files, read `evolve skills get evals core-concepts/upload` for the required layout and fields. The root needs `config.json` and `result.json`; each trial has its own `result.json`.

For an SDK session, read `evolve skills get evals core-concepts/upload-sdk-session` first. It shows the local log location, field mapping, and packaging script. A session can contain several runs or commands; do not assume one file is one trial. The example script supports one successful Codex or Claude run; the guide covers other cases.

Preserve recorded rewards in each trial's `verifier_result.rewards`. Without recorded rewards, the import has no score. Do not infer a score from agent completion.

### 2. Upload and follow

```bash
evolve upload ./completed-job -d my-benchmark@1.0
```

Use the job directory or its `.tar.gz`. Alternatively, use `evolve upload --from <public-https-archive-url>`. Omit `-d` if no published dataset should be linked; when supplied, it links trial tasks by name.

The CLI waits for the import by default. `--no-wait` returns the import record instead. Reconnect with:

```bash
evolve job imports --status RUNNING
evolve job import "$IMPORT_ID" --watch
```

### 3. Inspect the imported job

Use the job ID from the completed import:

```bash
evolve job show "$JOB_ID"
evolve job trials "$JOB_ID"
```

Choose a trial ID from the listing, then read its transcript with `evolve trial trace "$TRIAL_ID"`. Check the task, harness, model, prompt, agent activity, and recorded scores. Report skipped trial folders and missing task links.

Imported jobs support analysis, but cannot be resumed, retried, or regraded. Read `evolve skills get evals cli-reference/upload` for all upload options.

## Use Python or TypeScript instead

Read `evolve skills get evals sdk-reference/index` for client setup, then the matching method reference:

| Operation | Read |
| --- | --- |
| Validate, publish, follow, activate, or download datasets | `evolve skills get evals sdk-reference/methods/datasets` |
| Upload a job and follow its import | `evolve skills get evals sdk-reference/methods/jobs` |

Both SDKs expose `datasets().preflight()` and `datasets().publish()`, plus `jobs().upload()`. Call preflight separately when publishing through an SDK. Publishing and uploading return import records; follow with `watchImport` in TypeScript or `watch_import` in Python. These calls do not convert SDK session logs into job folders; package the session first.
