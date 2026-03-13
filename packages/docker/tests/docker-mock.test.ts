#!/usr/bin/env tsx
/**
 * Docker Provider — Mock Tests
 *
 * Exercises the full Docker provider without a running Docker daemon.
 * Uses a mock `docker` shell script that simulates the Docker CLI
 * using temp directories as container filesystems.
 *
 * This enables CI/local testing of all Docker provider code paths
 * including: container lifecycle, command execution, file operations
 * (tar-stream → docker cp), background processes, pause/resume,
 * connect, and cleanup.
 */

import {
  createDockerProvider,
  DockerProvider,
  type SandboxInstance,
  type SandboxProvider,
} from "../src/index";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Mock setup ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOCK_SCRIPT = path.join(__dirname, "mock-docker.sh");
const MOCK_BIN_DIR = path.join("/tmp", `mock-docker-bin-${randomUUID()}`);
const MOCK_DOCKER_ROOT = path.join("/tmp", `mock-docker-root-${randomUUID()}`);
const ORIGINAL_PATH = process.env.PATH;

async function setupMock(): Promise<void> {
  await fs.mkdir(MOCK_BIN_DIR, { recursive: true });
  await fs.mkdir(MOCK_DOCKER_ROOT, { recursive: true });

  // Copy mock script as "docker" binary
  await fs.copyFile(MOCK_SCRIPT, path.join(MOCK_BIN_DIR, "docker"));
  await fs.chmod(path.join(MOCK_BIN_DIR, "docker"), 0o755);

  // Prepend mock dir to PATH so our mock is found first
  process.env.PATH = `${MOCK_BIN_DIR}:${ORIGINAL_PATH}`;
  process.env.MOCK_DOCKER_ROOT = MOCK_DOCKER_ROOT;
}

