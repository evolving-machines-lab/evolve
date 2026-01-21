#!/usr/bin/env tsx
/**
 * Unit Test: Swarm Concurrency & Orchestration
 *
 * Tests that Swarm correctly orchestrates operations with the Semaphore:
 * - Global concurrency limit is respected across all operations
 * - bestOf: judge runs only after all candidates complete
 * - map → reduce: reduce runs only after map completes
 * - map → filter: filter runs only after map completes
 * - Retry respects semaphore (permit released during backoff)
 *
 * Uses mocked execute() to avoid real sandbox/agent calls.
 *
 * Usage:
 *   npm run test:unit:swarm
 *   npx tsx tests/unit/swarm-concurrency.test.ts
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
}

interface MockTracker {
  calls: ExecuteCall[];
  concurrent: number;
  maxConcurrent: number;
  callOrder: string[];
}

function createMockSwarm(concurrency: number, execDelay: number = 50): { swarm: Swarm; tracker: MockTracker } {
  const tracker: MockTracker = {
    calls: [],
    concurrent: 0,
    maxConcurrent: 0,
    callOrder: [],
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

  // Override the private execute method to track calls
  (swarm as any).execute = async function (
    _context: FileMap,
    _prompt: string,
    opts: { tagPrefix: string; timeout: number; schema?: unknown; systemPrompt?: string; agent?: unknown }
  ) {
    const call: ExecuteCall = {
      tagPrefix: opts.tagPrefix,
      startTime: Date.now(),
    };
    tracker.calls.push(call);
    tracker.callOrder.push(opts.tagPrefix);

    tracker.concurrent++;
    tracker.maxConcurrent = Math.max(tracker.maxConcurrent, tracker.concurrent);

    // Simulate work
    await sleep(execDelay);

    tracker.concurrent--;
    call.endTime = Date.now();

    // Return mock result
    const mockData = opts.schema ? { mock: true } : {};
    return {
      files: { "result.json": JSON.stringify(mockData) },
      data: mockData,
      tag: opts.tagPrefix + "-abc123",
      sandboxId: "mock-sandbox-id",
    };
  };

  return { swarm, tracker };
}

/**
 * Create a mock Swarm that can simulate failures for retry testing.
 * Tracks when permits are held vs released to verify backoff behavior.
 */
function createMockSwarmWithFailures(
  concurrency: number,
  execDelay: number = 50,
  failuresPerItem: Map<string, number> = new Map()
): { swarm: Swarm; tracker: MockTracker & { attemptCounts: Map<string, number>; permitHeldDuringBackoff: boolean } } {
  const tracker: MockTracker & { attemptCounts: Map<string, number>; permitHeldDuringBackoff: boolean } = {
    calls: [],
    concurrent: 0,
    maxConcurrent: 0,
    callOrder: [],
    attemptCounts: new Map(),
    permitHeldDuringBackoff: false,
  };

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

  // Override execute to track attempts and simulate failures
  (swarm as any).execute = async function (
    _context: FileMap,
    _prompt: string,
    opts: { tagPrefix: string; timeout: number; schema?: unknown; systemPrompt?: string; agent?: unknown }
  ) {
    // Extract base key without retry suffix (e.g., "test-map-0-er2" → "test-map-0")
    const itemKey = opts.tagPrefix.replace(/-er\d+$/, "");
    const currentAttempt = (tracker.attemptCounts.get(itemKey) ?? 0) + 1;
    tracker.attemptCounts.set(itemKey, currentAttempt);

    const call: ExecuteCall = {
      tagPrefix: opts.tagPrefix,
      startTime: Date.now(),
    };
    tracker.calls.push(call);
    tracker.callOrder.push(opts.tagPrefix);

    tracker.concurrent++;
    tracker.maxConcurrent = Math.max(tracker.maxConcurrent, tracker.concurrent);

    // Simulate work
    await sleep(execDelay);

    tracker.concurrent--;
    call.endTime = Date.now();

    // Check if this item should fail (use base key without retry suffix)
    const failuresRemaining = failuresPerItem.get(itemKey) ?? 0;
    if (failuresRemaining > 0) {
      failuresPerItem.set(itemKey, failuresRemaining - 1);
      // Return error result (will trigger retry)
      return {
        files: {},
        data: null,
        tag: opts.tagPrefix + "-abc123",
        sandboxId: "mock-sandbox-id",
        error: "Simulated failure",
      };
    }

    // Return success
    const mockData = opts.schema ? { mock: true, score: 5, value: 10 } : {};
    return {
      files: { "result.json": JSON.stringify(mockData) },
      data: mockData,
      tag: opts.tagPrefix + "-abc123",
      sandboxId: "mock-sandbox-id",
    };
  };

  return { swarm, tracker };
}

