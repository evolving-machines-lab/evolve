/**
 * Z Code parser.
 *
 * Consumes `zcode -p … --output-format stream-json` (ZCode v3.14.3, CLI
 * 0.16.9): one NDJSON line per internal session event in the "ZCode
 * Protocol" envelope — {type, eventId, sessionId, turnId?, seq, timestamp
 * (epoch ms), traceId, payload} — plus the CLI-private closing line
 * {type:"result", sessionId, traceId, turnId, response, usage, eventCount,
 * projection}.
 *
 * PROVENANCE. The envelope, the type names and every per-type payload schema
 * are zod definitions in the vendor's source (packages/shared/src/
 * zcode-protocol/index.ts at v3.14.3; the mapper apps/zcode-cli/packages/
 * bootstrap/src/zcode-protocol/session-mapper.ts; the NDJSON writer
 * apps/zcode-cli/packages/cli/src/headless-workflow.ts; the result line
 * prompt-command.ts). The stream itself is declared CLI-PRIVATE and
 * UNVERSIONED by the vendor (headless-workflow.ts), and its one catch-all
 * type, `session.updated`, drops the internal event name (session-mapper.ts),
 * so WHICH types appear in practice and HOW the catch-all payloads are told
 * apart is LIVE CAPTURE (2026-09-25, fourteen headless runs against the Evolve
 * gateway: plain answer, tool use, resume, MCP, skills, sub-agent, model
 * error, tool failure, two cancellations). The rules below hold for every
 * capture; a vendor release may change them without anything failing to
 * compile, so an unknown type is logged once and passed through as a
 * `harness_event`, never a failure (decision 2026-09-25).
 *
 * WHAT THE STREAM SAYS (observed), and what each line becomes:
 *   turn.started            the prompt (`input`); `inputSource:"subagent"` on a child
 *   session.updated         the catch-all — classified by payload shape:
 *     payload.type model_request_started (harness_event; names the model) |
 *       model_request_completed (usage, finishReason) | model_request_failed
 *       (error, non-fatal: errorCode, statusCode, retryable) |
 *       model_retry_scheduled (harness_event)
 *     {providerId, modelId, messageCount}          model_request: harness_event, names the model
 *     {usage, stopReason, content}                  model_complete: text only when none was streamed
 *     {toolCallId, status}                          the tool ledger (silent)
 *     {modelSelection}                              a sub-agent's model: harness_event
 *     {agentId, childSessionId, parentToolCallId, status}  sub-agent lifecycle: harness_event
 *   model.streaming         kind text_delta | reasoning_delta | tool_call;
 *                           start | finish | *_start | *_end | tool_input_delta are silent brackets
 *   tool.updated            kind scheduled | started | progress | result | error; batch is silent
 *   turn.completed          resultType success (silent) | cancelled | error_* (error, fatal; usage)
 *   turn.failed             error{message, code, …}, turnPhase (error, fatal)
 *   result                  the run total (usage) and the final response
 *   session.titleUpdated, session.resumed, checkpoint.created,
 *   streamRecovery.updated  session-level facts with no ACP slot: harness_event
 *
 * SUB-AGENTS write into the SAME stream under their own `sessionId`
 * (`sess_subagent_agent_<id>`); the parent announces the child with
 * {agentId, childSessionId, parentToolCallId, status:"running"} right after
 * its `Agent` tool starts. Every child line from then on is stamped
 * `parentToolCallId` (the delegating call); the child's own title line
 * arrives one line earlier and carries no parent yet. Every child line keeps
 * the RUN's session id on the envelope and names its own under
 * `extra.childSessionId`. The run totals
 * (`turn.completed.usage`, `result.usage`) count the parent's requests only
 * — the child's tokens are in its own per-call `usage` events.
 *
 * THE EXIT CODE IS NOT A VERDICT: the CLI exits 0 whenever the prompt
 * finished, whatever `resultType` says, and a cancelled turn ends with
 * `turn.completed{resultType:"cancelled"}` and no `result` line at all. So a
 * non-success `turn.completed` and every `turn.failed` are the `error`
 * variant (fatal), and the turn's usage rides beside them.
 */

