#!/usr/bin/env tsx
/**
 * Unit Test: THE PER-LINE FACTS every parser carries for a trajectory.
 *
 * Harbor's converters (REFERENCES/Harbor/src/harbor/agents/installed/*.py)
 * put on every ATIF step what the harness's own record says: token usage per
 * LLM call, the model, the message id, the stop reason, the harness's clock,
 * the structured tool result (exit code, stderr), and — for a subagent — the
 * parent call it belongs to. Until this suite existed our parsers dropped all
 * of it (parsers/types.ts: OutputEvent timestamp/model/messageId/
 * parentToolCallId/extra, ToolCallUpdate.rawOutput, the `usage` variant).
 *
 * Every fixture line is the wire shape of a live capture, with synthetic
 * values (2026-09-08 trials, one per harness; no user data):
 *   claude    stream-json, claude 2.1.263 (assistant / user / result lines)
 *   codex     exec --json, codex 0.153.4 (thread.started, item.*, turn.completed)
 *   gemini    --output-format stream-json (init, tool_result, result.stats)
 *   qwen      qwen-code 0.23.0 NDJSON (assistant message.usage, result.usage)
 *   opencode  run --format json (step_finish tokens/cost, tool_use state)
 *   droid     exec --output-format stream-json, droid 0.182.0 (completion.usage)
 *   kimi      -p --output-format stream-json, kimi-code 0.41.0 (no usage line)
 *
 * The other half of the law: accounting is NEVER work (isAgentWorkUpdate),
 * so a usage-only stream still trips the eval runner's harnessNeverRan.
 */

import { createClaudeParser } from "../../src/parsers/claude.ts";
import { createCodexParser } from "../../src/parsers/codex.ts";
import { createDroidParser } from "../../src/parsers/droid.ts";
import { createGeminiParser } from "../../src/parsers/gemini.ts";
import { createKimiParser } from "../../src/parsers/kimi.ts";
import { createOpenCodeParser } from "../../src/parsers/opencode.ts";
import { createQwenParser } from "../../src/parsers/qwen.ts";
import { isAgentWorkUpdate } from "../../src/parsers/types.ts";
import type { OutputEvent, SessionUpdate } from "../../src/parsers/types.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type Parse = (line: string) => OutputEvent[] | null;

function parseAll(parse: Parse, lines: string[]): OutputEvent[] {
  const out: OutputEvent[] = [];
  for (const line of lines) {
    const events = parse(line);
    if (events) out.push(...events);
  }
  return out;
}

function ofKind<K extends SessionUpdate["sessionUpdate"]>(
  events: OutputEvent[],
  kind: K,
): Array<OutputEvent & { update: Extract<SessionUpdate, { sessionUpdate: K }> }> {
  return events.filter((e) => e.update.sessionUpdate === kind) as Array<
    OutputEvent & { update: Extract<SessionUpdate, { sessionUpdate: K }> }
  >;
}

