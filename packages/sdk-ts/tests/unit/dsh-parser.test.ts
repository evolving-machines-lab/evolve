#!/usr/bin/env tsx
/**
 * Unit Test: dsh Parser
 *
 * Validates the DeepSeek Harness `--profile headless --json` parser against
 * the live captures of @deepseek-ai/dsh@0.1.7-rc.2 against the Evolve gateway
 * (team/dev-items/harness-recon-2026-09-25/06-live-tests/dsh, rounds 1 and 2,
 * 2026-09-25). Every fixture line below is a captured line verbatim except the
 * working directory, shortened to /work, and the `<gateway-host>` placeholders
 * the captures already carry. Runs named: T1 (one-shot text), T2 (write +
 * bash tool use, resume seed), M1 (MCP), S1 (skill), U1 (sub-agent), E1
 * (model error after retries), E2/E2b (tool exit code vs tool failure), E3/E3b
 * (SIGINT), T7b (auth failure), R2 (openrouter v4-pro: blank text blocks).
 */

import { createDshParser } from "../../src/parsers/dsh.ts";
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

// ---------------------------------------------------------------------------
// Fixtures (live captures)
// ---------------------------------------------------------------------------

const SESSION_T1 = `{"type":"session","sessionId":"session-1daaa9ed-3f72-4002-90ce-b2fd02035153","cwd":"/work"}`;

/** T1: "Reply with exactly the word OK and nothing else." — exit 0. */
const T1 = [
  SESSION_T1,
  `{"type":"status","phase":"turn_start","turn":1}`,
  `{"type":"status","phase":"step_start","turn":1,"step":1}`,
  `{"type":"text","text":"OK"}`,
  `{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":5569,"outputTokens":3,"totalTokens":5572}}`,
  `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}`,
  `{"type":"final","text":"OK"}`,
];

/** T2: create hello.txt then cat it — three steps, write + bash, cache reads. Exit 0. */
const T2 = [
  `{"type":"session","sessionId":"session-fab655c4-d085-41e0-adf5-11880872873c","cwd":"/work"}`,
  `{"type":"status","phase":"turn_start","turn":1}`,
  `{"type":"status","phase":"step_start","turn":1,"step":1}`,
  `{"type":"thinking","text":"Simple task. Create file with write tool, then read/print."}`,
  `{"type":"tool_call","callId":"call_8f1b268a3e504b39bb2aa64d","tool":"write","input":{"file_path":"hello.txt","content":"hello from dsh"}}`,
  `{"type":"tool_result","callId":"call_8f1b268a3e504b39bb2aa64d","status":"completed","result":"<path>/work/hello.txt</path>\\n<type>file</type>\\n<content>\\nCreated file\\n</content>"}`,
  `{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":210,"outputTokens":74,"totalTokens":5660,"cacheReadTokens":5376}}`,
  `{"type":"status","phase":"step_start","turn":1,"step":2}`,
  `{"type":"tool_call","callId":"call_3a1738ec48f24992806af73d","tool":"bash","input":{"command":"cat hello.txt","description":"Print file contents"}}`,
  `{"type":"tool_result","callId":"call_3a1738ec48f24992806af73d","status":"completed","result":"hello from dsh"}`,
  `{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":115,"outputTokens":58,"totalTokens":5805,"cacheReadTokens":5632}}`,
  `{"type":"status","phase":"step_start","turn":1,"step":3}`,
  `{"type":"text","text":"Created \`hello.txt\` with the single line:\\n\\n\`\`\`\\nhello from dsh\\n\`\`\`\\n\\nPrinted via \`cat hello.txt\` — output matches exactly."}`,
  `{"type":"status","phase":"step_end","turn":1,"step":3,"usage":{"inputTokens":188,"outputTokens":31,"totalTokens":5851,"cacheReadTokens":5632}}`,
  `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}`,
  `{"type":"final","text":"Created \`hello.txt\` with the single line:\\n\\n\`\`\`\\nhello from dsh\\n\`\`\`\\n\\nPrinted via \`cat hello.txt\` — output matches exactly."}`,
];

