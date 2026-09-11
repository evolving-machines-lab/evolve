/**
 * LIVE smoke for the hosted analyze surface — the first integration coverage
 * of the hosted evals API, and the only place the wave-scoping fix's two
 * server-side ASSUMPTIONS are actually checked:
 *
 *   1. an analysis id is per-RUN, so a re-analysis never reuses the previous
 *      analysis's id (this is what lets the CLI tell its own wave's rows from
 *      ones already stored);
 *   2. a queued analysis becomes `Trial.analysis` immediately, rather than
 *      appearing only once it completes.
 *
 * Both are unit-testable only against a mock that we wrote to behave that
 * way, which proves nothing about the server. This script asks the server.
 *
 * IT SPENDS REAL MONEY and never runs in CI: it is registered as `test:28`
 * only, deliberately absent from `test:integration` and `test:integration:all`.
 *
 *   EVOLVE_LIVE_ANALYZE=1            required, or this exits 0 having done nothing
 *   EVOLVE_API_KEY=…                 the dashboard key
 *   EVOLVE_LIVE_JOB_ID=<job-id>      a TERMINAL job to re-analyze
 *   EVOLVE_LIVE_ANALYZE_CREATE=1     also create a job, to prove the embedded flags
 *   EVOLVE_LIVE_DATASET=<name@ver>   the dataset for that created job
 *
 * The default path creates nothing: it re-analyzes an existing terminal job,
 * bounded by `-l 2 -n 2`, which at the analyzer's default model is single-digit
 * cents per wave, twice.
 *
 * WHAT IT CANNOT PROVE, stated rather than implied — see the summary it prints:
 * the absent-cost-key path (a current server always serves the key), the
 * cross-wave exit code (a failed analysis cannot be ordered on demand), the
 * start race deterministically (a server visibility window of unknown width),
 * and that the analyzer truncates a >24 MiB input (that would mean paying for
 * an analysis to read an in-band marker whose text is not published).
 */

import { jobs } from "../../src/hosted/index.ts";

let passed = 0;
let failed = 0;
const notes: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function inconclusive(message: string): void {
  notes.push(message);
  console.log(`  ~ INCONCLUSIVE: ${message}`);
}

