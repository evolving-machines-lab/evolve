---
title: "Checks methods"
description: "Create task quality checks and read each checker’s result."
---

Create `client` with `checks()`. A **check id** identifies the group. Each `results[]` entry has a **task check id** identifying one checker run.

```text
Check: check.id
└── Task check: check.results[].id
    ├── Result and evidence
    ├── Transcript and logs
    └── Sandbox files
```

Python returns check and task-check records as dictionaries. Use `check["id"]` and `check["results"]`.

| Work | Methods |
| --- | --- |
| Create and follow | [create](#create), [get](#get), [list](#list), [defaults](#defaults), [watch](#watch) |
| Read one checker | [task](#task), [transcript](#transcript), [artifact](#artifact) — TypeScript only |
| Files and sharing | [download](#download), [taskFilesystem](#taskfilesystem), [share](#share), [unshare](#unshare), [shares](#shares) |

## create

Check a local task directory, a directory of tasks, or a published dataset. Returns the accepted `Check` immediately.

### Signature

```ts TypeScript signature
create(input: CreateCheckInput): Promise<Check>;
```

```python Python signature
async def create(
    directory: Optional[str] = None,
    *,
    dataset: Optional[str] = None,
    name: Optional[str] = None,
    agent: Optional[str] = None,
    model_name: Optional[str] = None,
    rubric: Optional[Rubric] = None,
    prompt: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    sandbox_provider: Optional[EvalSandboxProvider] = None,
    n_concurrent: Optional[int] = None,
    include_task_names: Optional[List[str]] = None,
    exclude_task_names: Optional[List[str]] = None,
    n_tasks: Optional[int] = None,
    on_upload_progress: Optional[Callable[[int, int], None]] = None,
) -> Check: ...
```

```ts TypeScript
const check = await client.create({
  source: {
    directory: "./tasks"
  },
  n_tasks: 2,
});
```

```python Python
check = await client.create(
    './tasks',
    n_tasks=2,
)
```

| Source | Inputs |
| --- | --- |
| Local directory | TypeScript: `source.directory`. Python: `directory` or the first positional argument. |
| Published version | TypeScript: `source.dataset`. Python: `dataset`. Use `name@version`. |

Supply exactly one source. A local source must be a directory, not an archive. `include_task_names` and `exclude_task_names` are glob lists; `n_tasks` caps the selected set after filtering. `n_concurrent` is bounded by organization capacity.

Optional `onUploadProgress(sent, total)` / `on_upload_progress(sent, total)` reports local transfer bytes. All omitted policy settings use [defaults](#defaults). The accepted check records the resolved policy. Follow with `watch(check.id)` / `watch(check["id"])`.

### Input fields

```ts
interface CheckConfigInput {
  name?: string;
  agent?: string;
  model_name?: string;
  rubric?: Rubric;
  prompt?: string;
  reasoning_effort?: string;
  sandbox_provider?: EvalSandboxProvider;
  n_concurrent?: number;
  include_task_names?: string[];
  exclude_task_names?: string[];
  n_tasks?: number;
}

interface CreateCheckInput extends CheckConfigInput {
  source: { directory: string } | { dataset: string };
  onUploadProgress?: (sentBytes: number, totalBytes: number) => void;
}
```

## get

Read a check at any status. Returns `Check`, including one task-check result per selected task.

### Signature

```ts TypeScript signature
get(checkId: string): Promise<Check>;
```

```python Python signature
async def get(check_id: str) -> Check: ...
```

```ts TypeScript
const check = await client.get(checkId);
```

```python Python
check = await client.get(check_id)
```

Use the group’s check id. See [all check fields](/sdk-reference/types#analysis-and-check-results).

## list

List visible checks, newest first. Returns a page or an iterable of `Check`.

### Signature

```ts TypeScript signature
list(options?: ListChecksOptions): CheckList;
```

```python Python signature
def list(
    *,
    scope: Optional[JobListScope] = None,
    status: Optional[List[CheckStatus]] = None,
    dataset: Optional[str] = None,
    limit: Optional[int] = None,
    cursor: Optional[str] = None,
) -> _PaginatedList: ...
```

```ts TypeScript
const page = await client.list({
  dataset: "my-tasks@1.0",
  status: ["completed"]
});
```

```python Python
page = await client.list(
    dataset='my-tasks@1.0',
    status=['completed'],
)
```

Optional `scope`: `my` (default), `shared`, or `org`; `status`: a list of `queued`, `running`, or `completed`; `dataset`: a bare name or pinned `name@version`. `limit` defaults to 50 (maximum 200); `cursor` continues a page.

## defaults

Read `CheckDefaults`: current agent, model, reasoning effort, sandbox provider, rubric, and unrendered prompt template. Pass an agent to read what that agent runs under when you name no model.

### Signature

```ts TypeScript signature
defaults(options?: { agent?: string }): Promise<CheckDefaults>;
```

```python Python signature
async def defaults(*, agent: Optional[str] = None) -> CheckDefaults: ...
```

```ts TypeScript
const defaults = await client.defaults();
const codex = await client.defaults({ agent: "codex" });
```

```python Python
defaults = await client.defaults()
codex = await client.defaults(agent="codex")
```

Python returns a dictionary. The check’s prompt uses `{task_path}`, `{file_tree}`, and `{criteria_guidance}`; the output contract is appended after your template. An agent the platform does not offer is refused with `invalid_input`.

## watch

Wait until every task check has settled. Returns the final `Check`, which may contain failed task checks.

### Signature

```ts TypeScript signature
watch(
  checkId: string,
  options?: WatchCheckOptions
): Promise<Check>;
```

```python Python signature
async def watch(
    check_id: str,
    *,
    on_progress: Optional[Callable[[Check], None]] = None,
    poll_interval_s: float = 2.0,
    timeout_s: Optional[float] = None,
) -> Check: ...
```

```ts TypeScript
const check = await client.watch(checkId, {
  onProgress: c => console.log(c.status)
});
```

```python Python
check = await client.watch(
    check_id,
    on_progress=lambda c: print(c['status']),
)
```

Optional `onProgress(check)` / `on_progress(check)` runs when per-task statuses change. `pollIntervalMs` / `poll_interval_s` defaults to 2 seconds, doubles while unchanged to 30 seconds, and resets on change. TypeScript accepts `signal`; Python accepts `timeout_s`.

## task

TypeScript only. Read one checker’s `TaskCheck` result at any status.

### Signature

```ts TypeScript signature
task(taskCheckId: string): Promise<TaskCheck>;
```

```ts TypeScript
const result = await client.task(taskCheckId);
```

Use `check.results[].id`, not the group’s id. Python reads the same result within `check["results"]`. The result contains `checks`, attempts, measured cost, and typed failure.

## transcript

TypeScript only. Read one checker’s own activity. Returns `TaskCheckTranscript`.

### Signature

```ts TypeScript signature
transcript(
  taskCheckId: string,
  options?: AnalysisTranscriptOptions,
): Promise<TaskCheckTranscript>;
```

```ts TypeScript
const transcript = await client.transcript(taskCheckId, {
  since: 0
});
```

Optional `since` skips that many events; default 0. No server pagination. `total` counts all stored events; `gateway_calls` is separate and returned whole. [Transcript fields](/sdk-reference/types#analysis-and-check-results) include the owning `check_id` and dataset.

## artifact

TypeScript only. Read one checker’s stored stdout, stderr, or captured home.

### Signature

```ts TypeScript signature
artifact(
  taskCheckId: string,
  stream: Exclude<AnalysisArtifactStream, "agent-home">,
): Promise<string | null>;
artifact(
  taskCheckId: string,
  stream: "agent-home",
): Promise<Record<string, string> | null>;
```

```ts TypeScript
const stderr = await client.artifact(
  taskCheckId,
  "trace-stderr"
);
```

Use the task check id. `trace-stdout` and `trace-stderr` return `string | null`; `agent-home` returns a path-to-text map or null. Null means not stored. Python can read stored evidence from `download(task_check_id)`.

## download

Download a settled whole check or one task check as a `.tar.gz`. Both id forms use the same method.

### Signature

```ts TypeScript signature
download(id: string): Promise<Buffer>;
download(
  id: string,
  options: { to: string }
): Promise<string>;
download(
  id: string,
  options: { stream: true }
): Promise<ReadableStream<Uint8Array>>;
download(
  id: string,
  options?: DownloadJobOptions
): Promise<Buffer | string | ReadableStream<Uint8Array>>;
```

```python Python signature
async def download(
    id: str,
    *,
    to: Optional[str] = None,
) -> bytes | str: ...
```

```ts TypeScript
const path = await client.download(checkId, {
  to: "./results"
});
```

```python Python
path = await client.download(
    check_id,
    to='./results',
)
```

Omit options for `Buffer` / `bytes`; use `to` for a saved file path. TypeScript also accepts `{ stream: true }`, a raw stream whose integrity the caller verifies. Python has no stream option. A live group or task check returns `check_not_terminal`. The group archive includes `check_report.json` and each checker’s wrapper trial.

## taskFilesystem

Python: `task_filesystem`. Get one checker’s `RunFilesystem`. Requires both the group id and task check id.

### Signature

```ts TypeScript signature
taskFilesystem(
  checkId: string,
  taskCheckId: string
): RunFilesystem;
```

```python Python signature
def task_filesystem(
    check_id: str,
    task_check_id: str,
) -> 'RunFilesystem': ...
```

```ts TypeScript
const fs = client.taskFilesystem(checkId, taskCheckId);
```

```python Python
fs = client.task_filesystem(
    check_id,
    task_check_id,
)
```

See [filesystem methods](/sdk-reference/methods/filesystem) for files, sandbox logs, and processes.

## share

Grant read access to a check you created. Returns `JobShares`, the same share-state shape used by jobs.

A check can have up to 50 email grants.

### Signature

```ts TypeScript signature
share(
  id: string,
  request: JobShareRequest
): Promise<JobShares>;
```

```python Python signature
async def share(
    id: str,
    *,
    link: bool = False,
    emails: Optional[List[str]] = None,
) -> JobShares: ...
```

```ts TypeScript
const shares = await client.share(checkId, {
  link: true
});
```

```python Python
shares = await client.share(
    check_id,
    link=True,
)
```

Supply `link: true` / `link=True`, `emails: string[]` / `emails=[...]`, or both. New email grants send invitations. Recipients can read the check, its task checks, and downloads. They cannot operate it. [Share-state fields](/sdk-reference/types#sharing-and-deletion) describe the result.

## unshare

Revoke a check’s link or email grants. Returns `JobShares`. Creator-only and idempotent.

### Signature

```ts TypeScript signature
unshare(
  id: string,
  request: JobShareRequest
): Promise<JobShares>;
```

```python Python signature
async def unshare(
    id: str,
    *,
    link: bool = False,
    emails: Optional[List[str]] = None,
) -> JobShares: ...
```

```ts TypeScript
const shares = await client.unshare(checkId, {
  link: true
});
```

```python Python
shares = await client.unshare(
    check_id,
    link=True,
)
```

Takes the same `link` and `emails` fields as `share`.

## shares

Read the check’s whole share state: visibility, link, and email grants. Creator-only.

### Signature

```ts TypeScript signature
shares(id: string): Promise<JobShares>;
```

```python Python signature
async def shares(id: str) -> JobShares: ...
```

```ts TypeScript
const shares = await client.shares(checkId);
```

```python Python
shares = await client.shares(check_id)
```
