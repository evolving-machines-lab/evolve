#!/usr/bin/env tsx
/**
 * Unit Test: Skills Integration
 *
 * Tests skills support across Evolve, Swarm, and Pipeline:
 * - Evolve.withSkills() correctly sets skills config
 * - Swarm passes skills through execute() opts
 * - Skills resolution: swarm-level default, per-operation override
 * - BestOf: candidateSkills, judgeSkills resolution via config
 * - Verify: verifierSkills resolution via config
 * - Pipeline: skills passed from step config through to Swarm
 *
 * Uses mocked execute() to avoid real sandbox/agent calls.
 *
 * Usage:
 *   npx tsx tests/unit/skills-integration.test.ts
 */

import {
  Swarm,
  Pipeline,
  Evolve,
  type SwarmConfig,
  type FileMap,
  type SkillName,
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

function assertArrayEquals(actual: unknown[] | undefined, expected: unknown[] | undefined, message: string): void {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
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
  skills?: SkillName[];
  role?: string;
}

interface MockTracker {
  calls: ExecuteCall[];
}

function createMockSwarm(
  swarmSkills?: SkillName[]
): { swarm: Swarm; tracker: MockTracker } {
  const tracker: MockTracker = {
    calls: [],
  };

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
    skills: swarmSkills,
  };

  const swarm = new Swarm(config);

  // Override execute to capture skills
  (swarm as any).execute = async function (
    _context: FileMap,
    _prompt: string,
    opts: {
      tagPrefix: string;
      timeoutMs: number;
      schema?: unknown;
      skills?: SkillName[];
      observability?: { role?: string };
    }
  ) {
    const call: ExecuteCall = {
      tagPrefix: opts.tagPrefix,
      skills: opts.skills,
      role: opts.observability?.role,
    };
    tracker.calls.push(call);

    await sleep(5);

    const mockData = opts.schema ? { score: 5, value: 10, passed: true, reasoning: "OK" } : {};
    return {
      files: { "result.json": JSON.stringify(mockData) },
      data: mockData,
      tag: opts.tagPrefix + "-abc",
      sandboxId: "mock-sandbox-id",
    };
  };

  return { swarm, tracker };
}

// =============================================================================
// TEST: EVOLVE.WITHSKILLS()
// =============================================================================

async function testEvolveWithSkills(): Promise<void> {
  console.log("\n[1] Evolve.withSkills(): Sets skills on config");

  const kit = new Evolve({ type: "claude", apiKey: "mock-key" });
  const result = kit.withSkills(["pdf", "dev-browser"]);

  // Check fluent return
  assert(result === kit, "withSkills() returns this for chaining");

  // Check config
  const config = (kit as any).config;
  assertArrayEquals(config.skills, ["pdf", "dev-browser"], "skills set on config");
}

async function testEvolveWithSkillsChaining(): Promise<void> {
  console.log("\n[2] Evolve.withSkills(): Chains with other methods");

  const kit = new Evolve({ type: "claude", apiKey: "mock-key" })
    .withSkills(["pdf"])
    .withMcpServers({ test: { type: "sse", url: "http://test" } })
    .withSystemPrompt("Test prompt");

  const config = (kit as any).config;
  assertArrayEquals(config.skills, ["pdf"], "skills preserved after chaining");
  assert(config.mcpServers !== undefined, "mcpServers set after chaining");
  assert(config.systemPrompt === "Test prompt", "systemPrompt set after chaining");
}

// =============================================================================
// TEST: SWARM DEFAULT SKILLS
// =============================================================================

async function testSwarmDefaultSkills(): Promise<void> {
  console.log("\n[3] Swarm: Default skills passed to execute()");

  const { swarm, tracker } = createMockSwarm(["pdf", "docx"]);
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({ items, prompt: "Process" });

  assert(tracker.calls.length === 1, "1 execute call");
  assertArrayEquals(tracker.calls[0]?.skills, ["pdf", "docx"], "skills passed to execute");
}

