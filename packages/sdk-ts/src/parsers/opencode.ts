/**
 * OpenCode JSONL → ACP-style events parser.
 *
 * Native format: `opencode run --format json` outputs JSONL to stdout.
 * Each line is a JSON object with a `type` field.
 *
 * OpenCode event types:
 * - "step_start"  → lifecycle (skip)
 * - "text"        → agent_message_chunk
 * - "reasoning"   → agent_thought_chunk
 * - "tool_use"    → tool_call + tool_call_update (tools arrive completed or error)
 * - "step_finish" → lifecycle (skip)
 * - "error"       → agent_message_chunk (error text)
 *
 * Key differences from other parsers:
 * - tool_use events arrive already completed/error (not pending→result like Claude),
 *   so we emit both tool_call (pending) and tool_call_update (completed/failed) from a single event.
 * - ToolStateError has `error: string` (NOT `output`), ToolStateCompleted has `output: string`.
 *
 * Reference:
 *   Part schemas: KNOWLEDGE/opencode/packages/opencode/src/session/message-v2.ts (TextPart, StepFinishPart, ToolState*, etc.)
 *   Wire format:  KNOWLEDGE/opencode/packages/opencode/src/cli/cmd/run.ts (emit() function, event handlers)
 *   ACP output:   parsers/types.ts (OutputEvent, SessionUpdate)
 */

import {
  OutputEvent,
  PlanEntry,
  SessionUpdate,
  ToolKind,
  ToolCallContent,
  ToolCallLocation,
} from "./types";

/** Map OpenCode tool names to ACP ToolKind */
const TOOL_KINDS: Record<string, ToolKind> = {
  // File operations
  read: "read",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  apply_patch: "edit",
  // Shell
  bash: "execute",
  // Search
  glob: "search",
  grep: "search",
  list: "search",
  codesearch: "search",
  lsp: "search",
  // Web
  webfetch: "fetch",
  websearch: "fetch",
  // Agent/planning
  task: "think",
  batch: "think",
  plan_enter: "switch_mode",
  plan_exit: "switch_mode",
  todoread: "other",
  todowrite: "other",
  skill: "other",
  question: "other",
};

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)?((?:;[^,]+)*),(.*)$/s.exec(url);
  if (!match) return null;
  const mimeType = match[1] || "";
  const params = match[2] || "";
  const data = match[3] || "";
  if (!/;base64/i.test(params)) return null;
  return { mimeType, data };
}

function normalizeTodoStatus(status: unknown): PlanEntry["status"] {
  if (typeof status !== "string") return "pending";
  switch (status.toLowerCase()) {
    case "in_progress":
    case "in-progress":
    case "running":
      return "in_progress";
    case "completed":
    case "done":
    case "cancelled":
      return "completed";
    default:
      return "pending";
  }
}

function normalizeTodoPriority(priority: unknown): PlanEntry["priority"] {
  if (priority === "high" || priority === "medium" || priority === "low") {
    return priority;
  }
  return "medium";
}

function parseTodoEntries(value: unknown): PlanEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): PlanEntry | null => {
      if (!item || typeof item !== "object") return null;
      const content = (item as { content?: unknown }).content;
      if (typeof content !== "string" || content.length === 0) return null;
      return {
        content,
        status: normalizeTodoStatus((item as { status?: unknown }).status),
        priority: normalizeTodoPriority((item as { priority?: unknown }).priority),
      };
    })
    .filter((entry): entry is PlanEntry => entry !== null);
}

function toAttachmentContent(item: unknown): ToolCallContent | null {
  if (!item || typeof item !== "object") return null;
  const attachment = item as { mime?: unknown; url?: unknown; filename?: unknown };
  const mimeType = typeof attachment.mime === "string" ? attachment.mime : "";
  const url = typeof attachment.url === "string" ? attachment.url : "";

  if (mimeType.startsWith("image/")) {
    if (url.length > 0) {
      const parsed = parseDataUrl(url);
      if (parsed) {
        return {
          type: "content",
          content: { type: "image", data: parsed.data, mimeType: parsed.mimeType || mimeType },
        };
      }
      return {
        type: "content",
        content: { type: "image", data: "", mimeType, uri: url },
      };
    }
    return null;
  }

  // ACP content blocks support text/image only, so preserve non-image attachments as text references.
  const filename = typeof attachment.filename === "string" ? attachment.filename : "";
  const label = filename || "attachment";
  const detail = mimeType || "file";
  return {
    type: "content",
    content: { type: "text", text: `[attachment] ${label} (${detail})` },
  };
}