import { harnessErrorText } from "./types";
import type {
  OutputEvent,
  PlanEntryStatus,
  SessionUpdate,
  TokenUsage,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "./types";
import { isoTimestamp } from "./usage";

const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  bash: "execute",
  glob: "search",
  grep: "search",
  ls: "search",
  webfetch: "fetch",
  websearch: "fetch",
  skill: "execute",
  agent: "think",
  task: "think",
  todowrite: "other",
};

/** Observed types with no ACP slot: passed through as harness_event, unwarned. */
const FACT_TYPES = new Set([
  "session.titleUpdated",
  "session.resumed",
  "checkpoint.created",
  "streamRecovery.updated",
]);

/** `model.streaming` kinds that only bracket the deltas they surround. */
const SILENT_STREAMING_KINDS = new Set([
  "start",
  "finish",
  "text_start",
  "text_end",
  "reasoning_start",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
]);

interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  emitted: boolean;
}

export function createZcodeParser(): (jsonLine: string) => OutputEvent[] | null {
  // The run's session (the first line's); a child's own id rides `extra`.
  let rootSessionId: string | undefined;
  // childSessionId -> the parent's delegating tool call (the `Agent` tool).
  const childParents = new Map<string, string>();
  // sessionId -> the model its requests name (the first model_request line).
  const models = new Map<string, string>();
  // sessionId -> the assistant message currently streaming.
  const currentMessage = new Map<string, string>();
  // assistantMessageId -> the text streamed for it, to dedupe the echoes on
  // model_complete.content and result.response.
  const textByMessage = new Map<string, string>();
  const toolCalls = new Map<string, ToolCallRecord>();
  let lastRootMessageId: string | undefined;
  let runUsageEmitted = false;
  const warnedTypes = new Set<string>();

  function warnUnknown(kind: string): void {
    if (warnedTypes.has(kind)) return;
    warnedTypes.add(kind);
    console.warn(`[zcode parser] unknown event type ${kind}`);
  }

  return function parseZcodeEvent(jsonLine: string): OutputEvent[] | null {
    let data: unknown;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }
    if (!isRecord(data)) return null;

    const type = stringField(data, "type");
    if (!type) return null;
    const lineSessionId = stringField(data, "sessionId") || undefined;
    if (rootSessionId === undefined && lineSessionId) rootSessionId = lineSessionId;
    const sessionId = lineSessionId ?? rootSessionId;
    const isChild = sessionId !== undefined && sessionId !== rootSessionId;

    const updates: SessionUpdate[] = [];
    let messageId: string | undefined = sessionId ? currentMessage.get(sessionId) : undefined;
    const extra: Record<string, unknown> = {};

    if (type === "result") {
      // The CLI-private terminal line: the run's total, and the final answer
      // (already streamed as text deltas — repeated here only when it was not).
      const usage = zcodeTokenUsage(data.usage);
      if (usage && !runUsageEmitted) {
        runUsageEmitted = true;
        updates.push({ sessionUpdate: "usage", scope: "run", usage });
      }
      const response = stringField(data, "response");
      const streamed = lastRootMessageId ? textByMessage.get(lastRootMessageId) ?? "" : "";
      if (response && response !== streamed) {
        updates.push(agentText(response));
      }
      messageId = lastRootMessageId;
      return finish(updates, sessionId, undefined, messageId, extra, isChild ? sessionId : undefined);
    }

    const payload = asRecord(data.payload) ?? {};
    const timestamp = isoTimestamp(data.timestamp);

    switch (type) {
      case "turn.started": {
        const input = stringField(payload, "input");
        if (input) {
          updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: input } });
        }
        messageId = undefined;
        break;
      }

      case "session.updated": {
        const payloadType = stringField(payload, "type");
        if (payloadType) {
          switch (payloadType) {
            case "model_request_started": {
              const modelId = stringField(payload, "modelId");
              if (modelId && sessionId) models.set(sessionId, modelId);
              updates.push(harnessEvent(data, type));
              break;
            }
            case "model_request_completed": {
              const usage = zcodeTokenUsage(payload.usage);
              if (usage) updates.push({ sessionUpdate: "usage", scope: "call", usage });
              const finishReason = stringField(payload, "finishReason");
              if (finishReason) extra.finishReason = finishReason;
              break;
            }
            case "model_request_failed": {
              // One request's failure. Whether the TURN is over is said by
              // the turn.failed / turn.completed line that follows, so this
              // is never fatal on its own — retries are announced the same way.
              updates.push({
                sessionUpdate: "error",
                message: harnessErrorText(
                  [payload.message, payload.providerErrorMessage, payload.errorCode],
                  payload,
                ),
                fatal: false,
              });
              copyIfPresent(payload, extra, ["errorCode", "statusCode", "retryable", "attempt", "maxAttempts"]);
              break;
            }
            case "model_retry_scheduled":
              updates.push(harnessEvent(data, type));
              break;
            default:
              warnUnknown(`session.updated/${payloadType}`);
              updates.push(harnessEvent(data, type));
          }
          break;
        }
        if (typeof payload.modelId === "string" && typeof payload.providerId === "string" && "messageCount" in payload) {
          // model_request: the model this session's requests name.
          if (sessionId) models.set(sessionId, payload.modelId);
          updates.push(harnessEvent(data, type));
          break;
        }
        if (isRecord(payload.usage) && "stopReason" in payload) {
          // model_complete: the request's final text, already streamed as
          // deltas — repeated only when nothing was streamed for the message.
          const content = stringField(payload, "content");
          const streamed = messageId ? textByMessage.get(messageId) ?? "" : "";
          if (content && content !== streamed) {
            updates.push(agentText(content));
            if (messageId) textByMessage.set(messageId, content);
          }
          const stopReason = stringField(payload, "stopReason");
          if (stopReason) extra.stopReason = stopReason;
          break;
        }
        if (typeof payload.toolCallId === "string" && typeof payload.status === "string" && !("childSessionId" in payload)) {
          // The streaming tool ledger; the tool.updated lines carry the facts.
          break;
        }
        if (isRecord(payload.modelSelection)) {
          const modelId = stringField(payload.modelSelection, "modelId");
          if (modelId && sessionId) models.set(sessionId, modelId);
          updates.push(harnessEvent(data, type));
          break;
        }
        if (typeof payload.childSessionId === "string" && typeof payload.parentToolCallId === "string") {
          // Sub-agent lifecycle: running (the mapping every child line is
          // stamped from) and completed (the parent's tool result follows).
          childParents.set(payload.childSessionId, payload.parentToolCallId);
          updates.push(harnessEvent(data, type));
          break;
        }
        if (isRecord(payload.error) && "retryable" in payload) {
          // model_error (documented, not observed live): the request layer's error.
          updates.push({
            sessionUpdate: "error",
            message: harnessErrorText([asRecord(payload.error)?.message], payload),
            fatal: false,
          });
          break;
        }
        warnUnknown(`session.updated/{${Object.keys(payload).sort().join(",")}}`);
        updates.push(harnessEvent(data, type));
        break;
      }

      case "model.streaming": {
        const kind = stringField(payload, "kind");
        const assistantMessageId = stringField(payload, "assistantMessageId");
        if (assistantMessageId && sessionId) {
          currentMessage.set(sessionId, assistantMessageId);
          if (!isChild) lastRootMessageId = assistantMessageId;
          messageId = assistantMessageId;
        }
        switch (kind) {
          case "text_delta": {
            const delta = stringField(payload, "delta");
            if (delta) {
              updates.push(agentText(delta));
              if (messageId) textByMessage.set(messageId, (textByMessage.get(messageId) ?? "") + delta);
            }
            break;
          }
          case "reasoning_delta": {
            const delta = stringField(payload, "delta");
            if (delta) {
              updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta } });
            }
            break;
          }
          case "tool_call": {
            const update = recordToolCall(
              toolCalls,
              stringField(payload, "toolCallId"),
              stringField(payload, "toolName"),
              asRecord(payload.input) ?? {},
            );
            if (update) updates.push(update);
            break;
          }
          case "error": {
            // Documented kind, never observed: a streaming-layer error.
            updates.push({
              sessionUpdate: "error",
              message: harnessErrorText([payload.message, payload.delta], payload),
              fatal: false,
            });
            break;
          }
          default:
            if (!SILENT_STREAMING_KINDS.has(kind)) {
              warnUnknown(`model.streaming/${kind || "?"}`);
              updates.push(harnessEvent(data, type));
            }
        }
        break;
      }

      case "tool.updated": {
        const kind = stringField(payload, "kind");
        const toolCallId = stringField(payload, "toolCallId");
        const assistantMessageId = stringField(payload, "assistantMessageId");
        if (assistantMessageId) messageId = assistantMessageId;
        switch (kind) {
          case "scheduled": {
            const update = recordToolCall(
              toolCalls,
              toolCallId,
              stringField(payload, "toolName"),
              asRecord(payload.input) ?? {},
            );
            if (update) updates.push(update);
            break;
          }
          case "started": {
            if (!toolCallId) break;
            updates.push({
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "in_progress",
              title: toolCalls.get(toolCallId)?.name || stringField(payload, "toolName") || undefined,
            });
            break;
          }
          case "progress": {
            if (!toolCallId) break;
            const text = stringField(payload, "outputPreview") || stringField(payload, "stdoutTail") || stringField(payload, "stderrTail");
            updates.push({
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "in_progress",
              content: text ? contentList(text) : undefined,
            });
            break;
          }
          case "result": {
            if (!toolCallId) break;
            const result = asRecord(payload.result) ?? {};
            // A non-zero exit code is a normal result to Z Code
            // (result.success stays true; the exit code rides result.perf);
            // only its own `success:false` is a failed tool.
            updates.push({
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: result.success === false ? "failed" : "completed",
              title: toolCalls.get(toolCallId)?.name || undefined,
              content: contentList(result.content),
              rawOutput: payload.result,
            });
            toolCalls.delete(toolCallId);
            break;
          }
          case "error": {
            if (!toolCallId) break;
            const error = asRecord(payload.error);
            updates.push({
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "failed",
              title: toolCalls.get(toolCallId)?.name || undefined,
              content: contentList(harnessErrorText([error?.message, error?.code], payload.error ?? payload)),
              rawOutput: payload.error,
            });
            toolCalls.delete(toolCallId);
            break;
          }
          case "batch":
            break;
          default:
            warnUnknown(`tool.updated/${kind || "?"}`);
            updates.push(harnessEvent(data, type));
        }
        break;
      }

      case "turn.completed": {
        const resultType = stringField(payload, "resultType");
        if (resultType && resultType !== "success") {
          // cancelled (a signal: exit 130, no result line follows) or
          // error_max_turns / error_max_budget / error_during_execution /
          // error_max_tool_calls: the turn is over and did not succeed.
          updates.push({
            sessionUpdate: "error",
            message: harnessErrorText([resultType], payload),
            fatal: true,
          });
          extra.resultType = resultType;
          if (!isChild) {
            const usage = zcodeTokenUsage(payload.usage);
            if (usage && !runUsageEmitted) {
              runUsageEmitted = true;
              updates.push({ sessionUpdate: "usage", scope: "run", usage });
            }
          }
        }
        break;
      }

      case "turn.failed": {
        const error = asRecord(payload.error) ?? {};
        updates.push({
          sessionUpdate: "error",
          message: harnessErrorText([error.message, error.detail, error.code], payload),
          fatal: true,
        });
        copyIfPresent(error, extra, ["code", "type"]);
        copyIfPresent(payload, extra, ["turnPhase"]);
        break;
      }

      default:
        if (!FACT_TYPES.has(type)) warnUnknown(type);
        updates.push(harnessEvent(data, type));
    }

    const parentToolCallId = isChild && sessionId ? childParents.get(sessionId) : undefined;
    return finish(updates, sessionId, timestamp, messageId, extra, isChild ? sessionId : undefined, parentToolCallId);
  };

  function finish(
    updates: SessionUpdate[],
    sessionId: string | undefined,
    timestamp: string | undefined,
    messageId: string | undefined,
    extra: Record<string, unknown>,
    childSessionId: string | undefined,
    parentToolCallId?: string,
  ): OutputEvent[] | null {
    if (updates.length === 0) return null;
    const model = sessionId !== undefined ? models.get(sessionId) : undefined;
    if (childSessionId) extra.childSessionId = childSessionId;
    return updates.map((update) => ({
      sessionId: rootSessionId ?? sessionId,
      update,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      ...(Object.keys(extra).length > 0 ? { extra: { ...extra } } : {}),
    }));
  }
}

