# Streaming

## At a Glance

- Subscribe to `content` for parsed session updates.
- Subscribe to `lifecycle` for sandbox/agent state transitions.
- `stdout`/`stderr` are raw channels.

## Event Channels

| Event | Type | Purpose |
|---|---|---|
| `content` | `OutputEvent` | parsed ACP-style updates (recommended for UI) |
| `lifecycle` | `LifecycleEvent` | runtime state transitions |
| `stdout` | `string` | raw JSONL stream |
| `stderr` | `string` | errors |

## Copy/Paste UI Handler

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
      break;
    case "agent_thought_chunk":
      break;
    case "user_message_chunk":
      break;
    case "tool_call":
      toolTitles.set(u.toolCallId, u.title);
      break;
    case "tool_call_update": {
      const title = toolTitles.get(u.toolCallId);
      if (isBrowserUseTool(title)) {
        for (const c of u.content ?? []) {
          if (c.type === "content" && c.content?.type === "text") {
            const urls = extractBrowserUseUrls(c.content.text);
            if (urls.liveUrl) console.log("Live:", urls.liveUrl);
            if (urls.screenshotUrl) console.log("Shot:", urls.screenshotUrl);
          }
        }
      }
      break;
    }
    case "plan":
      break;
  }
});

evolve.on("lifecycle", (event: LifecycleEvent) => {
  console.log(event.reason, event.sandbox, event.agent);
});

evolve.on("stdout", (chunk: string) => process.stdout.write(chunk));
evolve.on("stderr", (chunk: string) => process.stderr.write(chunk));
```

## Lifecycle States and Reasons

`LifecycleEvent` includes:
- sandbox state: `booting | error | ready | running | paused | stopped`
- agent state: `idle | running | interrupted | error`
- reason: run/command/sandbox transition reason

Important background reasons:
- `run_background_complete`
- `run_background_failed`
- `command_background_complete`
- `command_background_failed`

## `content` Session Update Types

`SessionUpdate` is one of:
- `agent_message_chunk`
- `agent_thought_chunk`
- `user_message_chunk`
- `tool_call`
- `tool_call_update`
- `plan`

## Browser-Use Notes

- Browser-use tools currently arrive as `kind: "other"`.
- Detect browser-use by title containing `browser-use`.
- Browser payload is JSON text in `ToolCallUpdate.content[].content.text`.

## Robust Parsing Rules

1. handle all session update variants
2. correlate tool events by `toolCallId`
3. support out-of-order events
4. concatenate chunked text
5. support image content blocks
6. expose `locations` in UI for file references

## Full Contracts

See [10 Reference](./10-reference.md) for exhaustive definitions:
- `LifecycleEvent`, `OutputEvent`, `SessionUpdate`
- `ToolKind`, `ToolCall*`, `ContentBlock`
- `BrowserUseResponse`
