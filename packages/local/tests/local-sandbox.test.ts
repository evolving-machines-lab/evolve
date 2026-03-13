#!/usr/bin/env tsx
/**
 * Local Sandbox Integration Tests
 *
 * Exercises the local sandbox lifecycle: create, run commands,
 * file I/O, background processes, connect, and cleanup.
 *
 * No external dependencies required — runs on any platform.
 */

import {
  createLocalProvider,
  LocalProvider,
  type SandboxInstance,
  type SandboxProvider,
} from "../src/index";

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ─── Test helpers ────────────────────────────────────────────

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

function testDir(): string {
  return path.join("/tmp", `evolve-test-${randomUUID()}`);
}

async function withSandbox(
  provider: SandboxProvider,
  fn: (sandbox: SandboxInstance) => Promise<void>,
): Promise<void> {
  const tmpDir = testDir();
  await fs.mkdir(tmpDir, { recursive: true });
  const sandbox = await provider.create({ workingDirectory: tmpDir });
  try {
    await fn(sandbox);
  } finally {
    await sandbox.kill().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("\n═══ Local Sandbox Integration Tests ═══\n");

  // ───────────────────────────────────────────────────────────
  console.log("[1] Provider creation");
  // ───────────────────────────────────────────────────────────

  const provider = createLocalProvider();
  assert(provider !== null && provider !== undefined, "createLocalProvider succeeds");
  assertEqual(provider.providerType, "local", 'providerType === "local"');
  assertEqual((provider as LocalProvider).name, "Local", 'name === "Local"');

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

    // Working directory (use realpath to handle macOS /tmp → /private/tmp symlink)
    const tmpCwd = testDir();
    await fs.mkdir(tmpCwd, { recursive: true });
    const realTmpCwd = await fs.realpath(tmpCwd);
    try {
      const cwd = await sandbox.commands.run("pwd", { cwd: tmpCwd });
      assertEqual(cwd.stdout.trim(), realTmpCwd, "cwd option works");
    } finally {
      await fs.rm(tmpCwd, { recursive: true, force: true }).catch(() => {});
    }

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
    const textFile = path.join("/tmp", `evolve-test-${randomUUID()}`, "test.txt");
    await sandbox.files.write(textFile, "hello world");
    const text = await sandbox.files.read(textFile);
    assertEqual(text, "hello world", "write and read text file round-trip");

    // Binary round-trip
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    const binFile = path.join("/tmp", `evolve-test-${randomUUID()}`, "test.bin");
    await sandbox.files.write(binFile, binaryData);
    const binary = await sandbox.files.read(binFile);
    assert(binary instanceof Uint8Array, "binary file returns Uint8Array");
    assertEqual(
      Buffer.from(binary as Uint8Array).toString("hex"),
      binaryData.toString("hex"),
      "write and read binary file round-trip"
    );

    // writeBatch
    const batchDir = path.join("/tmp", `evolve-test-${randomUUID()}`);
    await sandbox.files.writeBatch([
      { path: path.join(batchDir, "a.txt"), data: "file-a" },
      { path: path.join(batchDir, "b.txt"), data: "file-b" },
    ]);
    const a = await sandbox.files.read(path.join(batchDir, "a.txt"));
    const b = await sandbox.files.read(path.join(batchDir, "b.txt"));
    assertEqual(a, "file-a", "writeBatch writes file a");
    assertEqual(b, "file-b", "writeBatch writes file b");

    // makeDir
    const deepDir = path.join("/tmp", `evolve-test-${randomUUID()}`, "deep", "nested", "dir");
    await sandbox.files.makeDir(deepDir);
    const stat = await fs.stat(deepDir);
    assert(stat.isDirectory(), "makeDir creates nested directories");

    // Read non-existent
    await assertThrows(
      () => sandbox.files.read(path.join("/tmp", `nonexistent-${randomUUID()}`, "nope.txt")),
      "Failed to read file",
      "read non-existent file throws"
    );
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n[5] Background processes (spawn)");
  // ───────────────────────────────────────────────────────────

  await withSandbox(provider, async (sandbox) => {
    // Spawn and wait
    const handle = await sandbox.commands.spawn("echo background-output; sleep 0.5; echo done");
    assert(typeof handle.processId === "string" && handle.processId.length > 0, "spawn returns handle with processId");

    const result = await handle.wait();
    assert(result.stdout.includes("background-output"), "wait() resolves with stdout");
    assert(result.stdout.includes("done"), "wait() captures all output");
    assertEqual(result.exitCode, 0, "wait() exit code is 0");

    // Spawn and kill
    const longHandle = await sandbox.commands.spawn("sleep 300");
    assert(typeof longHandle.processId === "string", "long-running spawn has processId");
    await new Promise((r) => setTimeout(r, 200));
    const killed = await longHandle.kill();
    assert(killed, "kill() terminates process");
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n[6] Connect and cleanup");
  // ───────────────────────────────────────────────────────────

  const tmpDir = testDir();
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    const sandbox = await provider.create({ workingDirectory: tmpDir });

    // Connect by sandboxId
    const connected = await provider.connect(sandbox.sandboxId);
    assert(connected !== null, "connect(sandboxId) returns instance");

    // getHost
    const host = await sandbox.getHost(8080);
    assertEqual(host, "localhost:8080", "getHost returns localhost:port");

    // Kill and verify cleanup
    await sandbox.kill();
    assert(true, "kill() succeeds");

    // Connect to killed instance throws
    await assertThrows(
      () => provider.connect(sandbox.sandboxId),
      "not found",
      "connect to killed instance throws"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // ─── Summary ───────────────────────────────────────────────

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);

  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});
