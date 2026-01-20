#!/usr/bin/env tsx
/**
 * Unit Test: Swarm Retry + Verify Combinations
 *
 * Tests all combinations of retry and verify options across map, filter, and reduce:
 * - Tag naming: -er{n} for error retries, -vr{n} for verify retries
 * - retryOn: Workers keep custom retryOn, verifiers ignore it
 * - All abstractions: map, filter, reduce
 *
 * Uses mocked execute() to avoid real sandbox/agent calls.
 *
 * Usage:
 *   npx tsx tests/unit/swarm-retry-verify.test.ts
 */

import { Swarm, type SwarmConfig, type FileMap, type SwarmResult } from "../../src/index.js";
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
  isVerify: boolean;
  result: "success" | "error";
}

interface MockTracker {
  calls: ExecuteCall[];
  tags: string[];
  workerTags: string[];
  verifierTags: string[];
  retryOnChecks: { tagPrefix: string; wasApplied: boolean }[];
}

interface MockOptions {
  /** Map of tag pattern to number of failures before success */
  failuresPerTag?: Map<string, number>;
  /** Verify passes on which attempt per item (1 = first try, etc.) */
  verifyPassOnAttempt?: number;
  /** Custom retryOn condition - returns true if should retry */
  customRetryOn?: (result: { status: string; error?: string }) => boolean;
  /** Track when retryOn is checked */
  trackRetryOn?: boolean;
}

function createMockSwarm(
  concurrency: number,
  options: MockOptions = {}
): { swarm: Swarm; tracker: MockTracker } {
  const {
    failuresPerTag = new Map(),
    verifyPassOnAttempt = 1,
    customRetryOn,
    trackRetryOn = false,
  } = options;

  const tracker: MockTracker = {
    calls: [],
    tags: [],
    workerTags: [],
    verifierTags: [],
    retryOnChecks: [],
  };

  // Track failures per tag pattern
  const failureCounters = new Map<string, number>();

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

  // Track verify attempts per item (by item key like "map-0", "filter-1", "reduce")
  const verifyAttempts = new Map<string, number>();

  // Override execute
  (swarm as any).execute = async function (
    _context: FileMap,
    _prompt: string,
    opts: { tagPrefix: string; timeout: number; schema?: unknown; systemPrompt?: string }
  ) {
    const isVerify = opts.tagPrefix.includes("-verifier");

    tracker.tags.push(opts.tagPrefix);
    if (isVerify) {
      tracker.verifierTags.push(opts.tagPrefix);
    } else {
      tracker.workerTags.push(opts.tagPrefix);
    }

    await sleep(5);

    if (isVerify) {
      // Extract item key for verify attempt tracking
      // e.g., "test-map-0-verifier" or "test-map-0-vr1-verifier" -> "map-0"
      // e.g., "test-reduce-verifier" -> "reduce"
      const itemMatch = opts.tagPrefix.match(/test-(map|filter)-(\d+)/);
      const reduceMatch = opts.tagPrefix.match(/test-(reduce)/);
      const itemKey = itemMatch ? `${itemMatch[1]}-${itemMatch[2]}` : (reduceMatch ? "reduce" : opts.tagPrefix);

      const currentAttempt = (verifyAttempts.get(itemKey) ?? 0) + 1;
      verifyAttempts.set(itemKey, currentAttempt);

      const shouldPass = currentAttempt >= verifyPassOnAttempt;

      const call: ExecuteCall = {
        tagPrefix: opts.tagPrefix,
        isVerify: true,
        result: "success",
      };
      tracker.calls.push(call);

      return {
        files: {
          "result.json": JSON.stringify({
            passed: shouldPass,
            reasoning: shouldPass ? "OK" : "Needs work",
            feedback: shouldPass ? undefined : "Fix it",
          }),
        },
        data: {
          passed: shouldPass,
          reasoning: shouldPass ? "OK" : "Needs work",
          feedback: shouldPass ? undefined : "Fix it",
        },
        tag: opts.tagPrefix + "-abc",
        sandboxId: "mock-id",
      };
    }

    // Worker execution - check for configured failures
    let shouldFail = false;

    // Check each failure pattern
    for (const [pattern, maxFailures] of failuresPerTag.entries()) {
      if (opts.tagPrefix.includes(pattern) || opts.tagPrefix.match(new RegExp(pattern))) {
        const counter = failureCounters.get(pattern) ?? 0;
        if (counter < maxFailures) {
          failureCounters.set(pattern, counter + 1);
          shouldFail = true;
          break;
        }
      }
    }

    const call: ExecuteCall = {
      tagPrefix: opts.tagPrefix,
      isVerify: false,
      result: shouldFail ? "error" : "success",
    };
    tracker.calls.push(call);

    if (shouldFail) {
      return {
        files: {},
        data: null,
        tag: opts.tagPrefix + "-abc",
        sandboxId: "mock-id",
        error: "Simulated failure for retry testing",
      };
    }

    const mockData = opts.schema ? { mock: true, score: 5, value: 10 } : {};
    return {
      files: { "result.json": JSON.stringify(mockData), "output.txt": "content" },
      data: mockData,
      tag: opts.tagPrefix + "-abc",
      sandboxId: "mock-id",
    };
  };

  return { swarm, tracker };
}

