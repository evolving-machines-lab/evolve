---
title: "Datasets: methods"
description: "Every dataset call, option, and returned field."
---

Create the client with `datasets()` or use `hosted().datasets`. For a guided example, see [datasets](/sdk-reference/datasets). Examples use a configured `client` from `datasets()`. Python examples run inside an async function.

| Group | Methods |
| --- | --- |
| [Browse](#list) | `list`, `get`, `getActive`, `getTaskBuild`, `taskFiles` |
| [Publish](#preflight) | `preflight`, `publish`, `getImport`, `watchImport`, `listImports` |
| [Manage](#download) | `download`, `update`, `activate`, `delete` |

## list

Read one catalog page, or iterate the whole catalog.

```ts TypeScript
const page = await client.list({
  search: "harbor-examples",
  limit: 20,
});
```

```python Python
page = await client.list(
    search="harbor-examples",
    limit=20,
)
```

**Returns:** `DatasetPage` when awaited; a `Dataset` per iteration. See [dataset fields](#dataset-fields).

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `search?` | String; filters name and description. |
| `limit?` | Integer; collection page size. Default 50, maximum 200. |
| `cursor?` | String from the previous page. Omit for the first page. |

TypeScript returns `DatasetList`; Python returns an awaitable, asynchronously iterable handle. `for await` / `async for` follows subsequent pages. Page fields are `items`, `nextCursor`, `hasMore` in TypeScript; `items`, `next_cursor`, `has_more` in Python.

## get

Read all versions and one page of a selected version’s tasks.

```ts TypeScript
const dataset = await client.get("harbor-examples@1.0", {
  limit: 50,
});
```

```python Python
dataset = await client.get(
    "harbor-examples@1.0",
    limit=50,
)
```

**Returns:** `Dataset`, including `versions`, `selected_version`, `tasks`, and `failed_tasks`.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `ref` | Required string: `name` selects the active version; `name@version` selects one version. |
| `limit?`, `cursor?` | Page the tasks. Default 200 tasks, maximum 500. Pass the prior task page’s cursor. |

## getActive / get_active

Resolve a bare dataset name to its active version.

```ts TypeScript
const dataset = await client.getActive("harbor-examples");
console.log(dataset.version, dataset.tasks.items);
```

```python Python
dataset = await client.get_active("harbor-examples")
print(dataset.version, dataset.tasks.items)
```

**Returns:** `ActiveDataset`; `version`, `active_version`, and `tasks` are present.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `name` | Required string; use a bare dataset name. |
| `limit?`, `cursor?` | Task pagination, as for `get`. TypeScript passes an options object; Python uses keywords. |

Raises `NoActiveVersionError` when no version is active. Use `get` if you need to inspect a dataset before it has an active version.

## getTaskBuild / get_task_build

Read one task’s settled build result.

```ts TypeScript
const build = await client.getTaskBuild(
  "my-benchmark@1.0",
  "hello-world",
);
console.log(build.state, build.failure);
```

```python Python
build = await client.get_task_build(
    "my-benchmark@1.0",
    "hello-world",
)
print(build.state, build.failure)
```

**Returns:** `TaskBuild`: `task_name`, `state`, `failure`, and `build_log_ref`.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `ref` | Required string, pinned as `name@version`. |
| `taskName` / `task_name` | Required task name. |

`state` is `READY` or `FAILED`. Failure fields are `code`, `step`, `message`, and optional `excerpt`. `build_log_ref` is a stored log reference, or null. A missing task or an unsettled build returns `404 task_not_found`.

## taskFiles / task_files

Get a client for one task’s retained package files.

```ts TypeScript
const files = client.taskFiles(
  "my-benchmark@1.0",
  "hello-world",
);
const listing = await files.list();
```

```python Python
files = client.task_files("my-benchmark@1.0", "hello-world")
listing = await files.list()
```

**Returns:** [`TaskPackageFiles`](/sdk-reference/methods/filesystem). Creating this client makes no request.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `ref` | Required string, pinned as `name@version`. |
| `taskName` / `task_name` | Required task name. |

The file client exposes `status`, `list`, and `read`. See the filesystem reference for their parameters and response fields.

## preflight

Check a local corpus’s metadata before uploading its task files.

```ts TypeScript
const verdict = await client.preflight({
  source: { directory: "./tasks" },
});
```

```python Python
verdict = await client.preflight(directory="./tasks")
```

**Returns:** `DatasetPreflight`. Inspect `tasks_refused`, each task’s `reason`, and the checks listed in `deferred`.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| TypeScript `source.directory` | Required local directory path. No other source type is accepted. |
| Python `directory` | Required keyword argument for the same directory. |

Reads task TOML files and an optional dataset manifest. It does not build images or run verifiers. SDK `publish` does not call preflight automatically.

## publish

Submit a new immutable dataset version. Follow the returned import id with `watchImport` / `watch_import`.

```ts TypeScript
const pending = await client.publish({
  name: "my-benchmark",
  version: "1.0",
  source: { directory: "./tasks" },
});
```

```python Python
pending = await client.publish(
    name="my-benchmark",
    version="1.0",
    directory="./tasks",
)
```

**Returns:** `DatasetImport` after the source is accepted; image builds may still be running.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `source` (TypeScript) | Exactly one source object, shown below. Python passes those fields as keyword arguments. |
| `name?`, `version?` | Strings. Required for git and archive URLs. A local `dataset.toml` or Hub package can supply them. |
| `org?` | Organization slug or id. Overrides the client default. New datasets use your personal organization when neither is set. |

| Source | TypeScript `source` | Python keywords |
| --- | --- | --- |
| Local folder | `{ directory: "./tasks" }` | `directory="./tasks"` |
| Git | `{ git_url, git_ref, git_path? }` | `git_url=`, `git_ref=`, `git_path=` |
| Public HTTPS tarball | `{ archive_url }` | `archive_url=` |
| Public Harbor Hub package | `{ hub_package: "org/name@ref" }` | `hub_package="org/name@ref"` |

Git requires an HTTPS URL and a full 40-character commit SHA or tag. Branch names are refused with `unpinned_git_ref`. Optional `git_path` selects one relative repository directory. Point a local `directory` directly at the desired folder.

An existing dataset keeps its organization when both the call and client omit `org`. Supplying a different organization is refused; publishing another version does not move the dataset.

| Parameter | Type and meaning |
| --- | --- |
| `onUploadProgress` / `on_upload_progress` | Callback `(sentBytes, totalBytes)` / `(sent_bytes, total_bytes)` for local archive transfers. |
| `onRegistered` / `on_registered` | Callback `(importId)` / `(import_id)` when a large resumable upload pre-registers its import. |

In TypeScript, callbacks belong to the second `options` argument. Python accepts them as keywords and calls them from the uploader thread: keep them short and thread-safe. Registration callbacks require a resumable local upload with explicit name and version; they do not fire for every publish.

## getImport / get_import

Read a publish operation by its import id.

```ts TypeScript
const pending = await client.getImport(importId);
console.log(pending.status, pending.progress);
```

```python Python
pending = await client.get_import(import_id)
print(pending.status, pending.progress)
```

**Returns:** `DatasetImport`. See [import fields](#import-fields).

### Parameters and behavior

`id` is the required string returned by `publish`. Import status is `QUEUED`, `RUNNING`, `COMPLETED`, or `FAILED`. `receiving` distinguishes an upload still arriving from an import ready to be picked up.

## watchImport / watch_import

Wait for the import to finish and confirm the published version’s state.

```ts TypeScript
const result = await client.watchImport(importId, {
  onProgress: (progress) => console.log(progress.phase),
  pollIntervalMs: 2_000,
});
```

```python Python
result = await client.watch_import(
    import_id,
    on_progress=lambda progress, imported: print(progress.phase),
    poll_interval_s=2.0,
)
```

**Returns:** `DatasetImport`. A failed import is returned with `status: "FAILED"` and `failure`; inspect it before using the version.

### Parameters and behavior

| TypeScript options | Python keywords | Meaning |
| --- | --- | --- |
| `id` | `id` | Required import id. |
| `onStatus?` | `on_status?` | Callback `(import)`: first observation and observed status or `receiving` changes. |
| `onProgress?` | `on_progress?` | Callback `(progress, import)`: changed, non-null progress. |
| `onVersion?` | `on_version?` | Callback `(version, dataset)`: observed version-state changes while settling. |
| `pollIntervalMs?` | `poll_interval_s?` | Polling interval; 2000 milliseconds / 2 seconds by default. |
| `settleTimeoutMs?` | `settle_timeout_s?` | Bound on confirming the version after import completion; 30 minutes by default. |
| `signal?` | — | TypeScript `AbortSignal` to stop watching. |
| — | `timeout_s?` | Python overall time limit in seconds; omitted means no overall limit. |

The watch retries HTTP 429 and 503 after a delay. A version that does not settle in time raises `ImportSettleError` with code `settle_timeout`; Python’s overall limit raises `TimeoutError`. Timing out stops the wait, not the import. A `READY` version can contain failed tasks: read the dataset’s `failed_tasks`.

## listImports / list_imports

Find your previous publishes, newest first.

```ts TypeScript
const page = await client.listImports({
  dataset: "my-benchmark",
  status: "FAILED",
});
```

```python Python
page = await client.list_imports(
    dataset="my-benchmark",
    status="FAILED",
)
```

**Returns:** `DatasetImportPage` when awaited; a `DatasetImport` per iteration.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `status?` | `QUEUED`, `RUNNING`, `COMPLETED`, or `FAILED`. |
| `dataset?` | Dataset name string. |
| `limit?`, `cursor?` | Collection pagination: default 50, maximum 200. Filters are preserved while iterating. |

## download

Download the original corpus package for a dataset you own.

```ts TypeScript
const path = await client.download("my-benchmark@1.0", {
  to: "./downloads",
});
```

```python Python
path = await client.download(
    "my-benchmark@1.0",
    to="./downloads",
)
```

**Returns:** With `to`: a saved file path string. Without options: TypeScript `Buffer`, Python `bytes`.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `ref` | Required `name` or `name@version`. |
| `to?` | Destination directory, not a filename. |
| TypeScript `stream: true` | Returns `ReadableStream<Uint8Array>`. Python has no stream option; use `to` for a disk download. |

Buffered and disk downloads check the declared byte length and digest. A raw TypeScript stream leaves client-side verification to the caller. Only the owning account can download; platform-curated datasets are not downloadable. `package_not_retained` means an older version has no saved corpus package.

## update

Change whether a moving upstream git ref is imported automatically.

```ts TypeScript
const dataset = await client.update("my-benchmark", {
  upstream_auto_import: true,
});
```

```python Python
dataset = await client.update(
    "my-benchmark",
    upstream_auto_import=True,
)
```

**Returns:** `Dataset` summary fields. Call `get` for its task page and full version list.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `name` | Required dataset name string. |
| `upstream_auto_import` | Required boolean. The only writable dataset setting. |

Requires an owned dataset with a moving git ref. Otherwise the server returns `dataset_not_owned` or `upstream_not_watchable`.

## activate

Choose the ready version used by bare-name references.

```ts TypeScript
const dataset = await client.activate(
  "my-benchmark",
  "1.0",
);
```

```python Python
dataset = await client.activate("my-benchmark", "1.0")
```

**Returns:** `Dataset` detail with the selected active version.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `name` | Required dataset name. |
| `version` | Required existing version label. |

You must own the dataset. A version still building returns `version_not_ready`; `FAILED` and `ARCHIVED` versions return `version_not_activatable`. Publishing already activates the new ready version on owned datasets.

## delete

Delete an owned dataset, including its versions, tasks, and archived solutions.

```ts TypeScript
await client.delete("my-benchmark");
```

```python Python
await client.delete("my-benchmark")
```

**Returns:** No value (`void` / `None`).

### Parameters and behavior

`name` is required. A dataset referenced by any job returns `dataset_in_use`; `error.details.sample_job_ids` names blocking jobs and `job_count` gives their count when known. A platform-curated dataset returns `dataset_not_owned`.

## Dataset fields

The schemas below list TypeScript fields. Python uses the same field names as dataclass attributes, except page cursors are `next_cursor` and `has_more`. Optional TypeScript fields can be absent; Python normally represents missing optional values as `None`.

### Dataset and active-version result

`list` returns summary fields. `get` adds the selected task page, version list, failed tasks, and timestamps. `active_version` is the current default; `latest_version` is the newest version even when it is not active. Python’s `ActiveDataset` timestamps may be `None`.

`DatasetVersionState` is `DRAFT`, `RECEIVING`, `IMPORTING`, `BUILDING`, `READY`, `FAILED`, or `ARCHIVED`. `task_count` counts ready tasks; `n_failed_tasks` counts failed builds. `Page<T>` has `items: T[]`, `nextCursor: string | null`, and `hasMore: boolean`.

`failed_tasks` is a sample of at most 500 failed tasks, sorted by task name. It has no cursor and does not use the requested task-page limit. `n_failed_tasks` gives the full count; use `getTaskBuild` / `get_task_build` to inspect a particular task.

```ts Fields
interface Dataset {
  name: string;
  title: string | null;
  description: string | null;
  active_version: DatasetVersion | null;
  latest_version: DatasetVersion | null;
  versions?: DatasetVersion[];
  selected_version?: DatasetVersion | null;
  tasks?: Page<Task>;
  failed_tasks?: DatasetFailedTask[];
  upstream: UpstreamStatus | null;
  created_at?: string;
  updated_at?: string;
}

interface ActiveDataset {
  name: string;
  title: string | null;
  description: string | null;
  active_version: DatasetVersion;
  version: string;
  tasks: Page<Task>;
  versions: DatasetVersion[];
  created_at: string;
  updated_at: string;
}

interface DatasetVersion {
  version: string;
  state: DatasetVersionState;
  created_at: string;
  task_count: number;
  n_failed_tasks: number;
  manifest: DatasetManifestMetadata | null;
  source: DatasetVersionSource | null;
}
```

### Tasks and build failures

`providers` is keyed by `e2b`, `daytona`, and `modal`. A successful provider verdict can still declare a fallback in `degrades_to`. Notes are non-fatal. Python defaults missing `gpus` to `0` and `notes` to an empty list.

```ts Fields
interface Task {
  task_name: string;
  agent_timeout_sec: number;
  verifier_timeout_sec: number;
  gpus?: number;
  gpu_types?: string[] | null;
  providers: Record<EvalSandboxProvider, TaskProviderVerdict>;
  notes: TaskNote[];
}

type TaskProviderVerdict =
  | { ok: true; degrades_to?: "modal"; reason?: string }
  | { ok: false; reason: string };

interface TaskNote {
  code: "tests_dockerfile_not_built";
  message: string;
}

interface DatasetFailedTask {
  task_name: string;
  failure: TaskBuildFailure;
}

interface TaskBuild {
  task_name: string;
  state: TaskBuildState;
  failure: TaskBuildFailure | null;
  build_log_ref: string | null;
}

interface TaskBuildFailure {
  code: string;
  step: string;
  message: string;
  excerpt?: string | null;
}
```

### Manifest and source provenance

`manifest` preserves dataset metadata. `source.kind` chooses the source variant; git URLs are returned without embedded credentials. A null source means no recorded provenance.

```ts Fields
interface DatasetManifestAuthor {
  name: string;
  email: string | null;
}

interface DatasetManifestMetadata {
  name: string;
  version: string | null;
  description: string;
  authors: DatasetManifestAuthor[];
  keywords: string[];
  task_count: number | null;
}

interface DatasetVersionGitSource {
  kind: "git";
  git_url: string | null;
  ref: string;
  commit: string;
  path: string | null;
}

interface DatasetVersionArchiveSource {
  kind: "archive";
  digest: string;
}

interface DatasetVersionArchiveUrlSource {
  kind: "archive_url";
  archive_url: string;
  digest: string;
}

interface DatasetVersionHubSource {
  kind: "hub_package";
  hub_package: string;
  digest: string;
}

type DatasetVersionSource =
  | DatasetVersionGitSource
  | DatasetVersionArchiveSource
  | DatasetVersionArchiveUrlSource
  | DatasetVersionHubSource;
```

### Upstream git status

`moved` says whether the remote ref differs from the imported commit. `acked_commit` is the newest commit already imported into any local version. `behind_by` is reserved and currently null. Null or failed checks do not mean the source is up to date.

```ts Fields
interface UpstreamStatus {
  git_url?: string | null;
  ref: string;
  current_commit: string;
  path?: string | null;
  latest_commit: string | null;
  acked_commit?: string | null;
  moved: boolean;
  behind_by: number | null;
  checked_at: string | null;
  error: string | null;
  auto_import: boolean;
}
```

## Preflight fields

### DatasetPreflight and per-task verdicts

`checks` names checks performed. `deferred` names checks that need the full corpus, with `reads` describing their input. `task_key` is the task identity used during preflight. Provider verdicts and task notes use the shapes above.

```ts Fields
interface DatasetPreflight {
  importer_version: string;
  checks: string[];
  deferred: PreflightDeferredCheck[];
  manifest: PreflightManifestVerdict | null;
  tasks: PreflightTaskVerdict[];
  tasks_total: number;
  tasks_ok: number;
  tasks_refused: number;
}

interface PreflightTaskVerdict {
  name: string;
  ok: boolean;
  task_key: string;
  schema_version?: string;
  providers?: Record<EvalSandboxProvider, TaskProviderVerdict>;
  notes?: TaskNote[];
  reason?: string;
}

interface PreflightDeferredCheck {
  name: string;
  reads: string;
}

interface PreflightManifestVerdict {
  ok: boolean;
  name?: string;
  short_name?: string;
  version?: string | null;
  task_count?: number;
  reason?: string;
}
```

## Import fields

### DatasetImport, failures, and warnings

`failure` is null unless a failure was recorded. `task_count` appears when known. Python represents missing `task_count` and timestamps as `None`, and defaults missing `receiving` to `False`. `DatasetImportStatus` is `QUEUED`, `RUNNING`, `COMPLETED`, or `FAILED`.

```ts Fields
interface DatasetImport {
  id: string;
  status: DatasetImportStatus;
  receiving?: boolean;
  name: string;
  version: string;
  failure: DatasetImportFailure | null;
  warnings: ImportWarning[];
  progress: DatasetImportProgress | null;
  task_count?: number;
  created_at?: string;
  updated_at?: string;
}

interface DatasetImportFailure {
  code: string;
  message: string;
  failures?: { task_name: string; error: string }[];
}

interface ImportWarning {
  code:
    | "solutions_archiving_disabled"
    | "no_solutions_archived"
    | "partial_solutions_archived"
    | "tasks_failed_to_build"
    | "tests_dockerfile_not_built";
  message?: string;
}
```

### Progress and phase counters

`done` and `total` describe each phase’s units. `images` separates built, mirrored, and reused (`banked`) images. `codebuild` records copy-build usage. Python maps `images` to `ImportImageCounts` and `codebuild` to `ImportCodeBuildMeter` dataclasses with these same field names. Progress is recorded at phase boundaries and coarse intervals, not every second.

```ts Fields
type ImportPhase =
  | "extracting"
  | "parsing"
  | "building"
  | "copying"
  | "verifying";

interface ImportPhaseProgress {
  name: ImportPhase;
  started_at: string;
  completed_at?: string;
  done: number;
  total: number;
  banked?: number;
}

interface DatasetImportProgress {
  phase: ImportPhase;
  started_at: string;
  phases: ImportPhaseProgress[];
  images: { built: number; mirrored: number; banked: number };
  codebuild: { copy_builds: number; billed_minutes: number };
}
```
