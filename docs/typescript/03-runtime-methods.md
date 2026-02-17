# TypeScript SDK: Runtime Methods

> Part 3 of 5

## 3. Runtime Methods

`run()` and `executeCommand()` are async and return `AgentResponse`. `status()` is synchronous and returns `SessionStatus`. `interrupt()` returns `Promise<boolean>`.

```ts
type AgentResponse = {
  sandboxId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  checkpoint?: CheckpointInfo;  // Present when .withStorage() configured and run succeeded — see Section 5.1
};
```

### 3.1 run

Runs the agent with a given prompt. 

```ts
const result = await evolve.run({
    prompt: "Analyze the data and create a report",
    timeoutMs: 15 * 60 * 1000,                // (optional) Default 1 hour
    background: false,                         // (optional) Run in background
    from: "ckpt_abc123",                       // (optional) Restore from checkpoint ID or "latest"
    checkpointComment: "after analysis",       // (optional) Label for the auto-checkpoint
});

console.log(result.exitCode);
console.log(result.stdout);
console.log(result.checkpoint?.id);            // Checkpoint ID (if .withStorage() configured)
```

- If `timeoutMs` is omitted the agent uses the TypeScript default of 3_600_000 ms (1 hour).
- If `background` is `true`, the call returns immediately with a start handshake (`exitCode: 0`), not final completion. Completion is delivered asynchronously via `lifecycle` events (`run_background_complete` or `run_background_failed`), or by polling `status()`.
- If `from` is set, the SDK restores a checkpoint into a fresh sandbox before running. Pass a checkpoint ID or `"latest"` to restore the most recent. Requires `.withStorage()`. Cannot be used with `.withSession()`.
- If `checkpointComment` is set, the auto-checkpoint created after a successful run is labeled with this string. Requires `.withStorage()`.
- Calling `run()` multiple times maintains the agent context / history.
- Calling `run()` while another run or command is active throws immediately. Call `interrupt()` first or wait for the active operation to finish.

### 3.2 executeCommand

Runs a direct shell command in the sandbox working directory.

```ts
// Run shell command directly in sandbox
const result = await evolve.executeCommand("pytest", {
    timeoutMs: 10 * 60 * 1000,                // (optional) Default 1 hour
    background: false,                         // (optional) Run in background
});
```

- If `background` is `true`, returns a start handshake (`exitCode: 0`). Completion arrives via `lifecycle` events (`command_background_complete` or `command_background_failed`).

### 3.3 Streaming Events

`Evolve` extends Node's `EventEmitter`. Subscribe to real-time output from `run()` and `executeCommand()`:

```typescript
import { Evolve } from "@evolvingmachines/sdk";
import type { OutputEvent, LifecycleEvent } from "@evolvingmachines/sdk";

const evolve = new Evolve().withAgent({ type: "claude" });

// Parsed events (recommended)
evolve.on("content", (event: OutputEvent) => {
  console.log(event.update.sessionUpdate, event.update);
});

// Lifecycle events (sandbox + agent state transitions)
evolve.on("lifecycle", (event: LifecycleEvent) => {
  console.log(event.reason, event.sandbox, event.agent);
});

// Raw output (debugging)
evolve.on("stdout", (chunk: string) => process.stdout.write(chunk));
evolve.on("stderr", (chunk: string) => process.stderr.write(chunk));

await evolve.run({ prompt: "Hello" });
```

| Event | Type | Description |
|-------|------|-------------|
| `content` | `OutputEvent` | Parsed ACP-style events (recommended) |
| `lifecycle` | `LifecycleEvent` | Sandbox and agent state transitions |
| `stdout` | `string` | Raw JSONL output |
| `stderr` | `string` | Error output |

#### LifecycleEvent

```typescript
evolve.on("lifecycle", (event: LifecycleEvent) => {
  console.log(event.reason, event.sandboxId);
});
```

