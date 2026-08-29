/**
 * pi / prime-agent JSONL → ACP-style events parser.
 *
 * Native format: `pi --mode json` and `prime-agent --mode json` write one JSON
 * object per line to stdout. prime-agent is a hard fork of pi and emits the same
 * event vocabulary, so a single parser serves both.
 *
 * Top-level event types (discriminated on `type`):
 * - "session"                → header, carries the session id (captured, no event)
 * - "agent_start"/"agent_end"/"turn_start"/"turn_end" → lifecycle (skip)
 * - "message_start"/"message_end"                     → lifecycle (skip)
 * - "message_update"         → streaming deltas, see assistantMessageEvent below
 * - "tool_execution_start"   → tool_call
 * - "tool_execution_update"  → tool_call_update (in_progress)
 * - "tool_execution_end"     → tool_call_update (completed/failed)
 * - "extension_error"        → agent_message_chunk (error text)
 *
 * Nested `message_update.assistantMessageEvent.type` values:
 *   start, text_start, text_delta, text_end, thinking_start, thinking_delta,
 *   thinking_end, toolcall_start, toolcall_delta, toolcall_end, done, error
 *
 * Only the *_delta and error members carry content we surface; the rest are
 * boundaries.
 *
 * Two format notes that matter here:
 * - `message_update` is delta-only: it omits the cumulative `message` field, so
 *   text must be accumulated downstream rather than read from the event.
 * - Records are strictly LF-delimited. The caller splits on "\n" only, which is
 *   required because U+2028/U+2029 are legal inside JSON strings.
 */

import {
  OutputEvent,
  SessionUpdate,
  ToolKind,
  ToolCallContent,
  ToolCallLocation,
} from "./types";

/** Map pi/prime-agent tool names to ACP ToolKind */
const TOOL_KINDS: Record<string, ToolKind> = {
  // File operations
  read: "read",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  // Shell and code execution
  bash: "execute",
  powershell: "execute",
  // prime-agent exposes a single persistent IPython kernel as its only tool
  ipython: "execute",
  // Search
  grep: "search",
  find: "search",
  ls: "search",
  glob: "search",
  // Web
  webfetch: "fetch",
  websearch: "fetch",
  // Agent/planning
  task: "think",
  todoread: "other",
  todowrite: "other",
  skill: "other",
};

