/**
 * DeepSeek Harness (dsh) `--profile headless --json` → ACP-style events.
 *
 * Native format: one JSON object per stdout line, ten event shapes
 * (deepseek-harness packages/bundle/headless/src/json-stream.ts at tag
 * dsh-v0.1.7-rc.2, commit 477b4f4 — the emitting source; no exported type,
 * JSON Schema or docs page declares the vocabulary, and the vendor calls it
 * "a projection, not the log" with pre-stable APIs):
 *
 *   session      { sessionId, cwd }                 first line; the id the
 *                                                   resume flag needs
 *   status       { phase: turn_start | step_start } lifecycle (nothing to carry)
 *                { phase: step_end, usage? }        usage (scope "call": one
 *                                                   step = one model call)
 *                { phase: turn_end, reason }        completed → nothing;
 *                                                   any other kind → error
 *   thinking     { text }                           agent_thought_chunk
 *   text         { text }                           agent_message_chunk
 *   tool_call    { callId, tool, input }            tool_call (pending)
 *   tool_result  { callId, status, result }         tool_call_update
 *   final        { text }                           the last assistant text —
 *                                                   emitted only when no `text`
 *                                                   line already carried it
 *   error        { message }                        error (fatal: a driver
 *                                                   failure outside a turn)
 *
 * Every string is capped at 8 KiB and a line at 32 KiB; a cut line carries
 * `truncated: true`, which rides the envelope's `extra`. No line carries a
 * clock, a model id, a message id or a cost — the on-disk session log
 * (~/.dsh/sessions/…/session.v4.jsonl.zstd, captured with the home) has them.
 *
 * FAILURE SEMANTICS (live captures, harness-recon-2026-09-25/06-live-tests/dsh
 * rounds 1 and 2): a failed turn ends with `turn_end {reason: {kind: "error",
 * error: {message, code, status?}}}` then `final ""` and exit 1; the retries
 * before it are invisible here (`step_end` usage is all zeros after a fully
 * failed step). `tool_result.status: "error"` is a tool-level failure only —
 * a shell command's non-zero exit comes back `completed` with the code in the
 * text. After SIGINT the stream ends at `final` with no `turn_end` at all.
 * The exit code IS a verdict for dsh (0 only on `completed`), unlike pi.
 *
 * Any `type` or `status.phase` outside this vocabulary is logged once and
 * skipped — never a failure, never work — because the stream is unversioned
 * and the vendor promises breaking changes; the raw line still reaches the
 * stored stdout trace untouched (the run loop writes every line).
 */

import { harnessErrorText } from "./types";
import type {
  OutputEvent,
  PlanEntry,
  PlanEntryStatus,
  SessionUpdate,
  TokenUsage,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "./types";

/** dsh's tool names (the headless profile's request/header tool list) → ACP kind. */
const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  read_image: "read",
  write: "edit",
  edit: "edit",
  glob: "search",
  grep: "search",
  bash: "execute",
  run_code: "execute",
  job_list: "execute",
  job_output: "execute",
  job_kill: "execute",
  web_search: "fetch",
  web_fetch: "fetch",
  subagent: "think",
  subagent_fork: "think",
  exit_plan_mode: "switch_mode",
  // Bookkeeping, agent control, goals, skills, workflows and every mcp__*
  // tool fall to "other" (the map's default).
};

