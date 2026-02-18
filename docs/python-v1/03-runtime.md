## 3. Runtime Methods

`run()` and `execute_command()` are async and return `AgentResponse`. `status()` is async and returns `SessionStatus`. `interrupt()` returns `bool`.

```python
@dataclass
class AgentResponse:
    sandbox_id: str
    exit_code: int
    stdout: str
    stderr: str
    checkpoint: CheckpointInfo | None  # Present when storage= configured and run succeeded — see Section 5.1

@dataclass
class SessionStatus:
    sandbox_id: str | None
    sandbox: str
    agent: str
    active_process_id: str | None
    has_run: bool
    timestamp: str
```

### 3.1 run

Runs the agent with a given prompt.

```python
result = await evolve.run(
    prompt='Analyze the data and create a report',
    timeout_ms=15 * 60 * 1000,                # (optional) Default 1 hour
    background=False,                          # (optional) Run in background
    from_checkpoint='ckpt_abc123',             # (optional) Restore from checkpoint ID or 'latest'
    checkpoint_comment='after analysis',       # (optional) Label for the auto-checkpoint
)

print(result.exit_code)
print(result.stdout)
print(result.checkpoint.id if result.checkpoint else None)  # Checkpoint ID (if storage= configured)
```

- If `timeout_ms` is omitted the agent uses the default of 3_600_000 ms (1 hour).
- If `background` is `True`, the call returns immediately with a start handshake (`exit_code=0`), not final completion. Completion is delivered asynchronously via `lifecycle` events (`run_background_complete` or `run_background_failed`) or by polling `status()`.
- If `from_checkpoint` is set, the SDK restores a checkpoint into a fresh sandbox before running. Pass a checkpoint ID or `'latest'` to restore the most recent. Requires `storage=`. Cannot be used with `sandbox_id=`.
- If `checkpoint_comment` is set, the auto-checkpoint created after a successful run is labeled with this string. Requires `storage=`.
- Calling `run()` multiple times maintains the agent context / history.
- Calling `run()` while another run or command is active throws immediately. Call `interrupt()` first or wait for the active operation to finish.

### 3.2 execute_command

Runs a direct shell command in the sandbox working directory.

```python
# Run shell command directly in sandbox
result = await evolve.execute_command(
    command='pytest',
    timeout_ms=10 * 60 * 1000,                # (optional) Default 1 hour
    background=False,                          # (optional) Run in background
)
```

- If `background` is `True`, returns a start handshake (`exit_code=0`). Completion arrives via `lifecycle` events (`command_background_complete` or `command_background_failed`).

### 3.3 Streaming Events

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

### LifecycleEvent (TypedDict shape)

```python
class LifecycleEvent(TypedDict):
    sandbox_id: str | None
    sandbox: Literal["booting", "error", "ready", "running", "paused", "stopped"]
    agent: Literal["idle", "running", "interrupted", "error"]
    timestamp: str
    reason: Literal[
        "sandbox_boot",
        "sandbox_connected",
        "sandbox_ready",
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

### Type Definitions

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

### BrowserUseResponse Extraction

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

### Event Types Summary

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `AgentMessageChunk` | `"agent_message_chunk"` | Text/image streaming from agent |
| `AgentThoughtChunk` | `"agent_thought_chunk"` | Reasoning (Codex) or thinking (Claude) |
| `UserMessageChunk` | `"user_message_chunk"` | User message echo (Gemini) |
| `ToolCall` | `"tool_call"` | Tool execution started |
| `ToolCallUpdate` | `"tool_call_update"` | Tool execution finished |
| `Plan` | `"plan"` | TodoWrite updates (replaces entire list) |

---

### ToolKind Reference

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

### UI Integration Example

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

### Key Patterns

1. **Handle all 6 event types** — Don't silently drop unknown events
2. **Match tools by ID** — `tool_call` and `tool_call_update` share `toolCallId`
3. **Handle out-of-order** — `tool_call_update` may arrive before `tool_call`
4. **Concatenate chunks** — Message text arrives incrementally
5. **Support images** — `ContentBlock` includes `ImageContent`
6. **Use `kind` for icons** — Categorize tools visually (read, edit, execute, etc.)
7. **Track `locations`** — Show affected file paths in UI
8. **Use `cast()` for narrowing** — TypedDict unions need explicit casting after checking `sessionUpdate`
9. **Detect browser-use by title** — Browser-use MCP tools have `kind="other"`, check `"browser-use" in title.lower()` to identify them

### 3.4 Upload: Local → Sandbox

**Format:** `{"destination": content}` — directories created automatically

| Method | Destination |
|--------|-------------|
| `upload_context()` | `/home/user/workspace/context/{path}` |
| `upload_files()` | `/home/user/workspace/{path}` |

```python
# Single file
await evolve.upload_context({'spec.json': json.dumps(data)})

