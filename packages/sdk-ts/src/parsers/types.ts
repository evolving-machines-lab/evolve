/**
 * ACP-inspired output types for unified agent event streaming.
 * These types are independent of @agentclientprotocol/sdk.
 *
 * ACP schema reference:
 *   MANUS-API/KNOWLEDGE/acp-typescript-sdk/src/schema/types.gen.ts
 *   (SessionUpdate, ContentBlock, ImageContent, TextContent, ToolCall, ToolCallUpdate, Plan)
 *
 * INTERNAL REFERENCE - JSDoc stripped from published package.
 *
 * @example Event Flow
 * ```
 * agent_message_chunk  → Text/image streaming from agent
 * agent_thought_chunk  → Reasoning (Codex) or thinking (Claude)
 * user_message_chunk   → User message echo (Gemini)
 * tool_call            → Tool started (status: pending/in_progress)
 * tool_call_update     → Tool finished (status: completed/failed)
 * plan                 → TodoWrite updates
 * ```
 *
 * @example UI Integration
 * ```ts
 * evolve.on('content', (event: OutputEvent) => {
 *   switch (event.update.sessionUpdate) {
 *     case 'agent_message_chunk':
 *       appendToChat(event.update.content);
 *       break;
 *     case 'tool_call':
 *       addToolCard(event.update.toolCallId, event.update.title);
 *       break;
 *     case 'tool_call_update':
 *       updateToolCard(event.update.toolCallId, event.update.status);
 *       break;
 *   }
 * });
 * ```
 */

/**
 * Tool operation category for UI grouping/icons.
 *
 * | Kind | Tools | Icon suggestion |
 * |------|-------|-----------------|
 * | read | Read, NotebookRead | 📄 |
 * | edit | Edit, Write, NotebookEdit | ✏️ |
 * | delete | (future) | 🗑️ |
 * | move | (future) | 📦 |
 * | search | Glob, Grep, LS | 🔍 |
 * | execute | Bash, BashOutput, KillShell | ⚡ |
 * | think | Task (subagent) | 🧠 |
 * | fetch | WebFetch, WebSearch | 🌐 |
 * | switch_mode | ExitPlanMode | 🔀 |
 * | other | MCP tools, unknown | ❓ |
 */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

/**
 * Tool execution lifecycle.
 *
 * Flow: pending → in_progress → completed|failed
 *
 * - pending: Tool call received, not yet executing
 * - in_progress: Tool is executing (Codex command_execution)
 * - completed: Tool finished successfully
 * - failed: Tool errored (check content for error message)
 */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * Plan/Todo item status.
 */
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

/**
 * Text content block.
 */
export interface TextContent {
  type: "text";
  text: string;
}

/**
 * Image content block (base64 or URL).
 */
export interface ImageContent {
  type: "image";
  /** Base64-encoded image data */
  data: string;
  /** MIME type (e.g., "image/png") */
  mimeType: string;
  /** Optional URL if image is remote */
  uri?: string;
}

/**
 * Diff content for file edits.
 */
export interface DiffContent {
  type: "diff";
  /** File path being edited */
  path: string;
  /** Original text (null for new files) */
  oldText: string | null;
  /** New text after edit */
  newText: string;
}

/**
 * Content that can appear in messages.
 */
export type ContentBlock = TextContent | ImageContent;

/**
 * Content attached to tool calls.
 * Either wrapped content or a diff.
 */
export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | DiffContent;

/**
 * File location affected by a tool call.
 */
export interface ToolCallLocation {
  /** Absolute file path */
  path: string;
  /** Line number (0-indexed for Read offset) */
  line?: number;
}

/**
 * Todo/plan entry from TodoWrite.
 */
export interface PlanEntry {
  /** Task description */
  content: string;
  /** Current status */
  status: PlanEntryStatus;
  /** Priority level */
  priority: "high" | "medium" | "low";
}

/**
 * All possible session update types.
 * Discriminated union on `sessionUpdate` field.
 */
export type SessionUpdate =
  | AgentMessageChunk
  | AgentThoughtChunk
  | UserMessageChunk
  | ToolCall
  | ToolCallUpdate
  | Plan;

/**
 * Streaming text/image from agent.
 * May arrive in multiple chunks - concatenate text.
 */
export interface AgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
}

/**
 * Agent reasoning/thinking (not shown to end user by default).
 * - Codex: "reasoning" item type
 * - Claude: "thinking" content block
 */
export interface AgentThoughtChunk {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
}

/**
 * User message echo (primarily from Gemini).
 */
export interface UserMessageChunk {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
}

/**
 * Tool call started.
 *
 * Match with ToolCallUpdate via `toolCallId`.
 *
 * @example Claude Read tool
 * ```json
 * {
 *   "sessionUpdate": "tool_call",
 *   "toolCallId": "toolu_01ABC...",
 *   "title": "Read /src/index.ts (1 - 100)",
 *   "kind": "read",
 *   "status": "pending",
 *   "locations": [{ "path": "/src/index.ts", "line": 0 }]
 * }
 * ```
 */
