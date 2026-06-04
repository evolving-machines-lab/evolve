/**
 * Droid exec parser.
 *
 * Supports the documented headless `--output-format stream-json` lines and the
 * raw `stream-jsonrpc` notification envelope used by Droid's low-level SDK.
 */

import type {
  OutputEvent,
  PlanEntryStatus,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "./types";

const TOOL_KINDS: Record<string, ToolKind> = {
  applypatch: "edit",
  apply_patch: "edit",
  create: "edit",
  edit: "edit",
  grep: "search",
  glob: "search",
  ls: "search",
  read: "read",
  write: "edit",
  execute: "execute",
  execute_cli: "execute",
  fetchurl: "fetch",
  fetch_url: "fetch",
  webfetch: "fetch",
  web_fetch: "fetch",
  websearch: "fetch",
  web_search: "fetch",
  skill: "execute",
  task: "think",
  todowrite: "other",
  todo_write: "other",
};

const IGNORED_NOTIFICATION_TYPES = new Set([
  "assistant_text_complete",
  "thinking_text_complete",
  "droid_working_state_changed",
  "permission_resolved",
  "settings_updated",
  "session_title_updated",
  "mcp_status_changed",
  "session_token_usage_changed",
  "mission_state_changed",
  "mission_features_changed",
  "mission_progress_entry",
  "mission_heartbeat",
  "mission_worker_started",
  "mission_worker_completed",
  "mcp_auth_required",
  "mcp_auth_completed",
  "structured_output",
]);

export function createDroidParser(): (jsonLine: string) => OutputEvent[] | null {
  const toolNames = new Map<string, string>();
  let sessionId: string | undefined;
  let emittedAssistantText = false;
  let lastAssistantText = "";
  let lastThoughtSignature: string | undefined;

  return function parseDroidEvent(jsonLine: string): OutputEvent[] | null {
    let data: unknown;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }

    if (!isRecord(data)) return null;

    const rpcResponse = parseJsonRpcResponse(data);
    if (rpcResponse.sessionId) sessionId = rpcResponse.sessionId;
    if (rpcResponse.errorText) return [agentText(sessionId, rpcResponse.errorText)];
    if (rpcResponse.resultText) {
      lastAssistantText = rpcResponse.resultText;
      emittedAssistantText = true;
      return [agentText(sessionId, rpcResponse.resultText)];
    }
    if (rpcResponse.handled) return null;

    const notification = unwrapJsonRpcNotification(data);
    const event = notification ?? data;
    const eventSessionId = getSessionId(event);
    if (eventSessionId) sessionId = eventSessionId;

    const events: OutputEvent[] = [];
    const type = stringField(event, "type");

    switch (type) {
      case "system": {
        return null;
      }

      case "message": {
        const role = stringField(event, "role");
        const text = stringField(event, "text") || extractText(event.content);
        if (!text) break;
        if (role === "assistant") {
          emittedAssistantText = true;
          lastAssistantText = text;
          events.push(agentText(sessionId, text));
        }
        break;
      }

      case "completion": {
        const text = stringField(event, "finalText") || stringField(event, "result");
        if (text && (!emittedAssistantText || text !== lastAssistantText)) {
          emittedAssistantText = true;
          lastAssistantText = text;
          events.push(agentText(sessionId, text));
        }
        break;
      }

      case "assistant_text_delta": {
        const text = stringField(event, "textDelta") || stringField(event, "text");
        if (text) {
          emittedAssistantText = true;
          lastAssistantText += text;
          events.push(agentText(sessionId, text));
        }
        break;
      }

      case "thinking_text_delta": {
        // Factory SDK stream-jsonrpc emits thinking_text_delta; droid exec
        // stream-json currently emits the same content as top-level reasoning.
        const text = stringField(event, "textDelta") || stringField(event, "text");
        if (text) {
          const update = createThoughtUpdate(event, text, lastThoughtSignature);
          if (update) {
            lastThoughtSignature = update.signature;
            events.push({ sessionId, update: update.event });
          }
        }
        break;
      }

      case "reasoning": {
        const text = stringField(event, "text");
        if (text) {
          const update = createThoughtUpdate(event, text, lastThoughtSignature);
          if (update) {
            lastThoughtSignature = update.signature;
            events.push({ sessionId, update: update.event });
          }
        }
        break;
      }

      case "assistant": {
        const text = stringField(event, "text") || extractText(asRecord(event.message)?.content);
        if (text) {
          emittedAssistantText = true;
          lastAssistantText = text;
          events.push(agentText(sessionId, text));
        }
        break;
      }

      case "tool_call":
      case "tool_call_delta": {
        const toolUse = asRecord(event.toolUse) ?? asRecord(event.tool_use) ?? event;
        const update = handleToolUse(toolUse, toolNames);
        if (update) events.push({ sessionId, update });
        break;
      }

      case "tool_result": {
        const update = handleToolResult(event, toolNames);
        if (update) events.push({ sessionId, update });
        break;
      }

      case "tool_progress_update":
      case "tool_progress": {
        const update = handleToolProgress(event);
        if (update) events.push({ sessionId, update });
        break;
      }

      case "create_message": {
        for (const update of handleCreateMessage(event, toolNames)) {
          if (update.sessionUpdate === "agent_message_chunk") {
            const text = update.content.type === "text" ? update.content.text : "";
            if (emittedAssistantText && text === lastAssistantText) continue;
            emittedAssistantText = true;
            lastAssistantText = text;
          }
          events.push({ sessionId, update });
        }
        break;
      }

      case "result": {
        const text = stringify(event.result ?? event.text ?? event.error);
        if (text) {
          emittedAssistantText = true;
          lastAssistantText = text;
          events.push(agentText(sessionId, text));
        }
        break;
      }

      case "error": {
        const text = stringify(event.message ?? event.error ?? event);
        if (text) events.push(agentText(sessionId, text));
        break;
      }

      default:
        if (type && !IGNORED_NOTIFICATION_TYPES.has(type)) return null;
    }

    if (events.length > 0 && type !== "reasoning" && type !== "thinking_text_delta") {
      lastThoughtSignature = undefined;
    }

    return events.length > 0 ? events : null;
  };
}

