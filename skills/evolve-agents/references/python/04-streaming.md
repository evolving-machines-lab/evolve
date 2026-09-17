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

## LifecycleEvent (TypedDict shape)

```python
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

## Type Definitions

Use these `TypedDict` definitions for type hints:

```python
from typing import Any, TypedDict, Literal, Union, NotRequired

# =============================================================================
# Content Types
# =============================================================================

class TextContent(TypedDict):
    type: Literal["text"]
    text: str

class ImageContent(TypedDict):
    type: Literal["image"]
    data: str          # Base64-encoded
    mimeType: str      # "image/png", "image/jpeg"
    uri: NotRequired[str]

ContentBlock = Union[TextContent, ImageContent]

class DiffContent(TypedDict):
    type: Literal["diff"]
    path: str
    oldText: str | None  # None for new files
    newText: str

class WrappedContent(TypedDict):
    type: Literal["content"]
    content: ContentBlock

ToolCallContent = Union[WrappedContent, DiffContent]

# =============================================================================
# Tool Types
# =============================================================================

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

ToolCallStatus = Literal["pending", "in_progress", "completed", "failed"]

class ToolCallLocation(TypedDict):
    path: str
    line: NotRequired[int]

# =============================================================================
# Session Update Types
# =============================================================================

class AgentMessageChunk(TypedDict):
    sessionUpdate: Literal["agent_message_chunk"]
    content: ContentBlock

class AgentThoughtChunk(TypedDict):
    sessionUpdate: Literal["agent_thought_chunk"]
    content: ContentBlock

class UserMessageChunk(TypedDict):
    sessionUpdate: Literal["user_message_chunk"]
    content: ContentBlock

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

PlanEntryStatus = Literal["pending", "in_progress", "completed"]

class PlanEntry(TypedDict):
    content: str
    status: PlanEntryStatus
    priority: Literal["high", "medium", "low"]

class Plan(TypedDict):
    sessionUpdate: Literal["plan"]
    entries: list[PlanEntry]

class AgentError(TypedDict):
    sessionUpdate: Literal["error"]
    message: str   # the harness's own message, verbatim
    fatal: bool    # True when the harness treated it as terminal for the turn

class TokenUsage(TypedDict, total=False):
    promptTokens: int        # input INCLUDING the cached and cache-written shares
    completionTokens: int
    cachedTokens: int        # the cache-read share of promptTokens
    costUsd: float           # only when the harness priced it
    extra: dict[str, Any]    # the harness's other counters, its own key names verbatim

class AgentUsage(TypedDict):
    sessionUpdate: Literal["usage"]
    scope: Literal["call", "run"]  # one LLM inference, or the harness's whole-run total
    usage: TokenUsage

SessionUpdate = Union[
    AgentMessageChunk,
    AgentThoughtChunk,
    UserMessageChunk,
    ToolCall,
    ToolCallUpdate,
    Plan,
    AgentError,
    AgentUsage,
]

# =============================================================================
# Top-Level Event
# =============================================================================

class OutputEvent(TypedDict):
    sessionId: NotRequired[str]
    update: SessionUpdate
    timestamp: NotRequired[str]         # the harness's own clock for this line, ISO 8601
    model: NotRequired[str]             # the model the harness named for this line
    messageId: NotRequired[str]         # the harness's id for the LLM message this line belongs to
    parentToolCallId: NotRequired[str]  # on a SUBAGENT's line: the parent's tool call that delegated to it
    extra: NotRequired[dict[str, Any]]  # other facts of the line, the harness's own key names (e.g. stop_reason)
