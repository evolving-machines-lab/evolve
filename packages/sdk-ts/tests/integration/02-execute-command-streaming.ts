#!/usr/bin/env tsx
/**
 * Integration Test 02: Execute Command & Streaming Events
 *
 * Tests:
 * - executeCommand() foreground
 * - executeCommand() background
 * - on("stdout") streaming
 * - on("stderr") streaming
 * - on("content") streaming
 * - run() to verify agent works first
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

const LOGS_DIR = resolve(__dirname, "../test-logs/02-execute-command-streaming");
const agentConfig = getDefaultAgentConfig();
const env = getTestEnv();

function log(msg: string) {
  console.log(`[02-execute-command] ${msg}`);
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

  // Collect streaming events
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const contentEvents: OutputEvent[] = [];

  evolve.on("stdout", (chunk: string) => stdoutChunks.push(chunk));
  evolve.on("stderr", (chunk: string) => stderrChunks.push(chunk));
  evolve.on("content", (event: OutputEvent) => contentEvents.push(event));

  try {
    // Test 1: run() - ensure agent is working
    log("Test 1: run() - basic agent functionality...");
    const run1 = await evolve.run({
      prompt: "Say hello and create a file called test.txt with 'hello world' in it",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run1.exitCode}`);
    log(`  stdout events: ${stdoutChunks.length}`);
    log(`  content events: ${contentEvents.length}`);
    save("run-stdout.jsonl", stdoutChunks.join(""));
    save("run-content.jsonl", contentEvents.map(e => JSON.stringify(e)).join("\n"));

    if (run1.exitCode !== 0) {
      throw new Error(`run() failed with exit code ${run1.exitCode}`);
    }

    // Reset event collectors
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    contentEvents.length = 0;

    // Test 2: executeCommand() foreground
    log("Test 2: executeCommand() foreground...");
    const cmd1 = await evolve.executeCommand("ls -la && echo 'test complete'", {
      timeoutMs: 60000,
    });
    log(`  executeCommand() completed: exit=${cmd1.exitCode}`);
    log(`  stdout length: ${cmd1.stdout.length}`);
    log(`  streamed stdout chunks: ${stdoutChunks.length}`);
    save("cmd-foreground-stdout.txt", cmd1.stdout);
    save("cmd-foreground-stderr.txt", cmd1.stderr);
    save("cmd-foreground-streamed.txt", stdoutChunks.join(""));

    if (cmd1.exitCode !== 0) {
      throw new Error(`executeCommand() foreground failed with exit code ${cmd1.exitCode}`);
    }

    // Reset event collectors
    stdoutChunks.length = 0;
    stderrChunks.length = 0;

    // Test 3: executeCommand() background
    log("Test 3: executeCommand() background...");
    const cmd2 = await evolve.executeCommand("sleep 2 && echo 'background done'", {
      timeoutMs: 60000,
      background: true,
    });
    log(`  executeCommand() background started: exit=${cmd2.exitCode}`);
    log(`  stdout: ${cmd2.stdout}`);
    save("cmd-background-result.txt", JSON.stringify(cmd2, null, 2));

    // Wait a bit for background process
    await new Promise(r => setTimeout(r, 3000));
    log(`  streamed stdout chunks after wait: ${stdoutChunks.length}`);
    save("cmd-background-streamed.txt", stdoutChunks.join(""));

    // Test 4: executeCommand() with stderr
    log("Test 4: executeCommand() with stderr...");
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    const cmd3 = await evolve.executeCommand("echo 'stdout msg' && echo 'stderr msg' >&2", {
      timeoutMs: 60000,
    });
    log(`  stderr chunks received: ${stderrChunks.length}`);
    log(`  stderr content: ${stderrChunks.join("")}`);
    save("cmd-stderr-stdout.txt", cmd3.stdout);
    save("cmd-stderr-stderr.txt", cmd3.stderr);
    save("cmd-stderr-streamed-out.txt", stdoutChunks.join(""));
    save("cmd-stderr-streamed-err.txt", stderrChunks.join(""));

    await evolve.kill();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`PASS - All executeCommand & streaming tests passed (${duration}s)`);
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
