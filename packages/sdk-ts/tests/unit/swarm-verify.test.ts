#!/usr/bin/env tsx
/**
 * Unit Test: Swarm Verify Feature
 *
 * Tests the verify option across map, filter, and reduce operations:
 * - Verify passes on first attempt
 * - Verify retries with feedback on failure
 * - Verify exhausts max retries
 * - Concurrency is respected across workers and verifiers
 * - Verify is mutually exclusive with bestOf
 *
 * Uses mocked execute() to avoid real sandbox/agent calls.
 *
 * Usage:
 *   npm run test:unit:verify
 *   npx tsx tests/unit/swarm-verify.test.ts
 */

import { Swarm, type SwarmConfig, type FileMap } from "../../dist/index.js";
import { z } from "zod";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// MOCK INFRASTRUCTURE
// =============================================================================

interface ExecuteCall {
  tagPrefix: string;
  startTime: number;
  endTime?: number;
  isVerify: boolean;
}

interface MockTracker {
  calls: ExecuteCall[];
  concurrent: number;
  maxConcurrent: number;
  callOrder: string[];
  verifyAttemptsByItem: Map<number, number>;
  workerAttemptsByItem: Map<number, number>;
}

interface MockOptions {
  /** Verify passes on which attempt per item (1 = first try, 2 = second try, etc.) */
  verifyPassOnAttempt?: number;
  /** Execution delay in ms */
  execDelay?: number;
  /** Map of item index to number of worker failures before success */
  workerFailures?: Map<number, number>;
}

function createMockSwarmForVerify(
  concurrency: number,
  options: MockOptions = {}
): { swarm: Swarm; tracker: MockTracker } {
  const { verifyPassOnAttempt = 1, execDelay = 15, workerFailures = new Map() } = options;

  const tracker: MockTracker = {
    calls: [],
    concurrent: 0,
    maxConcurrent: 0,
    callOrder: [],
    verifyAttemptsByItem: new Map(),
    workerAttemptsByItem: new Map(),
  };

  // Create a mock sandbox provider
  const mockSandbox = {
    create: async () => ({
      id: "mock-sandbox",
      commands: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      files: {
        list: async () => [],
        read: async () => new Uint8Array(),
        write: async () => {},
      },
      kill: async () => {},
    }),
  };

  const config: SwarmConfig = {
    agent: { type: "claude", apiKey: "mock-key" },
    sandbox: mockSandbox as any,
    concurrency,
    tag: "test",
  };

  const swarm = new Swarm(config);

  // Override the private execute method
  (swarm as any).execute = async function (
    _context: FileMap,
    _prompt: string,
    opts: { tagPrefix: string; timeout: number; schema?: unknown; systemPrompt?: string; agent?: unknown }
  ) {
    // New tag format: test-map-0-verifier, test-filter-1-verifier, test-reduce-verifier
    const isVerify = opts.tagPrefix.includes("-verifier");

    const call: ExecuteCall = {
      tagPrefix: opts.tagPrefix,
      startTime: Date.now(),
      isVerify,
    };
    tracker.calls.push(call);
    tracker.callOrder.push(opts.tagPrefix);

    tracker.concurrent++;
    tracker.maxConcurrent = Math.max(tracker.maxConcurrent, tracker.concurrent);

    // Simulate work
    await sleep(execDelay);

    tracker.concurrent--;
    call.endTime = Date.now();

    if (isVerify) {
      // Extract item index from tag
      // New format: test-map-0-verify or test-map-0-r1-verify
      // Look for pattern: -{operation}-{index} or -{operation}-{index}-r{n}
      const match = opts.tagPrefix.match(/-(map|filter|reduce)-(\d+)/);
      const itemIndex = match ? parseInt(match[2], 10) : 0;

      // Track verify attempts per item
      const currentAttempt = (tracker.verifyAttemptsByItem.get(itemIndex) ?? 0) + 1;
      tracker.verifyAttemptsByItem.set(itemIndex, currentAttempt);

      // Verify passes on specified attempt
      const shouldPass = currentAttempt >= verifyPassOnAttempt;

      return {
        files: {
          "result.json": JSON.stringify({
            passed: shouldPass,
            reasoning: shouldPass ? "Output meets criteria" : "Needs improvement",
            feedback: shouldPass ? undefined : "Please fix the issues",
          }),
        },
        data: {
          passed: shouldPass,
          reasoning: shouldPass ? "Output meets criteria" : "Needs improvement",
          feedback: shouldPass ? undefined : "Please fix the issues",
        },
        tag: opts.tagPrefix + "-abc123",
        sandboxId: "mock-sandbox-id",
      };
    }

    // Regular worker execution
    // Extract item index from tag (e.g., test-map-0 or test-map-0-r1)
    const workerMatch = opts.tagPrefix.match(/-(map|filter|reduce)-(\d+)/);
    const workerItemIndex = workerMatch ? parseInt(workerMatch[2], 10) : 0;

    // Track worker attempts per item
    const workerAttempt = (tracker.workerAttemptsByItem.get(workerItemIndex) ?? 0) + 1;
    tracker.workerAttemptsByItem.set(workerItemIndex, workerAttempt);

    // Check if worker should fail
    const failuresRemaining = workerFailures.get(workerItemIndex) ?? 0;
    if (failuresRemaining > 0) {
      workerFailures.set(workerItemIndex, failuresRemaining - 1);
      return {
        files: {},
        data: null,
        tag: opts.tagPrefix + "-abc123",
        sandboxId: "mock-sandbox-id",
        error: "Simulated worker failure",
      };
    }

    const mockData = opts.schema ? { mock: true, score: 5, value: 10 } : {};
    return {
      files: { "result.json": JSON.stringify(mockData), "output.txt": "generated content" },
      data: mockData,
      tag: opts.tagPrefix + "-abc123",
      sandboxId: "mock-sandbox-id",
    };
  };

  return { swarm, tracker };
}