/** Extract a displayable string from a tool result of unverified shape. */
function toResultText(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return result.length > 0 ? result : null;
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["output", "text", "content", "stdout"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function toContentBlocks(text: string | null, failed: boolean): ToolCallContent[] {
  if (text === null || text.length === 0) return [];
  return [
    {
      type: "content",
      content: {
        type: "text",
        text: failed ? `\`\`\`\n${text}\n\`\`\`` : text,
      },
    },
  ];
}

/**
 * Create a pi-family parser instance (pi, prime-agent).
 *
 * Stateful: the session id arrives once in the header line and is attached to
 * every later event.
 */
export function createPiParser(): (jsonLine: string) => OutputEvent[] | null {
  let sessionId: string | undefined;

  return function parsePiEvent(jsonLine: string): OutputEvent[] | null {
    let data: any;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }

    if (!data || typeof data !== "object") return null;

    const events: OutputEvent[] = [];
    const push = (update: SessionUpdate | null) => {
      if (update) events.push({ sessionId, update });
    };

    switch (data.type) {
      // Header: capture the session id, emit nothing.
      case "session": {
        if (typeof data.id === "string" && data.id.length > 0) {
          sessionId = data.id;
        }
        return null;
      }

      case "message_update": {
        push(handleAssistantEvent(data.assistantMessageEvent));
        break;
      }

      case "tool_execution_start": {
        push(handleToolStart(data));
        break;
      }

      case "tool_execution_update": {
        push(handleToolUpdate(data));
        break;
      }

      case "tool_execution_end": {
        push(handleToolEnd(data));
        break;
      }

      case "extension_error": {
        const path = typeof data.extensionPath === "string" ? data.extensionPath : "extension";
        const message = typeof data.error === "string" ? data.error : "Unknown error";
        push({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `❌ ${path}: ${message}` },
        });
        break;
      }

      // Lifecycle and bookkeeping events carry no content to surface.
      default:
        return null;
    }

    return events.length > 0 ? events : null;
  };

  /**
   * Map the nested assistant delta stream.
   * { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "..." } }
   */
  function handleAssistantEvent(event: any): SessionUpdate | null {
    if (!event || typeof event !== "object") return null;

    switch (event.type) {
      case "text_delta": {
        const delta = event.delta;
        if (typeof delta !== "string" || delta.length === 0) return null;
        return {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: delta },
        };
      }

      case "thinking_delta": {
        const delta = event.delta;
        if (typeof delta !== "string" || delta.length === 0) return null;
        return {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: delta },
        };
      }

      case "error": {
        const message =
          typeof event.error === "string"
            ? event.error
            : typeof event.message === "string"
              ? event.message
              : "Unknown error";
        return {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `❌ ${message}` },
        };
      }

      default:
        return null;
    }
  }

  /**
   * { type: "tool_execution_start", toolCallId, toolName, args }
   */
  function handleToolStart(data: any): SessionUpdate | null {
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    if (toolCallId.length === 0) return null;

    const toolName = typeof data.toolName === "string" ? data.toolName.toLowerCase() : "";
    const args = typeof data.args === "object" && data.args ? data.args : {};
    const { kind, content, locations } = getToolInfo(toolName, args);

    return {
      sessionUpdate: "tool_call",
      toolCallId,
      title: toolName || "tool",
      kind,
      status: "in_progress",
      rawInput: args,
      content,
      locations,
    };
  }

  /**
   * { type: "tool_execution_update", toolCallId, toolName, args, partialResult }
   */
  function handleToolUpdate(data: any): SessionUpdate | null {
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    if (toolCallId.length === 0) return null;

    const text = toResultText(data.partialResult);
    if (text === null) return null;

    return {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "in_progress",
      content: toContentBlocks(text, false),
    };
  }

  /**
   * { type: "tool_execution_end", toolCallId, toolName, result, isError }
   */
  function handleToolEnd(data: any): SessionUpdate | null {
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    if (toolCallId.length === 0) return null;

    const failed = data.isError === true;
    return {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: failed ? "failed" : "completed",
      content: toContentBlocks(toResultText(data.result), failed),
    };
  }

  /**
   * Derive tool kind, preview content and touched file paths from tool args.
   */
  function getToolInfo(
    toolName: string,
    args: Record<string, unknown>
  ): {
    kind: ToolKind;
    content: ToolCallContent[];
    locations: ToolCallLocation[];
  } {
    const kind = TOOL_KINDS[toolName] || "other";
    const content: ToolCallContent[] = [];
    const locations: ToolCallLocation[] = [];
    const path = (args.path ?? args.filePath ?? args.file_path) as string | undefined;

    switch (toolName) {
      case "read": {
        if (path) {
          const offset = args.offset;
          locations.push({
            path,
            line:
              typeof offset === "number" && Number.isFinite(offset)
                ? Math.max(0, offset - 1)
                : undefined,
          });
        }
        break;
      }

      case "write": {
        if (path) {
          locations.push({ path });
          if (typeof args.content === "string") {
            content.push({
              type: "diff",
              path,
              oldText: null,
              newText: args.content,
            });
          }
        }
        break;
      }

      case "edit":
      case "multiedit": {
        if (path) {
          locations.push({ path });
          const oldText = args.oldString ?? args.old_string ?? args.oldText;
          const newText = args.newString ?? args.new_string ?? args.newText;
          if (toolName === "edit" && (oldText !== undefined || newText !== undefined)) {
            content.push({
              type: "diff",
              path,
              oldText: typeof oldText === "string" ? oldText : "",
              newText: typeof newText === "string" ? newText : "",
            });
          }
        }
        break;
      }

      case "bash":
      case "powershell":
      case "ipython": {
        const code = (args.command ?? args.code ?? args.script) as string | undefined;
        if (typeof code === "string" && code.length > 0) {
          content.push({ type: "content", content: { type: "text", text: code } });
        }
        break;
      }

      case "grep":
      case "find":
      case "ls":
      case "glob": {
        if (path) locations.push({ path });
        const pattern = (args.pattern ?? args.query) as string | undefined;
        if (typeof pattern === "string" && pattern.length > 0) {
          content.push({ type: "content", content: { type: "text", text: pattern } });
        }
        break;
      }

      case "webfetch":
      case "websearch": {
        const target = (args.url ?? args.query) as string | undefined;
        if (typeof target === "string" && target.length > 0) {
          content.push({ type: "content", content: { type: "text", text: target } });
        }
        break;
      }

      default:
        break;
    }

    return { kind, content, locations };
  }
}