export function createDshParser(): (jsonLine: string) => OutputEvent[] | null {
  let sessionId: string | undefined;
  let lastAssistantText: string | undefined;
  const warned = new Set<string>();

  return function parseDshEvent(jsonLine: string): OutputEvent[] | null {
    let data: unknown;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }
    if (!isRecord(data)) return null;

    const type = stringField(data, "type");
    const updates: SessionUpdate[] = [];
    // Facts of the line with no ACP slot, under the wire's own names.
    const extra: Record<string, unknown> = {};
    if (data.truncated === true) extra.truncated = true;

    switch (type) {
      case "session": {
        const id = stringField(data, "sessionId");
        if (id) sessionId = id;
        return null;
      }

      case "status": {
        const update = handleStatus(data, extra, warnOnce);
        if (update) updates.push(update);
        break;
      }

      case "thinking": {
        const text = stringField(data, "text");
        if (text) updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
        break;
      }

      case "text": {
        const text = stringField(data, "text");
        if (text) {
          lastAssistantText = text;
          updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
        }
        break;
      }

      case "tool_call": {
        updates.push(...handleToolCall(data));
        break;
      }

      case "tool_result": {
        const update = handleToolResult(data);
        if (update) updates.push(update);
        break;
      }

      // The run's closing text, lossless and uncapped. A completed turn
      // already streamed it as the last `text` block, so it is skipped
      // unless it differs — after SIGINT it is the only copy of the partial
      // answer (round-2 E3), and `""` on a failed turn says nothing.
      case "final": {
        const text = stringField(data, "text");
        if (text && text !== lastAssistantText) {
          lastAssistantText = text;
          updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
        }
        break;
      }

      // A driver failure outside a turn, or a usage/grammar error; the
      // stream ends here without `final` (json-stream.ts), so it is terminal.
      case "error": {
        updates.push({
          sessionUpdate: "error",
          message: harnessErrorText([data.message], data),
          fatal: true,
        });
        break;
      }

      default:
        warnOnce(`event type ${JSON.stringify(type)}`);
        return null;
    }

    if (updates.length === 0) return null;
    return updates.map((update) => ({
      sessionId,
      update,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    }));
  };

  function warnOnce(what: string): void {
    if (warned.has(what)) return;
    warned.add(what);
    console.warn(`[Evolve] dsh parser: unknown ${what} skipped (the raw line stays in the stdout trace)`);
  }
}

/**
 * `status` lines. `usage` on step_end is dsh's TokenUsage — DISJOINT counts
 * (deepseek-harness packages/llm/llm/src/types.ts: inputTokens is the
 * uncached share; cacheReadTokens, cacheWriteTokens, outputTokens,
 * totalTokens?, reasoningTokens?; live T2: 210 + 74 + 5376 = totalTokens
 * 5660). Harbor's arithmetic then: prompt = input + cache read + cache write,
 * completion = output, cached = cache read; the remaining counters ride
 * `extra` under their wire names. A counter the line did not carry is absent.
 */
function handleStatus(
  data: Record<string, unknown>,
  extra: Record<string, unknown>,
  warnOnce: (what: string) => void,
): SessionUpdate | null {
  const phase = stringField(data, "phase");
  switch (phase) {
    case "turn_start":
    case "step_start":
      return null;

    case "step_end": {
      const usage = stepUsage(data.usage);
      if (!usage) return null;
      if (typeof data.turn === "number") extra.turn = data.turn;
      if (typeof data.step === "number") extra.step = data.step;
      return { sessionUpdate: "usage", scope: "call", usage };
    }

    // `reason.kind`: completed | aborted | blocked | error | max-tokens |
    // interrupted | forked (json-stream.ts / session types TurnEndReason).
    // Everything but `completed` ended the turn without an answer and exits
    // non-zero, so it is the error variant with dsh's own text: the error's
    // message, the abort's reason, else the reason object dumped (never
    // blank). The kind and the error's code/status ride `extra` verbatim.
    case "turn_end": {
      const reason = asRecord(data.reason);
      const kind = reason ? stringField(reason, "kind") : "";
      if (kind === "completed") return null;
      const error = reason ? asRecord(reason.error) : null;
      if (typeof data.turn === "number") extra.turn = data.turn;
      if (kind) extra.kind = kind;
      for (const key of ["code", "status", "requestId", "providerRetryAfterMs"] as const) {
        const value = error?.[key];
        if (value !== undefined && value !== null) extra[key] = value;
      }
      return {
        sessionUpdate: "error",
        message: harnessErrorText([error?.message, reason?.reason], reason ?? data),
        fatal: true,
      };
    }

    default:
      warnOnce(`status phase ${JSON.stringify(phase)}`);
      return null;
  }
}

function stepUsage(value: unknown): TokenUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const input = finiteNumber(record.inputTokens);
  const output = finiteNumber(record.outputTokens);
  const cacheRead = finiteNumber(record.cacheReadTokens);
  const cacheWrite = finiteNumber(record.cacheWriteTokens);

  const usage: TokenUsage = {};
  if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
    usage.promptTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  if (output !== undefined) usage.completionTokens = output;
  if (cacheRead !== undefined) usage.cachedTokens = cacheRead;

  const extra: Record<string, unknown> = {};
  for (const [key, counter] of Object.entries(record)) {
    if (key === "inputTokens" || key === "outputTokens" || key === "cacheReadTokens") continue;
    if (counter === null || counter === undefined) continue;
    extra[key] = counter;
  }
  if (Object.keys(extra).length > 0) usage.extra = extra;
  return usage;
}

