#!/usr/bin/env tsx
/**
 * Unit Test: Observability Metadata Propagation
 *
 * Tests all observability changes:
 * - operationId: unique per map/filter/reduce/bestOf call
 * - BaseMeta fields: errorRetry, verifyRetry, candidateIndex, pipeline tracking
 * - PipelineContext: pipelineRunId, stepIndex, stepName propagation
 * - Observability objects passed to execute()
 * - pipelineContextToMeta() and pipelineContextToObservability() helpers
 * - Pipeline integration: pipelineRunId in results
 *
 * Uses mocked execute() to avoid real sandbox/agent calls.
 *
 * Usage:
 *   npx tsx tests/unit/observability-metadata.test.ts
 */

import {
  Swarm,
  Pipeline,
  type SwarmConfig,
  type FileMap,
  type SwarmResult,
  type ReduceResult,
  type BaseMeta,
  type IndexedMeta,
  type ReduceMeta,
  type JudgeMeta,
  type VerifyMeta,
  type PipelineContext,
} from "../../dist/index.js";
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

function assertDefined<T>(value: T | undefined | null, message: string): asserts value is T {
  if (value !== undefined && value !== null) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message} (was ${value})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// MOCK INFRASTRUCTURE
// =============================================================================

interface ObservabilityCapture {
  operationId?: string;
  operation?: string;
  itemIndex?: number;
  role?: string;
  errorRetry?: number;
  verifyRetry?: number;
  candidateIndex?: number;
  pipelineRunId?: string;
  pipelineStepIndex?: number;
  swarmName?: string;
  operationName?: string;
}

interface ExecuteCall {
  tagPrefix: string;
  observability?: ObservabilityCapture;
  systemPrompt?: string;
}

interface MockTracker {
  calls: ExecuteCall[];
  observabilities: ObservabilityCapture[];
}

interface MockOptions {
  /** Map of tag pattern to number of failures before success */
  failuresPerTag?: Map<string, number>;
  /** Verify passes on which attempt per item */
  verifyPassOnAttempt?: number;
}

function createMockSwarm(
  options: MockOptions = {}
): { swarm: Swarm; tracker: MockTracker } {
  const {
    failuresPerTag = new Map(),
    verifyPassOnAttempt = 1,
  } = options;

  const tracker: MockTracker = {
    calls: [],
    observabilities: [],
  };

  const failureCounters = new Map<string, number>();
  const verifyRetrys = new Map<string, number>();

  const mockSandbox = {
    providerType: "mock",
    name: "MockProvider",
    create: async () => ({
      sandboxId: "mock-sandbox-id",
      commands: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      files: {
        read: async () => new Uint8Array(),
        write: async () => {},
        writeBatch: async () => {},
        makeDir: async () => {},
      },
      getHost: () => "localhost",
      kill: async () => {},
      pause: async () => {},
    }),
    connect: async () => ({
      sandboxId: "mock-sandbox-id",
      commands: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      files: {
        read: async () => new Uint8Array(),
        write: async () => {},
        writeBatch: async () => {},
        makeDir: async () => {},
      },
      getHost: () => "localhost",
      kill: async () => {},
      pause: async () => {},
    }),
  };

  const config: SwarmConfig = {
    agent: { type: "claude", apiKey: "mock-key" },
    sandbox: mockSandbox as any,
    concurrency: 4,
    tag: "test",
  };

  const swarm = new Swarm(config);

  // Override execute to capture observability
  (swarm as any).execute = async function (
    _context: FileMap,
    _prompt: string,
    opts: {
      tagPrefix: string;
      timeoutMs: number;
      schema?: unknown;
      systemPrompt?: string;
      observability?: ObservabilityCapture;
    }
  ) {
    const call: ExecuteCall = {
      tagPrefix: opts.tagPrefix,
      observability: opts.observability,
      systemPrompt: opts.systemPrompt,
    };
    tracker.calls.push(call);

    if (opts.observability) {
      tracker.observabilities.push(opts.observability);
    }

    await sleep(5);

    const isVerify = opts.tagPrefix.includes("-verifier");

    if (isVerify) {
      // Extract item key for verify attempt tracking
      const itemMatch = opts.tagPrefix.match(/test-(map|filter)-(\d+)/);
      const reduceMatch = opts.tagPrefix.match(/test-(reduce)/);
      const itemKey = itemMatch ? `${itemMatch[1]}-${itemMatch[2]}` : (reduceMatch ? "reduce" : opts.tagPrefix);

      const currentAttempt = (verifyRetrys.get(itemKey) ?? 0) + 1;
      verifyRetrys.set(itemKey, currentAttempt);

      const shouldPass = currentAttempt >= verifyPassOnAttempt;

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
        sandboxId: "mock-sandbox-id",
      };
    }

    // Worker execution - check for configured failures
    let shouldFail = false;
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

    if (shouldFail) {
      return {
        files: {},
        data: null,
        tag: opts.tagPrefix + "-abc",
        sandboxId: "mock-sandbox-id",
        error: "Simulated failure",
      };
    }

    const mockData = opts.schema ? { score: 5, value: 10 } : {};
    return {
      files: { "result.json": JSON.stringify(mockData), "output.txt": "content" },
      data: mockData,
      tag: opts.tagPrefix + "-abc",
      sandboxId: "mock-sandbox-id",
    };
  };

  return { swarm, tracker };
}

