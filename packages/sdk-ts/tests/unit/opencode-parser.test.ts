#!/usr/bin/env tsx
/**
 * Unit Test: OpenCode Parser
 *
 * Validates OpenCode-specific parsing behavior for:
 * - TodoWrite -> ACP plan updates
 * - Tool attachments (images) in tool_call_update content
 * - Tool kind/location mapping for plan and multiedit
 */

import { createOpenCodeParser } from "../../src/parsers/opencode.ts";
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

function parseLine(line: Record<string, unknown>): OutputEvent[] | null {
  const parse = createOpenCodeParser();
  return parse(JSON.stringify(line));
}

function findUpdate(
  events: OutputEvent[] | null,
  kind: OutputEvent["update"]["sessionUpdate"]
): OutputEvent["update"] | undefined {
  return events?.find((e) => e.update.sessionUpdate === kind)?.update;
}

async function testTodoWritePlan(): Promise<void> {
  console.log("\n[1] todowrite emits plan update");

  const events = parseLine({
    type: "tool_use",
    sessionID: "ses_test",
    part: {
      callID: "tool_todo_1",
      tool: "todowrite",
      state: {
        status: "completed",
        input: {
          todos: [
            { content: "A", status: "pending", priority: "high" },
            { content: "B", status: "in_progress", priority: "medium" },
            { content: "C", status: "cancelled", priority: "low" },
          ],
        },
        output: "[]",
      },
    },
  });

  const plan = findUpdate(events, "plan");
  const entries = plan?.sessionUpdate === "plan" ? plan.entries : [];

  assert(Boolean(findUpdate(events, "tool_call")), "Emits tool_call");
  assert(Boolean(findUpdate(events, "tool_call_update")), "Emits tool_call_update");
  assert(Boolean(plan), "Emits plan update for todowrite");
  assert(entries.length === 3, "Includes all todo entries");
  assert(entries[0]?.status === "pending", "Maps pending -> pending");
  assert(entries[1]?.status === "in_progress", "Maps in_progress -> in_progress");
  assert(entries[2]?.status === "completed", "Maps cancelled -> completed");
  assert(entries[0]?.priority === "high", "Preserves high priority");
}

async function testImageAttachment(): Promise<void> {
  console.log("\n[2] tool attachments preserve image content blocks");

  const events = parseLine({
    type: "tool_use",
    sessionID: "ses_test",
    part: {
      callID: "tool_web_1",
      tool: "webfetch",
      state: {
        status: "completed",
        input: { url: "https://example.com/image.png" },
        output: "Image fetched successfully",
        attachments: [
          {
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,QUJDRA==",
          },
        ],
      },
    },
  });

  const update = findUpdate(events, "tool_call_update");
  const content = update?.sessionUpdate === "tool_call_update" ? update.content || [] : [];
  const image = content.find((c) => c.type === "content" && c.content.type === "image");

  assert(Boolean(update), "Emits tool_call_update");
  assert(update?.sessionUpdate === "tool_call_update" && update.status === "completed", "Marks tool as completed");
  assert(Boolean(image), "Includes image content block from attachments");
  assert(
    image?.type === "content" &&
      image.content.type === "image" &&
      image.content.mimeType === "image/png" &&
      image.content.data === "QUJDRA==",
    "Preserves attachment mime/data"
  );
}

async function testPlanKindMapping(): Promise<void> {
  console.log("\n[3] plan_exit maps to switch_mode kind");

  const events = parseLine({
    type: "tool_use",
    sessionID: "ses_test",
    part: {
      callID: "tool_plan_1",
      tool: "plan_exit",
      state: {
        status: "completed",
        input: {},
        output: "Switching to build agent",
      },
    },
  });

  const call = findUpdate(events, "tool_call");
  assert(call?.sessionUpdate === "tool_call", "Emits tool_call");
  assert(call?.sessionUpdate === "tool_call" && call.kind === "switch_mode", "Maps plan_exit -> switch_mode");
}

async function testMultiEditLocation(): Promise<void> {
  console.log("\n[4] multiedit maps to edit kind with file location");

  const events = parseLine({
    type: "tool_use",
    sessionID: "ses_test",
    part: {
      callID: "tool_edit_1",
      tool: "multiedit",
      state: {
        status: "completed",
        input: {
          filePath: "/home/user/workspace/src/index.ts",
          edits: [{ oldString: "a", newString: "b" }],
        },
        output: "Edit applied successfully.",
      },
    },
  });

  const call = findUpdate(events, "tool_call");
  assert(call?.sessionUpdate === "tool_call", "Emits tool_call");
  assert(call?.sessionUpdate === "tool_call" && call.kind === "edit", "Maps multiedit -> edit kind");
  assert(
    call?.sessionUpdate === "tool_call" &&
      (call.locations || []).some((loc) => loc.path === "/home/user/workspace/src/index.ts"),
    "Extracts location from multiedit input.filePath"
  );
}

async function main(): Promise<void> {
  console.log("\n=== OpenCode Parser Unit Tests ===");

  await testTodoWritePlan();
  await testImageAttachment();
  await testPlanKindMapping();
  await testMultiEditLocation();

  console.log(`\n=== Summary ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
