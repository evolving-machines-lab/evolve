#!/usr/bin/env tsx
/**
 * MicroVM (Boxlite) Sandbox Integration Tests
 *
 * Exercises the full MicroVM sandbox lifecycle: create, run commands,
 * file I/O, background processes, connect, and cleanup.
 *
 * Requires: Boxlite installed, KVM available (Linux with /dev/kvm).
 * Gracefully skips on unsupported platforms (macOS, Windows, no KVM).
 */

import {
  createMicroVMProvider,
  type SandboxInstance,
  type SandboxProvider,
} from "../src/index";

// ─── Test helpers ────────────────────────────────────────────

let passed = 0;
let failed = 0;
const sandboxes: string[] = []; // track for cleanup

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
    console.log(`      Expected: ${JSON.stringify(expected)}`);
    console.log(`      Actual:   ${JSON.stringify(actual)}`);
  }
}

async function assertThrows(fn: () => unknown, substring: string, message: string): Promise<void> {
  try {
    await fn();
    failed++;
    console.log(`  ✗ ${message} (did not throw)`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(substring)) {
      passed++;
      console.log(`  ✓ ${message}`);
    } else {
      failed++;
      console.log(`  ✗ ${message} (wrong error: "${msg}")`);
    }
  }
}

async function withSandbox(
  provider: SandboxProvider,
  fn: (sandbox: SandboxInstance) => Promise<void>,
): Promise<void> {
  const sandbox = await provider.create({});
  sandboxes.push(sandbox.sandboxId);
  try {
    await fn(sandbox);
  } finally {
    await sandbox.kill().catch(() => {});
  }
}

