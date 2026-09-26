#!/usr/bin/env tsx
/**
 * Unit Test: a retired harness's past records stay readable.
 *
 * gemini is retired (registry `retired`, replaced by antigravity): new runs are
 * refused (config-validation.test.ts), while a stored gemini trace, trial and
 * home must parse and lay out exactly as they did before the retirement.
 *
 * Usage:
 *   npx tsx tests/unit/retired-harness.test.ts
 */

import { readFileSync } from "node:fs";

import { createAgentParser } from "../../src/parsers/index";
import { isAgentWorkUpdate, type OutputEvent } from "../../src/parsers/types";
import { assembleTrialTree, harnessTrialLayout } from "../../src/hosted/trial-tree";
import type { Job, Trial } from "../../src/hosted/types";
import { AGENT_REGISTRY } from "../../src/registry";
import { ARTIFACT_PATH, type HarnessCapabilitiesArtifact } from "../../scripts/generate-harness-capabilities";

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

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (!match) {
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
  assert(match, message);
}

console.log("\n=== A retired harness's records stay readable (gemini) ===\n");

assertEqual(AGENT_REGISTRY.gemini.retired, { replacedBy: "antigravity" }, "gemini is retired in favor of antigravity");

// --- 1. A recorded trace parses through the same factory every reader uses -----

{
  // gemini --output-format stream-json, one line per event (parsers/gemini.ts header).
  const recorded = [
    `{"type":"init","timestamp":"2026-09-01T10:00:00.000Z","session_id":"g-old-1","model":"gemini-3.5-flash"}`,
    `{"type":"message","timestamp":"2026-09-01T10:00:01.000Z","role":"assistant","content":"Reading the file.","delta":true}`,
    `{"type":"tool_use","timestamp":"2026-09-01T10:00:02.000Z","tool_name":"read_file","tool_id":"read_file__1","parameters":{"absolute_path":"/app/main.py"}}`,
    `{"type":"tool_result","timestamp":"2026-09-01T10:00:03.000Z","tool_id":"read_file__1","status":"success","output":"print('hi')"}`,
    `{"type":"result","timestamp":"2026-09-01T10:00:04.000Z","status":"success","stats":{"total_tokens":120,"input_tokens":100,"output_tokens":20,"cached":0}}`,
  ];
  const parse = createAgentParser("gemini");
  const events: OutputEvent[] = recorded.flatMap((line) => parse(line) ?? []);
  assertEqual(
    events.map((event) => event.update.sessionUpdate),
    ["agent_message_chunk", "tool_call", "tool_call_update", "usage"],
    "every recorded line becomes its event kind",
  );
  assert(events.filter((event) => isAgentWorkUpdate(event.update)).length === 3, "the message, the tool call and its result count as work");
  assert(events.every((event) => event.sessionId === "g-old-1"), "the init session id is stamped on every event");
  assert(events.every((event) => event.model === "gemini-3.5-flash"), "the init model is stamped on every event");
  const usage = events[3].update;
  assert(
    usage.sessionUpdate === "usage" && usage.usage.promptTokens === 100 && usage.usage.completionTokens === 20,
    "the run's token counts are read from the result line",
  );
}

// --- 2. A stored trial lays out at Harbor's names, by either label -------------

function geminiTrial(label: string): Trial {
  return {
    id: "run-old-1",
    job_id: "job-old-1",
    task_name: "fix-bug",
    source: "deep-swe",
    agent_info: { name: label, version: "0.55.1", model_info: { name: "gemini-3.5-flash", provider: null } },
    status: "SCORED",
    reward: 1,
    verifier_result: { rewards: { reward: 1 } },
  } as unknown as Trial;
}

for (const label of ["gemini", "gemini-cli"]) {
  assertEqual(harnessTrialLayout(label).stdoutFile, "gemini-cli.txt", `label "${label}" resolves to gemini's layout`);
  const files = assembleTrialTree({
    trial: geminiTrial(label),
    job: { id: "job-old-1", source_jobs: [], is_regrade: false } as unknown as Job,
    events: [],
    atif: null,
    verifierLog: null,
    stdout: '{"type":"init","session_id":"g-old-1"}\n',
    stderr: null,
    home: {
      "/root/.gemini/settings.json": "{}",
      "/root/.gemini/tmp/abc123/chats/session-1.jsonl": "{}",
    },
    userId: "user-1",
  });
  assertEqual(
    Object.keys(files).filter((path) => path.startsWith("agent/")).sort(),
    ["agent/.gemini/settings.json", "agent/.gemini/tmp/abc123/chats/session-1.jsonl", "agent/gemini-cli.txt"],
    `label "${label}": the home sits at its real names and stdout at Harbor's tee name`,
  );
  assertEqual(JSON.parse(files["config.json"]).agent.name, label, `label "${label}": config.json keeps the stored agent name`);
}

// --- 3. The artifact keeps the harness, marked, with its models ----------------

{
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as HarnessCapabilitiesArtifact;
  const gemini = artifact.harnesses.gemini;
  assertEqual(gemini?.retired, { replacedBy: "antigravity" }, "the artifact marks gemini retired, naming the replacement");
  assertEqual(
    gemini?.models.map((model) => model.alias),
    AGENT_REGISTRY.gemini.models.map((model) => model.alias),
    "the artifact keeps gemini's model vocabulary for its past records",
  );
  assert(
    Object.entries(artifact.harnesses).every(([name, harness]) => (harness.retired === undefined) === !AGENT_REGISTRY[name as keyof typeof AGENT_REGISTRY].retired),
    "the artifact marks exactly the registry's retired entries",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