# Multiple files
await evolve.upload_files({
    'scripts/setup.sh': '#!/bin/bash\necho hello',
    'data/input.csv': csv_bytes,
})

# From local directory (helper)
from evolve import read_local_dir
await evolve.upload_context(read_local_dir('./input', recursive=True))
```

> **Setup alternative:** Constructor parameters `context` and `files` use the same format but upload on first `run()` instead of immediately.

### 3.5 Download: Sandbox → Local

**Flow:** `get_output_files()` → `save_local_dir()`

```python
# Return type
@dataclass
class OutputResult:
    files: dict          # All files from output/ folder
    data: Any | None     # Parsed result.json (if schema was set via schema=)
    error: str | None    # Validation error message (if schema validation failed)
    raw_data: str | None # Raw result.json content when parse/validation failed (for debugging)
```

```python
from pydantic import BaseModel
from evolve import Evolve, save_local_dir

class ResultSchema(BaseModel):
    summary: str
    score: float

evolve = Evolve(
    config=AgentConfig(...),
    schema=ResultSchema,  # Agent will be prompted to write result.json
)

await evolve.run(prompt='Analyze and score the document')

output = await evolve.get_output_files(recursive=True)  # recursive=True for nested dirs

# Access all fields
save_local_dir('./output', output.files)  # Save files locally
print(output.data)                         # ResultSchema(summary='...', score=85.0)
print(output.error)                        # None (or validation error message)
```

- **`files`** — dict of all files from `output/` folder
- **`data`** — Parsed `result.json` validated against schema (None if no schema or validation failed). For Pydantic schemas, returns a model instance.
- **`error`** — Validation error message if schema validation failed (None otherwise)
- **`raw_data`** — Raw result.json content when parse/validation failed (for debugging)

Files created before the last `run()` or `execute_command()` are filtered out.

### 3.6 Session controls

```python
session_id = await evolve.get_session()  # Returns sandbox ID (str) or None

status = await evolve.status()  # Runtime status snapshot
# status.sandbox           -> "stopped" | "booting" | "ready" | "running" | "paused" | "error"
# status.agent             -> "idle" | "running" | "interrupted" | "error"
# status.has_run           -> bool
# status.sandbox_id        -> str | None
# status.active_process_id -> str | None
# status.timestamp         -> str (ISO 8601)

ok = await evolve.interrupt()  # Interrupts active run() or execute_command() process; keeps sandbox alive. Returns bool.

# Steer a running task: interrupt, then reprompt in same session.
# The next run() auto-continues conversation history/context for this sandbox session.
await evolve.run(prompt='Do a full migration plan', background=True)
await evolve.interrupt()
await evolve.run(prompt='Change direction: only auth migration.')

await evolve.pause()   # Suspends sandbox (stops billing, preserves state)
await evolve.resume()  # Reactivates same sandbox

await evolve.kill()    # Destroys sandbox; next run() creates a new sandbox

await evolve.set_session('existing-sandbox-id')  # Sets sandbox ID; reconnection happens on next run()

