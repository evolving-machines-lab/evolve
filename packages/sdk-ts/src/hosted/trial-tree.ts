/**
 * Client-side materialization of one trial as Harbor's trial tree — the pure
 * assembly behind `evolve trial download` (and the evolve.json builders
 * `evolve job download` enriches the server archive with).
 *
 * THE LAYOUT IS HARBOR'S, file for file — the same names the server's job
 * archive extracts to (spec downloadJob):
 *
 *   config.json               trial identity (task + agent), Harbor vocabulary
 *   result.json               the outcome (status, reward, verifier verdict,
 *                             exception, agent_result, phase clocks)
 *   agent/trajectory.json     the normalized ATIF trajectory, when stored
 *   agent/stdout.log          the harness process's raw streams, when stored
 *   agent/stderr.log
 *   agent/trace-parsed.jsonl  the parsed event trace (Evolve's own artifact,
 *                             riding inside agent/ — Harbor has no slot for
 *                             it and a Harbor reader ignores it)
 *   agent/sessions/…          the agent CLI's home folder in its VISIBLE
 *                             shape (`codex/…`, never `root/.codex/…`) — the
 *                             same re-keying the server archive and the
 *                             agent-home tgz wear
 *   verifier/test-stdout.txt  the stored verifier log, when stored
 *   verifier/reward.json      the rewards map, when the verifier produced one
 *   exception.txt             when the trial carries an exception
 *   evolve.json               the platform's own record: gateway cost/tokens
 *                             per lane, provider, user_id, regrade lineage
 *
 * Absent artifacts are absent files — never empty placeholders (Harbor's own
 * law). Everything here is pure data-in, files-out: fetching belongs to the
 * clients, writing to the caller, so the assembly is testable byte for byte.
 */
import type { Job, TraceEvent, Trial } from "./types";

/** Everything the assembly consumes — fetched by the caller via the clients. */
export interface TrialTreeParts {
  trial: Trial;
  /** The trial's job (regrade lineage + arm context); null when unreachable. */
  job: Job | null;
  /** The parsed event trace, drained whole. */
  events: TraceEvent[];
  /** trials().artifact(id, "trace-atif") */
  atif: string | null;
  /** trials().artifact(id, "verifier") */
  verifierLog: string | null;
  /** trials().artifact(id, "trace-stdout") / ("trace-stderr") */
  stdout: string | null;
  stderr: string | null;
  /** trials().artifact(id, "agent-home") — true sandbox paths. */
  home: Record<string, string> | null;
  /**
   * The caller's USER id (auth().status() user_id); null when unknown.
   * Written to evolve.json as `user_id` — never `org`, which the platform
   * reserves for real Organizations (team accounts).
   */
  userId: string | null;
}

/**
 * The agent-home tree in its VISIBLE shape — the identical mapping the
 * server's tgz and job archive apply (their lib/tar-gz.ts visibleHomeTree):
 * strip the `/root/` (or `/home/<user>/`) wrapper and the leading dot of the
 * first surviving segment, so `/root/.codex/x` reads `codex/x`. A mapped
 * path that would collide keeps its wrapper-stripped original instead.
 */
export function visibleHomeTree(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const clean = path.replace(/^\/+/, "");
    const segs = clean.split("/");
    if (segs.length > 1 && segs[0] === "root") segs.shift();
    else if (segs.length > 2 && segs[0] === "home") segs.splice(0, 2);
    if (segs[0].length > 1 && segs[0].startsWith(".")) segs[0] = segs[0].slice(1);
    const mapped = segs.join("/");
    if (mapped in out) out[clean] = content;
    else out[mapped] = content;
  }
  return out;
}

