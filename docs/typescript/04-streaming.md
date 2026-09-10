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
  /** The harness's own clock for this line, ISO 8601 (absent when the wire line has none). */
  timestamp?: string;
  /** The model the harness named for this line. */
  model?: string;
  /** The harness's id for the LLM message this line belongs to (claude, qwen). */
  messageId?: string;
  /** On a SUBAGENT's line: the parent's tool call that delegated to it. */
  parentToolCallId?: string;
  /** Other facts of the line under the harness's own key names (e.g. stop_reason). */
  extra?: Record<string, unknown>;
}
```

Everything beyond `update` is optional and comes straight from the wire line the update was parsed
from — a field the harness did not print is absent, never guessed. `timestamp` is the harness's
clock (claude, gemini, opencode and droid stamp every line; qwen and kimi stamp none); `model` is
the model named on the line, or on the harness's init line for gemini and droid; `messageId` lets you
tell which lines belong to one LLM message (claude prints one line per content block, all with the
same `message.id`); `parentToolCallId` is set only on a subagent's lines and names the `toolCallId`
of the `Task`/`agent` call that spawned it.

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
  | Plan
  | AgentError
  | AgentUsage;
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
  toolName?: string;
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
  /** The harness's own structured record of the result, verbatim (ACP's rawOutput). */
  rawOutput?: unknown;
}
```

`toolName` is the harness-native tool name, verbatim — `Bash`, `Read`, or the joined `mcp__<server>__<tool>` an MCP call carries. Prefer it over parsing `title`, which is formatted per tool for people to read and is not round-trippable; `toolName` is the identifier the model actually called. It is a deliberate addition to the ACP shape, which names no tool and whose `kind` collapses every MCP tool to `other`, and it is optional — absent on traces recorded before the SDK carried it, and on the occasional call a harness cannot name, so fall back to `kind` there.

`content` is the result text exactly as the harness sent it — a failed call's error text is not
wrapped in a code fence or prefixed; frame it in your own UI. `rawOutput` is the harness's
structured record of the same result when it prints one beyond the text: claude's
`tool_use_result` (`stdout`, `stderr`, `exitCode`, `interrupted`, or the file it wrote), codex's
completed item (`aggregated_output`, `exit_code`, `status`), opencode's tool state (`output`,
`metadata` with the exit code, `time`). Read an exit code from there rather than from prose.

### Plan Event

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `Plan` | `"plan"` | TodoWrite updates (replaces entire list) |
| `AgentError` | `"error"` | A failure the HARNESS reported. **Not agent work** — see below |
| `AgentUsage` | `"usage"` | Token accounting the HARNESS reported. **Not agent work** — see below |

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
7. **Identify tools by `toolName`** — The harness-native name, not the human-readable `title`; fall back to `kind` when it is absent
8. **Track `locations`** — Show affected file paths in UI

---


## Harness-reported failures (`error`)

A harness can fail without the process dying, and it reports that on the same stream it uses for
output. Codex, for example, writes `{"type":"error"}` while it retries and `{"type":"turn.failed"}`
when a turn gives up — on **stdout**, while stderr says only `Reading prompt from stdin...`. Those
are surfaced as their own update so a transcript shows what actually happened:

```typescript
interface AgentError {
  sessionUpdate: "error";
  /** The harness's own message, verbatim. */
  message: string;
  /** True when the harness treated it as terminal for the turn. */
  fatal: boolean;
}
```

**It is deliberately not a message chunk.** If you are counting "did the agent do any work",
an error must not count — otherwise a run that never reached the model looks like a run that
produced output. Use the exported predicate rather than writing the check yourself:

```typescript
import { isAgentWorkUpdate } from "@evolvingmachines/sdk";

const didWork = events.some((e) => isAgentWorkUpdate(e.update));
```

## Harness-reported usage (`usage`)

Every harness prints its own token accounting on the stream, and it arrives as its own update so
you can meter a run without reading the raw JSON: claude and qwen print each LLM message's usage,
opencode prints each step's tokens and cost, and codex, gemini, claude, qwen and droid print a
whole-run total on their terminal line. Kimi's stream-json prints no usage at all, so a kimi run
simply has no `usage` events.

```typescript
interface AgentUsage {
  sessionUpdate: "usage";
  /** "call": one LLM inference. "run": the harness's total for the whole run. */
  scope: "call" | "run";
  usage: TokenUsage;
}

interface TokenUsage {
  promptTokens?: number;      // input INCLUDING the cached and cache-written shares
  completionTokens?: number;
  cachedTokens?: number;      // the cache-read share of promptTokens
  costUsd?: number;           // only when the harness priced it (claude's total_cost_usd)
  extra?: Record<string, unknown>; // the harness's other counters, its own key names verbatim
}
```

The names are Harbor's ATIF `Metrics` fields, so a trajectory copies them without renaming. A
counter the harness did not print is absent, never `0`. Two things to know when you sum:

- A `"call"` event repeats for every line of the same `messageId` (claude prints one line per
  content block, each with the message's running usage) — keep the **last** one per `messageId`,
  then add across messages.
- A `"run"` event is the harness's own total, reported once at the end; it is not another call.

```typescript
const perMessage = new Map<string, TokenUsage>();
for (const e of events) {
  if (e.update.sessionUpdate !== "usage" || e.update.scope !== "call") continue;
  perMessage.set(e.messageId ?? `line-${perMessage.size}`, e.update.usage);
}
const promptTokens = [...perMessage.values()].reduce((n, u) => n + (u.promptTokens ?? 0), 0);
```

Like `error`, `usage` is **not agent work**: `isAgentWorkUpdate` answers `false` for it, so a
stream that carries only accounting still counts as a run that did nothing.
