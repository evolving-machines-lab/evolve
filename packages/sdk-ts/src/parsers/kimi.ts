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
  PlanEntry,
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

function isKimiToolErrorText(text: string): boolean {
  return /<system>\s*ERROR:/i.test(text) || text.includes("<error>") || text.includes("ToolError");
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)((?:;[^,]*)*),(.+)$/i.exec(url);
  if (!match) return null;
  const mimeType = match[1] || "";
  const params = match[2] || "";
  const data = match[3] || "";
  if (!/;base64/i.test(params)) return null;
  return { mimeType, data };
}

function parseToolContentPart(item: any): ToolCallContent | null {
  if (!item || typeof item !== "object") return null;

  if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
    return {
      type: "content",
      content: { type: "text", text: item.text },
    };
  }

  if (item.type === "image_url" && typeof item.image_url?.url === "string") {
    const url = item.image_url.url;
    const parsed = parseDataUrl(url);
    if (parsed) {
      return {
        type: "content",
        content: { type: "image", data: parsed.data, mimeType: parsed.mimeType },
      };
    }
    return {
      type: "content",
      content: { type: "image", data: "", mimeType: "", uri: url },
    };
  }

  if (item.type === "video_url" && typeof item.video_url?.url === "string") {
    return {
      type: "content",
      content: { type: "text", text: `[video] ${item.video_url.url}` },
    };
  }

  if (item.type === "audio_url" && typeof item.audio_url?.url === "string") {
    return {
      type: "content",
      content: { type: "text", text: `[audio] ${item.audio_url.url}` },
    };
  }

  return null;
}

function parseToolOutputToContent(output: unknown): ToolCallContent[] {
  const content: ToolCallContent[] = [];

  if (typeof output === "string") {
    if (output.length > 0) {
      content.push({
        type: "content",
        content: { type: "text", text: output },
      });
    }
    return content;
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === "string" && item.length > 0) {
        content.push({
          type: "content",
          content: { type: "text", text: item },
        });
        continue;
      }
      const parsed = parseToolContentPart(item);
      if (parsed) content.push(parsed);
    }
    return content;
  }

  if (output && typeof output === "object") {
    const parsed = parseToolContentPart(output);
    if (parsed) content.push(parsed);
  }

  return content;
}

function contentHasKimiToolError(content: ToolCallContent[]): boolean {
  return content.some(
    (entry) => entry.type === "content" && entry.content.type === "text" && isKimiToolErrorText(entry.content.text)
  );
}

function parseAssistantContentPart(part: any): OutputEvent | null {
  if (!part || typeof part !== "object") return null;

  if (part.type === "think" && typeof part.think === "string" && part.think.length > 0) {
    return {
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: part.think },
      },
    };
  }

  if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
    return {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: part.text },
      },
    };
  }

  if (part.type === "image_url" && typeof part.image_url?.url === "string") {
    const url = part.image_url.url;
    const parsed = parseDataUrl(url);
    if (parsed) {
      return {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: parsed.data, mimeType: parsed.mimeType },
        },
      };
    }
    return {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "", mimeType: "", uri: url },
      },
    };
  }

  if (part.type === "video_url" && typeof part.video_url?.url === "string") {
    return {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `[video] ${part.video_url.url}` },
      },
    };
  }

  if (part.type === "audio_url" && typeof part.audio_url?.url === "string") {
    return {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `[audio] ${part.audio_url.url}` },
      },
    };
  }

  return null;
}

function toPlanEntryStatus(status: unknown): PlanEntry["status"] {
  if (status === "in_progress") return "in_progress";
  if (status === "done" || status === "completed") return "completed";
  return "pending";
}

function parseTodosToPlanEntries(input: unknown): PlanEntry[] {
  if (!input || typeof input !== "object") return [];
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return [];

  return todos
    .map((todo): PlanEntry | null => {
      if (!todo || typeof todo !== "object") return null;
      const title = (todo as { title?: unknown }).title;
      if (typeof title !== "string" || title.length === 0) return null;
      const status = (todo as { status?: unknown }).status;
      return {
        content: title,
        status: toPlanEntryStatus(status),
        priority: "medium",
      };
    })
    .filter((entry): entry is PlanEntry => entry !== null);
}