// =============================================================================
// VERIFY TESTS
// =============================================================================

async function testMapWithVerifyPassesFirstTry(): Promise<void> {
  console.log("\n[1] map() with verify: Passes on first attempt");

  const { swarm, tracker } = createMockSwarmForVerify(2, { verifyPassOnAttempt: 1 });

  const items: FileMap[] = [
    { "input1.txt": "content 1" },
    { "input2.txt": "content 2" },
  ];

  const results = await swarm.map({
    items,
    prompt: "Process this",
    verify: {
      criteria: "Output must be valid",
      maxAttempts: 3,
    },
  });

  // 2 worker calls + 2 verify calls = 4 total
  assert(tracker.calls.length === 4, `Total calls: ${tracker.calls.length}, expected 4`);

  // Both should succeed
  assert(results.success.length === 2, `Success count: ${results.success.length}, expected 2`);

  // Verify info should be present
  assert(results[0].verify !== undefined, "First result should have verify info");
  assert(results[0].verify?.passed === true, "First result verify should pass");
  assert(results[0].verify?.attempts === 1, `Attempts: ${results[0].verify?.attempts}, expected 1`);

  // Concurrency respected
  assert(tracker.maxConcurrent <= 2, `Max concurrent was ${tracker.maxConcurrent}, expected <= 2`);
}

async function testMapWithVerifyRetries(): Promise<void> {
  console.log("\n[2] map() with verify: Retries on failure then passes");

  // Verify fails first time, passes second time
  const { swarm, tracker } = createMockSwarmForVerify(2, { verifyPassOnAttempt: 2 });

  const items: FileMap[] = [{ "input.txt": "content" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    verify: {
      criteria: "Must be valid",
      maxAttempts: 3,
    },
  });

  // Attempt 1: worker + verify(fail) = 2 calls
  // Attempt 2: worker + verify(pass) = 2 calls
  // Total: 4 calls
  assert(tracker.calls.length === 4, `Total calls: ${tracker.calls.length}, expected 4`);

  // Should succeed after retry
  assert(results.success.length === 1, `Success count: ${results.success.length}, expected 1`);
  assert(results[0].verify?.passed === true, "Verify should pass after retry");
  assert(results[0].verify?.attempts === 2, `Attempts: ${results[0].verify?.attempts}, expected 2`);
}