async function testSwarmNoDefaultSkills(): Promise<void> {
  console.log("\n[4] Swarm: No default skills = undefined in execute()");

  const { swarm, tracker } = createMockSwarm(); // No skills
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({ items, prompt: "Process" });

  assert(tracker.calls.length === 1, "1 execute call");
  assert(tracker.calls[0]?.skills === undefined, "skills is undefined when not configured");
}

// =============================================================================
// TEST: PER-OPERATION OVERRIDE
// =============================================================================

async function testMapSkillsOverride(): Promise<void> {
  console.log("\n[5] map(): Per-operation skills override swarm default");

  const { swarm, tracker } = createMockSwarm(["pdf"]); // Default: pdf
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({ items, prompt: "Process", skills: ["xlsx", "pptx"] }); // Override

  assertArrayEquals(tracker.calls[0]?.skills, ["xlsx", "pptx"], "operation skills override default");
}

async function testFilterSkillsOverride(): Promise<void> {
  console.log("\n[6] filter(): Per-operation skills override swarm default");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const items: FileMap[] = [{ "a.txt": "a" }];
  const schema = z.object({ score: z.number() });

  await swarm.filter({
    items,
    prompt: "Evaluate",
    schema,
    condition: () => true,
    skills: ["dev-browser"],
  });

  assertArrayEquals(tracker.calls[0]?.skills, ["dev-browser"], "filter skills override default");
}

async function testReduceSkillsOverride(): Promise<void> {
  console.log("\n[7] reduce(): Per-operation skills override swarm default");

  const { swarm, tracker } = createMockSwarm(["pdf", "docx"]);
  const items: FileMap[] = [{ "a.txt": "a" }, { "b.txt": "b" }];

  await swarm.reduce({ items, prompt: "Synthesize", skills: ["xlsx"] });

  assertArrayEquals(tracker.calls[0]?.skills, ["xlsx"], "reduce skills override default");
}

// =============================================================================
// TEST: BESTOF SKILLS RESOLUTION
// =============================================================================

async function testBestOfCandidateSkills(): Promise<void> {
  console.log("\n[8] bestOf(): Candidates use config.skills (falls back to swarm default)");

  const { swarm, tracker } = createMockSwarm(["pdf"]); // Swarm default
  const item: FileMap = { "a.txt": "a" };

  await swarm.bestOf({
    item,
    prompt: "Process",
    config: {
      n: 2,
      judgeCriteria: "Best",
      skills: ["xlsx"], // Candidate override
    },
  });

  const candidateCalls = tracker.calls.filter((c) => c.role === "candidate");
  assert(candidateCalls.length === 2, "2 candidate calls");
  assertArrayEquals(candidateCalls[0]?.skills, ["xlsx"], "candidate 0 uses config.skills");
  assertArrayEquals(candidateCalls[1]?.skills, ["xlsx"], "candidate 1 uses config.skills");
}

async function testBestOfCandidateSkillsFallback(): Promise<void> {
  console.log("\n[9] bestOf(): Candidates fall back to swarm default when config.skills undefined");

  const { swarm, tracker } = createMockSwarm(["pdf", "docx"]); // Swarm default
  const item: FileMap = { "a.txt": "a" };

  await swarm.bestOf({
    item,
    prompt: "Process",
    config: {
      n: 2,
      judgeCriteria: "Best",
      // No skills override - should use swarm default
    },
  });

  const candidateCalls = tracker.calls.filter((c) => c.role === "candidate");
  assertArrayEquals(candidateCalls[0]?.skills, ["pdf", "docx"], "candidates use swarm default");
}

async function testBestOfJudgeSkills(): Promise<void> {
  console.log("\n[10] bestOf(): Judge uses config.judgeSkills");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const item: FileMap = { "a.txt": "a" };

  await swarm.bestOf({
    item,
    prompt: "Process",
    config: {
      n: 2,
      judgeCriteria: "Best",
      skills: ["xlsx"],
      judgeSkills: ["dev-browser"], // Judge-specific override
    },
  });

  const judgeCalls = tracker.calls.filter((c) => c.role === "judge");
  assert(judgeCalls.length === 1, "1 judge call");
  assertArrayEquals(judgeCalls[0]?.skills, ["dev-browser"], "judge uses judgeSkills");
}