// =============================================================================
// TEST: OPERATION ID GENERATION
// =============================================================================

async function testOperationIdUnique(): Promise<void> {
  console.log("\n[1] operationId: Each operation call gets unique ID");

  const { swarm, tracker } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }];

  // Run map twice
  await swarm.map({ items, prompt: "Process 1" });
  const firstOpIds = tracker.observabilities.map(o => o.operationId);

  await swarm.map({ items, prompt: "Process 2" });
  const allOpIds = tracker.observabilities.map(o => o.operationId);
  const secondOpIds = allOpIds.slice(firstOpIds.length);

  // First operation items share same operationId
  assert(
    firstOpIds[0] === firstOpIds[1],
    `Items in same operation share operationId: ${firstOpIds[0]} === ${firstOpIds[1]}`
  );

  // Different operations have different operationIds
  assert(
    firstOpIds[0] !== secondOpIds[0],
    `Different operations have different operationIds: ${firstOpIds[0]} !== ${secondOpIds[0]}`
  );

  // operationId is 16 hex chars (8 bytes)
  assert(
    /^[0-9a-f]{16}$/.test(firstOpIds[0]!),
    `operationId is 16 hex chars: ${firstOpIds[0]}`
  );
}

async function testOperationIdPerAbstraction(): Promise<void> {
  console.log("\n[2] operationId: Each abstraction (map/filter/reduce) gets unique ID");

  const { swarm, tracker } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }];
  const schema = z.object({ score: z.number() });

  await swarm.map({ items, prompt: "Map" });
  const mapOpId = tracker.observabilities[0]?.operationId;

  await swarm.filter({ items, prompt: "Filter", schema, condition: () => true });
  const filterOpId = tracker.observabilities[1]?.operationId;

  await swarm.reduce({ items, prompt: "Reduce" });
  const reduceOpId = tracker.observabilities[2]?.operationId;

  assert(mapOpId !== filterOpId, `map and filter have different operationIds`);
  assert(filterOpId !== reduceOpId, `filter and reduce have different operationIds`);
  assert(mapOpId !== reduceOpId, `map and reduce have different operationIds`);
}

// =============================================================================
// TEST: OBSERVABILITY FIELDS IN EXECUTE
// =============================================================================

async function testMapObservabilityFields(): Promise<void> {
  console.log("\n[3] map: Observability has correct fields");

  const { swarm, tracker } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }];

  await swarm.map({ items, prompt: "Process" });

  assert(tracker.observabilities.length === 2, `2 observability objects captured`);

  const obs0 = tracker.observabilities[0];
  assertDefined(obs0?.operationId, `operationId defined`);
  assert(obs0?.operation === "map", `operation is "map": ${obs0?.operation}`);
  assert(obs0?.itemIndex === 0, `itemIndex is 0: ${obs0?.itemIndex}`);
  assert(obs0?.role === "worker", `role is "worker": ${obs0?.role}`);

  const obs1 = tracker.observabilities[1];
  assert(obs1?.itemIndex === 1, `second item has itemIndex 1: ${obs1?.itemIndex}`);
}

async function testFilterObservabilityFields(): Promise<void> {
  console.log("\n[4] filter: Observability has correct fields");

  const { swarm, tracker } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }];
  const schema = z.object({ score: z.number() });

  await swarm.filter({ items, prompt: "Evaluate", schema, condition: () => true });

  const obs = tracker.observabilities[0];
  assertDefined(obs?.operationId, `operationId defined`);
  assert(obs?.operation === "filter", `operation is "filter": ${obs?.operation}`);
  assert(obs?.itemIndex === 0, `itemIndex is 0: ${obs?.itemIndex}`);
  assert(obs?.role === "worker", `role is "worker": ${obs?.role}`);
}

async function testReduceObservabilityFields(): Promise<void> {
  console.log("\n[5] reduce: Observability has correct fields");

  const { swarm, tracker } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }];

  await swarm.reduce({ items, prompt: "Synthesize" });

  const obs = tracker.observabilities[0];
  assertDefined(obs?.operationId, `operationId defined`);
  assert(obs?.operation === "reduce", `operation is "reduce": ${obs?.operation}`);
  assert(obs?.role === "worker", `role is "worker": ${obs?.role}`);
  // reduce doesn't have itemIndex (it processes all items together)
}

// =============================================================================
// TEST: ERROR RETRY TRACKING
// =============================================================================