// =============================================================================
// TEST: MAP + RETRY + VERIFY TAG NAMING
// =============================================================================

async function testMapRetryTagNaming(): Promise<void> {
  console.log("\n[1] map + retry: Worker error retry gets -er{n} tag suffix");

  // First call to test-map-0 fails, second succeeds
  const failuresPerTag = new Map([["test-map-0", 1]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag });

  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.map({
    items,
    prompt: "Process",
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  // Should have 2 worker calls: test-map-0 (fail), test-map-0-er1 (success)
  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-map-0", `First tag: ${tracker.workerTags[0]}, expected test-map-0`);
  assert(tracker.workerTags[1] === "test-map-0-er1", `Second tag: ${tracker.workerTags[1]}, expected test-map-0-er1`);
}

async function testMapVerifyRetryTagNaming(): Promise<void> {
  console.log("\n[2] map + verify: Verify retry gets -vr{n} tag suffix on worker");

  // Verify fails first attempt, passes second
  const { swarm, tracker } = createMockSwarm(2, { verifyPassOnAttempt: 2 });

  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 3 },
  });

  // Worker tags: test-map-0 (first attempt), test-map-0-vr1 (verify retry)
  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-map-0", `First worker tag: ${tracker.workerTags[0]}, expected test-map-0`);
  assert(tracker.workerTags[1] === "test-map-0-vr1", `Second worker tag: ${tracker.workerTags[1]}, expected test-map-0-vr1`);

  // Verifier tags: test-map-0-verifier, test-map-0-vr1-verifier
  assert(tracker.verifierTags.length === 2, `Verifier tags count: ${tracker.verifierTags.length}, expected 2`);
  assert(tracker.verifierTags[0] === "test-map-0-verifier", `First verifier tag: ${tracker.verifierTags[0]}`);
  assert(tracker.verifierTags[1] === "test-map-0-vr1-verifier", `Second verifier tag: ${tracker.verifierTags[1]}`);
}

async function testMapRetryAndVerifyTagNaming(): Promise<void> {
  console.log("\n[3] map + retry + verify: Error retry within verify loop gets combined tags");

  // Worker fails once on first verify attempt
  const failuresPerTag = new Map([["test-map-0", 1]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag, verifyPassOnAttempt: 1 });

  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 2 },
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  // Worker tags: test-map-0 (fail), test-map-0-er1 (success)
  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-map-0", `First tag: ${tracker.workerTags[0]}, expected test-map-0`);
  assert(tracker.workerTags[1] === "test-map-0-er1", `Second tag: ${tracker.workerTags[1]}, expected test-map-0-er1`);

  // Verifier tags: test-map-0-er1-verifier (verifier runs after successful retry)
  // Note: verifier uses the tag of the successful worker
  assert(tracker.verifierTags.length === 1, `Verifier tags count: ${tracker.verifierTags.length}, expected 1`);
}

