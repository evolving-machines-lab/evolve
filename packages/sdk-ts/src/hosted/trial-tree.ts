/**
 * Client-side materialization of one trial as Harbor's trial tree — the pure
 * assembly behind `evolve trial download` (and the evolve.json builders
 * `evolve job download` enriches the server archive with).
 *
 * THE LAYOUT IS HARBOR'S, AND IT IS THE SERVER'S: every file below sits at
 * the same path the server's job archive puts it (spec downloadJob; the
 * server's one builder is swarm_dashboard lib/evaluations/trial-tree.ts,
 * its per-harness table lib/evaluations/worker/harness-registry.ts
 * `trialLayout`), so a reader written against one finds the other where it
 * expects it. The captured home is placed by ONE rule (homeRelativePath
 * below, the server's harbor-output-tree.ts homeRelativePath verbatim) and
 * Harbor's own copies of its subtrees by a small TABLE (HARNESS_TRIAL_LAYOUTS
 * below), mirrored from the server's registry with the same citations into
 * Harbor's own agent adapters — a change to one side is a change to both.
 *
 * IT IS NOT THE SAME FILE SET, and the difference is recorded rather than
 * implied. The server archive also writes, per trial, `lock.json` (the
 * resolved trial inputs), `trial.log` (the trial's phase log), `artifacts/`
 * with its always-present `manifest.json`, the raw `verifier/reward.txt`
 * (the exact bytes the grader wrote, when captured), and — on multi-step
 * trials — the per-step `steps/<name>/verifier/reward.json` files. None of
 * these is materialized here: the lock is built from dataset- and arm-side
 * records (the task's source digest, its declared timeouts, the skills that
 * mounted) that no trial route serves, the collected artifacts and the raw
 * reward bytes live under their own storage prefixes outside what this
 * assembly reads, and the log is the platform's own renderer. Materializing
 * them here would mean a second renderer that can drift from the server's,
 * so the single-trial tree states less rather than stating it differently.
 * A caller that needs the complete tree downloads the JOB.
 *
 * THE HOME IS THE TEXT VIEW, NOT THE BYTES. The server archive's agent/
 * home is the capture byte for byte (their lib/evaluations/trial-tree.ts
 * reads trace-storage readAgentHome); this assembly reads the `agent-home`
 * artifact, the utf8 TEXT VIEW of the same capture (spec
 * downloadTrialArtifacts): a file that is not UTF-8 text — opencode's SQLite
 * store, a cached image — is present in the archive and absent here, named
 * only in the capture record (`/agent-home.json`, AGENT_HOME_MANIFEST_FILENAME
 * below, placed by homeRelativePath at agent/agent-home.json); and a home over the server's whole-read ceiling is
 * refused 413 (`invalid_input`, param `format`) with no bytes door on this
 * side — the JOB archive carries it whole. Every file both trees carry sits
 * at the same path in both.
 *
 * The files:
 *
 *   config.json               trial identity (task + agent), Harbor vocabulary
 *   result.json               the outcome (status, reward, verifier verdict,
 *                             exception, agent_result, phase clocks)
 *   agent/trajectory.json     the normalized ATIF trajectory, when stored
 *   agent/<harness>.txt       the harness process's stdout stream at Harbor's
 *                             own tee name for the harness (claude-code.txt,
 *                             codex.txt, gemini-cli.txt, qwen-code.txt,
 *                             kimi-code.txt, opencode.txt; droid.txt is the
 *                             platform's own, and stdout.log serves a harness
 *                             Harbor has no name for), when stored
 *   agent/stderr.log          the harness process's stderr stream, when stored
 *   agent/trace-parsed.jsonl  the parsed event trace (Evolve's own artifact,
 *                             riding inside agent/ — Harbor has no slot for
 *                             it and a Harbor reader ignores it)
 *   agent/.claude/…           the captured agent home at its real names —
 *   agent/.claude.json        the path relative to the home directory
 *   agent/.codex/…            (homeRelativePath: `/root/.gemini/x` -> .gemini/x),
 *   agent/.kimi-code/…        as far as the text view carries it (above)
 *   agent/agent-home.json     the capture record, beside the home
 *   agent/sessions/…          Harbor's own copies of the subtrees its adapter
 *   agent/qwen-sessions/…     keeps (claude and codex: sessions/; qwen:
 *   agent/opencode/…          qwen-sessions/; opencode: opencode/xdg-data/
 *                             opencode/) — the same text a second time at
 *                             Harbor's slot (harborCopyPath)
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
import { trialAgentCost } from "./money";
import type {
  AnalysisTranscript,
  Job,
  TaskCheck,
  TaskCheckTranscript,
  TraceEvent,
  Trial,
  TrialAnalysis,
} from "./types";

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
 * Where ONE harness's files land under agent/ in a Harbor trial dir: the
 * stdout tee name Harbor's adapter for it uses, and which subtrees of the
 * captured sandbox home Harbor's own adapter keeps a copy of (first match
 * wins; the home itself always lands at homeRelativePath). The server's table, mirrored
 * (swarm_dashboard lib/evaluations/worker/harness-registry.ts trialLayout,
 * each row cited into Harbor's agents/installed/*.py).
 */
