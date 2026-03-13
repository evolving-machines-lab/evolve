#!/usr/bin/env tsx
/**
 * Local Provider — Thorough Unit Tests
 *
 * Tests all edge cases, error paths, concurrency behavior,
 * and interface compliance for the Local sandbox provider.
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

async function assertThrows(fn: () => unknown, substring: string, message: string): Promise<void> {
  try { await fn(); failed++; console.log(`  ✗ ${message} (did not throw)`); }
  catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(substring)) { passed++; console.log(`  ✓ ${message}`); }
    else { failed++; console.log(`  ✗ ${message} (wrong error: "${msg}")`); }
  }
}

function tmpDir(): string { return path.join("/tmp", `evolve-unit-${randomUUID()}`); }

// ─── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("\n═══ Local Provider — Unit Tests ═══\n");

  // ─── 1. Factory & Provider ─────────────────────────────────
  console.log("[1] Factory & Provider API");

  const p1 = createLocalProvider();
  assertEqual(p1.providerType, "local", "providerType is 'local'");
  assertEqual((p1 as LocalProvider).name, "Local", "name is 'Local'");

  const p2 = createLocalProvider({ workingDirectory: "/tmp", defaultTimeoutMs: 5000 });
  assert(p2 !== p1, "each call returns new instance");

  // ─── 2. Multiple instances are isolated ────────────────────
  console.log("\n[2] Instance isolation");

  const dir1 = tmpDir(), dir2 = tmpDir();
  await fs.mkdir(dir1, { recursive: true });
  await fs.mkdir(dir2, { recursive: true });

  const provider = createLocalProvider();
  const s1 = await provider.create({ workingDirectory: dir1 });
  const s2 = await provider.create({ workingDirectory: dir2 });

  assert(s1.sandboxId !== s2.sandboxId, "instances have different sandboxIds");
  await s1.files.write("marker.txt", "instance1");
  await s2.files.write("marker.txt", "instance2");

  const r1 = await s1.files.read("marker.txt");
  const r2 = await s2.files.read("marker.txt");
  assertEqual(r1, "instance1", "instance1 reads its own file");
  assertEqual(r2, "instance2", "instance2 reads its own file");

  // Connect to s1 from provider should work
  const s1Reconnect = await provider.connect(s1.sandboxId);
  assertEqual(s1Reconnect.sandboxId, s1.sandboxId, "connect returns same instance");

  await s1.kill(); await s2.kill();
  await fs.rm(dir1, { recursive: true, force: true }).catch(() => {});
  await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});

  // ─── 3. Command edge cases ─────────────────────────────────
  console.log("\n[3] Command edge cases");

  const cmdDir = tmpDir();
  await fs.mkdir(cmdDir, { recursive: true });
  const sandbox = await provider.create({ workingDirectory: cmdDir });

  // Empty command
  const empty = await sandbox.commands.run("true");
  assertEqual(empty.exitCode, 0, "empty command succeeds");
  assertEqual(empty.stdout, "", "empty command has no stdout");

  // Multi-line output
  const multi = await sandbox.commands.run("echo line1; echo line2; echo line3");
  assertEqual(multi.stdout.trim().split("\n").length, 3, "multi-line output preserved");

  // Large output (100KB+)
  const large = await sandbox.commands.run("seq 1 20000");
  assert(large.stdout.split("\n").length >= 20000, "large output not truncated");
  assertEqual(large.exitCode, 0, "large output command exits 0");

  // Special characters in output
  const special = await sandbox.commands.run(`echo 'hello "world" \$FOO \`date\`'`);
  assert(special.stdout.includes('"world"'), "special characters preserved");

  // Environment variable override
  const envTest = await sandbox.commands.run("echo $HOME", { envs: { HOME: "/custom/home" } });
  assertEqual(envTest.stdout.trim(), "/custom/home", "env var override works");

  // Multiple env vars
  const multiEnv = await sandbox.commands.run("echo $A $B $C", {
    envs: { A: "alpha", B: "beta", C: "gamma" },
  });
  assertEqual(multiEnv.stdout.trim(), "alpha beta gamma", "multiple env vars work");

  // Pipeline commands
  const pipe = await sandbox.commands.run("echo hello | tr 'h' 'H' | tr 'e' 'E'");
  assertEqual(pipe.stdout.trim(), "HEllo", "pipeline commands work");

  // Combined stdout and stderr
  const combined = await sandbox.commands.run("echo out; echo err >&2");
  assertEqual(combined.stdout.trim(), "out", "combined stdout captured");
  assertEqual(combined.stderr.trim(), "err", "combined stderr captured");
  assertEqual(combined.exitCode, 0, "combined exits 0");

  // onStderr callback
  let stderrData = "";
  await sandbox.commands.run("echo err-callback >&2", {
    onStderr: (data) => { stderrData += data; },
  });
  assert(stderrData.includes("err-callback"), "onStderr callback fires");

  // Command timeout
  const start = Date.now();
  try {
    await sandbox.commands.run("sleep 60", { timeoutMs: 500 });
    assert(false, "timeout should throw");
  } catch (e) {
    const elapsed = Date.now() - start;
    assert(elapsed < 5000, `timeout kills promptly (${elapsed}ms < 5000ms)`);
    assert((e as Error).message.includes("timed out"), "timeout error message");
  }

  await sandbox.kill();
  await fs.rm(cmdDir, { recursive: true, force: true }).catch(() => {});

  // ─── 4. File edge cases ────────────────────────────────────
  console.log("\n[4] File edge cases");

  const fileDir = tmpDir();
  await fs.mkdir(fileDir, { recursive: true });
  const fileSandbox = await provider.create({ workingDirectory: fileDir });

  // Empty file
  await fileSandbox.files.write("empty.txt", "");
  const emptyFile = await fileSandbox.files.read("empty.txt");
  assertEqual(emptyFile, "", "empty file round-trip");

  // UTF-8 content
  const utf8Content = "Hello 世界 🌍 café résumé naïve";
  await fileSandbox.files.write("utf8.txt", utf8Content);
  const utf8Read = await fileSandbox.files.read("utf8.txt");
  assertEqual(utf8Read, utf8Content, "UTF-8 content preserved");

  // Large file (1MB+)
  const largeBuf = Buffer.alloc(1024 * 1024, "A");
  await fileSandbox.files.write("large.txt", largeBuf.toString());
  const largeRead = await fileSandbox.files.read("large.txt") as string;
  assertEqual(largeRead.length, 1024 * 1024, "large file size preserved");

  // Newlines preservation
  const newlines = "line1\nline2\r\nline3\n\n";
  await fileSandbox.files.write("newlines.txt", newlines);
  const nlRead = await fileSandbox.files.read("newlines.txt");
  assertEqual(nlRead, newlines, "newline types preserved");

  // Deeply nested path
  const deepPath = "a/b/c/d/e/f/deep.txt";
  await fileSandbox.files.write(deepPath, "deep content");
  const deepRead = await fileSandbox.files.read(deepPath);
  assertEqual(deepRead, "deep content", "deeply nested write auto-creates dirs");

  // Overwrite existing file
  await fileSandbox.files.write("overwrite.txt", "original");
  await fileSandbox.files.write("overwrite.txt", "updated");
  const overwritten = await fileSandbox.files.read("overwrite.txt");
  assertEqual(overwritten, "updated", "overwrite replaces content");

  // Binary files with various extensions
  const binData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG header
  await fileSandbox.files.write("image.png", binData);
  const binRead = await fileSandbox.files.read("image.png");
  assert(binRead instanceof Uint8Array, "binary extension returns Uint8Array");
  assertEqual(Buffer.from(binRead as Uint8Array).toString("hex"), binData.toString("hex"), "binary content preserved");

  // Uint8Array input
  const u8data = new Uint8Array([1, 2, 3, 4, 5]);
  await fileSandbox.files.write("u8.bin", u8data);
  const u8Read = await fileSandbox.files.read("u8.bin");
  assertEqual(Buffer.from(u8Read as Uint8Array).toString("hex"), Buffer.from(u8data).toString("hex"), "Uint8Array input preserved");

  // ArrayBuffer input
  const abData = new ArrayBuffer(4);
  new Uint8Array(abData).set([10, 20, 30, 40]);
  await fileSandbox.files.write("ab.bin", abData);
  const abRead = await fileSandbox.files.read("ab.bin");
  assertEqual(Buffer.from(abRead as Uint8Array).toString("hex"), "0a141e28", "ArrayBuffer input preserved");

  // writeBatch with zero files
  await fileSandbox.files.writeBatch([]);
  assert(true, "writeBatch with empty array succeeds");

  // writeBatch with many files
  const batchFiles = Array.from({ length: 20 }, (_, i) => ({
    path: `batch/file_${i}.txt`,
    data: `content_${i}`,
  }));
  await fileSandbox.files.writeBatch(batchFiles);
  const sample = await fileSandbox.files.read("batch/file_15.txt");
  assertEqual(sample, "content_15", "writeBatch with 20 files works");

  // makeDir idempotent
  await fileSandbox.files.makeDir("idempotent/dir");
  await fileSandbox.files.makeDir("idempotent/dir"); // no error
  assert(true, "makeDir is idempotent");

  await fileSandbox.kill();
  await fs.rm(fileDir, { recursive: true, force: true }).catch(() => {});

  // ─── 5. Background process edge cases ──────────────────────
  console.log("\n[5] Background process edge cases");

  const bgDir = tmpDir();
  await fs.mkdir(bgDir, { recursive: true });
  const bgSandbox = await provider.create({ workingDirectory: bgDir });

  // Spawn with non-zero exit
  const failHandle = await bgSandbox.commands.spawn("exit 7");
  const failResult = await failHandle.wait();
  assertEqual(failResult.exitCode, 7, "spawn wait() captures non-zero exit");

  // Spawn with env vars
  const envHandle = await bgSandbox.commands.spawn("echo $SPAWN_VAR", { envs: { SPAWN_VAR: "bg-value" } });
  const envResult = await envHandle.wait();
  assert(envResult.stdout.includes("bg-value"), "spawn env vars work");

  // Multiple concurrent spawns
  const handles = await Promise.all([
    bgSandbox.commands.spawn("echo p1; sleep 0.1"),
    bgSandbox.commands.spawn("echo p2; sleep 0.1"),
    bgSandbox.commands.spawn("echo p3; sleep 0.1"),
  ]);
  assert(handles.length === 3, "3 concurrent spawns created");
  const results = await Promise.all(handles.map((h) => h.wait()));
  assert(results.every((r) => r.exitCode === 0), "all concurrent spawns exit 0");

  // list() shows spawned processes
  const longHandle = await bgSandbox.commands.spawn("sleep 300");
  await new Promise((r) => setTimeout(r, 200));
  const procs = await bgSandbox.commands.list();
  assert(procs.some((p) => p.processId === longHandle.processId), "list() includes spawned process");

  // kill by processId
  const killed = await bgSandbox.commands.kill(longHandle.processId);
  assert(killed, "kill by processId succeeds");

  // kill already-dead process returns false
  const deadKill = await bgSandbox.commands.kill("99999999");
  assertEqual(deadKill, false, "kill non-existent process returns false");

  await bgSandbox.kill();
  await fs.rm(bgDir, { recursive: true, force: true }).catch(() => {});

  // ─── 6. Pause and getHost ──────────────────────────────────
  console.log("\n[6] Pause, getHost, connect");

  const miscDir = tmpDir();
  await fs.mkdir(miscDir, { recursive: true });
  const miscSandbox = await provider.create({ workingDirectory: miscDir });

  // pause is no-op but shouldn't throw
  await miscSandbox.pause();
  assert(true, "pause() is no-op and doesn't throw");

  // getHost returns localhost
  const host = await miscSandbox.getHost(3000);
  assertEqual(host, "localhost:3000", "getHost(3000) returns localhost:3000");
  const host2 = await miscSandbox.getHost(0);
  assertEqual(host2, "localhost:0", "getHost(0) returns localhost:0");

  // connect after kill throws
  const sid = miscSandbox.sandboxId;
  await miscSandbox.kill();
  await assertThrows(
    () => provider.connect(sid),
    "not found",
    "connect after kill throws"
  );

  // connect with unknown id
  await assertThrows(
    () => provider.connect("totally-fake-id"),
    "not found",
    "connect with fake id throws"
  );

  await fs.rm(miscDir, { recursive: true, force: true }).catch(() => {});

  // ─── 7. Default working directory ──────────────────────────
  console.log("\n[7] Default working directory");

  // No workingDirectory option uses process.cwd()
  const defaultSandbox = await provider.create({});
  const pwdResult = await defaultSandbox.commands.run("pwd");
  const realCwd = await fs.realpath(process.cwd());
  assertEqual(pwdResult.stdout.trim(), realCwd, "default cwd is process.cwd()");
  await defaultSandbox.kill();

  // Provider-level workingDirectory config
  const cfgDir = tmpDir();
  await fs.mkdir(cfgDir, { recursive: true });
  const realCfgDir = await fs.realpath(cfgDir);
  const cfgProvider = createLocalProvider({ workingDirectory: cfgDir });
  const cfgSandbox = await cfgProvider.create({});
  const cfgPwd = await cfgSandbox.commands.run("pwd");
  assertEqual(cfgPwd.stdout.trim(), realCfgDir, "provider config workingDirectory used");
  await cfgSandbox.kill();
  await fs.rm(cfgDir, { recursive: true, force: true }).catch(() => {});

  // ─── Summary ───────────────────────────────────────────────
  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("Test error:", err); process.exit(1); });
