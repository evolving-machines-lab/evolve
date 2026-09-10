/**
 * Codex JSONL → ACP-style events parser.
 *
 * Native schema: codex-rs/exec/src/exec_events.rs
 *   - ThreadEvent: thread.started, turn.started, turn.completed, item.started, item.updated, item.completed
 *   - ThreadItemDetails: AgentMessage, Reasoning, CommandExecution, FileChange, McpToolCall, WebSearch, TodoList, Error
 *
 * ACP output: acp-typescript-sdk/src/schema/types.gen.ts
 *   - SessionUpdate: agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan
 *
 * Event mapping:
 *   reasoning         → agent_thought_chunk  (exec_events.rs:134 ReasoningItem { text })
 *   agent_message     → agent_message_chunk  (exec_events.rs:129 AgentMessageItem { text })
 *   mcp_tool_call     → tool_call/update     (exec_events.rs:215 McpToolCallItem)
 *   command_execution → tool_call/update     (exec_events.rs:151 CommandExecutionItem)
 *   file_change       → tool_call            (exec_events.rs:176 FileChangeItem)
 *   todo_list         → plan                 (exec_events.rs:245 TodoListItem { items: TodoItem[] })
 *   web_search        → tool_call            (exec_events.rs:227 WebSearchItem { query })
 *   thread.started    → OutputEvent.sessionId on every later event (thread_id)
 *   turn.completed    → usage (scope "run")  (the turn's usage: input/cached/cache_write/output/reasoning tokens)
 */

import {
  harnessErrorText,
  OutputEvent,
  SessionUpdate,
  TokenUsage,
  ToolKind,
  ToolCallContent,
  ToolCallLocation,
  ContentBlock,
  PlanEntry,
} from "./types";

/**
 * Create a Codex parser instance.
 */
