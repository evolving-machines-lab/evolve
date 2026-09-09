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
 * error                → A failure the harness reported (never work)
 * usage                → Token accounting the harness reported (never work)
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
  | Plan
  | AgentError
  | AgentUsage;

/**
 * Token accounting as the harness reported it on one wire line.
 *
 * The field names are Harbor's ATIF `Metrics` (harbor/models/trajectories/
 * metrics.py: prompt_tokens, completion_tokens, cached_tokens, cost_usd,
 * extra), camel-cased like every other OutputEvent field, so a trajectory
 * builder copies them without renaming and the SDK and the ATIF document
 * speak one vocabulary. ACP's own end-turn usage shape is still a draft RFD
 * (docs/rfds/end-turn-token-usage.mdx) — when it stabilises this is the
 * one place to reconcile.
 *
 * Only what the harness said is here: a counter it did not report is absent,
 * never 0. `promptTokens` follows Harbor's arithmetic per harness (the cached
 * and cache-written shares INCLUDED, claude_code.py:842-846, opencode.py:330);
 * `extra` keeps the harness's remaining counters under their own wire names
 * verbatim (cache_creation_input_tokens, reasoning_output_tokens, ...).
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  extra?: Record<string, unknown>;
}

/**
 * The harness's own token accounting — NOT agent work.
 *
 * DELIBERATE EXTENSION BEYOND ACP, like AgentError. ACP's `usage_update` is
 * context-window fill plus cumulative session cost (schema/v1 UsageUpdate:
 * used, size, cost), and its per-turn token shape is an unresolved draft, so
 * neither carries what every harness actually prints: per-call usage on the
 * lines that produced it (claude and qwen `message.usage`, opencode
 * `step_finish`), and a whole-run total on the terminal line (codex
 * `turn.completed`, gemini `result.stats`, claude and qwen `result`, droid
 * `completion`). Dropping those left every ATIF step without `metrics`.
 *
 * `scope` says which of the two a line is:
 *   - "call": one LLM inference. Lines of the same `messageId` (OutputEvent)
 *     repeat the same accounting — claude prints one line per content block
 *     with the message's running usage — so a consumer keeps the LAST per
 *     message id (claude_code.py:1147-1158) and sums across ids.
 *   - "run": the harness's total for the whole run, reported once at the end.
 *
 * Excluded from isAgentWorkUpdate: accounting can never make a run that did
 * nothing look like one that did. Parsers emit it only on successful terminal
 * lines for the same reason (a failed run's total is the gateway meter's job).
 */
export interface AgentUsage {
  sessionUpdate: "usage";
  scope: "call" | "run";
  usage: TokenUsage;
}

/**
 * A failure the HARNESS itself reported — not model output, not work.
 *
 * WHY THIS IS ITS OWN VARIANT AND NOT AN agent_message_chunk. Harnesses stream
 * their failures on the same channel as their output: codex writes
 * {"type":"error"} and {"type":"turn.failed"} to stdout as JSONL while its
 * stderr says only "Reading prompt from stdin...". Dropping those left a run
 * that could not reach the model looking identical to a run that produced
 * nothing at all, which cost a full night of blind diagnosis. Folding them into
 * agent_message_chunk would be worse than dropping them: a consumer counting
 * "did the agent do any work" would count the error as work.
 *
 * So the transcript records the failure, and the discriminant says plainly that
 * it is a failure. Anything deciding whether a harness RAN must exclude this
 * variant — see isAgentWorkUpdate() below, and the eval runner's
 * harnessNeverRan law, which must keep firing for an error-only run so an
 * infrastructure failure is never scored as a zero.
 */
export interface AgentError {
  sessionUpdate: "error";
  /** The harness's own message, verbatim. */
  message: string;
  /** True when the harness treated it as terminal for the turn. */
  fatal: boolean;
}

/**
 * Is this update evidence the harness did WORK, as opposed to reporting a
 * failure? The one predicate every "did it run" check should use, so the answer
 * cannot drift between callers.
 */
export function isAgentWorkUpdate(update: { sessionUpdate?: unknown } | null | undefined): boolean {
  return !!update && update.sessionUpdate !== "error" && update.sessionUpdate !== "usage";
}