async function testMapRetryAndVerifyMultipleRetries(): Promise<void> {
  console.log("\n[4] map + retry + verify: Multiple error retries + verify retry");

  // Worker fails twice on first verify attempt, once on second verify attempt
  // Using exact tag matching for more control
  const failuresPerTag = new Map([
    ["test-map-0$", 2],  // First worker attempt fails twice
    ["test-map-0-vr1$", 1],  // Second worker attempt (after verify fail) fails once
  ]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag, verifyPassOnAttempt: 2 });

  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 3 },
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  // Expect worker tags like:
  // test-map-0 (fail) -> test-map-0-er1 (fail) -> test-map-0-er2 (success) -> verify fails
  // test-map-0-vr1 (fail) -> test-map-0-vr1-er1 (success) -> verify passes

  // Check that error retry tags have -er{n} suffix
  const erTags = tracker.workerTags.filter(t => t.includes("-er"));
  assert(erTags.length >= 1, `Should have at least 1 error retry tag, got ${erTags.length}`);

  // Check that verify retry tags have -vr{n} suffix
  const vrTags = tracker.workerTags.filter(t => t.includes("-vr"));
  assert(vrTags.length >= 1, `Should have at least 1 verify retry tag, got ${vrTags.length}`);
}

// =============================================================================
// TEST: FILTER + RETRY + VERIFY TAG NAMING
// =============================================================================

async function testFilterRetryTagNaming(): Promise<void> {
  console.log("\n[5] filter + retry: Worker error retry gets -er{n} tag suffix");

  const failuresPerTag = new Map([["test-filter-0", 1]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag });

  const schema = z.object({ score: z.number() });
  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.filter({
    items,
    prompt: "Evaluate",
    schema,
    condition: (d) => d.score > 3,
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-filter-0", `First tag: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-filter-0-er1", `Second tag: ${tracker.workerTags[1]}`);
}

async function testFilterVerifyRetryTagNaming(): Promise<void> {
  console.log("\n[6] filter + verify: Verify retry gets -vr{n} tag suffix");

  const { swarm, tracker } = createMockSwarm(2, { verifyPassOnAttempt: 2 });

  const schema = z.object({ score: z.number() });
  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.filter({
    items,
    prompt: "Evaluate",
    schema,
    condition: (d) => d.score > 3,
    verify: { criteria: "Accurate", maxAttempts: 3 },
  });

  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-filter-0", `First worker tag: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-filter-0-vr1", `Second worker tag: ${tracker.workerTags[1]}`);

  assert(tracker.verifierTags.length === 2, `Verifier tags count: ${tracker.verifierTags.length}, expected 2`);
  assert(tracker.verifierTags[0] === "test-filter-0-verifier", `First verifier tag: ${tracker.verifierTags[0]}`);
  assert(tracker.verifierTags[1] === "test-filter-0-vr1-verifier", `Second verifier tag: ${tracker.verifierTags[1]}`);
}

async function testFilterRetryAndVerifyTagNaming(): Promise<void> {
  console.log("\n[7] filter + retry + verify: Combined tag naming");

  const failuresPerTag = new Map([["test-filter-0", 1]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag, verifyPassOnAttempt: 1 });

  const schema = z.object({ score: z.number() });
  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.filter({
    items,
    prompt: "Evaluate",
    schema,
    condition: (d) => d.score > 3,
    verify: { criteria: "Accurate", maxAttempts: 2 },
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  // Worker: test-filter-0 (fail), test-filter-0-er1 (success)
  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-filter-0", `First tag: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-filter-0-er1", `Second tag: ${tracker.workerTags[1]}`);
}

// =============================================================================
// TEST: REDUCE + RETRY + VERIFY TAG NAMING
// =============================================================================

async function testReduceRetryTagNaming(): Promise<void> {
  console.log("\n[8] reduce + retry: Worker error retry gets -er{n} tag suffix");

  const failuresPerTag = new Map([["test-reduce", 1]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag });

  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }];

  await swarm.reduce({
    items,
    prompt: "Synthesize",
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-reduce", `First tag: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-reduce-er1", `Second tag: ${tracker.workerTags[1]}`);
}

