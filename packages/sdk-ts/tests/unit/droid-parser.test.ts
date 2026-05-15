#!/usr/bin/env tsx
/**
 * Unit Test: Droid Parser
 *
 * Validates Droid headless stream-json and low-level stream-jsonrpc parsing.
 */

import { createDroidParser } from "../../src/parsers/droid.ts";

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

async function testHeadlessStreamJson(): Promise<void> {
  console.log("\n[1] parses documented droid exec stream-json shape");

  const parser = createDroidParser();
  const init = parser(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "droid-session-1",
  }));
  const message = parser(JSON.stringify({
    type: "message",
    role: "assistant",
    text: "hello from droid",
    session_id: "droid-session-1",
  }));
  const completion = parser(JSON.stringify({
    type: "completion",
    finalText: "hello from droid",
    session_id: "droid-session-1",
  }));

  assert(init === null, "does not emit system init");
  assert(message?.length === 1, "emits assistant message");
  assert(message?.[0]?.sessionId === "droid-session-1", "sets session id");
  assert(message?.[0]?.update.sessionUpdate === "agent_message_chunk", "emits agent chunk");
  assert(completion === null, "does not duplicate completion finalText");
}

async function testJsonResultFallback(): Promise<void> {
  console.log("\n[2] parses final json result fallback");

  const parser = createDroidParser();
  const events = parser(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "result text",
    session_id: "droid-session-2",
  }));

  assert(events?.length === 1, "emits one result event");
  assert(events?.[0]?.sessionId === "droid-session-2", "sets result session id");
  const content = events?.[0]?.update.content;
  assert(content?.type === "text" && content.text === "result text", "emits result text");
}

async function testJsonRpcNotification(): Promise<void> {
  console.log("\n[3] parses stream-jsonrpc notification shape");

  const parser = createDroidParser();
  const events = parser(JSON.stringify({
    jsonrpc: "2.0",
    type: "notification",
    factoryApiVersion: "1.0.0",
    method: "droid.session_notification",
    params: {
      notification: {
        type: "assistant_text_delta",
        textDelta: "jsonrpc hello",
      },
    },
  }));

  assert(events?.length === 1, "emits one jsonrpc event");
  assert(events?.[0]?.update.sessionUpdate === "agent_message_chunk", "emits message chunk");
  const content = events?.[0]?.update.content;
  assert(content?.type === "text" && content.text === "jsonrpc hello", "emits textDelta");
}

async function testJsonRpcSessionResponse(): Promise<void> {
  console.log("\n[4] captures JSON-RPC response session for following events");

  const parser = createDroidParser();
  const init = parser(JSON.stringify({
    jsonrpc: "2.0",
    type: "response",
    factoryApiVersion: "1.0.0",
    id: "init",
    result: { sessionId: "droid-session-3" },
  }));
  const events = parser(JSON.stringify({
    jsonrpc: "2.0",
    type: "notification",
    factoryApiVersion: "1.0.0",
    method: "droid.session_notification",
    params: {
      notification: {
        type: "assistant_text_delta",
        textDelta: "after init",
      },
    },
  }));

  assert(init === null, "does not emit initialize response");
  assert(events?.[0]?.sessionId === "droid-session-3", "uses captured response session id");
}

async function testToolEvents(): Promise<void> {
  console.log("\n[5] parses tool call/result stream events");

  const parser = createDroidParser();
  const callEvents = parser(JSON.stringify({
    type: "tool_call",
    toolUse: {
      id: "tool-1",
      name: "Read",
      input: { file_path: "/workspace/src/index.ts" },
    },
  }));
  const resultEvents = parser(JSON.stringify({
    type: "tool_result",
    toolUseId: "tool-1",
    content: "file contents",
    isError: false,
  }));

  assert(callEvents?.[0]?.update.sessionUpdate === "tool_call", "emits tool_call");
  assert(callEvents?.[0]?.update.sessionUpdate === "tool_call" && callEvents[0].update.kind === "read", "maps Read tool kind");
  assert(resultEvents?.[0]?.update.sessionUpdate === "tool_call_update", "emits tool_call_update");
  assert(resultEvents?.[0]?.update.sessionUpdate === "tool_call_update" && resultEvents[0].update.status === "completed", "marks tool completed");
}

async function testTodoWritePlan(): Promise<void> {
  console.log("\n[6] maps TodoWrite to plan updates");

  const parser = createDroidParser();
  const events = parser(JSON.stringify({
    type: "tool_call",
    toolUse: {
      id: "tool-plan",
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Read docs", status: "completed", priority: "high" },
          { content: "Patch code", status: "in_progress", priority: "medium" },
        ],
      },
    },
  }));

  assert(events?.[0]?.update.sessionUpdate === "plan", "emits plan update");
  assert(events?.[0]?.update.sessionUpdate === "plan" && events[0].update.entries.length === 2, "preserves todos");
}

async function testUserEchoIgnored(): Promise<void> {
  console.log("\n[7] ignores plain user prompt echoes");

  const parser = createDroidParser();
  const streamMessage = parser(JSON.stringify({
    type: "message",
    role: "user",
    text: "Reply with exactly: hello world",
    session_id: "droid-session-user",
  }));
  const createMessage = parser(JSON.stringify({
    type: "create_message",
    message: {
      role: "user",
      content: [{ type: "text", text: "Reply with exactly: hello world" }],
    },
    session_id: "droid-session-user",
  }));

  assert(streamMessage === null, "ignores stream-json user message");
  assert(createMessage === null, "ignores create_message user text");
}

async function testInvalidLine(): Promise<void> {
  console.log("\n[8] ignores invalid JSON");

  const parser = createDroidParser();
  const events = parser("not-json");

  assert(events === null, "returns null");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Droid Parser Unit Tests");
  console.log("=".repeat(60));

  await testHeadlessStreamJson();
  await testJsonResultFallback();
  await testJsonRpcNotification();
  await testJsonRpcSessionResponse();
  await testToolEvents();
  await testTodoWritePlan();
  await testUserEchoIgnored();
  await testInvalidLine();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