async function testBestOfJudgeSkillsFallback(): Promise<void> {
  console.log("\n[11] bestOf(): Judge falls back to config.skills, then swarm default");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const item: FileMap = { "a.txt": "a" };

  // Test 1: Judge falls back to config.skills
  await swarm.bestOf({
    item,
    prompt: "Process",
    config: {
      n: 2,
      judgeCriteria: "Best",
      skills: ["xlsx"], // No judgeSkills - should use this
    },
  });

  let judgeCalls = tracker.calls.filter((c) => c.role === "judge");
  assertArrayEquals(judgeCalls[0]?.skills, ["xlsx"], "judge falls back to config.skills");

  // Test 2: Judge falls back to swarm default
  tracker.calls.length = 0;
  await swarm.bestOf({
    item,
    prompt: "Process",
    config: {
      n: 2,
      judgeCriteria: "Best",
      // No skills or judgeSkills - should use swarm default
    },
  });

  judgeCalls = tracker.calls.filter((c) => c.role === "judge");
  assertArrayEquals(judgeCalls[0]?.skills, ["pdf"], "judge falls back to swarm default");
}

// =============================================================================
// TEST: MAP WITH BESTOF SKILLS
// =============================================================================

async function testMapWithBestOfSkills(): Promise<void> {
  console.log("\n[12] map(bestOf): Skills resolution in map+bestOf combo");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({
    items,
    prompt: "Process",
    skills: ["docx"], // Operation-level override
    bestOf: {
      n: 2,
      judgeCriteria: "Best",
      skills: ["xlsx"], // BestOf candidate override
      judgeSkills: ["pptx"], // BestOf judge override
    },
  });

  const candidateCalls = tracker.calls.filter((c) => c.role === "candidate");
  const judgeCalls = tracker.calls.filter((c) => c.role === "judge");

  assertArrayEquals(candidateCalls[0]?.skills, ["xlsx"], "candidates use bestOf.skills");
  assertArrayEquals(judgeCalls[0]?.skills, ["pptx"], "judge uses bestOf.judgeSkills");
}

async function testMapWithBestOfSkillsFallback(): Promise<void> {
  console.log("\n[13] map(bestOf): Fallback chain: bestOf.skills → params.skills → swarm default");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const items: FileMap[] = [{ "a.txt": "a" }];

  // Test: bestOf.skills undefined → use params.skills
  await swarm.map({
    items,
    prompt: "Process",
    skills: ["docx"], // params.skills
    bestOf: {
      n: 2,
      judgeCriteria: "Best",
      // No skills - should fall back to params.skills
    },
  });

  let candidateCalls = tracker.calls.filter((c) => c.role === "candidate");
  assertArrayEquals(candidateCalls[0]?.skills, ["docx"], "candidates fall back to params.skills");

  // Test: Both undefined → use swarm default
  tracker.calls.length = 0;
  await swarm.map({
    items,
    prompt: "Process",
    // No skills at any level - should use swarm default
    bestOf: {
      n: 2,
      judgeCriteria: "Best",
    },
  });

  candidateCalls = tracker.calls.filter((c) => c.role === "candidate");
  assertArrayEquals(candidateCalls[0]?.skills, ["pdf"], "candidates fall back to swarm default");
}

// =============================================================================
// TEST: VERIFY SKILLS RESOLUTION
// =============================================================================