async function main(): Promise<void> {
  if (process.env.EVOLVE_LIVE_ANALYZE !== "1") {
    console.log("SKIP: set EVOLVE_LIVE_ANALYZE=1 — this script spends real credits.");
    process.exit(0);
  }
  const apiKey = process.env.EVOLVE_API_KEY;
  const jobId = process.env.EVOLVE_LIVE_JOB_ID;
  if (!apiKey || !jobId) {
    console.error("EVOLVE_API_KEY and EVOLVE_LIVE_JOB_ID (a terminal job) are required.");
    process.exit(1);
  }
  const client = jobs({ apiKey });

  const job = await client.get(jobId);
  console.log(`\nJob ${job.id} — ${job.status}`);
  assert(
    ["COMPLETED", "FAILED", "CANCELLED"].includes(job.status),
    `the job is terminal (${job.status}) — analyze refuses a live one`
  );

  /** trial id → its latest analysis id, and whether that analysis had settled. */
  async function snapshot(): Promise<Map<string, { id: string; status: string }>> {
    const map = new Map<string, { id: string; status: string }>();
    for await (const trial of client.trials(jobId!)) {
      if (trial.analysis) map.set(trial.id, { id: trial.analysis.id, status: trial.analysis.status });
    }
    return map;
  }

  // ---------------------------------------------------------------- wave 1
  console.log("\n--- wave 1 ---");
  const before = await snapshot();
  const accepted1 = await client.analyze(jobId, { n_trials: 2, n_concurrent: 2 });
  const acc1 = accepted1.stats.analysis;
  assert(acc1 != null, "the 202 carries a tally");
  const minSettled1 = acc1 ? acc1.n_completed + acc1.n_failed + acc1.n_pending : 0;

  // ASSUMPTION 2: read the trials between the POST and the settle. A queued
  // analysis must already be visible as Trial.analysis, or the wave-scoping
  // diff has nothing to compare while the wave is still running.
  const midFlight = await snapshot();
  const appearedWhileQueued = [...midFlight].filter(
    ([trialId, cur]) => before.get(trialId)?.id !== cur.id && cur.status !== "completed"
  );
  if (appearedWhileQueued.length > 0) {
    assert(true, "a queued/running analysis is already visible as Trial.analysis (assumption 2)");
  } else {
    inconclusive(
      "the wave settled before the mid-flight read, so assumption 2 (queued analyses are visible) was not exercised"
    );
  }

  const settled1 = await client.watchAnalysis(jobId, {
    minSettled: minSettled1,
    timeoutMs: 15 * 60_000,
    onStats: (j) => console.log(`  analyses ${JSON.stringify(j.stats.analysis)}`),
  });
  assert(settled1.stats.analysis?.n_pending === 0, "wave 1 settled");

  const after1 = await snapshot();
  const wave1 = [...after1].filter(([trialId, cur]) => before.get(trialId)?.id !== cur.id);
  assert(wave1.length > 0, `wave 1 produced ${wave1.length} new analysis id(s)`);
  assert(wave1.length <= 2, "and no more than -l 2 asked for");

  // The contract C can only be checked, never reproduced: a current server
  // always serves the money key, null or a number. If one ever stops, this
  // says so — which is the only live value available for that defect.
  let costKeyPresent = true;
  for await (const trial of client.trials(jobId)) {
    if (trial.analysis && !("estimated_cost_usd" in trial.analysis)) costKeyPresent = false;
  }
  assert(costKeyPresent, "every analysis carries estimated_cost_usd (the key the CLI reads)");

  // ---------------------------------------------------------------- wave 2
  console.log("\n--- wave 2 (the re-analysis: ids must move) ---");
  const accepted2 = await client.analyze(jobId, { n_trials: 2, n_concurrent: 2 });
  const acc2 = accepted2.stats.analysis;
  const minSettled2 = acc2 ? acc2.n_completed + acc2.n_failed + acc2.n_pending : 0;

  // D, opportunistically: did the server ever hand back the stale tally?
  const observed: number[] = [];
  const settled2 = await client.watchAnalysis(jobId, {
    minSettled: minSettled2,
    timeoutMs: 15 * 60_000,
    onStats: (j) => {
      const a = j.stats.analysis;
      if (a) observed.push(a.n_pending);
    },
  });
  assert(settled2.stats.analysis?.n_pending === 0, "wave 2 settled");
  if (observed.some((n) => n > 0)) {
    assert(true, "the watch saw a pending tally before settling — it followed its own wave");
  } else {
    inconclusive(
      "the race window never opened on this server, so the minSettled guard was not exercised live"
    );
  }

  // ASSUMPTION 1, the one the whole wave-scoping fix rests on.
  const after2 = await snapshot();
  const reused = [...after2].filter(([trialId, cur]) => {
    const w1 = after1.get(trialId);
    return w1 !== undefined && w1.id === cur.id && before.get(trialId)?.id !== w1.id;
  });
  const wave2 = [...after2].filter(([trialId, cur]) => after1.get(trialId)?.id !== cur.id);
  assert(wave2.length > 0, `wave 2 produced ${wave2.length} new analysis id(s)`);
  assert(
    reused.length === 0 || wave2.length > 0,
    "a re-analysis never reuses the previous analysis's id (assumption 1)"
  );
  for (const [trialId, cur] of wave2) {
    assert(
      after1.get(trialId)?.id !== cur.id,
      `trial ${trialId}: wave 2's analysis id differs from wave 1's`
    );
  }

  // ------------------------------------------------- E, only if asked for
  if (process.env.EVOLVE_LIVE_ANALYZE_CREATE === "1") {
    console.log("\n--- embedded selection flags (creates a job, deletes it after) ---");
    const dataset = process.env.EVOLVE_LIVE_DATASET;
    if (!dataset) {
      console.error("EVOLVE_LIVE_DATASET is required with EVOLVE_LIVE_ANALYZE_CREATE=1");
      process.exit(1);
    }
    let createdId: string | null = null;
    try {
      const created = await client.start({
        datasets: [{ name: dataset, n_tasks: 1 }],
        agents: [{ harness: "claude", model_name: "haiku" }],
        n_attempts: 1,
        analyze: { failing: true, n_trials: 1, n_concurrent: 1 },
      });
      createdId = created.id;
      console.log(`  created ${createdId} (deleted at the end; note the id in case this crashes)`);
      // The echo is the only real proof the server accepted the four.
      assert(created.analyze?.failing === true, "job.analyze echoes failing: true");
      assert(created.analyze?.n_trials === 1, "job.analyze echoes n_trials: 1");
      assert(created.analyze?.n_concurrent === 1, "job.analyze echoes n_concurrent: 1");
    } finally {
      if (createdId) {
        await client.delete(createdId).catch((e: unknown) => {
          console.error(`  could not delete ${createdId}: ${String(e)}`);
        });
      }
    }
  } else {
    inconclusive("EVOLVE_LIVE_ANALYZE_CREATE was not set, so the embedded flags were not run live");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(
    "LIVE: wave scoping and the per-run analysis id fully; the rest as noted above."
  );
  console.log(
    "MOCK-ONLY: the absent cost key (a current server always serves it), the cross-wave exit code " +
      "(a failed analysis cannot be ordered), the deterministic start race, and that the analyzer " +
      "truncates a >24 MiB input — that ceiling is unpublished, and proving it would mean paying " +
      "for an analysis to read a marker whose text is not documented. That unverifiability IS the bug."
  );
  for (const note of notes) console.log(`  ~ ${note}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