async function testErrorRetryInObservability(): Promise<void> {
  console.log("\n[6] errorRetry: Tracked in observability on retry");

  const failuresPerTag = new Map([["test-map-0", 2]]);
  const { swarm, tracker } = createMockSwarm({ failuresPerTag });
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({
    items,
    prompt: "Process",
    retry: { maxAttempts: 4, backoffMs: 1 },
  });

  // Should have 3 calls: attempt 1 (fail), attempt 2 (fail), attempt 3 (success)
  assert(tracker.observabilities.length === 3, `3 observability objects: ${tracker.observabilities.length}`);

  // First attempt: no errorRetry
  assert(
    tracker.observabilities[0]?.errorRetry === undefined,
    `First attempt has no errorRetry: ${tracker.observabilities[0]?.errorRetry}`
  );

  // Second attempt: errorRetry = 1
  assert(
    tracker.observabilities[1]?.errorRetry === 1,
    `Second attempt has errorRetry=1: ${tracker.observabilities[1]?.errorRetry}`
  );

  // Third attempt: errorRetry = 2
  assert(
    tracker.observabilities[2]?.errorRetry === 2,
    `Third attempt has errorRetry=2: ${tracker.observabilities[2]?.errorRetry}`
  );
}

async function testErrorRetryInMeta(): Promise<void> {
  console.log("\n[7] errorRetry: Tracked in result.meta");

  const failuresPerTag = new Map([["test-map-0", 1]]);
  const { swarm } = createMockSwarm({ failuresPerTag });
  const items: FileMap[] = [{ "a.txt": "a" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  const meta = results[0]?.meta;
  assertDefined(meta, `Result has meta`);
  assert(meta.errorRetry === 1, `meta.errorRetry is 1: ${meta.errorRetry}`);
}

// =============================================================================
// TEST: VERIFY ATTEMPT TRACKING
// =============================================================================

async function testVerifyAttemptInObservability(): Promise<void> {
  console.log("\n[8] verifyRetry: Tracked in observability during verify loop");

  const { swarm, tracker } = createMockSwarm({ verifyPassOnAttempt: 2 });
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 3 },
  });

  // Workers should have verifyRetry (undefined on first attempt, 1 on first retry)
  const workerObs = tracker.observabilities.filter(o => o.role === "worker");
  assert(workerObs.length === 2, `2 worker observabilities: ${workerObs.length}`);

  assert(
    workerObs[0]?.verifyRetry === undefined,
    `First worker has verifyRetry=undefined (not a retry): ${workerObs[0]?.verifyRetry}`
  );
  assert(
    workerObs[1]?.verifyRetry === 1,
    `Second worker has verifyRetry=1 (first retry): ${workerObs[1]?.verifyRetry}`
  );

  // Verifiers should also have verifyRetry
  const verifierObs = tracker.observabilities.filter(o => o.role === "verifier");
  assert(verifierObs.length === 2, `2 verifier observabilities: ${verifierObs.length}`);
}

async function testVerifyAttemptInMeta(): Promise<void> {
  console.log("\n[9] verifyRetry: Tracked in result.meta");

  const { swarm } = createMockSwarm({ verifyPassOnAttempt: 2 });
  const items: FileMap[] = [{ "a.txt": "a" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 3 },
  });

  const meta = results[0]?.meta;
  assertDefined(meta, `Result has meta`);
  // verifyRetry=1 means first retry (attempt 2)
  assert(meta.verifyRetry === 1, `meta.verifyRetry is 1: ${meta.verifyRetry}`);
}

// =============================================================================
// TEST: BESTOF CANDIDATE INDEX TRACKING
// =============================================================================

async function testCandidateIndexInObservability(): Promise<void> {
  console.log("\n[10] candidateIndex: Tracked in observability for bestOf");

  const { swarm, tracker } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({
    items,
    prompt: "Process",
    bestOf: { n: 3, judgeCriteria: "Best output" },
  });

  // Should have 3 candidates + 1 judge
  const candidateObs = tracker.observabilities.filter(o => o.role === "candidate");
  assert(candidateObs.length === 3, `3 candidate observabilities: ${candidateObs.length}`);

  assert(candidateObs[0]?.candidateIndex === 0, `First candidate has candidateIndex=0`);
  assert(candidateObs[1]?.candidateIndex === 1, `Second candidate has candidateIndex=1`);
  assert(candidateObs[2]?.candidateIndex === 2, `Third candidate has candidateIndex=2`);

  // Judge should not have candidateIndex
  const judgeObs = tracker.observabilities.find(o => o.role === "judge");
  assert(judgeObs?.candidateIndex === undefined, `Judge has no candidateIndex`);
}

async function testCandidateIndexInMeta(): Promise<void> {
  console.log("\n[11] candidateIndex: Tracked in candidate result.meta");

  const { swarm } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    bestOf: { n: 2, judgeCriteria: "Best output" },
  });

  // Winner should have bestOf info with candidates
  const result = results[0];
  assertDefined(result?.bestOf, `Result has bestOf info`);

  const candidates = result.bestOf!.candidates;
  assert(candidates[0]?.meta.candidateIndex === 0, `Candidate 0 meta has candidateIndex=0`);
  assert(candidates[1]?.meta.candidateIndex === 1, `Candidate 1 meta has candidateIndex=1`);
}

