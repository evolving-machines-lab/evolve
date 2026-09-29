#!/usr/bin/env tsx
/**
 * Unit Test: pi parser, on the real pi 0.87.1 streams captured against the
 * Evolve gateway 2026-09-25 (tests/fixtures/pi/, provenance in its README).
 *
 * Every assertion below names a fact of a captured file, so a pi release that
 * changes the wire shows up here as a failing fixture rather than as an empty
 * trace in production.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPiParser } from "../../src/parsers/pi.ts";
import { isAgentWorkUpdate } from "../../src/parsers/types.ts";
import type { HarnessEvent, OutputEvent, SessionUpdate } from "../../src/parsers/types.ts";

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

function fixture(name: string): string[] {
  const path = fileURLToPath(new URL(`../fixtures/pi/${name}.jsonl`, import.meta.url));
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
}

/** Parse a whole fixture with one parser instance, collecting every warning pi printed. */
function parseFixture(name: string): { events: OutputEvent[]; warnings: string[] } {
  const parse = createPiParser();
  const events: OutputEvent[] = [];
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    for (const line of fixture(name)) {
      const parsed = parse(line);
      if (parsed) events.push(...parsed);
    }
  } finally {
    console.warn = warn;
  }
  return { events, warnings };
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

function joinedText(events: OutputEvent[]): string {
  return ofKind(events, "agent_message_chunk")
    .map((e) => (e.update.content.type === "text" ? e.update.content.text : ""))
    .join("");
}

function joinedThought(events: OutputEvent[]): string {
  return ofKind(events, "agent_thought_chunk")
    .map((e) => (e.update.content.type === "text" ? e.update.content.text : ""))
    .join("");
}

function harnessEvents(events: OutputEvent[], type: string): HarnessEvent[] {
  return ofKind(events, "harness_event")
    .map((e) => e.update)
    .filter((u) => u.type === type);
}

// ---------------------------------------------------------------------------

function testToolUse(): void {
  console.log("\n[1] tool-use.jsonl — write, read, answer: the whole loop maps once, nothing twice");
  const { events, warnings } = parseFixture("tool-use");
  assert(warnings.length === 0, "no unknown event type in a plain tool run");
  assert(events.every((e) => e.sessionId === "recon-pi-t2"), "the session header's id rides every event");

  const users = ofKind(events, "user_message_chunk");
  assert(users.length === 1 && users[0].update.content.type === "text" && users[0].update.content.text.startsWith("Create a file named hello.txt"), "the user message is one user_message_chunk (message_start only, not message_end)");
  assert(users[0]?.timestamp === new Date(1790367024243).toISOString(), "the user line's epoch-ms clock is ISO on the envelope");

  // Turn 1 streamed four thinking deltas; the message_end repeats the thought and must not.
  const thoughts = ofKind(events, "agent_thought_chunk");
  assert(thoughts.length === 4 && joinedThought(events) === "Simple task. Create and print.", "thinking streams as deltas, and message_end adds no second copy");

  const calls = ofKind(events, "tool_call");
  assert(calls.length === 2, "two tool calls (write, read), each announced once by the assistant message_end");
  const write = calls[0]?.update;
  assert(write?.toolCallId === "call_1398aec3ea0f4d4696d1b3d7" && write.toolName === "write" && write.kind === "edit", "write: id, verbatim tool name, kind edit");
  assert(write?.title === "write /work/hello.txt", "write: the title names the path");
  assert(same(write?.locations, [{ path: "/work/hello.txt" }]), "write: the path is a location");
  assert(same(write?.content, [{ type: "diff", path: "/work/hello.txt", oldText: null, newText: "hello from pi" }]), "write: the content is a new-file diff");
  assert(same(write?.rawInput, { path: "/work/hello.txt", content: "hello from pi" }), "write: the arguments ride rawInput verbatim");
  assert(calls[0]?.model === "openrouter/deepseek/deepseek-v4.1-flash" && calls[0]?.messageId === "gen-1790367024-qHHf9RzBu5d8QjcuqpG5", "the tool call carries the message's model and responseId");
  const read = calls[1]?.update;
  assert(read?.toolName === "read" && read.kind === "read" && same(read.locations, [{ path: "/work/hello.txt" }]), "read: kind read, the path as a location");

  const updates = ofKind(events, "tool_call_update");
  assert(updates.length === 2, "two tool results, no in_progress (this run printed no tool_execution_update)");
  assert(updates[0]?.update.toolCallId === write?.toolCallId && updates[0].update.status === "completed", "write completed");
  assert(textOf(updates[0]?.update ?? {}) === "Successfully wrote to /work/hello.txt", "write: the result text verbatim");
  assert(same(updates[0]?.update.rawOutput, { content: [{ type: "text", text: "Successfully wrote to /work/hello.txt" }] }), "write: the whole result record rides rawOutput (no details key on write, as captured)");
  assert(textOf(updates[1]?.update ?? {}) === "hello from pi", "read: the file's bytes verbatim");

  assert(joinedText(events) === "Created `hello.txt` and its contents are:\n\n```\nhello from pi\n```", "the answer streams as text deltas, joined verbatim, with no second copy from message_end");

  const usage = ofKind(events, "usage");
  assert(usage.length === 3 && usage.every((u) => u.update.scope === "call"), "one call-scoped usage per assistant message (three inferences)");
  assert(
    same(usage[0]?.update.usage, {
      promptTokens: 1774,
      completionTokens: 121,
      cachedTokens: 1536,
      extra: { cacheRead: 1536, cacheWrite: 0, reasoning: 8, totalTokens: 1895 },
    }),
    "usage: prompt = input + cacheRead + cacheWrite (Harbor pi.py), cost 0 is unknown and absent, the rest rides extra under wire names",
  );
  assert(usage[0]?.messageId === "gen-1790367024-qHHf9RzBu5d8QjcuqpG5" && usage[0]?.timestamp === new Date(1790367024255).toISOString(), "usage carries the message's responseId and clock");
  assert(same(usage[0]?.extra, { stopReason: "toolUse", rawStopReason: "tool_calls", provider: "evolve-gateway", api: "openai-completions" }), "the message's stop reasons, provider and api ride extra under pi's own key names");
  assert(usage.every((u) => !isAgentWorkUpdate(u.update)), "usage is never work");

  assert(ofKind(events, "error").length === 0 && ofKind(events, "harness_event").length === 0, "a clean run has no error and no generic event");
}

