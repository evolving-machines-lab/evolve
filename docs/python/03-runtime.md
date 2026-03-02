# Runtime

## Methods

`run()` and `execute_command()` are async and return `AgentResponse`. `status()` is async and returns `SessionStatus`. `interrupt()` returns `bool`.

```python
@dataclass
class AgentResponse:
    sandbox_id: str
    exit_code: int
    stdout: str
    stderr: str
    checkpoint: CheckpointInfo | None  # Present when storage= configured and run succeeded

@dataclass
class SessionStatus:
    sandbox_id: str | None
    sandbox: str
    agent: str
    active_process_id: str | None
    has_run: bool
    timestamp: str
```

### run

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

### execute_command

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

### Streaming Events

Subscribe to real-time output from `run()` and `execute_command()`:

```python
evolve.on('content', lambda event: print(event['update']['sessionUpdate']))
evolve.on('lifecycle', lambda event: print(event['reason'], event['sandbox']))
```

| Event | Type | Description |
|-------|------|-------------|
| `content` | `OutputEvent` | Parsed ACP-style events (text, tools, plans) |
| `lifecycle` | `LifecycleEvent` | Sandbox and agent state transitions |
| `stdout` | `str` | Raw JSONL output |
| `stderr` | `str` | Error output |

For full type definitions, all event interfaces, browser-use detection, and UI integration example, see [Streaming Events](./04-streaming.md).

### Upload: Local → Sandbox

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

### Download: Sandbox → Local

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

### Session Controls

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