async function testMapWithVerifyExhaustsRetries(): Promise<void> {
  console.log("\n[3] map() with verify: Exhausts all retries");

  // Verify never passes (passOnAttempt = 99)
  const { swarm, tracker } = createMockSwarmForVerify(2, { verifyPassOnAttempt: 99 });

  const items: FileMap[] = [{ "input.txt": "content" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    verify: {
      criteria: "Must be valid",
      maxAttempts: 2, // 2 total attempts
    },
  });

  // Attempt 1: worker + verify (fail) = 2 calls
  // Attempt 2: worker + verify (fail) = 2 calls
  // Total: 4 calls
  assert(tracker.calls.length === 4, `Total calls: ${tracker.calls.length}, expected 4`);

  // Result should show verify failed (status = error when max exceeded)
  assert(results[0].verify?.passed === false, "Verify should show as failed");
  assert(results[0].verify?.attempts === 2, `Attempts: ${results[0].verify?.attempts}, expected 2`);
  assert(results[0].status === "error", `Status: ${results[0].status}, expected error`);
}

async function testMapWithVerifyConcurrency(): Promise<void> {
  console.log("\n[4] map() with verify: Respects concurrency across workers and verifiers");

  const { swarm, tracker } = createMockSwarmForVerify(3, { verifyPassOnAttempt: 1 });

  // 6 items with concurrency 3
  const items: FileMap[] = Array.from({ length: 6 }, (_, i) => ({ [`file${i}.txt`]: `content ${i}` }));

  await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 2 },
  });

  // 6 workers + 6 verifies = 12 calls
  assert(tracker.calls.length === 12, `Total calls: ${tracker.calls.length}, expected 12`);

  // Concurrency never exceeds 3
  assert(tracker.maxConcurrent <= 3, `Max concurrent was ${tracker.maxConcurrent}, expected <= 3`);

  // Verify calls should be interleaved with worker calls
  const verifyCalls = tracker.calls.filter((c) => c.isVerify);
  assert(verifyCalls.length === 6, `Verify calls: ${verifyCalls.length}, expected 6`);
}

async function testFilterWithVerify(): Promise<void> {
  console.log("\n[5] filter() with verify: Works correctly");

  const { swarm, tracker } = createMockSwarmForVerify(2, { verifyPassOnAttempt: 1 });

  const items: FileMap[] = [
    { "a.txt": "a" },
    { "b.txt": "b" },
    { "c.txt": "c" },
  ];

  const schema = z.object({ score: z.number() });

  const results = await swarm.filter({
    items,
    prompt: "Evaluate",
    schema,
    condition: (d) => d.score > 3,
    verify: { criteria: "Evaluation is accurate", maxAttempts: 2 },
  });

  // 3 filter workers + 3 verifies = 6 calls
  assert(tracker.calls.length === 6, `Total calls: ${tracker.calls.length}, expected 6`);

  // All should pass filter (mock returns score=5)
  assert(results.success.length === 3, `Success count: ${results.success.length}, expected 3`);

  // Verify info present on results
  assert(results[0].verify !== undefined, "Filter results should have verify info");
  assert(results[0].verify?.passed === true, "Filter verify should pass");
}