/**
 * `tool_call {callId, tool, input}`: `input` is the parsed arguments object
 * (`{}` when empty; the raw string when the model's JSON did not parse). The
 * name rides `toolName` verbatim — an MCP tool is `mcp__<server>__<tool>`.
 * `todo_write` also yields a `plan` (its schema, read from the live
 * request/header: `todos[{content, status: pending|in_progress|completed}]`,
 * no priority — dsh declares none, so every entry is "medium").
 */
function handleToolCall(data: Record<string, unknown>): SessionUpdate[] {
  const callId = stringField(data, "callId");
  if (!callId) return [];
  const toolName = stringField(data, "tool");
  const input = asRecord(data.input) ?? {};
  const { title, kind, content, locations } = toolInfo(toolName, input);

  const updates: SessionUpdate[] = [
    {
      sessionUpdate: "tool_call",
      toolCallId: callId,
      title,
      toolName,
      kind,
      status: "pending",
      rawInput: data.input,
      content,
      locations,
    },
  ];
  if (toolName === "todo_write") {
    const entries = planEntries(input.todos);
    if (entries.length > 0) updates.push({ sessionUpdate: "plan", entries });
  }
  return updates;
}

/**
 * `tool_result {callId, status: completed | error, result}`: `result` is the
 * tool's text blocks concatenated (images and structured content are dropped
 * by the projection), verbatim — no fence, no prefix; a viewer frames it.
 * `error` is the tool failing (a missing file), never a command's exit code.
 */
function handleToolResult(data: Record<string, unknown>): SessionUpdate | null {
  const callId = stringField(data, "callId");
  if (!callId) return null;
  const text = stringify(data.result);
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: callId,
    status: data.status === "error" ? "failed" : "completed",
    content: text ? [{ type: "content", content: { type: "text", text } }] : [],
  };
}

function toolInfo(toolName: string, input: Record<string, unknown>): {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
} {
  const kind = TOOL_KINDS[toolName] ?? "other";
  const path = stringField(input, "file_path") || stringField(input, "path");
  const command = stringField(input, "command");
  const url = stringField(input, "url");
  const detail =
    path ||
    command ||
    url ||
    stringField(input, "pattern") ||
    stringField(input, "name") ||
    stringField(input, "description");
  const content: ToolCallContent[] = [];
  const locations: ToolCallLocation[] = [];

  switch (toolName) {
    case "read": {
      if (path) {
        const offset = input.offset;
        // dsh's read `offset` is 1-based like Claude's; ACP lines are 0-based.
        locations.push({
          path,
          line: typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, offset - 1) : undefined,
        });
      }
      break;
    }
    case "write": {
      if (path) {
        locations.push({ path });
        if (typeof input.content === "string") {
          content.push({ type: "diff", path, oldText: null, newText: input.content });
        }
      }
      break;
    }
    case "edit": {
      if (path) {
        locations.push({ path });
        if (typeof input.old_string === "string" || typeof input.new_string === "string") {
          content.push({
            type: "diff",
            path,
            oldText: typeof input.old_string === "string" ? input.old_string : "",
            newText: typeof input.new_string === "string" ? input.new_string : "",
          });
        }
      }
      break;
    }
    case "bash": {
      const description = stringField(input, "description");
      if (description || command) {
        content.push({ type: "content", content: { type: "text", text: description || command } });
      }
      break;
    }
    case "glob":
    case "grep": {
      if (path) locations.push({ path });
      break;
    }
    case "web_fetch":
    case "web_search": {
      const text = url || stringField(input, "query");
      if (text) content.push({ type: "content", content: { type: "text", text } });
      break;
    }
    case "subagent":
    case "subagent_fork": {
      const description = stringField(input, "description");
      if (description) content.push({ type: "content", content: { type: "text", text: description } });
      break;
    }
    default:
      break;
  }

  return {
    title: detail ? `${toolName} ${detail}` : toolName,
    kind,
    content,
    locations,
  };
}

function planEntries(value: unknown): PlanEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: PlanEntry[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const content = record ? stringField(record, "content") : "";
    if (!content) continue;
    const status = record ? stringField(record, "status") : "";
    entries.push({
      content,
      status: (status === "in_progress" || status === "completed" ? status : "pending") as PlanEntryStatus,
      priority: "medium",
    });
  }
  return entries;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
