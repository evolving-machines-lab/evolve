#!/usr/bin/env tsx
/**
 * E2E Cost API Test — Tags-based per-run spend tracking
 *
 * Runs 2 parallel Evolve instances, each doing 2 successive runs (haiku),
 * waits for LiteLLM batch write, then verifies:
 * - getSessionCost() returns correct number of runs per session
 * - getRunCost({ index }) returns correct run data
 * - getRunCost({ runId }) matches the original runId
 * - runs are correctly grouped (not split by random session_id)
 *
 * Requires: .env loaded, dashboard running on localhost:3000
 */

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../../../../.env") });
process.env.EVOLVE_DASHBOARD_URL = "http://localhost:3000";

const { Evolve } = await import("../../dist/index.js");
const { createE2BProvider } = await import("../../../e2b/src/index.js");

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

async function runInstance(label: string): Promise<{
  evolve: InstanceType<typeof Evolve>;
  run1Id: string;
  run2Id: string;
  sessionTag: string;
}> {
  console.log(`\n[${label}] Creating Evolve instance (haiku)...`);
  const evolve = new Evolve()
    .withAgent({ type: "claude", apiKey: process.env.EVOLVE_API_KEY!, model: "haiku" })
    .withSandbox(createE2BProvider());

  console.log(`[${label}] Run 1 — create two text files...`);
  const r1 = await evolve.run({
    prompt: "Create two files: /tmp/hello.txt containing 'hello' and /tmp/world.txt containing 'world'. Do not explain, just create them.",
  });
  const run1Id = r1.runId!;
  console.log(`  run1Id: ${run1Id}`);
  console.log(`  output: ${(r1.stdout || "").slice(0, 80)}`);

  console.log(`[${label}] Run 2 — create a summary file...`);
  const r2 = await evolve.run({
    prompt: "Create /tmp/summary.txt containing 'test complete'. Do not explain, just create it.",
  });
  const run2Id = r2.runId!;
  console.log(`  run2Id: ${run2Id}`);
  console.log(`  output: ${(r2.stdout || "").slice(0, 80)}`);

  const sessionTag = evolve.getSessionTag()!;
  console.log(`  sessionTag: ${sessionTag}`);

  return { evolve, run1Id, run2Id, sessionTag };
}