```typescript
interface LifecycleEvent {
  sandboxId: string | null;
  sandbox: SandboxLifecycleState;    // "booting" | "error" | "ready" | "running" | "paused" | "stopped"
  agent: AgentRuntimeState;          // "idle" | "running" | "interrupted" | "error"
  timestamp: string;                 // ISO 8601
  reason: LifecycleReason;
}

type LifecycleReason =
  | "sandbox_boot"                  // Sandbox is being created
  | "sandbox_ready"                 // Sandbox is ready for commands
  | "sandbox_connected"             // Reconnected to existing sandbox
  | "sandbox_pause"                 // Sandbox suspended
  | "sandbox_resume"                // Sandbox resumed
  | "sandbox_killed"                // Sandbox destroyed
  | "sandbox_error"                 // Sandbox setup failed
  | "run_start"                     // Agent run started
  | "run_complete"                  // Agent run finished successfully
  | "run_interrupted"               // Agent run was interrupted
  | "run_failed"                    // Agent run failed (non-zero exit or error)
  | "run_background_complete"       // Background run finished successfully
  | "run_background_failed"         // Background run failed
  | "command_start"                 // Shell command started
  | "command_complete"              // Shell command finished successfully
  | "command_failed"                // Shell command failed (non-zero exit)
  | "command_interrupted"           // Shell command was interrupted
  | "command_background_complete"   // Background command finished successfully
  | "command_background_failed";    // Background command failed
```

---

### OutputEvent

Top-level event structure:

```typescript
interface OutputEvent {
  sessionId?: string;
  update: SessionUpdate;
}
```

---

### SessionUpdate Types

Discriminated union on `sessionUpdate` field:

```typescript
type SessionUpdate =
  | AgentMessageChunk
  | AgentThoughtChunk
  | UserMessageChunk
  | ToolCall
  | ToolCallUpdate
  | Plan;
```

#### Message Events

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `AgentMessageChunk` | `"agent_message_chunk"` | Text/image streaming from agent |
| `AgentThoughtChunk` | `"agent_thought_chunk"` | Reasoning (Codex) or thinking (Claude) |
| `UserMessageChunk` | `"user_message_chunk"` | User message echo (Gemini) |

```typescript
interface AgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
}

interface AgentThoughtChunk {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
}

interface UserMessageChunk {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
}
```

#### Tool Events

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `ToolCall` | `"tool_call"` | Tool execution started |
| `ToolCallUpdate` | `"tool_call_update"` | Tool execution finished |

```typescript
interface ToolCall {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  rawInput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolCallUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: ToolCallStatus;
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}
```

#### Plan Event

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `Plan` | `"plan"` | TodoWrite updates (replaces entire list) |

```typescript
interface Plan {
  sessionUpdate: "plan";
  entries: PlanEntry[];
}

interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}
```

---

### Content Types

```typescript
type ContentBlock = TextContent | ImageContent;

interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;       // Base64-encoded
  mimeType: string;   // "image/png", "image/jpeg"
  uri?: string;
}
```

---

### Tool Metadata Types

#### ToolKind

Tool category for UI icons:

```typescript
type ToolKind =
  | "read"        // Read, NotebookRead
  | "edit"        // Edit, Write, NotebookEdit
  | "delete"      // (future)
  | "move"        // (future)
  | "search"      // Glob, Grep, LS
  | "execute"     // Bash, BashOutput, KillShell
  | "think"       // Task (subagent)
  | "fetch"       // WebFetch, WebSearch
  | "switch_mode" // ExitPlanMode
  | "other";      // MCP tools (including browser-use), unknown
```

> **Important:** Browser-use MCP tools have `kind: "other"`, not `"browser"` or `"fetch"`. To identify browser tools in your UI, check if `title` starts with `"browser-use:"` (e.g., `"browser-use: browser_task"`, `"browser-use: monitor_task"`).

```typescript
// Helper to detect browser-use tools
function isBrowserUseTool(title?: string): boolean {
  return title?.toLowerCase().includes('browser-use') ?? false;
}
```

#### ToolCallStatus

```typescript
type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
```

#### ToolCallLocation

```typescript
interface ToolCallLocation {
  path: string;
  line?: number;
}
```

#### ToolCallContent

```typescript
type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | DiffContent;

interface DiffContent {
  type: "diff";
  path: string;
  oldText: string | null;
  newText: string;
}
```

#### BrowserUseResponse

Browser automation (`browser-use`) is included by default in Gateway mode. Browser tool responses embed a **JSON string** inside `ToolCallUpdate.content[].content.text`. You must extract and parse it.

