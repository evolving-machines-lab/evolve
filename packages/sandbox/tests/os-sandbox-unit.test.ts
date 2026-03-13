#!/usr/bin/env tsx
/**
 * OS Sandbox Provider — Unit Tests
 *
 * Tests factory guard, platform checks, configuration handling,
 * and interface compliance. Does NOT require @anthropic-ai/sandbox-runtime.
 */

import {
  createOSSandboxProvider,
  OSSandboxProvider,
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
  console.log("\n═══ OS Sandbox Provider — Unit Tests ═══\n");

  const platform = process.platform;

  // ─── 1. Platform guard ─────────────────────────────────────
  console.log("[1] Platform guard");

  if (platform === "darwin" || platform === "linux") {
    const provider = createOSSandboxProvider();
    assert(provider !== null, "factory succeeds on supported platform");
    assertEqual(provider.providerType, "os-sandbox", "providerType correct");
    assertEqual((provider as OSSandboxProvider).name, "OS Sandbox", "name correct");
  } else {
    await assertThrows(
      () => createOSSandboxProvider(),
      "requires macOS",
      "factory throws on unsupported platform"
    );
    skip("Remaining tests require macOS/Linux");
    console.log(`\n═══ ${passed} passed, ${failed} failed, ${skipped} skipped ═══\n`);
    return;
  }

  // ─── 2. Configuration options ──────────────────────────────
  console.log("\n[2] Configuration options");

  // Default config
  const defaultProvider = createOSSandboxProvider();
  assert(defaultProvider.providerType === "os-sandbox", "default config works");

  // Custom filesystem config
  const fsProvider = createOSSandboxProvider({
    filesystem: {
      denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
      allowWrite: [".", "/tmp"],
      denyWrite: [".env", "*.pem", "*.key"],
    },
  });
  assert(fsProvider.providerType === "os-sandbox", "filesystem config accepted");

  // Custom network config
  const netProvider = createOSSandboxProvider({
    network: {
      allowedDomains: ["api.github.com"],
      deniedDomains: ["evil.com"],
    },
  });
  assert(netProvider.providerType === "os-sandbox", "network config accepted");

  // Safe mode
  const safeProvider = createOSSandboxProvider({ safe: true });
  assert(safeProvider.providerType === "os-sandbox", "safe mode config accepted");

  // Full config
  const fullProvider = createOSSandboxProvider({
    workingDirectory: "/tmp",
    defaultTimeoutMs: 300000,
    filesystem: {
      denyRead: ["~/.ssh"],
      allowWrite: ["."],
      denyWrite: [".env"],
    },
    network: {
      allowedDomains: ["example.com"],
    },
    safe: false,
  });
  assert(fullProvider.providerType === "os-sandbox", "full config accepted");

  // Empty config
  const emptyProvider = createOSSandboxProvider({});
  assert(emptyProvider.providerType === "os-sandbox", "empty config object accepted");

  // ─── 3. Provider interface compliance ──────────────────────
  console.log("\n[3] Interface compliance");

  const provider = createOSSandboxProvider();
  assert(typeof provider.create === "function", "create is a function");
  assert(typeof provider.connect === "function", "connect is a function");
  assert(typeof provider.providerType === "string", "providerType is a string");

  // ─── 4. create() with sandbox-runtime missing ──────────────
  console.log("\n[4] Sandbox runtime dependency");

  // When sandbox-runtime is not installed, create() should throw a clear error
  try {
    const sandbox = await provider.create({ workingDirectory: "/tmp" });
    // If it succeeds, runtime is installed — verify instance shape
    assert(typeof sandbox.sandboxId === "string", "sandboxId is string");
    assert(typeof sandbox.commands === "object", "commands is object");
    assert(typeof sandbox.files === "object", "files is object");
    assert(typeof sandbox.getHost === "function", "getHost is function");
    assert(typeof sandbox.kill === "function", "kill is function");
    assert(typeof sandbox.pause === "function", "pause is function");

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

    await sandbox.kill();
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("sandbox-runtime") || msg.includes("Cannot find")) {
      assert(true, "clear error when sandbox-runtime not installed");
    } else {
      assert(false, `unexpected error: ${msg}`);
    }
  }

  // ─── 5. connect() with unknown id ──────────────────────────
  console.log("\n[5] Connect edge cases");

  await assertThrows(
    () => provider.connect("totally-nonexistent-uuid-12345"),
    "not found",
    "connect with unknown id throws"
  );

  // ─── 6. Multiple provider instances ────────────────────────
  console.log("\n[6] Multiple providers");

  const providerA = createOSSandboxProvider({ workingDirectory: "/tmp" });
  const providerB = createOSSandboxProvider({ workingDirectory: "/var" });
  assert(providerA !== providerB, "each factory call returns distinct instance");
  assertEqual(providerA.providerType, providerB.providerType, "all have same providerType");

  // ─── Summary ───────────────────────────────────────────────
  console.log(`\n═══ ${passed} passed, ${failed} failed, ${skipped} skipped ═══\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("Test error:", err); process.exit(1); });
