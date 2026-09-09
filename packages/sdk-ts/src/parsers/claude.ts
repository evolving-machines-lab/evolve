/**
 * Claude JSONL → ACP-style events parser.
 *
 * Native schema source (@anthropic-ai/claude-agent-sdk):
 *   MANUS-API/KNOWLEDGE/claude-agent-sdk/cc_sdk_typescript.md
 *   (SDKMessage, SDKAssistantMessage, SDKPartialAssistantMessage, Tool Input/Output types)
 *
 * Conversion logic reference:
 *   MANUS-API/KNOWLEDGE/claude-code-acp/src/tools.ts
 *   (toolInfoFromToolUse, toolUpdateFromToolResult)
 *
 * ACP output schema:
 *   MANUS-API/KNOWLEDGE/acp-typescript-sdk/src/schema/types.gen.ts
 */

import {
  harnessErrorText,
  OutputEvent,
  SessionUpdate,
  ToolKind,
  ToolCallContent,
  ToolCallLocation,
  PlanEntry,
  ContentBlock,
} from "./types";
import { anthropicTokenUsage, isoTimestamp } from "./usage";

/**
 * Create a Claude parser instance with its own isolated cache.
 * Each Evolve instance should create its own parser for proper isolation.
 */
export function createClaudeParser() {
  // Cache scoped to this parser instance
  const toolUseCache: Record<string, {
    type: string;
    id: string;
    name: string;
    input: any;
  }> = {};

  /**
   * Parse a Claude JSONL line and return ACP-style events.
   * Ported from acp-agent.ts
   */
  return function parseClaudeEvent(jsonLine: string): OutputEvent[] | null {
    let data: any;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }

    // Skip metadata lines
    if (data._meta || data._prompt) {
      return null;
    }

    const sessionId = data.session_id;

    switch (data.type) {
      case "system":
        return null;

      case "assistant": {
        const updates = toAcpNotifications(data.message?.content, "assistant") ?? [];
        // Every assistant line prints the message's usage (Anthropic's
        // running total for that message id) — claude_code.py:1147-1158
        // keeps the last one per message id, which the messageId stamped
        // on the envelope lets a consumer do.
        const usage = anthropicTokenUsage(data.message?.usage);
        if (usage) updates.push({ sessionUpdate: "usage", scope: "call", usage });
        return wrap(updates, data, sessionId);
      }

      case "user": {
        // Skip pure text user messages (like claude-code-acp lines 521-530)
        // Only process tool_result blocks
        const content = data.message?.content;
        if (typeof content === "string") {
          return null;
        }
        if (
          Array.isArray(content) &&
          content.length === 1 &&
          content[0].type === "text"
        ) {
          return null;
        }
        // Process tool_result blocks. The line's top-level tool_use_result
        // (stream-json spelling; the session file writes toolUseResult) is
        // claude's structured record of what the tool did — stdout, stderr,
        // exitCode, interrupted, the file it wrote — which the content block
        // flattens into prose. claude_code.py:871-942 reads it per result.
        const rawOutput = data.tool_use_result ?? data.toolUseResult;
        return wrap(toAcpNotifications(content, "user", rawOutput), data, sessionId);
      }

      // THE RUN'S VERDICT. A successful result carries no transcript — its
      // text already streamed as assistant messages, so re-emitting it would
      // double the transcript — but it IS the one line with the run's whole
      // accounting (usage, total_cost_usd: claude_code.py:944-973 reads
      // total_cost_usd from exactly this line), so it becomes a run-scoped
      // usage event. A FAILED result is the only place claude reports that the
      // run itself failed (subtype error_during_execution / error_max_turns /
      // error_max_budget_usd / error_max_structured_output_retries), and
      // returning null for it dropped that failure entirely: a run that never
      // reached the model produced no events and looked like a run that simply
      // did nothing. Claude carries the text in `errors: string[]`, and there
      // is no error.message here.
      //
      // `result` IS a carrier though, on one shape: subtype "success" with
      // is_error true — the run finished its turn and the turn's own text is
      // the failure report, so `errors` is empty and `result` holds the only
      // words claude supplied. It sits between the two: after `errors`, which
      // is the dedicated failure channel, and before `subtype`, which is a
      // single word and on this shape the actively misleading word "success".
      case "result": {
        if (data.is_error !== true) {
          const usage = anthropicTokenUsage(data.usage);
          if (!usage) return null;
          if (typeof data.total_cost_usd === "number" && Number.isFinite(data.total_cost_usd)) {
            usage.costUsd = data.total_cost_usd;
          }
          return wrap([{ sessionUpdate: "usage", scope: "run", usage }], data, sessionId);
        }
        const errors: unknown[] = Array.isArray(data.errors) ? data.errors : [];
        const text = errors.filter((e): e is string => typeof e === "string" && e.length > 0).join("\n");
        return [{
          sessionId,
          update: {
            sessionUpdate: "error",
            message: harnessErrorText([text, data.result, data.subtype], data),
            fatal: true,
          },
        }];
      }

      default:
        return null;
    }
  };

  /**
   * Envelope every update of one wire line with the line's own facts
   * (parsers/types.ts OutputEvent): claude's clock, the message's model and
   * id, its stop reason, and — on a subagent's line — the parent tool call
   * it belongs to. Only what the line carried with a value; null stays absent.
   */
  function wrap(
    updates: SessionUpdate[] | null,
    line: any,
    sessionId: string | undefined,
  ): OutputEvent[] | null {
    if (!updates || updates.length === 0) return null;
    const message = line.message;
    const timestamp = isoTimestamp(line.timestamp);
    const model = typeof message?.model === "string" && message.model ? message.model : undefined;
    const messageId = typeof message?.id === "string" && message.id ? message.id : undefined;
    const parentToolCallId =
      typeof line.parent_tool_use_id === "string" && line.parent_tool_use_id
        ? line.parent_tool_use_id
        : undefined;
    const extra: Record<string, unknown> = {};
    for (const key of ["stop_reason", "stop_sequence"]) {
      const value = message?.[key];
      if (value !== null && value !== undefined) extra[key] = value;
    }
    return updates.map((update) => ({
      sessionId,
      update,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    }));
  }

  /**
   * Convert Claude message content to ACP notifications.
   * Ported from acp-agent.ts toAcpNotifications()
   */
  function toAcpNotifications(
    content: string | any[] | undefined,
    role: "assistant" | "user",
    rawOutput?: unknown,
  ): SessionUpdate[] | null {
    if (typeof content === "string") {
      // User string content is filtered at caller level, but skip here too for safety
      if (role === "user") {
        return null;
      }
      return [{
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: content },
      }];
    }

    if (!content || !Array.isArray(content)) {
      return null;
    }

    const output: SessionUpdate[] = [];

    for (const chunk of content) {
      let update: SessionUpdate | null = null;

      switch (chunk.type) {
        case "text":
        case "text_delta":
          // Skip text in user messages (only process tool_result)
          if (role === "user") {
            break;
          }
          update = {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk.text },
          };
          break;

        case "image":
          // Skip images in user messages
          if (role === "user") {
            break;
          }
          update = {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "image",
              data: chunk.source?.type === "base64" ? chunk.source.data : "",
              mimeType: chunk.source?.type === "base64" ? chunk.source.media_type : "",
              uri: chunk.source?.type === "url" ? chunk.source.url : undefined,
            },
          };
          break;

        case "thinking":
        case "thinking_delta":
          update = {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: chunk.thinking },
          };
          break;

        case "tool_use":
        case "server_tool_use":
        case "mcp_tool_use": {
          toolUseCache[chunk.id] = chunk;

          if (chunk.name === "TodoWrite") {
            if (Array.isArray(chunk.input?.todos)) {
              update = {
                sessionUpdate: "plan",
                entries: planEntries(chunk.input),
              };
            }
          } else {
            const toolInfo = toolInfoFromToolUse(chunk);
            update = {
              sessionUpdate: "tool_call",
              toolCallId: chunk.id,
              status: "pending",
              ...toolInfo,
              // After the spread: the wire name is authoritative, and
              // toolInfoFromToolUse only derives display fields from it.
              toolName: chunk.name,
            };
          }
          break;
        }

        case "tool_result":
        case "tool_search_tool_result":
        case "web_fetch_tool_result":
        case "web_search_tool_result":
        case "code_execution_tool_result":
        case "bash_code_execution_tool_result":
        case "text_editor_code_execution_tool_result":
        case "mcp_tool_result": {
          const toolUse = toolUseCache[chunk.tool_use_id];

          if (!toolUse) {
            break;
          }

          // Clean up cache
          delete toolUseCache[chunk.tool_use_id];

          if (toolUse.name === "TodoWrite") {
            break;
          }

          update = {
            sessionUpdate: "tool_call_update",
            toolCallId: chunk.tool_use_id,
            status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
            ...toolUpdateFromToolResult(chunk, toolUse),
            ...(rawOutput !== undefined && rawOutput !== null ? { rawOutput } : {}),
          };
          break;
        }

        // Skip these types
        case "document":
        case "search_result":
        case "redacted_thinking":
        case "input_json_delta":
        case "citations_delta":
        case "signature_delta":
        case "container_upload":
          break;

        default:
          break;
      }

      if (update) {
        output.push(update);
      }
    }

    return output.length > 0 ? output : null;
  }

  /**
   * Extract tool info from a tool_use block.
   * Ported from tools.ts toolInfoFromToolUse()
   */
  function toolInfoFromToolUse(toolUse: any): {
    title: string;
    kind: ToolKind;
    content: ToolCallContent[];
    locations?: ToolCallLocation[];
    rawInput?: unknown;
  } {
    const name = toolUse.name;
    const input = toolUse.input || {};

    switch (name) {
      case "Task":
        return {
          title: input.description || "Task",
          kind: "think",
          content: input.prompt
            ? [{ type: "content", content: { type: "text", text: input.prompt } }]
            : [],
          rawInput: input,
        };

      case "NotebookRead":
        return {
          title: input.notebook_path ? `Read Notebook ${input.notebook_path}` : "Read Notebook",
          kind: "read",
          content: [],
          locations: input.notebook_path ? [{ path: input.notebook_path }] : [],
          rawInput: input,
        };

      case "NotebookEdit":
        return {
          title: input.notebook_path ? `Edit Notebook ${input.notebook_path}` : "Edit Notebook",
          kind: "edit",
          content: input.new_source
            ? [{ type: "content", content: { type: "text", text: input.new_source } }]
            : [],
          locations: input.notebook_path ? [{ path: input.notebook_path }] : [],
          rawInput: input,
        };

      case "Bash":
        return {
          title: input.command
            ? "`" + input.command.replaceAll("`", "\\`") + "`"
            : "Terminal",
          kind: "execute",
          content: input.description
            ? [{ type: "content", content: { type: "text", text: input.description } }]
            : [],
          rawInput: input,
        };

      case "BashOutput":
        return {
          title: "Tail Logs",
          kind: "execute",
          content: [],
          rawInput: input,
        };

      case "KillShell":
        return {
          title: "Kill Process",
          kind: "execute",
          content: [],
          rawInput: input,
        };

      case "Read": {
        let limit = "";
        if (input.limit) {
          limit = " (" + ((input.offset ?? 0) + 1) + " - " + ((input.offset ?? 0) + input.limit) + ")";
        } else if (input.offset) {
          limit = " (from line " + (input.offset + 1) + ")";
        }
        return {
          title: "Read " + (input.file_path ?? "File") + limit,
          kind: "read",
          content: [],
          locations: input.file_path
            ? [{ path: input.file_path, line: input.offset ?? 0 }]
            : [],
          rawInput: input,
        };
      }

      case "LS":
        return {
          title: input.path
            ? `List \`${input.path}\` directory`
            : "List current directory",
          kind: "search",
          content: [],
          locations: [],
          rawInput: input,
        };

      case "Edit": {
        const path = input.file_path;
        return {
          title: path ? `Edit \`${path}\`` : "Edit",
          kind: "edit",
          content: path
            ? [{
                type: "diff",
                path,
                oldText: input.old_string ?? null,
                newText: input.new_string ?? "",
              }]
            : [],
          locations: path ? [{ path }] : [],
          rawInput: input,
        };
      }

      case "Write":
        return {
          title: input.file_path ? `Write ${input.file_path}` : "Write",
          kind: "edit",
          content: input.file_path
            ? [{
                type: "diff",
                path: input.file_path,
                oldText: null,
                newText: input.content ?? "",
              }]
            : [],
          locations: input.file_path ? [{ path: input.file_path }] : [],
          rawInput: input,
        };

      case "Glob": {
        let label = "Find";
        if (input.path) label += ` \`${input.path}\``;
        if (input.pattern) label += ` \`${input.pattern}\``;
        return {
          title: label,
          kind: "search",
          content: [],
          locations: input.path ? [{ path: input.path }] : [],
          rawInput: input,
        };
      }

      case "Grep": {
        let label = "grep";
        if (input["-i"]) label += " -i";
        if (input["-n"]) label += " -n";
        if (input["-A"] !== undefined) label += ` -A ${input["-A"]}`;
        if (input["-B"] !== undefined) label += ` -B ${input["-B"]}`;
        if (input["-C"] !== undefined) label += ` -C ${input["-C"]}`;
        if (input.output_mode === "files_with_matches") label += " -l";
        else if (input.output_mode === "count") label += " -c";
        if (input.head_limit !== undefined) label += ` | head -${input.head_limit}`;
        if (input.glob) label += ` --include="${input.glob}"`;
        if (input.type) label += ` --type=${input.type}`;
        if (input.multiline) label += " -P";
        label += ` "${input.pattern ?? ""}"`;
        if (input.path) label += ` ${input.path}`;
        return {
          title: label,
          kind: "search",
          content: [],
          rawInput: input,
        };
      }

      case "WebFetch":
        return {
          title: input.url ? `Fetch ${input.url}` : "Fetch",
          kind: "fetch",
          content: input.prompt
            ? [{ type: "content", content: { type: "text", text: input.prompt } }]
            : [],
          rawInput: input,
        };

      case "WebSearch": {
        let label = `"${input.query ?? ""}"`;
        if (input.allowed_domains?.length > 0) {
          label += ` (allowed: ${input.allowed_domains.join(", ")})`;
        }
        if (input.blocked_domains?.length > 0) {
          label += ` (blocked: ${input.blocked_domains.join(", ")})`;
        }
        return {
          title: label,
          kind: "fetch",
          content: [],
          rawInput: input,
        };
      }

      case "TodoWrite":
        return {
          title: Array.isArray(input.todos)
            ? `Update TODOs: ${input.todos.map((t: any) => t.content).join(", ")}`
            : "Update TODOs",
          kind: "think",
          content: [],
          rawInput: input,
        };

      case "ExitPlanMode":
        return {
          title: "Ready to code?",
          kind: "switch_mode",
          content: input.plan
            ? [{ type: "content", content: { type: "text", text: input.plan } }]
            : [],
          rawInput: input,
        };

      // MCP tools
      default:
        if (name?.startsWith("mcp__")) {
          const parts = name.split("__");
          const serverName = parts[1] || "mcp";
          const toolName = parts.slice(2).join("__") || name;
          return {
            title: `${serverName}: ${toolName}`,
            kind: "other",
            content: [],
            rawInput: input,
          };
        }
        return {
          title: name || "Unknown Tool",
          kind: "other",
          content: [],
          rawInput: input,
        };
    }
  }

  /**
   * Extract tool update from a tool_result block.
   * Ported from tools.ts toolUpdateFromToolResult() — MINUS its markdown
   * fences. claude-code-acp wrapped a Read's file content and every error
   * text in ``` because its consumer was a chat pane; here the consumer is a
   * transcript, and a fence is bytes the harness never sent (Harbor keeps the
   * block verbatim, claude_code.py:877-887). Framing belongs to a viewer.
   */
  function toolUpdateFromToolResult(
    toolResult: any,
    toolUse: any
  ): { title?: string; content?: ToolCallContent[] } {
    switch (toolUse?.name) {
      case "ExitPlanMode":
        return { title: "Exited Plan Mode" };

      // Every other tool: the result content as claude sent it.
      default:
        return toAcpContentUpdate(toolResult.content);
    }
  }

  /**
   * Convert raw content to ACP ToolCallContent array.
   * Ported from tools.ts toAcpContentUpdate()
   */
  function toAcpContentUpdate(content: any): { content?: ToolCallContent[] } {
    if (Array.isArray(content) && content.length > 0) {
      return {
        content: content.map((c: any) => ({
          type: "content" as const,
          content: transformContentBlock(c),
        })),
      };
    } else if (typeof content === "string" && content.length > 0) {
      return {
        content: [{
          type: "content",
          content: { type: "text", text: content },
        }],
      };
    }
    return {};
  }

  /**
   * Transform a content block to ACP format, handling both:
   * - MCP format: {type: "image", data, mimeType}
   * - Claude format: {type: "image", source: {type: "base64", data, media_type}}
   */
  function transformContentBlock(c: any): ContentBlock {
    if (c.type === "text") {
      return { type: "text", text: c.text };
    }

    if (c.type === "image") {
      // MCP flat format: {type: "image", data, mimeType}
      if (c.data && c.mimeType) {
        return {
          type: "image",
          data: c.data,
          mimeType: c.mimeType,
        };
      }
      // Claude nested format: {type: "image", source: {type: "base64", data, media_type}}
      if (c.source?.type === "base64") {
        return {
          type: "image",
          data: c.source.data || "",
          mimeType: c.source.media_type || "",
        };
      }
      // Claude URL format: {type: "image", source: {type: "url", url}}
      if (c.source?.type === "url") {
        return {
          type: "image",
          data: "",
          mimeType: "",
          uri: c.source.url,
        };
      }
    }

    // Fallback: pass through as-is
    return c as ContentBlock;
  }

  /**
   * Convert TodoWrite input to PlanEntry array.
   * Ported from tools.ts planEntries()
   */
  function planEntries(input: { todos: Array<{ content: string; status: string }> }): PlanEntry[] {
    return input.todos.map((todo) => ({
      content: todo.content,
      status: (todo.status as PlanEntry["status"]) || "pending",
      priority: "medium" as const,
    }));
  }
}