/** M1 (round 2): MCP tools of the `everything` server — the `mcp__<server>__<tool>` names. */
const M1_MCP_CALL = `{"type":"tool_call","callId":"call_79ade2c3f6a148beb9ff8322","tool":"mcp__everything__get-sum","input":{"a":40,"b":2}}`;
const M1_MCP_RESULT = `{"type":"tool_result","callId":"call_79ade2c3f6a148beb9ff8322","status":"completed","result":"The sum of 40 and 2 is 42."}`;
const M1_LIST_RESOURCES = `{"type":"tool_call","callId":"call_4004f149eeee40f8a8940501","tool":"list_mcp_resources","input":{"server":"everything"}}`;

/** S1 (round 2): the `skill` tool loading $DSH_HOME/skills/secret-handshake. */
const S1_SKILL_CALL = `{"type":"tool_call","callId":"call_35774629eb3f48e988565bbc","tool":"skill","input":{"name":"secret-handshake"}}`;
const S1_SKILL_RESULT = `{"type":"tool_result","callId":"call_35774629eb3f48e988565bbc","status":"completed","result":"<skill_content name=\\"secret-handshake\\">\\n<skill_resources>\\nBase directory for this skill: /work/home/.dsh/skills/secret-handshake\\nResolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.\\n</skill_resources>\\n\\n<skill_instructions>\\nWhen asked for the handshake, answer exactly: HANDSHAKE-7431\\n</skill_instructions>\\n</skill_content>"}`;

/** U1 (round 2): the in-process `subagent` tool; the child's lines never reach the parent's stream. */
const U1_SUBAGENT_CALL = `{"type":"tool_call","callId":"call_3f698336521548b49279f885","tool":"subagent","input":{"description":"Reply with PONG","prompt":"Reply with exactly the single word: PONG. Do not add any other text, punctuation, or explanation.","run_in_background":false}}`;
const U1_SUBAGENT_RESULT = `{"type":"tool_result","callId":"call_3f698336521548b49279f885","status":"completed","result":"PONG"}`;

/** E1 (round 2): the gateway answered 429 then 500 on all 1 + 5 retries — exit 1. */
const E1 = [
  `{"type":"session","sessionId":"session-b28c98d6-8415-4639-a300-ca955901ecf6","cwd":"/work"}`,
  `{"type":"status","phase":"turn_start","turn":1}`,
  `{"type":"status","phase":"step_start","turn":1,"step":1}`,
  `{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":0,"outputTokens":0,"totalTokens":0}}`,
  `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"500: {\\"message\\":\\"sink: internal error (request 6)\\",\\"type\\":\\"server_error\\",\\"code\\":\\"internal_error\\"}","code":"SERVER"}}}`,
  `{"type":"final","text":""}`,
];

/** T7b: the native route against a recorder that answered 401 — the error's `status` field. */
const T7B_TURN_END = `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"recorder: no model behind this endpoint","code":"AUTH","status":401}}}`;

/** E2 (round 2): `exit 3` is a COMPLETED tool result with the code in the text. */
const E2_RESULT = `{"type":"tool_result","callId":"call_9b348ef0bd2c4c63830d02d5","status":"completed","result":"(no output)\\n[exit code: 3]"}`;
/** E2b (round 2): a missing file is the tool failing. */
const E2B_RESULT = `{"type":"tool_result","callId":"call_5b74a9d71be843c6870bd1dc","status":"error","result":"Error: cannot read \\"/nonexistent-dir-7431/missing.txt\\": not found"}`;