> **Detection:** Browser-use tools arrive with `kind: "other"` and `title` like `"browser-use: browser_task"` or `"browser-use: monitor_task"`. Use the `isBrowserUseTool(title)` helper above to identify them, then extract URLs from the tool output.

```typescript
interface BrowserUseResponse {
  task_id?: string;                           // Task ID for monitoring
  session_id?: string;                        // Browser session ID
  live_url?: string;                          // VNC live view URL
  screenshot_url?: string;                    // Final screenshot URL
  steps?: Array<{                             // Per-step screenshots
    step_number: number;
    screenshot_url?: string;
    url?: string;                             // Page URL at this step
    memory?: string;                          // Agent's reasoning
  }>;
  is_success?: boolean | null;                // Task completion status
  task_output?: string | null;                // Final task result
}
```

**Extraction function** (use regex first for speed and malformed JSON tolerance, then JSON.parse fallback for nested access):

```typescript
function extractBrowserUseUrls(text: string): { liveUrl?: string; screenshotUrl?: string } {
  let liveUrl: string | undefined;
  let screenshotUrl: string | undefined;

  // 1. Regex extraction (fast, handles malformed JSON)
  const liveMatch = text.match(/"live_url"\s*:\s*"([^"]+)"/);
  if (liveMatch) liveUrl = liveMatch[1];

  const screenshotMatch = text.match(/"screenshot_url"\s*:\s*"([^"]+)"/);
  if (screenshotMatch) screenshotUrl = screenshotMatch[1];

  // 2. JSON.parse fallback (for steps[].screenshot_url)
  if (!liveUrl || !screenshotUrl) {
    try {
      const parsed = JSON.parse(text) as BrowserUseResponse;
      if (!liveUrl) liveUrl = parsed.live_url;
      if (!screenshotUrl) screenshotUrl = parsed.screenshot_url ?? parsed.steps?.[parsed.steps.length - 1]?.screenshot_url;
    } catch {}
  }

  return { liveUrl, screenshotUrl };
}
```

---

### UI Integration Example

```typescript
import type { OutputEvent } from "@evolvingmachines/sdk";

// Helper to detect browser-use tools (they have kind: "other")
function isBrowserUseTool(title?: string): boolean {
  return title?.toLowerCase().includes('browser-use') ?? false;
}

// Track tool titles for browser detection
const toolTitles = new Map<string, string>();

function handleEvent(event: OutputEvent): void {
  const { update } = event;

  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") {
        ui.appendMessage(update.content.text);
      } else {
        ui.appendImage(update.content.data, update.content.mimeType);
      }
      break;

    case "agent_thought_chunk":
      ui.appendThought(update.content);
      break;

    case "user_message_chunk":
      // Gemini echo - typically ignored
      break;

    case "tool_call":
      // Store title for browser-use detection on updates
      toolTitles.set(update.toolCallId, update.title);

      // Determine effective kind for UI (browser-use has kind: "other")
      const effectiveKind = isBrowserUseTool(update.title) ? "browser" : update.kind;

      ui.addTool({
        id: update.toolCallId,
        title: update.title,
        kind: effectiveKind,  // Use "browser" for browser-use tools
        status: update.status,
        locations: update.locations,
      });
      break;

    case "tool_call_update":
      // 1. Always update tool card with result
      ui.updateTool(update.toolCallId, {
        status: update.status,
        content: update.content,
      });

      // 2. Extract browser-use URLs if this is a browser-use tool
      const title = toolTitles.get(update.toolCallId);
      if (isBrowserUseTool(title)) {
        for (const c of update.content ?? []) {
          if (c.type === "content" && c.content?.type === "text") {
            const urls = extractBrowserUseUrls(c.content.text);
            if (urls.liveUrl) ui.showLiveViewButton(urls.liveUrl);
            if (urls.screenshotUrl) ui.showScreenshot(urls.screenshotUrl);
          }
        }
      }
      break;

    case "plan":
      ui.renderPlan(update.entries);
      break;
  }
}

evolve.on("content", handleEvent);
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
8. **Detect browser-use by title** — Browser-use MCP tools have `kind: "other"`, check `title.includes("browser-use")` to identify them

### 3.4 Upload: Local → Sandbox

**Format:** `{ "destination": content }` — directories created automatically

| Method | Destination |
|--------|-------------|
| `uploadContext()` | `/home/user/workspace/context/{path}` |
| `uploadFiles()` | `/home/user/workspace/{path}` |

```ts
// Single file
await evolve.uploadContext({ "spec.json": JSON.stringify(data) });

