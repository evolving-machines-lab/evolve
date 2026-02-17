# Runtime

Agent execution, workspace layout, file I/O, session management, and streaming events.

---

## AgentResponse

```ts
type AgentResponse = {
  sandboxId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  checkpoint?: CheckpointInfo;  // Present when .withStorage() configured — see Storage & Checkpointing
};
```

## run()

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
console.log(result.checkpoint?.id);
```

- If `timeoutMs` is omitted the agent uses the TypeScript default of 3_600_000 ms (1 hour).
- If `background` is `true`, the call returns immediately with a start handshake (`exitCode: 0`). Completion is delivered via `lifecycle` events (`run_background_complete` or `run_background_failed`), or by polling `status()`.
- If `from` is set, the SDK restores a checkpoint into a fresh sandbox before running. Pass a checkpoint ID or `"latest"`. Requires `.withStorage()`. Cannot be used with `.withSession()`.
- If `checkpointComment` is set, the auto-checkpoint is labeled with this string. Requires `.withStorage()`.
- Calling `run()` multiple times maintains the agent context / history.
- Calling `run()` while another run or command is active throws immediately. Call `interrupt()` first or wait for the active operation to finish.

## executeCommand()

Runs a direct shell command in the sandbox working directory.

```ts
const result = await evolve.executeCommand("pytest", {
    timeoutMs: 10 * 60 * 1000,                // (optional) Default 1 hour
    background: false,                         // (optional) Run in background
});
```

- If `background` is `true`, returns a start handshake (`exitCode: 0`). Completion arrives via `lifecycle` events (`command_background_complete` or `command_background_failed`).

---

## Workspace Layout

Calling `run()` or `executeCommand()` for the first time provisions a sandbox with:

```
/home/user/workspace/
├── context/     # Input files (read-only) provided by the user
├── scripts/     # Your code goes here
├── temp/        # Scratch space
├── output/      # Final deliverables
└── CLAUDE.md    # System prompt (or AGENT.md, GEMINI.md, QWEN.md depending on agent)
```

Files passed to `context` are uploaded to `context/`. Files passed to `files` are uploaded relative to the working directory.

Evolve writes default filesystem instructions to the agent's config file in the workspace. Any string passed to `systemPrompt` via the [builder](02-configuration.md) is appended after the defaults.

## Structured Output

When you provide a `schema`, Evolve instructs the agent to write structured JSON output to `output/result.json`.

```ts
import { z } from "zod";

const CREDataSchema = z.object({
    property_name: z.string(),
    units: z.number(),
    total_rent: z.number(),
    occupancy_rate: z.number(),
});

const evolve = new Evolve()
    .withSchema(CREDataSchema)
    .withContext({
        "rent_roll.pdf": fs.readFileSync("rent_roll.pdf"),
    });

await evolve.run({ prompt: "Extract CRE data from the rent roll" });

