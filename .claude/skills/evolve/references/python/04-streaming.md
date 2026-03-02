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
    reason: Literal[
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
from typing import TypedDict, Literal, Union, NotRequired

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
    "other",       # MCP tools (including browser-use), unknown
]

# IMPORTANT: Browser-use MCP tools have kind="other", not "browser" or "fetch".
# To identify browser tools in your UI, check if title starts with "browser-use:"
# (e.g., "browser-use: browser_task", "browser-use: monitor_task")

def is_browser_use_tool(title: str | None) -> bool:
    """Helper to detect browser-use tools."""
    return "browser-use" in (title or "").lower()

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

PlanEntryStatus = Literal["pending", "in_progress", "completed"]

class PlanEntry(TypedDict):
    content: str
    status: PlanEntryStatus
    priority: Literal["high", "medium", "low"]

class Plan(TypedDict):
    sessionUpdate: Literal["plan"]
    entries: list[PlanEntry]

SessionUpdate = Union[
    AgentMessageChunk,
    AgentThoughtChunk,
    UserMessageChunk,
    ToolCall,
    ToolCallUpdate,
    Plan,
]

# =============================================================================
# Top-Level Event
# =============================================================================

class OutputEvent(TypedDict):
    sessionId: NotRequired[str]
    update: SessionUpdate

# =============================================================================
# Browser-Use Response (First-Party Integration)
# =============================================================================

class BrowserUseResponse(TypedDict):
    """Browser automation response embedded in ToolCallUpdate.content[].content.text as JSON string."""
    task_id: NotRequired[str]         # Task ID for monitoring
    session_id: NotRequired[str]      # Browser session ID
    live_url: NotRequired[str]        # VNC live view URL
    screenshot_url: NotRequired[str]  # Final screenshot URL
    steps: NotRequired[list[dict]]    # Per-step screenshots with url, memory, screenshot_url
    is_success: NotRequired[bool]     # Task completion status
    task_output: NotRequired[str]     # Final task result
```

---

## BrowserUseResponse Extraction

Browser automation (`browser-use`) is included by default in Gateway mode. Browser tool responses embed a **JSON string** inside `ToolCallUpdate["content"][].content.text`. You must extract and parse it.

> **Detection:** Browser-use tools arrive with `kind="other"` and `title` like `"browser-use: browser_task"` or `"browser-use: monitor_task"`. Use `is_browser_use_tool(title)` to identify them, then extract URLs from the tool output.

**Extraction function** (use regex first for speed and malformed JSON tolerance, then JSON fallback):

```python
import re
import json
from typing import Optional

def extract_browser_use_urls(text: str) -> dict[str, Optional[str]]:
    """Extract browser-use URLs from tool response text.

    Returns:
        {"live_url": str | None, "screenshot_url": str | None}
    """
    live_url: Optional[str] = None
    screenshot_url: Optional[str] = None

    # 1. Regex extraction (fast, handles malformed JSON)
    live_match = re.search(r'"live_url"\s*:\s*"([^"]+)"', text)
    if live_match:
        live_url = live_match.group(1)

    screenshot_match = re.search(r'"screenshot_url"\s*:\s*"([^"]+)"', text)
    if screenshot_match:
        screenshot_url = screenshot_match.group(1)

    # 2. JSON fallback (for steps[].screenshot_url)
    if not live_url or not screenshot_url:
        try:
            parsed: BrowserUseResponse = json.loads(text)
            if not live_url:
                live_url = parsed.get("live_url")
            if not screenshot_url:
                steps = parsed.get("steps", [])
                screenshot_url = parsed.get("screenshot_url") or (
                    steps[-1].get("screenshot_url") if steps else None
                )
        except (json.JSONDecodeError, IndexError, KeyError):
            pass

    return {"live_url": live_url, "screenshot_url": screenshot_url}
```

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

        # 1. Always update tool card with result
        ui.update_tool(
            update_data["toolCallId"],
            status=update_data.get("status"),
            content=update_data.get("content"),
        )

        # 2. Extract browser-use URLs if present (first-party integration)
        for c in update_data.get("content") or []:
            if c.get("type") == "content":
                inner = c.get("content", {})
                if inner.get("type") == "text":
                    urls = extract_browser_use_urls(inner["text"])
                    if urls["live_url"]:
                        ui.show_live_view_button(urls["live_url"])
                    if urls["screenshot_url"]:
                        ui.show_screenshot(urls["screenshot_url"])

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
7. **Track `locations`** — Show affected file paths in UI
8. **Use `cast()` for narrowing** — TypedDict unions need explicit casting after checking `sessionUpdate`
9. **Detect browser-use by title** — Browser-use MCP tools have `kind="other"`, check `"browser-use" in title.lower()` to identify them

---