/** E3 (round 2): SIGINT at 5 s while the model streamed — `final` carries text no `text` line did; exit 130. */
const E3 = [
  `{"type":"session","sessionId":"session-57f9e315-5aad-4104-90c8-f24247dcf2e8","cwd":"/work"}`,
  `{"type":"status","phase":"turn_start","turn":1}`,
  `{"type":"status","phase":"step_start","turn":1,"step":1}`,
  `{"type":"final","text":"I'll run that as a background job since it takes ~200 seconds.\\n\\n"}`,
];

/** R2 (round 2, openrouter v4-pro): a blank text block precedes each tool call. */
const R2_BLANK_TEXT = `{"type":"text","text":"\\n\\n"}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testOneShotText(): Promise<void> {
  console.log("\n[1] T1: a one-shot answer — text, one call-scoped usage, no lifecycle noise");
  const events = parseAll(createDshParser(), T1);
  const kinds = events.map((e) => e.update.sessionUpdate);
  assert(same(kinds, ["harness_event", "agent_message_chunk", "usage"]), `emits the session fact, text, then usage (got ${kinds.join(", ")})`);
  assert(events.every((e) => e.sessionId === "session-1daaa9ed-3f72-4002-90ce-b2fd02035153"), "the session line's id is stamped on every event, its own included");
  const opening = ofKind(events, "harness_event")[0];
  assert(
    opening?.update.type === "session" && same(opening.update.payload, { sessionId: "session-1daaa9ed-3f72-4002-90ce-b2fd02035153", cwd: "/work" }),
    "the opening session line rides as harness_event {type: session, payload: its other fields verbatim}",
  );
  assert(events.filter((e) => isAgentWorkUpdate(e.update)).length === 1, "only the text is agent work — the session fact and the usage are not");
  const text = ofKind(events, "agent_message_chunk")[0];
  assert(text?.update.content.type === "text" && text.update.content.text === "OK", "the text block rides verbatim");
  const usage = ofKind(events, "usage")[0];
  assert(usage?.update.scope === "call", "step_end usage is call-scoped (one step = one model call)");
  assert(
    same(usage?.update.usage, { promptTokens: 5569, completionTokens: 3, extra: { totalTokens: 5572 } }),
    "no cache counters: prompt = inputTokens, totalTokens rides extra verbatim",
  );
  assert(same(usage?.extra, { turn: 1, step: 1 }), "the step's turn and step ride the envelope extra");
  assert(events.every((e) => e.timestamp === undefined && e.model === undefined && e.messageId === undefined), "no clock, model or message id: dsh prints none");
  assert(ofKind(events, "error").length === 0, "a completed turn_end is not an error");
}

async function testToolUseRun(): Promise<void> {
  console.log("\n[2] T2: write + bash — tool_call/tool_call_update pairs, diff content, cache arithmetic, final dedup");
  const events = parseAll(createDshParser(), T2);
  const calls = ofKind(events, "tool_call");
  const results = ofKind(events, "tool_call_update");
  assert(calls.length === 2 && results.length === 2, "two tool calls, two results");

  const write = calls[0]?.update;
  assert(write?.toolCallId === "call_8f1b268a3e504b39bb2aa64d", "tool_call carries dsh's callId");
  assert(write?.toolName === "write" && write.kind === "edit" && write.status === "pending", "write → toolName verbatim, kind edit, pending");
  assert(write?.title === "write hello.txt", "the title names the tool and the path");
  assert(same(write?.rawInput, { file_path: "hello.txt", content: "hello from dsh" }), "rawInput is the parsed input object verbatim");
  assert(same(write?.locations, [{ path: "hello.txt" }]), "write names its location");
  assert(same(write?.content, [{ type: "diff", path: "hello.txt", oldText: null, newText: "hello from dsh" }]), "write yields a new-file diff");

  const bash = calls[1]?.update;
  assert(bash?.toolName === "bash" && bash.kind === "execute" && bash.title === "bash cat hello.txt", "bash → kind execute, command in the title");
  assert(same(bash?.content, [{ type: "content", content: { type: "text", text: "Print file contents" } }]), "bash content is the model's description");

  assert(results[0]?.update.toolCallId === write?.toolCallId && results[0]?.update.status === "completed", "the write result matches its call and is completed");
  assert(
    results[1]?.update.content?.[0]?.type === "content" && results[1].update.content[0].content.type === "text" && results[1].update.content[0].content.text === "hello from dsh",
    "the result text rides verbatim",
  );
  assert(results[0]?.update.rawOutput === undefined, "dsh's tool_result carries no structured record beyond the text — no rawOutput");

  const usage = ofKind(events, "usage");
  assert(usage.length === 3, "one usage per step");
  assert(
    same(usage[0]?.update.usage, { promptTokens: 5586, completionTokens: 74, cachedTokens: 5376, extra: { totalTokens: 5660 } }),
    "prompt = inputTokens + cacheReadTokens (210 + 5376), cached = cacheReadTokens, total in extra",
  );

  const thoughts = ofKind(events, "agent_thought_chunk");
  assert(thoughts.length === 1 && thoughts[0].update.content.type === "text" && thoughts[0].update.content.text.startsWith("Simple task."), "thinking → agent_thought_chunk");
  const texts = ofKind(events, "agent_message_chunk");
  assert(texts.length === 1, "the final line repeats the last text block and is NOT emitted twice");
}

async function testMcpSkillSubagent(): Promise<void> {
  console.log("\n[3] M1/S1/U1: MCP, skill and sub-agent calls keep their native names");
  const parser = createDshParser();
  parser(SESSION_T1);
  const mcp = parser(M1_MCP_CALL)?.[0]?.update;
  assert(mcp?.sessionUpdate === "tool_call" && mcp.toolName === "mcp__everything__get-sum" && mcp.kind === "other", "an MCP tool keeps its mcp__<server>__<tool> name, kind other");
  assert(mcp?.sessionUpdate === "tool_call" && mcp.title === "mcp__everything__get-sum", "an MCP call with no path/command is titled by name alone");
  const mcpResult = parser(M1_MCP_RESULT)?.[0]?.update;
  assert(mcpResult?.sessionUpdate === "tool_call_update" && mcpResult.status === "completed", "the MCP result is an ordinary tool_call_update");
  const list = parser(M1_LIST_RESOURCES)?.[0]?.update;
  assert(list?.sessionUpdate === "tool_call" && list.toolName === "list_mcp_resources" && list.kind === "other", "dsh's own MCP resource tools are named verbatim");

  const skill = parser(S1_SKILL_CALL)?.[0]?.update;
  assert(skill?.sessionUpdate === "tool_call" && skill.toolName === "skill" && skill.title === "skill secret-handshake", "the skill tool is titled with the skill name");
  const skillResult = parser(S1_SKILL_RESULT)?.[0]?.update;
  assert(
    skillResult?.sessionUpdate === "tool_call_update" &&
      skillResult.content?.[0]?.type === "content" &&
      skillResult.content[0].content.type === "text" &&
      skillResult.content[0].content.text.includes("HANDSHAKE-7431"),
    "the skill's content rides as the result text",
  );

  const sub = parser(U1_SUBAGENT_CALL)?.[0]?.update;
  assert(sub?.sessionUpdate === "tool_call" && sub.toolName === "subagent" && sub.kind === "think", "subagent → kind think");
  assert(
    sub?.sessionUpdate === "tool_call" && same(sub.content, [{ type: "content", content: { type: "text", text: "Reply with PONG" } }]),
    "the sub-agent's description is the call's content",
  );
  const subResult = parser(U1_SUBAGENT_RESULT)?.[0];
  assert(subResult?.update.sessionUpdate === "tool_call_update" && subResult.parentToolCallId === undefined, "the child's answer is the parent's tool result; no subagent lines exist on this stream");
}

async function testModelError(): Promise<void> {
  console.log("\n[4] E1: a model failure after retries — the error variant, never work");
  const events = parseAll(createDshParser(), E1);
  const errors = ofKind(events, "error");
  assert(errors.length === 1, "turn_end kind error → exactly one error event");
  assert(
    errors[0]?.update.message === `500: {"message":"sink: internal error (request 6)","type":"server_error","code":"internal_error"}`,
    "the message is dsh's own text verbatim",
  );
  assert(errors[0]?.update.fatal === true, "a turn_end is terminal — fatal");
  assert(same(errors[0]?.extra, { turn: 1, kind: "error", code: "SERVER" }), "the kind and dsh's error code ride extra");
  assert(events.filter((e) => isAgentWorkUpdate(e.update)).length === 0, "nothing in a fully failed run counts as agent work");
  const usage = ofKind(events, "usage");
  assert(usage.length === 1 && same(usage[0].update.usage, { promptTokens: 0, completionTokens: 0, extra: { totalTokens: 0 } }), "the all-zero step_end usage is what dsh said — recorded, not invented");

  const withStatus = parseAll(createDshParser(), [T7B_TURN_END]);
  assert(same(ofKind(withStatus, "error")[0]?.extra, { turn: 1, kind: "error", code: "AUTH", status: 401 }), "an HTTP status on the error rides extra too");

  const maxTokens = parseAll(createDshParser(), [`{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"max-tokens"}}`]);
  assert(
    ofKind(maxTokens, "error").length === 1 && ofKind(maxTokens, "error")[0].update.message === `{"kind":"max-tokens"}`,
    "a non-completed kind with no text still surfaces — the reason dumped, never blank",
  );
  const aborted = parseAll(createDshParser(), [`{"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"aborted","reason":"budget"}}`]);
  assert(ofKind(aborted, "error")[0]?.update.message === "budget", "an abort's own reason is the message");

  const driver = parseAll(createDshParser(), [`{"type":"error","message":"usage: task required"}`]);
  assert(ofKind(driver, "error").length === 1 && ofKind(driver, "error")[0].update.fatal === true && ofKind(driver, "error")[0].update.message === "usage: task required", "a top-level error line is a fatal error with its message");
}