// =============================================================================
// TEST: PIPELINE CONTEXT PROPAGATION
// =============================================================================

async function testPipelineContextInObservability(): Promise<void> {
  console.log("\n[12] Pipeline: Context propagated to observability");

  const { swarm, tracker } = createMockSwarm();
  const pipeline = new Pipeline(swarm)
    .map({ prompt: "Step 1", name: "analyze" })
    .filter({
      prompt: "Step 2",
      name: "evaluate",
      schema: z.object({ score: z.number() }),
      condition: () => true,
    });

  const items: FileMap[] = [{ "a.txt": "a" }];
  await pipeline.run(items);

  // Step 0 (map) observability
  const step0Obs = tracker.observabilities.find(o => o.pipelineStepIndex === 0);
  assertDefined(step0Obs, `Step 0 observability exists`);
  assertDefined(step0Obs?.pipelineRunId, `pipelineRunId defined`);
  assert(step0Obs?.pipelineStepIndex === 0, `pipelineStepIndex is 0`);

  // Step 1 (filter) observability
  const step1Obs = tracker.observabilities.find(o => o.pipelineStepIndex === 1);
  assertDefined(step1Obs, `Step 1 observability exists`);
  assert(step1Obs?.pipelineStepIndex === 1, `pipelineStepIndex is 1`);

  // Both steps share same pipelineRunId
  assert(
    step0Obs?.pipelineRunId === step1Obs?.pipelineRunId,
    `Both steps share pipelineRunId`
  );
}

async function testPipelineContextInMeta(): Promise<void> {
  console.log("\n[13] Pipeline: Context propagated to result.meta");

  const { swarm } = createMockSwarm();
  const pipeline = new Pipeline(swarm)
    .map({ prompt: "Analyze", name: "step1" });

  const items: FileMap[] = [{ "a.txt": "a" }];
  const result = await pipeline.run(items);

  // Check pipelineRunId in result
  assertDefined(result.pipelineRunId, `PipelineResult has pipelineRunId`);
  assert(
    /^[0-9a-f]{16}$/.test(result.pipelineRunId),
    `pipelineRunId is 16 hex chars: ${result.pipelineRunId}`
  );

  // Check meta in step results
  const stepResult = result.steps[0];
  assertDefined(stepResult, `Step result exists`);

  const itemResults = stepResult.results as SwarmResult<unknown>[];
  const meta = itemResults[0]?.meta;
  assertDefined(meta, `Item result has meta`);

  assert(
    meta.pipelineRunId === result.pipelineRunId,
    `meta.pipelineRunId matches result.pipelineRunId`
  );
  assert(meta.pipelineStepIndex === 0, `meta.pipelineStepIndex is 0: ${meta.pipelineStepIndex}`);
  assert(meta.operationName === "step1", `meta.operationName is "step1": ${meta.operationName}`);
}

async function testPipelineRunIdUnique(): Promise<void> {
  console.log("\n[14] Pipeline: Each run() gets unique pipelineRunId");

  const { swarm } = createMockSwarm();
  const pipeline = new Pipeline(swarm).map({ prompt: "Process" });

  const items: FileMap[] = [{ "a.txt": "a" }];

  const result1 = await pipeline.run(items);
  const result2 = await pipeline.run(items);

  assertDefined(result1.pipelineRunId, `First run has pipelineRunId`);
  assertDefined(result2.pipelineRunId, `Second run has pipelineRunId`);
  assert(
    result1.pipelineRunId !== result2.pipelineRunId,
    `Different runs have different pipelineRunIds: ${result1.pipelineRunId} !== ${result2.pipelineRunId}`
  );
}

// =============================================================================
// TEST: NO PIPELINE CONTEXT FOR DIRECT SWARM CALLS
// =============================================================================

async function testNoPipelineContextForDirectSwarm(): Promise<void> {
  console.log("\n[15] Direct Swarm: No pipeline context in meta");

  const { swarm, tracker } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }];

  const results = await swarm.map({ items, prompt: "Process" });

  // Observability should not have pipeline fields
  const obs = tracker.observabilities[0];
  assert(obs?.pipelineRunId === undefined, `No pipelineRunId in observability`);
  assert(obs?.pipelineStepIndex === undefined, `No pipelineStepIndex in observability`);

  // Meta should have undefined pipeline fields
  const meta = results[0]?.meta;
  assert(meta?.pipelineRunId === undefined, `No pipelineRunId in meta`);
  assert(meta?.pipelineStepIndex === undefined, `No pipelineStepIndex in meta`);
}

// =============================================================================
// TEST: REDUCE META STRUCTURE
// =============================================================================

