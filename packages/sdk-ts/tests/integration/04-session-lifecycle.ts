#!/usr/bin/env tsx
/**
 * Integration Test 04: Session Lifecycle
 *
 * Tests:
 * - getSession() - get current sandbox ID
 * - setSession() - switch to different sandbox
 * - withSession() - reconnect to existing sandbox
 * - pause() - suspend sandbox
 * - resume() - reactivate sandbox
 * - Multi-turn conversation (context preservation)
 */

import { Evolve } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { getDefaultAgentConfig, getTestEnv } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/04-session-lifecycle");
const agentConfig = getDefaultAgentConfig();
const env = getTestEnv();

function log(msg: string) {
  console.log(`[04-session-lifecycle] ${msg}`);
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

  const provider = createE2BProvider({ apiKey: env.E2B_API_KEY });

  const evolve = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(provider);

  try {
    // Test 1: Initial run and getSession()
    log("Test 1: Initial run() and getSession()...");
    const run1 = await evolve.run({
      prompt: "Create a file called session-test.txt with the text 'Turn 1: Session started'. Remember this for later.",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run1.exitCode}`);
    save("run1-stdout.txt", run1.stdout);

    const sessionId = evolve.getSession();
    log(`  getSession() returned: ${sessionId}`);
    save("session-id.txt", sessionId || "null");

    if (!sessionId) {
      throw new Error("getSession() returned null after run()");
    }

    // Test 2: Multi-turn conversation (context preservation)
    log("Test 2: Multi-turn conversation...");
    const run2 = await evolve.run({
      prompt: "What file did I ask you to create in the previous turn? Add 'Turn 2: Context preserved' to that file.",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run2.exitCode}`);
    save("run2-stdout.txt", run2.stdout);

    // Test 3: pause() and resume()
    log("Test 3: pause() and resume()...");
    log("  Calling pause()...");
    await evolve.pause();
    log("  Sandbox paused");

    // Wait a moment
    await new Promise(r => setTimeout(r, 2000));

    log("  Calling resume()...");
    await evolve.resume();
    log("  Sandbox resumed");

    // Verify sandbox is working after resume
    const run3 = await evolve.run({
      prompt: "Add 'Turn 3: After pause/resume' to session-test.txt and then show me its contents.",
      timeoutMs: 180000,
    });
    log(`  run() after resume completed: exit=${run3.exitCode}`);
    save("run3-stdout.txt", run3.stdout);

    if (run3.exitCode !== 0) {
      throw new Error(`run() after resume failed with exit code ${run3.exitCode}`);
    }

    // Test 4: withSession() - reconnect from new instance
    log("Test 4: withSession() - reconnect from new instance...");
    const evolve2 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withSession(sessionId);

    const run4 = await evolve2.run({
      prompt: "Add 'Turn 4: Reconnected via withSession' to session-test.txt and show me all its contents.",
      timeoutMs: 180000,
    });
    log(`  run() on reconnected instance completed: exit=${run4.exitCode}`);
    save("run4-stdout.txt", run4.stdout);

    if (run4.exitCode !== 0) {
      throw new Error(`run() on reconnected instance failed with exit code ${run4.exitCode}`);
    }

    // Test 5: setSession() - switch session on existing instance
    log("Test 5: setSession() - verify session switch API...");
    const currentSession = evolve2.getSession();
    log(`  Current session: ${currentSession}`);

    // Just verify setSession doesn't throw
    await evolve2.setSession(sessionId);
    log(`  setSession() completed without error`);

    // Clean up
    await evolve2.kill();
    log("  Sandbox killed");

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`PASS - All session lifecycle tests passed (${duration}s)`);
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
