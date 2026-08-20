#!/usr/bin/env tsx
/**
 * Unit Test: the client-side Harbor trial-tree assembly (hosted/trial-tree.ts)
 * behind `evolve trial download` / `evolve job download`.
 *
 * What is held here:
 *   - the LAYOUT is Harbor's, file for file: config.json, result.json,
 *     agent/ (trajectory, raw logs, parsed events, sessions/), verifier/,
 *     exception.txt — and absent artifacts are absent files, never empty
 *     placeholders;
 *   - agent/sessions/ wears the home tree's VISIBLE names (the same
 *     re-keying the server archive and the agent-home tgz apply);
 *   - evolve.json carries the platform record Harbor has no slot for:
 *     gateway money/tokens per lane, provider, user_id, regrade lineage;
 *   - the assembly is deterministic — same parts, same bytes.
 *
 * Usage:
 *   npx tsx tests/unit/hosted-trial-tree.test.ts
 */

import {
  assembleTrialTree,
  jobEvolveRecord,
  trialEvolveRecord,
  visibleHomeTree,
  type TrialTreeParts,
} from "../../src/hosted/trial-tree";
import type { Job, Trial } from "../../src/hosted/types";

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

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (!match) {
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
  assert(match, message);
}

function fixtureTrial(overrides: Partial<Trial> = {}): Trial {
  return {
    id: "run-1",
    job_id: "job-1",
    task_name: "fix-bug",
    source: "deep-swe",
    agent_info: {
      name: "codex",
      version: "1.0.0",
      model_info: { name: "gpt-test", provider: null },
      reasoning_effort: "high",
    },
    attempt: 1,
    status: "SCORED",
    reward: 1,
    verifier_result: { rewards: { reward: 1, tests: 0.5 } },
    exception_info: null,
    agent_result: {
      n_input_tokens: 100,
      n_cache_tokens: 10,
      n_output_tokens: 50,
      cost_usd: 0.75,
      rollout_details: null,
      metadata: null,
    },
    judge_result: {
      n_input_tokens: 5,
      n_cache_tokens: 0,
      n_output_tokens: 2,
      cost_usd: 0.01,
    },
    environment_setup: null,
    agent_setup: null,
    agent_execution: { started_at: "2026-08-01T00:00:00.000Z", finished_at: "2026-08-01T00:10:00.000Z" },
    verifier: null,
    step_results: null,
    spend_source: "measured",
    judge_spend_source: "measured",
    live_spent_usd: null,
    live_spend_at: null,
    max_trial_spend_usd: 200,
    sandbox_provider: "modal",
    sandbox_id: "sbx-1",
    verifier_sandbox_id: null,
    verifier_environment_mode: "shared",
    attempt_phase: null,
    n_retries: 1,
    retries: [
      {
        attempt_number: 1,
        exception_info: {
          exception_type: "InfrastructureError",
          exception_message: "sandbox died",
          exception_traceback: "",
          occurred_at: "2026-08-01T00:01:00.000Z",
        },
        cost_usd: 0.1,
        started_at: "2026-08-01T00:00:30.000Z",
        settled_at: "2026-08-01T00:01:00.000Z",
      },
    ],
    session_ref: null,
    started_at: "2026-08-01T00:00:00.000Z",
    finished_at: "2026-08-01T00:12:00.000Z",
    ...overrides,
  } as Trial;
}

function fixtureJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    job_name: "sweep",
    status: "COMPLETED",
    datasets: [{ name: "deep-swe", version: "1.1" }],
    agents: [],
    n_attempts: 1,
    n_concurrent_trials: 4,
    max_trial_spend_usd: 200,
    worst_case_spend_usd: 600,
    sandbox_provider: "modal",
    counts: { agents: 1, tasks: 1 },
    n_total_trials: 1,
    trials: { total: 1, byStatus: {} },
    stats: {
      cost_usd: 0.75,
      judge_cost_usd: 0.01,
      n_input_tokens: 100,
      n_cache_tokens: 10,
      n_output_tokens: 50,
    },
    failure: null,
    source_jobs: [{ action: "regrade", type: "hub", job_id: "job-0" }],
    is_regrade: true,
    idempotent_replay: false,
    started_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:12:00.000Z",
    finished_at: "2026-08-01T00:12:00.000Z",
    ...overrides,
  } as unknown as Job;
}

function fullParts(overrides: Partial<TrialTreeParts> = {}): TrialTreeParts {
  return {
    trial: fixtureTrial(),
    job: fixtureJob(),
    events: [
      { seq: 0, type: "agent.message", data: { text: "hi" } },
      { seq: 1, type: "phase.completed", data: { phase: "agent" } },
    ],
    atif: '{"schema_version":"ATIF-v1.7"}',
    verifierLog: "PASS all checks\n",
    stdout: "raw stdout\n",
    stderr: "raw stderr\n",
    home: { "/root/.codex/sessions/rollout.jsonl": "{}" },
    userId: "user-1",
    ...overrides,
  };
}

console.log("\n=== Harbor trial-tree assembly ===\n");

