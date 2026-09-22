---
title: "Datasets"
description: "Find a task set, inspect its versions, and check where its tasks can run."
---

The **Datasets** page shows the catalog available in your workspace. Filter **All**, **Public**, or **Private**, then open a dataset.

![Public datasets with task counts, versions, build status, and update times.](/images/dashboard-datasets.png)

*The public catalog. Open a dataset to inspect its tasks and versions.*

```text
Dataset
├── Active version
├── Tasks
└── Versions
```

- **Active version:** Used when a job omits a version.

- **Tasks:** What the selected version contains.

- **Versions:** Earlier and current published versions.

## Inspect tasks

The Tasks tab shows the selected version's tasks and their requirements:

| Column | Read it for |
| --- | --- |
| Task name | The key used by include/exclude filters. |
| GPUs | Whether the task needs GPU resources. |
| Timeouts | Agent and verifier time budgets. |
| Skills | Task-declared skills. |
| Providers | Compatibility and any fallback target. |

A provider arrow names the fallback target. Hover a refusal to read its reason. These compatibility summaries are advisory; job creation and dispatch validate the actual requirements.

## Choose a version

Open **Versions** to inspect provenance and task counts. Click a version to browse its tasks.

**Activate** changes which version a bare dataset name resolves to. An explicit reference such as `my-dataset@1.0` remains pinned to that version.

**Note:**

A ready version can contain failed task builds. Inspect the task/build details before assuming every task is runnable.

## Publish or manage

Publishing starts from the CLI or SDK:

```bash
evolve dataset publish --dir ./tasks --name my-dataset --version 1.0 --watch
```

The dashboard exposes activation and deletion where your permissions allow them. Deleting a dataset removes its versions and task records; use the confirmation details before proceeding.

**[Dataset lifecycle](/core-concepts/datasets)**

Publishing, builds, versions, and activation.

**[Task format](/core-concepts/tasks)**

The files inside each task.
