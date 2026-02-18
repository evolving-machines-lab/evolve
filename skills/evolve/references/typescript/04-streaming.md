# Streaming Events

Real-time output from `run()` and `executeCommand()`. For basic usage, see [Getting Started](./01-getting-started.md#streaming).

---

## Event Listeners

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

---

## LifecycleEvent

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

## OutputEvent

Top-level event structure:

```typescript
interface OutputEvent {
  sessionId?: string;
  update: SessionUpdate;
}
```

---

## SessionUpdate Types

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

### Message Events

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

### Tool Events

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

### Plan Event

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

## Content Types

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

## Tool Metadata Types

### ToolKind

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

### ToolCallStatus

```typescript
type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
```

### ToolCallLocation

```typescript
interface ToolCallLocation {
  path: string;
  line?: number;
}
```

### ToolCallContent

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

---

## BrowserUseResponse

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

## UI Integration Example

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

## Key Patterns

1. **Handle all 6 event types** — Don't silently drop unknown events
2. **Match tools by ID** — `tool_call` and `tool_call_update` share `toolCallId`
3. **Handle out-of-order** — `tool_call_update` may arrive before `tool_call`
4. **Concatenate chunks** — Message text arrives incrementally
5. **Support images** — `ContentBlock` includes `ImageContent`
6. **Use `kind` for icons** — Categorize tools visually (read, edit, execute, etc.)
7. **Track `locations`** — Show affected file paths in UI
8. **Detect browser-use by title** — Browser-use MCP tools have `kind: "other"`, check `title.includes("browser-use")` to identify them

---