export interface ToolCall {
  sessionUpdate: "tool_call";
  /** Unique ID to match with ToolCallUpdate */
  toolCallId: string;
  /** Human-readable title (e.g., "`npm install`", "Read /path/file.ts") */
  title: string;
  /** Tool category for UI grouping */
  kind: ToolKind;
  /** Execution status */
  status: ToolCallStatus;
  /** Original tool input parameters */
  rawInput?: unknown;
  /** Diff for edits, description for commands */
  content?: ToolCallContent[];
  /** File paths affected */
  locations?: ToolCallLocation[];
}

/**
 * Tool call completed/failed.
 *
 * Match with ToolCall via `toolCallId`.
 *
 * @example Successful completion
 * ```json
 * {
 *   "sessionUpdate": "tool_call_update",
 *   "toolCallId": "toolu_01ABC...",
 *   "status": "completed",
 *   "content": [{ "type": "content", "content": { "type": "text", "text": "..." } }]
 * }
 * ```
 *
 * @example Failed tool
 * ```json
 * {
 *   "sessionUpdate": "tool_call_update",
 *   "toolCallId": "toolu_01ABC...",
 *   "status": "failed",
 *   "content": [{ "type": "content", "content": { "type": "text", "text": "```\nError: ...\n```" } }]
 * }
 * ```
 *
 * @example Browser-Use MCP tool response
 * The browser-use MCP tool returns a JSON string in content[].content.text:
 * ```json
 * {
 *   "sessionUpdate": "tool_call_update",
 *   "toolCallId": "...",
 *   "status": "completed",
 *   "content": [{
 *     "type": "content",
 *     "content": {
 *       "type": "text",
 *       "text": "{\"live_url\":\"https://...\",\"screenshot_url\":\"https://...\",\"steps\":[{\"screenshot_url\":\"https://...\"}]}"
 *     }
 *   }]
 * }
 * ```
 * The `text` field contains a JSON string with:
 * - `live_url`: URL for live browser view (VNC/noVNC)
 * - `screenshot_url`: URL for screenshot image
 * - `steps[].screenshot_url`: Alternative location for screenshots
 */
export interface ToolCallUpdate {
  sessionUpdate: "tool_call_update";
  /** Matches ToolCall.toolCallId */
  toolCallId: string;
  /** Final status */
  status?: ToolCallStatus;
  /** Updated title (e.g., "Exited Plan Mode") */
  title?: string;
  /** Output content or error message */
  content?: ToolCallContent[];
  /** Updated locations (rare) */
  locations?: ToolCallLocation[];
}

/**
 * Todo list update from TodoWrite tool.
 * Replaces entire todo list on each update.
 */
export interface Plan {
  sessionUpdate: "plan";
  /** All current plan entries */
  entries: PlanEntry[];
}

/**
 * Top-level event emitted by Evolve 'content' event.
 *
 * @example
 * ```ts
 * evolve.on('content', (event: OutputEvent) => {
 *   console.log(event.sessionId, event.update.sessionUpdate);
 * });
 * ```
 */
export interface OutputEvent {
  /** Session ID (from agent, may be undefined) */
  sessionId?: string;
  /** The session update payload */
  update: SessionUpdate;
}

/**
 * Browser-use MCP tool response schema.
 * First-party Evolve integration - auto-available with API key.
 *
 * Location: ToolCallUpdate.content[].content.text (as JSON string)
 *
 * @example Extracting browser-use URLs (robust)
 * ```typescript
 * function extractBrowserUseUrls(text: string): { liveUrl?: string; screenshotUrl?: string } {
 *   let liveUrl: string | undefined;
 *   let screenshotUrl: string | undefined;
 *
 *   // Regex first (faster, handles malformed JSON)
 *   const liveMatch = text.match(/"live_url"\s*:\s*"([^"]+)"/);
 *   if (liveMatch) liveUrl = liveMatch[1];
 *
 *   const screenshotMatch = text.match(/"screenshot_url"\s*:\s*"([^"]+)"/);
 *   if (screenshotMatch) screenshotUrl = screenshotMatch[1];
 *
 *   // JSON.parse fallback for nested access
 *   if (!liveUrl || !screenshotUrl) {
 *     try {
 *       const parsed = JSON.parse(text) as BrowserUseResponse;
 *       if (!liveUrl) liveUrl = parsed.live_url;
 *       if (!screenshotUrl) screenshotUrl = parsed.screenshot_url ?? parsed.steps?.[0]?.screenshot_url;
 *     } catch {}
 *   }
 *
 *   return { liveUrl, screenshotUrl };
 * }
 *
 * // Usage with ToolCallUpdate:
 * for (const c of update.content ?? []) {
 *   if (c.type === 'content' && c.content?.type === 'text') {
 *     const urls = extractBrowserUseUrls(c.content.text);
 *     console.log(urls.liveUrl, urls.screenshotUrl);
 *   }
 * }
 * ```
 */
export interface BrowserUseResponse {
  /** URL for live browser view (VNC/noVNC) */
  live_url?: string;
  /** URL for screenshot image */
  screenshot_url?: string;
  /** Step history with screenshots */
  steps?: Array<{ screenshot_url?: string }>;
}
