/**
 * Antigravity CLI (`antigravity`, Google's `agy`) `--output-format stream-json` → ACP-style events. The CLI is closed
 * source: every shape here is from the live capture of agy 1.2.11 (the fixtures of tests/unit/antigravity-parser.test.ts),
 * then the vendor's headless docs page; the capture wins. Not on the wire: timestamps, text on user_input /
 * system_message / error_message steps, tool call ids (a step's updates pair by step_index), a failing command's exit
 * code. Usage rides per call on a DONE agent_response and whole on result; promptTokens = input + cache_read (Harbor).
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

/** agy's 57 tool names (the 1.2.11 init line) → ACP kinds; browser tools stay "other" (no ACP kind; "fetch" would claim a network read). */
const TOOL_KINDS: Record<string, ToolKind> = {
  run_command: "execute",
  command_status: "execute",
  send_command_input: "execute",
  notebook_execution: "execute",
  view_file: "read",
  read_resource: "read",
  list_dir: "search",
  find_by_name: "search",
  grep_search: "search",
  list_resources: "search",
  write_to_file: "edit",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  sed_file: "edit",
  notebook_edit: "edit",
  read_url_content: "fetch",
  search_web: "fetch",
  open_browser_url: "fetch",
  invoke_subagent: "think",
  define_subagent: "think",
  manage_subagents: "think",
  browser_subagent: "think",
};

/** Parameter names that carry a path (live: TargetFile, AbsolutePath) or the one detail a title shows. */
const PATH_PARAMS = ["TargetFile", "AbsolutePath", "DirectoryPath", "SearchPath"];
const DETAIL_PARAMS = ["CommandLine", ...PATH_PARAMS, "Query", "Pattern", "Url", "Action"];

/** Step types with no ACP slot that the capture or the docs name — passed through without a warning. */
const NO_SLOT_STEPS = new Set(["system_message", "checkpoint"]);