async function testToolFailureShapes(): Promise<void> {
  console.log("\n[5] E2/E2b: a shell exit code is a completed result; a tool failure is failed");
  const parser = createDshParser();
  const exit3 = parser(E2_RESULT)?.[0]?.update;
  assert(exit3?.sessionUpdate === "tool_call_update" && exit3.status === "completed", "`exit 3` comes back completed (the code is in the text, as dsh reports it)");
  const missing = parser(E2B_RESULT)?.[0]?.update;
  assert(missing?.sessionUpdate === "tool_call_update" && missing.status === "failed", "status error → failed");
  assert(
    missing?.sessionUpdate === "tool_call_update" &&
      missing.content?.[0]?.type === "content" &&
      missing.content[0].content.type === "text" &&
      missing.content[0].content.text === `Error: cannot read "/nonexistent-dir-7431/missing.txt": not found`,
    "the failure text rides verbatim, no fence",
  );
}

async function testCancellation(): Promise<void> {
  console.log("\n[6] E3: SIGINT — no turn_end; `final` alone carries the partial answer");
  const events = parseAll(createDshParser(), E3);
  const texts = ofKind(events, "agent_message_chunk");
  assert(texts.length === 1 && texts[0].update.content.type === "text" && texts[0].update.content.text.startsWith("I'll run that as a background job"), "final's text is emitted when no text line carried it");
  assert(ofKind(events, "error").length === 0, "an interrupted stream reports no error of its own (the exit code does)");
  const empty = parseAll(createDshParser(), [`{"type":"final","text":""}`]);
  assert(empty.length === 0, "an empty final says nothing");
}