```

Everything beyond `update` is optional and comes straight from the wire line the update was parsed
from — a field the harness did not print is absent, never guessed. `timestamp` is the harness's
clock (claude, gemini, opencode and droid stamp every line; qwen and kimi stamp none); `model` is
the model named on the line, or on the harness's init line for gemini and droid; `messageId` lets
you tell which lines belong to one LLM message (claude prints one line per content block, all with
the same `message.id`); `parentToolCallId` is set only on a subagent's lines and names the
`toolCallId` of the `Task`/`agent` call that spawned it.

`toolName` is the harness-native tool name, verbatim — `Bash`, `Read`, or the joined `mcp__<server>__<tool>` an MCP call carries. Prefer it over parsing `title`, which is formatted per tool for people to read and is not round-trippable; `toolName` is the identifier the model actually called. It is a deliberate addition to the ACP shape, which names no tool and whose `kind` collapses every MCP tool to `other`, and it is optional — absent on traces recorded before the SDK carried it, and on the occasional call a harness cannot name, so fall back to `kind` there.

`content` is the result text exactly as the harness sent it — a failed call's error text is not
wrapped in a code fence or prefixed; frame it in your own UI. `rawOutput` is the harness's
structured record of the same result when it prints one beyond the text: claude's
`tool_use_result` (`stdout`, `stderr`, `exitCode`, `interrupted`, or the file it wrote), codex's
completed item (`aggregated_output`, `exit_code`, `status`), opencode's tool state (`output`,
`metadata` with the exit code, `time`). Read an exit code from there rather than from prose.

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

## Event Types Summary

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `AgentMessageChunk` | `"agent_message_chunk"` | Text/image streaming from agent |
| `AgentThoughtChunk` | `"agent_thought_chunk"` | Reasoning (Codex) or thinking (Claude) |
| `UserMessageChunk` | `"user_message_chunk"` | User message echo (Gemini) |
| `ToolCall` | `"tool_call"` | Tool execution started |
| `ToolCallUpdate` | `"tool_call_update"` | Tool execution finished |
| `Plan` | `"plan"` | TodoWrite updates (replaces entire list) |
| `AgentError` | `"error"` | A failure the HARNESS reported. **Not agent work** — see below |
| `AgentUsage` | `"usage"` | Token accounting the HARNESS reported. **Not agent work** — see below |

---

## ToolKind Reference

| Kind | Tools | Icon |
|------|-------|------|
| `read` | Read, NotebookRead | :page_facing_up: |
| `edit` | Edit, Write, NotebookEdit | :pencil2: |
| `search` | Glob, Grep, LS | :mag: |
| `execute` | Bash, BashOutput, KillShell | :zap: |
| `think` | Task (subagent) | :brain: |
| `fetch` | WebFetch, WebSearch | :globe_with_meridians: |
| `switch_mode` | ExitPlanMode | :twisted_rightwards_arrows: |
| `other` | MCP tools, unknown | :grey_question: |

---

## UI Integration Example

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
        # Gemini echo - typically ignored
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

evolve.on("content", handle_event)
```

---

## Key Patterns

1. **Handle all 6 event types** — Don't silently drop unknown events
2. **Match tools by ID** — `tool_call` and `tool_call_update` share `toolCallId`
3. **Handle out-of-order** — `tool_call_update` may arrive before `tool_call`
4. **Concatenate chunks** — Message text arrives incrementally
5. **Support images** — `ContentBlock` includes `ImageContent`
6. **Use `kind` for icons** — Categorize tools visually (read, edit, execute, etc.)
7. **Identify tools by `toolName`** — The harness-native name, not the human-readable `title`; fall back to `kind` when it is absent
8. **Track `locations`** — Show affected file paths in UI
9. **Use `cast()` for narrowing** — TypedDict unions need explicit casting after checking `sessionUpdate`

---


## Harness-reported failures (`error`)

A harness can fail without the process dying, and it reports that on the same stream it uses for
output. Codex, for example, writes `{"type": "error"}` while it retries and
`{"type": "turn.failed"}` when a turn gives up — on **stdout**, while stderr says only
`Reading prompt from stdin...`. Those are surfaced as their own update so a transcript shows what
actually happened:

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
    return any(e.get("update", {}).get("sessionUpdate") not in ("error", "usage") for e in events)
```

## Harness-reported usage (`usage`)

Every harness prints its own token accounting on the stream, and it arrives as its own update so
you can meter a run without reading the raw JSON: claude and qwen print each LLM message's usage,
opencode prints each step's tokens and cost, and codex, gemini, claude, qwen and droid print a
whole-run total on their terminal line. Kimi's stream-json prints no usage at all, so a kimi run
simply has no `usage` events.

```python
{
    "messageId": "msg_01...",  # claude and qwen: the LLM message this line belongs to
    "update": {
        "sessionUpdate": "usage",
        "scope": "call",  # "call": one LLM inference; "run": the harness's total for the whole run
        "usage": {
            "promptTokens": 150,      # input INCLUDING the cached and cache-written shares
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