export interface HarnessTrialLayout {
  /** Harbor's tee file for the harness stdout stream, a name under agent/. */
  stdoutFile: string;
  /** Harbor's own copies of captured-home subtrees: sandbox dir -> dir under agent/. */
  harborCopies: readonly { sandboxRoot: string; agentDir: string }[];
}

/** A harness Harbor has no adapter for: stdout.log, no Harbor copy. */
export const DEFAULT_HARNESS_TRIAL_LAYOUT: HarnessTrialLayout = { stdoutFile: "stdout.log", harborCopies: [] };

/** The table, keyed by SDK harness id (the server's registry entries, mirrored). */
export const HARNESS_TRIAL_LAYOUTS: Record<string, HarnessTrialLayout> = {
  // claude_code.py:482 CLAUDE_CONFIG_DIR = agent/sessions; tee :1890.
  claude: { stdoutFile: "claude-code.txt", harborCopies: [{ sandboxRoot: "/root/.claude", agentDir: "sessions" }] },
  // codex.py:1458-1463 copies $CODEX_HOME/sessions to agent/sessions; tee :80.
  codex: { stdoutFile: "codex.txt", harborCopies: [{ sandboxRoot: "/root/.codex/sessions", agentDir: "sessions" }] },
  // gemini_cli.py:979-980 tee; its session files are the ACP runner's own — no slot.
  gemini: { stdoutFile: "gemini-cli.txt", harborCopies: [] },
  // qwen_code.py:627 copies ~/.qwen/projects to agent/qwen-sessions; tee :619.
  qwen: { stdoutFile: "qwen-code.txt", harborCopies: [{ sandboxRoot: "/root/.qwen/projects", agentDir: "qwen-sessions" }] },
  // kimi_cli.py writes trajectory.json only: no Harbor copy; the home lands at .kimi-code/ by the one rule. Tee :18.
  kimi: { stdoutFile: "kimi-code.txt", harborCopies: [] },
  // opencode.py:74 tee; :524 XDG_DATA_HOME = /logs/agent/opencode/xdg-data, and the
  // CLI keeps its store at $XDG_DATA_HOME/opencode — the captured default store
  // (~/.local/share/opencode, registry.ts) sits at that slot. The state twin
  // (:525 XDG_STATE_HOME) is not captured: no slot.
  opencode: {
    stdoutFile: "opencode.txt",
    harborCopies: [{ sandboxRoot: "/root/.local/share/opencode", agentDir: "opencode/xdg-data/opencode" }],
  },
  // No Harbor adapter: droid.txt follows their <harness>.txt pattern, recorded as ours.
  droid: { stdoutFile: "droid.txt", harborCopies: [] },
};

