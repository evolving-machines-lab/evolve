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
  browser?: {
    liveUrl: string;                 // Live browser view URL
    sessionId?: string;              // Use with sessions().browserReplay()
    sessionTag?: string;             // Use to correlate checkpoints
  };
}

type LifecycleReason =
  | "browser_ready"                  // Managed browser live view is available
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
  | "other";      // Unknown or third-party MCP tools
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

## Browser Automation Streaming

The full browser guide is [Configuration → Browser Automation](./02-configuration.md#browser-automation).
This section only documents the streaming fields for browser live view.

| Need | API | Use |
|------|-----|-----|
| Show live browser during a run | `lifecycle` event with `reason === "browser_ready"` | `event.browser.liveUrl` |
| Save the browser/session id | same lifecycle event | `event.browser.sessionId` |

### Managed Browser

Managed browser sessions emit the live-view URL as soon as the browser is ready:

```typescript
evolve.on("lifecycle", (event) => {
  if (event.reason === "browser_ready" && event.browser) {
    openLiveView(event.browser.liveUrl);
    rememberSessionId(event.browser.sessionId);
  }
});

const result = await evolve.run({ prompt: "QA the checkout flow" });
openLiveView(result.browser?.liveUrl);
```

The same URL is also stored in trace metadata for replay or embedding after the trace exists:

```typescript
type TraceMetadata = {
  browser_session_id?: string;
  dashboard_session_id?: string;
  browser_session_tag?: string;
  browser_live_url?: string;
};
```

Use `event.browser.liveUrl` or `result.browser?.liveUrl` for immediate UI display.
For replay after cleanup, use the `sessionId` with `sessions().browserReplay()`;
the full example lives in [Configuration → Browser Automation](./02-configuration.md#browser-automation).

---

## UI Integration Example

```typescript
import type { OutputEvent } from "@evolvingmachines/sdk";

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
      ui.addTool({
        id: update.toolCallId,
        title: update.title,
        kind: update.kind,
        status: update.status,
        locations: update.locations,
      });
      break;

    case "tool_call_update":
      ui.updateTool(update.toolCallId, {
        status: update.status,
        content: update.content,
      });
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

---