// =============================================================================
// TESTS
// =============================================================================

async function testMapConcurrency(): Promise<void> {
  console.log("\n[1] map() Respects Global Concurrency");

  const { swarm, tracker } = createMockSwarm(4, 50);

  // map 10 items with concurrency 4
  const items: FileMap[] = Array.from({ length: 10 }, (_, i) => ({ [`file${i}.txt`]: `content ${i}` }));

  await swarm.map({ items, prompt: "Process this" });

  assert(tracker.maxConcurrent === 4, `Max concurrent was ${tracker.maxConcurrent}, expected 4`);
  assert(tracker.calls.length === 10, `Total calls: ${tracker.calls.length}, expected 10`);
}

async function testBestOfConcurrencyAndOrdering(): Promise<void> {
  console.log("\n[2] bestOf() Candidates Before Judge, Respects Concurrency");

  const { swarm, tracker } = createMockSwarm(3, 30);

  const item: FileMap = { "input.txt": "test content" };

  await swarm.bestOf({ item, prompt: "Do the task", config: { n: 5, judgeCriteria: "Pick the best" } });

  // Should have 5 candidates + 1 judge = 6 total calls
  assert(tracker.calls.length === 6, `Total calls: ${tracker.calls.length}, expected 6`);

  // Max concurrent should be 3 (our limit), not 5
  assert(tracker.maxConcurrent === 3, `Max concurrent was ${tracker.maxConcurrent}, expected 3`);

  // Judge should be LAST in call order
  const judgeCall = tracker.callOrder.find((tag) => tag.includes("judge"));
  const judgeIndex = tracker.callOrder.indexOf(judgeCall!);
  assert(judgeIndex === 5, `Judge was call #${judgeIndex + 1}, expected #6 (last)`);

  // All candidates should complete before judge starts
  const candidateCalls = tracker.calls.filter((c) => c.tagPrefix.includes("cand"));
  const judgeCallObj = tracker.calls.find((c) => c.tagPrefix.includes("judge"));

  const allCandidatesBeforeJudge = candidateCalls.every(
    (c) => c.endTime! <= judgeCallObj!.startTime
  );
  assert(allCandidatesBeforeJudge, "All candidates completed before judge started");
}

async function testMapWithBestOf(): Promise<void> {
  console.log("\n[3] map() with bestOf: Complex Orchestration");

  const { swarm, tracker } = createMockSwarm(4, 20);

  // map 3 items, each with bestOf(3) = 3 * (3 candidates + 1 judge) = 12 total
  const items: FileMap[] = [
    { "a.txt": "a" },
    { "b.txt": "b" },
    { "c.txt": "c" },
  ];

  await swarm.map({
    items,
    prompt: "Process",
    bestOf: { n: 3, judgeCriteria: "Pick best" },
  });

  // 3 items × (3 candidates + 1 judge) = 12 calls
  assert(tracker.calls.length === 12, `Total calls: ${tracker.calls.length}, expected 12`);

  // Max concurrent should never exceed 4
  assert(tracker.maxConcurrent <= 4, `Max concurrent was ${tracker.maxConcurrent}, expected <= 4`);

  // For each map item, its judge should come after its candidates
  for (let i = 0; i < 3; i++) {
    const candidateTags = tracker.callOrder.filter((t) => t.includes(`map-${i}-bestof-cand`));
    const judgeTag = tracker.callOrder.find((t) => t.includes(`map-${i}-bestof-judge`));

    const candidateIndices = candidateTags.map((t) => tracker.callOrder.indexOf(t));
    const judgeIndex = tracker.callOrder.indexOf(judgeTag!);

    const judgeAfterCandidates = candidateIndices.every((ci) => ci < judgeIndex);
    assert(judgeAfterCandidates, `map-${i}: judge after all its candidates`);
  }
}