# Checkpointing (requires storage= — see Section 5.1)
ckpt = await evolve.checkpoint(comment='before refactor')   # Explicit snapshot of current sandbox
checkpoints = await evolve.list_checkpoints(limit=10)       # List checkpoints, newest first
```

`sandbox_id` is a constructor parameter for initialization—it sets the sandbox ID before the first `run()`. `set_session()` is a runtime method that actively interrupts any running process, flushes the session log, resets checkpoint lineage, and switches to the new sandbox. They are **not** interchangeable: use `sandbox_id=` when constructing, `set_session()` when switching mid-session.

**Provider caveats:**
- **E2B / Daytona** — full support for `pause()`, `resume()`, `interrupt()`.
- **Modal** — does not support `pause()`. `interrupt()` is effectively unsupported and returns `False` for active processes.

### 3.7 get_host

Expose a forwarded port:

```python
url = await evolve.get_host(8000)
print(f'Workspace service available at {url}')
```
---

## 4. Workspace Setup & Structured Output

Calling `run` or `execute_command` for the first time provisions a sandbox with the following filesystem:

```
/home/user/workspace/
├── context/     # Input files (read-only) provided by the user
├── scripts/     # Your code goes here
├── temp/        # Scratch space
├── output/      # Final deliverables
└── CLAUDE.md    # System prompt (or AGENT.md, GEMINI.md, QWEN.md depending on agent)
```

Files passed to `context` are uploaded to `context/`. Files passed to `files` are uploaded relative to the working directory.

## Filesystem Instructions
Evolve writes a default filesystem instructions to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`):

```
## FILESYSTEM INSTRUCTIONS

You are running in a sandbox environment.

Present working directory: /home/user/workspace/

IMPORTANT - Directory structure:
/home/user/workspace/
├── context/   # Input files (read-only) provided by the user
├── scripts/   # Your code goes here
├── temp/      # Scratch space
└── output/    # Final deliverables

## OUTPUT RESULTS (DELIVERABLES) MUST BE SAVED to `output/` as files.
```

Any string passed to `system_prompt` is automatically appended to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`) after this default.

## Structured Output

When you provide a `schema`, Evolve instructs the agent to write structured JSON output.

```python
from pydantic import BaseModel

class CREData(BaseModel):
    property_name: str
    units: int
    total_rent: float
    occupancy_rate: float

evolve = Evolve(
    schema=CREData,
    context={
        'rent_roll.pdf': open('rent_roll.pdf', 'rb').read(),
    },
)

await evolve.run(prompt='Extract CRE data from the rent roll')

output = await evolve.get_output_files()
print(output.data)  # CREData(property_name='...', units=120, ...)
```

When a schema is provided, `get_output_files()` automatically validates `output/result.json` and returns `OutputResult` (see [Section 3.5](#35-download-sandbox--local)).

```python
# Type-safe access to validated data
if output.data:
    print(output.data.property_name)  # Pydantic model instance
else:
    print(output.error)               # "Schema validation failed: ..."
    print(output.raw_data)            # Raw JSON for debugging
```

The SDK automatically appends the following to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`):

~~~
## STRUCTURED OUTPUT

Your final result MUST be saved to `output/result.json` following this schema:

```json
{
  "type": "object",
  "properties": {
    "property_name": { "type": "string" },
    "units": { "type": "integer" },
    "total_rent": { "type": "number" },
    "occupancy_rate": { "type": "number" }
  },
  "required": ["property_name", "units", "total_rent", "occupancy_rate"]
}
```

You are free to:
- Reason through the problem step by step
- Read and analyze context files
- Use any available tools
- Process incrementally
- Create intermediate files in `temp/` or `scripts/`

But your final `output/result.json` MUST conform to the schema above.

### OUTPUT RESULTS (DELIVERABLES) MUST BE WRITTEN to `output/result.json` as files.
### Never just state results as text.
~~~

---

## 5. Cleaning up and session management

**Multi-turn conversations** (most common):

```python
evolve = Evolve(
    config=AgentConfig(...),
)

await evolve.run(prompt='Analyze data.csv')
output = await evolve.get_output_files()

# Still same session, automatically maintains context / history
await evolve.run(prompt='Now create visualization')
output2 = await evolve.get_output_files()

# Still same session, automatically maintains context / history
await evolve.run(prompt='Export to PDF')
output3 = await evolve.get_output_files()

await evolve.kill()  # When done
```

**One-shot tasks** (automatic cleanup):

```python
async with evolve:
    result = await evolve.run(prompt='...')
    output = await evolve.get_output_files()
# Calls kill() automatically via __aexit__()
```

**Pause and resume** (same instance):

```python
evolve = Evolve(
    config=AgentConfig(...),
)

await evolve.run(prompt='Start analysis')
await evolve.pause()  # Suspend billing, keep state
# Do other work...
await evolve.resume()  # Reactivate same sandbox
await evolve.run(prompt='Continue analysis')  # Session intact

await evolve.kill()  # Kill the Sandbox when done
```

