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
  harnessErrorText,
  OutputEvent,
  SessionUpdate,
  TokenUsage,
  ToolKind,
  ToolCallContent,
  ToolCallLocation,
} from "./types";
import { isoTimestamp } from "./usage";

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
  // gemini names the model and the session ONCE, on init (types.ts:43-47
  // InitEvent { session_id, model }), and never on a message line — so both
  // are remembered here and stamped on every later event's envelope. The
  // native session file names the model per message (gemini_cli.py:367) and
  // the session in its header (gemini_cli.py:319); the stream has only this.
  let model: string | undefined;
  let initSessionId: string | undefined;

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

    const sessionId: string | undefined =
      (typeof data.session_id === "string" && data.session_id ? data.session_id : undefined) ?? initSessionId;
    const events: OutputEvent[] = [];

    switch (data.type) {
      case "init":
        if (typeof data.model === "string" && data.model) model = data.model;
        if (typeof data.session_id === "string" && data.session_id) initSessionId = data.session_id;
        return null;

      // THE TERMINAL FAILURE. Unlike every other harness here, gemini does not
      // report the failure that ENDS a run on its "error" channel — that
      // channel carries warnings the run continues past (see handleError). The
      // run's verdict is the result event's status, and a status of "error"
      // with the flat error:{type,message} is the only place a fatal gemini
      // failure ever appears (types.ts:91-99 ResultEvent). This case used to
      // fall in with "init" and return null, so a gemini run that never reached
      // the model produced no events at all — the drop the AgentError variant
      // exists to end.
      //
      // A SUCCESSFUL result is the one line with the run's accounting: its
      // `stats` (total_tokens, input_tokens, output_tokens, cached, per-model
      // breakdown) — a run-scoped usage event. Per-call usage is not on this
      // stream at all; it lives in the native session file (gemini_cli.py:481).
      case "result": {
        if (data.status !== "error") {
          const usage = geminiStatsUsage(data.stats);
          if (!usage) return null;
          events.push({ sessionId, update: { sessionUpdate: "usage", scope: "run", usage } });
          break;
        }
        events.push({
          sessionId,
          update: {
            sessionUpdate: "error",
            // Gemini's own words first — the message, then the error's type
            // name. The third candidate is ours, and it exists so this ladder
            // never reaches harnessErrorText's raw dump: the raw here is the
            // result event, whose body is the run's token STATS, so a fatal
            // result that arrived without an error object rendered as a blob
            // of counts that says nothing about the failure. The sentence
            // reports the status and stops there — no severity, no cause, no
            // classification gemini did not make itself.
            message: harnessErrorText(
              [
                data.error?.message,
                data.error?.type,
                'gemini ended the run with result status "error" and no error text',
              ],
              data.error ?? data,
            ),
            fatal: true,
          },
        });
        break;
      }

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

    if (events.length === 0) return null;
    const timestamp = isoTimestamp(data.timestamp);
    return events.map((event) => ({
      ...event,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(model !== undefined ? { model } : {}),
    }));
  };

  /**
   * result.stats → TokenUsage. The stats object (types.ts:91-99 ResultEvent)
   * names input_tokens, output_tokens and cached; everything else it carries
   * (total_tokens, duration_ms, tool_calls, the per-model `models` map) rides
   * extra verbatim. Null when the line carried no stats object.
   */
  function geminiStatsUsage(stats: unknown): TokenUsage | null {
    if (!stats || typeof stats !== "object" || Array.isArray(stats)) return null;
    const record = stats as Record<string, unknown>;
    const num = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const usage: TokenUsage = {};
    const prompt = num(record.input_tokens);
    const completion = num(record.output_tokens);
    const cached = num(record.cached);
    if (prompt !== undefined) usage.promptTokens = prompt;
    if (completion !== undefined) usage.completionTokens = completion;
    if (cached !== undefined) usage.cachedTokens = cached;
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "input_tokens" || key === "output_tokens" || key === "cached") continue;
      if (value === null || value === undefined) continue;
      extra[key] = value;
    }
    if (Object.keys(extra).length > 0) usage.extra = extra;
    return usage;
  }

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
      toolName,
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

    // The output and the error text as gemini sent them — no fence around a
    // failure: the bytes are the harness's (gemini_cli.py:412-416 keeps the
    // raw output), framing is a viewer's decision.
    if (output && typeof output === "string" && output.length > 0) {
      content.push({
        type: "content",
        content: { type: "text", text: output },
      });
    }

    // Add error message if present
    if (error?.message && !output) {
      content.push({
        type: "content",
        content: { type: "text", text: error.message },
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
   *
   * A FAILURE THE HARNESS REPORTED, so it is the `error` variant — it used to
   * be an agent_message_chunk carrying a "⚠️ Warning"/"❌ Error" prefix, which
   * broke the honesty law twice over: a consumer counting "did the agent do any
   * work" counted gemini's own complaint as work, and the harness's words were
   * rewritten on the way through.
   *
   * NOT fatal, at either severity. gemini pushes both onto a `warnings` list
   * and keeps going (nonInteractiveCli.ts) — "Maximum session turns exceeded"
   * arrives with severity "error" and still does not end the run. The severity
   * is deliberately not folded into the message or the flag: `fatal` records
   * what the harness did, and the harness did not stop.
   */
  function handleError(data: any): SessionUpdate | null {
    // A message-less error event still surfaces (as a dump of the raw line)
    // rather than returning null the way this used to: swallowing a malformed
    // failure is the same blindness as swallowing a well-formed one.
    return {
      sessionUpdate: "error",
      message: harnessErrorText([data.message], data),
      fatal: false,
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
