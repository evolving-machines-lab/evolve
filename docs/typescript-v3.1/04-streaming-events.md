# Streaming Events

This page covers real-time event handling for `run()` and `executeCommand()`.

## Copy/Paste UI Pattern (recommended first)

```ts
import { Evolve } from "@evolvingmachines/sdk";
import type { LifecycleEvent, OutputEvent } from "@evolvingmachines/sdk";

const evolve = new Evolve().withAgent({ type: "claude" });

function isBrowserUseTool(title?: string): boolean {
  return title?.toLowerCase().includes("browser-use") ?? false;
}

function extractBrowserUseUrls(text: string): { liveUrl?: string; screenshotUrl?: string } {
  let liveUrl: string | undefined;
  let screenshotUrl: string | undefined;

  const liveMatch = text.match(/"live_url"\s*:\s*"([^"]+)"/);
  if (liveMatch) liveUrl = liveMatch[1];

  const screenshotMatch = text.match(/"screenshot_url"\s*:\s*"([^"]+)"/);
  if (screenshotMatch) screenshotUrl = screenshotMatch[1];

  if (!liveUrl || !screenshotUrl) {
    try {
      const parsed = JSON.parse(text) as {
        live_url?: string;
        screenshot_url?: string;
        steps?: Array<{ screenshot_url?: string }>;
      };
      if (!liveUrl) liveUrl = parsed.live_url;
      if (!screenshotUrl) screenshotUrl = parsed.screenshot_url ?? parsed.steps?.[parsed.steps.length - 1]?.screenshot_url;
    } catch {}
  }

  return { liveUrl, screenshotUrl };
}

const toolTitles = new Map<string, string>();

evolve.on("content", (event: OutputEvent) => {
  const u = event.update;

  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      if (u.content.type === "text") {
        ui.appendMessage(u.content.text);
      } else {
        ui.appendImage(u.content.data, u.content.mimeType);
      }
      break;

    case "agent_thought_chunk":
      ui.appendThought(u.content);
      break;

    case "user_message_chunk":
      // Gemini echo — typically ignored in UI
      break;

    case "tool_call":
      toolTitles.set(u.toolCallId, u.title);
      ui.addTool({
        id: u.toolCallId,
        title: u.title,
        kind: isBrowserUseTool(u.title) ? "browser" : u.kind,
        status: u.status,
        locations: u.locations,
      });
      break;

    case "tool_call_update": {
      ui.updateTool(u.toolCallId, {
        status: u.status,
        content: u.content,
      });

      const title = toolTitles.get(u.toolCallId);
      if (isBrowserUseTool(title)) {
        for (const c of u.content ?? []) {
          if (c.type === "content" && c.content?.type === "text") {
            const urls = extractBrowserUseUrls(c.content.text);
            if (urls.liveUrl) ui.showLiveViewButton(urls.liveUrl);
            if (urls.screenshotUrl) ui.showScreenshot(urls.screenshotUrl);
          }
        }
      }
      break;
    }

    case "plan":
      ui.renderPlan(u.entries);
      break;
  }
});

evolve.on("lifecycle", (event: LifecycleEvent) => {
  console.log(event.reason, event.sandbox, event.agent);
});

evolve.on("stdout", (chunk: string) => process.stdout.write(chunk));

evolve.on("stderr", (chunk: string) => process.stderr.write(chunk));
```

## Event Channels

| Event | Type | Use |
|---|---|---|
| `content` | `OutputEvent` | parsed ACP-style events (main UI signal) |
| `lifecycle` | `LifecycleEvent` | sandbox and agent state transitions |
| `stdout` | `string` | raw JSONL stream (debugging/low-level adapters) |
| `stderr` | `string` | errors |

## `LifecycleEvent`

```ts
interface LifecycleEvent {
  sandboxId: string | null;
  sandbox: "booting" | "error" | "ready" | "running" | "paused" | "stopped";
  agent: "idle" | "running" | "interrupted" | "error";
  timestamp: string;
  reason: LifecycleReason;
}

type LifecycleReason =
  | "sandbox_boot"
  | "sandbox_ready"
  | "sandbox_connected"
  | "sandbox_pause"
  | "sandbox_resume"
  | "sandbox_killed"
  | "sandbox_error"
  | "run_start"
  | "run_complete"
  | "run_interrupted"
  | "run_failed"
  | "run_background_complete"
  | "run_background_failed"
  | "command_start"
  | "command_complete"
  | "command_failed"
  | "command_interrupted"
  | "command_background_complete"
  | "command_background_failed";
```

## `OutputEvent` and Session Updates

```ts
interface OutputEvent {
  sessionId?: string;
  update: SessionUpdate;
}

type SessionUpdate =
  | AgentMessageChunk
  | AgentThoughtChunk
  | UserMessageChunk
  | ToolCall
  | ToolCallUpdate
  | Plan;
```

### Message events

- `agent_message_chunk`: text/image stream from agent
- `agent_thought_chunk`: thinking/reasoning stream
- `user_message_chunk`: user echo (notably Gemini)

### Tool events

- `tool_call`: tool execution started
- `tool_call_update`: tool execution updates/completion

`tool_call` and `tool_call_update` correlate via `toolCallId`.

### Plan events

- `plan`: full replacement of todo entries

## Tool Kind Notes

```ts
type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";
```

Important:
- browser-use tools are currently `kind: "other"`
- detect browser-use via title (for example `"browser-use: browser_task"`)

## Browser-use Response Shape

Browser-use tool payload is a JSON string in `ToolCallUpdate.content[].content.text`.

```ts
interface BrowserUseResponse {
  task_id?: string;
  session_id?: string;
  live_url?: string;
  screenshot_url?: string;
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

## Robust Handling Rules

1. handle all 6 `SessionUpdate` variants
2. match tool events by `toolCallId`
3. allow out-of-order events (`tool_call_update` can arrive first)
4. concatenate message chunks
5. support `ImageContent` payloads
6. map `ToolKind` to UI icon categories
7. surface `locations` (file + line) in UI
8. special-case browser-use detection by title

## Full Type Dumps

For complete `ContentBlock`, `ToolCall*`, and related interfaces, see [Appendix: Types](./appendix-types.md).