const output = await evolve.getOutputFiles();
console.log(output.data);  // { property_name: '...', units: 120, ... }
```

The SDK automatically appends a structured output prompt to the agent's config file, instructing it to save `output/result.json` matching the schema. The agent remains free to reason, read files, and use tools — only the final output must conform.

```ts
// Type-safe access to validated data
if (output.data) {
    console.log(output.data.property_name);  // TypeScript knows the shape
} else {
    console.error(output.error);             // "Schema validation failed: ..."
    console.log(output.rawData);             // Raw JSON for debugging
}
```

---

## Upload: Local → Sandbox

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

## Download: Sandbox → Local

**Flow:** `getOutputFiles()` → `saveLocalDir()`

```ts
interface OutputResult<T = unknown> {
    files: FileMap;      // All files from output/ folder
    data: T | null;      // Parsed result.json (if schema was set via withSchema())
    error?: string;      // Validation error message (if schema validation failed)
    rawData?: string;    // Raw result.json content when parse/validation failed
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
    .withSchema(ResultSchema);

await evolve.run({ prompt: "Analyze and score the document" });

const output = await evolve.getOutputFiles(true);  // recursive=true for nested dirs

saveLocalDir("./output", output.files);
console.log(output.data);   // { summary: "...", score: 85 }
console.log(output.error);  // undefined (or validation error message)
```

Files created before the last `run()` or `executeCommand()` are filtered out.

---

## Session Controls

```ts
const sessionId = evolve.getSession();  // Returns sandbox ID (string) or null (sync)

const s = evolve.status();             // Synchronous snapshot of sandbox + agent state
// s.sandbox   → "stopped" | "booting" | "ready" | "running" | "paused" | "error"
// s.agent     → "idle" | "running" | "interrupted" | "error"
// s.hasRun    → boolean (true after first run)
// s.sandboxId → string | null
// s.activeProcessId → string | null
// s.timestamp → string (ISO 8601)

const ok = await evolve.interrupt();   // Interrupts active run/command; sandbox stays alive. Returns boolean.

// Steer a running task: interrupt, then reprompt in same session
void evolve.run({ prompt: "Do a full migration plan", background: true });
await evolve.interrupt();
await evolve.run({ prompt: "Change direction: only auth migration." });

await evolve.pause();  // Suspends sandbox (stops billing, preserves state)
await evolve.resume(); // Reactivates same sandbox

await evolve.kill();   // Destroys sandbox; next run() creates a new one

await evolve.setSession("existing-sandbox-id"); // Switch to different sandbox at runtime

// Checkpointing (requires .withStorage() — see Storage & Checkpointing)
const ckpt = await evolve.checkpoint({ comment: "before refactor" });
const list = await evolve.listCheckpoints({ limit: 10 });
```

`withSession("sandbox-id")` is a builder method for initialization — it sets the sandbox ID before the first `run()`. `setSession()` is a runtime method that actively interrupts any running process, flushes the session log, resets checkpoint lineage, and switches to the new sandbox. They are **not** interchangeable: use `withSession()` when building, `setSession()` when switching mid-session.

**Provider caveats:**
- **E2B / Daytona** — full support for `pause()`, `resume()`, `interrupt()`.
- **Modal** — does not support `pause()`. `interrupt()` returns `false` for active processes.

### getHost

Expose a forwarded port:

```ts
const url = await evolve.getHost(8000);
console.log(`Workspace service available at ${url}`);
```

---

## Session Patterns

### Multi-turn conversations

```ts
const evolve = new Evolve().withAgent({...});

await evolve.run({ prompt: 'Analyze data.csv' });
const output1 = await evolve.getOutputFiles();

// Same session — automatically maintains context / history
await evolve.run({ prompt: 'Now create visualization' });
const output2 = await evolve.getOutputFiles();

await evolve.kill();
```

### Pause and resume

```ts
await evolve.run({ prompt: 'Start analysis' });
await evolve.pause();   // Suspend billing, keep state
// Do other work...
await evolve.resume();  // Reactivate same sandbox
await evolve.run({ prompt: 'Continue analysis' });
await evolve.kill();
```

### Save and reconnect (different script/session)

```ts
// Script 1: Save session
const evolve = new Evolve().withAgent({...});
await evolve.run({ prompt: 'Start analysis' });
const sessionId = evolve.getSession();
fs.writeFileSync('session.txt', sessionId);

// Script 2: Reconnect
const savedId = fs.readFileSync('session.txt', 'utf-8');
const evolve2 = new Evolve()
  .withAgent({...})
  .withSession(savedId);

await evolve2.run({ prompt: 'Continue analysis' });
```

### Switch between sandboxes

```ts
const evolve = new Evolve().withAgent({...});

await evolve.run({ prompt: 'Analyze dataset A' });
const sessionA = evolve.getSession();

await evolve.setSession('existing-sandbox-b-id');
await evolve.run({ prompt: 'Analyze dataset B' });

await evolve.setSession(sessionA);
await evolve.run({ prompt: 'Compare results' });
```

---

## Streaming Events

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

### LifecycleEvent

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

### OutputEvent + SessionUpdate

```typescript
interface OutputEvent {
  sessionId?: string;
  update: SessionUpdate;
}

type SessionUpdate =
  | MessageChunk       // agent_message_chunk, agent_thought_chunk, user_message_chunk
  | ToolCall
  | ToolCallUpdate
  | Plan;
```

### Message Events

All three message types share the same shape — only the `sessionUpdate` discriminant differs:

```typescript
interface MessageChunk {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
  content: ContentBlock;
}
```

- `agent_message_chunk` — Text/image streaming from agent
- `agent_thought_chunk` — Reasoning (Codex) or thinking (Claude)
- `user_message_chunk` — User message echo (Gemini)

### Tool Events

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

### Tool Metadata Types

**ToolKind** — tool category for UI icons:

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

> **Important:** Browser-use MCP tools have `kind: "other"`, not `"browser"` or `"fetch"`. To identify browser tools in your UI, check if `title` starts with `"browser-use:"`.

```typescript
type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

interface ToolCallLocation {
  path: string;
  line?: number;
}

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

### Browser-Use

Browser automation (`browser-use`) is included by default in Gateway mode. Browser tool responses embed a **JSON string** inside `ToolCallUpdate.content[].content.text`. You must extract and parse it.

```typescript
// Helper to detect browser-use tools (they have kind: "other")
function isBrowserUseTool(title?: string): boolean {
  return title?.toLowerCase().includes('browser-use') ?? false;
}
```

```typescript
interface BrowserUseResponse {
  task_id?: string;
  session_id?: string;
  live_url?: string;                          // VNC live view URL
  screenshot_url?: string;                    // Final screenshot URL
  steps?: Array<{
    step_number: number;
    screenshot_url?: string;
    url?: string;
    memory?: string;
  }>;
  is_success?: boolean | null;
  task_output?: string | null;
}
```

**Extraction function** (regex first for speed, JSON.parse fallback for nested access):

```typescript
function extractBrowserUseUrls(text: string): { liveUrl?: string; screenshotUrl?: string } {
  let liveUrl: string | undefined;
  let screenshotUrl: string | undefined;

  const liveMatch = text.match(/"live_url"\s*:\s*"([^"]+)"/);
  if (liveMatch) liveUrl = liveMatch[1];

  const screenshotMatch = text.match(/"screenshot_url"\s*:\s*"([^"]+)"/);
  if (screenshotMatch) screenshotUrl = screenshotMatch[1];

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
      break;  // Gemini echo — typically ignored

    case "tool_call":
      toolTitles.set(update.toolCallId, update.title);
      const effectiveKind = isBrowserUseTool(update.title) ? "browser" : update.kind;
      ui.addTool({
        id: update.toolCallId,
        title: update.title,
        kind: effectiveKind,
        status: update.status,
        locations: update.locations,
      });
      break;

    case "tool_call_update":
      ui.updateTool(update.toolCallId, {
        status: update.status,
        content: update.content,
      });

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

### Key Patterns

1. **Handle all 6 event types** — Don't silently drop unknown events
2. **Match tools by ID** — `tool_call` and `tool_call_update` share `toolCallId`
3. **Handle out-of-order** — `tool_call_update` may arrive before `tool_call`
4. **Concatenate chunks** — Message text arrives incrementally
5. **Support images** — `ContentBlock` includes `ImageContent`
6. **Use `kind` for icons** — Categorize tools visually (read, edit, execute, etc.)
7. **Track `locations`** — Show affected file paths in UI
8. **Detect browser-use by title** — Browser-use MCP tools have `kind: "other"`, check `title.includes("browser-use")`

---

**Next:** [Storage & Observability](04-storage-and-observability.md) for checkpointing and traces.