async function testMapThenReduce(): Promise<void> {
  console.log("\n[4] map() → reduce(): Sequential Orchestration");

  const { swarm, tracker } = createMockSwarm(4, 30);

  const items: FileMap[] = [
    { "1.txt": "one" },
    { "2.txt": "two" },
    { "3.txt": "three" },
    { "4.txt": "four" },
    { "5.txt": "five" },
  ];

  // Run map, then reduce
  const mapped = await swarm.map({ items, prompt: "Analyze" });
  await swarm.reduce({ items: mapped.success, prompt: "Synthesize" });

  // 5 map + 1 reduce = 6 total
  assert(tracker.calls.length === 6, `Total calls: ${tracker.calls.length}, expected 6`);

  // Reduce should be last
  const reduceCall = tracker.calls.find((c) => c.tagPrefix.includes("reduce"));
  const mapCalls = tracker.calls.filter((c) => c.tagPrefix.includes("map"));

  const reduceAfterAllMaps = mapCalls.every((m) => m.endTime! <= reduceCall!.startTime);
  assert(reduceAfterAllMaps, "Reduce started only after all map items completed");
}

async function testMapThenFilter(): Promise<void> {
  console.log("\n[5] map() → filter(): Sequential Orchestration");

  const { swarm, tracker } = createMockSwarm(3, 25);

  const items: FileMap[] = [
    { "a.txt": "a" },
    { "b.txt": "b" },
    { "c.txt": "c" },
    { "d.txt": "d" },
  ];

  const schema = z.object({ score: z.number() });

  // Run map, then filter
  const mapped = await swarm.map({ items, prompt: "Score this", schema });
  await swarm.filter({ items: mapped.success, prompt: "Evaluate", schema, condition: () => true });

  // 4 map + 4 filter = 8 total
  assert(tracker.calls.length === 8, `Total calls: ${tracker.calls.length}, expected 8`);

  // All filter calls should start after all map calls complete
  const mapCalls = tracker.calls.filter((c) => c.tagPrefix.includes("map"));
  const filterCalls = tracker.calls.filter((c) => c.tagPrefix.includes("filter"));

  const mapEndTimes = mapCalls.map((c) => c.endTime!);
  const filterStartTimes = filterCalls.map((c) => c.startTime);

  const lastMapEnd = Math.max(...mapEndTimes);
  const firstFilterStart = Math.min(...filterStartTimes);

  assert(firstFilterStart >= lastMapEnd, "Filter started only after all map items completed");
}

async function testMapFilterReduce(): Promise<void> {
  console.log("\n[6] map() → filter() → reduce(): Full Pipeline");

  const { swarm, tracker } = createMockSwarm(2, 20);

  const items: FileMap[] = [
    { "1.txt": "1" },
    { "2.txt": "2" },
    { "3.txt": "3" },
  ];

  const schema = z.object({ value: z.number() });

  // Full pipeline
  const mapped = await swarm.map({ items, prompt: "Extract", schema });
  const filtered = await swarm.filter({ items: mapped.success, prompt: "Check", schema, condition: () => true });
  await swarm.reduce({ items: filtered.success, prompt: "Combine" });

  // 3 map + 3 filter + 1 reduce = 7 total
  assert(tracker.calls.length === 7, `Total calls: ${tracker.calls.length}, expected 7`);

  // Verify ordering: all map → all filter → reduce
  const mapCalls = tracker.calls.filter((c) => c.tagPrefix.includes("map"));
  const filterCalls = tracker.calls.filter((c) => c.tagPrefix.includes("filter"));
  const reduceCall = tracker.calls.find((c) => c.tagPrefix.includes("reduce"));

  const lastMapEnd = Math.max(...mapCalls.map((c) => c.endTime!));
  const firstFilterStart = Math.min(...filterCalls.map((c) => c.startTime));
  const lastFilterEnd = Math.max(...filterCalls.map((c) => c.endTime!));

  assert(firstFilterStart >= lastMapEnd, "Filter phase after map phase");
  assert(reduceCall!.startTime >= lastFilterEnd, "Reduce after filter phase");

  // Max concurrent should never exceed 2
  assert(tracker.maxConcurrent <= 2, `Max concurrent was ${tracker.maxConcurrent}, expected <= 2`);
}