async function testReduceVerifyRetryTagNaming(): Promise<void> {
  console.log("\n[9] reduce + verify: Verify retry gets -vr{n} tag suffix");

  const { swarm, tracker } = createMockSwarm(2, { verifyPassOnAttempt: 2 });

  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }];

  await swarm.reduce({
    items,
    prompt: "Synthesize",
    verify: { criteria: "Complete", maxAttempts: 3 },
  });

  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-reduce", `First worker tag: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-reduce-vr1", `Second worker tag: ${tracker.workerTags[1]}`);

  assert(tracker.verifierTags.length === 2, `Verifier tags count: ${tracker.verifierTags.length}, expected 2`);
  assert(tracker.verifierTags[0] === "test-reduce-verifier", `First verifier tag: ${tracker.verifierTags[0]}`);
  assert(tracker.verifierTags[1] === "test-reduce-vr1-verifier", `Second verifier tag: ${tracker.verifierTags[1]}`);
}

async function testReduceRetryAndVerifyTagNaming(): Promise<void> {
  console.log("\n[10] reduce + retry + verify: Combined tag naming");

  const failuresPerTag = new Map([["test-reduce", 1]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag, verifyPassOnAttempt: 1 });

  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }];

  await swarm.reduce({
    items,
    prompt: "Synthesize",
    verify: { criteria: "Complete", maxAttempts: 2 },
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  // Worker: test-reduce (fail), test-reduce-er1 (success)
  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-reduce", `First tag: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-reduce-er1", `Second tag: ${tracker.workerTags[1]}`);
}

// =============================================================================
// TEST: VERIFIER ERROR RETRY TAG NAMING
// =============================================================================

async function testVerifierTagNaming(): Promise<void> {
  console.log("\n[11] map + verify: Verifier gets correct tag based on worker tag");

  const { swarm, tracker } = createMockSwarm(2, { verifyPassOnAttempt: 1 });

  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 2 },
  });

  // Verifier tag should include worker tag: test-map-0-verifier
  assert(tracker.verifierTags.length === 1, `Verifier tags count: ${tracker.verifierTags.length}, expected 1`);
  assert(tracker.verifierTags[0] === "test-map-0-verifier", `Verifier tag: ${tracker.verifierTags[0]}, expected test-map-0-verifier`);
}

// =============================================================================
// TEST: MULTIPLE ITEMS WITH DIFFERENT RETRY PATTERNS
// =============================================================================

async function testMultipleItemsDifferentRetries(): Promise<void> {
  console.log("\n[12] map + retry + verify: Multiple items with different retry patterns");

  // Item 0: worker fails once
  // Item 1: no failures
  // Item 2: worker fails twice
  const failuresPerTag = new Map([
    ["test-map-0", 1],
    ["test-map-2", 2],
  ]);
  const { swarm, tracker } = createMockSwarm(4, { failuresPerTag, verifyPassOnAttempt: 1 });

  const items: FileMap[] = [
    { "a.txt": "a" },
    { "b.txt": "b" },
    { "c.txt": "c" },
  ];

  const results = await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 2 },
    retry: { maxAttempts: 4, backoffMs: 1 },
  });

  // All should succeed
  assert(results.success.length === 3, `Success count: ${results.success.length}, expected 3`);

  // Check tags for each item
  const item0Tags = tracker.workerTags.filter(t => t.match(/test-map-0($|-)/));
  const item1Tags = tracker.workerTags.filter(t => t.match(/test-map-1($|-)/));
  const item2Tags = tracker.workerTags.filter(t => t.match(/test-map-2($|-)/));

  // Item 0: 2 attempts (fail, success)
  assert(item0Tags.length === 2, `Item 0 tags: ${item0Tags.length}, expected 2`);
  assert(item0Tags.some(t => t.includes("-er1")), `Item 0 should have -er1 tag`);

  // Item 1: 1 attempt (success)
  assert(item1Tags.length === 1, `Item 1 tags: ${item1Tags.length}, expected 1`);

  // Item 2: 3 attempts (fail, fail, success)
  assert(item2Tags.length === 3, `Item 2 tags: ${item2Tags.length}, expected 3`);
  assert(item2Tags.some(t => t.includes("-er2")), `Item 2 should have -er2 tag`);
}

// =============================================================================
// TEST: VERIFY RETRIES WITH ERROR RETRIES COMBINED
// =============================================================================