// -----------------------------------------------------------------------------
// The full tree
// -----------------------------------------------------------------------------
{
  const files = assembleTrialTree(fullParts());
  assertEqual(
    Object.keys(files).sort(),
    [
      "agent/stderr.log",
      "agent/stdout.log",
      "agent/trace-parsed.jsonl",
      "agent/trajectory.json",
      "agent/sessions/codex/sessions/rollout.jsonl",
      "config.json",
      "evolve.json",
      "result.json",
      "verifier/reward.json",
      "verifier/test-stdout.txt",
    ].sort(),
    "a fully-stored trial materializes Harbor's whole tree"
  );

  const config = JSON.parse(files["config.json"]);
  assertEqual(config.task, { name: "fix-bug", source: "deep-swe" }, "config.json states the task identity");
  assertEqual(
    config.agent,
    { name: "codex", version: "1.0.0", model_name: "gpt-test", reasoning_effort: "high" },
    "config.json states the agent identity"
  );

  const result = JSON.parse(files["result.json"]);
  assertEqual(result.status, "SCORED", "result.json carries the status");
  assertEqual(result.reward, 1, "result.json carries the reward");
  assertEqual(result.agent_result.cost_usd, 0.75, "result.json carries agent_result");

  assertEqual(files["agent/trajectory.json"], '{"schema_version":"ATIF-v1.7"}', "the ATIF document is agent/trajectory.json, byte-verbatim");
  assertEqual(files["verifier/test-stdout.txt"], "PASS all checks\n", "the verifier log is verifier/test-stdout.txt, byte-verbatim");
  assertEqual(JSON.parse(files["verifier/reward.json"]), { reward: 1, tests: 0.5 }, "verifier/reward.json is the rewards map");
  assert(
    files["agent/trace-parsed.jsonl"] === '{"seq":0,"type":"agent.message","data":{"text":"hi"}}\n{"seq":1,"type":"phase.completed","data":{"phase":"agent"}}\n',
    "the parsed events serialize one per line"
  );

  const evolve = JSON.parse(files["evolve.json"]);
  assertEqual(evolve.trial_id, "run-1", "evolve.json names the trial");
  assertEqual(evolve.user_id, "user-1", "evolve.json names the downloading user");
  assertEqual(evolve.provider, "modal", "evolve.json names the provider");
  assertEqual(evolve.gateway.cost_usd, 0.75, "evolve.json carries the gateway cost");
  assertEqual(evolve.gateway.spend_source, "measured", "evolve.json names the spend lane");
  assertEqual(evolve.gateway.judge.cost_usd, 0.01, "the judge meter is itemized apart");
  assertEqual(evolve.regrade_lineage.is_regrade, true, "the regrade lineage rides the job's word");
  assertEqual(evolve.regrade_lineage.source_jobs[0].job_id, "job-0", "the lineage names the source job");
  assertEqual(evolve.regrade_lineage.n_retries, 1, "the auto-retry lineage rides along");
}

// -----------------------------------------------------------------------------
// The money law of Harbor's result.json: a figure only when one was measured
// -----------------------------------------------------------------------------
{
  // The API serves cost_usd and spend_source as a pair. evolve.json keeps both
  // halves; Harbor's result.json has no slot for the lane, so an unmeasured
  // number there would read as "this trial cost $0.00" to the one reader who
  // cannot see the qualifier. Production 2026-08-20, trial 4f103397: settled
  // at assumed_cap with cost 0, measured $0.057 by the platform minutes later.
  for (const lane of ["assumed_cap", "measured_provisional"] as const) {
    const files = assembleTrialTree(
      fullParts({
        trial: fixtureTrial({
          spend_source: lane,
          agent_result: {
            n_input_tokens: 18219,
            n_cache_tokens: 9014,
            n_output_tokens: 166,
            cost_usd: 0,
            rollout_details: null,
            metadata: null,
          },
        }),
      })
    );
    const result = JSON.parse(files["result.json"]);
    assertEqual(result.agent_result.cost_usd, null, `${lane}: result.json states no cost figure`);
    assertEqual(
      result.agent_result.n_input_tokens,
      18219,
      `${lane}: the tokens are still stated — they were counted`
    );

    // The platform record keeps the number AND the lane that qualifies it.
    const evolve = JSON.parse(files["evolve.json"]);
    assertEqual(evolve.gateway.cost_usd, 0, `${lane}: evolve.json keeps the raw figure`);
    assertEqual(evolve.gateway.spend_source, lane, `${lane}: beside the lane that qualifies it`);
  }

  // A measured trial is untouched — the whole point is that only the
  // unmeasured lanes lose the figure.
  const measured = JSON.parse(
    assembleTrialTree(fullParts())["result.json"]
  );
  assertEqual(measured.agent_result.cost_usd, 0.75, "a measured trial still states its cost");

  // THE UNEVIDENCED MEASURED ZERO. A 'measured' $0 whose token columns are all
  // null is not an authoritative figure: money and tokens come from the same
  // gateway read, so a real measured zero carries its token trace. Reachable
  // today — a pre-run infrastructure failure settles that way with no key ever
  // minted. The platform's own writer refuses it; this side must too, or the
  // same trial reads $0.00 downloaded alone and unstated inside a job archive.
  const unevidenced = JSON.parse(
    assembleTrialTree(
      fullParts({
        trial: fixtureTrial({
          spend_source: "measured",
          agent_result: {
            n_input_tokens: null,
            n_cache_tokens: null,
            n_output_tokens: null,
            cost_usd: 0,
            rollout_details: null,
            metadata: null,
          },
        }),
      })
    )["result.json"]
  );
  assertEqual(
    unevidenced.agent_result.cost_usd,
    null,
    "a 'measured' $0 with no token evidence states no figure"
  );

  // ...and a measured zero that DOES carry its token trace is a real reading,
  // which must survive. Refusing it would be the opposite lie.
  const provenZero = JSON.parse(
    assembleTrialTree(
      fullParts({
        trial: fixtureTrial({
          spend_source: "measured",
          agent_result: {
            n_input_tokens: 12,
            n_cache_tokens: 0,
            n_output_tokens: 0,
            cost_usd: 0,
            rollout_details: null,
            metadata: null,
          },
        }),
      })
    )["result.json"]
  );
  assertEqual(provenZero.agent_result.cost_usd, 0, "an evidenced measured zero is still a figure");
}

