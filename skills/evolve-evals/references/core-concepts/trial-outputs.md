---
title: "Trial outputs"
description: "Find the record, trace, logs, and files from an evaluation."
---

Choose the output that answers your question:

| Question | Open |
| --- | --- |
| What score did it earn? | `result.json` and verifier output. |
| What did the agent do? | Parsed trace or ATIF trajectory. |
| What did the process print? | Raw stdout and stderr. |
| What files did it change? | Run filesystem and changes list. |
| What state did the harness keep? | Captured agent home. |

## The trial directory

```bash
evolve trial download "$TRIAL_ID" -o trials/
```

A typical Codex trial looks like this. Files appear only when recorded.

- trials/
  - TRIAL_ID/
    - config.json
    - result.json
    - evolve.json
    - exception.txt
    - agent/
      - trajectory.json
      - trace-parsed.jsonl
      - codex.txt
      - stderr.log
      - agent-home.json
      - .codex/
    - verifier/
      - test-stdout.txt
      - reward.json

### What each file contains

| File | Contents |
| --- | --- |
| `config.json` | Task and agent identity |
| `result.json` | Reward, timing, and exception |
| `evolve.json` | Evolve's detailed trial record |
| `exception.txt` | Present when an exception exists |
| `trajectory.json` | ATIF conversation |
| `trace-parsed.jsonl` | Parsed events |
| `codex.txt` | Raw stdout |
| `stderr.log` | Raw stderr |
| `agent-home.json` | Capture manifest |
| `.codex/` | Captured harness state |
| `test-stdout.txt` | Verifier log |
| `reward.json` | Recorded rewards |

The stdout filename follows the harness. A registered custom agent uses `stdout.log`.

### Trial download or job archive?

| Download | Includes |
| --- | --- |
| `evolve trial download "$TRIAL_ID"` | One trial reconstructed by the CLI, including the text view of its agent home. |
| `evolve job download "$JOB_ID"` | The full server archive: job records, each trial's locks and logs, retained binary home files, and recorded artifacts. |

A job archive also includes per-step records for multi-step tasks. Platform-specific fields in Harbor-format records use `x_evolve` extensions.

Existing output folders require `--overwrite`. This permits writing into the folder; it does not remove unrelated old files.

### Declared artifacts in the job archive

Each trial in the full job archive contains `artifacts/manifest.json`. For native Evolve runs, artifact payloads come from the retained inputs of **separate verification**. Shared verification does not export the task's artifact list; inspect its live or captured files through [sandbox files](#sandbox-files).

Files normally mirror their absolute source path under `artifacts/`. A task's `destination` changes that downloaded location. For example, one generated manifest entry can be:

```json
{
  "source": "/app/reports/result.json",
  "destination": "artifacts/reports/result.json",
  "type": "file",
  "status": "ok",
  "service": null
}
```

### Artifact manifest fields

The manifest is a JSON array of entries.

| Field | Meaning |
| --- | --- |
| `source` | Original absolute file path in the sandbox. |
| `destination` | Export path relative to the trial directory, including `artifacts/`. |
| `type` | `"file"` for generated entries. Directory declarations expand to individual retained files. |
| `status` | `"ok"` for an emitted file, or `"skipped"` for a destination conflict. |
| `service` | Compose service name, or `null` for the main container. |

The first file claiming a destination wins. Later equal or nested destinations are skipped, and `artifacts/manifest.json` is reserved for the manifest itself.

Generated entries describe retained file candidates; missing, unrecorded files have no entry. A native trial with no retained artifact record has `[]`, including shared-mode trials or a separate-mode trial whose artifact record could not be stored. The separate filesystem capture can still be available.

Uploaded archives retain their own artifact files and manifest when present. Their manifest content is preserved rather than rewritten to the generated schema above.

## The parsed trace

Each event has a sequence position, a type, and data. This illustrative event shows a completed tool call:

```json
{
  "seq": 3,
  "type": "tool_call_update",
  "data": {
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-1",
      "status": "completed"
    }
  }
}
```

```bash
evolve trial trace "$TRIAL_ID" --json
evolve trial trace "$TRIAL_ID" --grep 'permission denied' --tail 50
```

Gateway usage events carry `data.update.source: "gateway"`. Use them for gateway token and cost accounting; harness-reported usage is a different reading.

## The ATIF trajectory

ATIF is Harbor's **Agent Trajectory Interchange Format**. Evolve exports `ATIF-v1.7`, built from the stored parsed trace.

| Field | Contents |
| --- | --- |
| `schema_version` | Format version |
| `agent` | Harness, version, and model |
| `steps[].source` | User, system, or agent |
| `steps[].message` | Conversation content |
| `steps[].tool_calls` | Agent actions |
| `steps[].observation` | Tool results |

```bash
evolve trial download "$TRIAL_ID" --stream trace-atif
```

The `trajectory` stream name is reserved for a native harness session and is not served today. Use `trace-atif` for the portable trajectory.

## Raw streams and the verifier log

```bash
evolve trial download "$TRIAL_ID" --stream trace-stdout
evolve trial download "$TRIAL_ID" --stream trace-stderr
evolve trial download "$TRIAL_ID" --stream verifier
```

An absent artifact remains absent. It is not replaced with an empty success log.

## The agent's home folder

The captured home contains harness settings, sessions, and subagent transcripts. `agent-home.json` records paths, sizes, digests, and files excluded or skipped.

The `agent-home` stream is a **text view**. Binary files are listed in the manifest but omitted from this view. Download the full job archive to retrieve retained binary files.

## Sandbox files

The run filesystem is separate from the saved trial directory above.

| File in the sandbox | After capture |
| --- | --- |
| `/app/report.json` — changed | Metadata and captured bytes |
| `/app/new.txt` — created | Metadata and captured bytes |
| `/usr/bin/python` — unchanged | Metadata only |

The capture preserves supported files the run created or changed. It is not a complete copy of the base image. Files omitted during capture carry a reason.

### 1. Check which source is available

```bash
evolve trial files status "$TRIAL_ID"
```

The state is `live`, `capturing`, `captured`, or `none`.

### 2. Browse and read

```bash
evolve trial files ls "$TRIAL_ID" /app
evolve trial files cat "$TRIAL_ID" /app/report.json
evolve trial files changes "$TRIAL_ID"
```

Reads use the live sandbox when available, otherwise its capture. Force one with `--source live` or `--source capture`.

### 3. Keep a subtree

```bash
evolve trial files archive "$TRIAL_ID" --path /app -o archives/
```

An unchanged image file may be listed but unreadable after capture (`not_captured`). A forced source that is unavailable returns `filesystem_state`.

### Logs and processes

```bash
evolve trial logs "$TRIAL_ID" --stream agent --follow
evolve trial procs "$TRIAL_ID"
```

| Stream | Availability |
| --- | --- |
| `agent` | Recorded harness output. |
| `verifier` | Recorded verifier output. |
| `system` | When the job enabled `--system-log`. |
| `setup`, `metrics` | Reserved; currently empty with an explanation. |

Process inspection requires a live sandbox. Analysis runs and task checks expose the same filesystem operations. Published task files have a separate read-only package browser.

**[Filesystem API](/sdk-reference/filesystem)**

Read ranges, search, changes, and events.

**[Trial viewer](/dashboard/trial-viewer)**

Inspect the trace in the browser.
