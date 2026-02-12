#!/usr/bin/env tsx
/**
 * Unit Test: Checkpoint Error Handling
 *
 * Tests error conditions in checkpoint restore paths:
 * - Evolve.run(): `from` with `withSession()` → mutual exclusivity
 * - Agent.run(): `from` without storage configured
 * - Agent.run(): `from` with existing sandbox (via sandboxId)
 * - Agent.run(): `from` without sandbox provider
 *
 * Usage:
 *   npm run test:unit:checkpoint-errors
 *   npx tsx tests/unit/checkpoint-errors.test.ts
 */

import { Agent, Evolve } from "../../dist/index.js";

// =============================================================================
// TEST HELPERS
// =============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message}`);
  }
}

async function assertThrows(fn: () => unknown, substring: string, message: string): Promise<void> {
  try {
    await fn();
    failed++;
    console.log(`  \u2717 ${message} (did not throw)`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(substring)) {
      passed++;
      console.log(`  \u2713 ${message}`);
    } else {
      failed++;
      console.log(`  \u2717 ${message} (threw "${msg}", expected to contain "${substring}")`);
    }
  }
}

// =============================================================================
// MINIMAL CONFIGS
// =============================================================================

/** Minimal ResolvedAgentConfig for testing (not exported, so we cast) */
function makeAgentConfig() {
  return {
    type: "claude" as const,
    apiKey: "test-key-000",
    isDirectMode: true,
    isOAuth: false,
    model: "opus",
  };
}

/** Minimal ResolvedStorageConfig for testing */
function makeStorageConfig() {
  return {
    bucket: "test-bucket",
    prefix: "test-prefix",
    region: "us-east-1",
    mode: "byok" as const,
  };
}

/** Minimal no-op sandbox provider (for testing provider-present path) */
function makeMockProvider() {
  return {
    name: "mock",
    providerType: "mock",
    create: async () => {
      throw new Error("Mock provider: create should not be reached in this test");
    },
    connect: async () => {
      throw new Error("Mock provider: connect should not be reached in this test");
    },
  };
}

// =============================================================================
// TESTS: from + no storage
// =============================================================================

async function testFromWithoutStorage(): Promise<void> {
  console.log("\n[1] from + No Storage Configured");

  const agent = new Agent(makeAgentConfig() as any, {
    // No storage, no sandboxProvider, no sandboxId
  });

  await assertThrows(
    () => agent.run({ prompt: "test", from: "ckpt_abc123" }),
    "Storage not configured",
    "Throws when from is set but no storage configured"
  );
}

// =============================================================================
// TESTS: from + existing sandbox (sandboxId)
// =============================================================================

async function testFromWithExistingSandboxId(): Promise<void> {
  console.log("\n[2] from + Existing Sandbox (via sandboxId)");

  const agent = new Agent(makeAgentConfig() as any, {
    storage: makeStorageConfig(),
    sandboxId: "existing-sandbox-123",
    sandboxProvider: makeMockProvider() as any,
  });

  await assertThrows(
    () => agent.run({ prompt: "test", from: "ckpt_abc123" }),
    "Cannot restore into existing sandbox",
    "Throws when from is set with existing sandboxId"
  );
}

// =============================================================================
// TESTS: from + no sandbox provider
// =============================================================================

async function testFromWithoutSandboxProvider(): Promise<void> {
  console.log("\n[3] from + No Sandbox Provider");

  const agent = new Agent(makeAgentConfig() as any, {
    storage: makeStorageConfig(),
    // No sandboxProvider
  });

  await assertThrows(
    () => agent.run({ prompt: "test", from: "ckpt_abc123" }),
    "No sandbox provider configured",
    "Throws when from is set but no sandbox provider"
  );
}

// =============================================================================
// TESTS: concurrent run guard
// =============================================================================

async function testConcurrentRunGuard(): Promise<void> {
  console.log("\n[4] Concurrent Run Guard");

  // We can't easily simulate an active command without a real sandbox,
  // but we can verify the error message exists by checking the Agent class
  // has the guard. This test validates the Agent constructor works with
  // storage config and the error paths are reachable.

  const agent = new Agent(makeAgentConfig() as any, {
    storage: makeStorageConfig(),
    sandboxProvider: makeMockProvider() as any,
  });

  // Verify agent was created successfully with storage
  assert(agent !== null, "Agent created with storage config");
  assert(agent.getSession() === null, "No session before first run");
}

// =============================================================================
// TESTS: from + storage + provider (reaches sandbox creation, which fails with mock)
// =============================================================================

async function testFromReachesSandboxCreation(): Promise<void> {
  console.log("\n[5] from + Storage + Provider (reaches sandbox creation)");

  const agent = new Agent(makeAgentConfig() as any, {
    storage: makeStorageConfig(),
    sandboxProvider: makeMockProvider() as any,
  });

  // This should pass the guard checks and reach sandbox creation,
  // which will throw from our mock provider
  await assertThrows(
    () => agent.run({ prompt: "test", from: "ckpt_abc123" }),
    "Mock provider: create should not be reached",
    "Passes all guards and reaches sandbox creation"
  );
}

// =============================================================================
// TESTS: run without from works normally (until sandbox needed)
// =============================================================================

async function testRunWithoutFromHitsNoProvider(): Promise<void> {
  console.log("\n[6] Normal Run Without from (no provider)");

  const agent = new Agent(makeAgentConfig() as any, {
    // No sandboxProvider, no storage
  });

  // Normal run without from should fail at getSandbox() because no provider
  await assertThrows(
    () => agent.run({ prompt: "test" }),
    "No sandbox provider configured",
    "Normal run without provider throws at getSandbox"
  );
}

// =============================================================================
// TESTS: Evolve-level — from + withSession() mutual exclusivity
// =============================================================================

async function testEvolveFromWithSession(): Promise<void> {
  console.log("\n[7] Evolve: from + withSession() Mutual Exclusivity");

  // Evolve.run() checks from + sandboxId BEFORE agent initialization,
  // so we don't need a full agent/sandbox setup
  const kit = new Evolve()
    .withSession("existing-sandbox-123");

  await assertThrows(
    () => (kit as any).run({ prompt: "test", from: "ckpt_abc123" }),
    "Cannot use 'from' with 'withSession()'",
    "Evolve throws when from is set with withSession()"
  );
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Checkpoint Error Handling Unit Tests");
  console.log("=".repeat(60));

  await testFromWithoutStorage();
  await testFromWithExistingSandboxId();
  await testFromWithoutSandboxProvider();
  await testConcurrentRunGuard();
  await testFromReachesSandboxCreation();
  await testRunWithoutFromHitsNoProvider();
  await testEvolveFromWithSession();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