async function testEdgesAndUnknowns(): Promise<void> {
  console.log("\n[7] edges: blank text blocks, todo plans, truncation, unknown types");
  const blank = parseAll(createDshParser(), [R2_BLANK_TEXT]);
  assert(blank.length === 1 && blank[0].update.sessionUpdate === "agent_message_chunk", "a whitespace-only text block is still the model's output (R2 emits one before each tool call)");

  const todo = parseAll(createDshParser(), [
    `{"type":"tool_call","callId":"c9","tool":"todo_write","input":{"todos":[{"content":"write tests","status":"in_progress"},{"content":"ship","status":"pending"}]}}`,
  ]);
  const plan = ofKind(todo, "plan")[0];
  assert(todo[0]?.update.sessionUpdate === "tool_call" && todo[0].update.toolName === "todo_write", "todo_write is still a tool_call");
  assert(
    same(plan?.update.entries, [
      { content: "write tests", status: "in_progress", priority: "medium" },
      { content: "ship", status: "pending", priority: "medium" },
    ]),
    "todo_write also yields a plan (dsh's schema: content + status, no priority)",
  );

  const edit = parseAll(createDshParser(), [
    `{"type":"tool_call","callId":"c10","tool":"edit","input":{"file_path":"/work/a.ts","old_string":"x = 1","new_string":"x = 2"}}`,
  ])[0]?.update;
  assert(
    edit?.sessionUpdate === "tool_call" && same(edit.content, [{ type: "diff", path: "/work/a.ts", oldText: "x = 1", newText: "x = 2" }]),
    "edit yields a diff from old_string/new_string (dsh's edit schema)",
  );

  const truncated = parseAll(createDshParser(), [`{"type":"text","text":"long…","truncated":true}`]);
  assert(same(truncated[0]?.extra, { truncated: true }), "a cut line's truncated flag rides the envelope extra");

  const rawInput = parseAll(createDshParser(), [`{"type":"tool_call","callId":"c11","tool":"bash","input":"{not json"}`])[0]?.update;
  assert(rawInput?.sessionUpdate === "tool_call" && rawInput.rawInput === "{not json" && rawInput.title === "bash", "an unparseable input string is kept raw");

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const parser = createDshParser();
    const unknown = parser(`{"type":"compaction","summary":"…"}`)?.[0]?.update;
    const again = parser(`{"type":"compaction","summary":"…"}`)?.[0]?.update;
    const phase = parser(`{"type":"status","phase":"turn_paused","turn":1}`)?.[0]?.update;
    assert(
      unknown?.sessionUpdate === "harness_event" && unknown.type === "compaction" && same(unknown.payload, { summary: "…" }),
      "an unknown event type rides as harness_event {type, payload: the other fields verbatim} — never dropped, never a failure",
    );
    assert(again?.sessionUpdate === "harness_event" && !isAgentWorkUpdate(again), "a second unknown line is still passed through and is never work");
    assert(
      phase?.sessionUpdate === "harness_event" && phase.type === "status" && same(phase.payload, { phase: "turn_paused", turn: 1 }),
      "an unknown status phase rides the same way under type status",
    );
    assert(
      warnings.length === 2 && warnings.every((w) => w.startsWith("[dsh parser] unknown ")) && warnings[0].includes('"compaction"') && warnings[1].includes('"turn_paused"'),
      "each unknown type is logged once per parser instance, as [dsh parser] unknown …",
    );
  } finally {
    console.warn = original;
  }

  assert(createDshParser()("not json") === null, "a non-JSON line is skipped");
  assert(createDshParser()("[1,2]") === null, "a non-object line is skipped");
  assert(createDshParser()(`{"type":"status","phase":"step_end","turn":1,"step":1}`) === null, "a step_end without usage says nothing");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("dsh parser — live captures of @deepseek-ai/dsh@0.1.7-rc.2");
  console.log("=".repeat(60));

  await testOneShotText();
  await testToolUseRun();
  await testMcpSkillSubagent();
  await testModelError();
  await testToolFailureShapes();
  await testCancellation();
  await testEdgesAndUnknowns();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
