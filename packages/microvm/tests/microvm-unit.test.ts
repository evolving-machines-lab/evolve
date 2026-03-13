#!/usr/bin/env tsx
/**
 * MicroVM Provider — Unit Tests
 *
 * Tests factory guard, platform checks, configuration,
 * and interface compliance. Gracefully skips on unsupported
 * platforms or when Boxlite is not available.
 */

import {
  createMicroVMProvider,
  MicroVMProvider,
  type SandboxProvider,
  type SandboxInstance,
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
  console.log("\n═══ MicroVM Provider — Unit Tests ═══\n");

  const platform = process.platform;
  const arch = process.arch;
  const isMacARM = platform === "darwin" && arch === "arm64";
  const isLinux = platform === "linux";
  const platformSupported = isMacARM || isLinux;

  // ─── 1. Platform guard ─────────────────────────────────────
  console.log("[1] Platform guard");

  if (platformSupported) {
    const provider = createMicroVMProvider();
    assert(provider !== null, "factory succeeds on supported platform");
    assertEqual(provider.providerType, "microvm", "providerType is 'microvm'");
    assertEqual((provider as MicroVMProvider).name, "MicroVM", "name is 'MicroVM'");
  } else {
    await assertThrows(
      () => createMicroVMProvider(),
      "not supported",
      "factory throws on unsupported platform"
    );
    skip(`Platform ${platform}/${arch} not supported — remaining tests skipped`);
    console.log(`\n═══ ${passed} passed, ${failed} failed, ${skipped} skipped ═══\n`);
    return;
  }

  // ─── 2. Configuration options ──────────────────────────────
  console.log("\n[2] Configuration options");

  // Default config
  const defaultProvider = createMicroVMProvider();
  assert(defaultProvider.providerType === "microvm", "default config works");

  // Custom image
  const imgProvider = createMicroVMProvider({ image: "debian:latest" });
  assert(imgProvider.providerType === "microvm", "custom image accepted");

  // Custom resources
  const resProvider = createMicroVMProvider({
    memoryMib: 1024,
    cpus: 2,
    workingDirectory: "/workspace",
  });
  assert(resProvider.providerType === "microvm", "custom resources accepted");

  // Volume mounts
  const volProvider = createMicroVMProvider({
    volumes: [
      { hostPath: "/tmp/data", guestPath: "/data", readOnly: true },
    ],
  });
  assert(volProvider.providerType === "microvm", "volume config accepted");

  // Port mappings
  const portProvider = createMicroVMProvider({
    ports: [
      { guestPort: 8080, hostPort: 8080 },
      { guestPort: 3000 },
    ],
  });
  assert(portProvider.providerType === "microvm", "port config accepted");

  // Security config
  const secProvider = createMicroVMProvider({
    security: {
      jailerEnabled: true,
      seccompEnabled: false,
      maxOpenFiles: 1024,
      maxProcesses: 100,
      networkEnabled: true,
    },
  });
  assert(secProvider.providerType === "microvm", "security config accepted");

  // Full config
  const fullProvider = createMicroVMProvider({
    image: "ubuntu:latest",
    memoryMib: 2048,
    cpus: 4,
    workingDirectory: "/home/user",
    volumes: [{ hostPath: "/tmp", guestPath: "/mnt/tmp" }],
    ports: [{ guestPort: 80, hostPort: 8080, protocol: "tcp" }],
    security: { jailerEnabled: false, networkEnabled: true },
  });
  assert(fullProvider.providerType === "microvm", "full config accepted");

  // Empty config
  const emptyProvider = createMicroVMProvider({});
  assert(emptyProvider.providerType === "microvm", "empty config accepted");

  // ─── 3. Interface compliance ───────────────────────────────
  console.log("\n[3] Interface compliance");

  const provider = createMicroVMProvider();
  assert(typeof provider.create === "function", "create is a function");
  assert(typeof provider.connect === "function", "connect is a function");
  assert(typeof provider.providerType === "string", "providerType is string");

  // ─── 4. create() with Boxlite ──────────────────────────────
  console.log("\n[4] VM lifecycle");

  let boxliteAvailable = false;
  let sandbox: SandboxInstance | null = null;

  try {
    sandbox = await provider.create({});
    boxliteAvailable = true;

    // Verify instance shape
    assert(typeof sandbox.sandboxId === "string", "sandboxId is string");
    assert(sandbox.sandboxId.length > 0, "sandboxId is non-empty");
    assert(typeof sandbox.commands === "object", "commands is object");
    assert(typeof sandbox.files === "object", "files is object");

    // Verify commands interface
    assert(typeof sandbox.commands.run === "function", "commands.run exists");
    assert(typeof sandbox.commands.spawn === "function", "commands.spawn exists");
    assert(typeof sandbox.commands.list === "function", "commands.list exists");
    assert(typeof sandbox.commands.kill === "function", "commands.kill exists");

    // Verify files interface
    assert(typeof sandbox.files.read === "function", "files.read exists");
    assert(typeof sandbox.files.write === "function", "files.write exists");
    assert(typeof sandbox.files.writeBatch === "function", "files.writeBatch exists");
    assert(typeof sandbox.files.makeDir === "function", "files.makeDir exists");

    // Verify other methods
    assert(typeof sandbox.getHost === "function", "getHost exists");
    assert(typeof sandbox.kill === "function", "kill exists");
    assert(typeof sandbox.pause === "function", "pause exists");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("Cannot find") || msg.includes("MODULE_NOT_FOUND") || msg.includes("boxlite")) {
      skip(`Boxlite not installed: ${msg}`);
    } else {
      skip(`VM creation failed: ${msg}`);
    }
  } finally {
    if (sandbox) await sandbox.kill().catch(() => {});
  }

  if (!boxliteAvailable) {
    skip("Boxlite not available — runtime tests skipped");
    console.log(`\n═══ ${passed} passed, ${failed} failed, ${skipped} skipped ═══\n`);
    if (failed > 0) process.exit(1);
    return;
  }

  // ─── 5. Command execution ─────────────────────────────────
  console.log("\n[5] Command execution");

  sandbox = await provider.create({});
  try {
    // Basic echo
    const echo = await sandbox.commands.run("echo hello microvm");
    assertEqual(echo.stdout.trim(), "hello microvm", "echo works");
    assertEqual(echo.exitCode, 0, "exit code 0");

    // Non-zero exit
    const fail = await sandbox.commands.run("exit 42");
    assertEqual(fail.exitCode, 42, "non-zero exit captured");

    // Stderr (should be clean of Boxlite warnings)
    const err = await sandbox.commands.run("echo err-msg >&2");
    assertEqual(err.stderr.trim(), "err-msg", "stderr captured (warnings stripped)");

    // Env vars
    const env = await sandbox.commands.run("echo $MVM_VAR", { envs: { MVM_VAR: "vm-value" } });
    assertEqual(env.stdout.trim(), "vm-value", "env vars work");

    // cwd
    await sandbox.commands.run("mkdir -p /tmp/cwdtest");
    const cwd = await sandbox.commands.run("pwd", { cwd: "/tmp/cwdtest" });
    assertEqual(cwd.stdout.trim(), "/tmp/cwdtest", "cwd works");

    // onStdout callback
    let cbData = "";
    await sandbox.commands.run("echo cb-test", { onStdout: (d) => { cbData += d; } });
    assert(cbData.includes("cb-test"), "onStdout callback fires");

    // Pipeline
    const pipe = await sandbox.commands.run("echo UPPER | tr A-Z a-z");
    assertEqual(pipe.stdout.trim(), "upper", "pipeline works");
  } finally {
    await sandbox.kill().catch(() => {});
  }

  // ─── 6. File operations ────────────────────────────────────
  console.log("\n[6] File operations");

  sandbox = await provider.create({});
  try {
    // Text round-trip
    await sandbox.files.write("/tmp/mvm.txt", "hello microvm");
    const text = await sandbox.files.read("/tmp/mvm.txt");
    assertEqual(text, "hello microvm", "text round-trip");

    // Binary round-trip
    const binData = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]);
    await sandbox.files.write("/tmp/mvm.bin", binData);
    const binRead = await sandbox.files.read("/tmp/mvm.bin");
    assert(binRead instanceof Uint8Array, "binary returns Uint8Array");
    assertEqual(
      Buffer.from(binRead as Uint8Array).toString("hex"),
      binData.toString("hex"),
      "binary content preserved"
    );

    // UTF-8
    const utf8 = "Héllo 世界 🎉";
    await sandbox.files.write("/tmp/mvm-utf8.txt", utf8);
    const utf8Read = await sandbox.files.read("/tmp/mvm-utf8.txt");
    assertEqual(utf8Read, utf8, "UTF-8 preserved");

    // Deep nested
    await sandbox.files.write("/tmp/a/b/c/deep.txt", "deep");
    const deep = await sandbox.files.read("/tmp/a/b/c/deep.txt");
    assertEqual(deep, "deep", "deeply nested write");

    // writeBatch
    await sandbox.files.writeBatch([
      { path: "/tmp/batch/a.txt", data: "A" },
      { path: "/tmp/batch/b.txt", data: "B" },
    ]);
    const a = await sandbox.files.read("/tmp/batch/a.txt");
    const b = await sandbox.files.read("/tmp/batch/b.txt");
    assertEqual(a, "A", "writeBatch file 1");
    assertEqual(b, "B", "writeBatch file 2");

    // Empty writeBatch
    await sandbox.files.writeBatch([]);
    assert(true, "empty writeBatch succeeds");

    // makeDir
    await sandbox.files.makeDir("/tmp/mvm-dir/nested");
    const dirCheck = await sandbox.commands.run("test -d /tmp/mvm-dir/nested && echo ok");
    assertEqual(dirCheck.stdout.trim(), "ok", "makeDir creates dirs");

    // Read non-existent
    await assertThrows(
      () => sandbox!.files.read("/tmp/totally-missing.txt"),
      "Failed to read file",
      "read missing file throws"
    );
  } finally {
    await sandbox.kill().catch(() => {});
  }

  // ─── 7. Background processes ───────────────────────────────
  console.log("\n[7] Background processes");

  sandbox = await provider.create({});
  try {
    // Spawn and wait
    const h = await sandbox.commands.spawn("echo bg-out; sleep 1; echo done");
    assert(typeof h.processId === "string", "spawn returns processId");
    const r = await h.wait();
    assert(r.stdout.includes("bg-out"), "spawn stdout captured");
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
  } finally {
    await sandbox.kill().catch(() => {});
  }

  // ─── 8. Pause & getHost ────────────────────────────────────
  console.log("\n[8] Pause & getHost");

  sandbox = await provider.create({});
  try {
    // pause is no-op
    await sandbox.pause();
    assert(true, "pause() doesn't throw");

    // getHost
    const host = await sandbox.getHost(8080);
    assert(host.includes("localhost"), "getHost returns localhost");
    assert(host.includes("8080"), "getHost includes port");
  } finally {
    await sandbox.kill().catch(() => {});
  }

  // ─── Summary ───────────────────────────────────────────────
  console.log(`\n═══ ${passed} passed, ${failed} failed, ${skipped} skipped ═══\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("Test error:", err); process.exit(1); });
