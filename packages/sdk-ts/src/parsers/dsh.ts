/**
 * DeepSeek Harness (dsh) `--profile headless --json` → ACP-style events.
 *
 * The vocabulary is the emitting source, not a published schema: deepseek-harness
 * packages/bundle/headless/src/json-stream.ts at dsh-v0.1.7-rc.2 (recon
 * 01-deepseek.md §G1; every shape observed live in 06-live-tests/dsh). Ten
 * line types: session, status (turn_start | step_start | step_end | turn_end),
 * thinking, text, tool_call, tool_result, final, error. No clock, model id,
 * message id or cost on any line; strings are capped at 8 KiB (`truncated`).
 *
 * Failure is `turn_end` with a `reason.kind` other than `completed` (round-2
 * E1: retries are invisible, then one turn_end, `final ""`, exit 1); a
 * `tool_result.status: "error"` is a tool failing, a shell's exit code is
 * not (E2/E2b); SIGINT ends the stream at `final` with no turn_end (E3).
 *
 * Any type or phase outside the vocabulary rides `harness_event` and is
 * logged once — the stream is unversioned and pre-stable by the vendor's word.
 */

import { harnessErrorText, harnessEvent, unknownTypeWarner } from "./types";
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

/** The headless profile's tool list (live request/header, T2) → ACP kind; the rest is "other". */
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
};

export function createDshParser(): (jsonLine: string) => OutputEvent[] | null {
  let sessionId: string | undefined;
  let lastAssistantText: string | undefined;
  const warnUnknown = unknownTypeWarner("dsh");

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
    const extra: Record<string, unknown> = {};
    if (data.truncated === true) extra.truncated = true;

    switch (type) {
      // The opening line: the id `--session-id` resumes with, and the cwd.
      case "session": {
        const id = stringField(data, "sessionId");
        if (id) sessionId = id;
        updates.push(harnessEvent(type, data));
        break;
      }

      case "status": {
        const update = handleStatus(data, extra, warnUnknown);
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

      // The last text block again on a completed turn; after SIGINT it is the
      // only copy of the partial answer (E3), and `""` after a failed turn.
      case "final": {
        const text = stringField(data, "text");
        if (text && text !== lastAssistantText) {
          lastAssistantText = text;
          updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
        }
        break;
      }

      // A driver failure outside a turn; the stream ends here without `final`.
      case "error": {
        updates.push({
          sessionUpdate: "error",
          message: harnessErrorText([data.message], data),
          fatal: true,
        });
        break;
      }

      default:
        warnUnknown("event type", type);
        updates.push(harnessEvent(type, data));
        break;
    }

    if (updates.length === 0) return null;
    return updates.map((update) => ({
      sessionId,
      update,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    }));
  };
}

/**
 * step_end.usage is dsh's TokenUsage with DISJOINT counts (llm/src/types.ts:
 * inputTokens is the uncached share; T2: 210 + 74 + 5376 = totalTokens 5660),
 * so Harbor's arithmetic is prompt = input + cache read + cache write.
 */
function handleStatus(
  data: Record<string, unknown>,
  extra: Record<string, unknown>,
  warnUnknown: (what: string, type: string) => void,
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

    // Every kind but `completed` (aborted, blocked, error, max-tokens,
    // interrupted, forked) ended the turn without an answer and exits non-zero.
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
      warnUnknown("status phase", phase);
      return harnessEvent("status", data);
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

/** `input` is the parsed arguments (`{}` when empty; the raw string when the model's JSON did not parse). */
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

/** `result` is the tool's text blocks concatenated (the projection drops images and structured content). */
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
        // dsh's `offset` is 1-based (its read schema); ACP lines are 0-based.
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

/** todo_write's schema (live request/header): `todos[{content, status}]`, no priority. */
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