// -----------------------------------------------------------------------------
// Absence law: absent artifacts are absent files
// -----------------------------------------------------------------------------
{
  const files = assembleTrialTree(
    fullParts({
      atif: null,
      verifierLog: null,
      stdout: null,
      stderr: null,
      home: null,
      events: [],
      trial: fixtureTrial({ verifier_result: null, judge_result: null }),
    })
  );
  assertEqual(
    Object.keys(files).sort(),
    ["config.json", "evolve.json", "result.json"],
    "a bare trial is exactly the three record files — no empty placeholders"
  );
  const evolve = JSON.parse(files["evolve.json"]);
  assertEqual(evolve.gateway.judge, null, "no judge ever ran reads as null, never $0");
}

// -----------------------------------------------------------------------------
// Exception + missing job + missing user id
// -----------------------------------------------------------------------------
{
  const files = assembleTrialTree(
    fullParts({
      job: null,
      userId: null,
      trial: fixtureTrial({
        status: "INFRASTRUCTURE_ERROR",
        reward: null,
        verifier_result: null,
        exception_info: {
          exception_type: "InfrastructureError",
          exception_message: "sandbox died during agent phase",
          exception_traceback: "",
          occurred_at: "2026-08-01T00:05:00.000Z",
        },
      }),
    })
  );
  assertEqual(
    files["exception.txt"],
    "InfrastructureError: sandbox died during agent phase\n",
    "an exception materializes exception.txt"
  );
  const evolve = JSON.parse(files["evolve.json"]);
  assertEqual(evolve.user_id, null, "an unknown user id is null, honestly");
  assertEqual(evolve.regrade_lineage.is_regrade, false, "no reachable job reads as original lineage");
  assertEqual(evolve.regrade_lineage.source_jobs, [], "no reachable job reads as empty lineage");
}

// -----------------------------------------------------------------------------
// Determinism
// -----------------------------------------------------------------------------
{
  const first = assembleTrialTree(fullParts());
  const second = assembleTrialTree(fullParts());
  assertEqual(first, second, "same parts, same bytes — re-downloads diff clean");
}

// -----------------------------------------------------------------------------
// The visible home mapping — the server's exact rule
// -----------------------------------------------------------------------------
{
  assertEqual(
    visibleHomeTree({ "/root/.kimi-code/config.toml": "x" }),
    { "kimi-code/config.toml": "x" },
    "/root/.name strips to name/"
  );
  assertEqual(
    visibleHomeTree({ "/home/user/.codex/s.jsonl": "y" }),
    { "codex/s.jsonl": "y" },
    "/home/<user>/.name strips to name/"
  );
  const collided = visibleHomeTree({ "/root/.codex/a": "1", "/.codex/a": "2" });
  assertEqual(Object.keys(collided).sort(), [".codex/a", "codex/a"], "a colliding mapped path keeps its original");
}

// -----------------------------------------------------------------------------
// The job-level evolve record
// -----------------------------------------------------------------------------
{
  const record = jobEvolveRecord(fixtureJob(), "user-1");
  assertEqual(record.job_id, "job-1", "names the job");
  assertEqual((record.gateway as Record<string, unknown>).judge_cost_usd, 0.01, "itemizes the judge share");
  assertEqual(
    (record.regrade_lineage as Record<string, unknown>).is_regrade,
    true,
    "carries the regrade lineage"
  );
}

// -----------------------------------------------------------------------------
// The trial record builder alone (what job download writes per trial dir)
// -----------------------------------------------------------------------------
{
  const record = trialEvolveRecord(fixtureTrial(), fixtureJob(), "user-1");
  assertEqual(record.trial_id, "run-1", "names the trial");
  assertEqual(record.provider, "modal", "names the provider");
  assertEqual(
    (record.gateway as Record<string, unknown>).max_trial_spend_usd,
    200,
    "carries the minted cap"
  );
}

console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