async function testReduceWithVerify(): Promise<void> {
  console.log("\n[6] reduce() with verify: Works correctly");

  const { swarm, tracker } = createMockSwarmForVerify(2, { verifyPassOnAttempt: 1 });

  const items: FileMap[] = [
    { "1.txt": "one" },
    { "2.txt": "two" },
  ];

  const result = await swarm.reduce({
    items,
    prompt: "Synthesize these",
    verify: { criteria: "Synthesis is complete", maxAttempts: 2 },
  });

  // 1 reduce worker + 1 verify = 2 calls
  assert(tracker.calls.length === 2, `Total calls: ${tracker.calls.length}, expected 2`);

  // Should succeed
  assert(result.status === "success", `Status: ${result.status}, expected success`);
  assert(result.verify !== undefined, "Reduce result should have verify info");
  assert(result.verify?.passed === true, "Verify should pass");
}

async function testReduceWithVerifyRetries(): Promise<void> {
  console.log("\n[7] reduce() with verify: Retries entire reduce on verify failure");

  const { swarm, tracker } = createMockSwarmForVerify(2, { verifyPassOnAttempt: 2 });

  const items: FileMap[] = [
    { "1.txt": "one" },
    { "2.txt": "two" },
  ];

  const result = await swarm.reduce({
    items,
    prompt: "Synthesize",
    verify: { criteria: "Must be complete", maxAttempts: 3 },
  });

  // Attempt 1: reduce + verify (fail) = 2 calls
  // Attempt 2: reduce + verify (pass) = 2 calls
  // Total: 4 calls
  assert(tracker.calls.length === 4, `Total calls: ${tracker.calls.length}, expected 4`);

  assert(result.status === "success", `Status: ${result.status}, expected success`);
  assert(result.verify?.attempts === 2, `Verify attempts: ${result.verify?.attempts}, expected 2`);
}

async function testVerifyBestOfMutuallyExclusive(): Promise<void> {
  console.log("\n[8] map() with verify AND bestOf: Should be mutually exclusive");

  const { swarm } = createMockSwarmForVerify(2);

  let errorThrown = false;
  let errorMessage = "";
  try {
    await swarm.map({
      items: [{ "test.txt": "content" }],
      prompt: "Process",
      verify: { criteria: "Valid" },
      bestOf: { n: 2, judgeCriteria: "Best" },
    });
  } catch (e) {
    errorThrown = true;
    errorMessage = (e as Error).message;
  }

  assert(errorThrown, "Should throw an error for verify + bestOf");
  assert(
    errorMessage.toLowerCase().includes("mutually exclusive") ||
      errorMessage.toLowerCase().includes("cannot use both"),
    `Error mentions mutual exclusivity: "${errorMessage}"`
  );
}

async function testVerifyWithStandardRetry(): Promise<void> {
  console.log("\n[9] map() with verify AND retry: Both work together");

  const { swarm, tracker } = createMockSwarmForVerify(2, { verifyPassOnAttempt: 1 });

  const items: FileMap[] = [
    { "input1.txt": "content 1" },
    { "input2.txt": "content 2" },
  ];

  const results = await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 2 },
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // No worker failures in this test, so: 2 workers + 2 verifies = 4
  assert(tracker.calls.length === 4, `Total calls: ${tracker.calls.length}, expected 4`);
  assert(results.success.length === 2, `Success count: ${results.success.length}, expected 2`);
}

async function testMapWithVerifyMultipleItems(): Promise<void> {
  console.log("\n[10] map() with verify: Multiple items with different verify attempts");

  // Each item needs 2 verify attempts to pass
  const { swarm, tracker } = createMockSwarmForVerify(4, { verifyPassOnAttempt: 2 });

  const items: FileMap[] = Array.from({ length: 4 }, (_, i) => ({ [`file${i}.txt`]: `content ${i}` }));

  const results = await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 3 },
  });

  // Each item: 2 workers + 2 verifies = 4 calls
  // 4 items × 4 calls = 16 total
  assert(tracker.calls.length === 16, `Total calls: ${tracker.calls.length}, expected 16`);

  // All should succeed
  assert(results.success.length === 4, `Success count: ${results.success.length}, expected 4`);

  // Each should have 2 attempts
  for (let i = 0; i < results.length; i++) {
    assert(
      results[i].verify?.attempts === 2,
      `Item ${i} attempts: ${results[i].verify?.attempts}, expected 2`
    );
  }

  // Concurrency respected
  assert(tracker.maxConcurrent <= 4, `Max concurrent was ${tracker.maxConcurrent}, expected <= 4`);
}

