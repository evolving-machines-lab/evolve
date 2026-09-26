/**
 * The pi-family parser core: pi (`pi --mode json`) and Prime Agent
 * (`prime-agent --mode json`), one wire vocabulary.
 *
 * Prime Agent is a hard fork of pi at pi 0.74.0 (2026-05-07); the core loop
 * events, the streaming deltas, the message and usage shapes and the JSONL
 * session format are byte-compatible between pi 0.87.1 and Prime v0.9.6
 * (both vendors' TypeScript types read at those tags; both live-captured
 * against the Evolve gateway 2026-09-25). What differs is DATA the two thin
 * profiles carry (parsers/pi.ts, parsers/prime-agent.ts): the tool set
 * (pi: read/bash/edit/write and the `mcp` adapter proxy; Prime: one
 * `ipython` tool), how a tool failure is spelled, and which session-level
 * event types each prints.
 *
 * The stream (one JSON object per line, JSON mode; pi
 * packages/coding-agent/src/modes/json-event.ts strips `message`/`partial`
 * from message_update, Prime keeps them):
 *
 *   session                 header: id, cwd (first line; also on resume)
 *   agent_start / agent_end one low-level run (pi: agent_end.willRetry)
 *   turn_start / turn_end   one assistant response plus its tool results
 *   message_start / _end    system, user, assistant, toolResult and (Prime)
 *                           custom messages; assistant message_end is the
 *                           authoritative message: content[], usage,
 *                           stopReason, errorMessage, responseId, timestamp
 *   message_update          assistantMessageEvent deltas (text_*, thinking_*,
 *                           toolcall_*)
 *   tool_execution_start    toolCallId, toolName, args
 *   tool_execution_update   partialResult {content[], details?}
 *   tool_execution_end      result {content[], details?}, isError
 *   auto_retry_start / _end pi and Prime retry a failed model call themselves
 *   agent_settled           pi only: the terminal record
 *   entry_appended          pi only: session-file entries (context_edit)
 *   rlm_child_update, session_action_update, auth_stale, … Prime only
 *
 * THE EXIT CODE IS NOT A VERDICT for either CLI: JSON mode exits 0 when every
 * model call failed (pi print-mode.ts:139-161; Prime print-mode.ts; both
 * live-verified). Failure is therefore read from the stream — an assistant
 * message_end with stopReason `error`/`aborted` is the `error` variant, and
 * the retry loop giving up (pi: agent_end with willRetry false after an
 * error; Prime: auto_retry_end with success false) is the fatal one.
 *
 * EVERY OTHER LINE IS KEPT. Session-level types with no ACP slot — a retry
 * schedule, a Prime sub-agent's progress, a compaction — ride the
 * `harness_event` variant with the line verbatim, and so does any type this
 * file has never seen (warned once per type per parser instance): both
 * vendors release weekly and grow the union (the owner's ruling
 * 2026-09-25). Only the loop's punctuation (agent_start, turn_start,
 * turn_end, agent_end, agent_settled) is silent, as in every other parser.
 */

