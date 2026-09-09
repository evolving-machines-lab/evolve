/**
 * Qwen NDJSON → ACP-style events parser.
 *
 * Native schema: KNOWLEDGE/qwen-code/packages/sdk-typescript/src/types/protocol.ts
 * ACP schema: KNOWLEDGE/acp-typescript-sdk/src/schema/types.gen.ts
 *
 * Qwen NDJSON message types (protocol.ts:428-433):
 * - type: "assistant"    → SDKAssistantMessage (protocol.ts:102-108)
 * - type: "stream_event" → SDKPartialAssistantMessage (protocol.ts:225-231)
 * - type: "user"         → SDKUserMessage (protocol.ts:93-100)
 * - type: "system"       → SDKSystemMessage (skipped)
 * - type: "result"       → SDKResultMessage (skipped)
 *
 * ContentBlock types (protocol.ts:72-76):
 * - TextBlock (protocol.ts:43-48): { type: 'text', text: string }
 * - ThinkingBlock (protocol.ts:49-54): { type: 'thinking', thinking: string }
 * - ToolUseBlock (protocol.ts:56-62): { type: 'tool_use', id, name, input }
 * - ToolResultBlock (protocol.ts:64-70): { type: 'tool_result', tool_use_id, content?, is_error? }
 *
 * StreamEvent types (protocol.ts:218-223):
 * - message_start, content_block_start, content_block_delta, content_block_stop, message_stop
 */

import {
  harnessErrorText,
  OutputEvent,
  SessionUpdate,
  TokenUsage,
  ToolKind,
  ToolCallContent,
  ToolCallLocation,
  PlanEntry,
} from "./types";

/** Map Qwen tool names to ACP ToolKind */
const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  read_file: "read",
  Write: "edit",
  Edit: "edit",
  write_file: "edit",
  edit_file: "edit",
  Bash: "execute",
  BashOutput: "execute",
  KillShell: "execute",
  shell: "execute",
  run_shell_command: "execute",
  WebFetch: "fetch",
  WebSearch: "fetch",
  brave_web_search: "fetch",
  Glob: "search",
  Grep: "search",
  LS: "search",
  list_directory: "search",
  Task: "think",
  TodoWrite: "other",
  ExitPlanMode: "switch_mode",
};

// =============================================================================
// QWEN PROTOCOL TYPES
// Subset of protocol.ts types needed for parsing
// =============================================================================

// protocol.ts:43-48
interface TextBlock {
  type: "text";
  text: string;
}

// protocol.ts:49-54
interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

// protocol.ts:56-62
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

// protocol.ts:64-70
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

// protocol.ts:72-76
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// protocol.ts:83-91 — id, model, stop_reason and usage are the message's own
// facts (live wire, qwen-code 0.23.0: usage carries input_tokens,
// output_tokens, cache_read_input_tokens, total_tokens).
interface APIAssistantMessage {
  id: string;
  role: "assistant";
  content: ContentBlock[];
  model?: string;
  stop_reason?: string | null;
  usage?: Record<string, unknown>;
}

// protocol.ts:102-108; parent_tool_use_id (protocol.ts:98,107) names the
// parent's tool call on a SUBAGENT's line, null on the main conversation.
interface SDKAssistantMessage {
  type: "assistant";
  uuid: string;
  session_id: string;
  parent_tool_use_id?: string | null;
  message: APIAssistantMessage;
}

// protocol.ts:93-100 (subset)
interface SDKUserMessage {
  type: "user";
  session_id: string;
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
}

// protocol.ts:189-201
interface ContentBlockDelta {
  type: "text_delta" | "thinking_delta" | "input_json_delta";
  text?: string;
  thinking?: string;
  partial_json?: string;
}

// protocol.ts:218-223
interface StreamEvent {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_stop";
  index?: number;
  content_block?: ContentBlock;
  delta?: ContentBlockDelta;
}

// protocol.ts:225-231
interface SDKPartialAssistantMessage {
  type: "stream_event";
  uuid: string;
  session_id: string;
  event: StreamEvent;
}

// =============================================================================
// PARSER
// =============================================================================

/**
 * Create a Qwen parser instance.
 * Stateful to track content blocks during streaming.
 */
