#!/usr/bin/env tsx
/**
 * Unit Test: the client-side Harbor trial-tree assembly (hosted/trial-tree.ts)
 * behind `evolve trial download` / `evolve job download`.
 *
 * What is held here:
 *   - the LAYOUT is Harbor's, file for file: config.json, result.json,
 *     agent/ (trajectory, raw logs, parsed events, the home at its real
 *     names, Harbor's copies), verifier/,
 *     exception.txt — and absent artifacts are absent files, never empty
 *     placeholders;
 *   - the stdout stream sits at Harbor's tee name for the harness; the
 *     captured home lands at its real names by the server's ONE rule
 *     (homeRelativePath, mirrored) with Harbor's own copies beside it by the
 *     server's small table (HARNESS_TRIAL_LAYOUTS, mirrored and pinned);
 *   - evolve.json carries the platform record Harbor has no slot for:
 *     gateway money/tokens per lane, provider, user_id, regrade lineage;
 *   - the assembly is deterministic — same parts, same bytes.
 *
 * Usage:
 *   npx tsx tests/unit/hosted-trial-tree.test.ts
 */

import {
  AGENT_HOME_MANIFEST_FILENAME,
  assembleAnalysisTree,
  assembleTaskCheckTree,
  assembleTrialTree,
  DEFAULT_HARNESS_TRIAL_LAYOUT,
  HARNESS_TRIAL_LAYOUTS,
  harnessTrialLayout,
  harborCopyPath,
  homeRelativePath,
  jobEvolveRecord,
  placeHomeObject,
  trialEvolveRecord,
  type AnalysisTreeParts,
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
      "agent/.codex/sessions/rollout.jsonl",
      "agent/stderr.log",
      "agent/codex.txt",
      "agent/trace-parsed.jsonl",
      "agent/trajectory.json",
      "agent/sessions/rollout.jsonl",
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
// The per-harness table: opencode's store at Harbor's XDG slot (opencode.py:524)
// -----------------------------------------------------------------------------
{
  const files = assembleTrialTree(
    fullParts({
      trial: fixtureTrial({ agent_info: { ...fixtureTrial().agent_info, name: "opencode" } }),
      home: {
        "/root/.local/share/opencode/log/opencode.log": "log",
        "/root/.local/state/opencode/x": "state",
      },
    })
  );
  assertEqual(
    Object.keys(files).filter((p) => p.startsWith("agent/")).sort(),
    [
      "agent/.local/share/opencode/log/opencode.log",
      "agent/.local/state/opencode/x",
      "agent/opencode.txt",
      "agent/opencode/xdg-data/opencode/log/opencode.log",
      "agent/stderr.log",
      "agent/trace-parsed.jsonl",
      "agent/trajectory.json",
    ],
    "opencode: the tee is opencode.txt, the home at its real names, and the data store a second time at agent/opencode/xdg-data/opencode/ (Harbor's copy)"
  );
}

// -----------------------------------------------------------------------------
// The ONE placement rule — the server's harbor-output-tree.ts homeRelativePath,
// mirrored: the record at agent-home.json, the home at its real names, the
// pre-2026-09-09 upload keys under sessions/, the mount rule verbatim
// -----------------------------------------------------------------------------
{
  const manifestKey = `/${AGENT_HOME_MANIFEST_FILENAME}`;
  assertEqual(homeRelativePath(manifestKey), "agent-home.json", "the capture record lands at agent/agent-home.json (rule 2)");
  assertEqual(homeRelativePath("/root/.claude/projects/-app/s.jsonl"), ".claude/projects/-app/s.jsonl", "a /root home file keeps its real name (rule 3)");
  assertEqual(homeRelativePath("/home/user/.codex/s.jsonl"), ".codex/s.jsonl", "a /home/<user> home file keeps its real name (rule 3)");
  assertEqual(homeRelativePath("/root/.claude.json"), ".claude.json", "a dot-file at the home root keeps its real name (rule 3)");
  assertEqual(homeRelativePath("/logs/agent/sessions/x.jsonl"), "sessions/x.jsonl", "an uploaded archive's mount key is verbatim (rule 1)");
  assertEqual(homeRelativePath("/projects/-app/s.jsonl"), "sessions/projects/-app/s.jsonl", "a pre-2026-09-09 upload key rides sessions/ (rule 4)");
  const placed = new Set<string>();
  assertEqual(placeHomeObject(placed, manifestKey), "agent-home.json", "the record is placed first");
  assertEqual(placeHomeObject(placed, "/root/agent-home.json"), "root/agent-home.json", "a same-named file INSIDE a home falls back to its sandbox path (collision rule)");
  const suffixed = new Set<string>();
  placeHomeObject(suffixed, "/home/u/x");
  placeHomeObject(suffixed, "/home/u/root/x");
  assertEqual(placeHomeObject(suffixed, "/root/x"), "root/x.2", "a taken fallback takes a numbered suffix (x and root/x already placed)");
  const files = assembleTrialTree(
    fullParts({
      trial: fixtureTrial({ agent_info: { ...fixtureTrial().agent_info, name: "claude-code" } }),
      home: {
        [manifestKey]: '{"files":[]}',
        "/root/.claude/projects/-app/s.jsonl": "{}",
        "/root/.claude.json": "{}",
      },
    })
  );
  assertEqual(
    Object.keys(files).filter((p) => p.startsWith("agent/.") || p.startsWith("agent/agent-home") || p.startsWith("agent/sessions/")).sort(),
    ["agent/.claude.json", "agent/.claude/projects/-app/s.jsonl", "agent/agent-home.json", "agent/sessions/projects/-app/s.jsonl"],
    "evolve trial download writes the home at its real names with the record beside it, and Harbor's copy of the claude config dir at agent/sessions/"
  );
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
// Harbor's copies — the server's table (harness-registry.ts harborCopies), pinned
// -----------------------------------------------------------------------------
{
  const expected: Record<string, readonly { sandboxRoot: string; agentDir: string }[]> = {
    claude: [{ sandboxRoot: "/root/.claude", agentDir: "sessions" }],
    codex: [{ sandboxRoot: "/root/.codex/sessions", agentDir: "sessions" }],
    gemini: [],
    qwen: [{ sandboxRoot: "/root/.qwen/projects", agentDir: "qwen-sessions" }],
    kimi: [],
    opencode: [{ sandboxRoot: "/root/.local/share/opencode", agentDir: "opencode/xdg-data/opencode" }],
    droid: [],
  };
  assertEqual(Object.keys(HARNESS_TRIAL_LAYOUTS).sort(), Object.keys(expected).sort(), "the table names exactly the seven harnesses");
  for (const [id, copies] of Object.entries(expected)) {
    assertEqual(HARNESS_TRIAL_LAYOUTS[id].harborCopies, copies, `${id}: Harbor's copies mirror the server's table`);
  }
  assertEqual(harborCopyPath(harnessTrialLayout("claude-code"), "/root/.claude/x"), "sessions/x", "claude's config dir is copied to Harbor's sessions/");
  assertEqual(harborCopyPath(harnessTrialLayout("kimi"), "/root/.kimi-code/x"), null, "kimi has no Harbor copy: the home at .kimi-code/ is the whole record");
  assertEqual(harborCopyPath(DEFAULT_HARNESS_TRIAL_LAYOUT, "/root/.claude/x"), null, "the default layout copies nothing");
}

// -----------------------------------------------------------------------------
// Collisions across the rules and the copy-skip branch — the server's
// evaluations-harbor-output-tree.test.ts cases, mirrored, contents asserted
// -----------------------------------------------------------------------------
{
  const claude = (home: Record<string, string>) =>
    Object.keys(
      assembleTrialTree(fullParts({ trial: fixtureTrial({ agent_info: { ...fixtureTrial().agent_info, name: "claude-code" } }), home }))
    )
      .filter((p) => p.startsWith("agent/.") || p.startsWith("agent/root/") || p.startsWith("agent/sessions/"))
      .sort();
  assertEqual(
    claude({ "/root/sessions/x": "native", "/root/.claude/x": "cfg" }),
    ["agent/.claude/x", "agent/root/sessions/x", "agent/sessions/x"],
    "Harbor's copy of .claude/x takes sessions/x first (sandbox-path order), so the native /root/sessions/x falls back to root/sessions/x — no second write, no bytes dropped"
  );
  assertEqual(
    claude({ "/logs/agent/.claude/x": "mounted", "/root/.claude/x": "native" }),
    ["agent/.claude/x", "agent/root/.claude/x", "agent/sessions/x"],
    "an uploaded archive's mount key (rule 1) takes .claude/x, the native home file falls back to root/.claude/x, Harbor's copy of the native file still lands at sessions/x"
  );
  // The copy-skip branch itself: a key that sorts BEFORE /root/.claude/x already holds sessions/x,
  // so Harbor's copy of the config dir is NOT written a second time (the bytes stay the uploaded file's).
  const skipped = assembleTrialTree(
    fullParts({
      trial: fixtureTrial({ agent_info: { ...fixtureTrial().agent_info, name: "claude-code" } }),
      home: { "/logs/agent/sessions/x": "uploaded", "/root/.claude/x": "cfg" },
    })
  );
  assertEqual(skipped["agent/sessions/x"], "uploaded", "a slot already holding an object keeps it: Harbor's copy is skipped, never overwritten");
  assertEqual(skipped["agent/.claude/x"], "cfg", "the native home file still lands at its real name");
  assertEqual(
    Object.keys(skipped).filter((p) => p.startsWith("agent/.") || p.startsWith("agent/root/") || p.startsWith("agent/sessions/")).sort(),
    ["agent/.claude/x", "agent/sessions/x"],
    "no fallback path is written when nothing collides at the home path"
  );
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

// -----------------------------------------------------------------------------
// The analysis tree (evolve analysis download)
// -----------------------------------------------------------------------------
function fixtureAnalysisParts(): AnalysisTreeParts {
  return {
    analysis: {
      id: "an-1",
      status: "completed",
      model_name: "glm-5.3-flash",
      rubric: { criteria: [{ name: "reward_hacking", description: "d", guidance: "g" }] },
      summary: "The agent solved the task legitimately.",
      checks: { reward_hacking: { outcome: "pass", explanation: "no tampering" } },
      estimated_cost_usd: 0.0412,
      usage: {
        provisional: false,
        spent_usd: 0.0412,
        input_tokens: 1000,
        cached_input_tokens: 400,
        cache_write_tokens: 0,
        output_tokens: 200,
        as_of: "2026-08-30T22:24:22.619Z",
      },
      failure: null,
      created_at: "2026-08-30T21:50:09.010Z",
      finished_at: "2026-08-30T22:24:22.619Z",
    },
    transcript: {
      id: "an-1",
      analyzed_trial_id: "run-1",
      job_id: "job-1",
      task_name: "fix-bug",
      sandbox_provider: "daytona",
      sandbox_id: "box-9",
      model_name: "glm-5.3-flash",
      is_ended: true,
      total: 2,
      events: [
        { seq: 0, type: "unknown", data: { _prompt: { text: "analyze" } } },
        { seq: 1, type: "tool_call", data: { update: { sessionUpdate: "tool_call" } } },
      ],
    },
    stdout: "analyzer out",
    stderr: null,
    home: { "/root/.claude/session.jsonl": "{}" },
    userId: "user-1",
  };
}

{
  const files = assembleAnalysisTree(fixtureAnalysisParts());
  assertEqual(
    Object.keys(files).sort(),
    [
      "agent/.claude/session.jsonl",
      "agent/stdout.log",
      "agent/trace-parsed.jsonl",
      "analysis.json",
      "evolve.json",
    ],
    "the analysis tree: verdict at the run's root, analyzer streams in agent/ (the default layout), no trial-only files"
  );
  const verdict = JSON.parse(files["analysis.json"]) as Record<string, unknown>;
  assertEqual(verdict.id, "an-1", "analysis.json is the wire verdict document");
  assertEqual(
    (verdict.checks as Record<string, unknown>).reward_hacking,
    { outcome: "pass", explanation: "no tampering" },
    "checks ride verbatim");
  assert(!("agent/stderr.log" in files), "an absent artifact is an absent file");
  assertEqual(
    files["agent/trace-parsed.jsonl"],
    `${JSON.stringify({ seq: 0, type: "unknown", data: { _prompt: { text: "analyze" } } })}\n` +
      `${JSON.stringify({ seq: 1, type: "tool_call", data: { update: { sessionUpdate: "tool_call" } } })}\n`,
    "the parsed trace is one JSONL line per event, TraceEvent shape"
  );
  const record = JSON.parse(files["evolve.json"]) as Record<string, unknown>;
  assertEqual(record.analysis_id, "an-1", "evolve.json names the analysis");
  assertEqual(record.analyzed_trial_id, "run-1", "…and the analyzed trial");
  assertEqual(record.provider, "daytona", "…and the ANALYZER's own provider");
  assertEqual(
    record.gateway,
    { cost_usd: 0.0412, n_input_tokens: 1000, n_cache_tokens: 400, n_output_tokens: 200 },
    "the meter restates the verdict's one-home usage reading"
  );
  assertEqual(
    JSON.stringify(assembleAnalysisTree(fixtureAnalysisParts())),
    JSON.stringify(files),
    "deterministic — same parts, same bytes"
  );
}

// THE TASK CHECK TREE — the analysis tree's assembly (one builder, owner
// ruling 2026-09-09) with the checker's own verdict name: check-result.json
// (Harbor's checker.py:37 RESULT_FILENAME) at the root, the same agent/
// slots, an evolve.json carrying the check record and the dataset ref.
{
  const parts = {
    taskCheck: {
      id: "tc-1",
      check_id: "chk-1",
      task_name: "hello-world",
      status: "completed" as const,
      checks: { typos: { outcome: "pass" as const, explanation: "none" } },
      cost_usd: 0.004,
      attempts: 1,
      failure: null,
      created_at: "2026-09-09T10:00:00.000Z",
      finished_at: "2026-09-09T10:05:00.000Z",
    },
    transcript: {
      id: "tc-1",
      check_id: "chk-1",
      dataset: "harbor-examples@1.0",
      task_name: "hello-world",
      model_name: "glm-5.3-flash",
      sandbox_provider: "e2b",
      sandbox_id: "box-2",
      is_ended: true,
      total: 1,
      events: [{ seq: 0, type: "unknown", data: { _prompt: { text: "check" } } }],
    },
    stdout: "checker out",
    stderr: null,
    home: { "/root/.claude/session.jsonl": "{}" },
    userId: "user-1",
  };
  const files = assembleTaskCheckTree(parts);
  assertEqual(
    Object.keys(files).sort(),
    ["agent/.claude/session.jsonl", "agent/stdout.log", "agent/trace-parsed.jsonl", "check-result.json", "evolve.json"],
    "the task check tree: check-result.json at the run's root, the checker's streams in agent/, no trial-only files"
  );
  const verdict = JSON.parse(files["check-result.json"]) as Record<string, unknown>;
  assertEqual(verdict.id, "tc-1", "check-result.json is the wire TaskCheck");
  assertEqual((verdict.checks as Record<string, unknown>).typos, { outcome: "pass", explanation: "none" }, "checks ride verbatim");
  assert(!("agent/stderr.log" in files), "an absent artifact is an absent file");
  const record = JSON.parse(files["evolve.json"]) as Record<string, unknown>;
  assertEqual(record.task_check_id, "tc-1", "evolve.json names the task check");
  assertEqual(record.check_id, "chk-1", "…and the check record");
  assertEqual(record.dataset, "harbor-examples@1.0", "…and the dataset the task came from");
  assertEqual(record.provider, "e2b", "…and the CHECKER's own provider");
  assertEqual(record.gateway, { cost_usd: 0.004 }, "the meter restates the result's cost");
  assertEqual(JSON.stringify(assembleTaskCheckTree(parts)), JSON.stringify(files), "deterministic — same parts, same bytes");
}

console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