async function testVerifyOrderingWorkerBeforeVerifier(): Promise<void> {
  console.log("\n[11] Verify ordering: Worker always runs before its verifier");

  const { swarm, tracker } = createMockSwarmForVerify(2, { verifyPassOnAttempt: 1 });

  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 2 },
  });

  // Find worker and verify calls
  const workerCalls = tracker.calls.filter((c) => !c.isVerify);
  const verifyCalls = tracker.calls.filter((c) => c.isVerify);

  assert(workerCalls.length === 1, `Worker calls: ${workerCalls.length}, expected 1`);
  assert(verifyCalls.length === 1, `Verify calls: ${verifyCalls.length}, expected 1`);

  // Worker should complete before verify starts
  assert(
    workerCalls[0].endTime! <= verifyCalls[0].startTime,
    "Worker completed before verify started"
  );
}

async function testWorkerErrorRetryWithVerify(): Promise<void> {
  console.log("\n[12] Worker error retry with verify: Worker fails, retries, succeeds, then verify runs");

  // Item 0: worker fails once then succeeds
  // Item 1: worker succeeds first try
  const workerFailures = new Map([[0, 1]]);

  const { swarm, tracker } = createMockSwarmForVerify(2, {
    verifyPassOnAttempt: 1,
    execDelay: 10,
    workerFailures,
  });

  const items: FileMap[] = [
    { "input1.txt": "content 1" },
    { "input2.txt": "content 2" },
  ];

  const results = await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 2 },
    retry: { maxAttempts: 3, backoffMs: 5 },
  });

  // Item 0: worker fail + worker success + verify = 3 calls
  // Item 1: worker success + verify = 2 calls
  // Total: 5 calls
  assert(tracker.calls.length === 5, `Total calls: ${tracker.calls.length}, expected 5`);

  // Both should succeed
  assert(results.success.length === 2, `Success count: ${results.success.length}, expected 2`);

  // Worker attempts: item 0 had 2 attempts, item 1 had 1 attempt
  assert(
    tracker.workerAttemptsByItem.get(0) === 2,
    `Item 0 worker attempts: ${tracker.workerAttemptsByItem.get(0)}, expected 2`
  );
  assert(
    tracker.workerAttemptsByItem.get(1) === 1,
    `Item 1 worker attempts: ${tracker.workerAttemptsByItem.get(1)}, expected 1`
  );

  // Verify should have run for both items
  const verifyCalls = tracker.calls.filter((c) => c.isVerify);
  assert(verifyCalls.length === 2, `Verify calls: ${verifyCalls.length}, expected 2`);

  // Both results should have verify info with passed=true
  assert(results[0].verify?.passed === true, "Item 0 verify should pass");
  assert(results[1].verify?.passed === true, "Item 1 verify should pass");
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Swarm Verify Feature Tests");
  console.log("=".repeat(70));

  await testMapWithVerifyPassesFirstTry();
  await testMapWithVerifyRetries();
  await testMapWithVerifyExhaustsRetries();
  await testMapWithVerifyConcurrency();
  await testFilterWithVerify();
  await testReduceWithVerify();
  await testReduceWithVerifyRetries();
  await testVerifyBestOfMutuallyExclusive();
  await testVerifyWithStandardRetry();
  await testMapWithVerifyMultipleItems();
  await testVerifyOrderingWorkerBeforeVerifier();
  await testWorkerErrorRetryWithVerify();

  console.log("\n" + "=".repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(70));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
