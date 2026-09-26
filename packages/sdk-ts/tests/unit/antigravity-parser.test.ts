#!/usr/bin/env tsx
/**
 * Unit Test: Antigravity Parser
 *
 * Every fixture line below is a LIVE line from agy 1.2.11 `--output-format
 * stream-json` against the Evolve gateway (team recon 2026-09-25, rounds 1
 * and 2; the gateway host is spelled <EVOLVE_GATEWAY_HOST>, the init tool
 * list shortened to the tools the runs used). The parser is held to what the
 * CLI actually printed: tool use, MCP, skills, sub-agents, model error, tool
 * error, cancellation, the json envelope, a resumed conversation — and the
 * pass-through of anything it does not know.
 */

import { createAntigravityParser, antigravityTokenUsage } from "../../src/parsers/antigravity.ts";
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

function textOf(update: SessionUpdate): string {
  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
    return update.content.type === "text" ? update.content.text : "";
  }
  if (update.sessionUpdate === "tool_call_update") {
    return (update.content ?? [])
      .map((c) => (c.type === "content" && c.content.type === "text" ? c.content.text : ""))
      .join("");
  }
  return "";
}

const CID = "93f3c9f6-a7cc-4e73-bb8c-4fda4b3abdd8";
const INIT = `{"event":"init","conversation_id":"${CID}","init":{"model":"gemini-3.8-flash-low","cwd":"/work","tools":["call_mcp_tool","invoke_subagent","run_command","view_file","write_to_file"],"permission_mode":"always-proceed"}}`;

