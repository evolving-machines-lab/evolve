---
name: publish
description: Publish Harbor-format task datasets or upload existing results to Evolve, including recorded Evolve SDK runs packaged as jobs. Use when the user wants to publish a benchmark, upload tasks, or turn an SDK session into an evaluation job.
metadata:
  internal: true
---

# Publish to Evolve

Choose the workflow from what the user has. Read its canonical page before constructing a command.

| Input | Workflow | Read |
| --- | --- | --- |
| Tasks to evaluate | Publish a dataset version. | `evolve skills get evals cli-reference/dataset` |
| Completed trials and results | Import a job. | `evolve skills get evals cli-reference/upload` |
| A recorded Evolve SDK run | Find the session log, package the run, and upload it. | `evolve skills get evals core-concepts/upload-sdk-session` |
| Another runner's files | Check the required job layout before packing them. | `evolve skills get evals core-concepts/upload` |

## Publish tasks

1. Inspect the task folder and any `dataset.toml`. Use `evolve skills get create-task` for task authoring.
2. Run `evolve dataset check <directory>` for metadata validation. This contacts Evolve but does not publish the corpus or execute the tasks.
3. Publish the selected source using the canonical dataset page. Follow the import with `--watch`.
4. Report the dataset name, version, final state, and any failed tasks. A `READY` version can include failed tasks; do not describe it as fully built without checking.

## Import results

1. Identify the source. Upload an existing job folder directly. For an SDK session, read `evolve skills get evals core-concepts/upload-sdk-session` first; the guide includes the local log path, field mapping, and packaging script.
2. Check the source against the upload layout. Preserve recorded rewards; do not invent missing scores. A session can contain several runs or commands, so do not assume the whole file is one trial.
3. Choose a published dataset reference when task linking is wanted.
4. Run `evolve upload` with the authorized source. It follows the import by default; use `job import <id> --watch` to reconnect.
5. Inspect the imported trial's prompt, agent activity, and recorded scores. Report the job ID, skipped trial folders, and missing task links.

Publishing or importing is a remote mutation. Proceed when the user's request authorizes it; otherwise prepare the exact command and explain what it will upload. Never infer authorization to email or share results from an upload request. For explicit sharing requests, read `evolve skills get evals core-concepts/sharing`.
