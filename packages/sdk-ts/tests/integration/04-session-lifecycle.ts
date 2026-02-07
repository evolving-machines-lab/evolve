#!/usr/bin/env tsx
/**
 * Integration Test 04: Session Lifecycle
 *
 * Full coverage of the session control plane:
 *  1. status() cold
 *  2. run() + lifecycle (sandbox_boot, sandbox_ready, run_start, run_complete)
 *  3. Multi-turn context
 *  4. interrupt() when idle
 *  5. interrupt() on executeCommand (command_interrupted)
 *  6. interrupt() on run() (run_interrupted)
 *  7. concurrent run() rejection
 *  8. foreground executeCommand success (command_complete)
 *  9. foreground executeCommand failure (command_failed)
 * 10. background executeCommand success (command_background_complete)
 * 11. background executeCommand failure (command_background_failed)
 * 12. background run() success (run_background_complete)
 * 13. background run() failure (run_background_failed)
 * 14. pause() / resume()
 * 15. withSession() reconnect (sandbox_connected)
 * 16. setSession() real switch to different live sandbox
 * 17. kill() + sandbox_killed + null session invariants
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
  console.log(`[04] ${msg}`);
}

function save(name: string, content: string) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

function assertEq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
  log(`  ✓ ${label}`);
}

function assertIncludes(arr: string[], value: string, label: string) {
  if (!arr.includes(value)) {
    throw new Error(`${label}: "${value}" not found in [${arr.join(", ")}]`);
  }
  log(`  ✓ ${label}`);
}

function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 90000,
  intervalMs = 250
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`);
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
  const events: LifecycleEvent[] = [];
  evolve.on("lifecycle", (e) => events.push(e));
  const reasons = () => events.map(e => e.reason);

  try {
    // ── 1. status() cold ──────────────────────────────────────────────
    log("\n── 1. status() cold");
    const s0 = evolve.status();
    assertEq(s0.sandbox, "stopped", "sandbox stopped");
    assertEq(s0.agent, "idle", "agent idle");
    assertEq(s0.hasRun, false, "hasRun false");
    assertEq(s0.sandboxId, null, "sandboxId null");

    // ── 2. run() + lifecycle + status ─────────────────────────────────
    log("\n── 2. run() + lifecycle + status");
    const run1 = await evolve.run({
      prompt: "Create a file called session-test.txt with the text 'Turn 1'.",
      timeoutMs: 180000,
    });
    assertEq(run1.exitCode, 0, "run1 exits 0");
    save("run1.txt", run1.stdout);

    const sessionId = evolve.getSession();
    if (!sessionId) throw new Error("getSession() null after run()");
    log(`  ✓ getSession() = ${sessionId}`);

    const s1 = evolve.status();
    assertEq(s1.sandbox, "ready", "sandbox ready after run");
    assertEq(s1.agent, "idle", "agent idle after run");
    assertEq(s1.hasRun, true, "hasRun true after run");

    assertIncludes(reasons(), "sandbox_boot", "lifecycle: sandbox_boot");
    assertIncludes(reasons(), "sandbox_ready", "lifecycle: sandbox_ready");
    assertIncludes(reasons(), "run_start", "lifecycle: run_start");
    assertIncludes(reasons(), "run_complete", "lifecycle: run_complete");

    // ── 3. Multi-turn context ─────────────────────────────────────────
    log("\n── 3. multi-turn context");
    const run2 = await evolve.run({
      prompt: "Append 'Turn 2' to session-test.txt.",
      timeoutMs: 180000,
    });
    assertEq(run2.exitCode, 0, "run2 exits 0");

    // ── 4. interrupt() when idle ──────────────────────────────────────
    log("\n── 4. interrupt() when idle");
    assertEq(await evolve.interrupt(), false, "returns false when idle");

    // ── 5. interrupt() on executeCommand ──────────────────────────────
    if (supportsInterrupt) {
      log("\n── 5. interrupt() on executeCommand");
      const longCmd = evolve.executeCommand("sleep 60", { timeoutMs: 180000 });
      await waitFor(
        () => evolve.status().agent === "running" && evolve.status().activeProcessId !== null,
        "active command for interrupt test"
      );
      assertEq(await evolve.interrupt(), true, "interrupt() true");
      const r = await longCmd;
      save("cmd-interrupted.json", JSON.stringify(r, null, 2));
      assertEq(evolve.status().sandbox, "ready", "sandbox ready after interrupt");
      assertEq(evolve.status().agent, "interrupted", "agent interrupted");
      assertIncludes(reasons(), "command_interrupted", "lifecycle: command_interrupted");
    } else {
      log("\n── 5. skipped (no interrupt support)");
    }

    // ── 6. interrupt() on run() ───────────────────────────────────────
    if (supportsInterrupt) {
      log("\n── 6. interrupt() on run()");
      const longRun = evolve.run({
        prompt: "Run this exact command and wait for it to finish: sleep 120",
        timeoutMs: 180000,
      });
      await waitFor(
        () => evolve.status().agent === "running" && evolve.status().activeProcessId !== null,
        "active run for interrupt test"
      );
      assertEq(await evolve.interrupt(), true, "interrupt() true on run");
      const rr = await longRun;
      save("run-interrupted.json", JSON.stringify(rr, null, 2));
      assertIncludes(reasons(), "run_interrupted", "lifecycle: run_interrupted");

      // Verify sandbox still works
      const recovery = await evolve.run({
        prompt: "Append 'After run interrupt' to session-test.txt.",
        timeoutMs: 180000,
      });
      assertEq(recovery.exitCode, 0, "run after run-interrupt exits 0");
    } else {
      log("\n── 6. skipped (no interrupt support)");
    }

    // ── 7. concurrent run() rejection ─────────────────────────────────
    if (supportsInterrupt) {
      log("\n── 7. concurrent run() rejection");
      const bg = evolve.executeCommand("sleep 30", { timeoutMs: 180000 });
      await waitFor(
        () => evolve.status().agent === "running" && evolve.status().activeProcessId !== null,
        "active command for concurrent run rejection"
      );
      let threw = false;
      try {
        await evolve.run({ prompt: "should fail", timeoutMs: 5000 });
      } catch (err) {
        threw = true;
        if (!(err instanceof Error && err.message.includes("already running"))) {
          throw err;
        }
      }
      assertEq(threw, true, "concurrent run() throws");
      await evolve.interrupt();
      await bg;
    } else {
      log("\n── 7. skipped (no interrupt support)");
    }

    // ── 8. foreground executeCommand success ──────────────────────────
    log("\n── 8. foreground executeCommand (command_complete)");
    const cmdOk = await evolve.executeCommand("echo hello", { timeoutMs: 30000 });
    assertEq(cmdOk.exitCode, 0, "echo exits 0");
    assertIncludes(reasons(), "command_complete", "lifecycle: command_complete");

    // ── 9. foreground executeCommand failure ──────────────────────────
    log("\n── 9. foreground executeCommand failure (command_failed)");
    const cmdFail = await evolve.executeCommand("false", { timeoutMs: 30000 });
    assertEq(cmdFail.exitCode === 0, false, "false gives non-zero");
    assertIncludes(reasons(), "command_failed", "lifecycle: command_failed");

    // ── 10. background executeCommand success ─────────────────────────
    log("\n── 10. background executeCommand (command_background_complete)");
    const bgOk = await evolve.executeCommand("echo bg-ok", { timeoutMs: 30000, background: true });
    assertEq(bgOk.exitCode, 0, "background handshake 0");
    await waitFor(
      () => reasons().includes("command_background_complete"),
      "command_background_complete event",
      30000
    );
    assertIncludes(reasons(), "command_background_complete", "lifecycle: command_background_complete");

    // ── 11. background executeCommand failure ─────────────────────────
    log("\n── 11. background executeCommand failure (command_background_failed)");
    const bgFail = await evolve.executeCommand("false", { timeoutMs: 30000, background: true });
    assertEq(bgFail.exitCode, 0, "background handshake 0");
    await waitFor(
      () => reasons().includes("command_background_failed"),
      "command_background_failed event",
      60000
    );
    assertIncludes(reasons(), "command_background_failed", "lifecycle: command_background_failed");

    // ── 12. background run() success ──────────────────────────────────
    log("\n── 12. background run() success (run_background_complete)");
    const bgRun = await evolve.run({
      prompt: "Say hello.",
      timeoutMs: 180000,
      background: true,
    });
    assertEq(bgRun.exitCode, 0, "background run handshake 0");
    await waitFor(
      () => reasons().includes("run_background_complete"),
      "run_background_complete event",
      120000
    );
    assertIncludes(reasons(), "run_background_complete", "lifecycle: run_background_complete");

    // ── 13. background run() failure ──────────────────────────────────
    log("\n── 13. background run() failure (run_background_failed)");
    const bgRunFail = await evolve.run({
      prompt: "Run this exact command and wait for it to finish: sleep 30",
      timeoutMs: 1000,
      background: true,
    });
    assertEq(bgRunFail.exitCode, 0, "background run-fail handshake 0");
    await waitFor(
      () => reasons().includes("run_background_failed"),
      "run_background_failed event",
      120000
    );
    assertIncludes(reasons(), "run_background_failed", "lifecycle: run_background_failed");

    // ── 14. pause / resume ────────────────────────────────────────────
    if (supportsPauseResume) {
      log("\n── 14. pause() / resume()");
      await evolve.pause();
      assertEq(evolve.status().sandbox, "paused", "sandbox paused");
      assertEq(evolve.status().agent, "idle", "agent idle while paused");
      assertIncludes(reasons(), "sandbox_pause", "lifecycle: sandbox_pause");
      await evolve.resume();
      assertEq(evolve.status().sandbox, "ready", "sandbox ready after resume");
      assertIncludes(reasons(), "sandbox_resume", "lifecycle: sandbox_resume");

      const runResume = await evolve.run({
        prompt: "Append 'After pause/resume' to session-test.txt.",
        timeoutMs: 180000,
      });
      assertEq(runResume.exitCode, 0, "run after resume exits 0");
    } else {
      log("\n── 14. skipped (no pause support)");
    }

    // ── 15. withSession() reconnect ───────────────────────────────────
    log("\n── 15. withSession() reconnect (sandbox_connected)");
    const events2: LifecycleEvent[] = [];
    const evolve2 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withSession(sessionId);
    evolve2.on("lifecycle", (e) => events2.push(e));

    const run4 = await evolve2.run({
      prompt: "Append 'Reconnected' to session-test.txt and show its contents.",
      timeoutMs: 180000,
    });
    assertEq(run4.exitCode, 0, "reconnected run exits 0");
    save("run4.txt", run4.stdout);
    assertIncludes(events2.map(e => e.reason), "sandbox_connected", "lifecycle: sandbox_connected");

    // ── 16. setSession() real switch ──────────────────────────────────
    log("\n── 16. setSession() real switch to different sandbox");
    const evolve3 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider);
    const run5 = await evolve3.run({
      prompt: "Create file alt-session.txt with text 'alt'.",
      timeoutMs: 180000,
    });
    assertEq(run5.exitCode, 0, "new sandbox run exits 0");
    const altSessionId = evolve3.getSession();
    if (!altSessionId) throw new Error("altSessionId is null");
    if (altSessionId === sessionId) {
      throw new Error("altSessionId must be different from original sessionId");
    }
    await evolve2.setSession(altSessionId);
    assertEq(evolve2.status().sandbox, "ready", "ready after setSession");
    assertEq(evolve2.status().sandboxId, altSessionId, "sandboxId switched to alt session");
    const run6 = await evolve2.run({
      prompt: "Append 'switched-session' to alt-session.txt and show file contents.",
      timeoutMs: 180000,
    });
    assertEq(run6.exitCode, 0, "run after setSession switch exits 0");

    // ── 17. kill() + null session invariants ──────────────────────────
    log("\n── 17. kill() + sandbox_killed + null session invariants");
    await evolve2.kill();
    assertEq(evolve2.status().sandbox, "stopped", "stopped after kill");
    assertEq(evolve2.status().agent, "idle", "idle after kill");
    assertEq(evolve2.status().hasRun, false, "hasRun false after kill");
    assertEq(evolve2.status().sandboxId, null, "sandboxId null after kill");
    assertEq(evolve2.getSession(), null, "getSession() null after kill");
    assertIncludes(events2.map(e => e.reason), "sandbox_killed", "lifecycle: sandbox_killed");

    // Cleanup remaining original session sandbox
    await evolve.kill();
    await evolve3.kill().catch(() => {});

    // ── Save all events ───────────────────────────────────────────────
    save("lifecycle-events.jsonl", events.map(e => JSON.stringify(e)).join("\n"));
    save("lifecycle-events-2.jsonl", events2.map(e => JSON.stringify(e)).join("\n"));

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`PASS - All 17 tests passed (${duration}s)`);
    log(`============================================================\n`);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save("error.txt", err instanceof Error ? err.stack || msg : msg);
    save("lifecycle-events.jsonl", events.map(e => JSON.stringify(e)).join("\n"));
    await evolve.kill().catch(() => {});

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`FAIL - ${msg} (${duration}s)`);
    log(`============================================================\n`);
    process.exit(1);
  }
}

main();
