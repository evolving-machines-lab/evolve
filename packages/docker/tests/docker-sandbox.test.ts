#!/usr/bin/env tsx
/**
 * Docker Sandbox Integration Tests
 *
 * Exercises the full Docker sandbox lifecycle: create, run commands,
 * file I/O, background processes, pause/connect, and cleanup.
 *
 * Requires: Docker daemon running locally.
 * Image: ubuntu:latest (lightweight, universally available)
 */

import {
  createDockerProvider,
  DockerProvider,
  type SandboxInstance,
  type SandboxProvider,
} from "../src/index";

// ─── Test helpers ────────────────────────────────────────────

let passed = 0;
let failed = 0;
const containers: string[] = []; // track for cleanup

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
  image = "ubuntu:latest"
): Promise<void> {
  const sandbox = await provider.create({ image });
  containers.push(sandbox.sandboxId);
  try {
    await fn(sandbox);
  } finally {
    await sandbox.kill().catch(() => {});
  }
}

async function cleanup(): Promise<void> {
  // Remove any leaked evolve-* containers
  const { execFileSync } = await import("node:child_process");
  try {
    const ids = execFileSync("docker", [
      "ps", "-aq", "--filter", "label=evolve.managed=true",
    ], { encoding: "utf-8" }).trim();
    if (ids) {
      execFileSync("docker", ["rm", "-f", ...ids.split("\n")], {
        stdio: "pipe",
      });
    }
  } catch {
    // ignore
  }
}

// ─── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("\n═══ Docker Sandbox Integration Tests ═══\n");

  // ───────────────────────────────────────────────────────────
  console.log("[1] Provider creation");
  // ───────────────────────────────────────────────────────────

  const provider = createDockerProvider({ imageName: "ubuntu:latest" });
  assert(provider !== null && provider !== undefined, "createDockerProvider succeeds");
  assertEqual(provider.providerType, "docker", 'providerType === "docker"');
  assertEqual((provider as DockerProvider).name, "Docker", 'name === "Docker"');

  // ───────────────────────────────────────────────────────────
  console.log("\n[2] Container lifecycle");
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
    assert(processes.length > 0, "list() returns running processes (at least sleep infinity)");
    assert(processes.some((p) => p.cmd.includes("sleep")), "list() includes sleep process");
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n[7] Pause and connect");
  // ───────────────────────────────────────────────────────────

  // Manual lifecycle — don't use withSandbox since we need control over kill
  const pauseSandbox = await provider.create({ image: "ubuntu:latest" });
  containers.push(pauseSandbox.sandboxId);
  try {
    // Write state before pause
    await pauseSandbox.files.write("/tmp/state.txt", "pre-pause");

    // Pause
    await pauseSandbox.pause();
    assert(true, "pause() succeeds");

    // Connect (resumes paused container)
    const resumed = await provider.connect(pauseSandbox.sandboxId);
    assert(resumed !== null, "connect() resumes paused container");

    // Verify state persisted
    const state = await resumed.commands.run("cat /tmp/state.txt");
    assertEqual(state.stdout.trim(), "pre-pause", "state persists after pause/resume");

    // Commands still work
    const after = await resumed.commands.run("echo post-resume");
    assertEqual(after.stdout.trim(), "post-resume", "commands work after resume");
  } finally {
    await pauseSandbox.kill().catch(() => {});
  }

  // ───────────────────────────────────────────────────────────
  console.log("\n[8] Container cleanup");
  // ───────────────────────────────────────────────────────────

  const killSandbox = await provider.create({ image: "ubuntu:latest" });
  const killId = killSandbox.sandboxId;
  await killSandbox.kill();
  assert(true, "kill() removes container");

  await assertThrows(
    () => provider.connect(killId),
    "not found",
    "connect() to killed container throws"
  );

  // ─── Summary ───────────────────────────────────────────────

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);

  await cleanup();

  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("Test suite error:", err);
  await cleanup();
  process.exit(1);
});