function getResultText(status: unknown, state: Record<string, unknown>): string | null {
  if (status === "error") {
    return typeof state.error === "string" ? state.error : null;
  }
  if (typeof state.output === "string") return state.output;
  if (state.output === undefined || state.output === null) return null;
  try {
    return JSON.stringify(state.output);
  } catch {
    return String(state.output);
  }
}

function toUpdateStatus(
  status: unknown,
  exitCode: unknown
): "pending" | "in_progress" | "completed" | "failed" {
  if (status === "error") return "failed";
  if (status === "running") return "in_progress";
  if (status === "pending") return "pending";
  if (typeof exitCode === "number" && exitCode !== 0) return "failed";
  return "completed";
}

/**
 * Create an OpenCode parser instance.
 */
export function createOpenCodeParser(): (jsonLine: string) => OutputEvent[] | null {
  return function parseOpenCodeEvent(jsonLine: string): OutputEvent[] | null {
    let data: any;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }

    if (!data || typeof data !== "object") return null;

    const sessionId = data.sessionID;
    const events: OutputEvent[] = [];

    switch (data.type) {
      // Lifecycle - skip
      case "step_start":
      case "step_finish":
        return null;

      // Text content from agent
      case "text": {
        const update = handleText(data);
        if (update) events.push({ sessionId, update });
        break;
      }

      // Reasoning/thinking (emitted with --thinking flag)
      case "reasoning": {
        const update = handleReasoning(data);
        if (update) events.push({ sessionId, update });
        break;
      }

      // Tool use (arrives already completed or error)
      case "tool_use": {
        const updates = handleToolUse(data);
        for (const update of updates) {
          events.push({ sessionId, update });
        }
        break;
      }

      // Error events
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
   * Handle text events
   * { type: "text", part: { type: "text", text: string, time?: { start, end? } } }
   */
  function handleText(data: any): SessionUpdate | null {
    const text = data.part?.text;
    if (typeof text !== "string" || text.length === 0) return null;

    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    };
  }

  /**
   * Handle reasoning events
   * { type: "reasoning", part: { type: "reasoning", text: string, time: { start, end? } } }
   */
  function handleReasoning(data: any): SessionUpdate | null {
    const text = data.part?.text;
    if (typeof text !== "string" || text.length === 0) return null;

    return {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    };
  }

  /**
   * Handle tool_use events
   *
   * OpenCode emits tool_use with completed/error status, so we emit both:
   * 1. tool_call (pending) - for UI to show the tool card
   * 2. tool_call_update (completed/failed) - with output or error
   *
   * ToolStateCompleted: { status: "completed", input, output: string, title, metadata, time }
   * ToolStateError:     { status: "error", input, error: string, metadata?, time }
   */
  function handleToolUse(data: any): SessionUpdate[] {
    const part = data.part;
    if (!part) return [];

    const callId = typeof part.callID === "string" ? part.callID : "";
    if (callId.length === 0) return [];
    const toolName = typeof part.tool === "string" ? part.tool.toLowerCase() : "";
    const state = typeof part.state === "object" && part.state ? part.state : {};
    const input = typeof state.input === "object" && state.input ? state.input : {};
    const status = state.status;
    const title = state.title ?? state.metadata?.description ?? toolName;
    const exitCode = state.metadata?.exit;

    const { kind, content: callContent, locations } = getToolInfo(toolName, input);

    const updates: SessionUpdate[] = [];

    // Emit tool_call (pending)
    updates.push({
      sessionUpdate: "tool_call",
      toolCallId: callId,
      title,
      kind,
      status: "pending",
      rawInput: input,
      content: callContent,
      locations,
    });

    if (toolName === "todowrite") {
      let entries = parseTodoEntries((input as { todos?: unknown }).todos);
      if (entries.length === 0 && typeof state.output === "string") {
        try {
          entries = parseTodoEntries(JSON.parse(state.output));
        } catch {
          // Ignore invalid JSON output and skip plan update.
        }
      }
      if (entries.length > 0) {
        updates.push({
          sessionUpdate: "plan",
          entries,
        });
      }
    }

    // Emit tool_call_update. OpenCode run JSON emits tool_use at completed/error.
    const updateStatus = toUpdateStatus(status, exitCode);
    if (updateStatus === "pending") return updates;

    const resultText = getResultText(status, state);
    const resultContent: ToolCallContent[] = [];

    if (typeof resultText === "string" && resultText.length > 0) {
      resultContent.push({
        type: "content",
        content: {
          type: "text",
          text: updateStatus === "failed" ? `\`\`\`\n${resultText}\n\`\`\`` : resultText,
        },
      });
    }

    if (Array.isArray(state.attachments)) {
      for (const attachment of state.attachments) {
        const block = toAttachmentContent(attachment);
        if (block) resultContent.push(block);
      }
    }

    updates.push({
      sessionUpdate: "tool_call_update",
      toolCallId: callId,
      status: updateStatus,
      content: resultContent,
    });

    return updates;
  }

  /**
   * Handle error events
   * { type: "error", error: { name, data: { message } } }
   */
  function handleError(data: any): SessionUpdate | null {
    const errorName = data.error?.name ?? "Error";
    const message = data.error?.data?.message ?? data.error?.message ?? "Unknown error";

    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `❌ ${errorName}: ${message}` },
    };
  }

  /**
   * Get tool info from tool name and input parameters.
   */
  function getToolInfo(
    toolName: string,
    input: Record<string, unknown>
  ): {
    kind: ToolKind;
    content: ToolCallContent[];
    locations: ToolCallLocation[];
  } {
    const kind = TOOL_KINDS[toolName] || "other";
    const content: ToolCallContent[] = [];
    const locations: ToolCallLocation[] = [];

    switch (toolName) {
      case "read": {
        const path = (input.filePath ?? input.path) as string | undefined;
        if (path) {
          const offset = input.offset;
          locations.push({
            path,
            line: typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, offset - 1) : undefined,
          });
        }
        break;
      }

      case "write": {
        const path = (input.filePath ?? input.path) as string | undefined;
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

      case "edit":
      case "multiedit": {
        const path = (input.filePath ?? input.path) as string | undefined;
        if (path) {
          locations.push({ path });
          if (toolName === "edit" && (input.oldString !== undefined || input.newString !== undefined)) {
            content.push({
              type: "diff",
              path,
              oldText: (input.oldString as string) ?? "",
              newText: (input.newString as string) ?? "",
            });
          }
        }
        break;
      }

      case "apply_patch": {
        // apply_patch uses patchText, no file path in input (paths are in the patch itself)
        break;
      }

      case "bash": {
        const cmd = input.command as string | undefined;
        if (cmd && input.description) {
          content.push({
            type: "content",
            content: { type: "text", text: input.description as string },
          });
        } else if (cmd) {
          content.push({
            type: "content",
            content: { type: "text", text: cmd },
          });
        }
        break;
      }

      case "glob":
      case "list": {
        const path = input.path as string | undefined;
        if (path) locations.push({ path });
        break;
      }

      case "grep": {
        const path = input.path as string | undefined;
        if (path) locations.push({ path });
        break;
      }

      case "codesearch":
      case "websearch": {
        const query = input.query as string | undefined;
        if (query) {
          content.push({
            type: "content",
            content: { type: "text", text: query },
          });
        }
        break;
      }

      case "webfetch": {
        const url = input.url as string | undefined;
        if (url) {
          content.push({
            type: "content",
            content: { type: "text", text: url },
          });
        }
        break;
      }

      case "task": {
        const description = input.description as string | undefined;
        if (description) {
          content.push({
            type: "content",
            content: { type: "text", text: description },
          });
        }
        break;
      }

      // skill, question, todoread, todowrite, lsp, batch, plan_enter/plan_exit — no extra extraction
      default:
        break;
    }

    return { kind, content, locations };
  }
}