function textOf(update: { content?: unknown }): string {
  const content = update.content as Array<{ type: string; content?: { type: string; text?: string } }> | undefined;
  return (content ?? [])
    .map((c) => (c.type === "content" && c.content?.type === "text" ? c.content.text ?? "" : ""))
    .join("");
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

async function testClaude(): Promise<void> {
  console.log("\n[claude] the assistant line's own facts ride the envelope, usage rides the usage variant");
  const parse = createClaudeParser();
  const assistant = parseAll(parse, [
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_a1",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Reading it." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cat /app/x" } },
        ],
        model: "claude-sonnet-test",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 7, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, service_tier: "standard" },
      },
      parent_tool_use_id: null,
      session_id: "ses_c",
      uuid: "u1",
      timestamp: "2026-09-08T20:08:51.927Z",
    }),
  ]);
  const message = ofKind(assistant, "agent_message_chunk")[0];
  assert(message?.timestamp === "2026-09-08T20:08:51.927Z", "claude: the line's own timestamp is on the envelope");
  assert(message?.model === "claude-sonnet-test", "claude: message.model is on the envelope");
  assert(message?.messageId === "msg_a1", "claude: message.id is on the envelope");
  assert(same(message?.extra, { stop_reason: "tool_use" }), "claude: stop_reason rides extra; a null stop_sequence stays absent");
  assert(message?.parentToolCallId === undefined, "claude: a main-conversation line has no parentToolCallId");
  const usage = ofKind(assistant, "usage");
  assert(usage.length === 1 && usage[0].update.scope === "call", "claude: ONE call-scoped usage event per assistant line");
  assert(
    same(usage[0]?.update.usage, {
      promptTokens: 150,
      completionTokens: 7,
      cachedTokens: 30,
      extra: { cache_creation_input_tokens: 20, cache_read_input_tokens: 30, service_tier: "standard" },
    }),
    "claude: prompt = input + cache_read + cache_creation (claude_code.py:842-846), other keys verbatim in extra",
  );
  assert(usage[0]?.messageId === "msg_a1", "claude: the usage event carries the message id it belongs to");
  assert(!isAgentWorkUpdate(usage[0]?.update), "claude: usage is never work");

  console.log("\n[claude] the tool result keeps claude's structured record and its raw bytes");
  const result = parseAll(parse, [
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "boom\n", is_error: true }],
      },
      parent_tool_use_id: null,
      session_id: "ses_c",
      timestamp: "2026-09-08T20:08:52.001Z",
      tool_use_result: { stdout: "", stderr: "boom", exitCode: 2, interrupted: false, isImage: false },
    }),
  ]);
  const update = ofKind(result, "tool_call_update")[0];
  assert(update?.update.status === "failed", "claude: is_error still marks the result failed");
  assert(textOf(update?.update ?? {}) === "boom\n", "claude: the error text is the harness's bytes — no ``` fence added");
  assert(
    same(update?.update.rawOutput, { stdout: "", stderr: "boom", exitCode: 2, interrupted: false, isImage: false }),
    "claude: tool_use_result rides rawOutput verbatim (exit code and stderr survive)",
  );
  assert(update?.timestamp === "2026-09-08T20:08:52.001Z", "claude: the result line's timestamp is on the envelope");

  console.log("\n[claude] a Read result is the file's bytes, not a fenced block");
  const read = parseAll(parse, [
    JSON.stringify({ type: "assistant", message: { id: "msg_a2", content: [{ type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: "/app/x" } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_r", type: "tool_result", content: "line1\nline2\n" }] } }),
  ]);
  assert(textOf(ofKind(read, "tool_call_update")[0]?.update ?? {}) === "line1\nline2\n", "claude: Read content verbatim (markdownEscape is gone)");

  console.log("\n[claude] a subagent's line names the parent tool call");
  const sub = parseAll(createClaudeParser(), [
    JSON.stringify({ type: "assistant", message: { id: "msg_s", content: [{ type: "text", text: "sub says hi" }] }, parent_tool_use_id: "toolu_task_1", session_id: "ses_c" }),
  ]);
  assert(ofKind(sub, "agent_message_chunk")[0]?.parentToolCallId === "toolu_task_1", "claude: parent_tool_use_id → parentToolCallId");

  console.log("\n[claude] the successful result is the run's accounting and nothing else");
  const done = parseAll(parse, [
    JSON.stringify({
      type: "result", subtype: "success", is_error: false, num_turns: 2, result: "Done.",
      total_cost_usd: 0.0123, session_id: "ses_c",
      usage: { input_tokens: 400, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "standard" },
    }),
  ]);
  assert(done.length === 1 && done[0].update.sessionUpdate === "usage" && done[0].update.scope === "run", "claude: success result → one run-scoped usage event");
  const run = done[0]?.update.sessionUpdate === "usage" ? done[0].update.usage : null;
  assert(run?.promptTokens === 400 && run?.completionTokens === 40 && run?.costUsd === 0.0123, "claude: run usage carries the tokens and total_cost_usd (claude_code.py:944-973)");
  assert(done.every((e) => !isAgentWorkUpdate(e.update)), "claude: a success result is still not work");

  console.log("\n[claude] requestId rides extra when a line carries it, and only then");
  // claude_code.py:1198-1200 reads stop_reason, stop_sequence and requestId
  // off the message when present. No captured stream or session file has
  // printed requestId so far (prod trial cbf3c254 session file and the
  // 2026-09-09 dev E2E file both grep 0) — the key is a read, not a promise.
  const withRequestId = parseAll(createClaudeParser(), [
    JSON.stringify({ type: "assistant", message: { id: "msg_rq", model: "m", requestId: "req_011", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] } }),
  ]);
  assert(same(withRequestId[0]?.extra, { stop_reason: "end_turn", requestId: "req_011" }), "claude: a message's requestId is kept beside its stop_reason");
  const withoutRequestId = parseAll(createClaudeParser(), [
    JSON.stringify({ type: "assistant", message: { id: "msg_nr", model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] } }),
  ]);
  assert(same(withoutRequestId[0]?.extra, { stop_reason: "end_turn" }), "claude: a line without requestId has no requestId key — absent, never null");

  console.log("\n[claude] a FAILED result still carries the run's accounting beside the error");
  // claude_code.py:944-973 reads total_cost_usd from the result line with no
  // is_error check; a run that hit error_max_turns after many turns has a real
  // total, and dropping it left the ATIF with no harness-reported usage at all.
  const failed = parseAll(createClaudeParser(), [
    JSON.stringify({
      type: "result", subtype: "error_max_turns", is_error: true, num_turns: 9, session_id: "ses_f",
      total_cost_usd: 0.254125, errors: ["Reached maximum number of turns (9)"],
      usage: { input_tokens: 4000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
    }),
  ]);
  assert(failed.length === 2 && failed[0].update.sessionUpdate === "usage" && failed[1].update.sessionUpdate === "error", "claude: failed result → the run usage, then the error");
  const failedUsage = failed[0]?.update.sessionUpdate === "usage" ? failed[0].update : null;
  assert(failedUsage?.scope === "run" && failedUsage.usage.promptTokens === 4100 && failedUsage.usage.completionTokens === 300 && failedUsage.usage.costUsd === 0.254125, "claude: the failed run's tokens and total_cost_usd are the same arithmetic as a success");
  assert(failed.every((e) => !isAgentWorkUpdate(e.update)), "claude: neither event is work — harnessNeverRan still fires on a failed-only stream");
  const costOnly = parseAll(createClaudeParser(), [
    // the live error_max_turns capture (parser-harness-errors.test.ts): total_cost_usd without a usage object
    JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2, session_id: "ses_g", total_cost_usd: 0.0412, errors: ["Reached maximum number of turns (1)"] }),
  ]);
  assert(costOnly.length === 2 && costOnly[0].update.sessionUpdate === "usage" && same(costOnly[0].update.usage, { costUsd: 0.0412 }), "claude: total_cost_usd alone is still the run's accounting (claude_code.py:944-973 reads it without usage)");
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

async function testCodex(): Promise<void> {
  console.log("\n[codex] thread.started names the session; items keep their record; turn.completed is the run's accounting");
  const events = parseAll(createCodexParser(), [
    `{"type":"thread.started","thread_id":"01a081b6-thread"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"python3 -c 1","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
    `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"python3 -c 1","aggregated_output":"python3: command not found\\n","exit_code":127,"status":"failed"}}`,
    `{"type":"turn.completed","usage":{"input_tokens":29745,"cached_input_tokens":22069,"cache_write_input_tokens":7664,"output_tokens":309,"reasoning_output_tokens":67}}`,
  ]);
  assert(events.every((e) => e.sessionId === "01a081b6-thread"), "codex: the thread id is the sessionId on every later event");
  const update = ofKind(events, "tool_call_update")[0];
  assert(update?.update.status === "failed", "codex: exit_code 127 still marks the call failed");
  assert(
    (update?.update.rawOutput as { exit_code?: number } | undefined)?.exit_code === 127,
    "codex: the completed item rides rawOutput, so the exit code itself survives",
  );
  const usage = ofKind(events, "usage");
  assert(usage.length === 1 && usage[0].update.scope === "run", "codex: turn.completed → one run-scoped usage event");
  assert(
    same(usage[0]?.update.usage, {
      promptTokens: 29745,
      completionTokens: 309,
      cachedTokens: 22069,
      extra: { cache_write_input_tokens: 7664, reasoning_output_tokens: 67 },
    }),
    "codex: codex.py:523-541 mapping — cached_input_tokens → cached; cache_write and reasoning ride extra verbatim",
  );
  assert(!isAgentWorkUpdate(usage[0]?.update), "codex: usage is never work");
}

// ---------------------------------------------------------------------------
// gemini
// ---------------------------------------------------------------------------

async function testGemini(): Promise<void> {
  console.log("\n[gemini] init names the model for every later line; results are raw; result.stats is the run's accounting");
  const events = parseAll(createGeminiParser(), [
    `{"type":"init","timestamp":"2026-09-08T15:50:04.130Z","session_id":"g-1","model":"gemini-test-lite"}`,
    `{"type":"tool_use","timestamp":"2026-09-08T15:50:05.677Z","tool_name":"run_shell_command","tool_id":"run_shell_command__1","parameters":{"command":"false"}}`,
    `{"type":"tool_result","timestamp":"2026-09-08T15:50:05.725Z","tool_id":"run_shell_command__1","status":"error","output":"Command exited with code 1"}`,
    `{"type":"result","timestamp":"2026-09-08T15:50:07.040Z","status":"success","stats":{"total_tokens":20042,"input_tokens":19955,"output_tokens":87,"cached":0,"input":19955,"duration_ms":2910,"tool_calls":1,"models":{"gemini-test-lite":{"total_tokens":20042}}}}`,
  ]);
  const call = ofKind(events, "tool_call")[0];
  assert(call?.model === "gemini-test-lite", "gemini: the init model is stamped on later events");
  assert(call?.sessionId === "g-1", "gemini: the init session_id is stamped on later events (message lines carry none)");
  assert(call?.timestamp === "2026-09-08T15:50:05.677Z", "gemini: the line's timestamp is on the envelope");
  const update = ofKind(events, "tool_call_update")[0];
  assert(update?.update.status === "failed" && textOf(update.update) === "Command exited with code 1", "gemini: error output verbatim — no ``` fence (gemini_cli.py:412-416)");
  const usage = ofKind(events, "usage");
  assert(usage.length === 1 && usage[0].update.scope === "run", "gemini: result.stats → one run-scoped usage event");
  assert(
    usage[0]?.update.usage.promptTokens === 19955 && usage[0]?.update.usage.completionTokens === 87 && usage[0]?.update.usage.cachedTokens === 0,
    "gemini: input_tokens/output_tokens/cached mapped; the rest rides extra",
  );
  assert(same(Object.keys(usage[0]?.update.usage.extra ?? {}), ["total_tokens", "input", "duration_ms", "tool_calls", "models"]), "gemini: the other stats keys are kept verbatim in extra");

  console.log("\n[gemini] a FAILED result still carries its stats beside the error");
  const failed = parseAll(createGeminiParser(), [
    `{"type":"result","timestamp":"2026-09-08T15:50:07.040Z","status":"error","error":{"type":"FatalTurnLimitedError","message":"Reached max session turns"},"stats":{"total_tokens":20042,"input_tokens":19955,"output_tokens":87,"cached":0}}`,
  ]);
  assert(failed.length === 2 && failed[0].update.sessionUpdate === "usage" && failed[1].update.sessionUpdate === "error", "gemini: failed result → the run usage, then the error");
  assert(failed[0]?.update.sessionUpdate === "usage" && failed[0].update.scope === "run" && failed[0].update.usage.promptTokens === 19955, "gemini: the failed run's stats are the same arithmetic as a success");
  assert(failed.every((e) => !isAgentWorkUpdate(e.update)), "gemini: neither event is work");
}

// ---------------------------------------------------------------------------
// qwen
// ---------------------------------------------------------------------------

async function testQwen(): Promise<void> {
  console.log("\n[qwen] the assistant line's facts ride the envelope; results are raw; result.usage is the run's accounting");
  const events = parseAll(createQwenParser(), [
    JSON.stringify({
      type: "assistant", uuid: "u1", session_id: "q-1", parent_tool_use_id: "call_parent_9",
      message: {
        id: "m1", type: "message", role: "assistant", model: "qwen-test-flash",
        content: [{ type: "tool_use", id: "call_1", name: "run_shell_command", input: { command: "false" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 23617, output_tokens: 62, cache_read_input_tokens: 5, total_tokens: 23679 },
      },
    }),
    JSON.stringify({
      type: "user", uuid: "u2", session_id: "q-1", parent_tool_use_id: "call_parent_9",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", is_error: true, content: "exit 1" }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", uuid: "u3", session_id: "q-1", is_error: false, num_turns: 2, result: "ok", usage: { input_tokens: 47324, output_tokens: 91, cache_read_input_tokens: 0, total_tokens: 47415 } }),
  ]);
  const call = ofKind(events, "tool_call")[0];
  assert(call?.model === "qwen-test-flash" && call?.messageId === "m1", "qwen: message.model and message.id are on the envelope");
  assert(same(call?.extra, { stop_reason: "tool_use" }), "qwen: stop_reason rides extra");
  assert(call?.parentToolCallId === "call_parent_9", "qwen: parent_tool_use_id → parentToolCallId (protocol.ts:98,107)");
  const usage = ofKind(events, "usage");
  assert(usage.length === 2 && usage[0].update.scope === "call" && usage[1].update.scope === "run", "qwen: one call-scoped usage per assistant line, one run-scoped on the result");
  assert(
    same(usage[0]?.update.usage, { promptTokens: 23617, completionTokens: 62, cachedTokens: 5, extra: { total_tokens: 23679 } }),
    "qwen: input_tokens is the prompt (== the native promptTokenCount qwen_code.py:192 reads), cache_read the cached share",
  );
  const update = ofKind(events, "tool_call_update")[0];
  assert(update?.update.status === "failed" && textOf(update.update) === "exit 1", "qwen: error result verbatim — no ``` fence (qwen_code.py:233-244)");
  assert(update?.parentToolCallId === "call_parent_9", "qwen: the subagent's tool result carries the parent call too");

  console.log("\n[qwen] a FAILED result still carries result.usage beside the error");
  const failed = parseAll(createQwenParser(), [
    JSON.stringify({ type: "result", subtype: "error_max_turns", uuid: "u9", session_id: "q-9", is_error: true, num_turns: 9, usage: { input_tokens: 9000, output_tokens: 120, total_tokens: 9120 } }),
  ]);
  assert(failed.length === 2 && failed[0].update.sessionUpdate === "usage" && failed[1].update.sessionUpdate === "error", "qwen: failed result → the run usage, then the error");
  assert(failed[0]?.update.sessionUpdate === "usage" && failed[0].update.scope === "run" && same(failed[0].update.usage, { promptTokens: 9000, completionTokens: 120, extra: { total_tokens: 9120 } }), "qwen: the failed run's usage is the same arithmetic as a success");
  assert(failed.every((e) => !isAgentWorkUpdate(e.update)), "qwen: neither event is work");
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

async function testOpenCode(): Promise<void> {
  console.log("\n[opencode] timestamps on every event; step_finish is the step's accounting; the user event is the prompt");
  const events = parseAll(createOpenCodeParser(), [
    `{"type":"user","timestamp":1788898138000,"sessionID":"ses_o","parts":[{"type":"text","text":"Do it."}]}`,
    `{"type":"step_start","timestamp":1788898139037,"sessionID":"ses_o","part":{"type":"step-start"}}`,
    `{"type":"tool_use","timestamp":1788898139038,"sessionID":"ses_o","part":{"type":"tool","tool":"bash","callID":"call_o1","state":{"status":"error","input":{"command":"false"},"error":"exit code 1","metadata":{"exit":1},"time":{"start":1,"end":2}}}}`,
    `{"type":"step_finish","timestamp":1788898139042,"sessionID":"ses_o","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":7106,"input":7069,"output":23,"reasoning":14,"cache":{"write":3,"read":10}},"cost":0}}`,
  ]);
  const user = ofKind(events, "user_message_chunk")[0];
  assert(user?.update.content.type === "text" && user.update.content.text === "Do it.", "opencode: the user event becomes the user message (opencode.py:224-238)");
  assert(user?.timestamp === new Date(1788898138000).toISOString(), "opencode: the epoch-ms timestamp is ISO on the envelope");
  const update = ofKind(events, "tool_call_update")[0];
  assert(update?.update.status === "failed" && textOf(update.update) === "exit code 1", "opencode: error text verbatim — no ``` fence (opencode.py:293-297)");
  assert((update?.update.rawOutput as { metadata?: { exit?: number } } | undefined)?.metadata?.exit === 1, "opencode: the tool state rides rawOutput (exit code in metadata)");
  const usage = ofKind(events, "usage");
  assert(usage.length === 1 && usage[0].update.scope === "call", "opencode: step_finish → one call-scoped usage event");
  assert(
    same(usage[0]?.update.usage, { promptTokens: 7079, completionTokens: 23, cachedTokens: 10, extra: { reasoning_tokens: 14, cache_write_tokens: 3 } }),
    "opencode: prompt = input + cache.read, cost 0 is absent, reasoning/cache-write in extra (opencode.py:311-343)",
  );
  assert(usage[0]?.timestamp === new Date(1788898139042).toISOString(), "opencode: the step_finish timestamp is on the usage event");
}

// ---------------------------------------------------------------------------
// droid
// ---------------------------------------------------------------------------

async function testDroid(): Promise<void> {
  console.log("\n[droid] init names the model; lines carry their clock; completion.usage is the run's accounting");
  const events = parseAll(createDroidParser(), [
    `{"type":"system","subtype":"init","cwd":"/app","session_id":"d-1","tools":["Create"],"model":"custom:test-model","reasoning_effort":"high"}`,
    `{"type":"message","role":"assistant","id":"m1","text":"Created it.","timestamp":1788898151024,"session_id":"d-1"}`,
    `{"type":"completion","finalText":"Created it.","numTurns":2,"durationMs":4105,"session_id":"d-1","timestamp":1788898151032,"usage":{"input_tokens":17118,"output_tokens":41,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"factory_credits":1037,"ttft_ms":1843}}`,
  ]);
  const message = ofKind(events, "agent_message_chunk")[0];
  assert(message?.model === "custom:test-model", "droid: the init model is stamped on later events");
  assert(message?.timestamp === new Date(1788898151024).toISOString(), "droid: the epoch-ms timestamp is ISO on the envelope");
  const usage = ofKind(events, "usage");
  assert(usage.length === 1 && usage[0].update.scope === "run", "droid: completion.usage → one run-scoped usage event");
  assert(
    same(usage[0]?.update.usage, { promptTokens: 17118, completionTokens: 41, cachedTokens: 0, extra: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, factory_credits: 1037, ttft_ms: 1843 } }),
    "droid: Anthropic-named counters use claude's arithmetic; factory_credits and ttft_ms ride extra verbatim",
  );
}

// ---------------------------------------------------------------------------
// kimi
// ---------------------------------------------------------------------------

async function testKimi(): Promise<void> {
  console.log("\n[kimi] stream-json carries no usage line at all — a recorded absence, never an invented number");
  const events = parseAll(createKimiParser(), [
    `{"role":"meta","type":"system.version","version":"0.41.0"}`,
    `{"role":"assistant","tool_calls":[{"type":"function","id":"Write_0","function":{"name":"Write","arguments":"{\\"path\\":\\"hello.txt\\",\\"content\\":\\"hi\\"}"}}]}`,
    `{"role":"tool","tool_call_id":"Write_0","content":"Wrote 2 bytes to hello.txt"}`,
    `{"role":"assistant","content":"Done."}`,
    `{"role":"meta","type":"session.resume_hint","session_id":"session_x","command":"kimi -r session_x"}`,
  ]);
  assert(ofKind(events, "usage").length === 0, "kimi: no usage event (PromptJsonWriter writes assistant, tool and meta lines only)");
  assert(ofKind(events, "tool_call").length === 1 && ofKind(events, "agent_message_chunk").length === 1, "kimi: the rest of the stream is unchanged");
}

// ---------------------------------------------------------------------------
// the law
// ---------------------------------------------------------------------------

async function testLaw(): Promise<void> {
  console.log("\n[law] accounting is never work");
  assert(!isAgentWorkUpdate({ sessionUpdate: "usage" }), "isAgentWorkUpdate(usage) === false");
  assert(!isAgentWorkUpdate({ sessionUpdate: "error" }), "isAgentWorkUpdate(error) === false (unchanged)");
  assert(isAgentWorkUpdate({ sessionUpdate: "agent_message_chunk" }), "isAgentWorkUpdate(agent_message_chunk) === true (unchanged)");
}

async function main(): Promise<void> {
  console.log("Parser ATIF-field tests");
  await testClaude();
  await testCodex();
  await testGemini();
  await testQwen();
  await testOpenCode();
  await testDroid();
  await testKimi();
  await testLaw();
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
