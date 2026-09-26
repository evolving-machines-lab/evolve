#!/usr/bin/env tsx
/**
 * Unit Test: Z Code Parser
 *
 * Every fixture under tests/fixtures/zcode/ is a REAL `zcode -p …
 * --output-format stream-json` capture (ZCode 3.14.3, CLI 0.16.9, 2026-09-25)
 * against the Evolve gateway on the GLM 5.3 routes, with the gateway host
 * replaced by `<GATEWAY_URL>` and the working directory by `$S` — nothing
 * else changed. One capture per behaviour the parser must read: tool use,
 * MCP, a skill, a sub-agent, a model error ladder, a tool that exits
 * non-zero, two cancellations and a 400. The hand-written lines below are
 * the shapes no capture could carry without a machine path (the
 * no-provider-file failure, a resume) or that the vendor documents but the
 * live runs never produced (a model_complete without streamed deltas, an
 * unknown type).
 */

import { readFileSync } from "node:fs";

import { createZcodeParser } from "../../src/parsers/zcode.ts";
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

function fixture(name: string): string[] {
  return readFileSync(new URL(`../fixtures/zcode/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseAll(lines: string[]): OutputEvent[] {
  const parse = createZcodeParser();
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

function joinedAgentText(events: OutputEvent[]): string {
  return ofKind(events, "agent_message_chunk")
    .map((e) => (e.update.content.type === "text" ? e.update.content.text : ""))
    .join("");
}

// ---------------------------------------------------------------------------

async function testToolUse(): Promise<void> {
  console.log("\n[1] tool use (glm-T2-flash): Write, then the answer — two requests");
  const events = parseAll(fixture("glm-T2-flash"));

  const echo = ofKind(events, "user_message_chunk");
  assert(echo.length === 1 && echo[0].update.content.type === "text" && echo[0].update.content.text.startsWith("Create a file named hello.txt"), "turn.started echoes the prompt once");
  assert(events.every((e) => e.sessionId === "sess_f69325ab-f1e6-4571-b433-3042201020d4"), "every event carries the run's session id");
  assert(events[0].update.sessionUpdate === "harness_event" && events[0].update.type === "session.titleUpdated" && events[0].model === undefined && echo[0].model === undefined, "the title line and the prompt echo precede the first request line, so they name no model");
  assert(events.slice(2).every((e) => e.model === "openrouter/z-ai/glm-5.3-flash"), "the model named on the first request line is stamped on it and every later event");
  assert(events.every((e) => e.timestamp === undefined || !Number.isNaN(Date.parse(e.timestamp))), "epoch-ms timestamps become ISO on the envelope");
  assert(ofKind(events, "agent_thought_chunk").length > 0, "reasoning deltas are thought chunks");

  const calls = ofKind(events, "tool_call");
  assert(calls.length === 1, `exactly one tool_call (got ${calls.length})`);
  const write = calls[0]?.update;
  assert(write?.toolName === "Write" && write.kind === "edit", "Write is an edit with its verbatim name");
  assert(write?.status === "pending", "the tool_call is pending when the model produces it");
  assert(typeof (write?.rawInput as Record<string, unknown>)?.file_path === "string", "rawInput carries the model's input verbatim");
  assert(write?.locations?.[0]?.path === "$S/work/hello.txt", "the file path is a location");
  assert(write?.title === "Write $S/work/hello.txt", "the title names the tool and its path");

  const updates = ofKind(events, "tool_call_update").filter((e) => e.update.toolCallId === write?.toolCallId);
  assert(updates.length === 2, `started + result → two tool_call_updates (got ${updates.length})`);
  assert(updates[0]?.update.status === "in_progress", "tool.updated started → in_progress");
  assert(updates[1]?.update.status === "completed", "tool.updated result → completed");
  assert(textOf(updates[1]?.update ?? {}).startsWith("File created successfully"), "the result content is the tool's own text");
  const raw = updates[1]?.update.rawOutput as Record<string, unknown> | undefined;
  assert(raw?.success === true && typeof raw?.perf === "object", "rawOutput is Z Code's structured result (success, perf)");

  const calls_ = ofKind(events, "usage").filter((e) => e.update.scope === "call");
  const runs = ofKind(events, "usage").filter((e) => e.update.scope === "run");
  assert(calls_.length === 2, `two per-call usage events, one per model request (got ${calls_.length})`);
  assert(calls_.every((e) => typeof e.messageId === "string" && e.messageId.startsWith("msg_")), "per-call usage is keyed to the assistant message it belongs to");
  assert(calls_[0].messageId !== calls_[1].messageId, "the two requests have two message ids");
  assert(typeof calls_[0].update.usage.promptTokens === "number" && typeof calls_[0].update.usage.completionTokens === "number", "prompt and completion counts are read");
  assert(typeof calls_[0].update.usage.extra?.reasoningTokens === "number", "reasoningTokens rides extra under its wire name");
  assert(runs.length === 1, "the result line is the one run-scoped usage");
  assert(runs[0].update.usage.promptTokens === 40521 && runs[0].update.usage.completionTokens === 410, "the run total is result.usage as printed (40521 / 410)");
  assert((runs[0].update.usage.extra as Record<string, unknown>)?.modelRequestCount === 2, "modelRequestCount rides extra");
  assert(ofKind(events, "error").length === 0, "a successful run reports no failure");

  const facts = ofKind(events, "harness_event");
  assert(facts.length === 7, `title, checkpoint, stream-recovery, two model_request and two request-start lines pass through as harness_event (got ${facts.length})`);
  assert(facts.every((e) => !isAgentWorkUpdate(e.update)), "a harness_event is never agent work");
  assert(facts.filter((e) => e.update.type === "session.updated" && (e.update.payload.payload as Record<string, unknown>)?.type === "model_request_started").length === 2, "each request start is one harness_event under the type word session.updated");
  assert(facts.every((e) => !("type" in e.update.payload) && typeof e.update.payload.seq === "number" && typeof e.update.payload.payload === "object"), "payload is the line minus its type word: seq, sessionId, timestamp and the vendor payload verbatim");
  assert(facts.map((e) => e.update.type).filter((t) => t !== "session.updated").sort().join(",") === "checkpoint.created,session.titleUpdated,streamRecovery.updated", "the three session-level fact types of a tool run");

  const finalTexts = events.filter((e) => e.update.sessionUpdate === "agent_message_chunk").slice(-1);
  assert(finalTexts.length === 1, "text is present");
  assert(!joinedAgentText(events).includes("hello from zcode\n```hello from zcode"), "result.response is not repeated after the streamed text (dedupe)");
}

async function testMcp(): Promise<void> {
  console.log("\n[2] MCP (glm-M1): an mcp__<server>__<tool> call looks like any other tool");
  const events = parseAll(fixture("glm-M1"));
  const call = ofKind(events, "tool_call")[0]?.update;
  assert(call?.toolName === "mcp__everything__get-sum", "the verbatim MCP tool name is carried");
  assert(call?.kind === "other", "an MCP tool is kind other");
  assert(JSON.stringify(call?.rawInput) === JSON.stringify({ a: 40, b: 2 }), "the MCP input rides rawInput");
  const done = ofKind(events, "tool_call_update").find((e) => e.update.status === "completed");
  assert(textOf(done?.update ?? {}) === "The sum of 40 and 2 is 42.", "the MCP result text is the tool's own");
  assert(joinedAgentText(events).includes("42"), "the answer follows");
}

async function testSkill(): Promise<void> {
  console.log("\n[3] skills (glm-S1): a skill load is a Skill tool call");
  const events = parseAll(fixture("glm-S1"));
  const call = ofKind(events, "tool_call")[0]?.update;
  assert(call?.toolName === "Skill" && call.kind === "execute", "Skill is an execute-kind tool");
  assert(call?.title === "Skill secret-handshake", "the title names the skill");
  const done = ofKind(events, "tool_call_update").find((e) => e.update.status === "completed");
  assert(textOf(done?.update ?? {}).includes('<skill_content name="secret-handshake">'), "the skill body is the tool result");
  assert(joinedAgentText(events).includes("HANDSHAKE-7431"), "the skill's answer follows");
}

async function testSubagent(): Promise<void> {
  console.log("\n[4] sub-agent (glm-U1): the child's lines are stamped with the delegating call");
  const events = parseAll(fixture("glm-U1"));
  const agentCall = ofKind(events, "tool_call").find((e) => e.update.toolName === "Agent");
  assert(agentCall !== undefined && agentCall.update.kind === "think", "the Agent delegation is a think-kind tool_call");
  const parentToolCallId = agentCall?.update.toolCallId;
  const child = events.filter((e) => e.extra?.childSessionId !== undefined);
  assert(child.length > 0 && child.every((e) => e.extra?.childSessionId === "sess_subagent_agent_ca1a6360-3d21-4ddb-aa69-424c7c69aac3"), "the child's lines name the child's own session under extra");
  assert(child.every((e) => e.sessionId === "sess_6899ec83-fd4d-47e4-99bb-a659504ad8f6"), "child events keep the RUN's session id on the envelope");
  const [first, ...announced] = child;
  assert(first.update.sessionUpdate === "harness_event" && first.update.type === "session.titleUpdated" && first.parentToolCallId === undefined && first.model === undefined, "the child's title line arrives one line before the parent announces it: no parent stamp and no model yet");
  assert(announced.length > 0 && announced.every((e) => e.parentToolCallId === parentToolCallId), "every child line after the announcement carries the id of the parent's Agent call");
  assert(events.filter((e) => e.extra?.childSessionId === undefined).every((e) => e.parentToolCallId === undefined), "root lines carry no parent stamp");
  const childEcho = child.find((e) => e.update.sessionUpdate === "user_message_chunk");
  assert(childEcho !== undefined && childEcho.update.sessionUpdate === "user_message_chunk" && childEcho.update.content.type === "text" && childEcho.update.content.text === "Reply with the word PONG.", "the child's turn.started is its own prompt");
  const childUsage = child.filter((e) => e.update.sessionUpdate === "usage");
  assert(childUsage.length === 1 && childUsage[0].update.sessionUpdate === "usage" && childUsage[0].update.scope === "call" && childUsage[0].update.usage.promptTokens === 15043, "the child's request has its own per-call usage (15043 prompt tokens)");
  assert(child.some((e) => e.update.sessionUpdate === "agent_message_chunk"), "the child's text is in the stream");
  const runs = ofKind(events, "usage").filter((e) => e.update.scope === "run");
  assert(runs.length === 1 && runs[0].update.usage.promptTokens === 40480, "the run total counts the parent's requests only (40480), as Z Code prints it");
  const result = ofKind(events, "tool_call_update").find((e) => e.update.toolCallId === parentToolCallId && e.update.status === "completed");
  assert(textOf(result?.update ?? {}).startsWith("PONG"), "the Agent tool's result is the child's answer");
  assert(ofKind(events, "error").length === 0, "no failure");

  const vendor = (e: OutputEvent) => ((e.update as { payload?: Record<string, unknown> }).payload?.payload ?? {}) as Record<string, unknown>;
  const status = ofKind(events, "harness_event").filter((e) => typeof vendor(e).childSessionId === "string");
  assert(status.length === 2 && status.map((e) => vendor(e).status).join(",") === "running,completed", "the parent's two sub-agent status lines are harness_events (running, then completed)");
  assert(status.every((e) => e.parentToolCallId === undefined), "…as the parent's own lines, not stamped as the child's");
  assert(ofKind(events, "harness_event").filter((e) => vendor(e).modelSelection !== undefined).length === 1, "the child's model_selected line is a harness_event");
}

async function testModelError(): Promise<void> {
  console.log("\n[5] model error (glm-E1): 429 then 500 then 500 — three request failures, then the turn fails");
  const events = parseAll(fixture("glm-E1"));
  const errors = ofKind(events, "error");
  assert(errors.length === 4, `three request failures and the turn failure (got ${errors.length})`);
  assert(errors.slice(0, 3).every((e) => e.update.fatal === false), "a request failure is not fatal on its own (retries follow)");
  assert(errors[0].update.message === "Rate limit exceeded (sink)" && errors[0].extra?.statusCode === 429 && errors[0].extra?.retryable === true, "the 429 carries the harness's message, status and retryable");
  assert(errors[2].extra?.retryable === false, "the last attempt is marked not retryable");
  assert(errors[3].update.fatal === true && errors[3].update.message === "Internal server error (sink)", "turn.failed is fatal, in the harness's own words");
  assert(errors[3].extra?.code === "internal_error" && errors[3].extra?.turnPhase === "processing_input", "code and turnPhase ride extra");
  assert(ofKind(events, "usage").length === 0, "no usage line exists for a run that never got an answer");
  const work = events.filter((e) => isAgentWorkUpdate(e.update));
  assert(work.length === 1 && work[0].update.sessionUpdate === "user_message_chunk", "the only work-shaped event is the prompt echo");
  const retries = ofKind(events, "harness_event").filter((e) => (e.update.payload.payload as Record<string, unknown>)?.type === "model_retry_scheduled");
  assert(retries.length === 2 && retries.every((e) => typeof (e.update.payload.payload as Record<string, unknown>).delayMs === "number"), `the two scheduled retries are harness_events carrying delayMs (got ${retries.length})`);
}

async function testProbe400(): Promise<void> {
  console.log("\n[6] a 400 (glm-PROBE1) is not retried: one request failure, one fatal turn.failed");
  const events = parseAll(fixture("glm-PROBE1"));
  const errors = ofKind(events, "error");
  assert(errors.length === 2, `two failures (got ${errors.length})`);
  assert(errors[0].update.fatal === false && errors[0].extra?.statusCode === 400 && errors[0].extra?.errorCode === "invalid_model_request", "the request failure names the 400");
  assert(errors[1].update.fatal === true && errors[1].extra?.code === "400", "the turn failure is fatal with the harness's code");
}

async function testToolExitCode(): Promise<void> {
  console.log("\n[7] tool failure (glm-E2): a non-zero exit is a completed tool to Z Code — the exit code rides rawOutput");
  const events = parseAll(fixture("glm-E2"));
  const call = ofKind(events, "tool_call")[0]?.update;
  assert(call?.toolName === "Bash" && call.kind === "execute" && call.title === "Bash exit 3", "the Bash call and its command");
  const done = ofKind(events, "tool_call_update").find((e) => e.update.status === "completed");
  assert(done !== undefined, "the tool completed (Z Code's success:true)");
  const perf = (done?.update.rawOutput as { perf?: { detail?: { command?: { exitCode?: number } } } })?.perf;
  assert(perf?.detail?.command?.exitCode === 3, "exit code 3 is in the structured result");
  assert(textOf(done?.update ?? {}) === "Exit code 3", "the content is the tool's own text");
  assert(ofKind(events, "error").length === 0, "no harness failure");
  assert(ofKind(events, "usage").filter((e) => e.update.scope === "run").length === 1, "the run total is present");
}

async function testCancelWhileStreaming(): Promise<void> {
  console.log("\n[8] cancellation while streaming (glm-E3): request cancelled, turn.completed cancelled, no result line");
  const events = parseAll(fixture("glm-E3"));
  const errors = ofKind(events, "error");
  assert(errors.length === 2, `two failures (got ${errors.length})`);
  assert(errors[0].update.fatal === false && errors[0].extra?.errorCode === "model_request_cancelled", "the request's cancellation is a non-fatal failure");
  assert(errors[1].update.fatal === true && errors[1].update.message === "cancelled" && errors[1].extra?.resultType === "cancelled", "turn.completed{cancelled} is the fatal verdict");
  assert(ofKind(events, "usage").length === 0, "a cancelled turn with no usage reports none");
}

async function testCancelDuringTool(): Promise<void> {
  console.log("\n[9] cancellation during a tool (glm-E3b): the tool fails, the turn is cancelled, the turn's usage rides beside it");
  const events = parseAll(fixture("glm-E3b"));
  const call = ofKind(events, "tool_call")[0]?.update;
  assert(call?.toolName === "Bash", "the Bash call was recorded before the signal");
  const failedTool = ofKind(events, "tool_call_update").find((e) => e.update.status === "failed");
  assert(failedTool !== undefined && failedTool.update.toolCallId === call?.toolCallId, "tool.updated error → failed");
  assert(textOf(failedTool?.update ?? {}) === "Bash was cancelled and the child process was asked to stop", "the tool error is the harness's message");
  assert((failedTool?.update.rawOutput as Record<string, unknown>)?.code === "TOOL_CANCELLED", "rawOutput is the structured error");
  const fatal = ofKind(events, "error").filter((e) => e.update.fatal);
  assert(fatal.length === 1 && fatal[0].update.message === "cancelled", "one fatal failure: the cancelled turn");
  const runs = ofKind(events, "usage").filter((e) => e.update.scope === "run");
  assert(runs.length === 1 && runs[0].update.usage.promptTokens === 20129, "turn.completed.usage is the run total when no result line follows (20129)");
}

async function testNoProviderFile(): Promise<void> {
  console.log("\n[10] no provider file: a single turn.failed line, exit 1");
  const events = parseAll([
    JSON.stringify({
      eventId: "e1",
      payload: {
        error: { type: "unknown_error", attribution: { retryable: false }, code: "CONFIGURATION_ERROR", message: "Select a model before continuing", detail: "Model creation failed" },
        turnPhase: "model_creation",
      },
      seq: 1,
      sessionId: "sess_d819a07a",
      timestamp: 1790367240179,
      traceId: "t",
      turnId: "turn_1",
      type: "turn.failed",
    }),
  ]);
  assert(events.length === 1 && events[0].update.sessionUpdate === "error", "one failure");
  assert(events[0].update.sessionUpdate === "error" && events[0].update.fatal && events[0].update.message === "Select a model before continuing", "fatal, in the harness's words");
  assert(events[0].extra?.code === "CONFIGURATION_ERROR" && events[0].extra?.turnPhase === "model_creation", "code and phase ride extra");
  assert(events[0].timestamp === new Date(1790367240179).toISOString(), "the line's clock is on the envelope");
}

async function testFactsAndUnknown(): Promise<void> {
  console.log("\n[11] session-level facts pass through as harness_event; an unknown type is logged once and passed through too");
  const parse = createZcodeParser();
  const resumed = parse(JSON.stringify({ type: "session.resumed", sessionId: "sess_x", seq: 27, timestamp: 1, payload: { directory: "/w", interruptedToolCount: 0, messageCount: 4, partCount: 12 } }));
  const fact = resumed?.[0]?.update;
  assert(resumed?.length === 1 && fact?.sessionUpdate === "harness_event" && fact.type === "session.resumed", "session.resumed is one harness_event under its own type word");
  assert(
    fact?.sessionUpdate === "harness_event" &&
      JSON.stringify(fact.payload) === JSON.stringify({ sessionId: "sess_x", seq: 27, timestamp: 1, payload: { directory: "/w", interruptedToolCount: 0, messageCount: 4, partCount: 12 } }),
    "payload is the line's other fields verbatim",
  );
  assert(fact !== undefined && !isAgentWorkUpdate(fact), "a harness_event is never agent work");
  assert(resumed?.[0]?.timestamp === "1970-01-01T00:00:00.001Z" && resumed[0].sessionId === "sess_x", "the envelope keeps the line's session and timestamp");
  for (const type of ["session.titleUpdated", "checkpoint.created", "streamRecovery.updated"]) {
    const out = parse(JSON.stringify({ type, sessionId: "sess_x", seq: 2, timestamp: 1, payload: {} }));
    assert(out?.length === 1 && out[0].update.sessionUpdate === "harness_event" && out[0].update.type === type, `${type} is a harness_event`);
  }
  assert(parse(JSON.stringify({ type: "turn.completed", sessionId: "sess_x", seq: 9, timestamp: 1, payload: { resultType: "success", response: "ok", usage: {} } })) === null, "a successful turn.completed is loop punctuation: silent");
  assert(parse(JSON.stringify({ type: "tool.updated", sessionId: "sess_x", seq: 10, timestamp: 1, payload: { kind: "batch", toolCallIds: ["c"], successCount: 1, errorCount: 0 } })) === null, "a tool batch line is loop punctuation: silent");

  const warnings: string[] = [];
  const previous = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const unseen = parse(JSON.stringify({ type: "permission.requested", sessionId: "sess_x", seq: 3, timestamp: 1, payload: { toolCallId: "c", toolName: "Bash" } }));
    assert(unseen?.length === 1 && unseen[0].update.sessionUpdate === "harness_event" && unseen[0].update.type === "permission.requested", "a documented-but-unseen type passes through as harness_event");
    parse(JSON.stringify({ type: "permission.requested", sessionId: "sess_x", seq: 4, timestamp: 1, payload: {} }));
    const novel = parse(JSON.stringify({ type: "something.new", sessionId: "sess_x", seq: 5, timestamp: 1, payload: { a: 1 } }));
    assert(novel?.length === 1 && novel[0].update.sessionUpdate === "harness_event" && novel[0].update.type === "something.new", "an unknown type passes through as harness_event");
    const catchAll = parse(JSON.stringify({ type: "session.updated", sessionId: "sess_x", seq: 6, timestamp: 1, payload: { compactedMessages: 12, summary: "…" } }));
    assert(catchAll?.length === 1 && catchAll[0].update.sessionUpdate === "harness_event" && catchAll[0].update.type === "session.updated", "an unclassifiable catch-all payload passes through as harness_event");
    parse(JSON.stringify({ type: "session.updated", sessionId: "sess_x", seq: 7, timestamp: 1, payload: { compactedMessages: 3, summary: "…" } }));
  } finally {
    console.warn = previous;
  }
  assert(warnings.length === 3, `each unknown type is logged once per parser (got ${warnings.length})`);
  assert(warnings.every((w) => w.startsWith("[zcode parser] unknown event type ")), "the log line names the parser and says what it is");
  assert(warnings[0].endsWith("permission.requested") && warnings[1].endsWith("something.new") && warnings[2].endsWith("session.updated/{compactedMessages,summary}"), "the log names the type (a catch-all payload by its key set)");
  assert(parse("not json") === null && parse("{}") === null, "a non-JSON line and a line with no type are ignored");
}

async function testModelCompleteWithoutDeltas(): Promise<void> {
  console.log("\n[12] model_complete carries the text when nothing was streamed for the message");
  const parse = createZcodeParser();
  const base = { sessionId: "sess_y", traceId: "t", turnId: "turn_1", timestamp: 1790376331943 };
  parse(JSON.stringify({ ...base, seq: 1, type: "session.updated", payload: { messageCount: 6, providerId: "evolve", modelId: "openrouter/z-ai/glm-5.3", toolCount: 40, iteration: 0 } }));
  parse(JSON.stringify({ ...base, seq: 2, type: "model.streaming", payload: { assistantMessageId: "msg_1", delta: "", done: false, kind: "start" } }));
  const complete = parse(JSON.stringify({ ...base, seq: 3, type: "session.updated", payload: { content: "Done.", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 2 }, contextWindow: 200000 } }));
  assert(complete?.length === 1 && complete[0].update.sessionUpdate === "agent_message_chunk", "the unstreamed content is emitted once");
  assert(complete?.[0].messageId === "msg_1" && complete[0].model === "openrouter/z-ai/glm-5.3" && complete[0].extra?.stopReason === "stop", "message id, model and stopReason ride the envelope");
  // Streamed text is never repeated by model_complete.
  parse(JSON.stringify({ ...base, seq: 4, type: "model.streaming", payload: { assistantMessageId: "msg_2", delta: "", done: false, kind: "start" } }));
  parse(JSON.stringify({ ...base, seq: 5, type: "model.streaming", payload: { assistantMessageId: "msg_2", delta: "OK", done: false, kind: "text_delta" } }));
  const dup = parse(JSON.stringify({ ...base, seq: 6, type: "session.updated", payload: { content: "OK", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 1 } } }));
  assert(dup === null, "streamed text is not repeated");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Z Code Parser Unit Tests");
  console.log("=".repeat(60));

  await testToolUse();
  await testMcp();
  await testSkill();
  await testSubagent();
  await testModelError();
  await testProbe400();
  await testToolExitCode();
  await testCancelWhileStreaming();
  await testCancelDuringTool();
  await testNoProviderFile();
  await testFactsAndUnknown();
  await testModelCompleteWithoutDeltas();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