**Save and reconnect** (different script/session):

```python
# Script 1: Save session for later
evolve = Evolve(
    config=AgentConfig(...),
)

await evolve.run(prompt='Start analysis')

session_id = await evolve.get_session()
# Save to file, database, environment variable, etc.
with open('session.txt', 'w') as f:
    f.write(session_id)

# Script 2: Reconnect to saved session
with open('session.txt') as f:
    saved_id = f.read()

evolve2 = Evolve(
    config=AgentConfig(...),
    sandbox_id=saved_id  # Reconnect
)

await evolve2.run(prompt='Continue analysis')  # Session continues from Script 1
```

**Switch between sandboxes** (same instance):

```python
evolve = Evolve(
    config=AgentConfig(...),
)

# Work with first sandbox
await evolve.run(prompt='Analyze dataset A')
session_a = await evolve.get_session()

# Switch to different sandbox
await evolve.set_session('existing-sandbox-b-id')
await evolve.run(prompt='Analyze dataset B')  # Now working with sandbox B

# Switch back to first sandbox
await evolve.set_session(session_a)
await evolve.run(prompt='Compare results')  # Back to sandbox A
```

---

## 5.1 Storage & Checkpointing

Persist sandbox state beyond sandbox lifetime. Checkpoints archive specific directories under `/home/user/` to S3-compatible storage and can be restored into a fresh sandbox.

**What gets checkpointed:**
- `/home/user/workspace/` — your project files
- `/home/user/.<agent>/` — agent settings and session history (e.g. `.claude/`, `.codex/`, `.gemini/`, `.qwen/`, `.kimi/`)
- For OpenCode: XDG directories (`~/.local/share/opencode/`, `~/.config/opencode/`, `~/.local/state/opencode/`)

- **Auto-checkpoint:** Every successful `run()` with `storage=` creates a checkpoint automatically.
- **Content-addressed dedup:** Archives are hashed (SHA-256). Same content = skip upload.
- **Lineage tracking:** Each checkpoint records its `parent_id`, forming a chain across runs and restores.

### Modes

| | BYOK | Gateway |
|---|------|---------|
| Setup | `storage=StorageConfig(url='s3://...')` + AWS credentials | `storage=StorageConfig()` + `EVOLVE_API_KEY` |
| Storage | Your S3/R2/MinIO bucket | Evolve-managed |
| Metadata | JSON files in S3 | Dashboard database |

### Configuration

```python
from evolve import Evolve, AgentConfig, StorageConfig, StorageCredentials

# BYOK — your own S3 bucket
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(
        url='s3://my-bucket/agent-snapshots/',  # S3 URL (bucket + prefix)
        region='us-west-2',                      # (optional) Default: AWS_REGION env or us-east-1
    ),
)

# BYOK — Cloudflare R2 / MinIO / custom endpoint
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(
        url='s3://my-bucket/prefix/',
        endpoint='https://acct.r2.cloudflarestorage.com',
    ),
)

# Gateway — Evolve-managed storage (no S3 credentials needed)
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(),  # Reads EVOLVE_API_KEY from env
)
```

**StorageConfig:**

```python
@dataclass
class StorageConfig:
    url: str | None = None          # 's3://bucket/prefix' or 'https://endpoint/bucket/prefix'
    bucket: str | None = None       # Explicit bucket (overrides URL parsing)
    prefix: str | None = None       # Key prefix (overrides URL parsing)
    region: str | None = None       # AWS region (default: AWS_REGION env or 'us-east-1')
    endpoint: str | None = None     # Custom S3 endpoint (R2, MinIO, GCS)
    credentials: StorageCredentials | None = None  # StorageCredentials(access_key_id='...', secret_access_key='...') (default: AWS SDK chain)
```

**BYOK prerequisites:**

```bash
# The Python SDK bridges to Node.js — AWS SDK packages must be installed for BYOK storage
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

# Set credentials (or use any method supported by the AWS SDK credential chain)
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
```

> The AWS SDK packages are loaded dynamically at runtime by the Node.js bridge. If they are not installed, the SDK throws a clear error with install instructions.

### Auto-Checkpoint (via `run()`)

Every successful foreground `run()` auto-creates a checkpoint:

