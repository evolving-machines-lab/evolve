/**
 * Gemini JSONL → ACP-style events parser.
 *
 * Native schema (gemini --output-format stream-json):
 *   gemini-cli/packages/core/src/output/types.ts
 *
 * Gemini events (types.ts:29-36 JsonStreamEventType):
 * - "init"        → types.ts:43-47 InitEvent { session_id, model }
 * - "message"     → types.ts:49-54 MessageEvent { role, content, delta? }
 * - "tool_use"    → types.ts:56-61 ToolUseEvent { tool_name, tool_id, parameters }
 * - "tool_result" → types.ts:63-72 ToolResultEvent { tool_id, status, output?, error? }
 * - "error"       → types.ts:74-78 ErrorEvent { severity, message }
 * - "result"      → types.ts:91-99 ResultEvent { status, error?, stats? }
 *
 * ACP output: acp-typescript-sdk/src/schema/types.gen.ts:2449-2464
 */

import {
  OutputEvent,
  SessionUpdate,
  ToolKind,
  ToolCallContent,
  ToolCallLocation,
} from "./types";

/** Map Gemini tool names to ACP ToolKind
 * Reference: gemini-cli/packages/core/src/tools/tool-names.ts
 */
const TOOL_KINDS: Record<string, ToolKind> = {
  // File operations
  read_file: "read",
  read_many_files: "read",
  write_file: "edit",
  replace: "edit", // EDIT_TOOL_NAME in gemini-cli
  edit_file: "edit",
  // Shell
  run_shell_command: "execute",
  shell: "execute",
  // Search
  glob: "search",
  grep: "search",
  search_file_content: "search", // GREP_TOOL_NAME in gemini-cli
  list_directory: "search",
  // Web
  brave_web_search: "fetch",
  web_search: "fetch",
  google_web_search: "fetch", // WEB_SEARCH_TOOL_NAME in gemini-cli
  web_fetch: "fetch",
  // Agent/planning
  delegate_to_agent: "think",
  write_todos: "other",
  save_memory: "other",
  activate_skill: "other",
};

/**
 * Create a Gemini parser instance.
 */