export function createCodexParser() {
  // Track in-progress tool calls for status updates
  const pendingToolCalls: Record<string, { type: string; name?: string }> = {};
  // codex names its session ONCE, on thread.started, and never again — the
  // thread id is the rollout's session_meta id (codex.py:807-814 reads the
  // same id from the file), so it is stamped on every later event's envelope.
  let sessionId: string | undefined;

  return function parseCodexEvent(jsonLine: string): OutputEvent[] | null {
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

    const events: OutputEvent[] = [];

    switch (data.type) {
      case "thread.started":
        if (typeof data.thread_id === "string" && data.thread_id) sessionId = data.thread_id;
        return null;

      // Turn lifecycle - nothing to carry
      case "turn.started":
        return null;

      // THE TURN'S ACCOUNTING. codex exec --json reports usage once per turn,
      // not per model call (the per-call token_count events live only in the
      // rollout file, codex.py:894-897), so this is a run-scoped total: with
      // one prompt per run, the turn IS the run. Field mapping per
      // codex.py:523-541: input_tokens → prompt, output_tokens → completion,
      // cached_input_tokens → cached; cache_write_input_tokens and
      // reasoning_output_tokens ride extra under their own names.
      case "turn.completed": {
        const usage = codexTokenUsage(data.usage);
        if (!usage) return null;
        events.push({ update: { sessionUpdate: "usage", scope: "run", usage } });
        break;
      }

      // FAILURES THE HARNESS REPORTED. codex streams these on stdout beside its
      // normal output while stderr carries only "Reading prompt from stdin...",
      // so dropping them (which this parser used to do, via the default case)
      // made a run that never reached the model indistinguishable from one that
      // produced nothing — the exact blindness that cost a night of diagnosis on
      // a "stream disconnected before completion" failure nobody could see.
      //
      // They are emitted as the `error` variant, NOT as message chunks, so that
      // anything asking "did the harness do work" can exclude them
      // (isAgentWorkUpdate). `error` is retryable//transient in codex's own
      // stream (it emits "Reconnecting… n/5" as one), while `turn.failed` is the
      // turn giving up — hence the fatal flag rather than two variants.
      case "error": {
        const message = harnessErrorText([data.message], data);
        events.push({ update: { sessionUpdate: "error", message, fatal: false } });
        break;
      }
      case "turn.failed": {
        const message = harnessErrorText([data.error?.message], data.error ?? data);
        events.push({ update: { sessionUpdate: "error", message, fatal: true } });
        break;
      }

      // Item started - tool calls begin, todo_list initial
      case "item.started": {
        const item = data.item;
        if (!item) return null;

        const update = handleItemStarted(item);
        if (update) events.push({ update });
        break;
      }

      // Item updated - todo_list progress updates
      case "item.updated": {
        const item = data.item;
        if (!item) return null;

        const update = handleItemUpdated(item);
        if (update) events.push({ update });
        break;
      }

      // Item completed - messages, reasoning, tool results, todo_list final
      case "item.completed": {
        const item = data.item;
        if (!item) return null;

        const update = handleItemCompleted(item);
        if (update) events.push({ update });
        break;
      }

      default:
        return null;
    }

    if (events.length === 0) return null;
    return sessionId === undefined ? events : events.map((event) => ({ sessionId, ...event }));
  };

  /**
   * turn.completed.usage → TokenUsage (codex.py:523-541 field mapping). Null
   * when the line carried no usage object; a counter it did not print is absent.
   */
  function codexTokenUsage(usage: unknown): TokenUsage | null {
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
    const record = usage as Record<string, unknown>;
    const num = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const result: TokenUsage = {};
    const prompt = num(record.input_tokens);
    const completion = num(record.output_tokens);
    const cached = num(record.cached_input_tokens);
    if (prompt !== undefined) result.promptTokens = prompt;
    if (completion !== undefined) result.completionTokens = completion;
    if (cached !== undefined) result.cachedTokens = cached;
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "input_tokens" || key === "output_tokens" || key === "cached_input_tokens") continue;
      if (value === null || value === undefined) continue;
      extra[key] = value;
    }
    if (Object.keys(extra).length > 0) result.extra = extra;
    return result;
  }

  /**
   * Handle item.started events.
   * exec_events.rs:25 ItemStarted { item: ThreadItem }
   */
  function handleItemStarted(item: any): SessionUpdate | null {
    const itemId = item.id;
    const itemType = item.type;

    switch (itemType) {
      // exec_events.rs:215 McpToolCallItem { server, tool, arguments, result, error, status }
      case "mcp_tool_call": {
        pendingToolCalls[itemId] = { type: "mcp_tool_call", name: `${item.server}:${item.tool}` };
        return {
          sessionUpdate: "tool_call",
          toolCallId: itemId,
          title: `${item.server}: ${item.tool}`,
          // Codex is the one harness that splits an MCP name across two wire
          // fields (server + tool) instead of sending one string. We rejoin
          // them as mcp__<server>__<tool> — the exact literal Claude Code puts
          // on the wire for the same tool — so a trajectory reports one name
          // per tool regardless of which harness ran it. Exact-match
          // consumers (Harbor's trajectory_tool_used compares function_name
          // by string equality) would otherwise need per-harness spellings.
          toolName: `mcp__${item.server}__${item.tool}`,
          kind: "other" as ToolKind,
          status: "in_progress",
          rawInput: item.arguments,
          content: [],
        };
      }

      // exec_events.rs:151 CommandExecutionItem { command, aggregated_output, exit_code, status }
      case "command_execution": {
        pendingToolCalls[itemId] = { type: "command_execution", name: item.command };
        return {
          sessionUpdate: "tool_call",
          toolCallId: itemId,
          title: item.command ? `\`${item.command}\`` : "Execute Command",
          // Codex names non-MCP actions by item type, not by a tool name field.
          toolName: "command_execution",
          kind: "execute" as ToolKind,
          status: "in_progress",
          rawInput: { command: item.command },
          content: [],
        };
      }

      // exec_events.rs:227 WebSearchItem { query: String }
      case "web_search": {
        pendingToolCalls[itemId] = { type: "web_search", name: item.query };
        return {
          sessionUpdate: "tool_call",
          toolCallId: itemId,
          title: `Search: ${item.query ?? ""}`,
          toolName: "web_search",
          kind: "fetch" as ToolKind,
          status: "in_progress",
          content: [],
        };
      }

      // exec_events.rs:245 TodoListItem { items: Vec<TodoItem> }
      case "todo_list":
        return {
          sessionUpdate: "plan",
          entries: todoItemsToPlanEntries(item.items),
        };

      default:
        return null;
    }
  }

  /**
   * Handle item.updated events.
   * exec_events.rs:28 ItemUpdated { item: ThreadItem }
   */
  function handleItemUpdated(item: any): SessionUpdate | null {
    switch (item.type) {
      // exec_events.rs:245 TodoListItem { items: Vec<TodoItem> }
      case "todo_list":
        return {
          sessionUpdate: "plan",
          entries: todoItemsToPlanEntries(item.items),
        };

      default:
        return null;
    }
  }

  /**
   * Handle item.completed events.
   * exec_events.rs:31 ItemCompleted { item: ThreadItem }
   */
  function handleItemCompleted(item: any): SessionUpdate | null {
    const itemId = item.id;
    const itemType = item.type;

    switch (itemType) {
      // exec_events.rs ErrorItem — the SAME failure the top-level "error" event
      // carries, arriving as a completed item (observed live: codex reports its
      // transport fallback this way, e.g. "Falling back from WebSockets to HTTPS
      // transport…"). Non-fatal: the turn may still succeed after it.
      case "error": {
        return { sessionUpdate: "error", message: harnessErrorText([item.message], item), fatal: false };
      }

      // exec_events.rs:134 ReasoningItem { text: String }
      // v2.rs:1580 also supports Reasoning { summary: Vec<String>, content: Vec<String> }
      case "reasoning": {
        const text = item.text
          ?? item.summary?.join("\n")
          ?? item.content?.join("\n")
          ?? "";
        return {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        };
      }

      // exec_events.rs:129 AgentMessageItem { text: String }
      case "agent_message":
        return {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: item.text ?? "" },
        };

      // exec_events.rs:215 McpToolCallItem { server, tool, arguments, result, error, status }
      // exec_events.rs:194 McpToolCallStatus: in_progress, completed, failed
      // The completed item is codex's own record of the result (result /
      // error / status; aggregated_output / exit_code / status), so it rides
      // rawOutput verbatim — the exit code used to be read for `status` and
      // then dropped, and a trajectory could not say WHICH non-zero code.
      case "mcp_tool_call": {
        delete pendingToolCalls[itemId];
        const content = extractToolResultContent(item.result);
        const status = item.status === "failed" || item.error ? "failed" : "completed";
        return {
          sessionUpdate: "tool_call_update",
          toolCallId: itemId,
          status,
          content,
          rawOutput: item,
        };
      }

      // exec_events.rs:151 CommandExecutionItem { command, aggregated_output, exit_code, status }
      // exec_events.rs:142 CommandExecutionStatus: in_progress, completed, failed, declined
      case "command_execution": {
        delete pendingToolCalls[itemId];
        const content: ToolCallContent[] = item.aggregated_output
          ? [{ type: "content", content: { type: "text", text: item.aggregated_output } }]
          : [];
        const status = item.status === "completed" || item.exit_code === 0
          ? "completed"
          : "failed";
        return {
          sessionUpdate: "tool_call_update",
          toolCallId: itemId,
          status,
          content,
          rawOutput: item,
        };
      }

      // exec_events.rs:176 FileChangeItem { changes: Vec<FileUpdateChange>, status }
      // exec_events.rs:161 FileUpdateChange { path, kind }
      // exec_events.rs:185 PatchChangeKind: add, delete, update
      case "file_change": {
        const changes: Array<{ path: string; kind: string }> = item.changes ?? [];
        const locations: ToolCallLocation[] = changes.map((c) => ({ path: c.path }));
        const title = changes.length === 1
          ? `${changes[0].kind === "add" ? "Create" : "Edit"} ${changes[0].path}`
          : `Edit ${changes.length} files`;
        return {
          sessionUpdate: "tool_call",
          toolCallId: itemId,
          title,
          toolName: "file_change",
          kind: "edit" as ToolKind,
          status: item.status === "completed" ? "completed" : "failed",
          // The item's own record of what changed (path + kind per file) is
          // the call's input as far as this stream tells it — the patch body
          // itself lives only in the rollout file (codex.py:947-980).
          rawInput: { changes },
          content: changes.map((c) => ({
            type: "diff" as const,
            path: c.path,
            oldText: c.kind === "add" ? null : "",
            newText: "",
          })),
          locations,
        };
      }

      // exec_events.rs:227 WebSearchItem { query: String }
      case "web_search":
        return {
          sessionUpdate: "tool_call",
          toolCallId: itemId,
          title: `Search: ${item.query ?? ""}`,
          toolName: "web_search",
          kind: "fetch" as ToolKind,
          status: "completed",
          content: [],
        };

      // exec_events.rs:245 TodoListItem { items: Vec<TodoItem> }
      // exec_events.rs:239 TodoItem { text: String, completed: bool }
      case "todo_list":
        return {
          sessionUpdate: "plan",
          entries: todoItemsToPlanEntries(item.items),
        };

      default:
        return null;
    }
  }

  /**
   * Extract content from MCP tool result.
   * exec_events.rs:202 McpToolCallItemResult { content: Vec<McpContentBlock>, structured_content }
   */
  function extractToolResultContent(result: any): ToolCallContent[] {
    if (!result?.content) return [];

    if (Array.isArray(result.content)) {
      return result.content.map((c: any) => ({
        type: "content" as const,
        content: transformContentBlock(c),
      }));
    }

    if (typeof result.content === "string") {
      return [{ type: "content", content: { type: "text", text: result.content } }];
    }

    return [];
  }

  /**
   * Transform MCP content block to ACP format.
   * MCP uses snake_case (mime_type), ACP uses camelCase (mimeType).
   */
  function transformContentBlock(c: any): ContentBlock {
    if (c.type === "text") {
      return { type: "text", text: c.text ?? "" };
    }
    if (c.type === "image") {
      return {
        type: "image",
        data: c.data ?? "",
        mimeType: c.mime_type ?? c.mimeType ?? "",
        uri: c.uri,
      };
    }
    return c as ContentBlock;
  }

  /**
   * Convert TodoListItem to ACP PlanEntry[].
   * exec_events.rs:239 TodoItem { text: String, completed: bool }
   * types.ts:144 PlanEntry { content, status, priority }
   *
   * First non-completed item is marked "in_progress", rest are "pending".
   */
  function todoItemsToPlanEntries(items: any[]): PlanEntry[] {
    if (!Array.isArray(items)) return [];

    let foundFirstIncomplete = false;
    return items.map((item) => {
      let status: PlanEntry["status"];
      if (item.completed) {
        status = "completed";
      } else if (!foundFirstIncomplete) {
        status = "in_progress";
        foundFirstIncomplete = true;
      } else {
        status = "pending";
      }
      return { content: item.text ?? "", status, priority: "medium" as const };
    });
  }
}