async function testReduceMetaStructure(): Promise<void> {
  console.log("\n[16] reduce: Meta has correct structure (ReduceMeta)");

  const { swarm } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }, { "c.txt": "c" }];

  const result = await swarm.reduce({ items, prompt: "Synthesize" });

  const meta = result.meta as ReduceMeta;
  assertDefined(meta.operationId, `operationId defined`);
  assert(meta.operation === "reduce", `operation is "reduce"`);
  assert(meta.inputCount === 3, `inputCount is 3: ${meta.inputCount}`);
  assert(
    JSON.stringify(meta.inputIndices) === "[0,1,2]",
    `inputIndices is [0,1,2]: ${JSON.stringify(meta.inputIndices)}`
  );
}

// =============================================================================
// TEST: VERIFY META STRUCTURE
// =============================================================================

async function testVerifyMetaStructure(): Promise<void> {
  console.log("\n[17] verify: VerifyMeta has correct structure");

  const { swarm } = createMockSwarm({ verifyPassOnAttempt: 2 });
  const items: FileMap[] = [{ "a.txt": "a" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    verify: { criteria: "Valid", maxAttempts: 3 },
  });

  const verifyInfo = results[0]?.verify;
  assertDefined(verifyInfo, `Result has verify info`);
  assert(verifyInfo.passed === true, `verify.passed is true`);
  assert(verifyInfo.attempts === 2, `verify.attempts is 2: ${verifyInfo.attempts}`);

  const verifyMeta = verifyInfo.verifyMeta;
  assertDefined(verifyMeta, `verifyMeta defined`);
  assertDefined(verifyMeta.operationId, `verifyMeta.operationId defined`);
  assert(verifyMeta.operation === "verify", `verifyMeta.operation is "verify"`);
  assert(verifyMeta.attempts === 2, `verifyMeta.attempts is 2: ${verifyMeta.attempts}`);
}

async function testVerifyMetaHasPipelineContext(): Promise<void> {
  console.log("\n[18] verify: VerifyMeta has pipeline context when run via Pipeline");

  const { swarm } = createMockSwarm({ verifyPassOnAttempt: 1 });
  const pipeline = new Pipeline(swarm)
    .map({
      prompt: "Process",
      name: "verified-step",
      verify: { criteria: "Valid", maxAttempts: 2 },
    });

  const items: FileMap[] = [{ "a.txt": "a" }];
  const result = await pipeline.run(items);

  const stepResults = result.steps[0]?.results as SwarmResult<unknown>[];
  const verifyMeta = stepResults[0]?.verify?.verifyMeta;

  assertDefined(verifyMeta, `verifyMeta defined`);
  assert(
    verifyMeta.pipelineRunId === result.pipelineRunId,
    `verifyMeta.pipelineRunId matches: ${verifyMeta.pipelineRunId}`
  );
  assert(verifyMeta.pipelineStepIndex === 0, `verifyMeta.pipelineStepIndex is 0`);
}

// =============================================================================
// TEST: BESTOF JUDGE META STRUCTURE
// =============================================================================

async function testJudgeMetaStructure(): Promise<void> {
  console.log("\n[19] bestOf: JudgeMeta has correct structure");

  const { swarm } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }];

  const results = await swarm.map({
    items,
    prompt: "Process",
    bestOf: { n: 3, judgeCriteria: "Best output" },
  });

  const bestOfInfo = results[0]?.bestOf;
  assertDefined(bestOfInfo, `Result has bestOf info`);

  const judgeMeta = bestOfInfo.judgeMeta;
  assertDefined(judgeMeta, `judgeMeta defined`);
  assertDefined(judgeMeta.operationId, `judgeMeta.operationId defined`);
  assert(judgeMeta.operation === "bestof-judge", `judgeMeta.operation is "bestof-judge"`);
  assert(judgeMeta.candidateCount === 3, `judgeMeta.candidateCount is 3: ${judgeMeta.candidateCount}`);
}

async function testJudgeMetaHasPipelineContext(): Promise<void> {
  console.log("\n[20] bestOf: JudgeMeta has pipeline context when run via Pipeline");

  const { swarm } = createMockSwarm();
  const pipeline = new Pipeline(swarm)
    .map({
      prompt: "Process",
      name: "bestof-step",
      bestOf: { n: 2, judgeCriteria: "Best output" },
    });

  const items: FileMap[] = [{ "a.txt": "a" }];
  const result = await pipeline.run(items);

  const stepResults = result.steps[0]?.results as SwarmResult<unknown>[];
  const judgeMeta = stepResults[0]?.bestOf?.judgeMeta;

  assertDefined(judgeMeta, `judgeMeta defined`);
  assert(
    judgeMeta.pipelineRunId === result.pipelineRunId,
    `judgeMeta.pipelineRunId matches: ${judgeMeta.pipelineRunId}`
  );
  assert(judgeMeta.pipelineStepIndex === 0, `judgeMeta.pipelineStepIndex is 0`);
}

// =============================================================================
// TEST: ROLE FIELD IN OBSERVABILITY
// =============================================================================

