#!/usr/bin/env tsx
/**
 * Unit Test: THE HARNESS-ERROR LAW, across all seven parsers.
 *
 * The law lives in parsers/types.ts (AgentError): a failure the HARNESS itself
 * reported is the `error` variant — never an agent_message_chunk, never
 * dropped. Folding it into a message chunk is the worse of the two failures,
 * because the eval runner's harnessNeverRan law keys on "zero trace events":
 * a surfaced error that counts as work turns an unreachable-model run into a
 * SCORED ZERO. Dropping it is the blindness that cost a full night of
 * diagnosis on codex.
 *
 * codex was the only parser that obeyed. This suite pins the same two
 * properties for all seven:
 *   1. the failure is surfaced, with the harness's own text VERBATIM;
 *   2. it is never counted as agent work (isAgentWorkUpdate === false).
 *
 * WIRE FIXTURES. Every line below is the real thing, not a paraphrase:
 *   claude    live capture, CLI 2.1.233 (`--output-format stream-json`);
 *             shape pinned by SDKResultError in @anthropic-ai/claude-agent-sdk
 *   codex     the stdout of the failing daytona/modal trials (see
 *             codex-parser-errors.test.ts, which owns the codex regression)
 *   droid     live capture, droid 0.182.0 (`droid exec --output-format
 *             stream-json`, and the `--output-format json` result line)
 *   gemini    ErrorEvent / ResultEvent, gemini-cli
 *             packages/core/src/output/types.ts
 *   kimi      PromptJsonWriter.writeRetrying, kimi-code
 *             apps/kimi-code/src/cli/prompt-render.ts:209-225
 *   opencode  emit("error", { error }), opencode
 *             packages/opencode/src/cli/cmd/run.ts:678-691, 776-786
 *   qwen      SDKResultMessageError, qwen-code
 *             packages/sdk-typescript/src/types/protocol.ts:152-170
 *
 * ONE TRAP WORTH NAMING: {"type":"error"} does NOT mean the same thing in
 * every harness. In gemini it is a non-fatal warning and the run continues;
 * in droid and opencode it is the failure itself. That is why `fatal` is read
 * from each harness's own terminal signal rather than from the event name.
 */

import { createClaudeParser } from "../../src/parsers/claude.ts";
import { createCodexParser } from "../../src/parsers/codex.ts";
import { createDroidParser } from "../../src/parsers/droid.ts";
import { createGeminiParser } from "../../src/parsers/gemini.ts";
import { createKimiParser } from "../../src/parsers/kimi.ts";
import { createOpenCodeParser } from "../../src/parsers/opencode.ts";
import { createQwenParser } from "../../src/parsers/qwen.ts";
import { isAgentWorkUpdate } from "../../src/parsers/types.ts";
import type { AgentError, OutputEvent } from "../../src/parsers/types.ts";

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

type Parse = (line: string) => OutputEvent[] | null;

function parseAll(parse: Parse, lines: string[]): OutputEvent[] {
  const out: OutputEvent[] = [];
  for (const line of lines) {
    const events = parse(line);
    if (events) out.push(...events);
  }
  return out;
}

function errorsOf(events: OutputEvent[]): AgentError[] {
  return events
    .map((e) => e.update)
    .filter((u): u is AgentError => u.sessionUpdate === "error");
}

function workOf(events: OutputEvent[]): OutputEvent[] {
  return events.filter((e) => isAgentWorkUpdate(e.update));
}

/**
 * The two properties every harness must hold at once. Every per-harness case
 * below routes through this so the law cannot drift between harnesses.
 */