export function createQwenParser() {
  // Track streaming content blocks by index during stream_event processing
  const streamingBlocks: Map<number, ContentBlock> = new Map();
  // Accumulate JSON input for tool_use blocks during input_json_delta streaming
  const toolInputBuffers: Map<number, string> = new Map();

  return function parseQwenEvent(jsonLine: string): OutputEvent[] | null {
    let data: unknown;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }

    if (!data || typeof data !== "object") return null;
    const msg = data as Record<string, unknown>;

    // Skip metadata lines (from session logger)
    if ("_meta" in msg || "_prompt" in msg) {
      return null;
    }

    const sessionId = (msg.session_id as string) || undefined;
    const updates: SessionUpdate[] = [];

    switch (msg.type) {
      // Full assistant message (non-streaming mode). Each line prints its
      // message's usage (qwen-code 0.23.0 wire); the message id on the
      // envelope lets a consumer keep one accounting per message.
      case "assistant": {
        const assistant = msg as unknown as SDKAssistantMessage;
        updates.push(...handleAssistantMessage(assistant));
        const usage = qwenTokenUsage(assistant.message?.usage);
        if (usage) updates.push({ sessionUpdate: "usage", scope: "call", usage });
        break;
      }

      // Streaming events
      case "stream_event": {
        updates.push(...handleStreamEvent(msg as unknown as SDKPartialAssistantMessage));
        break;
      }

      // User message (includes tool_result blocks)
      case "user": {
        updates.push(...handleUserMessage(msg as unknown as SDKUserMessage));
        break;
      }

      // System messages - skip
      case "system":
        return null;

      // THE RUN'S VERDICT (protocol.ts:152-170 SDKResultMessageError). A
      // success carries no transcript — its text already streamed — but it
      // is the one line with the run's whole usage (protocol.ts:146,161), so
      // it becomes a run-scoped usage event — on a failure too: a run that
      // hit error_max_turns did its turns, and the usage variant is never
      // work (isAgentWorkUpdate), so carrying its total cannot make a failed
      // run look like one that did something. A failure (is_error: true,
      // subtype error_max_turns | error_during_execution) is qwen reporting
      // that the run itself failed, and skipping it dropped that failure
      // entirely, leaving an unreachable-model run indistinguishable from one
      // that produced nothing. `error` is optional on the wire, so the subtype
      // is the fallback — qwen's own word for what went wrong, not an invented
      // classification.
      case "result": {
        const usage = qwenTokenUsage(msg.usage);
        if (usage) updates.push({ sessionUpdate: "usage", scope: "run", usage });
        if (msg.is_error !== true) break;
        const error = msg.error as { message?: unknown } | undefined;
        updates.push({
          sessionUpdate: "error",
          message: harnessErrorText([error?.message, msg.subtype], msg.error ?? msg),
          fatal: true,
        });
        break;
      }

      default:
        return null;
    }

    if (updates.length === 0) return null;

    // The line's own facts on every envelope (parsers/types.ts OutputEvent):
    // the message's model and id, its stop reason, and — on a subagent's
    // line — the parent tool call it belongs to. Only values the line carried.
    const message = msg.message as Partial<APIAssistantMessage> | undefined;
    const model = typeof message?.model === "string" && message.model ? message.model : undefined;
    const messageId = typeof message?.id === "string" && message.id ? message.id : undefined;
    const parentToolCallId =
      typeof msg.parent_tool_use_id === "string" && msg.parent_tool_use_id ? msg.parent_tool_use_id : undefined;
    const stopReason = message?.stop_reason;
    const extra = stopReason !== null && stopReason !== undefined ? { stop_reason: stopReason } : undefined;
    return updates.map((update) => ({
      sessionId,
      update,
      ...(model !== undefined ? { model } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      ...(extra !== undefined ? { extra } : {}),
    }));
  };

  /**
   * message.usage / result.usage → TokenUsage. qwen's input_tokens is the
   * whole prompt (it equals the native session file's promptTokenCount, the
   * figure qwen_code.py:192 reads as prompt_tokens); cache_read_input_tokens
   * is the cached share; every other counter (total_tokens) rides extra
   * verbatim. Null when the line carried no usage object.
   */
  function qwenTokenUsage(usage: unknown): TokenUsage | null {
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
    const record = usage as Record<string, unknown>;
    const num = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const result: TokenUsage = {};
    const prompt = num(record.input_tokens);
    const completion = num(record.output_tokens);
    const cached = num(record.cache_read_input_tokens);
    if (prompt !== undefined) result.promptTokens = prompt;
    if (completion !== undefined) result.completionTokens = completion;
    if (cached !== undefined) result.cachedTokens = cached;
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "input_tokens" || key === "output_tokens" || key === "cache_read_input_tokens") continue;
      if (value === null || value === undefined) continue;
      extra[key] = value;
    }
    if (Object.keys(extra).length > 0) result.extra = extra;
    return result;
  }

  /**
   * Handle full assistant message (protocol.ts:102-108) in non-streaming mode.
   */
  function handleAssistantMessage(msg: SDKAssistantMessage): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    const content = msg.message?.content;

    if (!Array.isArray(content)) return updates;

    for (const block of content) {
      const blockUpdates = processContentBlock(block);
      updates.push(...blockUpdates);
    }

    return updates;
  }

  /**
   * Handle streaming events (protocol.ts:225-231, event types: 218-223).
   */
  function handleStreamEvent(
    msg: SDKPartialAssistantMessage
  ): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    const event = msg.event;

    if (!event) return updates;

    switch (event.type) {
      case "content_block_start": {
        const index = event.index ?? 0;
        const block = event.content_block;
        if (block) {
          streamingBlocks.set(index, block);
          // For tool_use blocks, initialize input buffer but DON'T emit yet
          // Wait for content_block_stop to have complete input
          if (block.type === "tool_use") {
            toolInputBuffers.set(index, "");
          }
        }
        break;
      }

      case "content_block_delta": {
        const index = event.index ?? 0;
        const delta = event.delta;
        const block = streamingBlocks.get(index);

        if (delta?.type === "text_delta" && delta.text) {
          updates.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: delta.text },
          });
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          updates.push({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: delta.thinking },
          });
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          // Accumulate tool input JSON
          if (block?.type === "tool_use") {
            const current = toolInputBuffers.get(index) || "";
            toolInputBuffers.set(index, current + delta.partial_json);
          }
        }
        break;
      }

      case "content_block_stop": {
        const index = event.index ?? 0;
        const block = streamingBlocks.get(index);

        if (block) {
          if (block.type === "text" && (block as TextBlock).text) {
            // Already streamed via deltas, skip
          } else if (
            block.type === "thinking" &&
            (block as ThinkingBlock).thinking
          ) {
            // Already streamed via deltas, skip
          } else if (block.type === "tool_use") {
            // Now emit tool_call with complete input
            const toolBlock = block as ToolUseBlock;
            const accumulatedJson = toolInputBuffers.get(index) || "";
            toolInputBuffers.delete(index);

            // Parse accumulated JSON and merge with existing input
            let finalInput = toolBlock.input as Record<string, unknown> | undefined;
            if (accumulatedJson) {
              try {
                finalInput = JSON.parse(accumulatedJson);
              } catch {
                // Keep original input if parsing fails
              }
            }

            // Create complete tool block and emit
            const completeBlock: ToolUseBlock = {
              ...toolBlock,
              input: finalInput,
            };
            const update = handleToolUseBlock(completeBlock);
            if (update) updates.push(update);
          } else if (block.type === "tool_result") {
            // Tool result - emit update
            const update = handleToolResultBlock(block as ToolResultBlock);
            if (update) updates.push(update);
          }
        }

        streamingBlocks.delete(index);
        break;
      }

      case "message_start":
      case "message_stop":
        // No-op for these events
        break;
    }

    return updates;
  }

  /**
   * Handle user message (protocol.ts:93-100). May contain tool_result blocks.
   */
  function handleUserMessage(msg: SDKUserMessage): SessionUpdate[] {
    const content = msg.message?.content;
    const updates: SessionUpdate[] = [];

    if (typeof content === "string") {
      updates.push({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: content },
      });
      return updates;
    }

    // If content is array of blocks, process each
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") {
          updates.push({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: (block as TextBlock).text },
          });
        } else if (block.type === "tool_result") {
          const update = handleToolResultBlock(block as ToolResultBlock);
          if (update) updates.push(update);
        }
      }
    }

    return updates;
  }

  /**
   * Process a content block (protocol.ts:72-76) into session updates.
   */
  function processContentBlock(block: ContentBlock): SessionUpdate[] {
    switch (block.type) {
      case "text":
        if (block.text) {
          return [
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: block.text },
            },
          ];
        }
        return [];

      case "thinking":
        if (block.thinking) {
          return [
            {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: block.thinking },
            },
          ];
        }
        return [];

      case "tool_use": {
        const update = handleToolUseBlock(block);
        return update ? [update] : [];
      }

      case "tool_result": {
        const update = handleToolResultBlock(block);
        return update ? [update] : [];
      }
    }
  }

  /**
   * Handle tool_use block (protocol.ts:56-62) → tool_call event or plan update.
   */
  function handleToolUseBlock(block: ToolUseBlock): SessionUpdate | null {
    const toolId = block.id;
    const toolName = block.name;
    const input = block.input as Record<string, unknown> | undefined;

    // Special handling for TodoWrite → emit plan update
    if (toolName === "TodoWrite" && Array.isArray(input?.todos)) {
      return {
        sessionUpdate: "plan",
        entries: (input.todos as Array<{ content: string; status: string }>).map(
          (todo): PlanEntry => ({
            content: todo.content,
            status: (todo.status as PlanEntry["status"]) || "pending",
            priority: "medium",
          })
        ),
      };
    }

    const { title, kind, content, locations } = getToolInfo(
      toolName,
      input || {}
    );

    return {
      sessionUpdate: "tool_call",
      toolCallId: toolId,
      title,
      toolName,
      kind,
      status: "pending",
      rawInput: input,
      content,
      locations,
    };
  }

  /**
   * Handle tool_result block (protocol.ts:64-70) → tool_call_update event.
   */
  function handleToolResultBlock(
    block: ToolResultBlock
  ): SessionUpdate | null {
    const toolId = block.tool_use_id;
    const isError = block.is_error ?? false;
    const resultContent = block.content;
    const content: ToolCallContent[] = [];

    // The result content as qwen sent it — no fence around a failure: the
    // bytes are the harness's (qwen_code.py:233-244 keeps the raw output),
    // framing is a viewer's decision.
    if (typeof resultContent === "string" && resultContent.length > 0) {
      content.push({
        type: "content",
        content: { type: "text", text: resultContent },
      });
    } else if (Array.isArray(resultContent)) {
      for (const item of resultContent) {
        if (item.type === "text") {
          content.push({
            type: "content",
            content: { type: "text", text: (item as TextBlock).text },
          });
        }
      }
    }

    return {
      sessionUpdate: "tool_call_update",
      toolCallId: toolId,
      status: isError ? "failed" : "completed",
      content,
    };
  }

  /**
   * Get tool info from tool name and input parameters
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
      case "Read":
      case "read_file":
        title = `Read ${input.file_path || input.absolute_path || "file"}`;
        if (input.file_path || input.absolute_path) {
          locations.push({
            path: (input.file_path || input.absolute_path) as string,
          });
        }
        break;

      case "Write":
      case "write_file":
        title = `Write ${input.file_path || "file"}`;
        if (input.file_path) {
          locations.push({ path: input.file_path as string });
          content.push({
            type: "diff",
            path: input.file_path as string,
            oldText: null,
            newText: (input.content as string) || "",
          });
        }
        break;

      case "Edit":
      case "edit_file":
        title = `Edit ${input.file_path || "file"}`;
        if (input.file_path) {
          locations.push({ path: input.file_path as string });
        }
        break;

      case "Bash":
      case "shell":
      case "run_shell_command":
        title = input.command ? `\`${input.command}\`` : "Run command";
        if (input.description) {
          content.push({
            type: "content",
            content: { type: "text", text: input.description as string },
          });
        }
        break;

      case "WebFetch":
        title = input.url ? `Fetch ${input.url}` : "Web fetch";
        break;

      case "WebSearch":
      case "brave_web_search":
        title = input.query ? `"${input.query}"` : "Web search";
        break;

      case "Glob":
        title = `Find ${input.pattern || "files"}`;
        if (input.path) locations.push({ path: input.path as string });
        break;

      case "Grep":
        title = `grep "${input.pattern || ""}"`;
        break;

      case "LS":
      case "list_directory":
        title = `List ${input.path || "directory"}`;
        if (input.path) locations.push({ path: input.path as string });
        break;

      case "Task":
        title = (input.description as string) || "Subagent task";
        break;

      case "TodoWrite":
        title = "Update todos";
        break;

      case "ExitPlanMode":
        title = "Exit plan mode";
        break;

      default:
        // MCP tools or unknown
        title = toolName;
    }

    return { title, kind, content, locations };
  }
}

/**
 * Stateless parser function (creates new parser per call).
 * Use createQwenParser() for stateful streaming parsing.
 *
 * @param line - Single line of NDJSON from qwen CLI
 * @returns Array of OutputEvent objects, or null if line couldn't be parsed
 */
export function parseQwenOutput(line: string): OutputEvent[] | null {
  const parser = createQwenParser();
  return parser(line);
}