```python
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(url='s3://my-bucket/snapshots/'),
)

result = await evolve.run(
    prompt='Build the report',
    checkpoint_comment='initial draft',  # (optional) Label
)

print(result.checkpoint.id)       # 'ckpt_m5abc_xyz123'
print(result.checkpoint.hash)     # SHA-256 of archive
print(result.checkpoint.comment)  # 'initial draft'
```

**Behavior notes:**

- **Non-fatal:** Auto-checkpoint failures are logged but never cause `run()` to throw. The run result will have `checkpoint` as `None`.
- **Foreground only:** Background runs (`background=True`) skip auto-checkpointing entirely.
- **Exclusions:** The archive excludes `node_modules/`, `__pycache__/`, `*.pyc`, `.cache/`, `.npm/`, `.pip/`, `.venv/`, `venv/`, and `{workspace}/temp/` to keep snapshots lean.
- **Dedup:** Archives are content-addressed by SHA-256 hash. If the hash matches an existing archive in storage, the upload is skipped—only the metadata entry is written.
- **`from_checkpoint='latest'` edge case:** If no checkpoints exist globally (across all sessions/tags), `from_checkpoint='latest'` throws an error. Note that `'latest'` resolves to the globally newest checkpoint, not scoped to the current session tag. Use `list_checkpoints()` first to check availability.

### Explicit Checkpoint

Snapshot at any point (between runs, after manual setup, etc.):

```python
ckpt = await evolve.checkpoint(comment='before refactor')
print(ckpt.id)  # 'ckpt_m5def_abc456'
```

Requires an active sandbox (`run()` must have been called first).

### Restore from Checkpoint

Pass `from_checkpoint` to `run()` to restore a checkpoint into a fresh sandbox before running:

```python
# Restore by checkpoint ID
result = await evolve.run(
    prompt='Continue where we left off',
    from_checkpoint='ckpt_m5abc_xyz123',
)

# Restore the most recent checkpoint
result = await evolve.run(
    prompt='Pick up from latest state',
    from_checkpoint='latest',
)
```

- `from_checkpoint` creates a fresh sandbox, downloads the archive, verifies hash integrity, and extracts it.
- Cannot be used with `sandbox_id=` (restore requires a fresh sandbox).
- The restored checkpoint becomes the `parent_id` for the next checkpoint, maintaining lineage.
- Agent type and workspace mode must match the checkpoint (model changes are fine).

### Listing Checkpoints

**Instance method** (uses storage config from `storage=`):

```python
checkpoints = await evolve.list_checkpoints(
    limit=10,                    # (optional) Max results (default: 100, max: 500)
    tag='my-session-tag',        # (optional) Filter by session tag
)

for ckpt in checkpoints:
    print(ckpt.id, ckpt.comment, ckpt.timestamp)
```

**Standalone function** (no Evolve instance needed):

```python
from evolve import list_checkpoints, StorageConfig

# BYOK — same limit=/tag= options as evolve.list_checkpoints()
all_checkpoints = await list_checkpoints(
    StorageConfig(url='s3://my-bucket/snapshots/'),
    limit=10, tag='my-session',
)

# Gateway (reads EVOLVE_API_KEY from env)
recent = await list_checkpoints(StorageConfig(), limit=5)
```

Results are sorted newest first.

### Checkpoint Lineage

Each checkpoint records `parent_id`—the checkpoint it was created from. Consecutive runs build a chain:

```python
r1 = await evolve.run(prompt='Step 1')
# r1.checkpoint.parent_id → None (first checkpoint)

r2 = await evolve.run(prompt='Step 2')
# r2.checkpoint.parent_id → r1.checkpoint.id

r3 = await evolve.run(prompt='Step 3')
# r3.checkpoint.parent_id → r2.checkpoint.id
```

Restoring from a checkpoint sets that checkpoint as the parent for subsequent checkpoints:

```python
# Later: restore from r1 and branch
r4 = await evolve.run(prompt='Branch from step 1', from_checkpoint=r1.checkpoint.id)
# r4.checkpoint.parent_id → r1.checkpoint.id (not r3)
```

### CheckpointInfo