/** One JSON spelling for every record file: 2-space, trailing newline. */
function record(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * The trial's evolve.json — the platform record Harbor's vocabulary has no
 * slot for: the gateway meter per lane (agent and judge, with the spend
 * source naming how final each figure is), where the trial ran, which USER
 * downloaded it (`user_id` — the caller's identity, not an Organization),
 * and the regrade/retry lineage (the owning job's `source_jobs` plus the
 * trial's own auto-retry lineage).
 */
export function trialEvolveRecord(
  trial: Trial,
  job: Job | null,
  userId: string | null
): Record<string, unknown> {
  return {
    trial_id: trial.id,
    job_id: trial.job_id,
    user_id: userId,
    provider: trial.sandbox_provider,
    gateway: {
      cost_usd: trial.agent_result?.cost_usd ?? null,
      n_input_tokens: trial.agent_result?.n_input_tokens ?? null,
      n_cache_tokens: trial.agent_result?.n_cache_tokens ?? null,
      n_output_tokens: trial.agent_result?.n_output_tokens ?? null,
      spend_source: trial.spend_source,
      max_trial_spend_usd: trial.max_trial_spend_usd,
      judge: trial.judge_result
        ? {
            cost_usd: trial.judge_result.cost_usd,
            n_input_tokens: trial.judge_result.n_input_tokens,
            n_cache_tokens: trial.judge_result.n_cache_tokens,
            n_output_tokens: trial.judge_result.n_output_tokens,
            spend_source: trial.judge_spend_source ?? null,
          }
        : null,
    },
    regrade_lineage: {
      is_regrade: job?.is_regrade ?? false,
      source_jobs: job?.source_jobs ?? [],
      n_retries: trial.n_retries,
      retries: trial.retries,
    },
  };
}

/** The job-level evolve.json `evolve job download` writes beside config.json. */
export function jobEvolveRecord(job: Job, userId: string | null): Record<string, unknown> {
  return {
    job_id: job.id,
    user_id: userId,
    provider: job.sandbox_provider,
    gateway: {
      cost_usd: job.stats.cost_usd ?? null,
      judge_cost_usd: job.stats.judge_cost_usd ?? null,
      n_input_tokens: job.stats.n_input_tokens ?? null,
      n_cache_tokens: job.stats.n_cache_tokens ?? null,
      n_output_tokens: job.stats.n_output_tokens ?? null,
      max_trial_spend_usd: job.max_trial_spend_usd,
      worst_case_spend_usd: job.worst_case_spend_usd,
    },
    regrade_lineage: {
      is_regrade: job.is_regrade,
      source_jobs: job.source_jobs,
    },
  };
}

/**
 * Assemble the whole tree as {relative-path: content}. Deterministic: the
 * same parts produce the same bytes, so a re-download diffs clean.
 */
export function assembleTrialTree(parts: TrialTreeParts): Record<string, string> {
  const { trial } = parts;
  const files: Record<string, string> = {};

  files["config.json"] = record({
    trial_name: trial.id,
    task: { name: trial.task_name, source: trial.source },
    agent: {
      name: trial.agent_info.name,
      version: trial.agent_info.version,
      model_name: trial.agent_info.model_info.name,
      reasoning_effort: trial.agent_info.reasoning_effort,
    },
  });

  files["result.json"] = record({
    trial_name: trial.id,
    task_name: trial.task_name,
    status: trial.status,
    reward: trial.reward,
    verifier_result: trial.verifier_result,
    exception_info: trial.exception_info,
    agent_result: trial.agent_result,
    started_at: trial.started_at,
    finished_at: trial.finished_at,
    environment_setup: trial.environment_setup,
    agent_setup: trial.agent_setup,
    agent_execution: trial.agent_execution,
    verifier: trial.verifier,
  });

  if (parts.atif !== null) files["agent/trajectory.json"] = parts.atif;
  if (parts.stdout !== null) files["agent/stdout.log"] = parts.stdout;
  if (parts.stderr !== null) files["agent/stderr.log"] = parts.stderr;
  if (parts.events.length > 0) {
    files["agent/trace-parsed.jsonl"] =
      parts.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  }
  if (parts.home !== null) {
    const visible = visibleHomeTree(parts.home);
    for (const path of Object.keys(visible)) {
      files[`agent/sessions/${path}`] = visible[path];
    }
  }

  if (parts.verifierLog !== null) files["verifier/test-stdout.txt"] = parts.verifierLog;
  if (trial.verifier_result?.rewards) {
    files["verifier/reward.json"] = record(trial.verifier_result.rewards);
  }
  if (trial.exception_info) {
    files["exception.txt"] =
      `${trial.exception_info.exception_type}: ${trial.exception_info.exception_message}\n`;
  }

  files["evolve.json"] = record(trialEvolveRecord(trial, parts.job, parts.userId));
  return files;
}