async function testMapBestOfThenFilter(): Promise<void> {
  console.log("\n[7] map(bestOf) → filter(): Complex Pipeline");

  const { swarm, tracker } = createMockSwarm(3, 20);

  const items: FileMap[] = [
    { "a.txt": "a" },
    { "b.txt": "b" },
    { "c.txt": "c" },
    { "d.txt": "d" },
  ];

  const schema = z.object({ score: z.number() });

  // map with bestOf: 4 items × (3 candidates + 1 judge) = 16 calls
  const mapped = await swarm.map({
    items,
    prompt: "Analyze",
    bestOf: { n: 3, judgeCriteria: "Best analysis" },
    schema,
  });

  // Then filter: 4 more calls
  await swarm.filter({ items: mapped.success, prompt: "Evaluate", schema, condition: () => true });

  // 16 map+bestOf + 4 filter = 20 total
  assert(tracker.calls.length === 20, `Total calls: ${tracker.calls.length}, expected 20`);

  // Concurrency never exceeded
  assert(tracker.maxConcurrent <= 3, `Max concurrent was ${tracker.maxConcurrent}, expected <= 3`);

  // All filter calls should start after all map+bestOf calls complete
  const mapBestOfCalls = tracker.calls.filter((c) => c.tagPrefix.includes("map"));
  const filterCalls = tracker.calls.filter((c) => c.tagPrefix.includes("filter"));

  const lastMapBestOfEnd = Math.max(...mapBestOfCalls.map((c) => c.endTime!));
  const firstFilterStart = Math.min(...filterCalls.map((c) => c.startTime));

  assert(firstFilterStart >= lastMapBestOfEnd, "Filter started only after all map+bestOf completed");
}

async function testMapBestOfFilterReduce(): Promise<void> {
  console.log("\n[8] map(bestOf) → filter() → reduce(): Full Complex Pipeline");

  const { swarm, tracker } = createMockSwarm(4, 15);

  const items: FileMap[] = [
    { "1.txt": "1" },
    { "2.txt": "2" },
    { "3.txt": "3" },
  ];

  const schema = z.object({ value: z.number() });

  // map with bestOf: 3 items × (2 candidates + 1 judge) = 9 calls
  const mapped = await swarm.map({
    items,
    prompt: "Extract",
    bestOf: { n: 2, judgeCriteria: "Most accurate" },
    schema,
  });

  // filter: 3 calls
  const filtered = await swarm.filter({ items: mapped.success, prompt: "Check", schema, condition: () => true });

  // reduce: 1 call
  await swarm.reduce({ items: filtered.success, prompt: "Combine" });

  // 9 + 3 + 1 = 13 total
  assert(tracker.calls.length === 13, `Total calls: ${tracker.calls.length}, expected 13`);

  // Concurrency never exceeded
  assert(tracker.maxConcurrent <= 4, `Max concurrent was ${tracker.maxConcurrent}, expected <= 4`);

  // Verify phase ordering
  const mapBestOfCalls = tracker.calls.filter((c) => c.tagPrefix.includes("map"));
  const filterCalls = tracker.calls.filter((c) => c.tagPrefix.includes("filter"));
  const reduceCall = tracker.calls.find((c) => c.tagPrefix.includes("reduce"));

  const lastMapBestOfEnd = Math.max(...mapBestOfCalls.map((c) => c.endTime!));
  const firstFilterStart = Math.min(...filterCalls.map((c) => c.startTime));
  const lastFilterEnd = Math.max(...filterCalls.map((c) => c.endTime!));

  assert(firstFilterStart >= lastMapBestOfEnd, "Filter phase after map+bestOf phase");
  assert(reduceCall!.startTime >= lastFilterEnd, "Reduce after filter phase");

  // Verify bestOf ordering within map phase (judge after candidates for each item)
  for (let i = 0; i < 3; i++) {
    const candidateTags = tracker.callOrder.filter((t) => t.includes(`map-${i}-bestof-cand`));
    const judgeTag = tracker.callOrder.find((t) => t.includes(`map-${i}-bestof-judge`));

    if (judgeTag) {
      const candidateIndices = candidateTags.map((t) => tracker.callOrder.indexOf(t));
      const judgeIndex = tracker.callOrder.indexOf(judgeTag);
      const judgeAfterCandidates = candidateIndices.every((ci) => ci < judgeIndex);
      assert(judgeAfterCandidates, `map-${i}: judge after all its candidates`);
    }
  }
}