/**
 * Harbor's own names for the harnesses above (their models/agent/name.py) —
 * the `agent_info.name` a `harbor run` record carries.
 */
const HARBOR_AGENT_NAMES: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  "gemini-cli": "gemini",
  "qwen-coder": "qwen",
  "kimi-code": "kimi",
  opencode: "opencode",
};

/** The layout for a harness LABEL: an SDK id, Harbor's name for one, else the default. */
export function harnessTrialLayout(label: string): HarnessTrialLayout {
  const id = label in HARNESS_TRIAL_LAYOUTS ? label : HARBOR_AGENT_NAMES[label];
  return id === undefined ? DEFAULT_HARNESS_TRIAL_LAYOUT : HARNESS_TRIAL_LAYOUTS[id];
}

/** Harbor mounts the trial's agent dir at this path inside the box (models/trial/paths.py). */
const HARBOR_AGENT_MOUNT_DIR = "/logs/agent";

/**
 * The capture record's filename — the ONE name on this side (the server's
 * lib/evaluations/harbor-output-tree.ts AGENT_HOME_MANIFEST_FILENAME): the
 * agent-home map carries it at `/` + this, the map's one key that is no
 * sandbox path — every file's path, size and sha256, the files the text
 * view left out.
 */
export const AGENT_HOME_MANIFEST_FILENAME = "agent-home.json";

/**
 * The HOME-RELATIVE path of ONE captured home file (the agent-home
 * artifact: sandbox path -> text) — the server's ONE rule, verbatim
 * (swarm_dashboard lib/evaluations/harbor-output-tree.ts homeRelativePath;
 * no harness enters it). The trial tree writes it at agent/<this>:
 *
 *   1. Harbor's own mount: `/logs/agent/x` -> x — an uploaded archive's
 *      home, any slot, verbatim;
 *   2. the capture record (`/agent-home.json`, AGENT_HOME_MANIFEST_FILENAME)
 *      -> agent-home.json;
 *   3. a home wrapper (`/root/x`, `/home/<user>/x`) -> x: the path relative
 *      to the home directory, real names kept (`.claude/…`, `.claude.json`,
 *      `.kimi-code/…`, `.local/share/opencode/…`);
 *   4. anything else -> sessions/<path> (the key shape the platform's
 *      job-upload ingest wrote before 2026-09-09).
 */
export function homeRelativePath(sandboxPath: string): string {
  const mounted = pathUnder(HARBOR_AGENT_MOUNT_DIR, sandboxPath);
  if (mounted !== null) return mounted;
  const clean = sandboxPath.replace(/^\/+/, "");
  if (clean === AGENT_HOME_MANIFEST_FILENAME) return clean;
  const inHome = /^(?:root|home\/[^/]+)\/(.+)$/.exec(clean);
  if (inHome !== null) return inHome[1];
  return `sessions/${clean}`;
}

