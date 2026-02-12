/**
 * Kimi Wire Protocol → ACP-style events parser.
 *
 * Native schema source (MoonshotAI/kimi-cli):
 *   KNOWLEDGE/kimi-cli/src/kimi_cli/wire/types.py (WireMessageEnvelope, Event types)
 *   KNOWLEDGE/kimi-cli/src/kimi_cli/ui/print/visualize.py (JsonPrinter — stream-json output)
 *   KNOWLEDGE/kimi-cli/src/kimi_cli/tools/__init__.py (tool name registry)
 *   KNOWLEDGE/kimi-cli/packages/kosong/src/kosong/message.py (ContentPart, ToolCall, Message)
 *
 * Output mode: `kimi --print --output-format stream-json`
 *
 * Kimi Wire message envelope: { "type": "TypeName", "payload": { ... } }
 *
 * Wire event types (wire/types.py):
 * - TurnBegin        → lifecycle (skip)
 * - TurnEnd          → lifecycle (skip)
 * - StepBegin        → lifecycle (skip)
 * - StepInterrupted  → lifecycle (skip)
 * - CompactionBegin  → lifecycle (skip)
 * - CompactionEnd    → lifecycle (skip)
 * - StatusUpdate     → lifecycle (skip)
 * - TextPart         → agent_message_chunk
 * - ThinkPart        → agent_thought_chunk
 * - ToolCall         → tool_call (pending)
 * - ToolCallPart     → accumulate partial tool call
 * - ToolResult       → tool_call_update (completed/failed)
 * - ApprovalRequest  → skip (YOLO mode auto-approves in print mode)
 * - ApprovalResponse → skip
 * - SubagentEvent    → recursively parse inner event
 *
 * ACP output: parsers/types.ts (OutputEvent, SessionUpdate)
 */

import {
  OutputEvent,
  SessionUpdate,
  ToolKind,
  ToolCallContent,
  ToolCallLocation,
} from "./types";

/** Map Kimi tool names to ACP ToolKind */
const TOOL_KINDS: Record<string, ToolKind> = {
  // File operations
  ReadFile: "read",
  ReadMediaFile: "read",
  WriteFile: "edit",
  StrReplaceFile: "edit",
  // Shell
  Shell: "execute",
  // Search
  Glob: "search",
  Grep: "search",
  // Web
  SearchWeb: "fetch",
  FetchURL: "fetch",
  // Agent
  Task: "think",
  Think: "think",
  CreateSubagent: "think",
  SetTodoList: "other",
};

/**
 * Create a Kimi parser instance.
 * Stateful to track partial ToolCallPart accumulation.
 */
