#!/usr/bin/env tsx
/**
 * Unit Test: Kimi Parser
 *
 * Validates Kimi-specific parsing behavior for:
 * - Tool error detection from <system>ERROR: ...</system>
 * - Media content parts in tool results (image_url / video_url)
 */

import { createKimiParser } from "../../src/parsers/kimi.ts";
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

function createParser() {
  const parser = createKimiParser();
  return (line: Record<string, unknown>): OutputEvent[] | null => {
    return parser(JSON.stringify(line));
  };
}

function createRawParser() {
  return createKimiParser();
}

function parseLine(line: Record<string, unknown>): OutputEvent[] | null {
  const parse = createParser();
  return parse(line);
}

function parseWith(
  parse: (line: Record<string, unknown>) => OutputEvent[] | null,
  line: Record<string, unknown>
): OutputEvent[] | null {
  return parse(line);
}

function firstUpdate(
  events: OutputEvent[] | null
): OutputEvent["update"] | undefined {
  return events?.[0]?.update;
}

function updateAt(
  events: OutputEvent[] | null,
  idx: number
): OutputEvent["update"] | undefined {
  return events?.[idx]?.update;
}

function includesSessionUpdate(
  events: OutputEvent[] | null,
  sessionUpdate: OutputEvent["update"]["sessionUpdate"]
): boolean {
  return Boolean(events?.some((e) => e.update.sessionUpdate === sessionUpdate));
}

async function testAssistantImageContent(): Promise<void> {
  console.log("\n[1] assistant image_url parts are preserved");

  const events = parseLine({
    role: "assistant",
    content: [
      { type: "text", text: "before" },
      { type: "image_url", image_url: { url: "https://example.com/image.png" } },
      { type: "text", text: "after" },
    ],
  });

  const middle = updateAt(events, 1);
  assert(updateAt(events, 0)?.sessionUpdate === "agent_message_chunk", "Emits text chunk before image");
  assert(middle?.sessionUpdate === "agent_message_chunk", "Emits image chunk");
  assert(
    middle?.sessionUpdate === "agent_message_chunk" &&
      middle.content.type === "image" &&
      middle.content.uri === "https://example.com/image.png",
    "Preserves remote image URL in agent content"
  );
  assert(updateAt(events, 2)?.sessionUpdate === "agent_message_chunk", "Emits text chunk after image");
}

async function testToolErrorDetection(): Promise<void> {
  console.log("\n[2] tool_call_update failed on <system>ERROR");

  const parse = createParser();
  const events = parseWith(parse, {
    role: "tool",
    tool_call_id: "tool_1",
    content: [{ type: "text", text: "<system>ERROR: failed to run command</system>" }],
  });

  const update = firstUpdate(events);
  assert(update?.sessionUpdate === "tool_call_update", "Emits tool_call_update");
  assert(update?.status === "failed", "Marks status as failed");
}

async function testToolErrorDetectionStringContent(): Promise<void> {
  console.log("\n[3] tool_call_update failed on string content error");

  const parse = createParser();
  const events = parseWith(parse, {
    role: "tool",
    tool_call_id: "tool_2",
    content: "<system>ERROR: command timed out</system>",
  });

  const update = firstUpdate(events);
  assert(update?.sessionUpdate === "tool_call_update", "Emits tool_call_update");
  assert(update?.status === "failed", "Marks status as failed");
}

async function testImageToolContent(): Promise<void> {
  console.log("\n[4] image_url parts are preserved in tool content");

  const parse = createParser();
  const events = parseWith(parse, {
    role: "tool",
    tool_call_id: "tool_3",
    content: [
      { type: "text", text: "<image path=\"/tmp/cat.png\">" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } },
      { type: "text", text: "</image>" },
    ],
  });

  const content = (firstUpdate(events)?.sessionUpdate === "tool_call_update"
    ? firstUpdate(events)?.content
    : undefined) || [];

  const image = content.find(
    (c) => c.type === "content" && c.content.type === "image"
  );

  assert(firstUpdate(events)?.sessionUpdate === "tool_call_update", "Emits tool_call_update");
  assert(firstUpdate(events)?.status === "completed", "Non-error tool result stays completed");
  assert(Boolean(image), "Includes image content block");
}