function createThoughtUpdate(
  event: Record<string, unknown>,
  text: string,
  lastSignature: string | undefined
): { signature: string; event: SessionUpdate } | null {
  const id = signatureField(event, "id") || signatureField(event, "messageId");
  const blockIndex = signatureField(event, "blockIndex");
  const signature = `${stringField(event, "type")}:${id}:${blockIndex}:${text}`;
  if (signature === lastSignature) return null;

  return {
    signature,
    event: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    },
  };
}

function parseJsonRpcResponse(data: Record<string, unknown>): {
  handled: boolean;
  sessionId?: string;
  resultText?: string;
  errorText?: string;
} {
  if (data.type !== "response") return { handled: false };

  const result = asRecord(data.result);
  const error = asRecord(data.error);
  const sessionId = getSessionId(result ?? data);

  if (error) {
    return {
      handled: true,
      sessionId,
      errorText: stringify(error.message ?? error),
    };
  }

  const resultText = result
    ? stringField(result, "finalText") || stringField(result, "result")
    : "";

  return { handled: true, sessionId, resultText };
}

function unwrapJsonRpcNotification(data: Record<string, unknown>): Record<string, unknown> | null {
  if (data.method !== "droid.session_notification") return null;
  return asRecord(asRecord(data.params)?.notification);
}

function handleCreateMessage(
  data: Record<string, unknown>,
  toolNames: Map<string, string>
): SessionUpdate[] {
  const message = asRecord(data.message);
  if (!message) return [];

  const updates: SessionUpdate[] = [];
  const content = message.content;

  if (Array.isArray(content)) {
    for (const block of content) {
      const item = asRecord(block);
      if (!item) continue;
      if (item.type === "tool_use") {
        const update = handleToolUse(item, toolNames);
        if (update) updates.push(update);
      }
    }
  }

  if (message.role === "assistant") {
    const text = extractText(content);
    if (text) {
      updates.push({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      });
    }
  }

  return updates;
}