async function testVerifyAndErrorRetriesCombined(): Promise<void> {
  console.log("\n[13] map + retry + verify: Verify fail + error retry on second attempt");

  // First verify attempt: worker succeeds, verify fails
  // Second verify attempt: worker fails once, then succeeds, verify passes
  const failuresPerTag = new Map([["test-map-0-vr1", 1]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag, verifyPassOnAttempt: 2 });

  const items: FileMap[] = [{ "input.txt": "content" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 3 },
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  assert(results.success.length === 1, `Success count: ${results.success.length}, expected 1`);

  // Expected worker tags:
  // 1. test-map-0 (success) -> verify fails
  // 2. test-map-0-vr1 (fail) -> test-map-0-vr1-er1 (success) -> verify passes

  const vrTags = tracker.workerTags.filter(t => t.includes("-vr"));
  const vrErTags = tracker.workerTags.filter(t => t.includes("-vr") && t.includes("-er"));

  assert(vrTags.length >= 1, `Should have verify retry tags, got: ${tracker.workerTags.join(", ")}`);
  assert(vrErTags.length >= 1, `Should have combined -vr and -er tags, got: ${tracker.workerTags.join(", ")}`);

  // Verify the combined tag format: -vr1-er1
  const hasCorrectFormat = tracker.workerTags.some(t => t === "test-map-0-vr1-er1");
  assert(hasCorrectFormat, `Should have test-map-0-vr1-er1 tag, got: ${tracker.workerTags.join(", ")}`);
}

// =============================================================================
// TEST: EXHAUSTED RETRIES
// =============================================================================

async function testExhaustedErrorRetries(): Promise<void> {
  console.log("\n[14] map + retry: All error retries exhausted");

  // Always fail
  const failuresPerTag = new Map([["test-map-0", 999]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag });

  const items: FileMap[] = [{ "input.txt": "content" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  // Should have 3 attempts
  assert(tracker.workerTags.length === 3, `Worker tags count: ${tracker.workerTags.length}, expected 3`);
  assert(tracker.workerTags[0] === "test-map-0", `First tag: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-map-0-er1", `Second tag: ${tracker.workerTags[1]}`);
  assert(tracker.workerTags[2] === "test-map-0-er2", `Third tag: ${tracker.workerTags[2]}`);

  // Result should be error
  assert(results.error.length === 1, `Error count: ${results.error.length}, expected 1`);
}

async function testExhaustedVerifyRetries(): Promise<void> {
  console.log("\n[15] map + verify: All verify retries exhausted");

  // Verify never passes
  const { swarm, tracker } = createMockSwarm(2, { verifyPassOnAttempt: 999 });

  const items: FileMap[] = [{ "input.txt": "content" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 3 },
  });

  // Should have 3 worker attempts + 3 verifier attempts
  assert(tracker.workerTags.length === 3, `Worker tags count: ${tracker.workerTags.length}, expected 3`);
  assert(tracker.workerTags[0] === "test-map-0", `First tag: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-map-0-vr1", `Second tag: ${tracker.workerTags[1]}`);
  assert(tracker.workerTags[2] === "test-map-0-vr2", `Third tag: ${tracker.workerTags[2]}`);

  // Result should be error with verify info
  assert(results.error.length === 1, `Error count: ${results.error.length}, expected 1`);
  assert(results[0].verify?.passed === false, `Verify should have failed`);
  assert(results[0].verify?.attempts === 3, `Verify attempts: ${results[0].verify?.attempts}, expected 3`);
}

// =============================================================================
// TEST: ONLY RETRY (NO VERIFY)
// =============================================================================

async function testRetryOnlyMap(): Promise<void> {
  console.log("\n[16] map + retry only (no verify): Tags correct");

  const failuresPerTag = new Map([["test-map-0", 2]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag });

  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.map({
    items,
    prompt: "Process",
    retry: { maxAttempts: 4, backoffMs: 1 },
  });

  assert(tracker.workerTags.length === 3, `Worker tags count: ${tracker.workerTags.length}, expected 3`);
  assert(tracker.workerTags[0] === "test-map-0", `Tag 1: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-map-0-er1", `Tag 2: ${tracker.workerTags[1]}`);
  assert(tracker.workerTags[2] === "test-map-0-er2", `Tag 3: ${tracker.workerTags[2]}`);

  // No verifier tags
  assert(tracker.verifierTags.length === 0, `Verifier tags: ${tracker.verifierTags.length}, expected 0`);
}

async function testRetryOnlyFilter(): Promise<void> {
  console.log("\n[17] filter + retry only (no verify): Tags correct");

  const failuresPerTag = new Map([["test-filter-0", 1]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag });

  const schema = z.object({ score: z.number() });
  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.filter({
    items,
    prompt: "Evaluate",
    schema,
    condition: (d) => d.score > 3,
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-filter-0", `Tag 1: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-filter-0-er1", `Tag 2: ${tracker.workerTags[1]}`);
}

async function testRetryOnlyReduce(): Promise<void> {
  console.log("\n[18] reduce + retry only (no verify): Tags correct");

  const failuresPerTag = new Map([["test-reduce", 1]]);
  const { swarm, tracker } = createMockSwarm(2, { failuresPerTag });

  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }];

  await swarm.reduce({
    items,
    prompt: "Synthesize",
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-reduce", `Tag 1: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-reduce-er1", `Tag 2: ${tracker.workerTags[1]}`);
}

// =============================================================================
// TEST: ONLY VERIFY (NO RETRY)
// =============================================================================

async function testVerifyOnlyMap(): Promise<void> {
  console.log("\n[19] map + verify only (no retry): Tags correct");

  const { swarm, tracker } = createMockSwarm(2, { verifyPassOnAttempt: 2 });

  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 3 },
  });

  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-map-0", `Tag 1: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-map-0-vr1", `Tag 2: ${tracker.workerTags[1]}`);

  assert(tracker.verifierTags.length === 2, `Verifier tags count: ${tracker.verifierTags.length}, expected 2`);
}

