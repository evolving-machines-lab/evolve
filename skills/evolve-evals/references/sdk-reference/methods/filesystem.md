---
title: "Filesystem methods"
description: "Read run files, captured changes, sandbox logs, and live processes."
---

A `RunFilesystem` belongs to a trial, analysis, or task check. Each exposes the same methods.

```ts TypeScript
const fs = trials().filesystem(trialId);
// Or: analyses().filesystem(analysisId)
// Or: checks().taskFilesystem(checkId, taskCheckId)
```

```python Python
fs = trials().filesystem(trial_id)
# Or: analyses().filesystem(analysis_id)
# Or: checks().task_filesystem(check_id, task_check_id)
```

Read [filesystem states](/sdk-reference/filesystem) before choosing a source. Omit `source` to use the available source; pass `live` or `capture` to request one explicitly.

| Files | Live observation |
| --- | --- |
| [status](#status), [list](#list), [read](#read), [search](#search), [changes](#changes), [archive](#archive) | [watch](#watch), [events](#events), [logs](#logs), [logEvents](#logevents), [procs](#procs) |

[Task package files](#task-package-files) provide a smaller, read-only interface.

## status

Return `FilesystemStatus`: state, live box, watcher type, root, work directory, and capture record.

### Signature

```ts TypeScript signature
status(): Promise<FilesystemStatus>;
```

```python Python signature
async def status() -> FilesystemStatus: ...
```

```ts TypeScript
const status = await fs.status();
```

```python Python
status = await fs.status()
```

States: `live`, `capturing`, `captured`, `none`. A null `capture` means no settled capture record. A capture can be incomplete: inspect `left_out` before assuming every file was retained. See [filesystem result fields](/sdk-reference/types#filesystem-results).

## list

Read one directory page, sorted by name. Returns `FilesystemListing`.

### Signature

```ts TypeScript signature
list(
  options?: FilesystemListOptions
): Promise<FilesystemListing>;
```

```python Python signature
async def list(
    *,
    path: str = '/',
    source: Optional[FilesystemSource] = None,
    cursor: Optional[str] = None,
    limit: Optional[int] = None,
) -> FilesystemListing: ...
```

```ts TypeScript
const page = await fs.list({
  path: "/app",
  limit: 100
});
```

```python Python
page = await fs.list(
    path='/app',
    limit=100,
)
```

Optional `path` defaults to `/`; `source` selects `live` or `capture`; `cursor` continues the page; `limit` defaults to 500 (maximum 1,000).

Returns `path`, `source`, `entries`, `next_cursor`, and elapsed `ms`. Both languages use `next_cursor` here. An entry with `captured: false` has no retained bytes. Read `left_out` for an omitted or failed capture; otherwise it may be an untouched image file. A missing directory returns `not_found`.

## read

Read raw bytes from an absolute sandbox path. Returns `Buffer` / `bytes`.

### Signature

```ts TypeScript signature
read(
  path: string,
  options?: FilesystemReadOptions
): Promise<Buffer>;
```

```python Python signature
async def read(
    path: str,
    *,
    source: Optional[FilesystemSource] = None,
    start: Optional[int] = None,
    end: Optional[int] = None,
    suffix: Optional[int] = None,
) -> bytes: ...
```

```ts TypeScript
const bytes = await fs.read("/app/result.txt", {
  range: {
    suffix: 4096
  }
});
```

```python Python
data = await fs.read(
    '/app/result.txt',
    suffix=4096,
)
```

Optional `source` chooses `live` or `capture`. For ranges, TypeScript uses `{ range: { start, end } }`; Python uses `start=` and `end=`. End is inclusive. Use `start` alone through EOF or `suffix` alone for the last N bytes. An oversized whole-file read returns 413; read slices instead.

## search

Search file contents. Returns `FilesystemSearchResult`, including hits and whether results were truncated.

### Signature

```ts TypeScript signature
search(
  options: FilesystemSearchOptions
): Promise<FilesystemSearchResult>;
```

```python Python signature
async def search(
    q: str,
    *,
    path: str = '/',
    regex: bool = False,
    limit: Optional[int] = None,
    source: Optional[FilesystemSource] = None,
) -> FilesystemSearchResult: ...
```

```ts TypeScript
const result = await fs.search({
  q: "TODO",
  path: "/app"
});
```

```python Python
result = await fs.search(
    'TODO',
    path='/app',
)
```

Required `q` is text; `regex: true` / `regex=True` interprets it as a regular expression. Optional `path` defaults to `/`; `limit` defaults to 200 (maximum 1,000); `source` selects `live` or `capture`.

Returns `hits[]` with `path`, `line`, `snippet`; plus `truncated`, `scope`, `source`, `ms`, and optional `image_files_excluded`. A whole-box search can take seconds. Captured search cannot inspect untouched image files.

## changes

Read created, modified, and removed paths by phase. Returns one `FilesystemChanges` page.

### Signature

```ts TypeScript signature
changes(
  options?: FilesystemChangesOptions
): Promise<FilesystemChanges>;
```

```python Python signature
async def changes(
    *,
    source: Optional[FilesystemSource] = None,
    phase: Optional[Literal['setup', 'agent', 'verifier', 'all']] = None,
    cursor: Optional[str] = None,
    limit: Optional[int] = None,
) -> FilesystemChanges: ...
```

```ts TypeScript
const page = await fs.changes({
  phase: "agent",
  limit: 100
});
```

```python Python
page = await fs.changes(
    phase='agent',
    limit=100,
)
```

Optional `phase`: `setup`, `agent`, `verifier`, or `all` (default); `source`: `live` or `capture`; `limit`: default 500, maximum 1,000; `cursor`: next page. Returns `source`, whole-list `total` and `changed_bytes`, page `items`, and `next_cursor`. Live changes require a recorded initial listing; otherwise the server returns `feature_unsupported`. For captured changes, `left_out` explains missing retained bytes.

## archive

Download a subtree as `.tar.gz`. The default path `/` requests the whole tree.

### Signature

```ts TypeScript signature
archive(
  options?: FilesystemArchiveOptions
): Promise<Buffer>;
archive(
  options: FilesystemArchiveOptions & { to: string }
): Promise<string>;
archive(
  options: FilesystemArchiveOptions & { stream: true },
): Promise<ReadableStream<Uint8Array>>;
```

```python Python signature
async def archive(
    *,
    path: str = '/',
    source: Optional[FilesystemSource] = None,
    to: Optional[str] = None,
) -> bytes | str: ...
```

```ts TypeScript
const path = await fs.archive({
  path: "/app",
  to: "./results"
});
```

```python Python
path = await fs.archive(
    path='/app',
    to='./results',
)
```

Optional `source` selects `live` or `capture`. No `to` returns `Buffer` / `bytes`; `to` saves into a directory and returns the file path. TypeScript also accepts `stream: true`; Python does not expose streaming. A live subtree too large to read within provider limits returns `feature_unsupported`.

## watch

Declare the folders currently open in your viewer. Replaces the watched set, with at most eight paths.

### Signature

```ts TypeScript signature
watch(paths: string[]): Promise<FilesystemWatchResult>;
```

```python Python signature
async def watch(
    paths: List[str]
) -> FilesystemWatchResult: ...
```

```ts TypeScript
const result = await fs.watch(["/app", "/logs"]);
```

```python Python
result = await fs.watch(
    ['/app', '/logs'],
)
```

Required `paths: string[]`. Returns `watcher: "native" | "poll"` and `paths: string[]`. Poll-based change detection uses this set. This method registers folders; `events()` reads their changes.

## events

Iterate filesystem state and changes until the filesystem settles. Returns async `FilesystemStreamEvent` frames.

### Signature

```ts TypeScript signature
events(
  options?: FilesystemStreamOptions
): AsyncIterableIterator<FilesystemStreamEvent>;
```

```python Python signature
async def events(
    *,
    last_event_id: Optional[str] = None,
) -> 'AsyncIterator[FilesystemStreamEvent]': ...
```

```ts TypeScript
for await (const event of fs.events()) {
  console.log(event.event, event.data);
}
```

```python Python
async for event in fs.events():
    print(event.event, event.data)
```

Optional `lastEventId` / `last_event_id` resumes after a stored event id. TypeScript also accepts `signal`. A `state` frame after a resume request means relist the folder. Frames are `state`, `fs`, or `ping`; [event fields](/sdk-reference/types#filesystem-results) define the payloads.

## logs

Read one page of one sandbox log stream. Returns `SandboxLogLines`.

### Signature

```ts TypeScript signature
logs(
  options: SandboxLogOptions
): Promise<SandboxLogLines>;
```

```python Python signature
async def logs(
    stream: SandboxLogStream,
    *,
    cursor: Optional[str] = None,
    limit: Optional[int] = None,
) -> SandboxLogLines: ...
```

```ts TypeScript
const page = await fs.logs({
  stream: "agent",
  limit: 100
});
```

```python Python
page = await fs.logs(
    'agent',
    limit=100,
)
```

Required `stream`: `agent`, `verifier`, `setup`, `system`, or `metrics`. Optional `cursor` continues the stream; `limit` defaults to and is capped at 1,000. Returns `stream`, `lines`, `next_cursor`, and optional `reason` when no lines were retained. Each line has `seq`, nullable `t`, `fd` (`out` or `err`), and `line`.

## logEvents

Python: `log_events`. Iterate all sandbox log streams together. Ends after the box is gone and stored lines are drained.

### Signature

```ts TypeScript signature
logEvents(
  options?: FilesystemStreamOptions
): AsyncIterableIterator<SandboxLogEvent>;
```

```python Python signature
async def log_events(
    *,
    last_event_id: Optional[str] = None,
) -> 'AsyncIterator[SandboxLogEvent]': ...
```

```ts TypeScript
for await (const event of fs.logEvents()) {
  if (event.event === "line")
    console.log(event.data.line);
}
```

```python Python
async for event in fs.log_events():
    if event.event == "line":
        print(event.data["line"])
```

Optional `lastEventId` / `last_event_id` is `<stream>:<seq>`. TypeScript also accepts `signal`. Returns `SandboxLogEvent`: `line`, `state`, or `ping`. A line payload adds `stream` to `SandboxLogLine`.

## procs

Read the live sandbox’s process list. Returns `SandboxProcs`.

### Signature

```ts TypeScript signature
procs(): Promise<SandboxProcs>;
```

```python Python signature
async def procs() -> SandboxProcs: ...
```

```ts TypeScript
const processes = await fs.procs();
console.log(processes.text);
```

```python Python
processes = await fs.procs()
print(processes.text)
```

No arguments. `text` is the process listing; `ms` is elapsed server time. Once the box is gone, this returns 409 `filesystem_state`; a captured filesystem cannot supply live processes.

## Task package files

`datasets().taskFiles(ref, taskName)` / `task_files(ref, task_name)` returns `TaskPackageFiles`. Pin `ref` as `name@version`. This reads the retained task package, not a sandbox.

```ts TypeScript
const files = datasets().taskFiles(
  "my-tasks@1.0",
  "hello-world"
);
```

```python Python
files = datasets().task_files(
    "my-tasks@1.0",
    "hello-world"
)
```

## package.status

Read `TaskPackageFilesystemStatus`, the normal filesystem status plus `source: "package"` and `package_retained: boolean`. Its `state` is always `none`.

### Signature

```ts TypeScript signature
status(): Promise<TaskPackageFilesystemStatus>;
```

```python Python signature
async def status() -> TaskPackageFilesystemStatus: ...
```

```ts TypeScript
const status = await files.status();
```

```python Python
status = await files.status()
```

A false `package_retained` means package bytes are unavailable; file reads return `task_package_not_retained`.

## package.list

Read a page from the task directory. Returns `FilesystemListing` with `source: "package"`.

### Signature

```ts TypeScript signature
list(
  options?: Omit<FilesystemListOptions, "source">
): Promise<FilesystemListing>;
```

```python Python signature
async def list(
    *,
    path: str = '/',
    cursor: Optional[str] = None,
    limit: Optional[int] = None,
) -> FilesystemListing: ...
```

```ts TypeScript
const page = await files.list({
  path: "/tests"
});
```

```python Python
page = await files.list(path="/tests")
```

Optional `path` defaults to `/`; `limit` defaults to 500 (maximum 1,000); `cursor` continues the page. There is no `source` selector.

## package.read

Read exact bytes from a retained task file. Returns `Buffer` / `bytes`.

### Signature

```ts TypeScript signature
read(
  path: string,
  options?: { range?: TrialFileRange }
): Promise<Buffer>;
```

```python Python signature
async def read(
    path: str,
    *,
    start: Optional[int] = None,
    end: Optional[int] = None,
    suffix: Optional[int] = None,
) -> bytes: ...
```

```ts TypeScript
const bytes = await files.read("/instruction.md", {
  range: {
    start: 0,
    end: 1023
  }
});
```

```python Python
data = await files.read(
    '/instruction.md',
    start=0,
    end=1023,
)
```

The same inclusive byte-range forms as `RunFilesystem.read` apply. This interface has no search, archive, watch, event, log, or process methods.