async function testVideoToolContentFallback(): Promise<void> {
  console.log("\n[5] video_url parts are converted to text fallback");

  const parse = createParser();
  const events = parseWith(parse, {
    role: "tool",
    tool_call_id: "tool_4",
    content: [
      { type: "video_url", video_url: { url: "https://example.com/video.mp4" } },
    ],
  });

  const content = (firstUpdate(events)?.sessionUpdate === "tool_call_update"
    ? firstUpdate(events)?.content
    : undefined) || [];

  const videoText = content.find(
    (c) =>
      c.type === "content" &&
      c.content.type === "text" &&
      c.content.text.includes("[video] https://example.com/video.mp4")
  );

  assert(Boolean(videoText), "Includes text fallback for video_url content");
}

async function assertTodoListPlan(toolName: "SetTodoList" | "TodoList"): Promise<void> {
  console.log(`\n[6] ${toolName} emits plan and suppresses matching tool result update`);

  const parse = createParser();
  const toolCallId = `${toolName}_1`;

  const assistant = parseWith(parse, {
    role: "assistant",
    content: [],
    tool_calls: [
      {
        type: "function",
        id: toolCallId,
        function: {
          name: toolName,
          arguments: JSON.stringify({
            todos: [
              { title: "A", status: "pending" },
              { title: "B", status: "in_progress" },
              { title: "C", status: "done" },
            ],
          }),
        },
      },
    ],
  });

  assert(Boolean(assistant), "Assistant payload parsed");
  assert(includesSessionUpdate(assistant, "plan"), "Emits plan update");
  assert(!includesSessionUpdate(assistant, "tool_call"), `Does not emit tool_call for ${toolName}`);

  const planUpdate = assistant?.find((e) => e.update.sessionUpdate === "plan")?.update;
  const entries = planUpdate?.sessionUpdate === "plan" ? planUpdate.entries : [];
  assert(entries.length === 3, "Includes all todo entries");
  assert(entries[0]?.status === "pending", "Maps pending -> pending");
  assert(entries[1]?.status === "in_progress", "Maps in_progress -> in_progress");
  assert(entries[2]?.status === "completed", "Maps done -> completed");

  const toolResult = parseWith(parse, {
    role: "tool",
    tool_call_id: toolCallId,
    content: [{ type: "text", text: "<system>Todo list updated</system>" }],
  });
  assert(toolResult === null, `Suppresses tool_call_update for ${toolName} result`);
}

async function testTodoListPlan(): Promise<void> {
  await assertTodoListPlan("SetTodoList");
  await assertTodoListPlan("TodoList");
}

async function testWireToolResultArrayOutput(): Promise<void> {
  console.log("\n[8] wire ToolResult preserves array output content parts");

  const events = parseLine({
    type: "ToolResult",
    payload: {
      tool_call_id: "tool_wire_1",
      return_value: {
        is_error: false,
        output: [
          { type: "text", text: "pong:hi" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } },
        ],
        message: "",
        display: [],
        extras: null,
      },
    },
  });

  const update = firstUpdate(events);
  const content = update?.sessionUpdate === "tool_call_update" ? update.content || [] : [];
  const text = content.find((c) => c.type === "content" && c.content.type === "text");
  const image = content.find((c) => c.type === "content" && c.content.type === "image");

  assert(update?.sessionUpdate === "tool_call_update", "Emits tool_call_update");
  assert(update?.status === "completed", "Marks successful wire tool result as completed");
  assert(Boolean(text), "Preserves text output from array payload");
  assert(Boolean(image), "Preserves image output from array payload");
}