function handleToolUse(
  toolUse: Record<string, unknown>,
  toolNames: Map<string, string>
): SessionUpdate | null {
  const toolCallId = stringField(toolUse, "id") ||
    stringField(toolUse, "toolUseId") ||
    stringField(toolUse, "tool_use_id");
  const name = stringField(toolUse, "name") ||
    stringField(toolUse, "toolName") ||
    stringField(toolUse, "tool_name") ||
    "Tool";

  if (!toolCallId) return null;
  toolNames.set(toolCallId, name);

  const input = asRecord(toolUse.input) ??
    asRecord(toolUse.toolInput) ??
    asRecord(toolUse.arguments) ??
    {};

  if (normalizeToolName(name) === "todowrite") {
    const plan = handleTodoWrite(input);
    if (plan) return plan;
  }

  const { title, kind, content, locations } = toolInfo(name, input);
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    kind,
    status: "pending",
    rawInput: input,
    content,
    locations,
  };
}

function handleToolResult(
  data: Record<string, unknown>,
  toolNames: Map<string, string>
): SessionUpdate | null {
  const toolCallId = stringField(data, "toolUseId") ||
    stringField(data, "tool_use_id") ||
    stringField(data, "tool_id");
  if (!toolCallId) return null;

  const toolName = stringField(data, "toolName") ||
    stringField(data, "tool_name") ||
    toolNames.get(toolCallId);
  toolNames.delete(toolCallId);

  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: data.isError === true || data.is_error === true ? "failed" : "completed",
    title: toolName,
    content: contentList(data.content ?? data.result ?? data.error),
  };
}

function handleToolProgress(data: Record<string, unknown>): SessionUpdate | null {
  const toolCallId = stringField(data, "toolUseId") ||
    stringField(data, "tool_use_id") ||
    stringField(data, "tool_id");
  if (!toolCallId) return null;

  const update = asRecord(data.update);
  const text = stringify(
    data.content ??
    update?.text ??
    update?.status ??
    update?.details
  );

  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "in_progress",
    content: text ? contentList(text) : undefined,
  };
}

function handleTodoWrite(input: Record<string, unknown>): SessionUpdate | null {
  const todos = input.todos;
  if (!Array.isArray(todos)) return null;

  const entries = todos.flatMap((todo): Array<{
    content: string;
    status: PlanEntryStatus;
    priority: "high" | "medium" | "low";
  }> => {
    const item = asRecord(todo);
    if (!item) return [];
    const content = stringField(item, "content");
    const status = normalizePlanStatus(stringField(item, "status"));
    const priority = normalizePriority(stringField(item, "priority"));
    return content ? [{ content, status, priority }] : [];
  });

  return entries.length > 0 ? { sessionUpdate: "plan", entries } : null;
}

function toolInfo(toolName: string, input: Record<string, unknown>): {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
} {
  const kind = TOOL_KINDS[normalizeToolName(toolName)] || "other";
  const path = stringField(input, "path") ||
    stringField(input, "filePath") ||
    stringField(input, "file_path") ||
    stringField(input, "absolute_path");
  const command = stringField(input, "command");
  const url = stringField(input, "url");
  const titleDetail = path || command || url;

  return {
    title: titleDetail ? `${toolName} ${titleDetail}` : toolName,
    kind,
    content: Object.keys(input).length > 0 ? contentList(input) : [],
    locations: path ? [{ path }] : [],
  };
}

function getSessionId(data: Record<string, unknown> | null | undefined): string | undefined {
  if (!data) return undefined;
  return stringField(data, "session_id") || stringField(data, "sessionId");
}

function agentText(sessionId: string | undefined, text: string): OutputEvent {
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      const item = asRecord(block);
      if (!item) return "";
      return stringField(item, "text") || stringField(item, "content");
    })
    .filter(Boolean)
    .join("");
}

function contentList(value: unknown): ToolCallContent[] {
  const text = stringify(value);
  return text
    ? [{ type: "content", content: { type: "text", text } }]
    : [];
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : "";
}

function signatureField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function normalizeToolName(name: string): string {
  return name.replace(/[-_\s]/g, "").toLowerCase();
}

function normalizePlanStatus(status: string): PlanEntryStatus {
  if (status === "in_progress" || status === "completed") return status;
  return "pending";
}

function normalizePriority(priority: string): "high" | "medium" | "low" {
  if (priority === "high" || priority === "low") return priority;
  return "medium";
}
