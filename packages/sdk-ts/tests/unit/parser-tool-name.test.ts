#!/usr/bin/env tsx
/**
 * Unit Test: parsed tool_call carries the harness-native tool name
 *
 * Every parser must set `toolName` on the tool_call update with the name the
 * harness put on the wire, verbatim. Consumers that render a trajectory need
 * the real name ("mcp__mcp-server__get_secret"); `kind` only says "other".
 *
 * Covers all 7 parsers, each with an MCP call and a non-MCP call.
 */

import { createClaudeParser } from "../../src/parsers/claude.ts";
import { createCodexParser } from "../../src/parsers/codex.ts";
import { createDroidParser } from "../../src/parsers/droid.ts";
import { createGeminiParser } from "../../src/parsers/gemini.ts";
import { createKimiParser } from "../../src/parsers/kimi.ts";
import { createOpenCodeParser } from "../../src/parsers/opencode.ts";
import { createQwenParser } from "../../src/parsers/qwen.ts";
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

/** The MCP tool name Harbor's own hello-mcp example produces on the Claude wire. */
const MCP_NAME = "mcp__mcp-server__get_secret";

type Parser = (line: string) => OutputEvent[] | null;

/** Pull the toolName off the first tool_call update in a parsed batch. */
function toolNameOf(events: OutputEvent[] | null): string | undefined {
  const update = events?.find((e) => e.update.sessionUpdate === "tool_call")?.update;
  return update?.sessionUpdate === "tool_call" ? update.toolName : undefined;
}

function feed(parser: Parser, line: Record<string, unknown>): OutputEvent[] | null {
  return parser(JSON.stringify(line));
}

/** Claude: {type:"assistant", message:{content:[{type:"tool_use", id, name, input}]}} */
function claudeLine(name: string): Record<string, unknown> {
  return {
    type: "assistant",
    session_id: "ses_claude",
    message: {
      content: [{ type: "tool_use", id: `toolu_${name}`, name, input: { command: "ls" } }],
    },
  };
}

async function testClaude(): Promise<void> {
  console.log("\n[1] claude");

  assert(
    toolNameOf(feed(createClaudeParser(), claudeLine(MCP_NAME))) === MCP_NAME,
    "MCP arm carries the verbatim wire name"
  );
  assert(
    toolNameOf(feed(createClaudeParser(), claudeLine("Bash"))) === "Bash",
    "non-MCP tool carries its native name"
  );
}

async function testCodex(): Promise<void> {
  console.log("\n[2] codex");

  // codex splits an MCP call across two wire fields: item.server + item.tool
  const mcp = feed(createCodexParser(), {
    type: "item.started",
    item: {
      id: "item_1",
      type: "mcp_tool_call",
      server: "mcp-server",
      tool: "get_secret",
      arguments: {},
    },
  });
  assert(
    toolNameOf(mcp) === MCP_NAME,
    "MCP server+tool pair is joined into the same literal Claude emits"
  );

  const exec = feed(createCodexParser(), {
    type: "item.started",
    item: { id: "item_2", type: "command_execution", command: "ls -la" },
  });
  assert(
    toolNameOf(exec) === "command_execution",
    "non-MCP item carries its native item type"
  );
}

async function testDroid(): Promise<void> {
  console.log("\n[3] droid");

  assert(
    toolNameOf(
      feed(createDroidParser(), { type: "tool_call", id: "d1", name: MCP_NAME, parameters: {} })
    ) === MCP_NAME,
    "MCP call carries the verbatim wire name"
  );
  assert(
    toolNameOf(
      feed(createDroidParser(), {
        type: "tool_call",
        id: "d2",
        name: "Read",
        parameters: { file_path: "/tmp/a.txt" },
      })
    ) === "Read",
    "non-MCP tool carries its native name"
  );
}

async function testGemini(): Promise<void> {
  console.log("\n[4] gemini");

  assert(
    toolNameOf(
      feed(createGeminiParser(), { type: "tool_use", tool_id: "g1", tool_name: MCP_NAME, parameters: {} })
    ) === MCP_NAME,
    "MCP call carries the verbatim wire name"
  );
  assert(
    toolNameOf(
      feed(createGeminiParser(), {
        type: "tool_use",
        tool_id: "g2",
        tool_name: "read_file",
        parameters: { absolute_path: "/tmp/a.txt" },
      })
    ) === "read_file",
    "non-MCP tool carries its native name"
  );
}

/** Kimi: {role:"assistant", content:[], tool_calls:[{type:"function", id, function:{name, arguments}}]} */
function kimiLine(name: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [],
    tool_calls: [
      {
        type: "function",
        id: `${name}_1`,
        function: { name, arguments: JSON.stringify({ command: "ls" }) },
      },
    ],
  };
}

async function testKimi(): Promise<void> {
  console.log("\n[5] kimi");

  assert(
    toolNameOf(feed(createKimiParser(), kimiLine(MCP_NAME))) === MCP_NAME,
    "MCP call carries the verbatim wire name"
  );
  assert(
    toolNameOf(feed(createKimiParser(), kimiLine("Bash"))) === "Bash",
    "non-MCP tool carries its native name"
  );
}

/** OpenCode: {type:"tool_use", part:{callID, tool, state:{status, input}}} */
function opencodeLine(tool: string): Record<string, unknown> {
  return {
    type: "tool_use",
    sessionID: "ses_oc",
    part: {
      callID: `oc_${tool}`,
      tool,
      state: { status: "completed", input: {}, output: "" },
    },
  };
}

async function testOpenCode(): Promise<void> {
  console.log("\n[6] opencode");

  assert(
    toolNameOf(feed(createOpenCodeParser(), opencodeLine(MCP_NAME))) === MCP_NAME,
    "MCP call carries the verbatim wire name"
  );
  assert(
    toolNameOf(feed(createOpenCodeParser(), opencodeLine("bash"))) === "bash",
    "non-MCP tool carries its native name"
  );
  // opencode lowercases the name it uses for kind lookup; toolName must not inherit that.
  assert(
    toolNameOf(feed(createOpenCodeParser(), opencodeLine("mcp__Sentry__getIssue"))) ===
      "mcp__Sentry__getIssue",
    "mixed-case MCP name is preserved, not lowercased"
  );
}

/** Qwen: {type:"assistant", message:{content:[{type:"tool_use", id, name, input}]}} */
function qwenLine(name: string): Record<string, unknown> {
  return {
    type: "assistant",
    session_id: "ses_qwen",
    message: {
      content: [{ type: "tool_use", id: `q_${name}`, name, input: { command: "ls" } }],
    },
  };
}

async function testQwen(): Promise<void> {
  console.log("\n[7] qwen");

  assert(
    toolNameOf(feed(createQwenParser(), qwenLine(MCP_NAME))) === MCP_NAME,
    "MCP call carries the verbatim wire name"
  );
  assert(
    toolNameOf(feed(createQwenParser(), qwenLine("Bash"))) === "Bash",
    "non-MCP tool carries its native name"
  );
}

async function main(): Promise<void> {
  console.log("\n=== Parser Tool Name Unit Tests ===");

  await testClaude();
  await testCodex();
  await testDroid();
  await testGemini();
  await testKimi();
  await testOpenCode();
  await testQwen();

  console.log(`\n=== Summary ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
