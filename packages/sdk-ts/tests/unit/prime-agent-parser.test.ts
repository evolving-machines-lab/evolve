#!/usr/bin/env tsx
/**
 * Unit Test: Prime Agent parser, on the real Prime Agent v0.9.6 streams
 * captured against the Evolve gateway 2026-09-25 (tests/fixtures/prime-agent/,
 * provenance in its README).
 *
 * The shared core is proven in pi-parser.test.ts; this file proves what
 * Prime adds: the one `ipython` tool and its `details.status` verdict, the
 * kernel-bootstrap partials, sub-agents (`rlm_child_update`, the child's reply
 * as a custom `agent_message`), `auth_stale`, and the fatal read from
 * `auto_retry_end` (Prime prints no `willRetry`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPrimeAgentParser } from "../../src/parsers/prime-agent.ts";
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
  const path = fileURLToPath(new URL(`../fixtures/prime-agent/${name}.jsonl`, import.meta.url));
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
}

function parseFixture(name: string): { events: OutputEvent[]; warnings: string[] } {
  const parse = createPrimeAgentParser();
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

function harnessEvents(events: OutputEvent[], type: string): HarnessEvent[] {
  return ofKind(events, "harness_event")
    .map((e) => e.update)
    .filter((u) => u.type === type);
}

// ---------------------------------------------------------------------------

function testToolUse(): void {
  console.log("\n[1] tool-use.jsonl — one ipython cell: the digest is silent, the kernel bootstrap is one in_progress, the result is the cell's stdout");
  const { events, warnings } = parseFixture("tool-use");
  assert(warnings.length === 0, "no unknown event type");
  assert(events.every((e) => e.sessionId === "01a0da3d-7608-767d-8861-65d523a57a1e"), "the session header's id rides every event");

  const users = ofKind(events, "user_message_chunk");
  assert(users.length === 1 && users[0].update.content.type === "text" && users[0].update.content.text.startsWith("Create a file named hello.txt"), "the harness_digest custom message is not conversation; the user message is");

  const thoughts = ofKind(events, "agent_thought_chunk");
  assert(thoughts.length > 0 && thoughts[0].timestamp === new Date(1790367856540).toISOString() && thoughts[0].model === "openrouter/deepseek/deepseek-v4.1-flash", "Prime keeps the message on message_update, so a delta carries the message's clock and model");

  const calls = ofKind(events, "tool_call");
  assert(calls.length === 1, "one tool call");
  const call = calls[0]?.update;
  assert(call?.toolName === "ipython" && call.kind === "execute" && call.toolCallId === "call_e5beed6d033e450aa86e50c0", "ipython: verbatim name, kind execute");
  assert(call?.title === "ipython with open('hello.txt','w') as f:", "the title is the cell's first line");
  assert(textOf(call ?? {}).startsWith("with open('hello.txt','w') as f:\n") && (call?.rawInput as { code?: string }).code === textOf(call ?? {}), "the whole cell is the content and rides rawInput.code");

  const updates = ofKind(events, "tool_call_update");
  assert(updates.length === 2 && updates[0].update.status === "in_progress", "eight kernel-bootstrap partials (status starting → ok) become exactly one in_progress");
  assert(updates[1]?.update.status === "completed" && textOf(updates[1].update) === "hello from prime\n\n/work/hello.txt\n", "status ok → completed, the stdout verbatim");
  const details = (updates[1]?.update.rawOutput as { details?: Record<string, unknown> })?.details;
  assert(details?.status === "ok" && details?.stdout === "hello from prime\n\n/work/hello.txt\n" && details?.kernelRestarted === false, "IpythonToolDetails ride rawOutput verbatim");

  const usage = ofKind(events, "usage");
  assert(usage.length === 2 && usage.every((u) => u.update.scope === "call"), "two inferences, two call-scoped usage events");
  assert(same(usage[0]?.update.usage, { promptTokens: 6067, completionTokens: 90, cachedTokens: 256, extra: { cacheRead: 256, cacheWrite: 0, totalTokens: 6157 } }), "prompt = input + cacheRead + cacheWrite; no reasoning key when the wire has none");
  assert(usage[0]?.messageId === "gen-1790367857-N3z8CS2KM20qDSJqrsHa", "the responseId is the message id");
  assert(same(usage[0]?.extra, { stopReason: "toolUse", provider: "evolve", api: "openai-completions" }), "Prime's message_end carries no raw stop reason on this route; the keys present ride extra");
  assert(joinedText(events).startsWith("Done."), "the answer streams as deltas");
}

function testResume(): void {
  console.log("\n[2] resume.jsonl — only the new turn");
  const { events } = parseFixture("resume");
  const users = ofKind(events, "user_message_chunk");
  assert(users.length === 1 && users[0].update.content.type === "text" && users[0].update.content.text === "Which file did you create? Answer with its name only.", "only the new user message (no digest, no system)");
  assert(joinedText(events) === "hello.txt" && ofKind(events, "usage").length === 1, "the answer and one inference");
}

function testModelError401(): void {
  console.log("\n[3] model-error-401.jsonl — 401: every attempt is an error, auth_stale is kept, auto_retry_end is the fatal");
  const { events, warnings } = parseFixture("model-error-401");
  assert(warnings.length === 0, "auth_stale is a known Prime event");
  const errors = ofKind(events, "error");
  assert(errors.length === 3, "two failed attempts plus the loop giving up");
  assert(errors[0]?.update.message === "401 hdrsink: rejected on purpose\n\nRun /login to update credentials." && errors[0].update.fatal === false, "message_end stopReason error → errorMessage verbatim, not fatal");
  assert(errors[1]?.update.fatal === false, "the retried attempt is not fatal either (Prime prints no willRetry)");
  assert(errors[2]?.update.fatal === true && errors[2].update.message === "401 hdrsink: rejected on purpose\n\nRun /login to update credentials.", "auto_retry_end success false → the finalError, fatal, once");
  const stale = harnessEvents(events, "auth_stale");
  assert(stale.length === 1 && stale[0].payload.provider === "hdrcheck", "auth_stale rides harness_event with its fields");
  assert(harnessEvents(events, "auto_retry_start")[0]?.payload.delayMs === 2271, "auto_retry_start rides harness_event");
  assert(ofKind(events, "usage").length === 0, "failed calls that printed zeros are not inferences");
}

function testModelErrorRetries(): void {
  console.log("\n[4] model-error-retries.jsonl — 429 then 500s");
  const { events } = parseFixture("model-error-retries");
  const errors = ofKind(events, "error");
  assert(errors.length === 4 && errors[0].update.message === "429 sink: rate limited on purpose", "three attempts plus the fatal, the 429 body verbatim");
  assert(errors.slice(0, 3).every((e) => !e.update.fatal) && errors[3]?.update.fatal === true && errors[3].update.message === "500 sink: internal error on purpose", "only auto_retry_end's finalError is fatal");
  assert(harnessEvents(events, "auto_retry_start").length === 2, "two retries kept as harness_event");
  assert(same(errors[0]?.extra, { stopReason: "error", provider: "sink", api: "openai-completions" }), "the failed message's facts ride extra");
}

function testToolError(): void {
  console.log("\n[5] tool-error.jsonl — a cell that raised: isError false on the wire, details.status error → failed");
  const { events } = parseFixture("tool-error");
  const updates = ofKind(events, "tool_call_update");
  const result = updates.find((u) => u.update.status !== "in_progress")?.update;
  assert(result?.status === "failed", "status error → failed although isError is false");
  assert(textOf(result ?? {}).startsWith("Traceback (most recent call last):"), "the traceback text verbatim");
  const details = (result?.rawOutput as { details?: Record<string, unknown> })?.details;
  assert(details?.status === "error" && details?.errorEname === "CalledProcessError", "the error record rides rawOutput.details");
  assert(joinedText(events).includes("CalledProcessError"), "the run continues to its report");
}

function testCancelled(): void {
  console.log("\n[6] cancelled.jsonl — SIGINT mid-cell: one in_progress, nothing invented");
  const { events } = parseFixture("cancelled");
  const updates = ofKind(events, "tool_call_update");
  assert(updates.length === 1 && updates[0].update.status === "in_progress", "twelve partial lines → one in_progress, no completion");
  assert(events[events.length - 1]?.update.sessionUpdate === "tool_call_update" && ofKind(events, "error").length === 0, "the stream ends on the running cell, no error invented");
}

function testMcp(): void {
  console.log("\n[7] mcp.jsonl — MCP through Python: cells, not MCP events");
  const { events, warnings } = parseFixture("mcp");
  assert(warnings.length === 0, "no unknown event type");
  const calls = ofKind(events, "tool_call");
  assert(calls.length === 5 && calls.every((c) => c.update.toolName === "ipython"), "five ipython cells and no MCP tool of its own");
  assert(((calls[4]?.update.rawInput as { code?: string }).code ?? "").includes('mcp.call_tool("everything", "get-sum"'), "the MCP call is Python source in the cell");
  const results = ofKind(events, "tool_call_update").filter((u) => u.update.status !== "in_progress");
  assert(results.length === 5 && results[0].update.status === "failed" && results[4].update.status === "completed", "the AttributeError cell failed (details.status), the real call completed");
  assert(textOf(results[4]?.update ?? {}) === "The sum of 40 and 2 is 42.\n" && joinedText(events) === "42", "the MCP result is stdout; the answer follows");
}

function testSkills(): void {
  console.log("\n[8] skills.jsonl — a skill is read inside a cell");
  const { events } = parseFixture("skills");
  const call = ofKind(events, "tool_call")[0]?.update;
  assert(((call?.rawInput as { code?: string }).code ?? "").includes("secret-handshake/SKILL.md"), "the SKILL.md is opened from Python");
  assert(joinedText(events).includes("HANDSHAKE-7431"), "the answer follows the skill");
}

function testSubagents(): void {
  console.log("\n[9] subagents.jsonl — rlm.spawn/collect: the child's progress rides harness_event, its reply is a user turn");
  const { events, warnings } = parseFixture("subagents");
  assert(warnings.length === 0, "rlm_child_update and session_action_update are known Prime events");
  const children = harnessEvents(events, "rlm_child_update");
  assert(children.length === 12, "twelve rlm_child_update lines, each kept");
  const first = children[0].payload.child as Record<string, unknown>;
  assert(first.id === "sub-8fd542ea" && first.status === "queued" && first.sessionName === "pong-echoer", "the first names the child and its queued status");
  assert(children.some((c) => (c.payload.child as Record<string, unknown>).status === "done" && (c.payload.child as Record<string, unknown>).answerPreview === "PONG"), "a later one records done with the child's answer");
  assert(harnessEvents(events, "session_action_update").length === 5, "the five session_action_update lines are kept");

  const users = ofKind(events, "user_message_chunk");
  assert(users.length === 2, "the instruction, then the child's reply");
  const reply = users[1];
  assert(reply?.update.content.type === "text" && reply.update.content.text === "[agent-message from child:pong-echoer]\n\nPONG", "the custom agent_message becomes a user turn with its text verbatim");
  assert(reply?.extra?.customType === "agent_message" && (reply?.extra?.from as { sessionName?: string })?.sessionName === "pong-echoer", "extra names the custom type and the sender");
  assert(ofKind(events, "tool_call").length === 2 && ofKind(events, "usage").length === 3, "two cells, three inferences (the third answers the child's reply)");
  assert(events.filter((e) => e.update.sessionUpdate === "harness_event").every((e) => !isAgentWorkUpdate(e.update)), "generic events are never work");
}

function testSyntheticShapes(): void {
  console.log("\n[10] synthetic lines — Prime-specific laws a capture cannot show");
  const parse = createPrimeAgentParser();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    // A message_end aborted (the session file's spelling of a SIGINT mid-call) is an error, not silence.
    const aborted = parse('{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"aborted","timestamp":1,"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"total":0}}}}');
    assert(aborted?.length === 1 && aborted[0].update.sessionUpdate === "error" && aborted[0].update.message === "aborted" && aborted[0].update.fatal === false, "stopReason aborted → error with the stop reason as its text, no usage for a zero call");

    // A failure Prime never retries (retry disabled, a non-retryable kind) ends on agent_end with no
    // auto_retry_end: the error stays non-fatal — at agent_end the parser cannot know that no retry follows.
    const unretried = createPrimeAgentParser();
    const unretriedError = unretried('{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"400 context overflow","timestamp":1}}');
    assert(unretriedError?.length === 1 && unretriedError[0].update.sessionUpdate === "error" && unretriedError[0].update.fatal === false, "an unretried Prime failure is one non-fatal error");
    assert(unretried('{"type":"agent_end","messages":[]}') === null, "Prime's agent_end carries no willRetry, so it marks nothing fatal");
    // isError true on the wire is also failed.
    parse('{"type":"tool_execution_start","toolCallId":"c1","toolName":"ipython","args":{"code":"x"}}');
    const failed = parse('{"type":"tool_execution_end","toolCallId":"c1","toolName":"ipython","result":{"content":[{"type":"text","text":"boom"}],"details":{"status":"ok"}},"isError":true}');
    assert(failed?.[0]?.update.sessionUpdate === "tool_call_update" && failed[0].update.status === "failed", "isError true → failed even when details say ok");
    // An unknown custom message role rides through.
    const custom = parse('{"type":"message_start","message":{"role":"branchSummary","content":"summary","timestamp":1}}');
    assert(custom?.[0]?.update.sessionUpdate === "harness_event" && custom[0].update.type === "message_start", "a message role the core has never seen rides harness_event");
    assert(parse('{"type":"message_start","message":{"role":"custom","customType":"harness_digest","content":"x","timestamp":1}}') === null, "the harness_digest is silent");
    assert(warnings.length === 0, "none of the above warned");
    const unknown = parse('{"type":"rlm_future_event","child":{}}');
    assert(unknown?.[0]?.update.sessionUpdate === "harness_event" && warnings.length === 1 && warnings[0].includes("[prime-agent parser]"), "an unknown type warns once, naming the harness");
  } finally {
    console.warn = warn;
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Prime Agent Parser Unit Tests (live captures, v0.9.6)");
  console.log("=".repeat(60));

  testToolUse();
  testResume();
  testModelError401();
  testModelErrorRetries();
  testToolError();
  testCancelled();
  testMcp();
  testSkills();
  testSubagents();
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
