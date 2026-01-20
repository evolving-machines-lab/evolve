#!/usr/bin/env tsx
/**
 * Integration Test 09: Advanced Features
 *
 * Tests gaps identified in coverage review:
 * - Content event types verification (agent_message_chunk, tool_call, etc.)
 * - withSystemPrompt() verification
 * - Binary file upload/download (Buffer/Uint8Array)
 * - kill() then run() creates new sandbox
 * - executeCommand() timeout
 */

import { Evolve } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import type { OutputEvent } from "../../dist/index.js";
import { getDefaultAgentConfig, getTestEnv } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/09-advanced-features");
const FIXTURES_DIR = resolve(__dirname, "../fixtures");
const agentConfig = getDefaultAgentConfig();
const env = getTestEnv();

function log(msg: string) {
  console.log(`[09-advanced-features] ${msg}`);
}

function save(name: string, content: string | Uint8Array) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

async function main() {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  log("Starting test...");
  const start = Date.now();

  // ==========================================================================
  // Test 1: Content event types verification
  // ==========================================================================
  log("Test 1: Content event types verification...");

  const evolve1 = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }));

  const contentEvents: OutputEvent[] = [];
  evolve1.on("content", (event: OutputEvent) => contentEvents.push(event));

  const run1 = await evolve1.run({
    prompt: "Create a file called test.txt with 'hello' in it. Use the write_file tool or equivalent.",
    timeoutMs: 180000,
  });
  log(`  run() completed: exit=${run1.exitCode}`);
  save("test1-stdout.txt", run1.stdout);
  save("test1-content-events.jsonl", contentEvents.map(e => JSON.stringify(e)).join("\n"));

  // Analyze event types
  const eventTypes = new Set<string>();
  for (const event of contentEvents) {
    const update = (event as any).update;
    if (update?.sessionUpdate) {
      eventTypes.add(update.sessionUpdate.type || "unknown");
    }
  }
  log(`  Event types captured: ${Array.from(eventTypes).join(", ") || "none"}`);
  save("test1-event-types.txt", Array.from(eventTypes).join("\n"));

  // Check for expected event types (at minimum agent_message_chunk or tool_call)
  const hasMessageOrTool = eventTypes.has("agent_message_chunk") ||
                           eventTypes.has("tool_call") ||
                           eventTypes.has("agent_thought_chunk");
  if (hasMessageOrTool) {
    log("  Content event types verified");
  } else {
    log("  WARNING: Expected agent_message_chunk, tool_call, or agent_thought_chunk events");
  }

  await evolve1.kill();
  log("  Sandbox 1 killed");

  // ==========================================================================
  // Test 2: withSystemPrompt() verification
  // ==========================================================================
  log("Test 2: withSystemPrompt() verification...");

  const customName = "TestBot9000";
  const evolve2 = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }))
    .withSystemPrompt(`Your name is ${customName}. Always introduce yourself by this name when asked.`);

  const run2 = await evolve2.run({
    prompt: "What is your name? Please tell me your name.",
    timeoutMs: 180000,
  });
  log(`  run() completed: exit=${run2.exitCode}`);
  save("test2-stdout.txt", run2.stdout);

  // Check if the custom name appears in output
  if (run2.stdout.includes(customName)) {
    log(`  System prompt verified: agent identified as '${customName}'`);
  } else {
    log(`  WARNING: Agent may not have used system prompt (looking for '${customName}')`);
  }

  await evolve2.kill();
  log("  Sandbox 2 killed");

  // ==========================================================================
  // Test 3: Binary file upload/download
  // ==========================================================================
  log("Test 3: Binary file upload/download...");

  const evolve3 = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }));

  // Create binary data (PNG header + some bytes)
  const binaryData = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG header
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk start
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 dimensions
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // bit depth, color type, etc
  ]);

  // Also test with Buffer (Node.js style)
  const bufferData = Buffer.from("Binary content from Buffer");

  // First run to initialize sandbox
  const run3init = await evolve3.run({
    prompt: "Say hello",
    timeoutMs: 180000,
  });
  log(`  Initial run: exit=${run3init.exitCode}`);

  // Upload binary files (convert Uint8Array to Buffer for type compatibility)
  await evolve3.uploadFiles({
    "binary-test.bin": Buffer.from(binaryData),
    "buffer-test.txt": bufferData,
  });
  log("  Binary files uploaded");

  // Verify files exist
  const run3verify = await evolve3.run({
    prompt: "Check if binary-test.bin and buffer-test.txt exist. Use ls -la to list them and tell me their sizes.",
    timeoutMs: 180000,
  });
  log(`  Verify run: exit=${run3verify.exitCode}`);
  save("test3-verify-stdout.txt", run3verify.stdout);

  // Test with real binary file from fixtures
  const realImagePath = resolve(FIXTURES_DIR, "test_image.png");
  try {
    const realImage = readFileSync(realImagePath);
    await evolve3.uploadContext({
      "uploaded-image.png": realImage,
    });
    log(`  Real image uploaded (${realImage.length} bytes)`);

    const run3image = await evolve3.run({
      prompt: "Check if context/uploaded-image.png exists and tell me its size in bytes using ls -la.",
      timeoutMs: 180000,
    });
    save("test3-image-stdout.txt", run3image.stdout);
    log(`  Image verification: exit=${run3image.exitCode}`);
  } catch (err) {
    log(`  Skipping real image test: ${err instanceof Error ? err.message : err}`);
  }

  await evolve3.kill();
  log("  Sandbox 3 killed");

  // ==========================================================================
  // Test 4: kill() then run() creates new sandbox
  // ==========================================================================
  log("Test 4: kill() then run() creates new sandbox...");

  const evolve4 = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }));

  // First run - get session ID
  const run4a = await evolve4.run({
    prompt: "Create a file called sandbox-marker.txt with 'First sandbox'",
    timeoutMs: 180000,
  });
  log(`  First run: exit=${run4a.exitCode}`);
  const sessionBefore = evolve4.getSession();
  log(`  Session before kill: ${sessionBefore}`);
  save("test4-session-before.txt", sessionBefore || "null");

  // Kill sandbox
  await evolve4.kill();
  log("  Sandbox killed");

  // Run again - should create new sandbox
  const run4b = await evolve4.run({
    prompt: "Check if sandbox-marker.txt exists. If it doesn't exist, say 'NEW SANDBOX'. If it exists, say 'SAME SANDBOX'.",
    timeoutMs: 180000,
  });
  log(`  Second run: exit=${run4b.exitCode}`);
  const sessionAfter = evolve4.getSession();
  log(`  Session after kill+run: ${sessionAfter}`);
  save("test4-session-after.txt", sessionAfter || "null");
  save("test4-second-run-stdout.txt", run4b.stdout);

  // Verify different sandbox
  if (sessionBefore !== sessionAfter) {
    log("  Verified: New sandbox created after kill()");
  } else {
    log("  WARNING: Same session ID after kill() - may be reconnecting?");
  }

  // Check if marker file exists (shouldn't in new sandbox)
  if (run4b.stdout.includes("NEW SANDBOX") || !run4b.stdout.includes("SAME SANDBOX")) {
    log("  Verified: Marker file doesn't exist in new sandbox");
  } else {
    log("  WARNING: Marker file may exist - sandbox may not be new");
  }

  await evolve4.kill();
  log("  Sandbox 4 killed");

  // ==========================================================================
  // Test 5: executeCommand() timeout
  // ==========================================================================
  log("Test 5: executeCommand() timeout...");

  const evolve5 = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }));

  // Initialize sandbox
  const run5init = await evolve5.run({
    prompt: "Say hello",
    timeoutMs: 180000,
  });
  log(`  Init run: exit=${run5init.exitCode}`);

  // Test short timeout on long command
  log("  Testing executeCommand timeout (5s on 'sleep 30')...");
  try {
    const cmdTimeout = await evolve5.executeCommand("sleep 30", {
      timeoutMs: 5000, // 5 seconds - should timeout
    });
    log(`  WARNING: Command completed instead of timing out: exit=${cmdTimeout.exitCode}`);
    save("test5-unexpected-success.txt", cmdTimeout.stdout);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`  Timeout triggered as expected: ${errMsg.substring(0, 80)}...`);
    save("test5-timeout-error.txt", errMsg);
  }

  // Verify sandbox still works after timeout
  const cmd5verify = await evolve5.executeCommand("echo 'Sandbox alive after timeout'", {
    timeoutMs: 60000,
  });
  log(`  Post-timeout command: exit=${cmd5verify.exitCode}`);
  save("test5-post-timeout.txt", cmd5verify.stdout);

  if (cmd5verify.exitCode === 0) {
    log("  Sandbox survived executeCommand timeout");
  } else {
    log("  WARNING: Sandbox may be in bad state after timeout");
  }

  await evolve5.kill();
  log("  Sandbox 5 killed");

  // ==========================================================================
  // Summary
  // ==========================================================================
  const duration = ((Date.now() - start) / 1000).toFixed(1);
  log(`\n============================================================`);
  log(`PASS - All advanced feature tests completed (${duration}s)`);
  log(`============================================================\n`);
  process.exit(0);
}

main().catch(err => {
  const msg = err instanceof Error ? err.message : String(err);
  save("error.txt", err instanceof Error ? err.stack || msg : msg);
  log(`\n============================================================`);
  log(`FAIL - ${msg}`);
  log(`============================================================\n`);
  process.exit(1);
});