export function createAntigravityParser(): (jsonLine: string) => OutputEvent[] | null {
  let model: string | undefined;
  let conversationId: string | undefined;
  // Tool and subagent steps whose first update opened a tool_call, so a DONE
  // update becomes a tool_call_update rather than a second call.
  const openedSteps = new Set<string>();
  // Every agent_response text delta so far, so the result's `response` (the
  // same text, whole) is not published a second time.
  let streamedText = "";
  const warned = new Set<string>();

  return function parseAntigravityEvent(jsonLine: string): OutputEvent[] | null {
    let data: unknown;
    try {
      data = JSON.parse(jsonLine);
    } catch {
      return null;
    }
    if (!isRecord(data)) return null;

    const eventName = stringField(data, "event");

    // `--output-format json`: the result object bare (live T5).
    if (!eventName && typeof data.status === "string" && "conversation_id" in data) {
      return stamp(handleResult(data), data);
    }
    if (!eventName) return null;

    switch (eventName) {
      case "init": {
        const init = asRecord(data.init);
        const named = init ? stringField(init, "model") : "";
        if (named) model = named;
        return stamp([harnessEvent(eventName, data, "event")], data);
      }
      case "step_update": {
        const step = asRecord(data.step_update);
        if (!step) return stamp([harnessEvent(eventName, data, "event")], data);
        return stamp(handleStep(step), step);
      }
      case "result": {
        const result = asRecord(data.result);
        if (!result) return stamp([harnessEvent(eventName, data, "event")], data);
        return stamp(handleResult(result), result);
      }
      default:
        warnOnce("event", eventName);
        return stamp([harnessEvent(eventName, data, "event")], data);
    }
  };

  /** Envelope: the conversation as session id, the init model, the line's own facts as extra. */
  function stamp(updates: SessionUpdate[], line: Record<string, unknown>): OutputEvent[] | null {
    if (updates.length === 0) return null;
    const id = stringField(line, "conversation_id");
    if (id) conversationId = id;
    const extra = lineExtra(line);
    const messageId = stepMessageId(line);
    return updates.map((update) => ({
      ...(conversationId !== undefined ? { sessionId: conversationId } : {}),
      update,
      ...(model !== undefined ? { model } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
      ...(extra !== undefined ? { extra } : {}),
    }));
  }

  function handleStep(step: Record<string, unknown>): SessionUpdate[] {
    const stepType = stringField(step, "step_type");
    const state = stringField(step, "state");
    const updates: SessionUpdate[] = [];

    switch (stepType) {
      case "agent_response": {
        const thought = stringField(step, "thinking_delta");
        if (thought) updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thought } });
        const text = stringField(step, "text_delta");
        if (text) {
          streamedText += text;
          updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
        }
        const usage = antigravityTokenUsage(step.usage);
        if (usage) updates.push({ sessionUpdate: "usage", scope: "call", usage });
        return updates;
      }

      case "tool":
      case "subagent": {
        const key = stepKey(step);
        const toolName =
          stringField(step, "tool_name") ||
          stringField(asRecord(step.tool_info) ?? {}, "name") ||
          (stepType === "subagent" ? "invoke_subagent" : "tool");
        const rawInput = stepType === "subagent" ? step.subagent_info : asRecord(step.tool_info)?.parameters;
        if (!openedSteps.has(key)) {
          openedSteps.add(key);
          updates.push(toolCall(key, toolName, rawInput));
        }
        if (state === "DONE") {
          updates.push(toolResult(key, stepType, step));
        } else if (updates.length === 0) {
          // A second ACTIVE update on an open step: progress, no new facts.
          updates.push({ sessionUpdate: "tool_call_update", toolCallId: key, status: "in_progress" });
        }
        return updates;
      }

      // A model API failure the run may recover from (live E1b, U1): never fatal here; the step carries no text, so
      // harnessErrorText dumps the step.
      case "error_message":
        return [
          {
            sessionUpdate: "error",
            message: harnessErrorText(
              [stringField(asRecord(step.error) ?? {}, "message"), stringField(step, "text_delta")],
              step,
            ),
            fatal: false,
          },
        ];

      // The turn's own echo of the prompt: loop punctuation, silent like every parser's turn start.
      case "user_input":
        return [];

      default: {
        if (!NO_SLOT_STEPS.has(stepType)) warnOnce("step", stepType);
        const passthrough: SessionUpdate[] = [harnessEvent(stepType || "step_update", step, "step_type")];
        const usage = antigravityTokenUsage(step.usage);
        if (usage) passthrough.push({ sessionUpdate: "usage", scope: "call", usage });
        return passthrough;
      }
    }
  }

  function handleResult(result: Record<string, unknown>): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    // The final text, whole — published only when the stream did not already
    // carry it as deltas (the json envelope, or a response that never streamed).
    const response = stringField(result, "response");
    if (response && !streamedText.includes(response)) {
      streamedText += response;
      updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: response } });
    }
    // The conversation's total, whatever the status: accounting is never work (types.ts).
    const usage = antigravityTokenUsage(result.usage);
    if (usage) updates.push({ sessionUpdate: "usage", scope: "run", usage });
    const status = stringField(result, "status");
    if (status !== "SUCCESS") {
      // The one place a fatal failure's text appears (live E1a/E1b/E3); the documented other statuses were never observed,
      // so any non-SUCCESS means only "ended short of an answer".
      updates.push({
        sessionUpdate: "error",
        message: harnessErrorText(
          [
            stringField(result, "error"),
            `antigravity ended the run with result status "${status}" and no error text`,
          ],
          result,
        ),
        fatal: true,
      });
    }
    return updates;
  }

  function toolCall(key: string, toolName: string, rawInput: unknown): SessionUpdate {
    const params = asRecord(rawInput) ?? {};
    const detail = firstString(params, DETAIL_PARAMS);
    const path = firstString(params, PATH_PARAMS);
    const locations: ToolCallLocation[] = path ? [{ path }] : [];
    let title = detail ? `${toolName} ${detail}` : toolName;
    if (toolName === "run_command" && detail) title = `\`${detail}\``;
    if (toolName === "call_mcp_tool") {
      // MCP is one generic tool on this CLI (live M1): server and tool names live in its parameters.
      const server = stringField(params, "ServerName");
      const tool = stringField(params, "ToolName");
      if (server || tool) title = `call_mcp_tool ${server}/${tool}`;
    }
    if (toolName === "invoke_subagent") {
      const names = subagentEntries(rawInput)
        .map((entry) => stringField(entry, "type_name"))
        .filter(Boolean);
      if (names.length > 0) title = `invoke_subagent ${names.join(", ")}`;
    }
    return {
      sessionUpdate: "tool_call",
      toolCallId: key,
      title,
      toolName,
      kind: TOOL_KINDS[toolName] ?? "other",
      status: "pending",
      rawInput,
      locations,
    };
  }

  function toolResult(key: string, stepType: string, step: Record<string, unknown>): SessionUpdate {
    const content: ToolCallContent[] = [];
    let status: "completed" | "failed" = "completed";
    let rawOutput: unknown;
    if (stepType === "subagent") {
      rawOutput = step.subagent_info;
      // The child conversations the harness named (each has its own transcript under brain/<id>/).
      const lines = subagentEntries(step.subagent_info)
        .map((entry) => {
          const name = stringField(entry, "type_name");
          const child = stringField(entry, "conversation_id");
          return child ? `${name}: conversation ${child}` : name;
        })
        .filter(Boolean);
      if (lines.length > 0) content.push({ type: "content", content: { type: "text", text: lines.join("\n") } });
    } else {
      const info = asRecord(step.tool_info);
      rawOutput = info ?? undefined;
      const output = info ? stringField(info, "output") : "";
      if (output) content.push({ type: "content", content: { type: "text", text: output } });
      // Documented, never observed live: tool_info.error { type, message }.
      const error = info ? asRecord(info.error) : null;
      if (error) {
        status = "failed";
        const message = harnessErrorText([stringField(error, "message"), stringField(error, "type")], error);
        if (!output) content.push({ type: "content", content: { type: "text", text: message } });
      }
    }
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: key,
      status,
      content,
      ...(rawOutput !== undefined ? { rawOutput } : {}),
    };
  }

  /** The step's identity: its conversation and index (agy prints no call ids). */
  function stepKey(step: Record<string, unknown>): string {
    const id = stringField(step, "conversation_id") || conversationId || "conversation";
    return `${id}:${String(step.step_index)}`;
  }

  /** One inference per agent_response step: its key is the message id of every line of that step. */
  function stepMessageId(line: Record<string, unknown>): string | undefined {
    if (stringField(line, "step_type") !== "agent_response") return undefined;
    if (typeof line.step_index !== "number") return undefined;
    return stepKey(line);
  }

  function warnOnce(kind: "event" | "step", type: string): void {
    const key = `${kind}:${type}`;
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[antigravity parser] unknown ${kind} type "${type}" passed through as harness_event`);
  }
}

/**
 * agy usage → TokenUsage: promptTokens = input + cache_read (disjoint on the wire; Harbor's arithmetic), completion =
 * output (includes thinking), cached = cache_read; every other counter rides extra verbatim. Null when absent.
 */
export function antigravityTokenUsage(usage: unknown): TokenUsage | null {
  const record = asRecord(usage);
  if (!record) return null;
  const input = finiteNumber(record.input_tokens);
  const output = finiteNumber(record.output_tokens);
  const cacheRead = finiteNumber(record.cache_read_tokens);
  const result: TokenUsage = {};
  if (input !== undefined || cacheRead !== undefined) result.promptTokens = (input ?? 0) + (cacheRead ?? 0);
  if (output !== undefined) result.completionTokens = output;
  if (cacheRead !== undefined) result.cachedTokens = cacheRead;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "input_tokens" || key === "output_tokens" || key === "cache_read_tokens") continue;
    if (value === null || value === undefined) continue;
    extra[key] = value;
  }
  if (Object.keys(extra).length > 0) result.extra = extra;
  return result;
}

/** The line's facts with no ACP slot, under agy's own key names. */
function lineExtra(line: Record<string, unknown>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const key of ["status", "num_turns", "step_index", "step_type", "state", "duration_seconds"]) {
    const value = line[key];
    if (value !== undefined && value !== null) extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** The line under the harness's own type word, every other field verbatim (types.ts HarnessEvent). */
function harnessEvent(type: string, line: Record<string, unknown>, typeKey: string): SessionUpdate {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(line)) {
    if (key !== typeKey) payload[key] = value;
  }
  return { sessionUpdate: "harness_event", type, payload };
}

function subagentEntries(info: unknown): Record<string, unknown>[] {
  const list = asRecord(info)?.subagents;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
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
