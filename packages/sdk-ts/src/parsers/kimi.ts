/**
 * Kimi Kosong Messages → ACP-style events parser.
 *
 * Native schema source (MoonshotAI/kimi-cli):
 *   KNOWLEDGE/kimi-cli/packages/kosong/src/kosong/message.py (ContentPart, ToolCall, Message)
 *   KNOWLEDGE/kimi-cli/src/kimi_cli/ui/print/visualize.py (JsonPrinter — stream-json output)
 *   KNOWLEDGE/kimi-cli/src/kimi_cli/tools/__init__.py (tool name registry)
 *
 * Output mode: `kimi --print --output-format stream-json`
 *
 * Actual output format (Kosong Messages, NOT Wire Protocol):
 *
 *   role: "assistant" with content[] and optional tool_calls[]
 *     content[].type: "think"    → agent_thought_chunk
 *     content[].type: "text"     → agent_message_chunk
 *     tool_calls[].type: "function" → tool_call (pending)
 *
 *   role: "tool" with content (string or array) and tool_call_id
 *     → tool_call_update (completed/failed)
 *
 * ACP output: parsers/types.ts (OutputEvent, SessionUpdate)
 */

import {
  OutputEvent,
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
 */
export function createKimiParser() {
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

    const role = data.role as string | undefined;

    // Kosong Messages format: { role, content, tool_calls?, tool_call_id? }
    if (role === "assistant") {
      return parseAssistantMessage(data);
    }

    if (role === "tool") {
      return parseToolMessage(data);
    }

    // Fallback: Wire Protocol envelope { type, payload } (future-proofing)
    if (typeof data.type === "string" && "payload" in data) {
      return parseWireEnvelope(data);
    }

    return null;
  };

  /**
   * Parse assistant message: content[] (think/text) + tool_calls[]
   */
  function parseAssistantMessage(data: any): OutputEvent[] | null {
    const events: OutputEvent[] = [];
    const content = data.content;
    const toolCalls = data.tool_calls;

    // Parse content parts (Kosong serializes single TextPart as plain string)
    if (typeof content === "string" && content.length > 0) {
      events.push({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: content },
        },
      });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;

        if (part.type === "think" && typeof part.think === "string" && part.think.length > 0) {
          events.push({
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: part.think },
            },
          });
        } else if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
          events.push({
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: part.text },
            },
          });
        }
      }
    }

    // Parse tool calls
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const fn = tc.function;
        if (!fn) continue;

        const toolId = tc.id ?? "";
        const toolName = fn.name ?? "";
        let input: unknown;
        try {
          input = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch {
          input = fn.arguments;
        }

        const { title, kind, toolContent, locations } = getToolInfo(
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
            content: toolContent,
            locations,
          },
        });
      }
    }

    return events.length > 0 ? events : null;
  }

  /**
   * Parse tool result message: { role: "tool", content, tool_call_id }
   */
  function parseToolMessage(data: any): OutputEvent[] | null {
    const toolId = data.tool_call_id;
    if (!toolId) return null;

    const rawContent = data.content;
    const content: ToolCallContent[] = [];
    let isError = false;

    if (typeof rawContent === "string") {
      // Simple string content — check for error markers
      isError = rawContent.includes("<error>") || rawContent.includes("ToolError");
      if (rawContent.length > 0) {
        content.push({
          type: "content",
          content: { type: "text", text: rawContent },
        });
      }
    } else if (Array.isArray(rawContent)) {
      // Array of content parts: [{ type: "text", text: "..." }]
      for (const item of rawContent) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
          if (item.text.includes("<error>") || item.text.includes("ToolError")) {
            isError = true;
          }
          content.push({
            type: "content",
            content: { type: "text", text: item.text },
          });
        }
      }
    }

    return [{
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: toolId,
        status: isError ? "failed" : "completed",
        content,
      },
    }];
  }

  /**
   * Fallback: Wire Protocol envelope { type, payload }
   */
  function parseWireEnvelope(data: any): OutputEvent[] | null {
    const type = data.type as string;
    const payload = data.payload ?? {};
    const events: OutputEvent[] = [];

    switch (type) {
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
        const { title, kind, toolContent, locations } = getToolInfo(
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
            content: toolContent,
            locations,
          },
        });
        break;
      }
      case "ToolResult": {
        const toolId = payload.tool_call_id;
        if (!toolId) break;
        const returnValue = payload.return_value ?? payload.content;
        const isError = returnValue?.type === "ToolError" || payload.is_error === true;
        const content: ToolCallContent[] = [];
        const outputText = returnValue?.output ?? returnValue?.message ?? "";
        if (typeof outputText === "string" && outputText.length > 0) {
          content.push({
            type: "content",
            content: { type: "text", text: isError ? `\`\`\`\n${outputText}\n\`\`\`` : outputText },
          });
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
      default:
        return null;
    }

    return events.length > 0 ? events : null;
  }

  /**
   * Get tool info from tool name and input parameters.
   */
  function getToolInfo(
    toolName: string,
    input: Record<string, unknown>
  ): {
    title: string;
    kind: ToolKind;
    toolContent: ToolCallContent[];
    locations: ToolCallLocation[];
  } {
    const kind = TOOL_KINDS[toolName] || "other";
    const toolContent: ToolCallContent[] = [];
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
            toolContent.push({
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

    return { title, kind, toolContent, locations };
  }
}
