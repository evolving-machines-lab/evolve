#!/usr/bin/env tsx
/**
 * Unit Test: Modal sandbox list pagination
 *
 * `list()` stopped at a hardcoded default of 100 sandboxes regardless of app
 * size and implemented no `listAll` at all — while the shared SandboxProvider
 * interface it satisfies promised exhaustive listing and a completeness
 * verdict. `listAll` being OPTIONAL in that type is exactly what let one
 * provider quietly disagree with it, which is why it is required now.
 *
 * Modal matters more than the others here: it publishes no lifecycle webhooks,
 * so absence from a list is the ONLY termination signal either lane gets. A
 * truncated walk read as a whole app is therefore not a slow query, it is a
 * fleet about to be reclaimed.
 *
 * What is asserted is the walk itself, with no gRPC in it:
 *   1. every sandbox is drained, not the first 100
 *   2. a limit that hides sandboxes reports INCOMPLETE
 *   3. a limit landing exactly at the end reports complete
 *   4. limit: 0 returns nothing, not one
 *   5. a failure mid-walk keeps what it saw and admits it did not finish
 *   6. the sandbox ceiling is a refusal, never a short "complete" answer
 *
 * Usage:
 *   npx tsx tests/unit/modal-list-pagination.test.ts
 */

import {
  MODAL_MAX_LIST_SANDBOXES,
  _testCollectSandboxes,
  type ModalSandboxStream,
} from "../../src/index.ts";

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

/** A generator of N sandboxes, optionally throwing after `throwAfter` of them. */
function stream(count: number, opts?: { throwAfter?: number; prefix?: string }) {
  return async function* (): AsyncGenerator<ModalSandboxStream> {
    for (let i = 0; i < count; i++) {
      if (opts?.throwAfter !== undefined && i === opts.throwAfter) {
        throw new Error("stream broke");
      }
      yield {
        sandboxId: `${opts?.prefix ?? "sb"}-${i}`,
        getTags: async () => ({}),
      };
    }
  };
}

// =============================================================================
// TESTS
// =============================================================================

async function testDrainsWholeApp(): Promise<void> {
  console.log("\n[1] The whole app, not the first 100");

  const page = await _testCollectSandboxes(stream(250));

  assert(page.sandboxes.length === 250, "returns all 250 sandboxes");
  assert(page.complete === true, "and reports complete");
  assert(page.error === undefined, "with no error");
}

async function testLimitHidesSandboxes(): Promise<void> {
  console.log("\n[2] A limit that hides sandboxes is INCOMPLETE");

  const page = await _testCollectSandboxes(stream(250), 100);

  assert(page.sandboxes.length === 100, "returns exactly the limit");
  assert(page.complete === false, "and INCOMPLETE — 150 more provably exist");
  assert((page.error ?? "").includes("limit"), "with a reason that names the limit");
}

async function testLimitAtFleetEnd(): Promise<void> {
  console.log("\n[3] A limit landing exactly at the end of the app IS complete");

  const page = await _testCollectSandboxes(stream(5), 5);

  assert(page.sandboxes.length === 5, "returns all five");
  assert(page.complete === true, "complete — nothing was hidden");
}

async function testLimitZero(): Promise<void> {
  console.log("\n[4] limit: 0 returns nothing, not one");

  const page = await _testCollectSandboxes(stream(3), 0);

  assert(page.sandboxes.length === 0, "returns zero sandboxes");
  assert(page.complete === false, "and says so — three were hidden by the bound");
}

async function testMidWalkFailure(): Promise<void> {
  console.log("\n[5] A failure mid-walk keeps what it saw and admits it did not finish");

  const page = await _testCollectSandboxes(stream(50, { throwAfter: 20 }));

  assert(page.sandboxes.length === 20, "keeps the twenty it read");
  assert(page.complete === false, "and reports INCOMPLETE");
  assert((page.error ?? "").includes("stream broke"), "carrying the underlying reason");
}

async function testFirstItemFailure(): Promise<void> {
  console.log("\n[6] A failure before the first sandbox is not an empty app");

  const page = await _testCollectSandboxes(stream(50, { throwAfter: 0 }));

  assert(page.sandboxes.length === 0, "no sandboxes");
  assert(
    page.complete === false,
    "but complete is FALSE — read as empty, this is the case that reclaims a live fleet",
  );
}

async function testCeiling(): Promise<void> {
  console.log("\n[7] The sandbox ceiling is a refusal, not a short answer");

  const page = await _testCollectSandboxes(stream(MODAL_MAX_LIST_SANDBOXES + 10));

  assert(
    page.sandboxes.length === MODAL_MAX_LIST_SANDBOXES,
    `stops at ${MODAL_MAX_LIST_SANDBOXES} sandboxes`,
  );
  assert(page.complete === false, "and says so rather than looking plausible");
  assert((page.error ?? "").includes("exceeded"), "with a readable reason");
}

async function testEmptyApp(): Promise<void> {
  console.log("\n[8] A genuinely empty app is COMPLETE and empty");

  const page = await _testCollectSandboxes(stream(0));

  assert(page.sandboxes.length === 0, "no sandboxes");
  assert(page.complete === true, "and complete — the answer a sweep may act on");
}

// =============================================================================
// RUNNER
// =============================================================================

const tests = [
  testDrainsWholeApp,
  testLimitHidesSandboxes,
  testLimitAtFleetEnd,
  testLimitZero,
  testMidWalkFailure,
  testFirstItemFailure,
  testCeiling,
  testEmptyApp,
];

(async () => {
  console.log("=== Modal Provider: list pagination + completeness Tests ===");
  try {
    for (const test of tests) {
      await test();
    }
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error("Unexpected error:", err);
    process.exit(1);
  }
})();
