#!/usr/bin/env tsx
/**
 * Sandbox Resolver — Unit Tests
 *
 * Tests the resolveDefaultSandbox() function's env var
 * priority logic, error messages, and edge cases.
 */

import { resolveDefaultSandbox } from "../../src/utils/sandbox";

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
    else { failed++; console.log(`  ✗ ${message} (wrong error: "${msg.slice(0, 120)}")`); }
  }
}

// Save original env
const originalEnv = { ...process.env };
function clearSandboxEnv() {
  delete process.env.E2B_API_KEY;
  delete process.env.DAYTONA_API_KEY;
  delete process.env.MODAL_TOKEN_ID;
  delete process.env.MODAL_TOKEN_SECRET;
  delete process.env.EVOLVE_SANDBOX_DOCKER;
  delete process.env.EVOLVE_SANDBOX_OS;
  delete process.env.EVOLVE_SANDBOX_LOCAL;
  delete process.env.EVOLVE_API_KEY;
}
function restoreEnv() {
  // Remove all sandbox env vars first
  clearSandboxEnv();
  // Restore original
  Object.assign(process.env, originalEnv);
}

// ─── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("\n═══ Sandbox Resolver — Unit Tests ═══\n");

  // ─── 1. No env vars → throws ──────────────────────────────
  console.log("[1] No environment variables");

  clearSandboxEnv();
  await assertThrows(
    () => resolveDefaultSandbox(),
    "No sandbox provider configured",
    "throws when no env vars set"
  );

  // ─── 2. Error message completeness ─────────────────────────
  console.log("\n[2] Error message completeness");

  clearSandboxEnv();
  try {
    await resolveDefaultSandbox();
  } catch (e) {
    const msg = (e as Error).message;
    assert(msg.includes("EVOLVE_API_KEY"), "error mentions EVOLVE_API_KEY");
    assert(msg.includes("E2B_API_KEY"), "error mentions E2B_API_KEY");
    assert(msg.includes("DAYTONA_API_KEY"), "error mentions DAYTONA_API_KEY");
    assert(msg.includes("MODAL_TOKEN_ID"), "error mentions MODAL_TOKEN_ID");
    assert(msg.includes("EVOLVE_SANDBOX_DOCKER"), "error mentions EVOLVE_SANDBOX_DOCKER");
    assert(msg.includes("EVOLVE_SANDBOX_OS"), "error mentions EVOLVE_SANDBOX_OS");
    assert(msg.includes("EVOLVE_SANDBOX_LOCAL"), "error mentions EVOLVE_SANDBOX_LOCAL");
    assert(msg.includes("withSandbox"), "error mentions .withSandbox()");
  }

  // ─── 3. EVOLVE_SANDBOX_LOCAL=true → local provider ─────────
  console.log("\n[3] Local provider resolution");

  clearSandboxEnv();
  process.env.EVOLVE_SANDBOX_LOCAL = "true";
  const localProvider = await resolveDefaultSandbox();
  assertEqual(localProvider.providerType, "local", "EVOLVE_SANDBOX_LOCAL=true → local");

  clearSandboxEnv();
  process.env.EVOLVE_SANDBOX_LOCAL = "1";
  const localProvider1 = await resolveDefaultSandbox();
  assertEqual(localProvider1.providerType, "local", "EVOLVE_SANDBOX_LOCAL=1 → local");

  // Non-truthy values should not resolve
  clearSandboxEnv();
  process.env.EVOLVE_SANDBOX_LOCAL = "false";
  await assertThrows(
    () => resolveDefaultSandbox(),
    "No sandbox provider configured",
    "EVOLVE_SANDBOX_LOCAL=false does not resolve"
  );

  clearSandboxEnv();
  process.env.EVOLVE_SANDBOX_LOCAL = "0";
  await assertThrows(
    () => resolveDefaultSandbox(),
    "No sandbox provider configured",
    "EVOLVE_SANDBOX_LOCAL=0 does not resolve"
  );

  // ─── 4. EVOLVE_SANDBOX_OS=true → OS sandbox ───────────────
  console.log("\n[4] OS Sandbox resolution");

  clearSandboxEnv();
  process.env.EVOLVE_SANDBOX_OS = "true";
  const platform = process.platform;
  if (platform === "darwin" || platform === "linux") {
    const osProvider = await resolveDefaultSandbox();
    assertEqual(osProvider.providerType, "os-sandbox", "EVOLVE_SANDBOX_OS=true → os-sandbox");
  } else {
    await assertThrows(
      () => resolveDefaultSandbox(),
      "requires macOS",
      "OS sandbox throws on unsupported platform"
    );
  }

  // ─── 5. Priority: Docker > OS > Local ──────────────────────
  console.log("\n[5] Resolution priority");

  // Local should be lowest priority among local modes
  clearSandboxEnv();
  process.env.EVOLVE_SANDBOX_LOCAL = "true";
  process.env.EVOLVE_SANDBOX_OS = "true";
  if (platform === "darwin" || platform === "linux") {
    const prio = await resolveDefaultSandbox();
    assertEqual(prio.providerType, "os-sandbox", "OS sandbox has priority over local");
  }

  // Docker should beat OS sandbox
  clearSandboxEnv();
  process.env.EVOLVE_SANDBOX_DOCKER = "true";
  process.env.EVOLVE_SANDBOX_OS = "true";
  process.env.EVOLVE_SANDBOX_LOCAL = "true";
  try {
    const prio = await resolveDefaultSandbox();
    assertEqual(prio.providerType, "docker", "Docker has priority over OS sandbox and local");
  } catch (e) {
    // Docker not available is fine — it was tried first
    assert((e as Error).message.includes("Docker"), "Docker tried first even if unavailable");
  }

  // ─── 6. EVOLVE_SANDBOX_DOCKER=true → docker ───────────────
  console.log("\n[6] Docker resolution");

  clearSandboxEnv();
  process.env.EVOLVE_SANDBOX_DOCKER = "true";
  try {
    const dockerProvider = await resolveDefaultSandbox();
    assertEqual(dockerProvider.providerType, "docker", "EVOLVE_SANDBOX_DOCKER=true → docker");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("Docker is not available")) {
      assert(true, "Docker env var accepted, daemon not running (expected)");
    } else {
      assert(false, `unexpected Docker error: ${msg.slice(0, 100)}`);
    }
  }

  // ─── Restore env and summarize ─────────────────────────────
  restoreEnv();

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { restoreEnv(); console.error("Test error:", err); process.exit(1); });