function assertLaw(
  harness: string,
  events: OutputEvent[],
  expected: { count: number; contains: string[]; fatal: boolean[] },
): void {
  const errors = errorsOf(events);
  assert(errors.length === expected.count, `${harness}: ${expected.count} failure(s) surfaced (got ${errors.length})`);
  assert(workOf(events).length === 0, `${harness}: a failure-only stream has ZERO work events, so harnessNeverRan still fires`);

  for (const [i, needle] of expected.contains.entries()) {
    const message = errors[i]?.message ?? "";
    assert(message.includes(needle), `${harness}: message ${i} carries the harness's own text ("${needle}")`);
    assert(message.length > 0, `${harness}: message ${i} is never empty`);
    assert(
      !/[❌⚠️]/u.test(message),
      `${harness}: message ${i} is verbatim — no decoration added to the harness's words`,
    );
  }
  for (const [i, fatal] of expected.fatal.entries()) {
    assert(errors[i]?.fatal === fatal, `${harness}: failure ${i} fatal=${fatal}`);
  }
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

async function testClaude(): Promise<void> {
  console.log("\n[claude] the failed result message");

  // Live capture, claude 2.1.233. The failure carrier is `errors: string[]` —
  // there is no error.message, and no `result` field at all on a failure.
  const events = parseAll(createClaudeParser(), [
    `{"type":"result","subtype":"error_max_turns","is_error":true,"duration_ms":2621,"duration_api_ms":3054,"num_turns":2,"stop_reason":"tool_use","session_id":"0cb2912b-eaa2-4c17-9d7c-a5bcbca4afa6","total_cost_usd":0.254125,"permission_denials":[],"terminal_reason":"max_turns","errors":["Reached maximum number of turns (1)"],"uuid":"4ab4934c-b758-4a63-bc0b-1a889dd9ecf4"}`,
  ]);
  assertLaw("claude", events, {
    count: 1,
    contains: ["Reached maximum number of turns (1)"],
    fatal: [true],
  });
  assert(events[0]?.sessionId === "0cb2912b-eaa2-4c17-9d7c-a5bcbca4afa6", "claude: keeps the session id");

  console.log("\n[claude] a successful result is still not an event");
  const ok = createClaudeParser()(
    `{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1"}`,
  );
  assert(ok === null, "claude: a success result stays silent (its text already streamed)");

  console.log("\n[claude] a failure with an empty errors[] still says something");
  const bare = errorsOf(parseAll(createClaudeParser(), [
    `{"type":"result","subtype":"error_during_execution","is_error":true,"errors":[],"session_id":"s1"}`,
  ]));
  assert(bare.length === 1, "claude: surfaced even with no error text");
  assert((bare[0]?.message ?? "").length > 0, "claude: falls back to the harness's own subtype rather than an empty string");
}

// ---------------------------------------------------------------------------
// codex — the parser that already obeyed; it must keep obeying
// ---------------------------------------------------------------------------

async function testCodex(): Promise<void> {
  console.log("\n[codex] the reference implementation still holds");

  const events = parseAll(createCodexParser(), [
    `{"type":"error","message":"stream disconnected before completion"}`,
    `{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}`,
  ]);
  assertLaw("codex", events, {
    count: 2,
    contains: ["stream disconnected before completion", "stream disconnected before completion"],
    fatal: [false, true],
  });
}

// ---------------------------------------------------------------------------
// droid
// ---------------------------------------------------------------------------

async function testDroid(): Promise<void> {
  console.log("\n[droid] stream-json error lines (live capture, droid 0.182.0)");

  // One failure emits TWO lines: the cause, then the wrapper's generic report.
  // Neither is a turn-ended event — droid's stream-json has no terminal line on
  // failure at all — so neither is marked fatal.
  const events = parseAll(createDroidParser(), [
    `{"type":"error","source":"agent_loop","message":"Connection error.","timestamp":1786858026302,"session_id":"8093cb3f-5673-420c-b944-627870d8f5fd"}`,
    `{"type":"error","source":"cli","message":"Exec failed","timestamp":1786858026307,"session_id":"8093cb3f-5673-420c-b944-627870d8f5fd"}`,
  ]);
  assertLaw("droid", events, {
    count: 2,
    contains: ["Connection error.", "Exec failed"],
    fatal: [false, false],
  });
  assert(events[0]?.sessionId === "8093cb3f-5673-420c-b944-627870d8f5fd", "droid: keeps the session id");

  console.log("\n[droid] the --output-format json failure result");
  const result = parseAll(createDroidParser(), [
    `{"type":"result","subtype":"failure","is_error":true,"duration_ms":119,"num_turns":0,"result":"Exec failed","session_id":"6f947e8e-1542-4a62-af3f-15281253dc24"}`,
  ]);
  assertLaw("droid/result", result, { count: 1, contains: ["Exec failed"], fatal: [true] });

  console.log("\n[droid] a JSON-RPC error response");
  const rpc = parseAll(createDroidParser(), [
    `{"type":"response","id":1,"error":{"code":-32603,"message":"Internal error: model gateway unreachable"}}`,
  ]);
  assertLaw("droid/rpc", rpc, { count: 1, contains: ["model gateway unreachable"], fatal: [true] });

  console.log("\n[droid] a successful run is untouched");
  const okEvents = parseAll(createDroidParser(), [
    `{"type":"result","subtype":"success","is_error":false,"result":"all done","session_id":"s2"}`,
  ]);
  assert(workOf(okEvents).length === 1, "droid: a successful result is still agent work");
  assert(errorsOf(okEvents).length === 0, "droid: a successful result is not a failure");
}

// ---------------------------------------------------------------------------
// gemini
// ---------------------------------------------------------------------------

async function testGemini(): Promise<void> {
  console.log("\n[gemini] the terminal failure is the result event, not the error event");

  // gemini-cli packages/core/src/output/types.ts: ResultEvent carries
  // status:'success'|'error' and a flat error:{type,message}.
  const result = parseAll(createGeminiParser(), [
    `{"type":"result","timestamp":"2026-08-15T12:34:56.789Z","status":"error","error":{"type":"FatalToolExecutionError","message":"Error executing tool write_file: no space left on device"},"stats":{}}`,
  ]);
  assertLaw("gemini/result", result, {
    count: 1,
    contains: ["no space left on device"],
    fatal: [true],
  });

  console.log("\n[gemini] error events are non-fatal warnings, but still never work");
  const warnings = parseAll(createGeminiParser(), [
    `{"type":"error","timestamp":"2026-08-15T12:34:56.789Z","severity":"error","message":"Maximum session turns exceeded"}`,
    `{"type":"error","timestamp":"2026-08-15T12:34:56.789Z","severity":"warning","message":"Loop detected, stopping execution"}`,
  ]);
  assertLaw("gemini/error", warnings, {
    count: 2,
    contains: ["Maximum session turns exceeded", "Loop detected, stopping execution"],
    fatal: [false, false],
  });

  console.log("\n[gemini] a successful result stays silent, and real output is still work");
  assert(
    createGeminiParser()(`{"type":"result","status":"success","stats":{}}`) === null,
    "gemini: a success result emits nothing",
  );
  const work = parseAll(createGeminiParser(), [
    `{"type":"message","role":"assistant","content":"hello"}`,
  ]);
  assert(workOf(work).length === 1, "gemini: an assistant message still counts as work");
}

// ---------------------------------------------------------------------------
// kimi
// ---------------------------------------------------------------------------

async function testKimi(): Promise<void> {
  console.log("\n[kimi] the retry meta line is the one failure kimi puts on stdout");

  // kimi-code apps/kimi-code/src/cli/prompt-render.ts:209-225. kimi's
  // stream-json writes exactly three line kinds — assistant, tool, and this
  // meta line — so a provider failure that retries is the only harness failure
  // a consumer ever sees. It is not terminal: the next attempt follows.
  const events = parseAll(createKimiParser(), [
    `{"role":"meta","type":"turn.step.retrying","failed_attempt":1,"next_attempt":2,"max_attempts":5,"delay_ms":1000,"error_name":"APIConnectionError","error_message":"Connection error.","status_code":null}`,
  ]);
  assertLaw("kimi", events, { count: 1, contains: ["Connection error."], fatal: [false] });

  console.log("\n[kimi] our own metadata lines are still skipped");
  const parse = createKimiParser();
  assert(parse(`{"_meta":{"harness":"kimi"}}`) === null, "kimi: _meta lines stay skipped");
  assert(parse(`{"_prompt":"hi"}`) === null, "kimi: _prompt lines stay skipped");

  console.log("\n[kimi] a tool failure is still a tool failure, not a harness failure");
  const toolRun = parseAll(createKimiParser(), [
    `{"role":"assistant","tool_calls":[{"type":"function","id":"c1","function":{"name":"Bash","arguments":"{}"}}]}`,
    `{"role":"tool","tool_call_id":"c1","content":"<system>ERROR: command not found</system>"}`,
  ]);
  assert(errorsOf(toolRun).length === 0, "kimi: a failing TOOL is not a harness failure");
  assert(
    toolRun.some((e) => e.update.sessionUpdate === "tool_call_update" && e.update.status === "failed"),
    "kimi: the tool failure is still reported as a failed tool_call_update",
  );
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

async function testOpenCode(): Promise<void> {
  console.log("\n[opencode] session errors carry the harness's own words");

  // opencode packages/opencode/src/cli/cmd/run.ts:776-786 — the CLI itself
  // reads error.data.message and falls back to error.name, because data is
  // empty for some named errors (MessageOutputLengthError). We follow the same
  // precedence rather than decorating the two into one string.
  const events = parseAll(createOpenCodeParser(), [
    `{"type":"error","timestamp":1755259496789,"sessionID":"ses_7f3a2b","error":{"name":"ProviderAuthError","data":{"providerID":"anthropic","message":"missing API key"}}}`,
    `{"type":"error","timestamp":1755259496789,"sessionID":"ses_7f3a2b","error":{"name":"MessageOutputLengthError","data":{}}}`,
  ]);
  assertLaw("opencode", events, {
    count: 2,
    contains: ["missing API key", "MessageOutputLengthError"],
    fatal: [false, false],
  });
  assert(events[0]?.sessionId === "ses_7f3a2b", "opencode: keeps the session id");

  console.log("\n[opencode] real output is still work");
  const work = parseAll(createOpenCodeParser(), [
    `{"type":"text","sessionID":"ses_7f3a2b","part":{"type":"text","text":"hello"}}`,
  ]);
  assert(workOf(work).length === 1, "opencode: agent text still counts as work");
}

// ---------------------------------------------------------------------------
// qwen
// ---------------------------------------------------------------------------

async function testQwen(): Promise<void> {
  console.log("\n[qwen] the failed result message");

  // qwen-code packages/sdk-typescript/src/types/protocol.ts:152-170
  // (SDKResultMessageError): subtype error_max_turns | error_during_execution,
  // is_error: true, optional error:{type?,message}.
  const events = parseAll(createQwenParser(), [
    `{"type":"result","subtype":"error_during_execution","uuid":"u1","session_id":"qwen-1","is_error":true,"duration_ms":1200,"duration_api_ms":900,"num_turns":1,"permission_denials":[],"error":{"type":"ApiError","message":"429 Too Many Requests"}}`,
  ]);
  assertLaw("qwen", events, { count: 1, contains: ["429 Too Many Requests"], fatal: [true] });
  assert(events[0]?.sessionId === "qwen-1", "qwen: keeps the session id");

  console.log("\n[qwen] a failure without an error object still says something");
  const bare = errorsOf(parseAll(createQwenParser(), [
    `{"type":"result","subtype":"error_max_turns","uuid":"u2","session_id":"qwen-2","is_error":true,"num_turns":9}`,
  ]));
  assert(bare.length === 1, "qwen: surfaced even with no error object");
  assert((bare[0]?.message ?? "").includes("error_max_turns"), "qwen: falls back to the harness's own subtype");

  console.log("\n[qwen] a successful result stays silent");
  assert(
    createQwenParser()(`{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"q"}`) === null,
    "qwen: a success result emits nothing",
  );
}

// ---------------------------------------------------------------------------
// The cross-harness invariant
// ---------------------------------------------------------------------------

async function testNoHarnessFoldsAFailureIntoAMessage(): Promise<void> {
  console.log("\n[all] no harness turns its own failure into agent work");

  const cases: Array<{ name: string; parse: Parse; lines: string[] }> = [
    {
      name: "claude",
      parse: createClaudeParser(),
      lines: [`{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["boom"],"session_id":"s"}`],
    },
    {
      name: "codex",
      parse: createCodexParser(),
      lines: [`{"type":"turn.failed","error":{"message":"boom"}}`],
    },
    {
      name: "droid",
      parse: createDroidParser(),
      lines: [`{"type":"error","source":"agent_loop","message":"boom","session_id":"s"}`],
    },
    {
      name: "gemini",
      parse: createGeminiParser(),
      lines: [`{"type":"result","status":"error","error":{"type":"FatalError","message":"boom"}}`],
    },
    {
      name: "kimi",
      parse: createKimiParser(),
      lines: [`{"role":"meta","type":"turn.step.retrying","failed_attempt":1,"next_attempt":2,"max_attempts":5,"delay_ms":1,"error_name":"E","error_message":"boom"}`],
    },
    {
      name: "opencode",
      parse: createOpenCodeParser(),
      lines: [`{"type":"error","sessionID":"s","error":{"name":"UnknownError","data":{"message":"boom"}}}`],
    },
    {
      name: "qwen",
      parse: createQwenParser(),
      lines: [`{"type":"result","subtype":"error_during_execution","session_id":"s","is_error":true,"error":{"message":"boom"}}`],
    },
  ];

  for (const { name, parse, lines } of cases) {
    const events = parseAll(parse, lines);
    assert(events.length > 0, `${name}: the failure is not dropped`);
    assert(errorsOf(events).length === 1, `${name}: it is the error variant`);
    assert(workOf(events).length === 0, `${name}: it is NOT counted as agent work`);
    assert(errorsOf(events)[0]?.message === "boom", `${name}: the message is exactly what the harness said`);
  }

  assert(cases.length === 7, "all seven harnesses are covered");
}

async function testMalformedFailuresDegradeInsteadOfVanishing(): Promise<void> {
  console.log("\n[all] a failure that arrives with no text still surfaces");

  // Swallowing a malformed failure is the same blindness as swallowing a
  // well-formed one, so every parser dumps the raw line rather than returning
  // null. codex already held this (codex-parser-errors.test.ts); these are the
  // harnesses that used to drop or decorate instead.
  const cases: Array<{ name: string; parse: Parse; line: string }> = [
    { name: "droid", parse: createDroidParser(), line: `{"type":"error","session_id":"s"}` },
    { name: "gemini", parse: createGeminiParser(), line: `{"type":"error","severity":"error"}` },
    { name: "gemini/result", parse: createGeminiParser(), line: `{"type":"result","status":"error"}` },
    { name: "opencode", parse: createOpenCodeParser(), line: `{"type":"error","sessionID":"s","error":{}}` },
  ];

  for (const { name, parse, line } of cases) {
    const errors = errorsOf(parseAll(parse, [line]));
    assert(errors.length === 1, `${name}: a message-less failure is still surfaced`);
    assert((errors[0]?.message ?? "").length > 0, `${name}: its message is a raw dump, never an empty string`);
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("THE HARNESS-ERROR LAW — all seven parsers");
  console.log("=".repeat(60));

  await testClaude();
  await testCodex();
  await testDroid();
  await testGemini();
  await testKimi();
  await testOpenCode();
  await testQwen();
  await testNoHarnessFoldsAFailureIntoAMessage();
  await testMalformedFailuresDegradeInsteadOfVanishing();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