/**
 * Z Code's usage object (contracts/src/model ModelUsageSummary): inputTokens
 * ALREADY includes the cached share (an OpenAI-shaped prompt count: T4's
 * 19 683 input with 19 200 cache-read), so promptTokens is inputTokens as
 * printed, cachedTokens is cacheReadTokens, completion is outputTokens; the
 * remaining counters (reasoningTokens, cacheWriteTokens, totalTokens,
 * modelRequestCount, …) ride `extra` under their wire names. No cost field
 * exists anywhere in the stream.
 */
function zcodeTokenUsage(usage: unknown): TokenUsage | null {
  if (!isRecord(usage)) return null;
  const input = finiteNumber(usage.inputTokens);
  const output = finiteNumber(usage.outputTokens);
  const cacheRead = finiteNumber(usage.cacheReadTokens);
  const result: TokenUsage = {};
  if (input !== undefined) result.promptTokens = input;
  if (output !== undefined) result.completionTokens = output;
  if (cacheRead !== undefined) result.cachedTokens = cacheRead;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (key === "inputTokens" || key === "outputTokens" || key === "cacheReadTokens") continue;
    if (value === null || value === undefined) continue;
    extra[key] = value;
  }
  if (Object.keys(extra).length > 0) result.extra = extra;
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * The first line that names a tool call emits it — `model.streaming
 * tool_call` (the model produced it) or `tool.updated scheduled` (the runtime
 * queued it), whichever arrives first; every capture shows both, in that
 * order, and a cancellation right after the model's line still leaves the
 * call in the trace.
 */