async function testRoleFieldVariants(): Promise<void> {
  console.log("\n[21] role: Different roles for different execution types");

  const { swarm, tracker } = createMockSwarm({ verifyPassOnAttempt: 1 });
  const items: FileMap[] = [{ "a.txt": "a" }];

  // Test worker role
  await swarm.map({ items, prompt: "Map" });
  assert(
    tracker.observabilities.some(o => o.role === "worker"),
    `map has role="worker"`
  );

  // Clear and test verify roles
  tracker.observabilities.length = 0;
  await swarm.map({
    items,
    prompt: "Map with verify",
    verify: { criteria: "Valid", maxAttempts: 2 },
  });
  assert(
    tracker.observabilities.some(o => o.role === "worker"),
    `verify workflow has role="worker"`
  );
  assert(
    tracker.observabilities.some(o => o.role === "verifier"),
    `verify workflow has role="verifier"`
  );

  // Clear and test bestOf roles
  tracker.observabilities.length = 0;
  await swarm.map({
    items,
    prompt: "Map with bestOf",
    bestOf: { n: 2, judgeCriteria: "Best" },
  });
  assert(
    tracker.observabilities.some(o => o.role === "candidate"),
    `bestOf has role="candidate"`
  );
  assert(
    tracker.observabilities.some(o => o.role === "judge"),
    `bestOf has role="judge"`
  );
}

// =============================================================================
// TEST: ALL FIELDS TOGETHER
// =============================================================================

async function testAllFieldsTogether(): Promise<void> {
  console.log("\n[22] Combined: Pipeline + verify fields present together");

  // Test pipeline context + verifyRetry together (most common combined scenario)
  const { swarm, tracker } = createMockSwarm({ verifyPassOnAttempt: 2 });

  const pipeline = new Pipeline(swarm)
    .map({
      prompt: "Process",
      name: "complex-step",
      verify: { criteria: "Valid", maxAttempts: 3 },
    });

  const items: FileMap[] = [{ "a.txt": "a" }];
  await pipeline.run(items);

  // Find the second worker (verifyRetry=1 is the first retry, which is the successful one)
  const successWorkerObs = tracker.observabilities.find(
    o => o.role === "worker" && o.verifyRetry === 1
  );

  assertDefined(successWorkerObs, `Found worker with verifyRetry=1`);
  assertDefined(successWorkerObs.operationId, `operationId defined`);
  assert(successWorkerObs.operation === "map", `operation is "map"`);
  assert(successWorkerObs.itemIndex === 0, `itemIndex is 0`);
  assert(successWorkerObs.role === "worker", `role is "worker"`);
  assert(successWorkerObs.verifyRetry === 1, `verifyRetry is 1 (first retry)`);
  assertDefined(successWorkerObs.pipelineRunId, `pipelineRunId defined`);
  assert(successWorkerObs.pipelineStepIndex === 0, `pipelineStepIndex is 0`);
}

// =============================================================================
// TEST: SWARM NAME PROPAGATION
// =============================================================================

async function testSwarmNameInObservability(): Promise<void> {
  console.log("\n[24] swarmName: Propagated to observability for all operations");

  const { swarm, tracker } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }];
  const schema = z.object({ score: z.number() });

  // Test map
  await swarm.map({ items, prompt: "Map" });
  const mapObs = tracker.observabilities[0];
  assert(mapObs?.swarmName === "test", `map observability has swarmName="test": ${mapObs?.swarmName}`);

  // Test filter
  tracker.observabilities.length = 0;
  await swarm.filter({ items, prompt: "Filter", schema, condition: () => true });
  const filterObs = tracker.observabilities[0];
  assert(filterObs?.swarmName === "test", `filter observability has swarmName="test": ${filterObs?.swarmName}`);

  // Test reduce
  tracker.observabilities.length = 0;
  await swarm.reduce({ items, prompt: "Reduce" });
  const reduceObs = tracker.observabilities[0];
  assert(reduceObs?.swarmName === "test", `reduce observability has swarmName="test": ${reduceObs?.swarmName}`);
}

async function testSwarmNameInMeta(): Promise<void> {
  console.log("\n[25] swarmName: Propagated to result.meta for all operations");

  const { swarm } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }];
  const schema = z.object({ score: z.number() });

  // Test map meta
  const mapResults = await swarm.map({ items, prompt: "Map" });
  assert(mapResults[0]?.meta.swarmName === "test", `map meta has swarmName="test": ${mapResults[0]?.meta.swarmName}`);

  // Test filter meta
  const filterResults = await swarm.filter({ items, prompt: "Filter", schema, condition: () => true });
  assert(filterResults[0]?.meta.swarmName === "test", `filter meta has swarmName="test": ${filterResults[0]?.meta.swarmName}`);

  // Test reduce meta
  const reduceResult = await swarm.reduce({ items, prompt: "Reduce" });
  assert(reduceResult.meta.swarmName === "test", `reduce meta has swarmName="test": ${reduceResult.meta.swarmName}`);
}

// =============================================================================
// TEST: OPERATION NAME VIA DIRECT SWARM CALLS
// =============================================================================