// Multiple files
await evolve.uploadFiles({
  "scripts/setup.sh": "#!/bin/bash\necho hello",
  "data/input.csv": csvBuffer,
});

// From local directory (helper)
import { readLocalDir } from "@evolvingmachines/sdk";
await evolve.uploadContext(readLocalDir("./input", true));
```

> **Setup alternative:** `withContext()` and `withFiles()` use the same format but upload on first `run()` instead of immediately.

### 3.5 Download: Sandbox → Local

**Flow:** `getOutputFiles()` → `saveLocalDir()`

```ts
// Return type
interface OutputResult<T = unknown> {
    files: FileMap;      // All files from output/ folder
    data: T | null;      // Parsed result.json (if schema was set via withSchema())
    error?: string;      // Validation error message (if schema validation failed)
    rawData?: string;    // Raw result.json content when parse/validation failed (for debugging)
}
```

```ts
import { z } from "zod";
import { saveLocalDir } from "@evolvingmachines/sdk";

const ResultSchema = z.object({
    summary: z.string(),
    score: z.number(),
});

const evolve = new Evolve()
    .withAgent({...})
    .withSchema(ResultSchema);  // Agent will be prompted to write result.json

await evolve.run({ prompt: "Analyze and score the document" });

const output = await evolve.getOutputFiles(true);  // recursive=true for nested dirs

// Access all three fields
saveLocalDir("./output", output.files);  // Save files locally
console.log(output.data);                 // { summary: "...", score: 85 }
console.log(output.error);                // undefined (or validation error message)
```

- **`files`** — `FileMap` of all files from `output/` folder
- **`data`** — Parsed `result.json` validated against schema (null if no schema or validation failed)
- **`error`** — Validation error message if schema validation failed (undefined otherwise)

Files created before the last `run()` or `executeCommand()` are filtered out.

### 3.6 Session controls

```ts
const sessionId = evolve.getSession();  // Returns sandbox ID (string) or null (sync)

const s = evolve.status();             // Synchronous snapshot of sandbox + agent state
// s.sandbox   → "stopped" | "booting" | "ready" | "running" | "paused" | "error"
// s.agent     → "idle" | "running" | "interrupted" | "error"
// s.hasRun    → boolean (true after first run)
// s.sandboxId → string | null
// s.activeProcessId → string | null
// s.timestamp → string (ISO 8601)

const ok = await evolve.interrupt();   // Interrupts active run() or executeCommand() process; sandbox stays alive. Returns true/false.

// Steer a running task: interrupt, then reprompt in same session.
// The next run() auto-continues conversation history/context for this sandbox session.
void evolve.run({ prompt: "Do a full migration plan", background: true });
await evolve.interrupt();
await evolve.run({ prompt: "Change direction: only auth migration." });

await evolve.pause();  // Suspends sandbox (stops billing, preserves state)
await evolve.resume(); // Reactivates same sandbox

await evolve.kill();   // Destroys sandbox; next run() creates a new sandbox

await evolve.setSession("existing-sandbox-id"); // Sets sandbox ID; reconnection happens on next run()

// Checkpointing (requires .withStorage() — see Section 5.1)
const ckpt = await evolve.checkpoint({ comment: "before refactor" });  // Explicit snapshot of current sandbox
const list = await evolve.listCheckpoints({ limit: 10 });              // List checkpoints, newest first
```

`withSession("sandbox-id")` is a builder method for initialization—it sets the sandbox ID before the first `run()`. `setSession()` is a runtime method that actively interrupts any running process, flushes the session log, resets checkpoint lineage, and switches to the new sandbox. They are **not** interchangeable: use `withSession()` when building, `setSession()` when switching mid-session.

**Provider caveats:**
- **E2B / Daytona** — full support for `pause()`, `resume()`, `interrupt()`.
- **Modal** — does not support `pause()`. `interrupt()` is effectively unsupported and returns `false` for active processes.

### 3.7 getHost

Expose a forwarded port:

```ts
const url = await evolve.getHost(8000);
console.log(`Workspace service available at ${url}`);
```
---