function testResume(): void {
  console.log("\n[2] resume.jsonl — a resumed session streams only the new turn");
  const { events } = parseFixture("resume");
  assert(events.every((e) => e.sessionId === "recon-pi-t2"), "the resumed header repeats the original id");
  const users = ofKind(events, "user_message_chunk");
  assert(users.length === 1 && users[0].update.content.type === "text" && users[0].update.content.text === "Which file did you create? Answer with its name only.", "only the new user message");
  assert(joinedText(events) === "hello.txt", "the answer");
  assert(ofKind(events, "usage").length === 1, "one inference");
}

function testModelErrorNoRetry(): void {
  console.log("\n[3] model-error-no-retry.jsonl — exit 0, but the stream says the call failed and the loop gave up");
  const { events } = parseFixture("model-error-no-retry");
  const errors = ofKind(events, "error");
  assert(errors.length === 2, "two error events: the failed message, then the loop giving up");
  assert(errors[0]?.update.message === '500: {"message":"capture only"}' && errors[0].update.fatal === false, "message_end stopReason error → the harness's errorMessage verbatim, not yet fatal (pi may retry)");
  assert(errors[1]?.update.message === '500: {"message":"capture only"}' && errors[1].update.fatal === true, "agent_end with willRetry false after a failure → the same failure, fatal");
  assert(same(errors[0]?.extra, { stopReason: "error", provider: "evolve-gateway", api: "openai-completions" }), "the failed message's stop reason rides extra");
  assert(ofKind(events, "usage").length === 0, "a failed call that printed all zeros is not an inference");
  assert(ofKind(events, "agent_message_chunk").length === 0 && ofKind(events, "tool_call").length === 0, "no agent work");
}