async function testOperationNameDirectSwarm(): Promise<void> {
  console.log("\n[26] operationName: Works via direct swarm.map({ name: '...' })");

  const { swarm, tracker } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({ items, prompt: "Process", name: "my-custom-operation" });

  // Check observability
  const obs = tracker.observabilities[0];
  assert(obs?.operationName === "my-custom-operation", `observability has operationName: ${obs?.operationName}`);
}

async function testOperationNameInMeta(): Promise<void> {
  console.log("\n[27] operationName: Propagated to result.meta for direct swarm calls");

  const { swarm } = createMockSwarm();
  const items: FileMap[] = [{ "a.txt": "a" }];
  const schema = z.object({ score: z.number() });

  // Test map
  const mapResults = await swarm.map({ items, prompt: "Map", name: "map-op" });
  assert(mapResults[0]?.meta.operationName === "map-op", `map meta has operationName: ${mapResults[0]?.meta.operationName}`);

  // Test filter
  const filterResults = await swarm.filter({ items, prompt: "Filter", schema, condition: () => true, name: "filter-op" });
  assert(filterResults[0]?.meta.operationName === "filter-op", `filter meta has operationName: ${filterResults[0]?.meta.operationName}`);

  // Test reduce
  const reduceResult = await swarm.reduce({ items, prompt: "Reduce", name: "reduce-op" });
  assert(reduceResult.meta.operationName === "reduce-op", `reduce meta has operationName: ${reduceResult.meta.operationName}`);
}

// =============================================================================
// TEST: REDUCE WITH RETRY TRACKING
// =============================================================================

