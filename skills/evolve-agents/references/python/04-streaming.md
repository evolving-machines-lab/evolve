# Streaming Events

Real-time output from `run()` and `execute_command()`. For basic usage, see [Getting Started](./01-getting-started.md#streaming).

---

## Event Listeners

Both `run()` and `execute_command()` stream output in real-time:

```python
from evolve import Evolve, AgentConfig

evolve = Evolve(config=AgentConfig(type='claude'))

# Parsed events (recommended)
evolve.on('content', lambda event: print(event['update']['sessionUpdate']))
evolve.on('lifecycle', lambda event: print(event['reason'], event['sandbox']))

# Raw output (debugging)
evolve.on('stdout', lambda data: print(data, end=''))
evolve.on('stderr', lambda data: print(f'[ERR] {data}', end=''))

await evolve.run(prompt='Hello')
```

| Event | Type | Description |
|-------|------|-------------|
| `content` | `OutputEvent` | Parsed ACP-style events (recommended) |
| `lifecycle` | `dict` (`LifecycleEvent` shape below) | Sandbox and agent state transitions |
| `stdout` | `str` | Raw JSONL output |
| `stderr` | `str` | Error output |

`evolve.on(...)` supports only: `stdout`, `stderr`, `content`, `lifecycle`.
Passing any other event name raises `ValueError`.

---

## LifecycleEvent

The optional type-hint examples below use Python 3.11's `NotRequired`. Event handling itself also works on Python 3.10; events are plain dictionaries.

```python
from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict, Union

class LifecycleEvent(TypedDict):
    sandbox_id: str | None
    sandbox: Literal["booting", "error", "ready", "running", "paused", "stopped"]
    agent: Literal["idle", "running", "interrupted", "error"]
    timestamp: str
    browser: NotRequired[dict[str, str]]  # live_url/session_id/session_tag
    reason: Literal[
        "browser_ready",
        "sandbox_boot",
        "sandbox_ready",
        "sandbox_connected",
        "sandbox_pause",
        "sandbox_resume",
        "sandbox_killed",
        "sandbox_error",
        "run_start",
        "run_complete",
        "run_interrupted",
        "run_failed",
        "run_background_complete",
        "run_background_failed",
        "command_start",
        "command_complete",
        "command_interrupted",
        "command_failed",
        "command_background_complete",
        "command_background_failed",
    ]
```

---

## OutputEvent

Python receives plain dictionaries. These definitions document their shapes for type hints; they are not exported SDK classes.

```python
class OutputEvent(TypedDict):
    sessionId: NotRequired[str]
    update: SessionUpdate
    timestamp: NotRequired[str]         # the harness's own clock for this line, ISO 8601
    model: NotRequired[str]             # the model the harness named for this line
    messageId: NotRequired[str]         # the harness's id for the LLM message this line belongs to
    parentToolCallId: NotRequired[str]  # on a SUBAGENT's line: the parent's tool call that delegated to it
    extra: NotRequired[dict[str, Any]]  # other facts of the line, the harness's own key names (e.g. stop_reason)
```

Every field except `update` is optional. Missing harness data stays absent.

| Field | Source |
| --- | --- |
| `timestamp` | The harness's ISO 8601 clock. Claude, OpenCode, Droid, and Z Code stamp lines; Pi and Prime Agent stamp messages. Codex, Qwen, Kimi, dsh, and Antigravity supply no timestamp. |
| `model` | The model named on the line, Droid/Antigravity's initialization event, or Z Code's first request. |
| `messageId` | Groups lines from one model message. Claude content blocks share `message.id`; Antigravity groups one `agent_response` step. |
| `parentToolCallId` | On sub-agent events, identifies the parent `Task`, `agent`, or `Agent` tool call. Z Code also supplies `extra.childSessionId`. |
| `extra` | Additional fields under the harness's original names. |

---

## SessionUpdate Types

Select the update type by its `sessionUpdate` field:

```python
SessionUpdate = Union[
    "AgentMessageChunk",
    "AgentThoughtChunk",
    "UserMessageChunk",
    "ToolCall",
    "ToolCallUpdate",
    "Plan",
    "AgentError",
    "AgentUsage",
    "HarnessEvent",
]
```

### Message Events

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `AgentMessageChunk` | `"agent_message_chunk"` | Text/image streaming from agent |
| `AgentThoughtChunk` | `"agent_thought_chunk"` | Reasoning (Codex) or thinking (Claude) |
| `UserMessageChunk` | `"user_message_chunk"` | User message echo (Qwen, OpenCode, Pi, Prime Agent, Z Code) |

```python
class AgentMessageChunk(TypedDict):
    sessionUpdate: Literal["agent_message_chunk"]
    content: ContentBlock

class AgentThoughtChunk(TypedDict):
    sessionUpdate: Literal["agent_thought_chunk"]
    content: ContentBlock

class UserMessageChunk(TypedDict):
    sessionUpdate: Literal["user_message_chunk"]
    content: ContentBlock
```

### Tool Events

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `ToolCall` | `"tool_call"` | Tool execution started |
| `ToolCallUpdate` | `"tool_call_update"` | Tool execution finished |

```python
class ToolCall(TypedDict):
    sessionUpdate: Literal["tool_call"]
    toolCallId: str
    title: str
    toolName: NotRequired[str]   # harness-native tool name, e.g. "mcp__mcp-server__get_secret"
    kind: ToolKind
    status: ToolCallStatus
    rawInput: NotRequired[dict]
    content: NotRequired[list[ToolCallContent]]
    locations: NotRequired[list[ToolCallLocation]]

class ToolCallUpdate(TypedDict):
    sessionUpdate: Literal["tool_call_update"]
    toolCallId: str
    status: NotRequired[ToolCallStatus]
    title: NotRequired[str]
    content: NotRequired[list[ToolCallContent]]
    locations: NotRequired[list[ToolCallLocation]]
    rawOutput: NotRequired[Any]  # the harness's own structured record of the result, verbatim
```

Use `toolName` to identify a tool: it preserves names such as `Bash`, `Read`, and `mcp__<server>__<tool>`. `title` is display text. If `toolName` is absent in an older trace or an unnamed call, fall back to `kind`.

`content` preserves result text, including errors, without adding formatting. `rawOutput` preserves a structured result when the harness provides one:

| Harness | Structured result |
| --- | --- |
| Claude | `tool_use_result`, including stdout, stderr, exit code, interruption, or file details. |
| Codex | Completed item, including `aggregated_output`, `exit_code`, and `status`. |
| OpenCode | Tool state, including output, metadata, exit code, and timing. |

Read an exit code from `rawOutput` rather than parsing prose.

### Plan Event

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `Plan` | `"plan"` | TodoWrite updates (replaces entire list) |
| `AgentError` | `"error"` | A failure the HARNESS reported. **Not agent work** — see below |
| `AgentUsage` | `"usage"` | Token accounting the HARNESS reported. **Not agent work** — see below |
| `HarnessEvent` | `"harness_event"` | A line about the harness's own run (a retry, a sub-agent step, an unknown type). **Not agent work** — see below |

```python
PlanEntryStatus = Literal["pending", "in_progress", "completed"]

class PlanEntry(TypedDict):
    content: str
    status: PlanEntryStatus
    priority: Literal["high", "medium", "low"]

class Plan(TypedDict):
    sessionUpdate: Literal["plan"]
    entries: list[PlanEntry]
```

---

## Content Types

```python
class TextContent(TypedDict):
    type: Literal["text"]
    text: str

class ImageContent(TypedDict):
    type: Literal["image"]
    data: str          # Base64-encoded
    mimeType: str      # "image/png", "image/jpeg"
    uri: NotRequired[str]

ContentBlock = Union[TextContent, ImageContent]
```

---

## Tool Metadata Types

### ToolKind

Tool category for UI icons:

```python
ToolKind = Literal[
    "read",        # Read, NotebookRead
    "edit",        # Edit, Write, NotebookEdit
    "delete",      # (future)
    "move",        # (future)
    "search",      # Glob, Grep, LS
    "execute",     # Bash, BashOutput, KillShell
    "think",       # Task (subagent)
    "fetch",       # WebFetch, WebSearch
    "switch_mode", # ExitPlanMode
    "other",       # Unknown or third-party MCP tools
]
```

### ToolCallStatus

```python
ToolCallStatus = Literal["pending", "in_progress", "completed", "failed"]
```

### ToolCallLocation

```python
class ToolCallLocation(TypedDict):
    path: str
    line: NotRequired[int]
```

### ToolCallContent

```python
class DiffContent(TypedDict):
    type: Literal["diff"]
    path: str
    oldText: str | None  # None for new files
    newText: str

class WrappedContent(TypedDict):
    type: Literal["content"]
    content: ContentBlock

ToolCallContent = Union[WrappedContent, DiffContent]
```

---

## Browser Automation Streaming

The full browser guide is [Configuration → Browser Automation](./02-configuration.md#browser-automation).
This section only documents the streaming fields for browser live view.

| Need | API | Use |
|------|-----|-----|
| Show live browser during a run | `lifecycle` event with `reason == "browser_ready"` | `event["browser"]["live_url"]` |
| Save the browser/session id | same lifecycle event | `event["browser"]["session_id"]` |

### Managed Browser

Managed browser sessions emit the live-view URL as soon as the browser is ready:

```python
def on_lifecycle(event):
    if event['reason'] == 'browser_ready' and event.get('browser'):
        open_live_view(event['browser']['live_url'])
        remember_session_id(event['browser']['session_id'])

evolve.on('lifecycle', on_lifecycle)
```

The same URL is also stored in trace metadata for replay or embedding after the trace exists:

```python
TraceMetadata = {
    "browser_session_id": "...",
    "dashboard_session_id": "...",
    "browser_session_tag": "...",
    "browser_live_url": "...",
}
```

Use `event["browser"]["live_url"]` or `result.browser["live_url"]` for immediate
UI display. For replay after cleanup, use the `session_id` with
`sessions().browser_replay()`; the full example lives in
[Configuration → Browser Automation](./02-configuration.md#browser-automation).

---

## UI Integration Example

Use `cast()` to narrow a TypedDict union after checking `sessionUpdate`.

```python
from typing import cast

def handle_event(event: OutputEvent) -> None:
    update = event["update"]
    event_type = update["sessionUpdate"]

    if event_type == "agent_message_chunk":
        msg = cast(AgentMessageChunk, update)
        if msg["content"]["type"] == "text":
            ui.append_message(msg["content"]["text"])
        else:
            img = cast(ImageContent, msg["content"])
            ui.append_image(img["data"], img["mimeType"])

    elif event_type == "agent_thought_chunk":
        thought = cast(AgentThoughtChunk, update)
        ui.append_thought(thought["content"])

    elif event_type == "user_message_chunk":
        # Prompt echo - typically ignored
        pass

    elif event_type == "tool_call":
        tool = cast(ToolCall, update)
        ui.add_tool(
            id=tool["toolCallId"],
            title=tool["title"],
            kind=tool["kind"],
            status=tool["status"],
            locations=tool.get("locations"),
        )

    elif event_type == "tool_call_update":
        update_data = cast(ToolCallUpdate, update)
        ui.update_tool(
            update_data["toolCallId"],
            status=update_data.get("status"),
            content=update_data.get("content"),
        )

    elif event_type == "plan":
        plan = cast(Plan, update)
        ui.render_plan(plan["entries"])

    elif event_type == "error":
        print(cast(AgentError, update)["message"])

    elif event_type in ("usage", "harness_event"):
        print(update)  # Diagnostic data, separate from agent work.

evolve.on("content", handle_event)
```

---

## Key Patterns

1. **Handle every update type** — Keep errors, usage, and harness activity separate from agent work

2. **Match tools by ID** — `tool_call` and `tool_call_update` share `toolCallId`

3. **Handle out-of-order** — `tool_call_update` may arrive before `tool_call`

4. **Concatenate chunks** — Message text arrives incrementally

5. **Support images** — `ContentBlock` includes `ImageContent`

6. **Use `kind` for icons** — Categorize tools visually (read, edit, execute, etc.)

7. **Identify tools by `toolName`** — The harness-native name, not the human-readable `title`; fall back to `kind` when it is absent

8. **Track `locations`** — Show affected file paths in UI

---


## Harness-reported failures (`error`)

A harness can fail without the process dying, and it reports that on the same stream it uses for
output. Codex, for example, writes `{"type": "error"}` while it retries and
`{"type": "turn.failed"}` when a turn gives up — on **stdout**, while stderr says only
`Reading prompt from stdin...`. Those are surfaced as their own update so a transcript shows what
actually happened:

```python
class AgentError(TypedDict):
    sessionUpdate: Literal["error"]
    message: str   # the harness's own message, verbatim
    fatal: bool    # True when the harness treated it as terminal for the turn
```

```python
{
    "update": {
        "sessionUpdate": "error",
        "message": "stream disconnected before completion: ...",  # the harness's own words
        "fatal": False,  # True when the harness treated it as terminal for the turn
    }
}
```

Python receives events as plain dicts (there is no typed union to import, unlike TypeScript), so
this arrives as `event["update"]["sessionUpdate"] == "error"`.

**It is deliberately not a message chunk.** If you are counting "did the agent do any work", an
error must not count — otherwise a run that never reached the model looks like a run that produced
output:

```python
def did_work(events):
    return any(e.get("update", {}).get("sessionUpdate") not in ("error", "usage", "harness_event") for e in events)
```

## Harness-reported events (`harness_event`)

`harness_event` carries run activity such as retries, sub-agent progress, and compaction that does not fit a message or tool update.

The `pi`, `prime-agent`, `dsh`, `zcode`, and `antigravity` parsers preserve unknown JSON event types this way. The update includes the original type and the event's other fields; warnings appear once for each unknown type in a parser instance.

Claude, Codex, Qwen, Kimi, OpenCode, and Droid do not provide that unknown-type guarantee in `content` events. Subscribe to `stdout` when you need the complete raw harness output.

```python
class HarnessEvent(TypedDict):
    sessionUpdate: Literal["harness_event"]
    type: str                  # the harness's own type word for the line
    payload: dict[str, Any]    # the line's other fields, verbatim
```

```python
{
    "update": {
        "sessionUpdate": "harness_event",
        "type": "auto_retry_start",          # the harness's own type word, verbatim
        "payload": {"attempt": 1, "maxAttempts": 3, "delayMs": 2271},  # the line's other fields, verbatim
    }
}
```

Exclude these events when checking whether the agent produced work. The `did_work` example excludes `harness_event`, `error`, and `usage`.

## Harness-reported usage (`usage`)

Usage events report the accounting available from the harness:

| Harness | Reported usage |
| --- | --- |
| Claude, Qwen | Each model message and a whole-run total. |
| Codex, Droid | A whole-run total. |
| OpenCode | Each step's tokens and cost. |
| Pi, Prime Agent | Each model call's tokens. Cost is present only when the harness supplies it. |
| dsh | Each step's tokens. |
| Z Code | Each model request and a whole-run total. Reasoning and cache counts are in `extra`; no cost is reported. |
| Antigravity | Each model call and a conversation total. The total includes earlier turns when a run resumes. |
| Kimi | No `usage` events; its stream does not report usage. |

Prompt-token accounting follows the harness. For OpenCode, `promptTokens` includes input and cache reads; cache writes remain in `extra.cache_write_tokens`.

```python
class TokenUsage(TypedDict, total=False):
    promptTokens: int        # Input total normalized from harness accounting
    completionTokens: int
    cachedTokens: int        # the cache-read share of promptTokens
    costUsd: float           # only when the harness priced it
    extra: dict[str, Any]    # the harness's other counters, its own key names verbatim

class AgentUsage(TypedDict):
    sessionUpdate: Literal["usage"]
    scope: Literal["call", "run"]  # one LLM inference, or the harness's whole-run total
    usage: TokenUsage
```

```python
{
    "messageId": "msg_01...",  # claude and qwen: the LLM message this line belongs to
    "update": {
        "sessionUpdate": "usage",
        "scope": "call",  # "call": one LLM inference; "run": the harness's total for the whole run
        "usage": {
            "promptTokens": 150,      # Input total normalized from harness accounting
            "completionTokens": 7,
            "cachedTokens": 30,       # the cache-read share of promptTokens
            "extra": {"cache_creation_input_tokens": 20, "service_tier": "standard"},
        },
    },
}
```

The names are Harbor's ATIF `Metrics` fields, so a trajectory copies them without renaming. A
counter the harness did not print is absent, never `0`. Two things to know when you sum:

- A `"call"` event repeats for every line of the same `messageId` (claude prints one line per
  content block, each with the message's running usage) — keep the **last** one per `messageId`,
  then add across messages.
- A `"run"` event is the harness's own total, reported once at the end; it is not another call.

```python
per_message: dict[str, dict] = {}
for e in events:
    update = e.get("update", {})
    if update.get("sessionUpdate") != "usage" or update.get("scope") != "call":
        continue
    per_message[e.get("messageId", f"line-{len(per_message)}")] = update["usage"]
prompt_tokens = sum(u.get("promptTokens", 0) for u in per_message.values())
```

Like `error`, `usage` is **not agent work**: a stream that carries only accounting still counts as a
run that did nothing.