export function createGeminiParser(): (jsonLine: string) => OutputEvent[] | null {
  return function parseGeminiEvent(jsonLine: string): OutputEvent[] | null {
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
    const events: OutputEvent[] = [];

    switch (data.type) {
      // Session lifecycle - skip
      case "init":
      case "result":
        return null;

      // Messages
      case "message": {
        const update = handleMessage(data);
        if (update) events.push({ sessionId, update });
        break;
      }

      // Tool use (call started)
      case "tool_use": {
        const update = handleToolUse(data);
        if (update) events.push({ sessionId, update });
        break;
      }

      // Tool result (call completed)
      case "tool_result": {
        const update = handleToolResult(data);
        if (update) events.push({ sessionId, update });
        break;
      }

      // Error events (warnings/errors during execution)
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
   * Handle message events (types.ts:49-54 MessageEvent)
   * role: 'user' | 'assistant', content: string
   */
  function handleMessage(data: any): SessionUpdate | null {
    const role = data.role;
    const content = data.content;

    if (!content) return null;

    if (role === "assistant") {
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: content },
      };
    }

    if (role === "user") {
      return {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: content },
      };
    }

    return null;
  }

  /**
   * Handle tool_use events (types.ts:56-61 ToolUseEvent)
   */
  function handleToolUse(data: any): SessionUpdate | null {
    const toolId = data.tool_id;
    const toolName = data.tool_name;
    const params = data.parameters || {};

    const { title, kind, content, locations } = getToolInfo(toolName, params);

    return {
      sessionUpdate: "tool_call",
      toolCallId: toolId,
      title,
      kind,
      status: "pending",
      rawInput: params,
      content,
      locations,
    };
  }

  /**
   * Handle tool_result events (types.ts:63-72 ToolResultEvent)
   * status: 'success' | 'error', output?: string, error?: { type, message }
   */
  function handleToolResult(data: any): SessionUpdate | null {
    const toolId = data.tool_id;
    const status = data.status;
    const output = data.output;
    const error = data.error;

    const content: ToolCallContent[] = [];

    // Add output content
    if (output && typeof output === "string" && output.length > 0) {
      content.push({
        type: "content",
        content: {
          type: "text",
          text: status === "error" ? `\`\`\`\n${output}\n\`\`\`` : output,
        },
      });
    }

    // Add error message if present
    if (error?.message && !output) {
      content.push({
        type: "content",
        content: { type: "text", text: `\`\`\`\n${error.message}\n\`\`\`` },
      });
    }

    return {
      sessionUpdate: "tool_call_update",
      toolCallId: toolId,
      status: status === "success" ? "completed" : "failed",
      content,
    };
  }

  /**
   * Handle error events (types.ts:74-78 ErrorEvent)
   * severity: 'warning' | 'error', message: string
   */
  function handleError(data: any): SessionUpdate | null {
    const severity = data.severity;
    const message = data.message;

    if (!message) return null;

    // Emit as agent message with error formatting
    const prefix = severity === "warning" ? "⚠️ Warning" : "❌ Error";
    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${prefix}: ${message}` },
    };
  }

  /**
   * Get tool info from tool name and parameters
   */
  function getToolInfo(toolName: string, params: any): {
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
      case "read_file":
        title = `Read ${params.absolute_path || params.file_path || "file"}`;
        if (params.absolute_path || params.file_path) {
          locations.push({ path: params.absolute_path || params.file_path });
        }
        break;

      case "write_file":
        title = `Write ${params.file_path || "file"}`;
        if (params.file_path) {
          locations.push({ path: params.file_path });
          content.push({
            type: "diff",
            path: params.file_path,
            oldText: null,
            newText: params.content || "",
          });
        }
        break;

      case "edit_file":
        title = `Edit ${params.file_path || "file"}`;
        if (params.file_path) {
          locations.push({ path: params.file_path });
        }
        break;

      case "replace":
        // gemini-cli EDIT_TOOL_NAME - string replacement edit
        title = `Edit ${params.file_path || "file"}`;
        if (params.file_path) {
          locations.push({ path: params.file_path });
          if (params.old_string !== undefined || params.new_string !== undefined) {
            content.push({
              type: "diff",
              path: params.file_path,
              oldText: params.old_string || "",
              newText: params.new_string || "",
            });
          }
        }
        break;

      case "run_shell_command":
      case "shell":
        title = params.command ? `\`${params.command}\`` : "Run command";
        if (params.description) {
          content.push({
            type: "content",
            content: { type: "text", text: params.description },
          });
        }
        break;

      case "brave_web_search":
      case "web_search":
      case "google_web_search":
        title = params.query ? `"${params.query}"` : "Web search";
        break;

      case "web_fetch":
        // Gemini uses prompt parameter containing URL(s)
        title = params.prompt ? `Fetch: ${params.prompt.substring(0, 50)}...` : "Web fetch";
        break;

      case "glob":
        // Gemini uses dir_path parameter
        title = `Find ${params.pattern || "files"}`;
        if (params.dir_path) locations.push({ path: params.dir_path });
        break;

      case "grep":
      case "search_file_content":
        title = `grep "${params.pattern || params.query || ""}"`;
        break;

      case "list_directory":
        // Gemini uses dir_path parameter
        title = `List ${params.dir_path || params.path || "directory"}`;
        if (params.dir_path || params.path) {
          locations.push({ path: params.dir_path || params.path });
        }
        break;

      case "read_many_files":
        // Gemini uses include parameter (array of glob patterns)
        title = `Read ${params.include?.length || "multiple"} files`;
        if (Array.isArray(params.include)) {
          params.include.forEach((p: string) => locations.push({ path: p }));
        }
        break;

      case "delegate_to_agent":
        // Gemini uses agent_name parameter
        title = params.agent_name ? `Agent: ${params.agent_name}` : "Delegate to agent";
        break;

      case "write_todos":
        title = "Update todos";
        break;

      case "save_memory":
        title = params.fact ? `Remember: "${params.fact.substring(0, 40)}..."` : "Save memory";
        break;

      case "activate_skill":
        title = params.name ? `Activate skill: ${params.name}` : "Activate skill";
        break;

      default:
        // MCP tools or unknown
        title = toolName;
    }

    return { title, kind, content, locations };
  }
}