function testModelErrorRetries(): void {
  console.log("\n[4] model-error-retries.jsonl — 429 then 500s: every attempt is an error, the retry schedule is kept, one fatal at the end");
  const { events, warnings } = parseFixture("model-error-retries");
  assert(warnings.length === 0, "auto_retry_start and entry_appended are known pi events");
  const errors = ofKind(events, "error");
  assert(errors.length === 5, "four failed attempts plus the loop giving up");
  assert(errors[0]?.update.message.startsWith("429: ") && errors[0].update.fatal === false, "the first attempt's 429 body verbatim, not fatal");
  assert(errors.slice(0, 4).every((e) => e.update.fatal === false), "no attempt is fatal while pi still retries");
  assert(errors[4]?.update.fatal === true && errors[4].update.message.startsWith("500: "), "the last agent_end (willRetry false) is the fatal error, once — auto_retry_end adds no second");
  const retries = harnessEvents(events, "auto_retry_start");
  assert(retries.length === 3 && same(retries.map((r) => r.payload.attempt), [1, 2, 3]) && retries[0].payload.delayMs === 2000, "the three auto_retry_start lines ride harness_event with their fields verbatim");
  assert(harnessEvents(events, "entry_appended").length === 3, "the three context_edit entries ride harness_event");
  assert(harnessEvents(events, "auto_retry_end").length === 0, "the failed auto_retry_end became the fatal error, not a generic event");
  assert(events.filter((e) => e.update.sessionUpdate === "harness_event").every((e) => !isAgentWorkUpdate(e.update)), "generic events are never work");
}

function testToolError(): void {
  console.log("\n[5] tool-error.jsonl — bash `exit 3`: in_progress once, then failed with the harness's text");
  const { events } = parseFixture("tool-error");
  const call = ofKind(events, "tool_call")[0]?.update;
  assert(call?.toolName === "bash" && call.kind === "execute" && call.title === "bash exit 3", "bash: kind execute, the command in the title");
  assert(textOf(call ?? {}) === "exit 3", "bash: the command is the call's content");
  const updates = ofKind(events, "tool_call_update");
  assert(updates.length === 2 && updates[0].update.status === "in_progress" && updates[0].update.content === undefined, "the tool_execution_update becomes one in_progress with no content");
  assert(updates[1]?.update.status === "failed" && textOf(updates[1].update) === "(no output)\n\nCommand exited with code 3", "isError true → failed, the output verbatim");
  assert(same(updates[1]?.update.rawOutput, { content: [{ type: "text", text: "(no output)\n\nCommand exited with code 3" }], details: {} }), "the result record rides rawOutput");
  assert(joinedText(events).endsWith("returned exit code **3**."), "the run continues to its answer");
}

function testCancelled(): void {
  console.log("\n[6] cancelled.jsonl — SIGINT mid-tool: the stream ends on a running tool, no verdict invented");
  const { events } = parseFixture("cancelled");
  const call = ofKind(events, "tool_call")[0]?.update;
  assert(call?.toolName === "bash" && (call.rawInput as { timeout?: number }).timeout === 220, "the running bash call is announced with its arguments");
  const updates = ofKind(events, "tool_call_update");
  assert(updates.length === 1 && updates[0].update.status === "in_progress", "three tool_execution_update lines → exactly one in_progress");
  assert(events[events.length - 1]?.update.sessionUpdate === "tool_call_update", "the last event is the in_progress: nothing completed, nothing failed");
  assert(ofKind(events, "error").length === 0, "no error is invented for a kill the stream never reported");
}

function testMcp(): void {
  console.log("\n[7] mcp.jsonl — pi-mcp-adapter: every MCP call is the `mcp` proxy tool; adapter failures live in details.error");
  const { events, warnings } = parseFixture("mcp");
  assert(warnings.length === 0, "no unknown event type");
  const calls = ofKind(events, "tool_call");
  assert(calls.length === 5 && calls.every((c) => c.update.toolName === "mcp" && c.update.kind === "other"), "five calls, all the adapter's proxy tool, kind other");
  assert(calls[0]?.update.title === "mcp add" && textOf(calls[0].update) === '{"a":40,"b":2}', "a call names the MCP tool in the title and carries its args");
  assert(calls[1]?.update.title === "mcp search add", "a search names its query");
  assert(calls[2]?.update.title === "mcp", "a status call is bare");
  assert(calls[3]?.update.title === "mcp everything", "a listing names the server");
  assert(calls[4]?.update.title === "mcp everything_get-sum", "the real call names the canonical tool");

  const updates = ofKind(events, "tool_call_update");
  assert(updates.length === 5, "five results");
  assert(updates[0]?.update.status === "failed", "tool_not_found: isError false on the wire, details.error set → failed");
  assert((updates[0]?.update.rawOutput as { details?: { error?: string } })?.details?.error === "tool_not_found", "the adapter's error rides rawOutput.details");
  assert(updates.slice(1).every((u) => u.update.status === "completed"), "the four other calls completed");
  assert(textOf(updates[4]?.update ?? {}) === "The sum of 40 and 2 is 42." && (updates[4]?.update.rawOutput as { details?: { server?: string; tool?: string } })?.details?.server === "everything", "the real call's text and server/tool record");
  assert(joinedText(events) === "42", "the answer");
}

