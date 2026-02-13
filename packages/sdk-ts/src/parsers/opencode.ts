/**
 * OpenCode JSONL → ACP-style events parser.
 *
 * Native format: `opencode run --format json` outputs JSONL to stdout.
 * Each line is a JSON object with a `type` field.
 *
 * OpenCode event types:
 * - "step_start"  → lifecycle (skip)
 * - "text"        → agent_message_chunk
 * - "tool_use"    → tool_call + tool_call_update (tools arrive completed)
 * - "step_finish" → lifecycle (skip)
 * - "error"       → agent_message_chunk (error text)
 *
 * Key difference: tool_use events arrive already completed (status="completed"),
 * so we emit both tool_call (pending) and tool_call_update (completed/failed)
 * from a single event.
 *
 * Reference: KNOWLEDGE/opencode/packages/opencode/src/cli/cmd/run.ts (emit() function, event handlers)
 * ACP output: parsers/types.ts (OutputEvent, SessionUpdate)
 */

import {
  OutputEvent,
  SessionUpdate,
  ToolKind,
  ToolCallContent,
  ToolCallLocation,
} from "./types";

/** Map OpenCode tool names to ACP ToolKind */
const TOOL_KINDS: Record<string, ToolKind> = {
  // File operations
  read: "read",
  write: "edit",
  edit: "edit",
  apply_patch: "edit",
  // Shell
  bash: "execute",
  // Search
  glob: "search",
  grep: "search",
  list: "search",
  codesearch: "search",
  // Web
  webfetch: "fetch",
  websearch: "fetch",
  // Agent/planning
  task: "think",
  todoread: "other",
  todowrite: "other",
  skill: "other",
};

/**
 * Create an OpenCode parser instance.
 */
export function createOpenCodeParser(): (jsonLine: string) => OutputEvent[] | null {
  return function parseOpenCodeEvent(jsonLine: string): OutputEvent[] | null {
    let data: any;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }

    if (!data || typeof data !== "object") return null;

    const sessionId = data.sessionID;
    const events: OutputEvent[] = [];

    switch (data.type) {
      // Lifecycle - skip
      case "step_start":
      case "step_finish":
        return null;

      // Text content from agent
      case "text": {
        const update = handleText(data);
        if (update) events.push({ sessionId, update });
        break;
      }

      // Tool use (arrives already completed)
      case "tool_use": {
        const updates = handleToolUse(data);
        for (const update of updates) {
          events.push({ sessionId, update });
        }
        break;
      }

      // Error events
      case "error": {
        const update = handleError(data);
        if (update) events.push({ sessionId, update });
        break;
      }

      default:
        return null;
    }

    return events.length > 0 ? events : null;
  };

  /**
   * Handle text events
   * { type: "text", part: { text: string, time: { start, end } } }
   */
  function handleText(data: any): SessionUpdate | null {
    const text = data.part?.text;
    if (typeof text !== "string" || text.length === 0) return null;

    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    };
  }

  /**
   * Handle tool_use events
   *
   * OpenCode emits tool_use with completed status, so we emit both:
   * 1. tool_call (pending) - for UI to show the tool card
   * 2. tool_call_update (completed/failed) - with output
   *
   * { type: "tool_use", part: { callID, tool, state: { status, input, output, title, metadata, time } } }
   */
  function handleToolUse(data: any): SessionUpdate[] {
    const part = data.part;
    if (!part) return [];

    const callId = part.callID;
    const toolName = part.tool ?? "";
    const state = part.state ?? {};
    const input = state.input ?? {};
    const output = state.output;
    const title = state.title ?? state.metadata?.description ?? toolName;
    const status = state.status;
    const exitCode = state.metadata?.exit;

    const { kind, content: callContent, locations } = getToolInfo(toolName, input);

    const updates: SessionUpdate[] = [];

    // Emit tool_call (pending)
    updates.push({
      sessionUpdate: "tool_call",
      toolCallId: callId,
      title,
      kind,
      status: "pending",
      rawInput: input,
      content: callContent,
      locations,
    });

    // Emit tool_call_update (completed/failed)
    const isFailed = status === "error" || (exitCode !== undefined && exitCode !== 0);
    const resultContent: ToolCallContent[] = [];

    if (typeof output === "string" && output.length > 0) {
      resultContent.push({
        type: "content",
        content: {
          type: "text",
          text: isFailed ? `\`\`\`\n${output}\n\`\`\`` : output,
        },
      });
    }

    updates.push({
      sessionUpdate: "tool_call_update",
      toolCallId: callId,
      status: isFailed ? "failed" : "completed",
      content: resultContent,
    });

    return updates;
  }

  /**
   * Handle error events
   * { type: "error", error: { name, data: { message } } }
   */
  function handleError(data: any): SessionUpdate | null {
    const errorName = data.error?.name ?? "Error";
    const message = data.error?.data?.message ?? data.error?.message ?? "Unknown error";

    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `❌ ${errorName}: ${message}` },
    };
  }

  /**
   * Get tool info from tool name and input parameters.
   */
  function getToolInfo(
    toolName: string,
    input: Record<string, unknown>
  ): {
    kind: ToolKind;
    content: ToolCallContent[];
    locations: ToolCallLocation[];
  } {
    const kind = TOOL_KINDS[toolName] || "other";
    const content: ToolCallContent[] = [];
    const locations: ToolCallLocation[] = [];

    switch (toolName) {
      case "read": {
        const path = (input.filePath ?? input.path) as string | undefined;
        if (path) locations.push({ path });
        break;
      }

      case "write": {
        const path = (input.filePath ?? input.path) as string | undefined;
        if (path) {
          locations.push({ path });
          if (typeof input.content === "string") {
            content.push({
              type: "diff",
              path,
              oldText: null,
              newText: input.content as string,
            });
          }
        }
        break;
      }

      case "edit": {
        const path = (input.filePath ?? input.path) as string | undefined;
        if (path) {
          locations.push({ path });
          if (input.oldString !== undefined || input.newString !== undefined) {
            content.push({
              type: "diff",
              path,
              oldText: (input.oldString as string) ?? "",
              newText: (input.newString as string) ?? "",
            });
          }
        }
        break;
      }

      case "apply_patch": {
        // apply_patch uses patchText, no file path in input (paths are in the patch itself)
        break;
      }

      case "bash": {
        const cmd = input.command as string | undefined;
        if (cmd && input.description) {
          content.push({
            type: "content",
            content: { type: "text", text: input.description as string },
          });
        }
        break;
      }

      case "glob":
      case "list": {
        const path = input.path as string | undefined;
        if (path) locations.push({ path });
        break;
      }

      case "grep":
      case "codesearch": {
        const path = input.path as string | undefined;
        if (path) locations.push({ path });
        break;
      }

      case "webfetch": {
        // No special handling
        break;
      }

      case "websearch": {
        // No special handling
        break;
      }

      case "task": {
        // Subagent task
        break;
      }

      default:
        break;
    }

    return { kind, content, locations };
  }
}
