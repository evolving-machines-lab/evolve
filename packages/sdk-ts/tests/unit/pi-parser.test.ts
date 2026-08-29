/**
 * Unit Test: pi / prime-agent Parser
 *
 * Both CLIs share one event vocabulary, so one parser covers both. Validates:
 * - Session id captured from the header line and attached to later events
 * - Nested assistantMessageEvent deltas -> message / thought chunks
 * - tool_execution_* lifecycle -> tool_call + tool_call_update
 * - Tool kind and location mapping, including prime-agent's ipython tool
 * - Registry wiring for both agent types
 */

import { createPiParser } from "../../src/parsers/pi.ts";
import { createAgentParser } from "../../src/parsers/index.ts";
import type { OutputEvent } from "../../src/parsers/types.ts";

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

function parseLine(
  parse: (line: string) => OutputEvent[] | null,
  line: Record<string, unknown>
): OutputEvent[] | null {
  return parse(JSON.stringify(line));
}

function findUpdate(
  events: OutputEvent[] | null,
  kind: OutputEvent["update"]["sessionUpdate"]
): OutputEvent["update"] | undefined {
  return events?.find((e) => e.update.sessionUpdate === kind)?.update;
}

async function testSessionHeader(): Promise<void> {
  console.log("\n[1] session header is captured, not emitted");

  const parse = createPiParser();
  const headerEvents = parseLine(parse, {
    type: "session",
    version: 3,
    id: "01H0000000000000000000",
    cwd: "/home/user/workspace",
  });

  assert(headerEvents === null, "Header line emits no events");

  const textEvents = parseLine(parse, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  });

  assert(
    textEvents?.[0]?.sessionId === "01H0000000000000000000",
    "Session id from header is attached to later events"
  );
}

async function testAssistantDeltas(): Promise<void> {
  console.log("\n[2] assistant deltas map to chunks");

  const parse = createPiParser();

  const text = findUpdate(
    parseLine(parse, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "part one" },
    }),
    "agent_message_chunk"
  );
  assert(
    text?.sessionUpdate === "agent_message_chunk" &&
      text.content.type === "text" &&
      text.content.text === "part one",
    "text_delta -> agent_message_chunk"
  );

  const thought = findUpdate(
    parseLine(parse, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
    }),
    "agent_thought_chunk"
  );
  assert(
    thought?.sessionUpdate === "agent_thought_chunk" &&
      thought.content.type === "text" &&
      thought.content.text === "reasoning",
    "thinking_delta -> agent_thought_chunk"
  );

  assert(
    parseLine(parse, {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    }) === null,
    "Boundary events emit nothing"
  );

  assert(
    parseLine(parse, { type: "turn_start" }) === null,
    "Lifecycle events emit nothing"
  );
}

async function testToolLifecycle(): Promise<void> {
  console.log("\n[3] tool execution lifecycle");

  const parse = createPiParser();

  const start = findUpdate(
    parseLine(parse, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "/home/user/workspace/src/index.ts", offset: 5 },
    }),
    "tool_call"
  );
  assert(start?.sessionUpdate === "tool_call", "tool_execution_start -> tool_call");
  assert(
    start?.sessionUpdate === "tool_call" && start.kind === "read",
    "Maps read -> read kind"
  );
  assert(
    start?.sessionUpdate === "tool_call" &&
      (start.locations || []).some(
        (loc) => loc.path === "/home/user/workspace/src/index.ts" && loc.line === 4
      ),
    "Converts 1-based offset to 0-based line"
  );

  const update = findUpdate(
    parseLine(parse, {
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "read",
      partialResult: "partial output",
    }),
    "tool_call_update"
  );
  assert(
    update?.sessionUpdate === "tool_call_update" && update.status === "in_progress",
    "tool_execution_update -> in_progress"
  );

  const end = findUpdate(
    parseLine(parse, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: "file contents",
      isError: false,
    }),
    "tool_call_update"
  );
  assert(
    end?.sessionUpdate === "tool_call_update" && end.status === "completed",
    "tool_execution_end -> completed"
  );

  const failedEnd = findUpdate(
    parseLine(parse, {
      type: "tool_execution_end",
      toolCallId: "call_2",
      toolName: "bash",
      result: "boom",
      isError: true,
    }),
    "tool_call_update"
  );
  assert(
    failedEnd?.sessionUpdate === "tool_call_update" && failedEnd.status === "failed",
    "isError -> failed"
  );
}

async function testIpythonTool(): Promise<void> {
  console.log("\n[4] prime-agent ipython tool");

  const parse = createPiParser();
  const call = findUpdate(
    parseLine(parse, {
      type: "tool_execution_start",
      toolCallId: "call_ipy",
      toolName: "ipython",
      args: { code: "print('hi')" },
    }),
    "tool_call"
  );

  assert(
    call?.sessionUpdate === "tool_call" && call.kind === "execute",
    "Maps ipython -> execute kind"
  );
  assert(
    call?.sessionUpdate === "tool_call" &&
      (call.content || []).some(
        (c) => c.type === "content" && c.content.type === "text" && c.content.text === "print('hi')"
      ),
    "Surfaces ipython code as content"
  );
}

async function testWriteDiffAndBadInput(): Promise<void> {
  console.log("\n[5] write diff and malformed input");

  const parse = createPiParser();
  const call = findUpdate(
    parseLine(parse, {
      type: "tool_execution_start",
      toolCallId: "call_w",
      toolName: "write",
      args: { path: "/tmp/new.txt", content: "body" },
    }),
    "tool_call"
  );
  assert(
    call?.sessionUpdate === "tool_call" &&
      (call.content || []).some(
        (c) => c.type === "diff" && c.oldText === null && c.newText === "body"
      ),
    "write emits a diff with null oldText"
  );

  assert(parse("not json") === null, "Invalid JSON returns null");
  assert(parse("") === null, "Empty line returns null");
  assert(
    parseLine(parse, { type: "tool_execution_start", toolName: "read" }) === null,
    "Missing toolCallId is dropped"
  );
}

async function testRegistryWiring(): Promise<void> {
  console.log("\n[6] both agent types resolve to the pi parser");

  for (const agentType of ["pi", "prime-agent"] as const) {
    const parse = createAgentParser(agentType);
    const events = parse(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "ok" },
      })
    );
    const update = findUpdate(events, "agent_message_chunk");
    assert(
      update?.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text" &&
        update.content.text === "ok",
      `createAgentParser("${agentType}") parses deltas`
    );
  }
}

async function main(): Promise<void> {
  console.log("\n=== pi / prime-agent Parser Unit Tests ===");
  await testSessionHeader();
  await testAssistantDeltas();
  await testToolLifecycle();
  await testIpythonTool();
  await testWriteDiffAndBadInput();
  await testRegistryWiring();
  console.log(`\n=== Summary ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