async function testVerifyOnlyFilter(): Promise<void> {
  console.log("\n[20] filter + verify only (no retry): Tags correct");

  const { swarm, tracker } = createMockSwarm(2, { verifyPassOnAttempt: 2 });

  const schema = z.object({ score: z.number() });
  const items: FileMap[] = [{ "input.txt": "content" }];

  await swarm.filter({
    items,
    prompt: "Evaluate",
    schema,
    condition: (d) => d.score > 3,
    verify: { criteria: "Accurate", maxAttempts: 3 },
  });

  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-filter-0", `Tag 1: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-filter-0-vr1", `Tag 2: ${tracker.workerTags[1]}`);
}

async function testVerifyOnlyReduce(): Promise<void> {
  console.log("\n[21] reduce + verify only (no retry): Tags correct");

  const { swarm, tracker } = createMockSwarm(2, { verifyPassOnAttempt: 2 });

  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }];

  await swarm.reduce({
    items,
    prompt: "Synthesize",
    verify: { criteria: "Complete", maxAttempts: 3 },
  });

  assert(tracker.workerTags.length === 2, `Worker tags count: ${tracker.workerTags.length}, expected 2`);
  assert(tracker.workerTags[0] === "test-reduce", `Tag 1: ${tracker.workerTags[0]}`);
  assert(tracker.workerTags[1] === "test-reduce-vr1", `Tag 2: ${tracker.workerTags[1]}`);
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Swarm Retry + Verify Tag Naming Tests");
  console.log("=".repeat(70));

  // Map tests
  await testMapRetryTagNaming();
  await testMapVerifyRetryTagNaming();
  await testMapRetryAndVerifyTagNaming();
  await testMapRetryAndVerifyMultipleRetries();

  // Filter tests
  await testFilterRetryTagNaming();
  await testFilterVerifyRetryTagNaming();
  await testFilterRetryAndVerifyTagNaming();

  // Reduce tests
  await testReduceRetryTagNaming();
  await testReduceVerifyRetryTagNaming();
  await testReduceRetryAndVerifyTagNaming();

  // Verifier tag naming
  await testVerifierTagNaming();

  // Multiple items
  await testMultipleItemsDifferentRetries();

  // Combined scenarios
  await testVerifyAndErrorRetriesCombined();

  // Exhausted retries
  await testExhaustedErrorRetries();
  await testExhaustedVerifyRetries();

  // Retry only (no verify)
  await testRetryOnlyMap();
  await testRetryOnlyFilter();
  await testRetryOnlyReduce();

  // Verify only (no retry)
  await testVerifyOnlyMap();
  await testVerifyOnlyFilter();
  await testVerifyOnlyReduce();

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
