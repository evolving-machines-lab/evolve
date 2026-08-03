#!/usr/bin/env tsx
/**
 * Unit Test: front-door configuration validation
 *
 * A run configured wrong used to travel all the way into buildCommand and die
 * at the shell-quoting helper with `Cannot read properties of undefined
 * (reading 'replace')` — a message that names nothing the caller wrote. The
 * required fields are now checked at the public entry (.withAgent() and
 * .run()) and reported as an EvolveConfigError carrying the field's name.
 *
 * What this pins down:
 *   - an empty model is rejected by name, with the agent's default in the hint;
 *   - an omitted model is still fine (the agent's default is the documented
 *     behaviour, and `model: undefined` reads the same as omitted in TS);
 *   - an unknown agent type is rejected by name and lists the valid types;
 *   - a run() without a prompt raises EvolveConfigError, never a TypeError;
 *   - the same checks guard the Agent constructor, the door a hand-built Agent
 *     goes through.
 *
 * Usage:
 *   npm run test:unit:config-validation
 *   npx tsx tests/unit/config-validation.test.ts
 */

import { Agent, Evolve, EvolveConfigError } from "../../dist/index.js";
import type { AgentConfig, ResolvedAgentConfig, RunOptions } from "../../src/types.js";

// =============================================================================
// TEST HELPERS
// =============================================================================

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
    console.log(`      Expected: ${String(expected)}`);
    console.log(`      Actual:   ${String(actual)}`);
  }
}

/** Run `fn`, return what it threw (or undefined if it did not throw). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

/** Await `fn`, return what it rejected with (or undefined if it resolved). */
async function rejectedBy(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

// =============================================================================
// TESTS
// =============================================================================

/** The reported crash: a missing model reached the shell-quoting helper. */
function testMissingModelIsNamed(): void {
  console.log("\n[1] A missing model is rejected by name");

  const error = thrownBy(() =>
    new Evolve().withAgent({ type: "droid", providerApiKey: "key", model: "" }),
  );

  assert(error instanceof EvolveConfigError, "an empty model throws EvolveConfigError");
  assertEqual((error as EvolveConfigError).field, "model", "the error names the model field");
  assertEqual(
    (error as Error).message,
    'Evolve agent config: "model" is empty (""). ' +
      'Pass a model id such as "claude-opus-5", ' +
      "or omit model entirely to use droid's default.",
    "the message states the field, the value, and a usable model id",
  );
  assert(
    !(error as Error).message.includes("Cannot read properties"),
    "the caller never sees the raw TypeError",
  );

  // Whitespace is not a model id either.
  const blank = thrownBy(() =>
    new Evolve().withAgent({ type: "claude", apiKey: "key", model: "   " }),
  );
  assertEqual((blank as EvolveConfigError)?.field, "model", "a whitespace-only model is rejected too");
}

/** Omitting the model is the documented way to take the agent's default. */
function testOmittedModelIsFine(): void {
  console.log("\n[2] An omitted model still means 'use the default'");

  const omitted = thrownBy(() => new Evolve().withAgent({ type: "droid", providerApiKey: "key" }));
  assertEqual(omitted, undefined, "omitting model does not throw");

  const explicitUndefined = thrownBy(() =>
    new Evolve().withAgent({ type: "droid", providerApiKey: "key", model: undefined }),
  );
  assertEqual(explicitUndefined, undefined, "model: undefined reads the same as omitted");

  const built = thrownBy(
    () => new Agent({ type: "droid", apiKey: "key", isDirectMode: true }),
  );
  assertEqual(built, undefined, "a hand-built Agent without a model still constructs");
}

/** A typo in the agent name is a front-door mistake as well. */
function testUnknownAgentType(): void {
  console.log("\n[3] An unknown agent type is rejected by name");

  const error = thrownBy(() =>
    new Evolve().withAgent({ type: "claude-code" as AgentConfig["type"], apiKey: "key" }),
  );

  assert(error instanceof EvolveConfigError, "an unknown type throws EvolveConfigError");
  assertEqual((error as EvolveConfigError).field, "type", "the error names the type field");
  assert(
    (error as Error).message.includes("claude, codex, gemini, qwen, kimi, opencode, droid"),
    "the message lists every valid agent type",
  );
}

/** run() without a prompt: the case that produced the raw TypeError. */
async function testMissingPrompt(): Promise<void> {
  console.log("\n[4] run() without a prompt is rejected before any command is built");

  const agent = new Agent({ type: "droid", apiKey: "key", isDirectMode: true });
  const error = await rejectedBy(() => agent.run({} as RunOptions));

  assert(error instanceof EvolveConfigError, "a missing prompt rejects with EvolveConfigError");
  assertEqual((error as EvolveConfigError).field, "prompt", "the error names the prompt field");
  assertEqual(
    (error as Error).message,
    'run() requires a non-empty "prompt" string, received undefined.',
    "the message states what run() wanted and what it got",
  );

  const empty = await rejectedBy(() => agent.run({ prompt: "" }));
  assertEqual((empty as EvolveConfigError)?.field, "prompt", "an empty prompt is rejected too");
}

/** A hand-built Agent skips withAgent(); the constructor is its door. */
function testAgentConstructorGuards(): void {
  console.log("\n[5] The Agent constructor enforces the same fields");

  const error = thrownBy(
    () =>
      new Agent({
        type: "opencode",
        apiKey: "key",
        isDirectMode: true,
        model: "",
      } as ResolvedAgentConfig),
  );

  assert(error instanceof EvolveConfigError, "an empty model rejects at construction too");
  assertEqual((error as EvolveConfigError).field, "model", "the error names the model field");
}

// =============================================================================
// RUNNER
// =============================================================================

async function main(): Promise<void> {
  console.log("Front-door configuration validation\n" + "=".repeat(60));

  testMissingModelIsNamed();
  testOmittedModelIsFine();
  testUnknownAgentType();
  await testMissingPrompt();
  testAgentConstructorGuards();

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
