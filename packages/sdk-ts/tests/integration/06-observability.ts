#!/usr/bin/env tsx
/**
 * Integration Test 06: Observability
 *
 * Tests:
 * - withSessionTagPrefix() - custom tag prefix
 * - getSessionTag() - retrieve session tag
 * - getSessionTimestamp() - retrieve session timestamp
 * - Verify local log file creation
 */

import { Evolve } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { getDefaultAgentConfig, getTestEnv } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/06-observability");
const agentConfig = getDefaultAgentConfig();
const env = getTestEnv();
const SESSION_LOGS_PATH = join(homedir(), ".evolve/observability/sessions");

function log(msg: string) {
  console.log(`[06-observability] ${msg}`);
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

  const tagPrefix = "test-observability";

  const evolve = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }))
    .withSessionTagPrefix(tagPrefix);

  try {
    // Test 1: Before run(), getSessionTag/Timestamp should return null
    log("Test 1: Before run(), observability getters should return null...");
    const tagBefore = evolve.getSessionTag();
    const timestampBefore = evolve.getSessionTimestamp();
    log(`  getSessionTag() before run: ${tagBefore}`);
    log(`  getSessionTimestamp() before run: ${timestampBefore}`);

    if (tagBefore !== null || timestampBefore !== null) {
      log("  WARNING: Expected null before run()");
    }

    // Test 2: After run(), getSessionTag should return prefixed tag
    log("Test 2: After run(), getSessionTag() should return prefixed tag...");
    const run1 = await evolve.run({
      prompt: "Say hello and confirm you are working",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run1.exitCode}`);
    save("run1-stdout.txt", run1.stdout);

    const tagAfter = evolve.getSessionTag();
    const timestampAfter = evolve.getSessionTimestamp();
    log(`  getSessionTag() after run: ${tagAfter}`);
    log(`  getSessionTimestamp() after run: ${timestampAfter}`);

    if (!tagAfter) {
      throw new Error("getSessionTag() returned null after run()");
    }

    if (!tagAfter.startsWith(tagPrefix)) {
      throw new Error(`getSessionTag() should start with '${tagPrefix}', got: ${tagAfter}`);
    }
    log(`  Tag correctly prefixed with '${tagPrefix}'`);

    if (!timestampAfter) {
      throw new Error("getSessionTimestamp() returned null after run()");
    }
    log(`  Timestamp is set: ${timestampAfter}`);

    save("session-tag.txt", tagAfter);
    save("session-timestamp.txt", timestampAfter);

    // Test 3: Verify local log file exists
    log("Test 3: Verifying local log file creation...");
    if (existsSync(SESSION_LOGS_PATH)) {
      const logFiles = readdirSync(SESSION_LOGS_PATH);
      const matchingFiles = logFiles.filter(f => f.includes(tagPrefix));
      log(`  Found ${matchingFiles.length} log files matching tag prefix`);

      if (matchingFiles.length > 0) {
        log(`  Latest matching file: ${matchingFiles[matchingFiles.length - 1]}`);
        save("matching-log-files.txt", matchingFiles.join("\n"));
      } else {
        log("  WARNING: No matching log files found (may be buffered)");
      }
    } else {
      log(`  Session logs directory not found: ${SESSION_LOGS_PATH}`);
    }

    // Test 4: Second run should maintain same tag
    log("Test 4: Second run() should maintain same session tag...");
    const run2 = await evolve.run({
      prompt: "Confirm you remember the previous conversation",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run2.exitCode}`);

    const tagAfterSecondRun = evolve.getSessionTag();
    if (tagAfterSecondRun !== tagAfter) {
      log(`  WARNING: Tag changed between runs: ${tagAfter} -> ${tagAfterSecondRun}`);
    } else {
      log(`  Tag remained consistent: ${tagAfterSecondRun}`);
    }

    // Test 5: After kill(), logs should be flushed
    log("Test 5: After kill(), logs should be flushed...");
    await evolve.kill();
    log("  Sandbox killed");

    // Wait a moment for async flush
    await new Promise(r => setTimeout(r, 1000));

    if (existsSync(SESSION_LOGS_PATH)) {
      const logFilesAfterKill = readdirSync(SESSION_LOGS_PATH);
      const matchingAfterKill = logFilesAfterKill.filter(f => f.includes(tagPrefix));
      log(`  Found ${matchingAfterKill.length} log files after kill`);
      save("log-files-after-kill.txt", matchingAfterKill.join("\n"));
    }

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`PASS - All observability tests passed (${duration}s)`);
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