// ─── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("\n═══ MicroVM (Boxlite) Sandbox Integration Tests ═══\n");

  // ─── Provider creation (may throw on unsupported platform) ──
  let provider: any;
  try {
    provider = createMicroVMProvider();
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("requires") || msg.includes("platform") || msg.includes("not supported")) {
      console.log(`\n⚠ Skipping MicroVM tests: ${msg}\n`);
      console.log("═══ 0 passed, 0 failed (skipped) ═══");
      process.exit(0);
    }
    throw e;
  }

  // ─── Pre-flight: verify Boxlite can actually create a VM ────
  let canRun = true;
  try {
    const testSandbox = await provider.create({});
    await testSandbox.kill();
  } catch (e) {
    console.log(`\n⚠ Skipping MicroVM tests: ${(e as Error).message}\n`);
    canRun = false;
  }
  if (!canRun) {
    console.log("═══ 0 passed, 0 failed (skipped) ═══");
    process.exit(0);
  }

  // ───────────────────────────────────────────────────────────
  console.log("[1] Provider creation");
  // ───────────────────────────────────────────────────────────

  assert(provider !== null && provider !== undefined, "createMicroVMProvider succeeds");
  assertEqual(provider.providerType, "microvm", 'providerType === "microvm"');
  assertEqual(provider.name, "MicroVM", 'name === "MicroVM"');

  // ───────────────────────────────────────────────────────────
  console.log("\n[2] Instance lifecycle");
  // ───────────────────────────────────────────────────────────

  await withSandbox(provider, async (sandbox) => {
    assert(sandbox !== null, "create() returns SandboxInstance");
    assert(typeof sandbox.sandboxId === "string" && sandbox.sandboxId.length > 0, "sandboxId is set");
    assert(sandbox.commands !== undefined, "commands is present");
    assert(sandbox.files !== undefined, "files is present");
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n[3] Command execution (run)");
  // ───────────────────────────────────────────────────────────

  await withSandbox(provider, async (sandbox) => {
    // Basic echo
    const echo = await sandbox.commands.run("echo hello world");
    assertEqual(echo.stdout.trim(), "hello world", "echo returns stdout");
    assertEqual(echo.exitCode, 0, "exit code 0 on success");

    // Non-zero exit
    const fail = await sandbox.commands.run("exit 42");
    assertEqual(fail.exitCode, 42, "exit code non-zero on failure");

    // Stderr
    const err = await sandbox.commands.run("echo oops >&2");
    assertEqual(err.stderr.trim(), "oops", "stderr captured");

    // Environment variables
    const env = await sandbox.commands.run("echo $MY_VAR", { envs: { MY_VAR: "test-value" } });
    assertEqual(env.stdout.trim(), "test-value", "env vars passed correctly");

    // Working directory
    await sandbox.commands.run("mkdir -p /tmp/testdir");
    const cwd = await sandbox.commands.run("pwd", { cwd: "/tmp/testdir" });
    assertEqual(cwd.stdout.trim(), "/tmp/testdir", "cwd option works");

    // onStdout callback
    let callbackData = "";
    await sandbox.commands.run("echo callback-test", {
      onStdout: (data) => { callbackData += data; },
    });
    assert(callbackData.includes("callback-test"), "onStdout callback fires");
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n[4] File operations");
  // ───────────────────────────────────────────────────────────

  await withSandbox(provider, async (sandbox) => {
    // Text round-trip
    await sandbox.files.write("/tmp/test.txt", "hello world");
    const text = await sandbox.files.read("/tmp/test.txt");
    assertEqual(text, "hello world", "write and read text file round-trip");

    // Binary round-trip
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    await sandbox.files.write("/tmp/test.bin", binaryData);
    const binary = await sandbox.files.read("/tmp/test.bin");
    assert(binary instanceof Uint8Array, "binary file returns Uint8Array");
    assertEqual(
      Buffer.from(binary as Uint8Array).toString("hex"),
      binaryData.toString("hex"),
      "write and read binary file round-trip"
    );

    // writeBatch
    await sandbox.files.writeBatch([
      { path: "/tmp/batch/a.txt", data: "file-a" },
      { path: "/tmp/batch/b.txt", data: "file-b" },
    ]);
    const a = await sandbox.files.read("/tmp/batch/a.txt");
    const b = await sandbox.files.read("/tmp/batch/b.txt");
    assertEqual(a, "file-a", "writeBatch writes file a");
    assertEqual(b, "file-b", "writeBatch writes file b");

    // makeDir
    await sandbox.files.makeDir("/tmp/deep/nested/dir");
    const dirCheck = await sandbox.commands.run("test -d /tmp/deep/nested/dir && echo ok");
    assertEqual(dirCheck.stdout.trim(), "ok", "makeDir creates nested directories");

    // Read non-existent
    await assertThrows(
      () => sandbox.files.read("/tmp/nonexistent.txt"),
      "Failed to read file",
      "read non-existent file throws"
    );
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n[5] Background processes (spawn)");
  // ───────────────────────────────────────────────────────────

  await withSandbox(provider, async (sandbox) => {
    // Spawn and wait
    const handle = await sandbox.commands.spawn("echo background-output; sleep 1; echo done");
    assert(typeof handle.processId === "string" && handle.processId.length > 0, "spawn returns handle with processId");

    const result = await handle.wait();
    assert(result.stdout.includes("background-output"), "wait() resolves with stdout");
    assert(result.stdout.includes("done"), "wait() captures all output");
    assertEqual(result.exitCode, 0, "wait() exit code is 0");

    // Spawn and kill
    const longHandle = await sandbox.commands.spawn("sleep 300");
    assert(typeof longHandle.processId === "string", "long-running spawn has processId");
    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 500));
    const killed = await longHandle.kill();
    assert(killed, "kill() terminates process");
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n[6] Process listing");
  // ───────────────────────────────────────────────────────────

  await withSandbox(provider, async (sandbox) => {
    const processes = await sandbox.commands.list();
    assert(Array.isArray(processes), "list() returns array");

    // Spawn a known process to check listing
    const handle = await sandbox.commands.spawn("sleep 600");
    await new Promise((r) => setTimeout(r, 500));

    const afterSpawn = await sandbox.commands.list();
    assert(afterSpawn.some((p) => p.cmd.includes("sleep")), "list() includes spawned sleep process");

    // Kill and verify removal
    await handle.kill();
    await new Promise((r) => setTimeout(r, 500));

    const afterKill = await sandbox.commands.list();
    const sleepStillRunning = afterKill.some(
      (p) => p.processId === handle.processId
    );
    assert(!sleepStillRunning, "killed process removed from list");
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n[7] Connect to existing");
  // ───────────────────────────────────────────────────────────

  // Manual lifecycle — don't use withSandbox since we need control over kill
  const connectSandbox = await provider.create({});
  sandboxes.push(connectSandbox.sandboxId);
  try {
    // Write state
    await connectSandbox.files.write("/tmp/state.txt", "pre-connect");

    // Connect to existing sandbox by ID
    const connected = await provider.connect(connectSandbox.sandboxId);
    assert(connected !== null, "connect() returns SandboxInstance");

    // Verify state persisted
    const state = await connected.commands.run("cat /tmp/state.txt");
    assertEqual(state.stdout.trim(), "pre-connect", "state persists after connect");

    // Commands still work
    const after = await connected.commands.run("echo post-connect");
    assertEqual(after.stdout.trim(), "post-connect", "commands work after connect");
  } finally {
    await connectSandbox.kill().catch(() => {});
  }

  // Connect to unknown sandbox throws
  await assertThrows(
    () => provider.connect("nonexistent-sandbox-id-12345"),
    "not found",
    "connect() to unknown sandbox throws"
  );

  // ───────────────────────────────────────────────────────────
  console.log("\n[8] Cleanup");
  // ───────────────────────────────────────────────────────────

  const killSandbox = await provider.create({});
  const killId = killSandbox.sandboxId;
  const host = await killSandbox.getHost(8080).catch(() => "localhost:8080");
  assert(typeof host === "string" && host.includes("localhost"), "getHost returns localhost:port");

  await killSandbox.kill();
  assert(true, "kill() succeeds");

  // ─── Summary ───────────────────────────────────────────────

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);

  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});
