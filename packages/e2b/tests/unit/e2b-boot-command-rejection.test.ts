#!/usr/bin/env tsx
/**
 * Unit Test: E2B boot-command rejection — offline, typed, before any API call.
 *
 * e2b takes no create-time boot command: the sandbox boots its template's own
 * init, and a start command is a template-BUILD field (Template startCmd) this
 * provider never sets. The provider law (SandboxCreateOptions doc in the SDK)
 * says reject what cannot be enforced, never silently ignore — a `bootCommand`
 * that fell through would read as the inert boot the caller asked for, with
 * the requested argv never run and no trace of the drop.
 *
 * Usage:
 *   npx tsx tests/unit/e2b-boot-command-rejection.test.ts
 */

import { E2BBootCommandError, createE2BProvider } from "../../src/index.ts";

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

async function main(): Promise<void> {
  console.log("\n[1] create() - bootCommand typed-rejected offline");
  const provider = createE2BProvider({ apiKey: "test-key" });

  let error: unknown;
  try {
    await provider.create({ bootCommand: ["sh", "-c", "sleep infinity"] });
  } catch (e) {
    error = e;
  }
  assert(error instanceof E2BBootCommandError, "bootCommand throws E2BBootCommandError");
  assert(
    String(error).includes("startCmd"),
    "Message names the template-build field that DOES take a start command"
  );
  assert(
    String(error).includes("exec"),
    "Message points at the honest alternative: exec after create"
  );

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