/**
 * The harness's failure text for an AgentError.message, in ITS OWN WORDS.
 *
 * The seven harnesses put that text in seven different places — codex in
 * `message`, gemini in `error.message`, opencode in `error.data.message` (and
 * in `error.name` when data is empty), claude in an `errors: string[]`, droid
 * in `message`, kimi in `error_message`, qwen in `error.message` — so each
 * parser passes its own fields, in its own preference order, as `candidates`.
 *
 * THE ONE RULE THIS HOLDS FOR ALL OF THEM: the result is never empty. A
 * failure that arrives with no text would render as an event that says
 * nothing, which reads exactly like the "nothing happened" this variant exists
 * to distinguish from — so when no candidate carries text, we dump the raw
 * event rather than emit a blank. This picks among the wire's own strings and
 * never classifies: no severity is folded in, no prefix is added.
 */
export function harnessErrorText(candidates: unknown[], raw: unknown): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  try {
    const dumped = JSON.stringify(raw);
    if (typeof dumped === "string" && dumped.length > 0) return dumped;
  } catch {
    // Circular or otherwise unserializable — fall through to String().
  }
  return String(raw);
}

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
  /**
   * The harness-native tool name, verbatim (e.g. "Bash",
   * "mcp__mcp-server__get_secret").
   *
   * DELIBERATE EXTENSION BEYOND ACP. ACP's ToolCall has no name field: it
   * describes `title` (for humans) and `kind` (for icons), both lossy. A
   * trajectory consumer needs the identifier the model actually called, and
   * every MCP tool collapses to kind "other" — so an ATIF trajectory built
   * from these events could only ever report "other" as its function_name.
   * We add the name rather than re-deriving it from `title`, because titles
   * are formatted per tool and are not round-trippable.
   *
   * Optional so old traces (and any parser path that genuinely has no name)
   * stay valid; consumers should fall back to `kind`.
   */
  toolName?: string;
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
 * @example Failed tool — the harness's error text, verbatim (no fence, no
 * prefix: the bytes are the harness's, a viewer decides how to frame them)
 * ```json
 * {
 *   "sessionUpdate": "tool_call_update",
 *   "toolCallId": "toolu_01ABC...",
 *   "status": "failed",
 *   "content": [{ "type": "content", "content": { "type": "text", "text": "Error: ..." } }]
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
  /**
   * The harness's own structured record of the tool's result, verbatim —
   * ACP's `rawOutput` ("Raw output returned by the tool", schema/v1
   * ToolCallUpdate). Present only when the wire carries one beyond the text
   * in `content`: claude's top-level `tool_use_result` (stdout, stderr,
   * exitCode, interrupted, the file written ...), codex's completed item
   * (aggregated_output, exit_code, status; an MCP result), opencode's tool
   * state (output, metadata, time). A trajectory keeps it as the observation's
   * metadata so an exit code or a stderr never disappears into prose.
   */
  rawOutput?: unknown;
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
  /**
   * The harness's own clock for the line this update came from, ISO 8601.
   * Absent when the wire line carries no time (qwen, kimi, codex stdout).
   */
  timestamp?: string;
  /**
   * The model the harness named for this line (claude and qwen
   * `message.model`; gemini and droid name it once on their init line, which
   * the parser then stamps on every later event). Absent when unnamed.
   */
  model?: string;
  /**
   * The harness's id for the LLM message this line belongs to (claude and
   * qwen `message.id`). Lines sharing an id are one inference split across
   * several wire lines; usage repeats across them (see AgentUsage).
   */
  messageId?: string;
  /**
   * Set when the line belongs to a SUBAGENT: the id of the parent's tool call
   * that delegated to it (claude and qwen `parent_tool_use_id`). Absent on
   * the main conversation. A trajectory groups these into embedded subagent
   * trajectories referenced from that call's observation (ATIF-v1.7
   * subagent_trajectories, qwen_code.py:286-328).
   */
  parentToolCallId?: string;
  /**
   * Facts of the wire line that have no ACP slot, under the harness's own
   * key names verbatim (claude and qwen: stop_reason, stop_sequence). Only
   * keys the line actually carried with a value.
   */
  extra?: Record<string, unknown>;
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