async function testVerifyVerifierSkills(): Promise<void> {
  console.log("\n[14] verify: verifierSkills override for verifier");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({
    items,
    prompt: "Process",
    skills: ["docx"],
    verify: {
      criteria: "Valid",
      maxAttempts: 1,
      verifierSkills: ["dev-browser"], // Verifier-specific
    },
  });

  const workerCalls = tracker.calls.filter((c) => c.role === "worker");
  const verifierCalls = tracker.calls.filter((c) => c.role === "verifier");

  assertArrayEquals(workerCalls[0]?.skills, ["docx"], "worker uses params.skills");
  assertArrayEquals(verifierCalls[0]?.skills, ["dev-browser"], "verifier uses verifierSkills");
}

async function testVerifyVerifierSkillsFallback(): Promise<void> {
  console.log("\n[15] verify: verifierSkills falls back to params.skills");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({
    items,
    prompt: "Process",
    skills: ["docx"],
    verify: {
      criteria: "Valid",
      maxAttempts: 1,
      // No verifierSkills - should use params.skills
    },
  });

  const verifierCalls = tracker.calls.filter((c) => c.role === "verifier");
  assertArrayEquals(verifierCalls[0]?.skills, ["docx"], "verifier falls back to params.skills");
}

// =============================================================================
// TEST: PIPELINE SKILLS
// =============================================================================

async function testPipelineStepSkills(): Promise<void> {
  console.log("\n[16] Pipeline: Step skills passed to Swarm operations");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const pipeline = new Pipeline(swarm)
    .map({ prompt: "Step 1", skills: ["xlsx"] });

  const items: FileMap[] = [{ "a.txt": "a" }];
  await pipeline.run(items);

  assertArrayEquals(tracker.calls[0]?.skills, ["xlsx"], "pipeline step skills passed to swarm");
}

async function testPipelineStepSkillsFallback(): Promise<void> {
  console.log("\n[17] Pipeline: Step without skills uses swarm default");

  const { swarm, tracker } = createMockSwarm(["pdf", "docx"]);
  const pipeline = new Pipeline(swarm)
    .map({ prompt: "Step 1" }); // No skills

  const items: FileMap[] = [{ "a.txt": "a" }];
  await pipeline.run(items);

  assertArrayEquals(tracker.calls[0]?.skills, ["pdf", "docx"], "pipeline step falls back to swarm default");
}

async function testPipelineMultiStepDifferentSkills(): Promise<void> {
  console.log("\n[18] Pipeline: Each step can have different skills");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const schema = z.object({ score: z.number() });

  const pipeline = new Pipeline(swarm)
    .map({ prompt: "Step 1", skills: ["xlsx"] })
    .filter({ prompt: "Step 2", schema, condition: () => true, skills: ["docx"] })
    .reduce({ prompt: "Step 3", skills: ["pptx"] });

  const items: FileMap[] = [{ "a.txt": "a" }];
  await pipeline.run(items);

  // Find calls by tag pattern
  const mapCalls = tracker.calls.filter((c) => c.tagPrefix.includes("map"));
  const filterCalls = tracker.calls.filter((c) => c.tagPrefix.includes("filter"));
  const reduceCalls = tracker.calls.filter((c) => c.tagPrefix.includes("reduce"));

  assertArrayEquals(mapCalls[0]?.skills, ["xlsx"], "map step has xlsx");
  assertArrayEquals(filterCalls[0]?.skills, ["docx"], "filter step has docx");
  assertArrayEquals(reduceCalls[0]?.skills, ["pptx"], "reduce step has pptx");
}

async function testPipelineWithBestOfSkills(): Promise<void> {
  console.log("\n[19] Pipeline: Map step with bestOf skills");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const pipeline = new Pipeline(swarm)
    .map({
      prompt: "Process",
      skills: ["docx"],
      bestOf: {
        n: 2,
        judgeCriteria: "Best",
        skills: ["xlsx"],
        judgeSkills: ["pptx"],
      },
    });

  const items: FileMap[] = [{ "a.txt": "a" }];
  await pipeline.run(items);

  const candidateCalls = tracker.calls.filter((c) => c.role === "candidate");
  const judgeCalls = tracker.calls.filter((c) => c.role === "judge");

  assertArrayEquals(candidateCalls[0]?.skills, ["xlsx"], "pipeline bestOf candidates use bestOf.skills");
  assertArrayEquals(judgeCalls[0]?.skills, ["pptx"], "pipeline bestOf judge uses judgeSkills");
}

