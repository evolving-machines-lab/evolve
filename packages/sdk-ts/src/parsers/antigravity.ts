/**
 * Antigravity CLI (`antigravity`, Google's `agy`) `--output-format stream-json`
 * → ACP-style events parser.
 *
 * PROVENANCE. The CLI is closed source and publishes no schema, so every shape
 * below comes from two places, in this order of authority: live capture of
 * agy 1.2.11 (26 stream-json runs against the Evolve gateway, 2026-09-25,
 * fixtures in tests/unit/antigravity-parser.test.ts) and the vendor's headless
 * docs page (antigravity.google/docs/cli/headless). Where the two disagree the
 * capture wins and the disagreement is noted. A later agy release may change
 * any of it without anything here failing to compile — which is why a line of
 * a kind this file does not know is passed through as an `unknown` update
 * rather than dropped (parsers/types.ts UnknownUpdate).
 *
 * Three top-level events, every line `{ event, <event>: {...} }`:
 *
 *   init         { conversation_id, init: { model, cwd, tools[], permission_mode } }
 *                names the model and the conversation ONCE; both are stamped
 *                on every later event (gemini/droid precedent).
 *   step_update  { conversation_id, step_index, state: ACTIVE|DONE, step_type,
 *                  tool_name?, text_delta?, thinking_delta?, duration_seconds?,
 *                  usage?, tool_info?, subagent_info? }
 *                one conversation step, streamed as several updates.
 *                step_type seen live: user_input, agent_response, tool,
 *                error_message, system_message, subagent (the last three are
 *                undocumented). Documented, never seen: checkpoint.
 *   result       { conversation_id, status, response, error?, duration_seconds,
 *                  num_turns, usage }
 *                once per process. status seen live: SUCCESS, ERROR. Documented
 *                also: CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING.
 *
 * plus the `--output-format json` envelope: the result object bare, no `event`.
 *
 * WHAT THE WIRE DOES NOT CARRY. No timestamps (none stamped). No text on
 * user_input, system_message or error_message steps — the error text arrives
 * only on the result line, the messages only in the on-disk transcript. No
 * tool call ids — a tool step is identified by its step_index, which is what
 * pairs its ACTIVE and DONE updates here. A failing shell command produces
 * neither `tool_info.error` nor an exit code (live E2: `exit 3` → a DONE update
 * with parameters only), so a tool result reports what the harness said —
 * completed — and nothing more.
 *
 * USAGE. Every DONE agent_response carries `usage` for THAT model call
 * (input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
 * total_tokens — output includes thinking; cache_read is disjoint from input,
 * total excludes it), so it is a per-call usage line keyed by the step; the
 * result's `usage` is the conversation's running total (cumulative across a
 * resumed conversation's turns, live T4) and rides as the run-scoped line.
 * Harbor's arithmetic for this stream (antigravity_cli.py, cache reads added
 * into prompt tokens): promptTokens = input + cache_read.
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

/**
 * agy's tool names (the 57 the init line lists, 1.2.11) mapped to ACP kinds.
 * Browser tools stay "other": ACP has no browser kind and "fetch" would claim
 * a network read the tool may not make.
 */
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

/** Step types that carry no content on the wire and are agent work of no kind — dropped, documented. */
const CONTENT_FREE_STEPS = new Set(["user_input", "system_message"]);

export function createAntigravityParser(): (jsonLine: string) => OutputEvent[] | null {
  let model: string | undefined;
  let conversationId: string | undefined;
  // Tool and subagent steps whose ACTIVE update opened a tool_call, so a DONE
  // update becomes a tool_call_update rather than a second call.
  const openedSteps = new Set<string>();
  // Every agent_response text delta so far, so the result's `response` (the
  // same text, whole) is not published a second time.
  let streamedText = "";

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

    switch (eventName) {
      case "init": {
        const init = asRecord(data.init);
        const named = init ? stringField(init, "model") : "";
        if (named) model = named;
        const id = stringField(data, "conversation_id");
        if (id) conversationId = id;
        return null;
      }
      case "step_update": {
        const step = asRecord(data.step_update);
        if (!step) return stamp([unknownUpdate(eventName, data)], data);
        return stamp(handleStep(step), step);
      }
      case "result": {
        const result = asRecord(data.result);
        if (!result) return stamp([unknownUpdate(eventName, data)], data);
        return stamp(handleResult(result), result);
      }
      default:
        // A top-level event this file does not know — passed through, never
        // dropped (closed-source stream, file header).
        return stamp([unknownUpdate(eventName || "unknown", data)], data);
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

      // A model/agent API failure the run may or may not recover from (live
      // E1b: seven of these, one per retry, then the result; U1: three, then
      // the answer). Not terminal, so `fatal` is false; the wire carries no
      // text on the step itself — the message arrives on the result line —
      // so this dumps the step rather than emitting a blank (harnessErrorText).
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

      default: {
        if (CONTENT_FREE_STEPS.has(stepType)) return [];
        // A step type this file does not know (checkpoint is documented but
        // never observed; a later release may add more). Passed through, and
        // its accounting kept when it carries some.
        const passthrough: SessionUpdate[] = [unknownUpdate(`step_update:${stepType || "unknown"}`, step)];
        const usage = antigravityTokenUsage(step.usage);
        if (usage) passthrough.push({ sessionUpdate: "usage", scope: "call", usage });
        return passthrough;
      }
    }
  }

  function handleResult(result: Record<string, unknown>): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    // The final text, whole. Published only when the stream did not already
    // carry it as deltas (the json envelope, or a response that never streamed).
    const response = stringField(result, "response");
    if (response && !streamedText.includes(response)) {
      streamedText += response;
      updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: response } });
    }
    // The conversation's total, whatever the status: a run that failed after
    // real calls did real work, and accounting is never work (types.ts).
    const usage = antigravityTokenUsage(result.usage);
    if (usage) updates.push({ sessionUpdate: "usage", scope: "run", usage });
    const status = stringField(result, "status");
    if (status !== "SUCCESS") {
      // The one place a fatal failure's text appears (E1a, E1b, E3 `interrupted`).
      // Any non-SUCCESS status is the run ending short of an answer; the
      // documented CANCELED/INTERRUPTED/INVALID/WAITING/RUNNING were never
      // observed, so they are not given semantics beyond "not a success".
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
      // MCP is one generic tool on this CLI (live M1): the server and tool
      // names live in its parameters, never in the tool name.
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
      // The child conversations the harness named (own transcript under brain/<id>/).
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
}

/**
 * agy's usage object → TokenUsage. promptTokens = input + cache_read (Harbor's
 * arithmetic for this stream; the two are disjoint on the wire), completion =
 * output (which includes thinking), cached = cache_read; thinking_tokens,
 * total_tokens and anything else ride extra verbatim. Null when absent.
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

function unknownUpdate(kind: string, raw: unknown): SessionUpdate {
  return { sessionUpdate: "unknown", kind, raw };
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
