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
 */

import {
  OutputEvent,
  SessionUpdate,
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
      // Thread/turn lifecycle - skip
      case "thread.started":
      case "turn.started":
      case "turn.completed":
        return null;

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

    return events.length > 0 ? events : null;
  };

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
      case "mcp_tool_call": {
        delete pendingToolCalls[itemId];
        const content = extractToolResultContent(item.result);
        const status = item.status === "failed" || item.error ? "failed" : "completed";
        return {
          sessionUpdate: "tool_call_update",
          toolCallId: itemId,
          status,
          content,
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
          kind: "edit" as ToolKind,
          status: item.status === "completed" ? "completed" : "failed",
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