async function testPipelineWithVerifySkills(): Promise<void> {
  console.log("\n[20] Pipeline: Map step with verify skills");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const pipeline = new Pipeline(swarm)
    .map({
      prompt: "Process",
      skills: ["docx"],
      verify: {
        criteria: "Valid",
        maxAttempts: 1,
        verifierSkills: ["dev-browser"],
      },
    });

  const items: FileMap[] = [{ "a.txt": "a" }];
  await pipeline.run(items);

  const workerCalls = tracker.calls.filter((c) => c.role === "worker");
  const verifierCalls = tracker.calls.filter((c) => c.role === "verifier");

  assertArrayEquals(workerCalls[0]?.skills, ["docx"], "pipeline verify worker uses step skills");
  assertArrayEquals(verifierCalls[0]?.skills, ["dev-browser"], "pipeline verify verifier uses verifierSkills");
}

// =============================================================================
// TEST: EMPTY SKILLS ARRAY
// =============================================================================

async function testEmptySkillsArray(): Promise<void> {
  console.log("\n[21] Empty skills array: Passed through (not treated as undefined)");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const items: FileMap[] = [{ "a.txt": "a" }];

  await swarm.map({ items, prompt: "Process", skills: [] }); // Empty array override

  // Empty array should override swarm default (not fall back)
  assertArrayEquals(tracker.calls[0]?.skills, [], "empty array passed through (overrides default)");
}

// =============================================================================
// TEST: SKILLS WITH ALL OPERATIONS TOGETHER
// =============================================================================

async function testAllOperationsWithSkills(): Promise<void> {
  console.log("\n[22] All operations: Skills work consistently across map/filter/reduce");

  const { swarm, tracker } = createMockSwarm(["pdf"]);
  const items: FileMap[] = [{ "a.txt": "a" }];
  const schema = z.object({ score: z.number() });

  // Run all operations with different skills
  await swarm.map({ items, prompt: "Map", skills: ["xlsx"] });
  await swarm.filter({ items, prompt: "Filter", schema, condition: () => true, skills: ["docx"] });
  await swarm.reduce({ items, prompt: "Reduce", skills: ["pptx"] });

  assertArrayEquals(tracker.calls[0]?.skills, ["xlsx"], "map uses xlsx");
  assertArrayEquals(tracker.calls[1]?.skills, ["docx"], "filter uses docx");
  assertArrayEquals(tracker.calls[2]?.skills, ["pptx"], "reduce uses pptx");
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Skills Integration Tests");
  console.log("=".repeat(70));

  // Evolve tests
  await testEvolveWithSkills();
  await testEvolveWithSkillsChaining();

  // Swarm default skills
  await testSwarmDefaultSkills();
  await testSwarmNoDefaultSkills();

  // Per-operation override
  await testMapSkillsOverride();
  await testFilterSkillsOverride();
  await testReduceSkillsOverride();

  // BestOf skills resolution
  await testBestOfCandidateSkills();
  await testBestOfCandidateSkillsFallback();
  await testBestOfJudgeSkills();
  await testBestOfJudgeSkillsFallback();

  // Map with bestOf
  await testMapWithBestOfSkills();
  await testMapWithBestOfSkillsFallback();

  // Verify skills
  await testVerifyVerifierSkills();
  await testVerifyVerifierSkillsFallback();

  // Pipeline
  await testPipelineStepSkills();
  await testPipelineStepSkillsFallback();
  await testPipelineMultiStepDifferentSkills();
  await testPipelineWithBestOfSkills();
  await testPipelineWithVerifySkills();

  // Edge cases
  await testEmptySkillsArray();
  await testAllOperationsWithSkills();

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