async function teardownMock(): Promise<void> {
  process.env.PATH = ORIGINAL_PATH!;
  delete process.env.MOCK_DOCKER_ROOT;
  await fs.rm(MOCK_BIN_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(MOCK_DOCKER_ROOT, { recursive: true, force: true }).catch(() => {});
}

// ─── Test framework ──────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.log(`  ✗ ${message}`); }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) { passed++; console.log(`  ✓ ${message}`); }
  else {
    failed++;
    console.log(`  ✗ ${message}`);
    console.log(`      Expected: ${JSON.stringify(expected)}`);
    console.log(`      Actual:   ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) { passed++; console.log(`  ✓ ${message}`); }
  else {
    failed++;
    console.log(`  ✗ ${message}`);
    console.log(`      Expected to include: ${JSON.stringify(needle)}`);
    console.log(`      Got: ${JSON.stringify(haystack.slice(0, 200))}`);
  }
}

async function assertThrows(fn: () => unknown, substring: string, message: string): Promise<void> {
  try { await fn(); failed++; console.log(`  ✗ ${message} (did not throw)`); }
  catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(substring)) { passed++; console.log(`  ✓ ${message}`); }
    else { failed++; console.log(`  ✗ ${message} (wrong error: "${msg.slice(0, 200)}")`); }
  }
}

async function withSandbox(
  provider: SandboxProvider,
  fn: (sandbox: SandboxInstance) => Promise<void>,
  image = "ubuntu:latest"
): Promise<void> {
  const sandbox = await provider.create({ image });
  try {
    await fn(sandbox);
  } finally {
    await sandbox.kill().catch(() => {});
  }
}

// ─── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("\n═══ Docker Provider — Mock Tests ═══\n");

  await setupMock();

  try {
    // ─── 1. Factory & Provider ─────────────────────────────────
    console.log("[1] Factory & Provider");

    const provider = createDockerProvider();
    assert(provider !== null, "createDockerProvider succeeds with mock");
    assertEqual(provider.providerType, "docker", "providerType is 'docker'");
    assertEqual((provider as DockerProvider).name, "Docker", "name is 'Docker'");

    // Custom configs
    const customImg = createDockerProvider({ imageName: "my-image" });
    assert(customImg.providerType === "docker", "custom imageName accepted");
    const customTimeout = createDockerProvider({ defaultTimeoutMs: 30000 });
    assert(customTimeout.providerType === "docker", "custom timeout accepted");

    // ─── 2. Container lifecycle ────────────────────────────────
    console.log("\n[2] Container lifecycle");

    await withSandbox(provider, async (sandbox) => {
      assert(typeof sandbox.sandboxId === "string", "sandboxId is string");
      assert(sandbox.sandboxId.startsWith("evolve-"), "sandboxId has evolve- prefix");
      assert(sandbox.sandboxId.length > 7, "sandboxId has random suffix");

      // Full interface present
      assert(typeof sandbox.commands.run === "function", "commands.run exists");
      assert(typeof sandbox.commands.spawn === "function", "commands.spawn exists");
      assert(typeof sandbox.commands.list === "function", "commands.list exists");
      assert(typeof sandbox.commands.kill === "function", "commands.kill exists");
      assert(typeof sandbox.files.read === "function", "files.read exists");
      assert(typeof sandbox.files.write === "function", "files.write exists");
      assert(typeof sandbox.files.writeBatch === "function", "files.writeBatch exists");
      assert(typeof sandbox.files.makeDir === "function", "files.makeDir exists");
      assert(typeof sandbox.getHost === "function", "getHost exists");
      assert(typeof sandbox.kill === "function", "kill exists");
      assert(typeof sandbox.pause === "function", "pause exists");
    });

    // Non-existent image
    await assertThrows(
      () => provider.create({ image: "nonexistent-image-xyz:latest" }),
      "not found",
      "non-existent image throws"
    );

    // ─── 3. Command execution ──────────────────────────────────
    console.log("\n[3] Command execution");

    await withSandbox(provider, async (sandbox) => {
      // Basic echo
      const echo = await sandbox.commands.run("echo hello docker-mock");
      assertEqual(echo.stdout.trim(), "hello docker-mock", "echo works");
      assertEqual(echo.exitCode, 0, "exit code 0 on success");

      // Non-zero exit
      const fail = await sandbox.commands.run("exit 42");
      assertEqual(fail.exitCode, 42, "non-zero exit code captured");

      // Stderr
      const err = await sandbox.commands.run("echo error-msg >&2");
      assertEqual(err.stderr.trim(), "error-msg", "stderr captured");

      // Environment variables
      const env = await sandbox.commands.run("echo $MY_VAR", { envs: { MY_VAR: "mock-value" } });
      assertEqual(env.stdout.trim(), "mock-value", "env vars passed correctly");

      // Multiple env vars
      const multi = await sandbox.commands.run("echo $A $B", { envs: { A: "x", B: "y" } });
      assertEqual(multi.stdout.trim(), "x y", "multiple env vars work");

      // Working directory
      await sandbox.commands.run("mkdir -p /workspace/subdir");
      const cwd = await sandbox.commands.run("pwd", { cwd: "/workspace/subdir" });
      assertEqual(cwd.stdout.trim(), "/workspace/subdir", "cwd option works");

      // Pipeline
      const pipe = await sandbox.commands.run("echo HELLO | tr A-Z a-z");
      assertEqual(pipe.stdout.trim(), "hello", "pipeline works");

      // Multi-line output
      const multiLine = await sandbox.commands.run("echo line1; echo line2; echo line3");
      assertEqual(multiLine.stdout.trim().split("\n").length, 3, "multi-line output");

      // onStdout callback
      let cbData = "";
      await sandbox.commands.run("echo callback-output", { onStdout: (d) => { cbData += d; } });
      assertIncludes(cbData, "callback-output", "onStdout callback fires");

      // onStderr callback
      let errData = "";
      await sandbox.commands.run("echo err-cb >&2", { onStderr: (d) => { errData += d; } });
      assertIncludes(errData, "err-cb", "onStderr callback fires");

      // Special characters
      const special = await sandbox.commands.run("echo 'hello \"world\" $FOO'");
      assertIncludes(special.stdout, "hello", "special characters handled");

      // Empty command
      const empty = await sandbox.commands.run("true");
      assertEqual(empty.exitCode, 0, "empty/true command succeeds");
    });

    // ─── 4. File operations ────────────────────────────────────
    console.log("\n[4] File operations");

    await withSandbox(provider, async (sandbox) => {
      // Text write and read
      await sandbox.files.write("/tmp/hello.txt", "hello mock-docker");
      const text = await sandbox.files.read("/tmp/hello.txt");
      assertEqual(text, "hello mock-docker", "text file round-trip");

      // Binary write and read
      const binData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      await sandbox.files.write("/tmp/test.bin", binData);
      const binRead = await sandbox.files.read("/tmp/test.bin");
      assert(binRead instanceof Uint8Array, "binary file returns Uint8Array");
      assertEqual(
        Buffer.from(binRead as Uint8Array).toString("hex"),
        binData.toString("hex"),
        "binary content preserved"
      );

      // UTF-8 content
      const utf8 = "日本語テスト 🎉 Héllo";
      await sandbox.files.write("/tmp/utf8.txt", utf8);
      const utf8Read = await sandbox.files.read("/tmp/utf8.txt");
      assertEqual(utf8Read, utf8, "UTF-8 content preserved");

      // Deep nested directory creation via write
      await sandbox.files.write("/tmp/deep/nested/path/file.txt", "deep-content");
      const deep = await sandbox.files.read("/tmp/deep/nested/path/file.txt");
      assertEqual(deep, "deep-content", "deeply nested write creates dirs");

      // Overwrite
      await sandbox.files.write("/tmp/hello.txt", "overwritten");
      const overwritten = await sandbox.files.read("/tmp/hello.txt");
      assertEqual(overwritten, "overwritten", "overwrite replaces content");

      // writeBatch
      await sandbox.files.writeBatch([
        { path: "/tmp/batch/a.txt", data: "file-A" },
        { path: "/tmp/batch/b.txt", data: "file-B" },
        { path: "/tmp/batch/c.txt", data: "file-C" },
      ]);
      const a = await sandbox.files.read("/tmp/batch/a.txt");
      const b = await sandbox.files.read("/tmp/batch/b.txt");
      const c = await sandbox.files.read("/tmp/batch/c.txt");
      assertEqual(a, "file-A", "writeBatch file a");
      assertEqual(b, "file-B", "writeBatch file b");
      assertEqual(c, "file-C", "writeBatch file c");

      // Empty writeBatch
      await sandbox.files.writeBatch([]);
      assert(true, "empty writeBatch succeeds");

      // makeDir
      await sandbox.files.makeDir("/tmp/newdir/sub1/sub2");
      const mkdirCheck = await sandbox.commands.run("test -d /tmp/newdir/sub1/sub2 && echo ok");
      assertEqual(mkdirCheck.stdout.trim(), "ok", "makeDir creates nested dirs");

      // makeDir idempotent
      await sandbox.files.makeDir("/tmp/newdir/sub1/sub2");
      assert(true, "makeDir idempotent");

      // Read non-existent file
      await assertThrows(
        () => sandbox.files.read("/tmp/totally-nonexistent.txt"),
        "Failed to read file",
        "read non-existent file throws"
      );

      // Uint8Array input
      const u8 = new Uint8Array([10, 20, 30, 40]);
      await sandbox.files.write("/tmp/u8.bin", u8);
      const u8Read = await sandbox.files.read("/tmp/u8.bin");
      assert(u8Read instanceof Uint8Array, "Uint8Array input writes binary");
      assertEqual(
        Buffer.from(u8Read as Uint8Array).toString("hex"),
        Buffer.from(u8).toString("hex"),
        "Uint8Array content preserved"
      );

      // Large file
      const largeContent = "x".repeat(100_000);
      await sandbox.files.write("/tmp/large.txt", largeContent);
      const largeRead = await sandbox.files.read("/tmp/large.txt");
      assertEqual((largeRead as string).length, 100_000, "large file preserved");
    });

    // ─── 5. Background processes ───────────────────────────────
    console.log("\n[5] Background processes");

    await withSandbox(provider, async (sandbox) => {
      // Spawn and wait
      const handle = await sandbox.commands.spawn("echo bg-output; sleep 0.5; echo done");
      assert(typeof handle.processId === "string", "spawn returns processId");
      assert(handle.processId.length > 0, "processId is non-empty");

      const result = await handle.wait();
      assertIncludes(result.stdout, "bg-output", "wait() captures stdout");
      assertIncludes(result.stdout, "done", "wait() captures all output");
      assertEqual(result.exitCode, 0, "spawn exit code 0");

      // Spawn with non-zero exit
      const failHandle = await sandbox.commands.spawn("exit 7");
      const failResult = await failHandle.wait();
      assertEqual(failResult.exitCode, 7, "spawn captures non-zero exit");

      // Spawn and kill
      const longHandle = await sandbox.commands.spawn("sleep 300");
      assert(typeof longHandle.processId === "string", "long spawn has processId");
      await new Promise((r) => setTimeout(r, 200));
      const killed = await longHandle.kill();
      assert(killed, "kill() terminates background process");

      // Process list
      const procs = await sandbox.commands.list();
      assert(Array.isArray(procs), "list() returns array");
      assert(procs.length > 0, "list() has processes");
    });

    // ─── 6. Pause / Resume ─────────────────────────────────────
    console.log("\n[6] Pause / Resume");

    const pauseSandbox = await provider.create({ image: "ubuntu:latest" });
    try {
      // Write state
      await pauseSandbox.files.write("/tmp/state.txt", "pre-pause");

      // Pause
      await pauseSandbox.pause();
      assert(true, "pause() succeeds");

      // Connect (auto-resumes paused container)
      const resumed = await provider.connect(pauseSandbox.sandboxId);
      assert(resumed !== null, "connect() returns instance for paused container");

      // Verify state persisted
      const state = await resumed.commands.run("cat /tmp/state.txt");
      assertEqual(state.stdout.trim(), "pre-pause", "state preserved after pause/resume");

      // Commands work after resume
      const postResume = await resumed.commands.run("echo resumed");
      assertEqual(postResume.stdout.trim(), "resumed", "commands work after resume");
    } finally {
      await pauseSandbox.kill().catch(() => {});
    }

    // ─── 7. Connect edge cases ─────────────────────────────────
    console.log("\n[7] Connect edge cases");

    // Connect to non-existent container
    await assertThrows(
      () => provider.connect("totally-fake-container-id"),
      "not found",
      "connect to non-existent throws"
    );

    // Connect to running container
    const runningSandbox = await provider.create({ image: "ubuntu:latest" });
    try {
      const connected = await provider.connect(runningSandbox.sandboxId);
      assert(connected !== null, "connect to running container works");
      const echo = await connected.commands.run("echo connected");
      assertEqual(echo.stdout.trim(), "connected", "connected instance works");
    } finally {
      await runningSandbox.kill().catch(() => {});
    }

    // ─── 8. Cleanup ────────────────────────────────────────────
    console.log("\n[8] Cleanup");

    const killSandbox = await provider.create({ image: "ubuntu:latest" });
    const killId = killSandbox.sandboxId;
    await killSandbox.kill();
    assert(true, "kill() succeeds");

    // Connect to killed container should fail
    await assertThrows(
      () => provider.connect(killId),
      "not found",
      "connect to killed container throws"
    );

    // ─── 9. Error handling ─────────────────────────────────────
    console.log("\n[9] Error handling");

    // getHost with no port mapping
    await withSandbox(provider, async (sandbox) => {
      await assertThrows(
        () => sandbox.getHost(8080),
        "port",
        "getHost with no port mapping throws"
      );
    });

    // Working directory option at create time
    const wdSandbox = await provider.create({
      image: "ubuntu:latest",
      workingDirectory: "/app",
    });
    try {
      const wd = await wdSandbox.commands.run("pwd");
      assertEqual(wd.stdout.trim(), "/app", "workingDirectory option creates and sets cwd");
    } finally {
      await wdSandbox.kill().catch(() => {});
    }

    // Environment variables at create time
    const envSandbox = await provider.create({
      image: "ubuntu:latest",
      envs: { INIT_VAR: "init-value" },
    });
    try {
      const initEnv = await envSandbox.commands.run("echo $INIT_VAR");
      assertEqual(initEnv.stdout.trim(), "init-value", "create-time envs are set");
    } finally {
      await envSandbox.kill().catch(() => {});
    }

  } finally {
    await teardownMock();
  }

  // ─── Summary ───────────────────────────────────────────────
  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("Test suite error:", err);
  await teardownMock().catch(() => {});
  process.exit(1);
});