async function testReduceErrorRetryInMeta(): Promise<void> {
  console.log("\n[28] reduce: errorRetry tracked in meta on retry");

  const failuresPerTag = new Map([["test-reduce", 1]]);
  const { swarm, tracker } = createMockSwarm({ failuresPerTag });
  const items: FileMap[] = [{ "a.txt": "a" }];

  const result = await swarm.reduce({
    items,
    prompt: "Synthesize",
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  // Should have 2 observabilities (1 fail + 1 success)
  assert(tracker.observabilities.length === 2, `2 observabilities: ${tracker.observabilities.length}`);

  // First attempt has no errorRetry
  assert(tracker.observabilities[0]?.errorRetry === undefined, `First attempt has no errorRetry`);

  // Second attempt has errorRetry=1
  assert(tracker.observabilities[1]?.errorRetry === 1, `Second attempt has errorRetry=1: ${tracker.observabilities[1]?.errorRetry}`);

  // Meta should have errorRetry
  assert(result.meta.errorRetry === 1, `reduce meta.errorRetry is 1: ${result.meta.errorRetry}`);
}

async function testReduceVerifyAttemptInMeta(): Promise<void> {
  console.log("\n[29] reduce: verifyRetry tracked in meta with verify");

  const { swarm, tracker } = createMockSwarm({ verifyPassOnAttempt: 2 });
  const items: FileMap[] = [{ "a.txt": "a" }];

  const result = await swarm.reduce({
    items,
    prompt: "Synthesize",
    verify: { criteria: "Valid", maxAttempts: 3 },
  });

  // Workers should have verifyRetry (undefined on first attempt, 1 on first retry)
  const workerObs = tracker.observabilities.filter(o => o.role === "worker");
  assert(workerObs.length === 2, `2 worker observabilities: ${workerObs.length}`);
  assert(workerObs[0]?.verifyRetry === undefined, `First worker has verifyRetry=undefined`);
  assert(workerObs[1]?.verifyRetry === 1, `Second worker has verifyRetry=1`);

  // Meta should have verifyRetry (1 = first retry was successful)
  assert(result.meta.verifyRetry === 1, `reduce meta.verifyRetry is 1: ${result.meta.verifyRetry}`);

  // Verify info should be present
  assertDefined(result.verify, `reduce result has verify info`);
  assert(result.verify.passed === true, `verify.passed is true`);
}

// =============================================================================
// TEST: FILTER WITH VERIFY TRACKING
// =============================================================================

async function testFilterVerifyAttemptInMeta(): Promise<void> {
  console.log("\n[30] filter: verifyRetry tracked in meta with verify");

  const { swarm, tracker } = createMockSwarm({ verifyPassOnAttempt: 2 });
  const items: FileMap[] = [{ "a.txt": "a" }];
  const schema = z.object({ score: z.number() });

  const results = await swarm.filter({
    items,
    prompt: "Evaluate",
    schema,
    condition: () => true,
    verify: { criteria: "Valid", maxAttempts: 3 },
  });

  // Workers should have verifyRetry (undefined on first attempt, 1 on first retry)
  const workerObs = tracker.observabilities.filter(o => o.role === "worker");
  assert(workerObs.length === 2, `2 worker observabilities: ${workerObs.length}`);
  assert(workerObs[0]?.verifyRetry === undefined, `First worker has verifyRetry=undefined`);
  assert(workerObs[1]?.verifyRetry === 1, `Second worker has verifyRetry=1`);

  // Meta should have verifyRetry (1 = first retry was successful)
  const meta = results[0]?.meta;
  assert(meta?.verifyRetry === 1, `filter meta.verifyRetry is 1: ${meta?.verifyRetry}`);

  // Verify info should be present
  assertDefined(results[0]?.verify, `filter result has verify info`);
  assert(results[0]?.verify?.passed === true, `verify.passed is true`);
}

async function testFilterErrorRetryInMeta(): Promise<void> {
  console.log("\n[31] filter: errorRetry tracked in meta on retry");

  const failuresPerTag = new Map([["test-filter-0", 1]]);
  const { swarm, tracker } = createMockSwarm({ failuresPerTag });
  const items: FileMap[] = [{ "a.txt": "a" }];
  const schema = z.object({ score: z.number() });

  const results = await swarm.filter({
    items,
    prompt: "Evaluate",
    schema,
    condition: () => true,
    retry: { maxAttempts: 3, backoffMs: 1 },
  });

  // Should have 2 observabilities (1 fail + 1 success)
  assert(tracker.observabilities.length === 2, `2 observabilities: ${tracker.observabilities.length}`);

  // First attempt has no errorRetry
  assert(tracker.observabilities[0]?.errorRetry === undefined, `First attempt has no errorRetry`);

  // Second attempt has errorRetry=1
  assert(tracker.observabilities[1]?.errorRetry === 1, `Second attempt has errorRetry=1`);

  // Meta should have errorRetry
  const meta = results[0]?.meta;
  assert(meta?.errorRetry === 1, `filter meta.errorRetry is 1: ${meta?.errorRetry}`);
}

// =============================================================================
// TEST: STANDALONE BESTOF OBSERVABILITY
// =============================================================================

async function testStandaloneBestOfObservability(): Promise<void> {
  console.log("\n[23] Standalone bestOf: Has same observability as map+bestOf (minus pipeline)");

  const { swarm, tracker } = createMockSwarm();
  const item: FileMap = { "a.txt": "a" };

  const result = await swarm.bestOf({
    item,
    prompt: "Process",
    config: { n: 2, judgeCriteria: "Best output" },
  });

  // Check candidates have correct observability
  const candidateObs = tracker.observabilities.filter(o => o.role === "candidate");
  assert(candidateObs.length === 2, `2 candidates`);
  assertDefined(candidateObs[0]?.operationId, `Candidate has operationId`);
  assert(candidateObs[0]?.candidateIndex === 0, `First candidate has candidateIndex=0`);
  assert(candidateObs[1]?.candidateIndex === 1, `Second candidate has candidateIndex=1`);

  // Check judge has correct observability
  const judgeObs = tracker.observabilities.find(o => o.role === "judge");
  assertDefined(judgeObs, `Judge observability exists`);
  assertDefined(judgeObs?.operationId, `Judge has operationId`);
  assert(judgeObs?.operationId === candidateObs[0]?.operationId, `Judge shares operationId with candidates`);

  // Standalone bestOf should NOT have pipeline context
  assert(candidateObs[0]?.pipelineRunId === undefined, `No pipelineRunId (standalone)`);

  // Check result structure
  assertDefined(result.judgeMeta, `Result has judgeMeta`);
  assert(result.judgeMeta.candidateCount === 2, `judgeMeta.candidateCount is 2`);
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Observability Metadata Propagation Tests");
  console.log("=".repeat(70));

  // operationId tests
  await testOperationIdUnique();
  await testOperationIdPerAbstraction();

  // Observability fields tests
  await testMapObservabilityFields();
  await testFilterObservabilityFields();
  await testReduceObservabilityFields();

  // Error retry tracking
  await testErrorRetryInObservability();
  await testErrorRetryInMeta();

  // Verify attempt tracking
  await testVerifyAttemptInObservability();
  await testVerifyAttemptInMeta();

  // BestOf candidate index
  await testCandidateIndexInObservability();
  await testCandidateIndexInMeta();

  // Pipeline context propagation
  await testPipelineContextInObservability();
  await testPipelineContextInMeta();
  await testPipelineRunIdUnique();
  await testNoPipelineContextForDirectSwarm();

  // Meta structures
  await testReduceMetaStructure();
  await testVerifyMetaStructure();
  await testVerifyMetaHasPipelineContext();
  await testJudgeMetaStructure();
  await testJudgeMetaHasPipelineContext();

  // Role field
  await testRoleFieldVariants();

  // Combined scenario
  await testAllFieldsTogether();

  // Standalone bestOf
  await testStandaloneBestOfObservability();

  // swarmName propagation
  await testSwarmNameInObservability();
  await testSwarmNameInMeta();

  // operationName via direct swarm calls
  await testOperationNameDirectSwarm();
  await testOperationNameInMeta();

  // reduce retry tracking
  await testReduceErrorRetryInMeta();
  await testReduceVerifyAttemptInMeta();

  // filter retry tracking
  await testFilterVerifyAttemptInMeta();
  await testFilterErrorRetryInMeta();

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
