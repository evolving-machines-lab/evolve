#!/usr/bin/env tsx
/**
 * Docker Provider — Unit Tests
 *
 * Tests factory guard, configuration handling, error paths,
 * and interface compliance. Gracefully skips when Docker daemon
 * is not available.
 */

import {
  createDockerProvider,
  DockerProvider,
  type SandboxInstance,
  type SandboxProvider,
} from "../src/index";

// ─── Test framework ──────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

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

async function assertThrows(fn: () => unknown, substring: string, message: string): Promise<void> {
  try { await fn(); failed++; console.log(`  ✗ ${message} (did not throw)`); }
  catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(substring)) { passed++; console.log(`  ✓ ${message}`); }
    else { failed++; console.log(`  ✗ ${message} (wrong error: "${msg}")`); }
  }
}

function skip(message: string): void {
  skipped++;
  console.log(`  ⚠ Skipped: ${message}`);
}

// ─── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("\n═══ Docker Provider — Unit Tests ═══\n");

  // ─── 1. Factory & Platform guard ───────────────────────────
  console.log("[1] Factory & Docker availability");

  let provider: SandboxProvider | null = null;
  let dockerAvailable = false;
  try {
    provider = createDockerProvider();
    dockerAvailable = true;
    assert(true, "createDockerProvider succeeds (Docker running)");
    assertEqual(provider.providerType, "docker", "providerType is 'docker'");
    assertEqual((provider as DockerProvider).name, "Docker", "name is 'Docker'");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("Docker is not available")) {
      assert(true, "clear error when Docker not running");
      assert(msg.includes("docker.com"), "error includes install URL");
    } else {
      assert(false, `unexpected error: ${msg}`);
    }
  }

  // ─── 2. Configuration options ──────────────────────────────
  console.log("\n[2] Configuration options");

  if (!dockerAvailable) {
    skip("Docker not available");
  } else {
    // Custom image
    const customImg = createDockerProvider({ imageName: "my-custom-image" });
    assert(customImg.providerType === "docker", "custom imageName accepted");

    // Custom timeout
    const customTimeout = createDockerProvider({ defaultTimeoutMs: 30000 });
    assert(customTimeout.providerType === "docker", "custom timeout accepted");

    // Empty config
    const emptyConfig = createDockerProvider({});
    assert(emptyConfig.providerType === "docker", "empty config accepted");

    // Full config
    const fullConfig = createDockerProvider({
      imageName: "ubuntu:latest",
      defaultTimeoutMs: 7200000,
    });
    assert(fullConfig.providerType === "docker", "full config accepted");
  }

  // ─── 3. Interface compliance ───────────────────────────────
  console.log("\n[3] Interface compliance");

  if (!dockerAvailable) {
    skip("Docker not available");
  } else {
    assert(typeof provider!.create === "function", "create is a function");
    assert(typeof provider!.connect === "function", "connect is a function");
    assert(typeof provider!.providerType === "string", "providerType is a string");
  }

  // ─── 4. Container lifecycle ────────────────────────────────
  console.log("\n[4] Container lifecycle");

  if (!dockerAvailable) {
    skip("Docker not available");
  } else {
    // Create with basic ubuntu image
    let sandbox: SandboxInstance | null = null;
    try {
      sandbox = await provider!.create({ image: "ubuntu:latest" });
      assert(typeof sandbox.sandboxId === "string", "sandboxId is string");
      assert(sandbox.sandboxId.startsWith("evolve-"), "sandboxId has evolve- prefix");

      // Verify full interface
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
    } finally {
      if (sandbox) await sandbox.kill().catch(() => {});
    }

    // Non-existent image
    await assertThrows(
      () => provider!.create({ image: "nonexistent-image-xyz-12345:latest" }),
      "not found",
      "non-existent image throws clear error"
    );

    // Connect to non-existent container
    await assertThrows(
      () => provider!.connect("nonexistent-container-id"),
      "not found",
      "connect to missing container throws"
    );
  }

  // ─── 5. Command execution ─────────────────────────────────
  console.log("\n[5] Command execution");

  if (!dockerAvailable) {
    skip("Docker not available");
  } else {
    const sandbox = await provider!.create({ image: "ubuntu:latest" });
    try {
      // Basic commands
      const echo = await sandbox.commands.run("echo hello");
      assertEqual(echo.stdout.trim(), "hello", "echo works");
      assertEqual(echo.exitCode, 0, "exit code 0");

      // Non-zero exit
      const fail = await sandbox.commands.run("exit 42");
      assertEqual(fail.exitCode, 42, "non-zero exit captured");

      // Env vars
      const env = await sandbox.commands.run("echo $FOO", { envs: { FOO: "bar" } });
      assertEqual(env.stdout.trim(), "bar", "env vars work");

      // Working directory
      await sandbox.commands.run("mkdir -p /workspace/test");
      const cwd = await sandbox.commands.run("pwd", { cwd: "/workspace/test" });
      assertEqual(cwd.stdout.trim(), "/workspace/test", "cwd works");

      // Stderr
      const err = await sandbox.commands.run("echo err >&2");
      assertEqual(err.stderr.trim(), "err", "stderr captured");

      // Multi-line
      const multi = await sandbox.commands.run("echo a; echo b; echo c");
      assertEqual(multi.stdout.trim().split("\n").length, 3, "multi-line output");

      // Pipeline
      const pipe = await sandbox.commands.run("echo HELLO | tr A-Z a-z");
      assertEqual(pipe.stdout.trim(), "hello", "pipeline works");

      // onStdout callback
      let cbData = "";
      await sandbox.commands.run("echo callback", { onStdout: (d) => { cbData += d; } });
      assert(cbData.includes("callback"), "onStdout fires");
    } finally {
      await sandbox.kill().catch(() => {});
    }
  }

  // ─── 6. File operations ────────────────────────────────────
  console.log("\n[6] File operations");

  if (!dockerAvailable) {
    skip("Docker not available");
  } else {
    const sandbox = await provider!.create({ image: "ubuntu:latest" });
    try {
      // Text round-trip
      await sandbox.files.write("/tmp/test.txt", "hello docker");
      const text = await sandbox.files.read("/tmp/test.txt");
      assertEqual(text, "hello docker", "text round-trip");

      // Binary round-trip
      const binData = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]);
      await sandbox.files.write("/tmp/test.bin", binData);
      const binRead = await sandbox.files.read("/tmp/test.bin");
      assert(binRead instanceof Uint8Array, "binary returns Uint8Array");
      assertEqual(
        Buffer.from(binRead as Uint8Array).toString("hex"),
        binData.toString("hex"),
        "binary content preserved"
      );

      // UTF-8
      const utf8 = "日本語テスト 🎉";
      await sandbox.files.write("/tmp/utf8.txt", utf8);
      const utf8Read = await sandbox.files.read("/tmp/utf8.txt");
      assertEqual(utf8Read, utf8, "UTF-8 preserved");

      // Deeply nested
      await sandbox.files.write("/tmp/a/b/c/d/deep.txt", "deep");
      const deep = await sandbox.files.read("/tmp/a/b/c/d/deep.txt");
      assertEqual(deep, "deep", "deeply nested write works");

      // writeBatch
      await sandbox.files.writeBatch([
        { path: "/tmp/batch/x.txt", data: "X" },
        { path: "/tmp/batch/y.txt", data: "Y" },
      ]);
      const x = await sandbox.files.read("/tmp/batch/x.txt");
      const y = await sandbox.files.read("/tmp/batch/y.txt");
      assertEqual(x, "X", "writeBatch file 1");
      assertEqual(y, "Y", "writeBatch file 2");

      // Read non-existent
      await assertThrows(
        () => sandbox.files.read("/tmp/nope.txt"),
        "Failed to read file",
        "read missing file throws"
      );
    } finally {
      await sandbox.kill().catch(() => {});
    }
  }

  // ─── 7. Background processes ───────────────────────────────
  console.log("\n[7] Background processes");

  if (!dockerAvailable) {
    skip("Docker not available");
  } else {
    const sandbox = await provider!.create({ image: "ubuntu:latest" });
    try {
      // Spawn and wait
      const h = await sandbox.commands.spawn("echo bg; sleep 1; echo done");
      const r = await h.wait();
      assert(r.stdout.includes("bg"), "spawn stdout");
      assert(r.stdout.includes("done"), "spawn completes");
      assertEqual(r.exitCode, 0, "spawn exit 0");

      // Spawn and kill
      const lh = await sandbox.commands.spawn("sleep 300");
      await new Promise((r) => setTimeout(r, 500));
      const killed = await lh.kill();
      assert(killed, "kill succeeds");

      // Process list
      const procs = await sandbox.commands.list();
      assert(Array.isArray(procs), "list returns array");
      assert(procs.length > 0, "list has processes (sleep infinity)");
    } finally {
      await sandbox.kill().catch(() => {});
    }
  }

  // ─── 8. Pause / Resume ────────────────────────────────────
  console.log("\n[8] Pause / Resume");

  if (!dockerAvailable) {
    skip("Docker not available");
  } else {
    const sandbox = await provider!.create({ image: "ubuntu:latest" });
    try {
      await sandbox.files.write("/tmp/pre-pause.txt", "preserved");
      await sandbox.pause();
      assert(true, "pause succeeds");

      const resumed = await provider!.connect(sandbox.sandboxId);
      const state = await resumed.commands.run("cat /tmp/pre-pause.txt");
      assertEqual(state.stdout.trim(), "preserved", "state preserved after pause/resume");
    } finally {
      await sandbox.kill().catch(() => {});
    }
  }

  // ─── Summary ───────────────────────────────────────────────
  console.log(`\n═══ ${passed} passed, ${failed} failed, ${skipped} skipped ═══\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("Test error:", err); process.exit(1); });