async function testHighLoadBestOf(): Promise<void> {
  console.log("\n[9] High Load: map(10) with bestOf(5), concurrency=4");

  const { swarm, tracker } = createMockSwarm(4, 15);

  // 10 items × (5 candidates + 1 judge) = 60 total calls
  const items: FileMap[] = Array.from({ length: 10 }, (_, i) => ({ [`${i}.txt`]: `${i}` }));

  await swarm.map({
    items,
    prompt: "Process",
    bestOf: { n: 5, judgeCriteria: "Best quality" },
  });

  // 10 × 6 = 60 calls
  assert(tracker.calls.length === 60, `Total calls: ${tracker.calls.length}, expected 60`);

  // Never exceed concurrency limit
  assert(tracker.maxConcurrent === 4, `Max concurrent was ${tracker.maxConcurrent}, expected 4`);

  // Verify each item's judge came after its candidates
  for (let i = 0; i < 10; i++) {
    const judgeTag = `test-map-${i}-bestof-judge`;
    const judgeIndex = tracker.callOrder.findIndex((t) => t === judgeTag);

    if (judgeIndex === -1) continue; // Skip if not found (different tag format)

    const candidateTags = Array.from({ length: 5 }, (_, c) => `test-map-${i}-bestof-cand-${c}`);
    const candidateIndices = candidateTags.map((t) => tracker.callOrder.findIndex((o) => o === t));

    const allCandidatesBeforeJudge = candidateIndices.every((ci) => ci < judgeIndex);
    if (!allCandidatesBeforeJudge) {
      assert(false, `map-${i}: judge should come after all its candidates`);
      return;
    }
  }
  assert(true, "All judges ran after their respective candidates");
}

async function testConcurrencyNeverExceeded(): Promise<void> {
  console.log("\n[10] Stress Test: Concurrency Never Exceeded");

  const { swarm, tracker } = createMockSwarm(5, 10);

  // Run multiple operations that would try to exceed concurrency
  const items: FileMap[] = Array.from({ length: 20 }, (_, i) => ({ [`${i}.txt`]: `${i}` }));

  // These all share the same semaphore
  const promises = [
    swarm.map({ items: items.slice(0, 10), prompt: "Map batch 1" }),
    swarm.map({ items: items.slice(10, 20), prompt: "Map batch 2" }),
  ];

  await Promise.all(promises);

  assert(tracker.maxConcurrent <= 5, `Max concurrent was ${tracker.maxConcurrent}, expected <= 5`);
  assert(tracker.calls.length === 20, `Total calls: ${tracker.calls.length}, expected 20`);
}

// =============================================================================
// RETRY TESTS
// =============================================================================

async function testMapRetryBasic(): Promise<void> {
  console.log("\n[11] map() with Retry: Basic Retry on Error");

  // Item 0 fails twice then succeeds, item 1 succeeds first try
  const failures = new Map([["test-map-0", 2]]);
  const { swarm, tracker } = createMockSwarmWithFailures(2, 20, failures);

  const items: FileMap[] = [
    { "a.txt": "a" },
    { "b.txt": "b" },
  ];

  const results = await swarm.map({
    items,
    prompt: "Process",
    retry: { maxAttempts: 3, backoffMs: 10 },
  });

  // Item 0: 3 attempts (2 failures + 1 success), Item 1: 1 attempt
  assert(tracker.calls.length === 4, `Total calls: ${tracker.calls.length}, expected 4 (3 retries + 1 direct)`);

  // Both should succeed in the end
  assert(results.success.length === 2, `Success count: ${results.success.length}, expected 2`);

  // Concurrency still respected
  assert(tracker.maxConcurrent <= 2, `Max concurrent was ${tracker.maxConcurrent}, expected <= 2`);
}