/**
 * Create a Kimi parser instance.
 */
export function createKimiParser() {
  const todoToolCallIds = new Set<string>();
  let fallbackToolCallIdCounter = 0;

  function getToolCallId(toolIdRaw: unknown, toolName: string): string {
    if (typeof toolIdRaw === "string" && toolIdRaw.length > 0) return toolIdRaw;
    fallbackToolCallIdCounter += 1;
    const safeName = toolName.replace(/[^a-zA-Z0-9_]/g, "_") || "tool";
    return `kimi_${safeName}_${fallbackToolCallIdCounter}`;
  }

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
        const parsed = parseAssistantContentPart(part);
        if (parsed) events.push(parsed);
      }
    }

    // Parse tool calls
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const fn = tc.function;
        if (!fn) continue;

        const toolName = fn.name ?? "";
        const toolId = getToolCallId(tc.id, toolName);
        let input: unknown;
        try {
          input = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch {
          input = fn.arguments;
        }

        if (toolName === "SetTodoList") {
          const entries = parseTodosToPlanEntries(input);
          if (entries.length > 0) {
            events.push({
              update: {
                sessionUpdate: "plan",
                entries,
              },
            });
          }
          todoToolCallIds.add(toolId);
          continue;
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
    if (typeof toolId !== "string" || toolId.length === 0) return null;
    if (todoToolCallIds.has(toolId)) {
      todoToolCallIds.delete(toolId);
      return null;
    }

    const rawContent = data.content;
    const content: ToolCallContent[] = [];
    let isError = false;

    if (typeof rawContent === "string") {
      // Simple string content — check for error markers
      isError = isKimiToolErrorText(rawContent);
      if (rawContent.length > 0) {
        content.push({
          type: "content",
          content: { type: "text", text: rawContent },
        });
      }
    } else if (Array.isArray(rawContent)) {
      // Array of content parts: text, image_url, video_url, ...
      for (const item of rawContent) {
        const parsed = parseToolContentPart(item);
        if (!parsed) continue;
        if (parsed.type === "content" && parsed.content.type === "text" && isKimiToolErrorText(parsed.content.text)) {
          isError = true;
        }
        content.push(parsed);
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
        const toolName = payload.function?.name ?? "";
        const toolId = getToolCallId(payload.id, toolName);
        const fn = payload.function;
        if (!fn) break;
        let input: unknown;
        try {
          input = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch {
          input = fn.arguments;
        }
        if (toolName === "SetTodoList") {
          const entries = parseTodosToPlanEntries(input);
          if (entries.length > 0) {
            events.push({
              update: {
                sessionUpdate: "plan",
                entries,
              },
            });
          }
          todoToolCallIds.add(toolId);
          break;
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
        if (typeof toolId !== "string" || toolId.length === 0) break;
        if (todoToolCallIds.has(toolId)) {
          todoToolCallIds.delete(toolId);
          break;
        }
        const returnValue = payload.return_value ?? payload.content;
        const content: ToolCallContent[] = [];

        let isError = payload.is_error === true;
        if (returnValue && typeof returnValue === "object" && !Array.isArray(returnValue)) {
          const rv = returnValue as {
            type?: unknown;
            is_error?: unknown;
            output?: unknown;
            message?: unknown;
          };
          isError = isError || rv.type === "ToolError" || rv.is_error === true;
          content.push(...parseToolOutputToContent(rv.output));
          if (content.length === 0 && typeof rv.message === "string" && rv.message.length > 0) {
            content.push({
              type: "content",
              content: { type: "text", text: rv.message },
            });
          }
          if (content.length === 0) {
            content.push(...parseToolOutputToContent(returnValue));
          }
        } else {
          content.push(...parseToolOutputToContent(returnValue));
        }

        isError = isError || contentHasKimiToolError(content);

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