/** `<rest>` of `<root>/<rest>`, or null when the path is not under the root. */
function pathUnder(root: string, path: string): string | null {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/**
 * homeRelativePath for one folder being written, with the server's collision
 * rule (harbor-output-tree.ts placeHomeObject): `placed` holds every path
 * already written; a later key that lands on a taken path goes to its sandbox
 * path minus the leading slash, then to that path with a numbered suffix
 * (root/x.2, root/x.3, …) until free — no bytes dropped, one object per path.
 */
export function placeHomeObject(placed: Set<string>, sandboxPath: string): string {
  let path = homeRelativePath(sandboxPath);
  const fallback = sandboxPath.replace(/^\/+/, "");
  if (placed.has(path)) path = fallback;
  for (let n = 2; placed.has(path); n++) path = `${fallback}.${n}`;
  placed.add(path);
  return path;
}

/**
 * Harbor's own copy of ONE captured home file, by the harness's layout: the
 * agent-relative path of the second write (`/root/.claude/x` -> sessions/x
 * for claude; the first matching root wins), or null when Harbor's adapter
 * keeps no such slot for it (server: harbor-output-tree.ts harborCopyPath).
 */
export function harborCopyPath(layout: HarnessTrialLayout, sandboxPath: string): string | null {
  for (const copy of layout.harborCopies) {
    const rest = pathUnder(copy.sandboxRoot, sandboxPath);
    if (rest !== null) return `${copy.agentDir}/${rest}`;
  }
  return null;
}

/**
 * The captured home as trial files: every object at agent/<homeRelativePath>
 * (real names, the record beside), and Harbor's copy at agent/<slot> where
 * the table names one — the same text written twice, as the server's trial
 * tree does (swarm_dashboard lib/evaluations/trial-tree.ts); sandbox-path
 * order, so the placement is deterministic.
 */
function placeHome(layout: HarnessTrialLayout, home: Record<string, string>): Record<string, string> {
  const placed = new Set<string>();
  const files: Record<string, string> = {};
  for (const sandboxPath of Object.keys(home).sort()) {
    files[`agent/${placeHomeObject(placed, sandboxPath)}`] = home[sandboxPath];
    const copy = harborCopyPath(layout, sandboxPath);
    if (copy !== null && !placed.has(copy)) {
      placed.add(copy);
      files[`agent/${copy}`] = home[sandboxPath];
    }
  }
  return Object.fromEntries(Object.keys(files).sort().map((path) => [path, files[path]]));
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
      // WHAT THE TWO TOTALS ABOVE CANNOT ACCOUNT FOR. A job's cost is the sum
      // of its trials, and a trial nobody measured folds a ZERO in — so a
      // positive count here means the figure beside it is a floor. The trial's
      // own evolve.json states its lane; without these the job half of the same
      // file family would state a number with nothing to qualify it. Null on
      // servers that predate the counters, which is not the same as zero.
      n_unmeasured_trials: job.stats.n_unmeasured_trials ?? null,
      n_unmeasured_judge_trials: job.stats.n_unmeasured_judge_trials ?? null,
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
 * `agent_result` as HARBOR'S result.json may state it: the trial's tokens
 * always, but a cost figure ONLY when the gateway actually measured one.
 *
 * The API serves `cost_usd` and `spend_source` as a PAIR — a lane of
 * "measured_provisional" (a floor still being written) or "assumed_cap"
 * (nobody ever measured it) tells a reader exactly how final the number
 * beside it is, and evolve.json keeps both halves together for that reason.
 * Harbor's schema has no slot for the lane. Copying the number into it alone
 * turns "we never measured this trial" into the sentence "this trial cost
 * $0.00" — a figure no meter produced, stated to the one reader who cannot
 * see the qualifier. Measured in production 2026-08-20 (trial 4f103397): a
 * settled trial whose gateway spend had not flushed yet downloaded as
 * `cost_usd: 0`, and the platform later measured $0.057. That lane is normal
 * and transient at settle, so the false figure was the ordinary case for
 * anyone downloading promptly, not an edge.
 *
 * So an unmeasured lane exports null, and null is Harbor's own "not stated".
 * THE LANE RULE ITSELF lives in ./money (trialAgentCost), because the CLI's
 * money cells need the same answer and two spellings of it would drift. What
 * this does NOT claim is that the two writers produce the same object — the
 * platform drops `agent_result` altogether on a trial with neither a cost nor
 * tokens and never carries `metadata`, while this side has both. The figure is
 * what had to agree.
 */
function harborAgentResult(trial: Trial): Trial["agent_result"] {
  const result = trial.agent_result;
  if (result === null || result === undefined) return result ?? null;
  if (trialAgentCost(trial).lane === "measured") return result;
  return { ...result, cost_usd: null };
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
    agent_result: harborAgentResult(trial),
    started_at: trial.started_at,
    finished_at: trial.finished_at,
    environment_setup: trial.environment_setup,
    agent_setup: trial.agent_setup,
    agent_execution: trial.agent_execution,
    verifier: trial.verifier,
  });

  const layout = harnessTrialLayout(trial.agent_info.name);
  if (parts.atif !== null) files["agent/trajectory.json"] = parts.atif;
  if (parts.stdout !== null) files[`agent/${layout.stdoutFile}`] = parts.stdout;
  if (parts.stderr !== null) files["agent/stderr.log"] = parts.stderr;
  if (parts.events.length > 0) {
    files["agent/trace-parsed.jsonl"] =
      parts.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  }
  if (parts.home !== null) Object.assign(files, placeHome(layout, parts.home));

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

// =============================================================================
// ANALYSIS TREE — one analyzer run, materialized (evolve analysis download)
// =============================================================================

/** Everything the analysis assembly consumes — fetched via analyses(). */
export interface AnalysisTreeParts {
  /** analyses().get(id) — the verdict document. */
  analysis: TrialAnalysis;
  /** analyses().transcript(id) — identity facts + the drained events. */
  transcript: AnalysisTranscript;
  /** analyses().artifact(id, "trace-stdout") / ("trace-stderr") */
  stdout: string | null;
  stderr: string | null;
  /** analyses().artifact(id, "agent-home") — true sandbox paths. */
  home: Record<string, string> | null;
  /** The caller's USER id (auth().status() user_id); null when unknown. */
  userId: string | null;
}

/**
 * The analysis's evolve.json — the platform record Harbor's AnalyzeResult has
 * no slot for: which run this analysis read (the analyzed trial, its job, its
 * task), where the ANALYZER's own box ran, which user downloaded it, and the
 * analyzer's own meter. The money and token figures restate the verdict's own
 * `usage` reading (the one-home rule) rather than inventing a second meter.
 */
export function analysisEvolveRecord(
  analysis: TrialAnalysis,
  transcript: AnalysisTranscript,
  userId: string | null
): Record<string, unknown> {
  return {
    analysis_id: analysis.id,
    analyzed_trial_id: transcript.analyzed_trial_id,
    job_id: transcript.job_id,
    task_name: transcript.task_name,
    user_id: userId,
    provider: transcript.sandbox_provider,
    sandbox_id: transcript.sandbox_id,
    status: analysis.status,
    model_name: analysis.model_name,
    gateway: {
      cost_usd: analysis.estimated_cost_usd,
      n_input_tokens: analysis.usage?.input_tokens ?? null,
      n_cache_tokens: analysis.usage?.cached_input_tokens ?? null,
      n_output_tokens: analysis.usage?.output_tokens ?? null,
    },
  };
}

/**
 * THE ONE RUBRIC-RUN TREE — an analysis run and a task check materialize
 * through this one assembly (owner ruling 2026-09-09: a task check is
 * downloadable like an analysis; never a second tree builder). Deterministic
 * like assembleTrialTree.
 *
 * The layout reuses the trial tree's own slot names, because the rubric
 * agent is itself an agent run and the store keys its artifacts identically:
 *
 *   <verdict file>            the verdict document at the run's root — the
 *                             wire's TrialAnalysis as analysis.json (Harbor's
 *                             name for the per-trial artifact, their
 *                             analyzer.py:414-424 / cli/analyze.py:357) or
 *                             the wire's TaskCheck as check-result.json
 *                             (Harbor's name for the checker's deliverable,
 *                             checker.py:37 RESULT_FILENAME) — the same
 *                             object the feed's verdict door serves and its
 *                             &format=log form downloads; here it sits at the
 *                             run's own root, because this tree IS the run
 *   agent/stdout.log          the agent process's raw streams, when stored
 *   agent/stderr.log          (the wire names no harness for a rubric run,
 *                             so the default layout applies: stdout.log)
 *   agent/trace-parsed.jsonl  the run's parsed event trace
 *   agent/.claude/…           the CLI's home folder at its real names
 *   agent/agent-home.json     (homeRelativePath; the default layout copies
 *                             nothing), the capture record beside it
 *   evolve.json               the platform record (the run's evolve record)
 *
 * Absent artifacts are absent files — never empty placeholders. No
 * config.json/result.json/verifier/: those are trial-tree facts a rubric run
 * does not have, and inventing them would fake a species.
 */
function assembleRubricRunTree(parts: {
  verdictFile: string;
  verdict: unknown;
  events: TraceEvent[];
  stdout: string | null;
  stderr: string | null;
  home: Record<string, string> | null;
  evolveRecord: Record<string, unknown>;
}): Record<string, string> {
  const files: Record<string, string> = {};

  files[parts.verdictFile] = record(parts.verdict);
  if (parts.stdout !== null) files["agent/stdout.log"] = parts.stdout;
  if (parts.stderr !== null) files["agent/stderr.log"] = parts.stderr;
  if (parts.events.length > 0) {
    files["agent/trace-parsed.jsonl"] = parts.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  }
  if (parts.home !== null) Object.assign(files, placeHome(DEFAULT_HARNESS_TRIAL_LAYOUT, parts.home));

  files["evolve.json"] = record(parts.evolveRecord);
  return files;
}

/** Assemble one analysis run as {relative-path: content} — the pure assembly behind `evolve analysis download` (assembleRubricRunTree states the layout). */
export function assembleAnalysisTree(parts: AnalysisTreeParts): Record<string, string> {
  return assembleRubricRunTree({
    verdictFile: "analysis.json",
    verdict: parts.analysis,
    events: parts.transcript.events,
    stdout: parts.stdout,
    stderr: parts.stderr,
    home: parts.home,
    evolveRecord: analysisEvolveRecord(parts.analysis, parts.transcript, parts.userId),
  });
}

// =============================================================================
// TASK CHECK TREE — one task check, materialized (evolve check download)
// =============================================================================

/** Everything the task-check assembly consumes — fetched via checks(). */
export interface TaskCheckTreeParts {
  /** checks().task(id) — the result document. */
  taskCheck: TaskCheck;
  /** checks().transcript(id) — identity facts + the drained events. */
  transcript: TaskCheckTranscript;
  /** checks().artifact(id, "trace-stdout") / ("trace-stderr") */
  stdout: string | null;
  stderr: string | null;
  /** checks().artifact(id, "agent-home") — true sandbox paths. */
  home: Record<string, string> | null;
  /** The caller's USER id (auth().status() user_id); null when unknown. */
  userId: string | null;
}

/**
 * The task check's evolve.json — the platform record Harbor's
 * QualityCheckResult has no slot for: the check record this result belongs
 * to, the dataset the task came from (the dataset form), where the CHECKER's
 * own box ran, which user downloaded it, and the checker's own meter (the
 * analysis record's shape, the check's facts).
 */
export function taskCheckEvolveRecord(
  taskCheck: TaskCheck,
  transcript: TaskCheckTranscript,
  userId: string | null
): Record<string, unknown> {
  return {
    task_check_id: taskCheck.id,
    check_id: taskCheck.check_id,
    dataset: transcript.dataset,
    task_name: taskCheck.task_name,
    user_id: userId,
    provider: transcript.sandbox_provider,
    sandbox_id: transcript.sandbox_id,
    status: taskCheck.status,
    model_name: transcript.model_name,
    gateway: { cost_usd: taskCheck.cost_usd },
  };
}

/** Assemble one task check as {relative-path: content} — the pure assembly behind `evolve check download` (assembleRubricRunTree states the layout). */
export function assembleTaskCheckTree(parts: TaskCheckTreeParts): Record<string, string> {
  return assembleRubricRunTree({
    verdictFile: "check-result.json",
    verdict: parts.taskCheck,
    events: parts.transcript.events,
    stdout: parts.stdout,
    stderr: parts.stderr,
    home: parts.home,
    evolveRecord: taskCheckEvolveRecord(parts.taskCheck, parts.transcript, parts.userId),
  });
}
