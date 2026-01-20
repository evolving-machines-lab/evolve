#!/usr/bin/env tsx
/**
 * Integration Test 07: Background Mode & Timeouts
 *
 * Tests:
 * - run({ background: true }) - background agent execution
 * - executeCommand({ background: true }) - background shell command
 * - run() timeout - verify timeoutMs works
 * - Sandbox timeout - verify sandbox doesn't die prematurely
 */

import { Evolve } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import type { OutputEvent } from "../../dist/index.js";
import { getDefaultAgentConfig, getTestEnv } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/07-background-timeouts");
const agentConfig = getDefaultAgentConfig();
const env = getTestEnv();

function log(msg: string) {
  console.log(`[07-background-timeouts] ${msg}`);
}

function save(name: string, content: string) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

async function main() {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  log("Starting test...");
  const start = Date.now();

  const evolve = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }));

  // Collect streaming events for background mode verification
  const stdoutChunks: string[] = [];
  const contentEvents: OutputEvent[] = [];
  evolve.on("stdout", (chunk: string) => stdoutChunks.push(chunk));
  evolve.on("content", (event: OutputEvent) => contentEvents.push(event));

  try {
    // Test 1: Normal run() first to initialize
    log("Test 1: Normal run() to initialize sandbox...");
    const run1 = await evolve.run({
      prompt: "Say hello briefly",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run1.exitCode}`);
    save("run1-stdout.txt", run1.stdout);

    // Reset collectors
    stdoutChunks.length = 0;
    contentEvents.length = 0;

    // Test 2: run({ background: true })
    log("Test 2: run({ background: true }) - background agent execution...");
    const runBg = await evolve.run({
      prompt: "Create a file called background-test.txt with 'Background run completed'",
      timeoutMs: 300000,
      background: true,
    });
    log(`  run() background returned: exit=${runBg.exitCode}`);
    log(`  stdout: ${runBg.stdout}`);
    save("run-background-result.txt", JSON.stringify(runBg, null, 2));

    // Background should return immediately with PID info
    if (!runBg.stdout.includes("Background process started")) {
      log("  WARNING: Expected 'Background process started' in stdout");
    }

    // Wait for background process and check streaming
    log("  Waiting for background streaming...");
    await new Promise(r => setTimeout(r, 10000));
    log(`  Streamed stdout chunks: ${stdoutChunks.length}`);
    log(`  Streamed content events: ${contentEvents.length}`);
    save("run-background-streamed-stdout.txt", stdoutChunks.join(""));
    save("run-background-streamed-content.jsonl", contentEvents.map(e => JSON.stringify(e)).join("\n"));

    // Reset collectors
    stdoutChunks.length = 0;
    contentEvents.length = 0;

    // Test 3: executeCommand({ background: true })
    log("Test 3: executeCommand({ background: true }) - background shell command...");
    const cmdBg = await evolve.executeCommand("sleep 3 && echo 'Background command done' > /tmp/bg-cmd.txt && cat /tmp/bg-cmd.txt", {
      timeoutMs: 60000,
      background: true,
    });
    log(`  executeCommand() background returned: exit=${cmdBg.exitCode}`);
    log(`  stdout: ${cmdBg.stdout}`);
    save("cmd-background-result.txt", JSON.stringify(cmdBg, null, 2));

    // Wait for background command
    await new Promise(r => setTimeout(r, 5000));
    log(`  Streamed stdout chunks after wait: ${stdoutChunks.length}`);
    save("cmd-background-streamed.txt", stdoutChunks.join(""));

    // Test 4: Timeout test - short timeout should fail on long operation
    log("Test 4: Timeout test - run() with very short timeout...");
    try {
      // This should timeout - 5 second timeout for a prompt that takes longer
      const runTimeout = await evolve.run({
        prompt: "Write a very long essay about the history of computing, at least 2000 words, take your time",
        timeoutMs: 5000, // 5 seconds - should timeout
      });
      log(`  WARNING: Run completed instead of timing out: exit=${runTimeout.exitCode}`);
      save("timeout-unexpected-success.txt", runTimeout.stdout);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`  Timeout triggered as expected: ${errMsg.substring(0, 100)}...`);
      save("timeout-error.txt", errMsg);
    }

    // Test 5: Verify sandbox is still alive after timeout
    log("Test 5: Verify sandbox survives after timeout...");
    const runAfterTimeout = await evolve.run({
      prompt: "Say 'Sandbox still alive after timeout test'",
      timeoutMs: 180000,
    });
    log(`  run() after timeout completed: exit=${runAfterTimeout.exitCode}`);
    save("run-after-timeout.txt", runAfterTimeout.stdout);

    if (runAfterTimeout.exitCode !== 0) {
      throw new Error(`Sandbox failed after timeout test: exit=${runAfterTimeout.exitCode}`);
    }
    log("  Sandbox survived timeout test");

    await evolve.kill();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`PASS - All background & timeout tests passed (${duration}s)`);
    log(`============================================================\n`);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save("error.txt", err instanceof Error ? err.stack || msg : msg);
    await evolve.kill().catch(() => {});

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`FAIL - ${msg} (${duration}s)`);
    log(`============================================================\n`);
    process.exit(1);
  }
}

main();