export function createKimiParser() {
  // Track accumulated ToolCallPart arguments by tool call id
  const toolCallPartBuffers: Map<string, { name: string; args: string }> = new Map();

  return function parseKimiEvent(jsonLine: string): OutputEvent[] | null {
    let data: any;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }

    if (!data || typeof data !== "object") return null;

    // Skip metadata lines
    if ("_meta" in data || "_prompt" in data) {
      return null;
    }

    // Kimi Wire envelope: { type: string, payload: object }
    const type = data.type as string;
    const payload = data.payload ?? {};

    const events: OutputEvent[] = [];

    switch (type) {
      // Lifecycle events - skip
      case "TurnBegin":
      case "TurnEnd":
      case "StepBegin":
      case "StepInterrupted":
      case "CompactionBegin":
      case "CompactionEnd":
      case "StatusUpdate":
      case "ApprovalRequest":
      case "ApprovalResponse":
        return null;

      // Text content from agent
      case "TextPart": {
        const text = payload.text;
        if (typeof text === "string" && text.length > 0) {
          events.push({
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          });
        }
        break;
      }

      // Thinking/reasoning content (kosong ThinkPart field is "think", not "thinking")
      case "ThinkPart": {
        const thinking = payload.think;
        if (typeof thinking === "string" && thinking.length > 0) {
          events.push({
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: thinking },
            },
          });
        }
        break;
      }

      // Complete tool call (kosong.message.ToolCall format)
      // { id, function: { name, arguments } }
      case "ToolCall": {
        const toolId = payload.id;
        const fn = payload.function;
        if (!fn) break;

        const toolName = fn.name ?? "";
        let input: unknown;
        try {
          input = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch {
          input = fn.arguments;
        }

        const { title, kind, content, locations } = getToolInfo(
          toolName,
          (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>
        );

        events.push({
          update: {
            sessionUpdate: "tool_call",
            toolCallId: toolId,
            title,
            kind,
            status: "pending",
            rawInput: input,
            content,
            locations,
          },
        });
        break;
      }

      // Partial tool call streaming (accumulate arguments)
      case "ToolCallPart": {
        const toolId = payload.id ?? payload.tool_call_id;
        const fn = payload.function;
        if (!toolId || !fn) break;

        const existing = toolCallPartBuffers.get(toolId);
        if (existing) {
          if (fn.arguments) existing.args += fn.arguments;
        } else {
          toolCallPartBuffers.set(toolId, {
            name: fn.name ?? "",
            args: fn.arguments ?? "",
          });
        }
        // Don't emit until ToolCall or ToolResult arrives
        break;
      }

      // Tool result (kosong.tooling.ToolResult format)
      // { tool_call_id, return_value: { type: "ToolOk"|"ToolError", output?, message?, display? } }
      case "ToolResult": {
        const toolId = payload.tool_call_id;
        if (!toolId) break;

        // Clean up partial buffer
        toolCallPartBuffers.delete(toolId);

        const returnValue = payload.return_value ?? payload.content;
        const isError =
          returnValue?.type === "ToolError" ||
          payload.is_error === true;

        const content: ToolCallContent[] = [];

        // Extract output text
        const outputText = returnValue?.output ?? returnValue?.message ?? "";
        if (typeof outputText === "string" && outputText.length > 0) {
          content.push({
            type: "content",
            content: {
              type: "text",
              text: isError ? `\`\`\`\n${outputText}\n\`\`\`` : outputText,
            },
          });
        }

        // Extract display blocks (brief, diff, shell, etc.)
        if (Array.isArray(returnValue?.display)) {
          for (const block of returnValue.display) {
            if (block.type === "brief" && block.content) {
              content.push({
                type: "content",
                content: { type: "text", text: block.content },
              });
            }
          }
        }

        // Also handle array content format
        if (Array.isArray(returnValue?.content)) {
          for (const item of returnValue.content) {
            if (item.type === "text" && item.text) {
              content.push({
                type: "content",
                content: {
                  type: "text",
                  text: isError ? `\`\`\`\n${item.text}\n\`\`\`` : item.text,
                },
              });
            }
          }
        }

        events.push({
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: toolId,
            status: isError ? "failed" : "completed",
            content,
          },
        });
        break;
      }

      // Subagent events - recursively parse the inner event
      case "SubagentEvent": {
        const innerEvent = payload.event;
        if (!innerEvent || typeof innerEvent !== "object") break;

        // Inner event is a WireMessageEnvelope { type, payload }
        const innerLine = JSON.stringify(innerEvent);
        const innerResults = parseKimiEvent(innerLine);
        if (innerResults) {
          events.push(...innerResults);
        }
        break;
      }

      default:
        return null;
    }

    return events.length > 0 ? events : null;
  };

  /**
   * Get tool info from tool name and input parameters.
   */
  function getToolInfo(
    toolName: string,
    input: Record<string, unknown>
  ): {
    title: string;
    kind: ToolKind;
    content: ToolCallContent[];
    locations: ToolCallLocation[];
  } {
    const kind = TOOL_KINDS[toolName] || "other";
    const content: ToolCallContent[] = [];
    const locations: ToolCallLocation[] = [];

    let title = toolName;

    switch (toolName) {
      case "ReadFile": {
        const path = (input.path ?? input.file_path) as string | undefined;
        title = `Read ${path || "file"}`;
        if (path) locations.push({ path });
        break;
      }

      case "ReadMediaFile": {
        const path = (input.path ?? input.file_path) as string | undefined;
        title = `Read media ${path || "file"}`;
        if (path) locations.push({ path });
        break;
      }

      case "WriteFile": {
        const path = (input.path ?? input.file_path) as string | undefined;
        title = `Write ${path || "file"}`;
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

      case "StrReplaceFile": {
        const path = (input.path ?? input.file_path) as string | undefined;
        title = `Edit ${path || "file"}`;
        if (path) locations.push({ path });
        break;
      }

      case "Shell":
        title = input.command ? `\`${input.command}\`` : "Run command";
        break;

      case "Glob":
        title = `Find ${input.pattern || "files"}`;
        if (input.path) locations.push({ path: input.path as string });
        break;

      case "Grep":
        title = `grep "${input.pattern || ""}"`;
        if (input.path) locations.push({ path: input.path as string });
        break;

      case "SearchWeb":
        title = input.query ? `"${input.query}"` : "Web search";
        break;

      case "FetchURL":
        title = input.url ? `Fetch ${input.url}` : "Web fetch";
        break;

      case "Task":
        title = (input.description as string) || "Subagent task";
        break;

      case "Think":
        title = (input.thought as string) || "Thinking";
        break;

      case "CreateSubagent":
        title = input.name ? `Subagent: ${input.name}` : "Create subagent";
        break;

      case "SetTodoList":
        title = "Update todos";
        break;

      default:
        title = toolName;
    }

    return { title, kind, content, locations };
  }
}