async function testMapRetryRespectsConcurrency(): Promise<void> {
  console.log("\n[12] map() with Retry: Semaphore Released During Backoff");

  // All items fail once - this means during backoff, other items should run
  const failures = new Map([
    ["test-map-0", 1],
    ["test-map-1", 1],
    ["test-map-2", 1],
    ["test-map-3", 1],
  ]);
  const { swarm, tracker } = createMockSwarmWithFailures(2, 15, failures);

  const items: FileMap[] = Array.from({ length: 4 }, (_, i) => ({ [`${i}.txt`]: `${i}` }));

  await swarm.map({
    items,
    prompt: "Process",
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // 4 items × 2 attempts = 8 calls
  assert(tracker.calls.length === 8, `Total calls: ${tracker.calls.length}, expected 8`);

  // Concurrency should NEVER exceed 2 (even during retries)
  assert(tracker.maxConcurrent <= 2, `Max concurrent was ${tracker.maxConcurrent}, expected <= 2`);
}

async function testMapRetryExhaustsAttempts(): Promise<void> {
  console.log("\n[13] map() with Retry: Exhausts All Attempts");

  // Item fails more times than maxAttempts allows
  const failures = new Map([["test-map-0", 5]]); // Fails 5 times, but only 3 attempts allowed
  const { swarm, tracker } = createMockSwarmWithFailures(2, 10, failures);

  const items: FileMap[] = [{ "a.txt": "a" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    retry: { maxAttempts: 3, backoffMs: 5 },
  });

  // Should have made exactly 3 attempts
  assert(tracker.calls.length === 3, `Total calls: ${tracker.calls.length}, expected 3`);

  // Should end in error (exhausted retries)
  assert(results.error.length === 1, `Error count: ${results.error.length}, expected 1`);
}

async function testFilterRetry(): Promise<void> {
  console.log("\n[14] filter() with Retry: Retries on Error");

  const failures = new Map([["test-filter-1", 1]]); // Second item fails once
  const { swarm, tracker } = createMockSwarmWithFailures(2, 15, failures);

  const schema = z.object({ score: z.number() });
  const items: FileMap[] = [
    { "a.txt": "a" },
    { "b.txt": "b" },
    { "c.txt": "c" },
  ];

  const results = await swarm.filter({
    items,
    prompt: "Evaluate",
    schema,
    condition: (d) => d.score > 3,
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // Item 0: 1, Item 1: 2 (retry), Item 2: 1 = 4 total
  assert(tracker.calls.length === 4, `Total calls: ${tracker.calls.length}, expected 4`);

  // All should succeed (filter passes all due to mock data score=5)
  assert(results.success.length === 3, `Success count: ${results.success.length}, expected 3`);

  // Concurrency respected
  assert(tracker.maxConcurrent <= 2, `Max concurrent was ${tracker.maxConcurrent}, expected <= 2`);
}

async function testReduceRetry(): Promise<void> {
  console.log("\n[15] reduce() with Retry: Retries Entire Reduce");

  const failures = new Map([["test-reduce", 1]]); // Reduce fails once
  const { swarm, tracker } = createMockSwarmWithFailures(2, 15, failures);

  const items: FileMap[] = [
    { "1.txt": "one" },
    { "2.txt": "two" },
  ];

  const result = await swarm.reduce({
    items,
    prompt: "Synthesize",
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // Reduce called twice (1 fail + 1 success)
  const reduceCalls = tracker.calls.filter((c) => c.tagPrefix.includes("reduce"));
  assert(reduceCalls.length === 2, `Reduce calls: ${reduceCalls.length}, expected 2`);

  // Should succeed after retry
  assert(result.status === "success", `Status: ${result.status}, expected success`);
}

async function testBestOfRetry(): Promise<void> {
  console.log("\n[16] bestOf() with Retry: Retries Failed Candidates");

  // Candidate 1 fails once
  const failures = new Map([["test-bestof-cand-1", 1]]);
  const { swarm, tracker } = createMockSwarmWithFailures(3, 15, failures);

  const item: FileMap = { "input.txt": "test" };

  const result = await swarm.bestOf({
    item,
    prompt: "Generate",
    config: { n: 3, judgeCriteria: "Best quality" },
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // 3 candidates (one retried once = 4) + 1 judge = 5 total
  assert(tracker.calls.length === 5, `Total calls: ${tracker.calls.length}, expected 5`);

  // Winner should be selected
  assert(result.winner !== undefined, "Should have a winner");

  // Concurrency respected
  assert(tracker.maxConcurrent <= 3, `Max concurrent was ${tracker.maxConcurrent}, expected <= 3`);
}

async function testMapWithBestOfRetry(): Promise<void> {
  console.log("\n[17] map(bestOf) with Retry: Per-Candidate Retries");

  // Each candidate that fails gets retried individually (per-candidate retry, not map-level)
  const failures = new Map([
    ["test-map-0-bestof-cand-0", 1], // First candidate of item 0 fails once → retried
    ["test-map-1-bestof-cand-1", 1], // Second candidate of item 1 fails once → retried
  ]);
  const { swarm, tracker } = createMockSwarmWithFailures(3, 10, failures);

  const items: FileMap[] = [
    { "a.txt": "a" },
    { "b.txt": "b" },
  ];

  const results = await swarm.map({
    items,
    prompt: "Process",
    bestOf: { n: 2, judgeCriteria: "Best" },
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // Item 0: cand-0 (2 calls: fail+retry), cand-1 (1), judge (1) = 4
  // Item 1: cand-0 (1), cand-1 (2 calls: fail+retry), judge (1) = 4
  // Total = 8
  assert(tracker.calls.length === 8, `Total calls: ${tracker.calls.length}, expected 8`);

  // All should succeed (judge picks from available successful candidates)
  assert(results.success.length === 2, `Success count: ${results.success.length}, expected 2`);

  // Concurrency never exceeded
  assert(tracker.maxConcurrent <= 3, `Max concurrent was ${tracker.maxConcurrent}, expected <= 3`);
}

async function testRetryWithHighConcurrency(): Promise<void> {
  console.log("\n[18] Retry Stress Test: High Load with Failures");

  // Half the items fail once
  const failures = new Map<string, number>();
  for (let i = 0; i < 10; i += 2) {
    failures.set(`test-map-${i}`, 1);
  }

  const { swarm, tracker } = createMockSwarmWithFailures(4, 10, failures);

  const items: FileMap[] = Array.from({ length: 10 }, (_, i) => ({ [`${i}.txt`]: `${i}` }));

  const results = await swarm.map({
    items,
    prompt: "Process",
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // 5 items succeed first try, 5 items need retry = 15 total calls
  assert(tracker.calls.length === 15, `Total calls: ${tracker.calls.length}, expected 15`);

  // All should succeed
  assert(results.success.length === 10, `Success count: ${results.success.length}, expected 10`);

  // Concurrency NEVER exceeded (critical for retry correctness)
  assert(tracker.maxConcurrent <= 4, `Max concurrent was ${tracker.maxConcurrent}, expected <= 4`);
}

async function testRetryPipelineConcurrency(): Promise<void> {
  console.log("\n[19] map(retry) → filter(retry) → reduce(retry): Full Pipeline with Retries");

  const failures = new Map([
    ["test-map-0", 1],
    ["test-filter-1", 1],
    ["test-reduce", 1],
  ]);
  const { swarm, tracker } = createMockSwarmWithFailures(2, 10, failures);

  const schema = z.object({ value: z.number() });
  const items: FileMap[] = [
    { "1.txt": "1" },
    { "2.txt": "2" },
    { "3.txt": "3" },
  ];

  // Map with retry
  const mapped = await swarm.map({
    items,
    prompt: "Extract",
    schema,
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // Filter with retry
  const filtered = await swarm.filter({
    items: mapped.success,
    prompt: "Check",
    schema,
    condition: () => true,
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // Reduce with retry
  const result = await swarm.reduce({
    items: filtered.success,
    prompt: "Combine",
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // Map: 3 + 1 retry = 4
  // Filter: 3 + 1 retry = 4
  // Reduce: 1 + 1 retry = 2
  // Total: 10
  assert(tracker.calls.length === 10, `Total calls: ${tracker.calls.length}, expected 10`);

  // Final result should succeed
  assert(result.status === "success", `Final status: ${result.status}, expected success`);

  // Concurrency never exceeded throughout entire pipeline
  assert(tracker.maxConcurrent <= 2, `Max concurrent was ${tracker.maxConcurrent}, expected <= 2`);
}

async function testCustomRetryOn(): Promise<void> {
  console.log("\n[20] Custom retryOn: Retry Based on Data Content");

  // Item 0 returns data with needsRetry=true first time
  let item0Attempts = 0;
  const { swarm, tracker } = createMockSwarmWithFailures(2, 10, new Map());

  // Override execute to return custom data (still track calls)
  const originalExecute = (swarm as any).execute;
  (swarm as any).execute = async function (...args: any[]) {
    const opts = args[2];
    if (opts.tagPrefix === "test-map-0") {
      item0Attempts++;
      if (item0Attempts === 1) {
        // Track this call manually
        tracker.calls.push({ tagPrefix: opts.tagPrefix, startTime: Date.now(), endTime: Date.now() });
        tracker.callOrder.push(opts.tagPrefix);
        // First attempt: success status but data says needs retry
        return {
          files: { "result.json": JSON.stringify({ needsRetry: true, value: 0 }) },
          data: { needsRetry: true, value: 0 },
          tag: opts.tagPrefix + "-abc",
          sandboxId: "mock",
        };
      }
    }
    return originalExecute.apply(this, args);
  };

  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    retry: {
      maxAttempts: 3,
      backoffMs: 5,
      // Custom condition: retry if data.needsRetry is true
      retryOn: (r) => r.status === "error" || (r.data as any)?.needsRetry === true,
    },
  });

  // Item 0: 2 attempts (first had needsRetry=true), Item 1: 1 attempt
  assert(tracker.calls.length === 3, `Total calls: ${tracker.calls.length}, expected 3`);
  assert(results.success.length === 2, `Success count: ${results.success.length}, expected 2`);
}

async function testJudgeRetryExplicit(): Promise<void> {
  console.log("\n[21] bestOf() Judge Retry: Judge Fails Then Succeeds");

  // Judge fails once
  const failures = new Map([["test-bestof-judge", 1]]);
  const { swarm, tracker } = createMockSwarmWithFailures(3, 10, failures);

  const item: FileMap = { "input.txt": "test" };

  const result = await swarm.bestOf({
    item,
    prompt: "Generate",
    config: { n: 2, judgeCriteria: "Best" },
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // 2 candidates + 2 judge attempts (1 fail + 1 success) = 4
  assert(tracker.calls.length === 4, `Total calls: ${tracker.calls.length}, expected 4`);
  assert(result.winner !== undefined, "Should have a winner");
}

async function testJudgeIgnoresCustomRetryOn(): Promise<void> {
  console.log("\n[22] bestOf() Custom retryOn: Candidates Use It, Judge Ignores It");

  // Candidate 0 fails once, judge fails once
  // With retryOn: () => false, candidate should NOT retry
  // But judge should retry (uses default, ignores custom retryOn)
  const failures = new Map([
    ["test-bestof-cand-0", 1], // Candidate fails - should NOT retry (retryOn: false)
    ["test-bestof-judge", 1], // Judge fails - SHOULD retry (ignores retryOn)
  ]);
  const { swarm, tracker } = createMockSwarmWithFailures(3, 10, failures);

  const item: FileMap = { "input.txt": "test" };

  const result = await swarm.bestOf({
    item,
    prompt: "Generate",
    config: { n: 2, judgeCriteria: "Best" },
    retry: {
      maxAttempts: 2,
      backoffMs: 5,
      retryOn: () => false, // Never retry - but only applies to candidates
    },
  });

  // Candidate 0: 1 call (fails, no retry due to retryOn: false)
  // Candidate 1: 1 call (succeeds)
  // Judge: 2 calls (fails, retries because it ignores retryOn)
  // Total: 4
  assert(tracker.calls.length === 4, `Total calls: ${tracker.calls.length}, expected 4`);
  assert(result.winner !== undefined, "Should have a winner after judge retry");

  // Verify candidate 0 did NOT retry (only 1 attempt)
  const cand0Calls = tracker.calls.filter((c) => c.tagPrefix.includes("cand-0"));
  assert(cand0Calls.length === 1, `Candidate 0 calls: ${cand0Calls.length}, expected 1 (no retry)`);
}

async function testMapBestOfJudgeRetry(): Promise<void> {
  console.log("\n[23] map(bestOf) Judge Retry: Judge Fails Then Succeeds");

  // Judge for item 0 fails once
  const failures = new Map([["test-map-0-bestof-judge", 1]]);
  const { swarm, tracker } = createMockSwarmWithFailures(3, 10, failures);

  const items: FileMap[] = [{ "a.txt": "a" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    bestOf: { n: 2, judgeCriteria: "Best" },
    retry: { maxAttempts: 2, backoffMs: 5 },
  });

  // 2 candidates + 2 judge attempts = 4
  assert(tracker.calls.length === 4, `Total calls: ${tracker.calls.length}, expected 4`);
  assert(results.success.length === 1, `Success count: ${results.success.length}, expected 1`);
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Swarm Concurrency & Orchestration Tests");
  console.log("=".repeat(70));

  // Original concurrency tests
  await testMapConcurrency();
  await testBestOfConcurrencyAndOrdering();
  await testMapWithBestOf();
  await testMapThenReduce();
  await testMapThenFilter();
  await testMapFilterReduce();
  await testMapBestOfThenFilter();
  await testMapBestOfFilterReduce();
  await testHighLoadBestOf();
  await testConcurrencyNeverExceeded();

  // Retry tests
  await testMapRetryBasic();
  await testMapRetryRespectsConcurrency();
  await testMapRetryExhaustsAttempts();
  await testFilterRetry();
  await testReduceRetry();
  await testBestOfRetry();
  await testMapWithBestOfRetry();
  await testRetryWithHighConcurrency();
  await testRetryPipelineConcurrency();
  await testCustomRetryOn();
  await testJudgeRetryExplicit();
  await testJudgeIgnoresCustomRetryOn();
  await testMapBestOfJudgeRetry();

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