function recordToolCall(
  toolCalls: Map<string, ToolCallRecord>,
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
): SessionUpdate | null {
  if (!toolCallId) return null;
  const existing = toolCalls.get(toolCallId);
  if (existing?.emitted) return null;
  const toolName = name || existing?.name || "Tool";
  toolCalls.set(toolCallId, { name: toolName, input, emitted: true });

  if (normalizeToolName(toolName) === "todowrite") {
    const plan = handleTodoWrite(input);
    if (plan) return plan;
  }

  const { title, kind, content, locations } = toolInfo(toolName, input);
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    toolName,
    kind,
    status: "pending",
    rawInput: input,
    content,
    locations,
  };
}

function handleTodoWrite(input: Record<string, unknown>): SessionUpdate | null {
  const todos = input.todos;
  if (!Array.isArray(todos)) return null;
  const entries = todos.flatMap((todo): Array<{ content: string; status: PlanEntryStatus; priority: "high" | "medium" | "low" }> => {
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
  const path = stringField(input, "file_path") || stringField(input, "path") || stringField(input, "notebook_path");
  const command = stringField(input, "command");
  const url = stringField(input, "url");
  const skill = stringField(input, "skill");
  const subagent = stringField(input, "subagent_type");
  const titleDetail = path || command || url || skill || subagent;
  return {
    title: titleDetail ? `${toolName} ${titleDetail}` : toolName,
    kind,
    content: Object.keys(input).length > 0 ? contentList(input) : [],
    locations: path ? [{ path }] : [],
  };
}

function agentText(text: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

/** The line under its own type word, every other field verbatim (types.ts HarnessEvent). */
function harnessEvent(line: Record<string, unknown>, type: string): SessionUpdate {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(line)) {
    if (key !== "type") payload[key] = value;
  }
  return { sessionUpdate: "harness_event", type, payload };
}

function copyIfPresent(from: Record<string, unknown>, into: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    const value = from[key];
    if (value !== undefined && value !== null) into[key] = value;
  }
}

function contentList(value: unknown): ToolCallContent[] {
  const text = stringify(value);
  return text ? [{ type: "content", content: { type: "text", text } }] : [];
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
