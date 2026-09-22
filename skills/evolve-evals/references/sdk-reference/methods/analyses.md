---
title: "Analyses methods"
description: "Read the analyzer’s verdict, transcript, files, and current defaults."
---

Create `client` with `analyses()`. Start a wave with [jobs.analyze](/sdk-reference/methods/jobs#analyze), then read its results here.

**Note:** Python exposes `list`, `defaults`, `download`, and `filesystem`. Direct `get`, `transcript`, and `artifact` reads are TypeScript-only. In Python, `list(job=...)` or `Trial.analysis` gives the verdict; an analysis download gives its stored evidence.

| Both SDKs | TypeScript only |
| --- | --- |
| [list](#list), [defaults](#defaults), [download](#download), [filesystem](#filesystem) | [get](#get), [transcript](#transcript), [artifact](#artifact) |

## list

List visible analyses, newest first. Returns one page or an iterable of `TrialAnalysis`.

### Signature

```ts TypeScript signature
list(options?: ListAnalysesOptions): AnalysisList;
```

```python Python signature
def list(
    *,
    scope: Optional[JobListScope] = None,
    job: Optional[str] = None,
    status: Optional[List[AnalysisStatus]] = None,
    limit: Optional[int] = None,
    cursor: Optional[str] = None,
) -> _PaginatedList: ...
```

```ts TypeScript
const page = await client.list({
  job: jobId,
  status: ["completed"]
});
```

```python Python
page = await client.list(
    job=job_id,
    status=['completed'],
)
```

Optional `scope`: `my` (default), `shared`, or `org`; `job`: source job id; `status`: list of `queued`, `running`, `completed`, or `failed`. `limit` defaults to 50 (maximum 200); `cursor` continues a page.

Python analysis rows are dictionaries: `row["id"]`, `row["checks"]`. [Analysis result fields](/sdk-reference/types#analysis-and-check-results) include failures and cost as well as verdicts.

## defaults

Read the current analysis defaults. Returns `AnalyzeDefaults`: model, effort, sandbox provider, rubric, and unrendered prompt template.

### Signature

```ts TypeScript signature
defaults(): Promise<AnalyzeDefaults>;
```

```python Python signature
async def defaults() -> AnalyzeDefaults: ...
```

```ts TypeScript
const defaults = await client.defaults();
```

```python Python
defaults = await client.defaults()
```

Python returns a dictionary. These are current defaults; an existing analysis records the policy it actually ran under.

## get

TypeScript only. Read one `TrialAnalysis` at any status, including an earlier analysis no longer attached to `Trial.analysis`.

### Signature

```ts TypeScript signature
get(analysisId: string): Promise<TrialAnalysis>;
```

```ts TypeScript
const analysis = await client.get(analysisId);
```

Takes one analysis id. Missing or inaccessible records return `analysis_not_found`.

## transcript

TypeScript only. Read the analyzer’s own activity, not the evaluated agent’s trace. Returns `AnalysisTranscript`.

### Signature

```ts TypeScript signature
transcript(
  analysisId: string,
  options?: AnalysisTranscriptOptions,
): Promise<AnalysisTranscript>;
```

```ts TypeScript
const transcript = await client.transcript(analysisId, {
  since: 0
});
```

Optional `since` is the number of events already read (nonnegative integer, default 0). There is no server-side pagination. `total` counts all stored events; `events` starts at `since`. `gateway_calls` is returned separately in full on each read. See [transcript fields](/sdk-reference/types#analysis-and-check-results).

## artifact

TypeScript only. Read the analyzer’s stored stdout, stderr, or captured home.

### Signature

```ts TypeScript signature
artifact(
  analysisId: string,
  stream: Exclude<AnalysisArtifactStream, "agent-home">
): Promise<string | null>;
artifact(
  analysisId: string,
  stream: "agent-home"
): Promise<Record<string, string> | null>;
```

```ts TypeScript
const stderr = await client.artifact(
  analysisId,
  "trace-stderr"
);
```

`trace-stdout` and `trace-stderr` return `string | null`; `agent-home` returns `Record<string, string> | null`. Null means not stored. Analyses do not expose trial `verifier` or `trace-atif` artifact selectors.

## download

Download a settled analysis as a `.tar.gz` containing its wrapper trial, transcript, logs, and available result artifacts.

### Signature

```ts TypeScript signature
download(analysisId: string): Promise<Buffer>;
download(
  analysisId: string,
  options: { to: string }
): Promise<string>;
download(
  analysisId: string,
  options: { stream: true },
): Promise<ReadableStream<Uint8Array>>;
download(
  analysisId: string,
  options?: DownloadJobOptions
): Promise<Buffer | string | ReadableStream<Uint8Array>>;
```

```python Python signature
async def download(
    analysis_id: str,
    *,
    to: Optional[str] = None,
) -> bytes | str: ...
```

```ts TypeScript
const path = await client.download(analysisId, {
  to: "./results"
});
```

```python Python
path = await client.download(
    analysis_id,
    to='./results',
)
```

Omit delivery options to return `Buffer` / `bytes`; `to` saves to a directory and returns a path. TypeScript also accepts `{ stream: true }`, returning a raw `ReadableStream<Uint8Array>` that the caller must verify. Python has no stream option. Queued or running analyses return `analysis_not_terminal`.

## filesystem

Get the analyzer’s `RunFilesystem`, including its live or captured files, sandbox logs, and process list.

### Signature

```ts TypeScript signature
filesystem(analysisId: string): RunFilesystem;
```

```python Python signature
def filesystem(analysis_id: str) -> 'RunFilesystem': ...
```

```ts TypeScript
const fs = client.filesystem(analysisId);
const status = await fs.status();
```

```python Python
fs = client.filesystem(analysis_id)
status = await fs.status()
```

This is the analyzer’s sandbox, separate from the trial it analyzed. See [filesystem methods](/sdk-reference/methods/filesystem).