```python
@dataclass
class CheckpointInfo:
    id: str                       # Checkpoint ID — pass as from_checkpoint to restore
    hash: str                     # SHA-256 of tar.gz archive
    tag: str                      # Session tag at checkpoint time
    timestamp: str                # ISO 8601
    size_bytes: int | None        # Archive size in bytes
    agent_type: str | None        # 'claude' | 'codex' | 'gemini' | 'qwen' | 'kimi' | 'opencode'
    model: str | None             # Model used
    workspace_mode: str | None    # 'knowledge' | 'swe'
    parent_id: str | None         # Parent checkpoint ID (lineage)
    comment: str | None           # User-provided label
```

### End-to-End Example

```python
from evolve import Evolve, AgentConfig, StorageConfig, list_checkpoints

# 1. Create and checkpoint
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(url='s3://my-bucket/project/'),
)

r1 = await evolve.run(
    prompt="Create a file called report.txt with 'Draft v1'",
    checkpoint_comment='initial draft',
)
print('Checkpoint 1:', r1.checkpoint.id)

# 2. Second run — auto-chains parent_id
r2 = await evolve.run(
    prompt="Append ' - reviewed' to report.txt",
    checkpoint_comment='reviewed',
)
print('Checkpoint 2:', r2.checkpoint.id)
print('Parent:', r2.checkpoint.parent_id)  # → r1.checkpoint.id

await evolve.kill()

# 3. Restore into fresh sandbox
evolve2 = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(url='s3://my-bucket/project/'),
)

r3 = await evolve2.run(
    prompt='Read report.txt — what does it say?',
    from_checkpoint=r1.checkpoint.id,  # Restore from checkpoint 1
)
# Agent sees 'Draft v1' (not the reviewed version)

await evolve2.kill()

# 4. List all checkpoints
all_checkpoints = await list_checkpoints(StorageConfig(url='s3://my-bucket/project/'))
print(f'{len(all_checkpoints)} checkpoints (newest first)')
```

---

## 6. Observability

Full execution traces—including tool calls, file operations (read/write/edit), text responses, and reasoning chunks—are logged to your Evolve dashboard at **https://dashboard.evolvingmachines.ai/traces** for debugging and replay.

Additionally, every run and command is logged locally to structured JSON lines under `~/.evolve-sdk/observability/sessions`. File name format:

```
{tag}_{provider}_{sandboxId}_{agent}_{timestamp}.jsonl
```

- `{tag}` – `my-prefix-` + 16 random hex characters (e.g. `my-prefix-a1b2c3d4e5f6g7h8`)
- `{provider}` – the sandbox provider (e.g. `e2b`)
- `{sandboxId}` – the active sandbox ID
- `{agent}` – the agent type (`codex`, `claude`, `gemini`, `qwen`, `kimi`, `opencode`)
- `{timestamp}` – ISO timestamp with `:` and `.` replaced by `-`

Each file contains three entry types:

```json
{"_meta":{"tag":"my-prefix-a1b2c3d4","provider":"e2b","agent":"qwen","model":"qwen-coder-plus-latest","sandbox_id":"sbx_123","timestamp":"2025-10-26T20:15:17.984Z"}}
{"_prompt":{"text":"hello how are you?"}}
{"jsonrpc":"2.0","method":"session/update", ...}
```

- `_meta` – exactly one line per file (sandbox, agent, timestamp)
- `_prompt` – one line per `run()` call with the prompt text
- Raw JSON – every streamed payload (ACP notifications, stdout, etc.)

Attach your own prefix to make logs easy to search:

```python
evolve = Evolve(
    config=AgentConfig(...),
    session_tag_prefix='my-project'
)

await evolve.run(prompt='Kick off analysis')

print(await evolve.get_session_tag())        # "my-project-ab12cd34"
print(await evolve.get_session_timestamp())  # Timestamp for first log file

await evolve.kill()                          # Flushes log file for sandbox A

await evolve.run(prompt='Start fresh')       # New sandbox → new log file

print(await evolve.get_session_tag())        # "my-project-f56789cd"
print(await evolve.get_session_timestamp())  # Timestamp for second log file
```

- `kill()` or `set_session()` flushes the current log; the next `run()` starts a
  fresh file with the new sandbox id.
- Long-running sessions (pause/resume or ACP auto-resume) keep appending to the
  current file, so you always have the full timeline.
- Logging is buffered inside the SDK, so it never blocks streaming output.

Use the tag together with the sandbox id to correlate logs with files saved in
`/output/`.

