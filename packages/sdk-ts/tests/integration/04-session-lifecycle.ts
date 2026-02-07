#!/usr/bin/env tsx
/**
 * Integration Test 04: Session Lifecycle
 *
 * Tests:
 * - status() - runtime status snapshot
 * - lifecycle stream - sandbox/agent transitions
 * - getSession() - get current sandbox ID
 * - interrupt() - stop active process without killing sandbox
 * - setSession() - switch to different sandbox
 * - withSession() - reconnect to existing sandbox
 * - pause() - suspend sandbox
 * - resume() - reactivate sandbox
 * - Multi-turn conversation (context preservation)
 */

import { Evolve } from "../../dist/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import type { LifecycleEvent } from "../../dist/index.js";
import {
  getDefaultAgentConfig,
  getSandboxProviderByName,
  type ProviderName,
} from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const providerArg = (process.argv[2] as ProviderName | undefined) || "e2b";
const LOGS_DIR = resolve(__dirname, `../test-logs/04-session-lifecycle-${providerArg}`);
const agentConfig = getDefaultAgentConfig();

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

  const provider = getSandboxProviderByName(providerArg);
  const supportsPauseResume = providerArg !== "modal";
  const supportsInterrupt = providerArg !== "modal";

  const evolve = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(provider);
  const lifecycleEvents: LifecycleEvent[] = [];
  evolve.on("lifecycle", (event) => lifecycleEvents.push(event));

  try {
    // Test 0: status() before first run
    log("Test 0: status() before first run...");
    const status0 = await evolve.status();
    save("status-0.json", JSON.stringify(status0, null, 2));
    if (status0.sandbox !== "stopped" || status0.agent !== "idle") {
      throw new Error(`Unexpected initial status: ${JSON.stringify(status0)}`);
    }

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

    // Test 2: Multi-turn context preservation with run()
    log("Test 2: multi-turn context preservation...");
    const run2 = await evolve.run({
      prompt: "What file did I ask you to create in the previous turn? Add 'Turn 2: Context preserved' to that file.",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run2.exitCode}`);
    save("run2-stdout.txt", run2.stdout);

    // Test 3: pause/resume if supported, then verify session still works
    log("Test 3: pause()/resume() capability...");
    if (supportsPauseResume) {
      log("  Calling pause()...");
      await evolve.pause();
      log("  Sandbox paused");
      await new Promise(r => setTimeout(r, 2000));
      log("  Calling resume()...");
      await evolve.resume();
      log("  Sandbox resumed");
    } else {
      log("  Provider does not support pause/resume; skipping");
    }

    // Verify sandbox/session is still working
    const run3 = await evolve.run({
      prompt: supportsPauseResume
        ? "Add 'Turn 3: After pause/resume' to session-test.txt and then show me its contents."
        : "Add 'Turn 3: No pause support but session alive' to session-test.txt and then show me its contents.",
      timeoutMs: 180000,
    });
    log(`  run() after capability check completed: exit=${run3.exitCode}`);
    save("run3-stdout.txt", run3.stdout);

    if (run3.exitCode !== 0) {
      throw new Error(`run() after resume failed with exit code ${run3.exitCode}`);
    }

    // Test 4: interrupt() on active process (without killing sandbox)
    log("Test 4: interrupt() on active executeCommand...");
    if (supportsInterrupt) {
      const longCommand = evolve.executeCommand("sleep 60 && echo never", { timeoutMs: 180000 });
      await new Promise(r => setTimeout(r, 3000));
      const interrupted = await evolve.interrupt();
      log(`  interrupt() returned: ${interrupted}`);
      save("interrupt-result.txt", JSON.stringify({ interrupted }, null, 2));
      if (!interrupted) {
        throw new Error("interrupt() returned false while a command was running");
      }

      const interruptedResult = await longCommand;
      log(`  interrupted command exit=${interruptedResult.exitCode}`);
      save("interrupt-command-result.json", JSON.stringify(interruptedResult, null, 2));

      const statusAfterInterrupt = await evolve.status();
      save("status-after-interrupt.json", JSON.stringify(statusAfterInterrupt, null, 2));
      if (statusAfterInterrupt.sandbox !== "ready") {
        throw new Error(`Sandbox should be ready after interrupt, got: ${statusAfterInterrupt.sandbox}`);
      }
      if (statusAfterInterrupt.agent !== "interrupted") {
        throw new Error(`Agent should be interrupted after interrupt, got: ${statusAfterInterrupt.agent}`);
      }
    } else {
      log("  Provider does not support interrupt; skipping");
    }

    // Verify sandbox/session still usable after interrupt
    const runAfterInterrupt = await evolve.run({
      prompt: "Append 'Turn 3b: After interrupt still running' to session-test.txt and show the final file.",
      timeoutMs: 180000,
    });
    save("run-after-interrupt.txt", runAfterInterrupt.stdout);
    if (runAfterInterrupt.exitCode !== 0) {
      throw new Error(`run() after interrupt failed: exit=${runAfterInterrupt.exitCode}`);
    }

    // Test 5: withSession() - reconnect from new instance
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

    // Test 6: setSession() - switch session on existing instance
    log("Test 6: setSession() - verify session switch API...");
    const currentSession = evolve2.getSession();
    log(`  Current session: ${currentSession}`);

    // Just verify setSession doesn't throw
    await evolve2.setSession(sessionId);
    log(`  setSession() completed without error`);
    const statusAfterSetSession = await evolve2.status();
    save("status-after-set-session.json", JSON.stringify(statusAfterSetSession, null, 2));

    // Lifecycle stream sanity checks
    const lifecycleReasons = lifecycleEvents.map(e => e.reason).filter(Boolean);
    save("lifecycle-events.jsonl", lifecycleEvents.map(e => JSON.stringify(e)).join("\n"));
    save("lifecycle-reasons.txt", lifecycleReasons.join("\n"));
    const mustHave = [
      "sandbox_boot",
      "sandbox_ready",
      "run_start",
      "run_complete",
    ];
    if (supportsInterrupt) {
      mustHave.push("command_interrupted");
    }
    if (supportsPauseResume) {
      mustHave.push("sandbox_pause", "sandbox_resume");
    }
    for (const reason of mustHave) {
      if (!lifecycleReasons.includes(reason)) {
        throw new Error(`Missing lifecycle reason: ${reason}`);
      }
    }

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
