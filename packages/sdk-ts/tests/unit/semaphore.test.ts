#!/usr/bin/env tsx
/**
 * Unit Test: Semaphore
 *
 * Tests the Semaphore class for correct concurrency control behavior.
 * No external dependencies (sandbox, agents) - pure unit tests.
 *
 * Usage:
 *   npm run test:unit:semaphore
 *   npx tsx tests/unit/semaphore.test.ts
 */

import { Semaphore } from "../../dist/index.js";

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

async function assertThrows(fn: () => unknown, message: string): Promise<void> {
  try {
    await fn();
    failed++;
    console.log(`  ✗ ${message} (did not throw)`);
  } catch {
    passed++;
    console.log(`  ✓ ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// TESTS
// =============================================================================

async function testConstructorValidation(): Promise<void> {
  console.log("\n[1] Constructor Validation");

  // max < 1 should throw
  await assertThrows(() => new Semaphore(0), "Semaphore(0) throws");
  await assertThrows(() => new Semaphore(-1), "Semaphore(-1) throws");

  // max >= 1 should not throw
  const sem1 = new Semaphore(1);
  assert(sem1 !== null, "Semaphore(1) creates instance");

  const sem10 = new Semaphore(10);
  assert(sem10 !== null, "Semaphore(10) creates instance");
}

async function testBasicUsage(): Promise<void> {
  console.log("\n[2] Basic Usage");

  const sem = new Semaphore(1);
  let executed = false;

  const result = await sem.use(async () => {
    executed = true;
    return 42;
  });

  assert(executed, "Function was executed");
  assert(result === 42, "Return value is passed through");
}

async function testConcurrencyLimit(): Promise<void> {
  console.log("\n[3] Concurrency Limit Enforcement");

  const sem = new Semaphore(2);
  let concurrent = 0;
  let maxConcurrent = 0;
  const results: number[] = [];

  const task = async (id: number): Promise<number> => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(50); // Simulate work
    concurrent--;
    results.push(id);
    return id;
  };

  // Launch 5 tasks with concurrency limit of 2
  const promises = [
    sem.use(() => task(1)),
    sem.use(() => task(2)),
    sem.use(() => task(3)),
    sem.use(() => task(4)),
    sem.use(() => task(5)),
  ];

  await Promise.all(promises);

  assert(maxConcurrent === 2, `Max concurrent was ${maxConcurrent}, expected 2`);
  assert(results.length === 5, `All 5 tasks completed`);
}

async function testQueueOrdering(): Promise<void> {
  console.log("\n[4] Queue Ordering (FIFO)");

  const sem = new Semaphore(1);
  const order: number[] = [];

  // First task holds the semaphore
  const blocker = sem.use(async () => {
    await sleep(100);
    order.push(0);
  });

  // These should queue in order
  await sleep(10); // Ensure blocker starts first
  const p1 = sem.use(async () => order.push(1));
  const p2 = sem.use(async () => order.push(2));
  const p3 = sem.use(async () => order.push(3));

  await Promise.all([blocker, p1, p2, p3]);

  assert(order[0] === 0, `First task completed first (was ${order[0]})`);
  assert(order[1] === 1, `Queued tasks run in FIFO order: pos 1 is ${order[1]}`);
  assert(order[2] === 2, `Queued tasks run in FIFO order: pos 2 is ${order[2]}`);
  assert(order[3] === 3, `Queued tasks run in FIFO order: pos 3 is ${order[3]}`);
}

async function testErrorPropagation(): Promise<void> {
  console.log("\n[5] Error Propagation");

  const sem = new Semaphore(1);
  let errorCaught = false;

  try {
    await sem.use(async () => {
      throw new Error("Test error");
    });
  } catch (e) {
    errorCaught = true;
    assert((e as Error).message === "Test error", "Error message preserved");
  }

  assert(errorCaught, "Error was propagated");

  // Semaphore should still work after error
  const result = await sem.use(async () => "recovered");
  assert(result === "recovered", "Semaphore works after error (permit released)");
}

async function testReleaseOnError(): Promise<void> {
  console.log("\n[6] Release on Error (Finally Block)");

  const sem = new Semaphore(1);

  // First task throws
  try {
    await sem.use(async () => {
      throw new Error("Intentional");
    });
  } catch {
    // Expected
  }

  // If permit wasn't released, this would hang forever
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), 500)
  );
  const task = sem.use(async () => "success");

  try {
    const result = await Promise.race([task, timeout]);
    assert(result === "success", "Second task acquired permit (release worked)");
  } catch {
    assert(false, "Second task should not timeout");
  }
}

async function testHighConcurrency(): Promise<void> {
  console.log("\n[7] High Concurrency Stress Test");

  const sem = new Semaphore(5);
  let concurrent = 0;
  let maxConcurrent = 0;
  const completed: number[] = [];

  const task = async (id: number): Promise<void> => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(Math.random() * 20); // Random work
    concurrent--;
    completed.push(id);
  };

  // Launch 50 tasks with concurrency limit of 5
  const promises = Array.from({ length: 50 }, (_, i) => sem.use(() => task(i)));

  await Promise.all(promises);

  assert(maxConcurrent <= 5, `Max concurrent was ${maxConcurrent}, expected <= 5`);
  assert(completed.length === 50, `All 50 tasks completed`);
}

async function testSynchronousReturn(): Promise<void> {
  console.log("\n[8] Synchronous Function Support");

  const sem = new Semaphore(1);

  // The function signature expects Promise<T>, but let's verify async wrapping works
  const result = await sem.use(async () => {
    return "sync-result";
  });

  assert(result === "sync-result", "Synchronous return value handled");
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Semaphore Unit Tests");
  console.log("=".repeat(60));

  await testConstructorValidation();
  await testBasicUsage();
  await testConcurrencyLimit();
  await testQueueOrdering();
  await testErrorPropagation();
  await testReleaseOnError();
  await testHighConcurrency();
  await testSynchronousReturn();

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