async function testMetaResumeHintIgnored(): Promise<void> {
  console.log("\n[9] meta resume_hint lines are ignored");

  const events = parseLine({
    role: "meta",
    type: "session.resume_hint",
    session_id: "ses_prompt",
    command: "kimi -r ses_prompt",
    content: "To resume this session: kimi -r ses_prompt",
  });

  assert(events === null, "Ignores Kimi Code meta line");
}

async function testKimiCodeBashToolName(): Promise<void> {
  console.log("\n[10] Kimi Code Bash tool maps to execute kind");

  const events = parseLine({
    role: "assistant",
    content: "checking",
    tool_calls: [
      {
        type: "function",
        id: "tc_bash",
        function: {
          name: "Bash",
          arguments: JSON.stringify({ command: "ls" }),
        },
      },
    ],
  });

  assert(updateAt(events, 0)?.sessionUpdate === "agent_message_chunk", "Emits assistant content");
  const toolCall = events?.find((event) => event.update.sessionUpdate === "tool_call")?.update;
  assert(toolCall?.sessionUpdate === "tool_call", "Emits tool_call");
  assert(toolCall?.sessionUpdate === "tool_call" && toolCall.kind === "execute", "Maps Bash to execute");
  assert(toolCall?.sessionUpdate === "tool_call" && toolCall.title === "`ls`", "Uses command title");
}

async function testKimiCodeStreamJsonFixture(): Promise<void> {
  console.log("\n[11] Kimi Code stream-json fixture parses without rewrite");

  const parse = createRawParser();

  assert(
    parse("/private/tmp/evolve-kimi-parser.61ShE0") === null,
    "Ignores non-JSON shell progress lines"
  );

  const toolCallEvents = parse(JSON.stringify({
    role: "assistant",
    tool_calls: [
      {
        type: "function",
        id: "Bash_0",
        function: {
          name: "Bash",
          arguments: "{\"command\":\"pwd\"}",
        },
      },
    ],
  }));
  const toolCall = firstUpdate(toolCallEvents);
  assert(toolCall?.sessionUpdate === "tool_call", "Parses assistant tool_calls without content");
  assert(toolCall?.sessionUpdate === "tool_call" && toolCall.kind === "execute", "Maps Kimi Code Bash to execute");

  const toolResultEvents = parse(JSON.stringify({
    role: "tool",
    tool_call_id: "Bash_0",
    content: "/private/tmp/evolve-kimi-parser.61ShE0\n",
  }));
  const toolResult = firstUpdate(toolResultEvents);
  assert(toolResult?.sessionUpdate === "tool_call_update", "Parses Kimi Code tool result");
  assert(toolResult?.sessionUpdate === "tool_call_update" && toolResult.status === "completed", "Completes tool result");

  const assistantEvents = parse(JSON.stringify({
    role: "assistant",
    content: "EVOLVE_KIMI_TOOL_STREAM_OK",
  }));
  assert(firstUpdate(assistantEvents)?.sessionUpdate === "agent_message_chunk", "Parses final assistant content");

  assert(parse(JSON.stringify({
    role: "meta",
    type: "session.resume_hint",
    session_id: "session_934b96e5-a92c-44ab-861e-2941e867539d",
    command: "kimi -r session_934b96e5-a92c-44ab-861e-2941e867539d",
    content: "To resume this session: kimi -r session_934b96e5-a92c-44ab-861e-2941e867539d",
  })) === null, "Ignores Kimi Code resume meta");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Kimi Parser Unit Tests");
  console.log("=".repeat(60));

  await testAssistantImageContent();
  await testToolErrorDetection();
  await testToolErrorDetectionStringContent();
  await testImageToolContent();
  await testVideoToolContentFallback();
  await testTodoListPlan();
  await testWireToolResultArrayOutput();
  await testMetaResumeHintIgnored();
  await testKimiCodeBashToolName();
  await testKimiCodeStreamJsonFixture();

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