import { harnessErrorText } from "./types";
import type {
  OutputEvent,
  SessionUpdate,
  TokenUsage,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "./types";
import { isoTimestamp } from "./usage";

/** How a tool call renders: the human title, the files it touches, the diff or command it carries. */
export interface PiToolDescription {
  title: string;
  kind: ToolKind;
  locations: ToolCallLocation[];
  content: ToolCallContent[];
}

/** The per-harness DATA the shared core reads. */
export interface PiFamilyProfile {
  /** The harness id, for the one warning this parser prints. */
  harness: "pi" | "prime-agent";
  /** Title, kind, locations and content for one tool call. */
  describeTool(toolName: string, args: Record<string, unknown>): PiToolDescription;
  /**
   * Did the tool FAIL? The wire's `isError` is not the whole truth for
   * either harness (Prime: a Python exception leaves isError false and puts
   * `details.status: "error"`; pi's MCP adapter answers a missing tool with
   * isError false and `details.error`), so each profile reads its own record.
   */
  toolFailed(toolName: string, details: Record<string, unknown> | null, isError: boolean): boolean;
  /**
   * Session-level event types this harness is KNOWN to print beyond the core
   * loop. They pass through as harness_event without a warning; a type in
   * neither this set nor the core is unknown and warned once.
   */
  knownEvents: ReadonlySet<string>;
}

/** The core loop's punctuation: nothing to carry, every message already rides its own line. */
const SILENT_TYPES = new Set(["agent_start", "turn_start", "turn_end", "agent_settled"]);

/** The core loop's record-bearing types, handled explicitly below. */
const CORE_TYPES = new Set([
  "session",
  "agent_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_retry_start",
  "auto_retry_end",
]);

export function createPiFamilyParser(profile: PiFamilyProfile): (jsonLine: string) => OutputEvent[] | null {
  let sessionId: string | undefined;
  // The assistant message in flight: its model for the deltas (pi strips the
  // message from message_update), and whether text/thinking already streamed
  // as deltas — message_end then carries only what the deltas did not.
  let currentModel: string | undefined;
  let sawTextDelta = false;
  let sawThinkingDelta = false;
  // The last assistant failure, so the retry loop giving up can name it.
  let lastError: string | undefined;
  let fatalEmitted = false;
  // Tool calls announced by an assistant message_end (id -> tool name); a
  // tool_execution_start for an id never announced emits the call itself.
  const toolNames = new Map<string, string>();
  const announced = new Set<string>();
  const progressed = new Set<string>();
  const warned = new Set<string>();

  return function parsePiFamilyEvent(jsonLine: string): OutputEvent[] | null {
    let data: unknown;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }
    if (!isRecord(data)) return null;
    const type = stringField(data, "type");
    if (!type) return null;

    if (SILENT_TYPES.has(type)) return null;

    switch (type) {
      case "session": {
        const id = stringField(data, "id");
        if (id) sessionId = id;
        return null;
      }

      case "agent_end": {
        // pi: willRetry false after a failed call = the loop gave up (retry
        // disabled, or the last attempt). Prime prints no willRetry; its
        // terminal signal is auto_retry_end below.
        if (data.willRetry === false && lastError !== undefined && !fatalEmitted) {
          fatalEmitted = true;
          return [envelope({ sessionUpdate: "error", message: lastError, fatal: true })];
        }
        return null;
      }

      case "message_start":
        return handleMessageStart(asRecord(data.message));

      case "message_update":
        return handleMessageUpdate(data);

      case "message_end":
        return handleMessageEnd(asRecord(data.message));

      case "tool_execution_start":
        return handleToolStart(data);

      case "tool_execution_update":
        return handleToolUpdate(data);

      case "tool_execution_end":
        return handleToolEnd(data);

      case "auto_retry_start":
        return [envelope(harnessEvent(type, data))];

      case "auto_retry_end": {
        if (data.success === false) {
          if (fatalEmitted) return null;
          fatalEmitted = true;
          return [
            envelope({
              sessionUpdate: "error",
              message: harnessErrorText([data.finalError, lastError], data),
              fatal: true,
            }),
          ];
        }
        return [envelope(harnessEvent(type, data))];
      }

      default: {
        if (!profile.knownEvents.has(type) && !CORE_TYPES.has(type) && !warned.has(type)) {
          warned.add(type);
          console.warn(`[${profile.harness} parser] unknown event type "${type}" passed through as harness_event`);
        }
        return [envelope(harnessEvent(type, data))];
      }
    }
  };

  function handleMessageStart(message: Record<string, unknown> | null): OutputEvent[] | null {
    if (!message) return null;
    const role = stringField(message, "role");
    if (role === "assistant") {
      currentModel = stringField(message, "model") || undefined;
      sawTextDelta = false;
      sawThinkingDelta = false;
      lastError = undefined;
      fatalEmitted = false;
      return null;
    }
    if (role === "user") {
      const text = contentText(message.content);
      if (!text) return null;
      return [envelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text } }, messageFacts(message))];
    }
    if (role === "custom") {
      // Prime: a sub-agent's reply delivered to the parent (custom
      // agent_message, in the model's context — a message TO the agent, so a
      // user turn); the harness_digest (its injected memory preamble,
      // display false) and every other custom kind are not conversation.
      if (stringField(message, "customType") !== "agent_message") return null;
      const text = contentText(message.content);
      if (!text) return null;
      const details = asRecord(message.details);
      const extra: Record<string, unknown> = { customType: "agent_message" };
      if (details?.from !== undefined) extra.from = details.from;
      return [
        envelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text } }, {
          ...messageFacts(message),
          extra,
        }),
      ];
    }
    // system and toolResult carry nothing beyond what other lines already
    // said; a role this core has never seen rides through verbatim.
    if (role === "system" || role === "toolResult") return null;
    return [envelope(harnessEvent("message_start", { message }))];
  }

  function handleMessageUpdate(data: Record<string, unknown>): OutputEvent[] | null {
    const event = asRecord(data.assistantMessageEvent);
    if (!event) return null;
    const delta = stringField(event, "delta");
    if (!delta) return null;
    // Prime keeps the message on message_update; pi strips it. Its clock and
    // model ride the envelope when present, else the message_start's model.
    const message = asRecord(data.message);
    const facts = message ? messageFacts(message) : {};
    if (facts.model === undefined && currentModel) facts.model = currentModel;
    const kind = stringField(event, "type");
    if (kind === "text_delta") {
      sawTextDelta = true;
      return [envelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } }, facts)];
    }
    if (kind === "thinking_delta") {
      sawThinkingDelta = true;
      return [envelope({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta } }, facts)];
    }
    return null;
  }

  function handleMessageEnd(message: Record<string, unknown> | null): OutputEvent[] | null {
    if (!message || stringField(message, "role") !== "assistant") return null;
    const facts = messageFacts(message);
    const events: OutputEvent[] = [];
    const content = Array.isArray(message.content) ? message.content : [];

    for (const block of content) {
      const item = asRecord(block);
      if (!item) continue;
      const kind = stringField(item, "type");
      if (kind === "thinking" && !sawThinkingDelta) {
        const thinking = stringField(item, "thinking");
        if (thinking) events.push(envelope({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thinking } }, facts));
      } else if (kind === "text" && !sawTextDelta) {
        const text = stringField(item, "text");
        if (text) events.push(envelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, facts));
      } else if (kind === "toolCall") {
        const id = stringField(item, "id");
        const name = stringField(item, "name");
        if (!id || !name) continue;
        events.push(envelope(toolCall(id, name, asRecord(item.arguments) ?? {}), facts));
      }
    }

    const stopReason = stringField(message, "stopReason");
    if (stopReason === "error" || stopReason === "aborted") {
      lastError = harnessErrorText([message.errorMessage, stopReason], message);
      events.push(envelope({ sessionUpdate: "error", message: lastError, fatal: false }, facts));
    }

    // The call's accounting (Harbor pi.py _metrics_from_usage). A failed or
    // aborted call that printed all zeros made no inference: nothing to account for.
    const usage = piUsage(message.usage);
    const noInference = usage !== null && (stopReason === "error" || stopReason === "aborted") && usageIsZero(usage);
    if (usage && !noInference) {
      events.push(envelope({ sessionUpdate: "usage", scope: "call", usage }, facts));
    }

    return events.length > 0 ? events : null;
  }

  function handleToolStart(data: Record<string, unknown>): OutputEvent[] | null {
    const id = stringField(data, "toolCallId");
    const name = stringField(data, "toolName");
    if (!id || !name) return null;
    // The assistant message_end announced this call already (the normal
    // order); a start for a call never announced is the call itself.
    if (announced.has(id)) return null;
    return [envelope(toolCall(id, name, asRecord(data.args) ?? {}))];
  }

  function handleToolUpdate(data: Record<string, unknown>): OutputEvent[] | null {
    const id = stringField(data, "toolCallId");
    if (!id) return null;
    // One in_progress per call: it records that execution began (the fact a
    // killed run leaves behind — E3 captures end on these lines with no
    // tool_execution_end). The partial text is NOT carried: the final
    // result repeats it whole, and a trajectory concatenates every update's
    // content into one observation.
    if (progressed.has(id)) return null;
    progressed.add(id);
    return [envelope({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" })];
  }

  function handleToolEnd(data: Record<string, unknown>): OutputEvent[] | null {
    const id = stringField(data, "toolCallId");
    if (!id) return null;
    const name = stringField(data, "toolName") || toolNames.get(id) || "";
    const result = asRecord(data.result);
    const details = result ? asRecord(result.details) : null;
    const isError = data.isError === true;
    const failed = isError || profile.toolFailed(name, details, isError);
    const text = result ? contentText(result.content) : "";
    toolNames.delete(id);
    announced.delete(id);
    progressed.delete(id);
    return [
      envelope({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: failed ? "failed" : "completed",
        content: text ? [{ type: "content", content: { type: "text", text } }] : [],
        // The harness's whole result record — content and details (pi's mcp
        // mode/server/tool, Prime's stdout/stderr/status/error) — verbatim.
        ...(result !== null ? { rawOutput: result } : {}),
      }),
    ];
  }

  function toolCall(id: string, name: string, args: Record<string, unknown>): SessionUpdate {
    toolNames.set(id, name);
    announced.add(id);
    const described = profile.describeTool(name, args);
    return {
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: described.title,
      toolName: name,
      kind: described.kind,
      status: "pending",
      rawInput: args,
      content: described.content,
      locations: described.locations,
    };
  }

  function envelope(update: SessionUpdate, facts: MessageFacts = {}): OutputEvent {
    return {
      sessionId,
      update,
      ...(facts.timestamp !== undefined ? { timestamp: facts.timestamp } : {}),
      ...(facts.model !== undefined ? { model: facts.model } : {}),
      ...(facts.messageId !== undefined ? { messageId: facts.messageId } : {}),
      ...(facts.extra !== undefined ? { extra: facts.extra } : {}),
    };
  }
}

type MessageFacts = { timestamp?: string; model?: string; messageId?: string; extra?: Record<string, unknown> };

/**
 * The per-line facts of a message: its clock (Unix ms), model, and the
 * provider's response id as the message id (pi/Prime messages have no id of
 * their own; `responseId` is the one identifier the wire carries per
 * inference). `extra` keeps the keys with no ACP slot, only when present.
 */
function messageFacts(message: Record<string, unknown>): MessageFacts {
  const facts: MessageFacts = {};
  const timestamp = isoTimestamp(message.timestamp);
  if (timestamp !== undefined) facts.timestamp = timestamp;
  const model = stringField(message, "model");
  if (model) facts.model = model;
  const responseId = stringField(message, "responseId");
  if (responseId) facts.messageId = responseId;
  const extra: Record<string, unknown> = {};
  // pi spells the raw stop reason `rawStopReason`, Prime `stopReasonRaw`.
  for (const key of ["stopReason", "rawStopReason", "stopReasonRaw", "responseModel", "provider", "api"]) {
    const value = message[key];
    if (typeof value === "string" && value.length > 0) extra[key] = value;
  }
  if (Object.keys(extra).length > 0) facts.extra = extra;
  return facts;
}

/**
 * pi-ai `Usage` — {input, output, cacheRead, cacheWrite, reasoning?,
 * totalTokens, cost{total,…}} — as Harbor's pi.py _metrics_from_usage reads
 * it: prompt is input PLUS the cache-read and cache-write shares, completion
 * is output, cached is the cache-read share; cost only when positive (a
 * models.json model declared without rates prints 0, which is "unknown");
 * the other counters ride extra under their wire names. Null when the
 * message carried no usage object.
 */
export function piUsage(usage: unknown): TokenUsage | null {
  const record = asRecord(usage);
  if (!record) return null;
  const input = finiteNumber(record.input);
  const output = finiteNumber(record.output);
  const cacheRead = finiteNumber(record.cacheRead);
  const cacheWrite = finiteNumber(record.cacheWrite);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return null;

  const result: TokenUsage = {};
  if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
    result.promptTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  if (output !== undefined) result.completionTokens = output;
  if (cacheRead !== undefined) result.cachedTokens = cacheRead;
  const costTotal = finiteNumber(asRecord(record.cost)?.total);
  if (costTotal !== undefined && costTotal > 0) result.costUsd = costTotal;

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "input" || key === "output" || key === "cost") continue;
    if (value === null || value === undefined) continue;
    extra[key] = value;
  }
  if (Object.keys(extra).length > 0) result.extra = extra;
  return result;
}

function usageIsZero(usage: TokenUsage): boolean {
  return !usage.promptTokens && !usage.completionTokens && !usage.cachedTokens && !usage.costUsd;
}

function harnessEvent(type: string, data: Record<string, unknown>): SessionUpdate {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "type") continue;
    payload[key] = value;
  }
  return { sessionUpdate: "harness_event", type, payload };
}

/** The text of a message or result `content`: a string, or the text blocks of an array joined. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = asRecord(block);
      return item && item.type === "text" ? stringField(item, "text") : "";
    })
    .filter(Boolean)
    .join("");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