async function main() {
  console.log("\n============================================================");
  console.log("E2E Cost API Test — 2 instances × 2 runs (haiku)");
  console.log("============================================================");

  const apiKey = process.env.EVOLVE_API_KEY;
  if (!apiKey) {
    console.error("EVOLVE_API_KEY not set");
    process.exit(1);
  }
  console.log(`EVOLVE_API_KEY: ${apiKey.slice(0, 8)}...`);
  console.log(`EVOLVE_DASHBOARD_URL: ${process.env.EVOLVE_DASHBOARD_URL}`);

  // --- Step 1: Run 2 instances in parallel, 2 runs each ---
  console.log("\n[1] Running 2 parallel instances...");
  const [a, b] = await Promise.all([
    runInstance("A"),
    runInstance("B"),
  ]);

  // --- Step 2: Wait for LiteLLM batch write (60s interval + buffer) ---
  console.log("\n[2] Waiting 75s for LiteLLM batch write...");
  await new Promise((resolve) => setTimeout(resolve, 75_000));

  // --- Step 3: Verify instance A ---
  console.log("\n[3] Instance A — session cost...");
  const aCost = await a.evolve.getSessionCost();
  console.log(`  totalCost: $${aCost.totalCost}`);
  console.log(`  runs: ${aCost.runs.length}`);
  for (const run of aCost.runs) {
    console.log(`    run[${run.index}]: $${run.cost} | ${run.model} | ${run.requests} reqs | runId=${run.runId}`);
  }

  assert(aCost.runs.length === 2, `A: has 2 runs (got ${aCost.runs.length})`);
  assert(aCost.totalCost > 0, `A: totalCost > 0 ($${aCost.totalCost})`);
  const aSumOfRuns = Math.round(aCost.runs.reduce((s, r) => s + r.cost, 0) * 1e6) / 1e6;
  assert(aCost.totalCost === aSumOfRuns, `A: totalCost ($${aCost.totalCost}) === sum of runs ($${aSumOfRuns})`);

  // Verify run1 by runId
  console.log("\n  A: getRunCost({ runId: run1Id })...");
  try {
    const aRun1 = await a.evolve.getRunCost({ runId: a.run1Id });
    assert(aRun1.runId === a.run1Id, `A run1: runId matches (${aRun1.runId})`);
    assert(aRun1.cost > 0, `A run1: cost > 0 ($${aRun1.cost})`);
    assert(aRun1.requests >= 1, `A run1: requests >= 1 (${aRun1.requests})`);
  } catch (err: any) {
    failed++;
    console.log(`  ✗ A run1 by runId failed: ${err.message}`);
  }

  // Verify run2 by index
  console.log("  A: getRunCost({ index: 2 })...");
  try {
    const aRun2 = await a.evolve.getRunCost({ index: 2 });
    assert(aRun2.runId === a.run2Id, `A run2: runId matches via index (${aRun2.runId})`);
    assert(aRun2.cost > 0, `A run2: cost > 0 ($${aRun2.cost})`);
  } catch (err: any) {
    failed++;
    console.log(`  ✗ A run2 by index failed: ${err.message}`);
  }

  // Verify negative index
  console.log("  A: getRunCost({ index: -1 })...");
  try {
    const aLast = await a.evolve.getRunCost({ index: -1 });
    assert(aLast.runId === a.run2Id, `A: last run (-1) is run2 (${aLast.runId})`);
  } catch (err: any) {
    failed++;
    console.log(`  ✗ A last run by index -1 failed: ${err.message}`);
  }

  // --- Step 4: Verify instance B ---
  console.log("\n[4] Instance B — session cost...");
  const bCost = await b.evolve.getSessionCost();
  console.log(`  totalCost: $${bCost.totalCost}`);
  console.log(`  runs: ${bCost.runs.length}`);
  for (const run of bCost.runs) {
    console.log(`    run[${run.index}]: $${run.cost} | ${run.model} | ${run.requests} reqs | runId=${run.runId}`);
  }

  assert(bCost.runs.length === 2, `B: has 2 runs (got ${bCost.runs.length})`);
  assert(bCost.totalCost > 0, `B: totalCost > 0 ($${bCost.totalCost})`);
  const bSumOfRuns = Math.round(bCost.runs.reduce((s, r) => s + r.cost, 0) * 1e6) / 1e6;
  assert(bCost.totalCost === bSumOfRuns, `B: totalCost ($${bCost.totalCost}) === sum of runs ($${bSumOfRuns})`);
  assert(bCost.sessionTag !== aCost.sessionTag, `A and B have different sessions`);

  // Verify B run1 by runId
  console.log("\n  B: getRunCost({ runId: run1Id })...");
  try {
    const bRun1 = await b.evolve.getRunCost({ runId: b.run1Id });
    assert(bRun1.runId === b.run1Id, `B run1: runId matches (${bRun1.runId})`);
  } catch (err: any) {
    failed++;
    console.log(`  ✗ B run1 by runId failed: ${err.message}`);
  }

  // --- Step 5: Kill and verify previousSessionTag fallback ---
  console.log("\n[5] Kill A and re-query (previousSessionTag fallback)...");
  await a.evolve.kill();
  const aPostKill = await a.evolve.getSessionCost();
  assert(
    aPostKill.sessionTag === aCost.sessionTag,
    `A: post-kill still queries same session (${aPostKill.sessionTag})`
  );
  assert(aPostKill.runs.length === 2, `A: post-kill still has 2 runs`);

  // Cleanup
  try { await b.evolve.kill(); } catch {}

  // --- Results ---
  console.log("\n============================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("============================================================\n");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