# Checkpointing (requires storage=)
ckpt = await evolve.checkpoint(comment='before refactor')   # Explicit snapshot of current sandbox
checkpoints = await evolve.list_checkpoints(limit=10)       # List checkpoints, newest first
files = await evolve.storage().download_files('latest', glob=['workspace/**/*.py'])  # Download specific files
```

`sandbox_id` is a constructor parameter for initialization—it sets the sandbox ID before the first `run()`. `set_session()` is a runtime method that actively interrupts any running process, flushes the session log, resets checkpoint lineage, and switches to the new sandbox. They are **not** interchangeable: use `sandbox_id=` when constructing, `set_session()` when switching mid-session.

**Provider caveats:**
- **E2B / Daytona** — full support for `pause()`, `resume()`, `interrupt()`.
- **Modal** — does not support `pause()`. `interrupt()` is effectively unsupported and returns `False` for active processes.

### get_host

Expose a forwarded port:

```python
url = await evolve.get_host(8000)
print(f'Workspace service available at {url}')
```
---

## Workspace & Structured Output

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

When a schema is provided, `get_output_files()` automatically validates `output/result.json` and returns `OutputResult` (see [Download: Sandbox → Local](#download-sandbox--local)).

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

## Session Management

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

## Storage & Checkpointing

> **Gateway feature** — requires `EVOLVE_API_KEY`. Storage is fully managed by Evolve; no S3 buckets or AWS credentials needed.

Persist sandbox state beyond sandbox lifetime. Checkpoints archive specific directories under `/home/user/` to Evolve-managed storage and can be restored into a fresh sandbox.

**What gets checkpointed:**
- `/home/user/workspace/` — your project files
- `/home/user/.<agent>/` — agent settings and session history (e.g. `.claude/`, `.codex/`, `.gemini/`, `.qwen/`, `.kimi/`)
- For OpenCode: XDG directories (`~/.local/share/opencode/`, `~/.config/opencode/`, `~/.local/state/opencode/`)

**Key properties:**
- **Auto-checkpoint:** Every successful `run()` with `storage=` creates a checkpoint automatically.
- **Content-addressed dedup:** Archives are hashed (SHA-256). Same content = skip upload.
- **Lineage tracking:** Each checkpoint records its `parent_id`, forming a chain across runs and restores.

### Configuration

```python
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(),  # Uses EVOLVE_API_KEY from env
)
```

### Auto-Checkpoint (via `run()`)

Every successful foreground `run()` auto-creates a checkpoint:

```python
result = await evolve.run(
    prompt='Build the report',
    checkpoint_comment='initial draft',
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
- **`from_checkpoint='latest'` edge case:** If no checkpoints exist globally (across all sessions/tags), `from_checkpoint='latest'` throws an error. Note that `'latest'` resolves to the globally newest checkpoint, not scoped to the current session tag. Use `storage().list_checkpoints()` first to check availability.

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
result = await evolve.run(
    prompt='Continue where we left off',
    from_checkpoint='ckpt_m5abc_xyz123',
)

# Or restore the most recent checkpoint
latest = await evolve.run(
    prompt='Pick up from latest state',
    from_checkpoint='latest',
)
```

- `from_checkpoint` creates a fresh sandbox, downloads the archive, verifies hash integrity, and extracts it.
- Cannot be used with `sandbox_id=` (restore requires a fresh sandbox).
- The restored checkpoint becomes the `parent_id` for the next checkpoint, maintaining lineage.
- Agent type and workspace mode must match the checkpoint (model changes are fine).

### Listing & Browsing Checkpoints

**Instance method:**

```python
checkpoints = await evolve.list_checkpoints(
    limit=10,                    # (optional) default: 100, max: 500
    tag='my-session-tag',        # (optional) filter by session tag
)
```

**Standalone `storage()` client** (no Evolve instance needed):

```python
from evolve import storage

async with storage() as store:  # Uses EVOLVE_API_KEY from env
    checkpoints = await store.list_checkpoints()
```

The `storage()` factory returns a `StorageClient` with four methods:

```python
# List checkpoints (newest first)
checkpoints = await store.list_checkpoints(limit=10, tag='my-session')

# Get a single checkpoint by ID
info = await store.get_checkpoint('ckpt_m5abc_xyz123')

# Download full checkpoint archive to a local directory
output_dir = await store.download_checkpoint('ckpt_m5abc_xyz123',
    to='./restored',   # (optional) default: cwd
    extract=True,      # (optional) default: True — set False to keep raw .tar.gz
)

# Download specific files without extracting the full archive
files = await store.download_files('ckpt_m5abc_xyz123',
    files=['workspace/output/result.json'],  # (optional) exact paths
    glob=['workspace/**/*.py'],              # (optional) glob patterns
    to='./output',                           # (optional) save to disk
)
# files is a dict[str, str | bytes] — relative path → file contents
```

Pass `'latest'` instead of a checkpoint ID to any method to resolve the most recent checkpoint.

**Downloading folders with glob patterns:**

```python
output = await store.download_files(id, glob=['workspace/output/**'])
all_files = await store.download_files(id, glob=['workspace/**'])

# Save directly to disk
await store.download_files(id, glob=['workspace/output/**'], to='./local-output')
```

> **Paths are relative to `/home/user/`** — use `workspace/...` not `/home/user/workspace/...`.

**Instance-bound `storage()` accessor:**

When you already have an Evolve instance, `evolve.storage()` returns a `StorageClient` with credentials automatically bound:

```python
store = evolve.storage()
files = await store.download_files('latest', glob=['workspace/report.*'])
```

**Standalone `list_checkpoints()`** (convenience shortcut for listing only):

```python
from evolve import list_checkpoints, StorageConfig

recent = await list_checkpoints(StorageConfig(), limit=5)
```

### Checkpoint Lineage

Each checkpoint records `parent_id`. Consecutive runs build a chain:

```python
r1 = await evolve.run(prompt='Step 1')
# r1.checkpoint.parent_id → None (first)

r2 = await evolve.run(prompt='Step 2')
# r2.checkpoint.parent_id → r1.checkpoint.id
```

Restoring from a checkpoint branches the lineage:

```python
r4 = await evolve.run(prompt='Branch from step 1', from_checkpoint=r1.checkpoint.id)
# r4.checkpoint.parent_id → r1.checkpoint.id (not r3)
```

### Type Reference

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

class StorageClient:
    async def list_checkpoints(limit=None, tag=None) -> list[CheckpointInfo]
    async def get_checkpoint(id: str) -> CheckpointInfo
    async def download_checkpoint(id: str, *, to=None, extract=True) -> str
    async def download_files(id: str, *, files=None, glob=None, to=None) -> dict[str, str | bytes]

# download_checkpoint options
to: str | None       # Output directory (default: cwd)
extract: bool        # Extract archive (default: True)

# download_files options
files: list[str] | None  # Exact file paths to extract
glob: list[str] | None   # Glob patterns to match files
to: str | None           # Save to disk (default: in-memory only)
```

### End-to-End Example

```python
from evolve import Evolve, AgentConfig, StorageConfig, storage

# 1. Create and checkpoint
async with Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(),
) as evolve:
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
    print('Parent:', r2.checkpoint.parent_id)  # → r1.checkpoint.id

# 3. Restore into fresh sandbox
async with Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(),
) as evolve2:
    r3 = await evolve2.run(
        prompt='Read report.txt — what does it say?',
        from_checkpoint=r1.checkpoint.id,
    )
    # Agent sees 'Draft v1' (not the reviewed version)

# 4. Browse checkpoints and download files (no Evolve instance needed)
async with storage() as store:
    all_checkpoints = await store.list_checkpoints()
    print(f'{len(all_checkpoints)} checkpoints (newest first)')

    files = await store.download_files('latest', glob=['workspace/report.*'])
    for path, content in files.items():
        print(f'{path}: {content}')
```

---

## Observability

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

await evolve.kill()                          # Destroys sandbox A

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

---

## Error Handling

Common errors and how to handle them:

| Error | Cause | Fix |
|-------|-------|-----|
| `No API key configured` | No `EVOLVE_API_KEY` or provider key in env | Set `EVOLVE_API_KEY` or pass `api_key`/`provider_api_key` to `AgentConfig` |
| `No sandbox provider configured` | No sandbox provider key in env | Set `E2B_API_KEY`, `MODAL_TOKEN_ID`+`SECRET`, or `DAYTONA_API_KEY` |
| `Operation already active` | Calling `run()` while another run is in progress | `await evolve.interrupt()` first, or wait for the active operation |
| `Cannot use 'from_checkpoint' with existing session` | `run(from_checkpoint=...)` with `sandbox_id=` | Checkpoint restore requires a fresh sandbox — remove `sandbox_id=` |
| `No checkpoints found` | `run(from_checkpoint='latest')` with no prior checkpoints | Create a checkpoint first, or use `list_checkpoints()` to verify |
| `Schema validation failed: ...` | Agent's `result.json` doesn't match schema | Check `output.raw_data` for the actual output; refine your prompt or schema |
| `Storage requires EVOLVE_API_KEY` | `storage=StorageConfig()` without gateway credentials | Set `EVOLVE_API_KEY` in your environment |
| Timeout (exit code -1) | Agent exceeded `timeout_ms` | Increase `timeout_ms` or simplify the prompt |

```python
# Handling schema validation errors
output = await evolve.get_output_files()
if output.error:
    print(f'Validation failed: {output.error}')
    print(f'Raw output: {output.raw_data}')  # Agent's actual JSON for debugging

# Handling run errors
try:
    result = await evolve.run(prompt='...')
    if result.exit_code != 0:
        print(f'Agent failed: {result.stderr}')
except Exception as err:
    # Raised for: no API key, no sandbox, operation conflict, restore failure
    print(err)
```

---