// Round 1, T2: write a file, cat it — two tools, three model calls.
const T2 = [
  INIT,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":2.122805,"usage":{"input_tokens":12581,"output_tokens":350,"thinking_tokens":212,"cache_read_tokens":0,"total_tokens":12931}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/work/hello.txt"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_to_file","duration_seconds":0.027438,"tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/work/hello.txt"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":3,"state":"DONE","step_type":"agent_response","duration_seconds":1.363672,"usage":{"input_tokens":13194,"output_tokens":198,"thinking_tokens":67,"cache_read_tokens":0,"total_tokens":13392}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"cat hello.txt"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.030596,"tool_info":{"name":"run_command","parameters":{"CommandLine":"cat hello.txt"},"output":"hello from antigravity\\r\\n"}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":5,"state":"ACTIVE","step_type":"agent_response","text_delta":"Created [hel"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":5,"state":"ACTIVE","step_type":"agent_response","text_delta":"lo.txt](file:///work/hello.txt) with the requested line.\\n\\nCon"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":5,"state":"DONE","step_type":"agent_response","text_delta":"tents:\\n\`\`\`text\\nhello from antigravity\\n\`\`\`\\n","duration_seconds":1.071714,"usage":{"input_tokens":13482,"output_tokens":99,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":13581}}}`,
  `{"event":"result","result":{"conversation_id":"${CID}","status":"SUCCESS","response":"Created [hello.txt](file:///work/hello.txt) with the requested line.\\n\\nContents:\\n\`\`\`text\\nhello from antigravity\\n\`\`\`\\n","duration_seconds":4.6340900000000005,"num_turns":1,"usage":{"input_tokens":39257,"output_tokens":647,"thinking_tokens":279,"cache_read_tokens":0,"total_tokens":39904}}}`,
];

async function testToolUseRun(): Promise<void> {
  console.log("\n[1] T2 live: tools, per-call usage, the final text once, the run total");
  const events = parseAll(createAntigravityParser(), T2);

  assert(events.every((e) => e.sessionId === CID), "every event carries the conversation id as sessionId");
  assert(events.every((e) => e.model === "gemini-3.8-flash-low"), "the init model is stamped on every later event");
  assert(events.every((e) => e.timestamp === undefined), "no timestamp: agy stamps none on the wire");

  const calls = ofKind(events, "tool_call");
  const results = ofKind(events, "tool_call_update");
  assert(calls.length === 2, "two tool calls (write_to_file, run_command)");
  assert(results.length === 2, "two tool results, one per DONE update");
  assert(calls[0]?.update.toolName === "write_to_file" && calls[0].update.kind === "edit", "write_to_file: verbatim name, kind edit");
  assert(same(calls[0]?.update.locations, [{ path: "/work/hello.txt" }]), "write_to_file: TargetFile is the location");
  assert(same(calls[0]?.update.rawInput, { TargetFile: "/work/hello.txt" }), "write_to_file: parameters ride rawInput verbatim");
  assert(calls[0]?.update.toolCallId === `${CID}:2`, "the tool call id is conversation:step_index (agy prints no call ids)");
  assert(results[0]?.update.toolCallId === calls[0]?.update.toolCallId, "ACTIVE and DONE of one step pair on the same id");
  assert(results[0]?.update.status === "completed" && textOf(results[0].update) === "", "write_to_file DONE without output: completed, no text");
  assert(calls[1]?.update.title === "`cat hello.txt`" && calls[1].update.kind === "execute", "run_command: the command line is the title, kind execute");
  assert(textOf(results[1]!.update) === "hello from antigravity\r\n", "run_command output rides the result verbatim");
  assert(same(results[1]?.update.rawOutput, { name: "run_command", parameters: { CommandLine: "cat hello.txt" }, output: "hello from antigravity\r\n" }), "tool_info rides rawOutput verbatim");

  const text = ofKind(events, "agent_message_chunk").map((e) => textOf(e.update)).join("");
  assert(text === "Created [hello.txt](file:///work/hello.txt) with the requested line.\n\nContents:\n```text\nhello from antigravity\n```\n", "the text deltas concatenate to the response");
  assert(ofKind(events, "agent_message_chunk").length === 3, "the result's response is NOT published a second time");

  const usage = ofKind(events, "usage");
  assert(usage.filter((u) => u.update.scope === "call").length === 3, "three model calls → three per-call usage lines");
  assert(same(usage[0]?.update.usage, { promptTokens: 12581, completionTokens: 350, cachedTokens: 0, extra: { thinking_tokens: 212, total_tokens: 12931 } }), "per-call: input+cache_read → prompt, output → completion, thinking/total ride extra");
  assert(usage[0]?.messageId === `${CID}:1`, "a per-call usage line names its step as the message id");
  const finalStep = events.filter((e) => e.messageId === `${CID}:5`);
  assert(finalStep.length === 4 && finalStep[3].update.sessionUpdate === "usage", "the streamed step's deltas and its usage share one message id");
  const run = usage.filter((u) => u.update.scope === "run");
  assert(run.length === 1 && run[0].update.usage.promptTokens === 39257 && run[0].update.usage.completionTokens === 647, "result.usage → one run-scoped line with the conversation total");
  assert(ofKind(events, "error").length === 0, "SUCCESS: no error event");
  assert(same(run[0]?.extra, { status: "SUCCESS", num_turns: 1, duration_seconds: 4.6340900000000005 }), "the result's own facts ride extra");
  assert(same(calls[1]?.extra, { step_index: 4, step_type: "tool", state: "ACTIVE" }), "a step's index, type and state ride extra");
}

async function testMcpAndSkill(): Promise<void> {
  console.log("\n[2] M1 live: MCP is one generic tool; S1: a skill is a view_file, no event of its own");
  const cid = "ead540bb-a4d2-4694-ab6a-bda79c4a2ef3";
  const events = parseAll(createAntigravityParser(), [
    `{"event":"init","conversation_id":"${cid}","init":{"model":"gemini-3.5-flash-lite","cwd":"/work","tools":["call_mcp_tool","view_file"],"permission_mode":"always-proceed"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${cid}","step_index":6,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/work/.agents/skills/secret-handshake/SKILL.md"}}}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${cid}","step_index":6,"state":"DONE","step_type":"tool","tool_name":"view_file","duration_seconds":0.013422,"tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/work/.agents/skills/secret-handshake/SKILL.md"},"output":"7 lines, 139 bytes"}}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${cid}","step_index":10,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{"a":40,"b":2},"ServerName":"everything","ToolName":"get-sum"}}}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${cid}","step_index":10,"state":"DONE","step_type":"tool","tool_name":"call_mcp_tool","duration_seconds":0.017179,"tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{"a":40,"b":2},"ServerName":"everything","ToolName":"get-sum"},"output":"The sum of 40 and 2 is 42."}}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${cid}","step_index":11,"state":"DONE","step_type":"agent_response","text_delta":"42\\n","duration_seconds":1.190264,"usage":{"input_tokens":4915,"output_tokens":116,"thinking_tokens":114,"cache_read_tokens":12254,"total_tokens":5031}}}`,
    `{"event":"result","result":{"conversation_id":"${cid}","status":"SUCCESS","response":"42\\n","duration_seconds":9.434901,"num_turns":1,"usage":{"input_tokens":81010,"output_tokens":1494,"thinking_tokens":776,"cache_read_tokens":12254,"total_tokens":82504}}}`,
  ]);
  const calls = ofKind(events, "tool_call");
  assert(calls[0]?.update.toolName === "view_file" && calls[0].update.kind === "read" && calls[0].update.title === "view_file /work/.agents/skills/secret-handshake/SKILL.md", "a skill read is a plain view_file with the path in the title");
  assert(calls[1]?.update.toolName === "call_mcp_tool", "MCP: the tool name is the CLI's generic call_mcp_tool, verbatim");
  assert(calls[1]?.update.title === "call_mcp_tool everything/get-sum", "MCP: server and tool name from the parameters form the title");
  assert(calls[1]?.update.kind === "other", "MCP: kind other");
  assert(same(calls[1]?.update.rawInput, { Arguments: { a: 40, b: 2 }, ServerName: "everything", ToolName: "get-sum" }), "MCP: ServerName/ToolName/Arguments ride rawInput");
  const mcpResult = ofKind(events, "tool_call_update")[1];
  assert(textOf(mcpResult!.update) === "The sum of 40 and 2 is 42.", "MCP: the string output rides the result");
  const call = ofKind(events, "usage").find((u) => u.update.scope === "call");
  assert(same(call?.update.usage, { promptTokens: 4915 + 12254, completionTokens: 116, cachedTokens: 12254, extra: { thinking_tokens: 114, total_tokens: 5031 } }), "cache_read_tokens (disjoint from input on the wire) is added into prompt and reported as cached");
}

async function testSubagent(): Promise<void> {
  console.log("\n[3] F-U1 live: an undocumented `subagent` step is a delegating tool call");
  const cid = "e118991e-106b-4c2a-a933-9a4a197fdb47";
  const child = "16784662-4150-473b-a1b9-b9a909974e8d";
  const events = parseAll(createAntigravityParser(), [
    `{"event":"init","conversation_id":"${cid}","init":{"model":"gemini-3.5-flash-lite","cwd":"/work","tools":["invoke_subagent"],"permission_mode":"always-proceed"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${cid}","step_index":2,"state":"ACTIVE","step_type":"subagent","tool_name":"invoke_subagent","subagent_info":{"subagents":[{"type_name":"ponger","role":"Ponger Subagent","initial_prompt":"Reply with the word PONG","conversation_id":"${child}","log_uri":"file:///home/.gemini/antigravity-cli/brain/${child}/.system_generated/logs/transcript.jsonl","workspace_uris":["file:///work"]}]}}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${cid}","step_index":2,"state":"DONE","step_type":"subagent","tool_name":"invoke_subagent","duration_seconds":0.021223,"subagent_info":{"subagents":[{"type_name":"ponger","role":"Ponger Subagent","initial_prompt":"Reply with the word PONG","conversation_id":"${child}","log_uri":"file:///home/.gemini/antigravity-cli/brain/${child}/.system_generated/logs/transcript.jsonl","workspace_uris":["file:///work"]}]}}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${cid}","step_index":7,"state":"DONE","step_type":"system_message","duration_seconds":0.000151}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${cid}","step_index":8,"state":"DONE","step_type":"agent_response","text_delta":"The \`ponger\` sub-agent was successfully delegated the task and returned: **PONG**.\\n","duration_seconds":1.051267,"usage":{"input_tokens":15935,"output_tokens":108,"thinking_tokens":88,"cache_read_tokens":0,"total_tokens":16043}}}`,
  ]);
  const call = ofKind(events, "tool_call")[0];
  assert(call?.update.toolName === "invoke_subagent" && call.update.kind === "think", "invoke_subagent: verbatim name, kind think");
  assert(call?.update.title === "invoke_subagent ponger", "the sub-agent type names form the title");
  assert((call?.update.rawInput as { subagents: unknown[] }).subagents.length === 1, "subagent_info rides rawInput");
  const result = ofKind(events, "tool_call_update")[0];
  assert(result?.update.status === "completed", "the DONE update completes the call");
  assert(textOf(result!.update) === `ponger: conversation ${child}`, "the child conversation id is named in the result text");
  assert((result?.update.rawOutput as { subagents: Array<{ conversation_id: string }> }).subagents[0].conversation_id === child, "subagent_info (with the child's conversation and log_uri) rides rawOutput");
  assert(events.every((e) => e.parentToolCallId === undefined), "the child's steps never appear in the parent stream, so no line is a subagent's");
  assert(events.filter((e) => e.extra?.step_type === "system_message").length === 0, "system_message (content only in the transcript) produces no event");
}

async function testModelErrorPaths(): Promise<void> {
  console.log("\n[4] E1a/E1b/E3 live: model failure, exhausted retries under --print-timeout, interruption");
  const e1a = parseAll(createAntigravityParser(), [
    `{"event":"init","conversation_id":"eae7b139","init":{"model":"gemini-3.5-flash-lite","cwd":"/work","tools":[],"permission_mode":"always-proceed"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"eae7b139","step_index":0,"state":"DONE","step_type":"user_input"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"eae7b139","step_index":1,"state":"DONE","step_type":"error_message"}}`,
    `{"event":"result","result":{"conversation_id":"eae7b139","status":"ERROR","response":"","error":"agent executor error: generating and executing: Error 500, Message: An internal error has occurred., Status: INTERNAL, Details: []","duration_seconds":0,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}`,
  ]);
  const errors = ofKind(e1a, "error");
  assert(errors.length === 2, "a 500 → the error_message step and the result's error, both error events");
  assert(errors[0]?.update.fatal === false && errors[0].update.message.includes("error_message"), "the step carries no text on the wire: non-fatal, the raw step dumped");
  assert(errors[1]?.update.fatal === true && errors[1].update.message === "agent executor error: generating and executing: Error 500, Message: An internal error has occurred., Status: INTERNAL, Details: []", "result.error is the fatal message, verbatim");
  assert(e1a.every((e) => !isAgentWorkUpdate(e.update)), "a run that never reached the model produced NO work");
  const total = ofKind(e1a, "usage").find((u) => u.update.scope === "run");
  assert(total?.update.usage.promptTokens === 0, "the zero run total still rides beside the error (accounting is never work)");

  const e1b = parseAll(createAntigravityParser(), [
    `{"event":"init","conversation_id":"a5d8585b","init":{"model":"gemini-3.5-flash-lite","cwd":"/work","tools":[],"permission_mode":"always-proceed"}}`,
    ...[1, 2, 3, 4, 5, 6, 7].map((i) => `{"event":"step_update","step_update":{"conversation_id":"a5d8585b","step_index":${i},"state":"DONE","step_type":"error_message","duration_seconds":0}}`),
    `{"event":"result","result":{"conversation_id":"a5d8585b","status":"ERROR","response":"","error":"API error (attempt 7): Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED, Details: []","duration_seconds":91.989384,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}`,
  ]);
  assert(ofKind(e1b, "error").filter((e) => !e.update.fatal).length === 7, "seven 429 retries → seven non-fatal error events");
  assert(ofKind(e1b, "error").filter((e) => e.update.fatal).length === 1, "exit 0 with status ERROR (print timeout) is still ONE fatal error — result.status is the verdict, never the exit code");

  const e3 = parseAll(createAntigravityParser(), [
    `{"event":"init","conversation_id":"6df38991","init":{"model":"gemini-3.5-flash-lite","cwd":"/work","tools":[],"permission_mode":"always-proceed"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"6df38991","step_index":0,"state":"DONE","step_type":"user_input"}}`,
    `{"event":"result","result":{"conversation_id":"6df38991","status":"ERROR","response":"","error":"interrupted","duration_seconds":4.616455,"num_turns":1,"usage":{"input_tokens":13566,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":13566}}}`,
  ]);
  const cancel = ofKind(e3, "error");
  assert(cancel.length === 1 && cancel[0].update.fatal && cancel[0].update.message === "interrupted", "SIGINT: one fatal error, the harness's own word");
  assert(ofKind(e3, "usage")[0]?.update.usage.promptTokens === 13566, "the interrupted run's input tokens still ride the run total");
}

async function testToolFailureAndResume(): Promise<void> {
  console.log("\n[5] E2 live: a failing command reports nothing; T4: a resumed conversation continues its steps");
  const e2 = parseAll(createAntigravityParser(), [
    `{"event":"init","conversation_id":"de61cf54","init":{"model":"gemini-3.5-flash-lite","cwd":"/work","tools":["run_command"],"permission_mode":"always-proceed"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"de61cf54","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"exit 3"}}}}`,
    `{"event":"step_update","step_update":{"conversation_id":"de61cf54","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.013216,"tool_info":{"name":"run_command","parameters":{"CommandLine":"exit 3"}}}}`,
  ]);
  const result = ofKind(e2, "tool_call_update")[0];
  assert(result?.update.status === "completed" && textOf(result.update) === "", "exit 3: the wire carries no output, no error and no exit code — reported as the harness said, completed");
  assert(same(result?.update.rawOutput, { name: "run_command", parameters: { CommandLine: "exit 3" } }), "the bare tool_info rides rawOutput so a reader sees exactly what was sent");

  // Documented, never observed live: tool_info.error { type, message }.
  const documented = parseAll(createAntigravityParser(), [
    `{"event":"step_update","step_update":{"conversation_id":"x","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"false"},"error":{"type":"ExitError","message":"exited 1"}}}}`,
  ]);
  assert(documented.length === 2 && documented[0].update.sessionUpdate === "tool_call" && documented[1].update.sessionUpdate === "tool_call_update", "a DONE with no earlier ACTIVE still opens the call before closing it");
  assert(documented[1].update.sessionUpdate === "tool_call_update" && documented[1].update.status === "failed" && textOf(documented[1].update) === "exited 1", "a documented tool_info.error marks the call failed with its message");

  const t4 = parseAll(createAntigravityParser(), [
    INIT,
    `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":6,"state":"DONE","step_type":"user_input"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":7,"state":"DONE","step_type":"system_message","duration_seconds":0.000151}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":8,"state":"ACTIVE","step_type":"agent_response","text_delta":"hello.txt"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":8,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":4.204044,"usage":{"input_tokens":13793,"output_tokens":810,"thinking_tokens":807,"cache_read_tokens":0,"total_tokens":14603}}}`,
    `{"event":"result","result":{"conversation_id":"${CID}","status":"SUCCESS","response":"hello.txt\\n","duration_seconds":9.738705,"num_turns":2,"usage":{"input_tokens":53050,"output_tokens":1457,"thinking_tokens":1086,"cache_read_tokens":0,"total_tokens":54507}}}`,
  ]);
  assert(ofKind(t4, "agent_message_chunk").map((e) => textOf(e.update)).join("") === "hello.txt\n", "--continue: the second turn's text streams as usual");
  assert(ofKind(t4, "agent_message_chunk")[0]?.messageId === `${CID}:8`, "step indices continue across turns, so the message id stays unique");
  const run = ofKind(t4, "usage").find((u) => u.update.scope === "run");
  assert(run?.update.usage.promptTokens === 53050 && run.extra?.num_turns === 2, "the run total is the CONVERSATION's cumulative usage (num_turns 2), as the wire states it");
}

async function testJsonEnvelopeAndVertex(): Promise<void> {
  console.log("\n[6] T5 live: the --output-format json envelope; V1: Vertex cache reads");
  const envelope = parseAll(createAntigravityParser(), [
    `{"conversation_id":"9e1018d7-4084-4ce4-8b26-8d2ee7d9e182","status":"SUCCESS","response":"OK\\n","duration_seconds":1.047131,"num_turns":1,"usage":{"input_tokens":12570,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":12571}}`,
  ]);
  assert(envelope.length === 2 && envelope[0].update.sessionUpdate === "agent_message_chunk" && textOf(envelope[0].update) === "OK\n", "json envelope: the response is the one text event (nothing streamed before it)");
  assert(envelope[1].update.sessionUpdate === "usage" && envelope[1].update.scope === "run", "json envelope: its usage is the run total");
  assert(envelope.every((e) => e.sessionId === "9e1018d7-4084-4ce4-8b26-8d2ee7d9e182"), "json envelope: conversation_id is the session id");

  const v1 = parseAll(createAntigravityParser(), [
    `{"event":"init","conversation_id":"09c6b3bc","init":{"model":"vertex_ai/gemini-3.5-flash-lite","cwd":"/work","tools":["write_to_file","run_command"],"permission_mode":"always-proceed"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"09c6b3bc","step_index":3,"state":"DONE","step_type":"agent_response","duration_seconds":1.262732,"usage":{"input_tokens":1918,"output_tokens":164,"thinking_tokens":23,"cache_read_tokens":10946,"total_tokens":2082}}}`,
    `{"event":"result","result":{"conversation_id":"09c6b3bc","status":"SUCCESS","response":"done","duration_seconds":6.119383,"num_turns":1,"usage":{"input_tokens":14387,"output_tokens":949,"thinking_tokens":567,"cache_read_tokens":23701,"total_tokens":15336}}}`,
  ]);
  assert(v1[0]?.model === "vertex_ai/gemini-3.5-flash-lite", "the Vertex route slug is the model the init line names");
  const call = ofKind(v1, "usage")[0];
  assert(same(call?.update.usage, { promptTokens: 12864, completionTokens: 164, cachedTokens: 10946, extra: { thinking_tokens: 23, total_tokens: 2082 } }), "Vertex: 1918 input + 10946 cache_read → 12864 prompt, 10946 cached (total_tokens on the wire excludes the cache share)");
  assert(same(antigravityTokenUsage({ input_tokens: 5, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 3, total_tokens: 7 }), { promptTokens: 8, completionTokens: 2, cachedTokens: 3, extra: { thinking_tokens: 1, total_tokens: 7 } }), "antigravityTokenUsage: the arithmetic, in one place");
  assert(antigravityTokenUsage(null) === null && antigravityTokenUsage("x") === null, "no usage object → null, never zeros");
}

async function testUnknownPassthrough(): Promise<void> {
  console.log("\n[7] the closed-source rule: unknown events and step types pass through, never dropped, never work");
  const parser = createAntigravityParser();
  parser(INIT);
  const step = parser(`{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":3,"state":"DONE","step_type":"checkpoint","duration_seconds":0.5,"usage":{"input_tokens":10,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":11}}}`);
  assert(step?.length === 2 && step[0].update.sessionUpdate === "unknown", "a documented-but-unseen step type (checkpoint) is an unknown update");
  assert(step?.[0].update.sessionUpdate === "unknown" && step[0].update.kind === "step_update:checkpoint", "the update names the harness's own word for it");
  assert(step?.[0].update.sessionUpdate === "unknown" && (step[0].update.raw as { step_type: string }).step_type === "checkpoint", "the wire object rides raw, verbatim");
  assert(step?.[1].update.sessionUpdate === "usage" && step[1].update.scope === "call", "its accounting is still kept");
  assert(step?.[0].sessionId === CID && step[0].model === "gemini-3.8-flash-low", "the envelope is stamped like any other line");
  assert(!isAgentWorkUpdate(step?.[0].update), "an unknown update is NOT agent work");

  const event = parser(`{"event":"control_request","control_request":{"kind":"permission"}}`);
  assert(event?.length === 1 && event[0].update.sessionUpdate === "unknown" && event[0].update.kind === "control_request", "an unknown top-level event passes through under its name");

  const stray = parser(`{"hello":"world"}`);
  assert(stray?.length === 1 && stray[0].update.sessionUpdate === "unknown", "a JSON line with no event and no status is still surfaced");
  assert(parser("not json") === null, "a non-JSON line is dropped");
  assert(parser(INIT) === null, "init itself emits nothing (its facts are stamped on later lines)");
  assert(parser(`{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":0,"state":"DONE","step_type":"user_input"}}`) === null, "user_input carries no text on the wire and emits nothing");
}

async function testThinkingDelta(): Promise<void> {
  console.log("\n[8] documented, never observed: thinking_delta is a thought chunk");
  const events = parseAll(createAntigravityParser(), [
    INIT,
    `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":1,"state":"ACTIVE","step_type":"agent_response","thinking_delta":"Let me check"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}`,
  ]);
  assert(events.length === 2 && events[0].update.sessionUpdate === "agent_thought_chunk" && textOf(events[0].update) === "Let me check", "thinking_delta → agent_thought_chunk");
  assert(events[1].update.sessionUpdate === "agent_message_chunk" && events[1].messageId === `${CID}:1`, "the thought and the text of one step share its message id");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Antigravity Parser Unit Tests");
  console.log("=".repeat(60));

  await testToolUseRun();
  await testMcpAndSkill();
  await testSubagent();
  await testModelErrorPaths();
  await testToolFailureAndResume();
  await testJsonEnvelopeAndVertex();
  await testUnknownPassthrough();
  await testThinkingDelta();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