function testSkills(): void {
  console.log("\n[8] skills.jsonl — a skill is a plain read of its SKILL.md");
  const { events } = parseFixture("skills");
  const call = ofKind(events, "tool_call")[0]?.update;
  assert(call?.toolName === "read" && same(call.locations, [{ path: "/root/.agents/skills/secret-handshake/SKILL.md", line: undefined }]), "the skill load is a read of the listed SKILL.md");
  assert(textOf(ofKind(events, "tool_call_update")[0]?.update ?? {}).includes("HANDSHAKE-7431"), "the SKILL.md bytes come back verbatim");
  assert(joinedText(events).endsWith("HANDSHAKE-7431"), "the answer follows the skill");
}

function testSyntheticShapes(): void {
  console.log("\n[9] synthetic lines — the laws a capture cannot show");
  const parse = createPiParser();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    assert(parse("not json") === null, "a non-JSON line is null");
    assert(parse('{"type":"agent_start"}') === null && parse('{"type":"turn_start"}') === null && parse('{"type":"turn_end","message":{},"toolResults":[]}') === null && parse('{"type":"agent_settled"}') === null, "loop punctuation is silent");

    const unknown = parse('{"type":"zzz_future_event","x":1}');
    assert(same(unknown?.[0]?.update, { sessionUpdate: "harness_event", type: "zzz_future_event", payload: { x: 1 } }), "an unknown type passes through as harness_event with the line verbatim");
    parse('{"type":"zzz_future_event","x":2}');
    assert(warnings.length === 1 && warnings[0].includes("zzz_future_event"), "an unknown type is warned once per parser, not per line");
    assert(same(parse('{"type":"compaction_start","reason":"threshold"}')?.[0]?.update, { sessionUpdate: "harness_event", type: "compaction_start", payload: { reason: "threshold" } }) && warnings.length === 1, "a known session-level event rides harness_event without a warning");

    // A message_end whose text never streamed (no deltas) is still the answer.
    parse('{"type":"message_start","message":{"role":"assistant","content":[],"model":"m","stopReason":"pending","timestamp":1}}');
    const end = parse('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"whole"}],"model":"m","stopReason":"stop","timestamp":2,"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0.5}}}}');
    assert(end?.[0]?.update.sessionUpdate === "agent_message_chunk" && end[0].update.content.type === "text" && end[0].update.content.text === "whole", "message_end text is emitted when no delta carried it");
    const usage = end?.find((e) => e.update.sessionUpdate === "usage")?.update;
    assert(usage?.sessionUpdate === "usage" && usage.usage.costUsd === 0.5, "a positive cost.total is costUsd");

    // A tool_execution_start for a call no message announced is the call itself.
    const start = parse('{"type":"tool_execution_start","toolCallId":"x1","toolName":"read","args":{"path":"/a"}}');
    assert(start?.[0]?.update.sessionUpdate === "tool_call" && start[0].update.toolCallId === "x1", "an unannounced tool_execution_start emits the tool_call");
    assert(parse('{"type":"tool_execution_start","toolCallId":"x1","toolName":"read","args":{}}') === null, "an announced call's start is silent");

    // Prime's raw-stop-reason spelling is also read by the shared core.
    const prime = parse('{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop","stopReasonRaw":"end_turn","timestamp":3,"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}}}}');
    assert(same(prime?.[0]?.extra, { stopReason: "stop", stopReasonRaw: "end_turn" }), "stopReasonRaw (Prime's spelling) rides extra like pi's rawStopReason");
  } finally {
    console.warn = warn;
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("pi Parser Unit Tests (live captures, pi 0.87.1)");
  console.log("=".repeat(60));

  testToolUse();
  testResume();
  testModelErrorNoRetry();
  testModelErrorRetries();
  testToolError();
  testCancelled();
  testMcp();
  testSkills();
  testSyntheticShapes();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
