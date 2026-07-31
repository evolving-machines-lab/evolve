/**
 * Public types for the hosted evaluations API — datasets, jobs, trials, agents.
 *
 * THE VOCABULARY IS THE WIRE'S. Every field on a wire-shaped object below is
 * spelled exactly as spec/openapi.yaml spells it (snake_case), in BOTH SDKs, so
 * the spec reads as the SDK's own field reference and nothing is ever lost in a
 * casing translation. The only camelCase keys are the four frozen historical
 * spots the spec names: the page envelope (`items`/`nextCursor`/`hasMore`), the
 * job body's `trials.byStatus`, the compare response's `taskMatrix`, and the
 * error envelope. SDK-side controls that never touch the wire — client config,
 * delivery options, callbacks — stay TypeScript-idiomatic camelCase.
 */

/** Configuration for the datasets() / agents() / jobs() / trials() factories */
export interface HostedClientConfig {
  /** API key (default: process.env.EVOLVE_API_KEY) */
  apiKey?: string;
  /** API base URL override (default: the Evolve dashboard API) */
  baseUrl?: string;
}

/**
 * ONE page shape for every collection on this surface — top level or nested.
 *
 * `nextCursor` means one thing everywhere: pass it back as the next call's
 * `cursor` for the next page, and `null` means there is no next page. It never
 * echoes where you already are, so a poller can always tell it has caught up.
 * The three envelope keys are frozen verbatim on the wire.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * A value you can `await`, with the rest of the promise surface attached.
 *
 * The dual-use handles below were `PromiseLike` alone, which is enough for
 * `await` and nothing else — so `client.list().catch(...)` was a compile error
 * two lines after `await client.list()` compiled fine, and `.finally()` for a
 * spinner was unavailable. A handle that is 90% of a promise is worse than one
 * that is none of it, because the missing 10% is only discovered at the call
 * site that needed it.
 *
 * `then`/`catch`/`finally` all return real Promises, so anything chained off a
 * handle behaves exactly like promise code from that point on.
 */
export interface Awaitable<T> extends PromiseLike<T> {
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult>;
  finally(onfinally?: (() => void) | null): Promise<T>;
}

/** Cursor + page-size options, accepted by every paged call */
export interface PageOptions {
  /** Max items per page */
  limit?: number;
  /** Cursor from a previous page's nextCursor */
  cursor?: string;
}

/**
 * Job lifecycle status (wire values, as the API emits them).
 * Terminal: COMPLETED, CANCELLED, FAILED.
 */
export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "CANCELLING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

/**
 * Trial status law: a valid reward (including 0) = SCORED; verifier crash or
 * out-of-domain reward = SCORING_ERROR (never a fabricated zero);
 * INFRASTRUCTURE_ERROR: the trial was lost before a result was recorded;
 * INDETERMINATE: the platform cannot tell whether the trial completed.
 */
export type TrialStatus =
  | "QUEUED"
  | "RUNNING"
  | "SCORING"
  | "SCORED"
  | "SCORING_ERROR"
  | "INFRASTRUCTURE_ERROR"
  | "INDETERMINATE"
  | "CANCELLED";

/**
 * Sandbox provider a hosted job runs on. Named `EvalSandboxProvider` to avoid
 * colliding with the core SDK's `SandboxProvider` (the sandbox-abstraction
 * interface).
 */
export type EvalSandboxProvider = "e2b" | "daytona" | "modal";

/**
 * Whether a settled trial's `agent_result.cost_usd` was measured from the
 * gateway or is the cap charged conservatively.
 */
export type SpendSource = "measured" | "assumed";

/** Where a trial's verifier executed: inside the agent's environment, or a separate one */
export type VerifierEnvironmentMode = "shared" | "separate";

/**
 * Which step a RUNNING trial is in, so a polling caller can tell a slow build
 * from a slow agent — RUNNING alone cannot.
 */
export type AttemptPhase =
  | "prepare"
  | "build"
  | "boot"
  | "install"
  | "agent"
  | "verify"
  | "persist";

/**
 * Trial count histogram by status. EVERY status is present, zeros included, so
 * a status bar can be drawn straight off the response without hardcoding the
 * enum and discovering a new status only when a bar goes missing.
 */
export type TrialCounts = Record<TrialStatus, number>;

/**
 * The one "how many" shape: a total plus the zeros-included histogram.
 * `byStatus` is one of the four frozen camelCase wire keys.
 */
export interface TrialStatusTally {
  total: number;
  byStatus: TrialCounts;
}

// =============================================================================
// JOB — CONFIG SIDE
// =============================================================================

/** A resolved dataset reference as echoed on job bodies. */
export interface DatasetRef {
  name: string;
  version: string;
}

/**
 * One dataset a job runs, with per-dataset task filters. `task_names` and
 * `exclude_task_names` are glob patterns; `n_tasks` caps the task count AFTER
 * filtering. A bare `name` resolves to the active version (`no_active_version`
 * when none).
 */
export interface DatasetSelector {
  /** Catalog dataset name. */
  name: string;
  /** Pin a version; omitted, the active version is used. */
  version?: string;
  /** Include filter — glob patterns over task names. */
  task_names?: string[];
  /** Exclude filter — glob patterns over task names. */
  exclude_task_names?: string[];
  /** Cap the task count after filters are applied. */
  n_tasks?: number;
}

/**
 * One agent arm of a job: an agent (built-in or registered) plus a model. A
 * model is always required; the server applies no default.
 *
 * `version` pins an agent version; omitted, the platform resolves the latest
 * supported (`agent_version_not_found` when a pin cannot resolve). The version
 * that actually RAN is recorded on every trial as `agent_info.version`.
 *
 * `reasoning_effort` is the platform extension: declared effort, PART OF THE
 * ARM'S IDENTITY like the agent, the model and the version pin — the same
 * agent and model at "low" and at "high" are two systems, and they
 * de-duplicate separately. Accepted values are published by /api/meta; an
 * effort the agent cannot apply is refused at creation, never recorded and
 * silently dropped.
 */
export interface AgentArmInput {
  /** Agent name — a built-in or one registered under /api/agents. */
  name: string;
  model_name: string;
  version?: string | null;
  reasoning_effort?: string | null;
}

/** One agent arm as echoed on job bodies (requested pin; null = took the latest). */
export interface AgentArm {
  name: string;
  model_name: string;
  version: string | null;
  reasoning_effort: string | null;
}

/**
 * Provenance of a derived job. `action: "regrade"` = verifier-only re-run of
 * the source; `action: "resume"` (platform extension) = new job over the
 * source's failed trials. `type` is always "hub" on this hosted surface.
 */
export interface SourceJob {
  action: "regrade" | "resume";
  type: "hub";
  job_id: string;
}

/** The job-creation body — POST /api/jobs. */
export interface JobCreate {
  /** User-facing label; server-generated when omitted. */
  job_name?: string;
  datasets: DatasetSelector[];
  agents: AgentArmInput[];
  /** Attempts per task per agent arm (default 1, max 100). */
  n_attempts?: number;
  /** Parallel trials across the job (default 4, max 16). */
  n_concurrent_trials?: number;
  /**
   * Per-trial spend cap in USD, minted onto each trial's gateway key — the
   * platform's ONLY spend enforcement (there is no job-wide budget). Omitted,
   * the server applies its published default ($200 unless the operator tuned
   * it); the response echoes the RESOLVED cap either way, and states the
   * resulting worst case for the job as a whole.
   */
  max_trial_spend_usd?: number;
  /** Sandbox provider to run on (optional; server default: `e2b`). */
  sandbox_provider?: EvalSandboxProvider;
  /**
   * Env injected into every agent run — a pass-through slot: the client sends
   * it verbatim and the server owns acceptance (refused until its wave lands,
   * never silently dropped).
   */
  agent_env?: Record<string, string>;
  /** Env injected into every verifier run — same pass-through contract. */
  verifier_env?: Record<string, string>;
}

/** Body of POST /api/jobs/{jobId}/resume. */
export interface ResumeRequest {
  /**
   * Which failures to resume, matched against
   * `exception_info.exception_type`. Omitted, the default set is
   * ["ScoringError", "InfrastructureError", "IncompleteTrialError"] plus
   * still-QUEUED trials of a cancelled source.
   */
  filter_error_types?: string[];
}

/**
 * Optional filter narrowing which trials a job-level regrade re-runs.
 * Omitted, every regradable trial is regraded.
 */
export interface RegradeRequest {
  statuses?: TrialStatus[];
  /** Restrict to one task's trials. */
  task_name?: string;
}

// =============================================================================
// JOB — RESULT SIDE
// =============================================================================

/**
 * Per-(agent, model, dataset) statistics. The evals key format is
 * `{agent}__{model}__{dataset}`, with the platform extension of a fourth
 * `__{effort}` segment when a declared reasoning effort is part of the arm
 * identity.
 */
export interface AgentDatasetStats {
  n_trials?: number;
  n_errors?: number;
  /** Metric results (a mean-reward entry per arm today); open objects. */
  metrics?: Record<string, unknown>[];
  /**
   * pass@k slot — keys are k as strings, values in [0,1]. Present and empty
   * until the platform computes it; the slot exists so adding the statistic is
   * not a wire change.
   */
  pass_at_k?: Record<string, number>;
  /** reward key -> reward value -> trial identifiers. */
  reward_stats?: Record<string, Record<string, string[]>>;
  /** exception type -> trial identifiers. */
  exception_stats?: Record<string, string[]>;
}

/**
 * Aggregate statistics of a job. Progress counters, token totals, and measured
 * cost. `cost_usd` is what the trials actually spent so far — reporting, never
 * a gate (enforcement is the per-trial cap).
 */
export interface JobStats {
  n_completed_trials?: number;
  n_errored_trials?: number;
  n_running_trials?: number;
  n_pending_trials?: number;
  n_cancelled_trials?: number;
  n_retries?: number;
  /** Keyed `{agent}__{model}__{dataset}` (+ optional effort segment). */
  evals?: Record<string, AgentDatasetStats>;
  /** Total input tokens (cache included); null until recorded. */
  n_input_tokens?: number | null;
  n_cache_tokens?: number | null;
  n_output_tokens?: number | null;
  /** Measured spend across settled trials; null before any settled. */
  cost_usd?: number | null;
}

/**
 * Why a job FAILED — deliberately NOT under the key `error`, which on this
 * surface always means "this request failed". `if (body.error) throw` stays
 * correct on a healthy 200 read of a failed job.
 */
export interface JobFailure {
  /** `job_execution_failed` when the runner recorded no code. */
  code: string;
  message: string;
}

/**
 * THE job body — the same shape from create, get, list items, cancel, resume,
 * and regrade responses; no field appears on some responses and not others.
 */
export interface Job {
  id: string;
  /** User-facing label. */
  job_name: string;
  status: JobStatus;
  /** The resolved dataset references this job ran. */
  datasets: DatasetRef[];
  agents: AgentArm[];
  n_attempts: number;
  n_concurrent_trials: number;
  /** The resolved per-trial cap every trial key was minted with. */
  max_trial_spend_usd: number;
  /**
   * The most this job can cost: every trial spending its whole cap. Stated
   * outright — the per-trial cap is the only enforcement, so the product is
   * the number someone approving a 500-trial run actually needs to see.
   */
  worst_case_spend_usd: number;
  sandbox_provider: EvalSandboxProvider;
  /** Entity cardinality only — things with no status of their own. */
  counts: { agents: number; tasks: number };
  n_total_trials: number;
  /** The zeros-included 8-status histogram, beside the coarser counters in `stats`. */
  trials: TrialStatusTally;
  stats: JobStats;
  /** Why the job FAILED, or null. Never the key `error` — see JobFailure. */
  failure: JobFailure | null;
  /** Empty for an original job. */
  source_jobs: SourceJob[];
  /** Derived: any source_jobs entry with action "regrade". */
  is_regrade: boolean;
  /** True only on a response that replayed an existing job for an Idempotency-Key. */
  idempotent_replay: boolean;
  started_at: string;
  updated_at: string;
  /** Null while the job is live. */
  finished_at: string | null;
}

// =============================================================================
// TRIAL
// =============================================================================

/**
 * A phase's wall-clock as a start/stop pair (never a duration). Either bound
 * is null while the phase has not reached it.
 */
export interface TimingInfo {
  started_at: string | null;
  finished_at: string | null;
}

export interface ModelInfo {
  name: string;
  /** Null means "not specified", never "unknown provider". */
  provider?: string | null;
}

/**
 * The agent that ran a trial. `version` is the version actually RESOLVED and
 * used (null until resolved) — the requested pin lives on the job's
 * `agents[].version`. `reasoning_effort` is the platform's arm-identity
 * extension.
 */
export interface AgentInfo {
  name: string;
  version: string | null;
  model_info: ModelInfo;
  reasoning_effort?: string | null;
}

/**
 * What the agent phase produced and consumed. `n_input_tokens` includes cache
 * tokens. `cost_usd` is the settled spend (see `spend_source` on the trial for
 * whether it was measured or assumed). `metadata` carries open per-run detail:
 * the harness bundle digest and runtime, the network mode the trial ran under
 * and where that decision came from, and any harness-reported usage detail.
 */
export interface AgentResult {
  n_input_tokens?: number | null;
  n_cache_tokens?: number | null;
  n_output_tokens?: number | null;
  /** Null until the trial has executed; null never means $0. */
  cost_usd?: number | null;
  /** Reserved for token-level rollout detail; null today. */
  rollout_details?: Record<string, unknown>[] | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The verifier's rewards map. The primary-reward convention: the value under
 * the key "reward"; else, when exactly one key exists, that value; else no
 * primary reward. Zero is a reward.
 */
export interface VerifierResult {
  rewards?: Record<string, number> | null;
}

/**
 * Why a trial failed, when it did. `exception_type` is one of the platform's
 * stable failure names (ScoringError, InfrastructureError, CancelledError,
 * IncompleteTrialError) — but filter with `Trial.status`, which is the primary
 * key for failure classes; this is the detail.
 */
export interface ExceptionInfo {
  exception_type: string;
  /** Truncated to 2000 chars on list rows; full on the detail route. */
  exception_message: string;
  /** Empty when the platform recorded no traceback. */
  exception_traceback?: string;
  occurred_at: string;
}

/**
 * Placeholder for multi-step tasks. Always null on trials today — declared so
 * multi-step lands without a wire change.
 */
export interface StepResult {
  step_name?: string;
  agent_result?: AgentResult | null;
  verifier_result?: VerifierResult | null;
  exception_info?: ExceptionInfo | null;
  agent_execution?: TimingInfo | null;
  verifier?: TimingInfo | null;
}

/**
 * The ONE public trial shape, shared verbatim by list rows and the detail
 * route (detail returns `exception_info.exception_message` untruncated — the
 * only documented difference). A trial id is globally addressable; `job_id` is
 * the reverse pointer.
 *
 * Execution facts (`sandbox_provider`, `verifier_environment_mode`,
 * `agent_result.cost_usd`, `spend_source`) are null until the trial has
 * actually executed: a QUEUED or CANCELLED trial never ran, so null means
 * "did not run" and never zero.
 */
export interface Trial {
  id: string;
  job_id: string;
  task_name: string;
  /** The dataset this trial's task came from. */
  source: string;
  agent_info: AgentInfo;
  /** Attempt index within the arm (1..n_attempts). */
  attempt: number;
  status: TrialStatus;
  /**
   * Convenience primary reward derived from `verifier_result.rewards` by the
   * primary-reward convention. Zero is a reward; null means the trial did not
   * score.
   */
  reward: number | null;
  verifier_result: VerifierResult | null;
  exception_info: ExceptionInfo | null;
  agent_result: AgentResult | null;
  environment_setup: TimingInfo | null;
  agent_setup: TimingInfo | null;
  agent_execution: TimingInfo | null;
  verifier: TimingInfo | null;
  /** Multi-step placeholder; null today. */
  step_results: StepResult[] | null;
  /** Whether `agent_result.cost_usd` was measured or is the cap charged conservatively. */
  spend_source: SpendSource | null;
  /**
   * A mid-run LOWER BOUND on spend, never the trial's cost. Only ever climbs
   * while the trial runs, and is CLEARED when the trial settles — on a
   * terminal trial read `agent_result.cost_usd` and `spend_source`; those are
   * the settled truth. Null is "no reading yet", never $0.
   */
  live_spent_usd: number | null;
  /** When that reading was taken — show its age, never the figure alone. */
  live_spend_at: string | null;
  /**
   * The cap THIS trial's gateway key carried — history, which can differ from
   * the job's current cap for rows settled before a change.
   */
  max_trial_spend_usd: number | null;
  sandbox_provider: EvalSandboxProvider | null;
  /** Provider id of the box the agent executed in; null when none booted. */
  sandbox_id: string | null;
  /** The separate verifier box; null in shared mode or when never reached. */
  verifier_sandbox_id: string | null;
  verifier_environment_mode: VerifierEnvironmentMode | null;
  /**
   * Which step a RUNNING trial is in, so a polling caller can tell a slow
   * build from a slow agent. Null when the trial is not mid-phase.
   */
  attempt_phase: AttemptPhase | null;
  /** Reference to the agent session/trace, when recorded. */
  session_ref: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/** Per-trial outcome of POST /api/trials/stop; every requested id appears in exactly one list. */
export interface StopResponse {
  /** Trials killed and settled by this request, with their settled rows. */
  stopped: Trial[];
  /** Ids that were already terminal; untouched. */
  already_terminal: string[];
  /** Ids that do not exist or are not the caller's. */
  not_found: string[];
}

/**
 * One parsed trace event of a trial's transcript. `seq` orders the stream and
 * is the paging cursor. `data` is the harness-native payload, deliberately
 * open.
 */
export interface TraceEvent {
  /** Monotonic sequence number (the resume position). */
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

/**
 * One page of a trial's trace — trials().trace().
 *
 * Same envelope as every other collection, and nextCursor means the same
 * thing: pass it back as { cursor } for the next page, and NULL MEANS CAUGHT
 * UP. To resume a poll later, keep the last event's `seq` and pass it as
 * { cursor } — the trace's cursor IS its position in the seq timeline.
 */
export type TraceEventPage = Page<TraceEvent>;

// =============================================================================
// COMPARE
// =============================================================================

/** How many of the trials behind an aggregate were SCORED (means cover SCORED only). */
export interface CompareCoverage {
  scored: number;
  total: number;
}

/**
 * One (task, job) cell. `status` is a TrialStatus when every trial in the cell
 * shares it, "MIXED" when they differ, "MISSING" when the job has no trials
 * for the task.
 */
export interface CompareCell {
  job_id: string;
  status: TrialStatus | "MIXED" | "MISSING";
  /** Mean reward over the cell's SCORED trials; null when none. Zero is a reward. */
  mean_reward: number | null;
  coverage: CompareCoverage;
}

/** One matrix row of jobs().compare(): a task across the compared jobs */
export interface CompareTaskRow {
  task_name: string;
  /** True when the jobs' cells differ in status or reward for this task */
  disagreement: boolean;
  /** Cells in the caller's job-id order */
  cells: CompareCell[];
}

/** Per-job aggregate of jobs().compare() */
export interface CompareJobAggregate {
  id: string;
  datasets: DatasetRef[];
  status: JobStatus;
  /** Mean reward over SCORED trials only; null when none. Zero is a reward. */
  mean_reward: number | null;
  coverage: CompareCoverage;
  cost_usd: number;
  agents: AgentArm[];
  started_at: string;
}

/**
 * Result of jobs().compare([ids]): per-job aggregates plus a per-task matrix
 * (disagreement rows first). `taskMatrix` is a frozen camelCase wire key.
 */
export interface CompareResponse {
  /** Aggregates in the caller's id order */
  jobs: CompareJobAggregate[];
  taskMatrix: CompareTaskRow[];
}

// =============================================================================
// SSE EVENTS
// =============================================================================

/** Fields every job event carries, whatever its type. */
interface JobEventBase {
  /** Monotonic sequence number (SSE id; the Last-Event-ID resume position) */
  seq: number;
}

/** The job's resolved creation inputs, echoed so a watcher that joined late knows what it is watching. */
export interface JobCreatedData {
  datasets: DatasetRef[];
  task_count: number;
  agents: AgentArm[];
  n_attempts: number;
  n_concurrent_trials: number;
  max_trial_spend_usd: number;
  sandbox_provider: EvalSandboxProvider;
  trial_count: number;
}

export interface JobCancellingData {
  job_id: string;
  /** Queued trials cancelled outright by the request */
  cancelled_trials: number;
  /** Trials still in flight, winding down before the job settles */
  active_trials: number;
}

export interface JobCancelledData {
  job_id: string;
  /** Total queued trials cancelled across the request and the settle */
  cancelled_trials: number;
}

export interface TrialRunningData {
  trial_id: string;
  task_name: string;
}

export interface TrialScoringData {
  trial_id: string;
  /** Bytes of agent stdout retained for the failure detail */
  captured_bytes?: number;
}

/**
 * A mid-run spend sample landed on a still-live trial. Emitted only when the
 * reading actually updated a RUNNING/SCORING row, so a poll that raced the
 * settle never fires one.
 */
export interface TrialSpendData {
  trial_id: string;
  task_name: string;
  /** The same lagging lower bound as Trial.live_spent_usd — not the trial's cost */
  live_spent_usd: number;
}

/**
 * A trial reached a terminal status. `reward` is present only on the scored
 * path; `exception_type` only on a failure; `attempt_phase` appears when the
 * settle happened mid-phase (worker death), which is exactly when knowing the
 * phase is worth having.
 */
export interface TrialSettledData {
  trial_id: string;
  task_name: string;
  status: TrialStatus;
  /** Zero is a reward; absent means the trial did not score. */
  reward?: number | null;
  exception_type?: string;
  attempt_phase?: AttemptPhase | null;
}

/**
 * One server-sent event from jobs().watch(), as a DISCRIMINATED UNION on
 * `type` and ONLY on `type`: several event types carry identically shaped
 * payloads (`job.running` and `job.completed` are both `{job_id}`), so payload
 * shape can never route a reader — the `type` constant does. Switching on
 * `type` narrows `data`.
 *
 * job.failed is declared terminal by the event stream and by this SDK, but NO
 * SERVER PATH EMITS IT today. It stays in the union because both consumers
 * treat it as terminal — the payload is fixed now so a client written today
 * parses it when it first appears. Treat it as RESERVED rather than expected.
 */
export type JobEvent =
  | (JobEventBase & { type: "job.created"; data: JobCreatedData })
  | (JobEventBase & { type: "job.running"; data: { job_id: string } })
  | (JobEventBase & { type: "job.cancelling"; data: JobCancellingData })
  | (JobEventBase & { type: "job.cancelled"; data: JobCancelledData })
  | (JobEventBase & { type: "job.completed"; data: { job_id: string } })
  | (JobEventBase & { type: "job.failed"; data: { job_id: string } })
  | (JobEventBase & { type: "trial.running"; data: TrialRunningData })
  | (JobEventBase & { type: "trial.scoring"; data: TrialScoringData })
  | (JobEventBase & { type: "trial.spend"; data: TrialSpendData })
  | (JobEventBase & { type: "trial.settled"; data: TrialSettledData });

/**
 * The handle returned by jobs().watch(). It is both:
 * - a promise for the final Job — `await client.watch(id)` resolves once
 *   the job reaches a terminal status (the original form); and
 * - an async iterable of events — `for await (const event of client.watch(id))`
 *   yields each JobEvent and completes on the terminal event.
 *
 * Pick one form per call: both drive the same underlying SSE stream, so a
 * single handle should not be awaited and iterated at once.
 */
export interface JobWatch extends Awaitable<Job>, AsyncIterable<JobEvent> {}

/** Cursor page of jobs (newest first) */
export type JobPage = Page<Job>;

/**
 * The handle returned by jobs().list(). Both:
 * - a promise for a single JobPage — `await client.list({ limit })`
 *   returns one page (the original form); and
 * - an async iterable — `for await (const item of client.list())` walks every
 *   job across cursor pages, fetching the next page for you.
 */
export interface JobList extends Awaitable<JobPage>, AsyncIterable<Job> {}

/**
 * One task's rollup within a job: its trial tally, mean reward over SCORED
 * trials, and measured cost. Sits between the job body and the trial list so
 * a caller need not fetch every trial to see which tasks are dragging.
 */
export interface JobTaskRollup {
  task_name: string;
  /** The dataset the task came from. */
  source: string;
  trials: TrialStatusTally;
  /** Mean over SCORED trials only; null when none. Zero is a reward. */
  mean_reward: number | null;
  /** Measured spend across the task's settled trials. */
  cost_usd: number | null;
}

/** Cursor page of per-task rollups */
export type JobTaskRollupPage = Page<JobTaskRollup>;

/**
 * The handle returned by jobs().tasks(). Both a promise for one page and an
 * async iterable across cursor pages, like every other list handle.
 */
export interface JobTaskRollupList
  extends Awaitable<JobTaskRollupPage>,
    AsyncIterable<JobTaskRollup> {}

/** Cursor page of trials */
export type TrialPage = Page<Trial>;

/**
 * The handle returned by jobs().trials(). Both:
 * - a promise for a single TrialPage — `await client.trials(id, { limit })`
 *   returns one page (the original form); and
 * - an async iterable — `for await (const trial of client.trials(id))` walks
 *   every trial across cursor pages, fetching the next page for you.
 */
export interface TrialList extends Awaitable<TrialPage>, AsyncIterable<Trial> {}

// =============================================================================
// DATASETS
// =============================================================================

/** Dataset version lifecycle state (wire values). Terminal: READY, FAILED, ARCHIVED. */
export type DatasetVersionState =
  | "DRAFT"
  | "IMPORTING"
  | "BUILDING"
  | "VALIDATING"
  | "READY"
  | "FAILED"
  | "ARCHIVED";

/** One immutable version of a dataset — one shape on every surface */
export interface DatasetVersion {
  version: string;
  state: DatasetVersionState;
  created_at: string;
  task_count: number;
}

/**
 * One provider's verdict for a task: runnable there, or refused with the
 * limitation named (e.g. a multi-container task on a provider that cannot
 * host its services, or declared resources above the provider's ceiling).
 */
export type TaskProviderVerdict = { ok: true } | { ok: false; reason: string };

/** Public task fields only — instructions, environments, and tests never leave the server */
export interface Task {
  task_name: string;
  agent_timeout_sec: number;
  verifier_timeout_sec: number;
  /**
   * Where the task can run, per sandbox provider. Advisory for planning a
   * job's provider choice — creating a job whose tasks include one refused on
   * the chosen provider is rejected with the same reason, so nothing is ever
   * spent on a trial that cannot execute.
   */
  providers: Record<EvalSandboxProvider, TaskProviderVerdict>;
}

/**
 * Where a dataset's git source points now, versus what its active version was
 * built from — the data behind a "new version available" badge. Null on a
 * dataset whose source cannot be re-resolved; null is "nothing to watch",
 * never "up to date". Nothing here imports anything — a new version is always
 * a row you create (or `auto_import` creates).
 */
export interface UpstreamStatus {
  /** The ref the active version was imported from. */
  ref: string;
  /** The commit the active version was built from. */
  current_commit: string;
  /** Where the ref points upstream now; null when the last check failed. */
  latest_commit: string | null;
  /** True when upstream has moved off the built-from commit. Branch on this. */
  moved: boolean;
  /** Reserved; always null today. */
  behind_by: number | null;
  /** When the cached answer was taken; null before the first check. */
  checked_at: string | null;
  /** Why the last check failed. Show "could not check", not "up to date". */
  error: string | null;
  /** Whether a moved upstream automatically imports a new version. */
  auto_import: boolean;
}

/**
 * A dataset in the catalog.
 *
 * list() returns the summary fields; get() additionally populates versions,
 * selected_version, tasks, created_at, and updated_at.
 */
export interface Dataset {
  name: string;
  title: string | null;
  description: string | null;
  /** The active version, or null when none is active (bare-name job refs refuse). */
  active_version: DatasetVersion | null;
  /** All versions, newest first (get() only) */
  versions?: DatasetVersion[];
  /** The version whose tasks are listed below (get() only) */
  selected_version?: DatasetVersion | null;
  /**
   * One page of the selected version's tasks (get() only). Paged like every
   * other collection: a SWE-bench-scale dataset has thousands of tasks, so
   * pass { limit, cursor } to get() and follow nextCursor.
   */
  tasks?: Page<Task>;
  upstream: UpstreamStatus | null;
  /** get() only */
  created_at?: string;
  /** get() only */
  updated_at?: string;
}

/** Body of datasets().update() — the only settable dataset field. */
export interface DatasetPatch {
  /** Automatically import a new version when the upstream git ref moves. */
  upstream_auto_import: boolean;
}

/**
 * A dataset's active version resolved to a runnable shape.
 *
 * Unlike Dataset, `version` and `tasks` are non-optional: datasets()
 * .getActive() throws NoActiveVersionError when there is no active version,
 * so callers never branch on a missing active version.
 */
export interface ActiveDataset {
  name: string;
  title: string | null;
  description: string | null;
  /** The active version (always present) */
  active_version: DatasetVersion;
  /** The active version string (identical to active_version.version) */
  version: string;
  /** One page of the active version's tasks */
  tasks: Page<Task>;
  /** All versions, newest first */
  versions: DatasetVersion[];
  created_at: string;
  updated_at: string;
}

/** Cursor page of datasets */
export type DatasetPage = Page<Dataset>;

/** Dual-use handle from datasets().list(): await one page, or iterate them all */
export interface DatasetList extends Awaitable<DatasetPage>, AsyncIterable<Dataset> {}

// =============================================================================
// DATASET PUBLISH (async import)
// =============================================================================

/**
 * Source for datasets().publish(): EITHER a git repository pinned to a ref, OR
 * a local corpus directory (tarred deterministically on the client and
 * uploaded).
 *
 * A UNION, not three optional fields: `{}` and both-branches-at-once are
 * compile errors rather than a 400 the caller discovers at run time, and
 * `?: never` on the absent branch's keys is what rejects the excess property
 * through a variable. `git_ref` is REQUIRED on the git branch — an unpinned
 * import is not reproducible.
 */
export type DatasetSource =
  | {
      /**
       * A git repository URL. https:// only — the import runs on a worker with
       * no ssh client, so ssh:// and git@ remotes are refused at validation.
       * For a private repository, put a token in the https url.
       */
      git_url: string;
      /** A pinned branch, tag, or commit. Required: an unpinned import is not reproducible. */
      git_ref: string;
      directory?: never;
    }
  | {
      /** A local standard-layout corpus directory — tarred + gzipped and uploaded. */
      directory: string;
      git_url?: never;
      git_ref?: never;
    };

/** Input for datasets().publish() */
export interface PublishDatasetInput {
  source: DatasetSource;
  /** Catalog dataset name the version lands under (created or extended) */
  name: string;
  /** Version label for the new immutable version */
  version: string;
}

/**
 * Dataset import status.
 *
 * The SAME four words a job uses, deliberately: a status chip rendering both
 * never carries a translation table. Terminal: "COMPLETED" (the corpus landed
 * as a dataset version; runnable once activated) and "FAILED".
 */
export type DatasetImportStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

/** Structured failure detail for a FAILED import. */
export interface DatasetImportFailure {
  /** Stable machine-readable cause; "import_failed" when none was recorded. */
  code: string;
  /** What went wrong, e.g. "2/113 task(s) failed to parse" */
  message: string;
  /** Per-task parse/validation failures, when the corpus was reachable */
  failures?: { task_name: string; error: string }[];
}

/**
 * Non-fatal but consequential import outcome. A version whose warnings include
 * `no_solutions_archived` cannot be activated through this API
 * (`version_not_activatable`) — an import that will never become runnable must
 * not look identical to one that will.
 */
export interface ImportWarning {
  code:
    | "solutions_archiving_disabled"
    | "no_solutions_archived"
    | "partial_solutions_archived";
  message?: string;
}

/**
 * An asynchronous publish. Self-describing: every response names the
 * dataset@version being imported — the 202 from publish(), getImport(), and
 * listImports() all return this same shape, so a caller can render the row it
 * just created without a follow-up read.
 */
export interface DatasetImport {
  /** Import job id */
  id: string;
  status: DatasetImportStatus;
  /** Catalog dataset name the import creates or extends */
  name: string;
  /** Version label of the imported version */
  version: string;
  /**
   * Why the import FAILED; null otherwise. Named `failure`, never `error` —
   * see JobFailure.
   */
  failure: DatasetImportFailure | null;
  /** Non-fatal but consequential outcomes — see ImportWarning. */
  warnings: ImportWarning[];
  /** Number of tasks parsed, once counted */
  task_count?: number;
  created_at?: string;
  updated_at?: string;
}

/** Cursor page of dataset imports */
export type DatasetImportPage = Page<DatasetImport>;

/** Dual-use handle from datasets().listImports(): await one page, or iterate them all */
export interface DatasetImportList
  extends Awaitable<DatasetImportPage>,
    AsyncIterable<DatasetImport> {}

// =============================================================================
// REGISTERED AGENTS (bring-your-own)
// =============================================================================

/**
 * Where a registered agent's executables came from: an install script run in a
 * throwaway builder sandbox, or a tarball uploaded from a local directory.
 * Echoed on every response; the SDK never guesses it.
 */
export type AgentSource = "install_script" | "tarball";

/**
 * A private agent registered by the caller. Once registered, its `name` is
 * usable in job `agents[].name` exactly like a built-in ("claude", "codex",
 * ...). Private to its owner: another user's name reads as `agent_not_found`,
 * never as a permission error — existence is never leaked.
 */
export interface Agent {
  /** The name to put in job agents[].name */
  name: string;
  /** How the executables were produced */
  source: AgentSource;
  /** The command run headless with `sh -c` at the task working directory */
  run_command: string;
  /**
   * Caller-declared env injected at RUN time only. It may not override the run
   * contract's own keys — the server rejects that at registration with
   * `agent_invalid_env`.
   */
  env: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/**
 * The two sources a registered agent's executables can come from. A union, not
 * two optional fields — see DatasetSource for why `?: never` is load-bearing
 * rather than decorative.
 */
export type AgentSourceInput =
  | {
      /**
       * The install script itself (not a path). It runs in a throwaway builder
       * sandbox that has internet and ZERO secrets, so everything it fetches
       * must be publicly fetchable, and it must leave executables in
       * `$PREFIX/bin`.
       */
      install_script: string;
      directory?: never;
    }
  | {
      /**
       * A local directory holding the agent — tarred + gzipped and uploaded.
       * Same build rules as an install script.
       */
      directory: string;
      install_script?: never;
    };

/**
 * Input for agents().create(): a name, a run command, and EXACTLY ONE source.
 * The source half is a union, so omitting both or passing both is a compile
 * error rather than a 400 the caller discovers at run time.
 */
export type AgentInput = AgentSourceInput & {
  /** Agent name; also the value used later in job agents[].name */
  name: string;
  /** Command run headless with `sh -c` at the task working directory */
  run_command: string;
  /** Env injected at RUN time only; may not override the run contract's keys */
  env?: Record<string, string>;
};

/**
 * An agent upsert body. Same shape as AgentInput minus `name`, which the
 * upsert takes as its first argument — the name is the resource identity, not
 * a field of it.
 */
export type AgentUpsertInput = AgentSourceInput & {
  /** Command run headless with `sh -c` at the task working directory */
  run_command: string;
  /** Env injected at RUN time only; may not override the run contract's keys */
  env?: Record<string, string>;
};

/** Cursor page of registered agents */
export type AgentPage = Page<Agent>;

/** Dual-use handle from agents().list(): await one page, or iterate them all */
export interface AgentList extends Awaitable<AgentPage>, AsyncIterable<Agent> {}

// =============================================================================
// OPTIONS
// =============================================================================

/** Options for jobs().start() and resume() */
export interface StartJobOptions {
  /**
   * Idempotency-Key header value: retries with the same key return the
   * original job (idempotent_replay: true) instead of creating a new one.
   */
  idempotencyKey?: string;
}

/** Options for jobs().list() (default page 50, max 200) */
export interface ListJobsOptions extends PageOptions {
  /**
   * Free-text filter over job name and dataset names. Sent verbatim; the
   * server owns availability (ignored or refused until its wave lands).
   */
  search?: string;
}

/** Options for jobs().tasks() (default page 50, max 200) */
export interface ListJobTasksOptions extends PageOptions {}

/** Options for jobs().trials() (default page 50, max 200) */
export interface ListTrialsOptions extends PageOptions {
  /** Only trials in these statuses (e.g. the failures behind a resume decision) */
  status?: TrialStatus[];
  /** Only one dataset's trials — exact match on the trial's `source`. */
  dataset?: string;
}

/** Options for datasets().list() (default page 50, max 200) */
export interface ListDatasetsOptions extends PageOptions {
  /** Free-text filter over name and description — same pass-through contract as jobs. */
  search?: string;
}

/** Options for agents().list() (default page 50, max 200) */
export interface ListAgentsOptions extends PageOptions {}

/** Options for datasets().get() / getActive(): pages the TASK list (default 200, max 500) */
export interface GetDatasetOptions extends PageOptions {}

/** Options for datasets().listImports() */
export interface ListImportsOptions extends PageOptions {
  /** Only imports in this status */
  status?: DatasetImportStatus;
  /** Only imports of this dataset name */
  dataset?: string;
}

/** Options for trials().trace() and traceEvents() */
export interface TraceOptions extends PageOptions {
  /**
   * Resume position: events with seq strictly greater than this cursor (omit =
   * from the beginning). A trace cursor IS a seq, so to resume a poll later
   * pass the last event's `seq` here as a string.
   */
  cursor?: string;
  /** Max events per page (server default: 200, max: 1000) */
  limit?: number;
}

/** Options for datasets().watchImport() */
export interface WatchImportOptions {
  /** Called on every observed status change (including the first status seen) */
  onStatus?: (datasetImport: DatasetImport) => void;
  /** Abort the watch (rejects with the abort reason) */
  signal?: AbortSignal;
  /** Poll interval between getImport() calls (default: 2000ms) */
  pollIntervalMs?: number;
}

/** Options for jobs().watch() */
export interface WatchJobOptions {
  /** Called for every event (replayed + live) */
  onEvent?: (event: JobEvent) => void;
  /** Abort the watch (rejects with the abort reason) */
  signal?: AbortSignal;
  /** Initial reconnect backoff (default: 1000ms; doubles up to maxReconnectDelayMs) */
  reconnectDelayMs?: number;
  /** Backoff ceiling (default: 30000ms) */
  maxReconnectDelayMs?: number;
}

/** Delivery options for datasets().download() */
export interface DownloadDatasetOptions {
  /** Directory to save the package into (returns the file path) */
  to?: string;
  /** Return the raw response stream instead of a Buffer */
  stream?: boolean;
}

/** Delivery options for jobs().download() */
export interface DownloadJobOptions {
  /** Directory to save the archive into (returns the file path) */
  to?: string;
  /** Return the raw response stream instead of a Buffer */
  stream?: boolean;
}

// =============================================================================
// CLIENTS
// =============================================================================

/** Client for the shared dataset catalog */
export interface DatasetsClient {
  /**
   * List datasets with their active versions (cursor-paged). Await the
   * result for one page, or `for await` it to walk the whole catalog.
   */
  list(options?: ListDatasetsOptions): DatasetList;
  /**
   * Get one dataset: all versions + one page of the selected version's tasks.
   * ref is "name" (active version's tasks) or "name@version"; { limit, cursor }
   * page the tasks.
   */
  get(ref: string, options?: GetDatasetOptions): Promise<Dataset>;
  /**
   * Get a dataset's active version resolved to a runnable shape: unlike
   * get(), `version` and `tasks` are guaranteed present. Throws
   * NoActiveVersionError when the dataset has no active version. Use get()
   * for the full multi-version detail with optional fields.
   */
  getActive(name: string, options?: GetDatasetOptions): Promise<ActiveDataset>;
  /**
   * Publish a dataset version (asynchronous server-side import) from a git
   * source pinned to a ref, or a local corpus directory. Returns immediately;
   * poll with getImport()/watchImport().
   */
  publish(input: PublishDatasetInput): Promise<DatasetImport>;
  /** Get an import job's status (failure, warnings, and task_count when available) */
  getImport(id: string): Promise<DatasetImport>;
  /**
   * Poll getImport() until the import reaches a terminal status ("COMPLETED"
   * or "FAILED") and resolve with the final import.
   */
  watchImport(id: string, options?: WatchImportOptions): Promise<DatasetImport>;
  /**
   * List the caller's own imports, newest first (cursor-paged). This is how
   * you find an import again after losing the id publish() returned. Await
   * for one page, or `for await` to walk them all. { status } filters on the
   * import vocabulary; { dataset } narrows to one dataset name.
   */
  listImports(options?: ListImportsOptions): DatasetImportList;
  /**
   * Download the ORIGINAL corpus package one of your own dataset versions was
   * published from — the gzipped tarball you uploaded, or, for a git publish,
   * the checked-out tree packed at import time. `ref` is "name" (the active
   * version's package) or "name@version".
   *
   * OWNER ONLY. This is the one call that returns task files, and it returns
   * them only to the account that owns the dataset; a platform-curated dataset
   * has no owner, so nobody can download it. Someone else's dataset is a plain
   * not-found, never a 403.
   *
   * The server verifies the stored bytes against their recorded sha256 before
   * sending anything and echoes the digest; the client re-checks the digest
   * and the Content-Length, so a successful call is byte-identical to what was
   * published. A version published before packages were retained has none
   * (`package_not_retained`, distinct from "not found").
   *
   * Default: Buffer. { to } saves into a directory and returns the file path.
   * { stream: true } returns the raw response stream.
   */
  download(ref: string): Promise<Buffer>;
  download(ref: string, options: { to: string }): Promise<string>;
  download(ref: string, options: { stream: true }): Promise<ReadableStream<Uint8Array>>;
  download(
    ref: string,
    options?: DownloadDatasetOptions
  ): Promise<Buffer | string | ReadableStream<Uint8Array>>;
  /**
   * Update dataset settings. The only settable field is
   * `upstream_auto_import`: automatically import a new version when the
   * dataset's upstream git ref moves. Refused (upstream_not_watchable) when
   * the dataset has no moving git ref to follow, and dataset_not_owned on a
   * platform-curated dataset. Returns the updated dataset.
   */
  update(name: string, patch: DatasetPatch): Promise<Dataset>;
  /**
   * Activate a READY version you own: bare-name job references resolve to it
   * from then on. Refused with `version_not_ready` while the import still
   * runs and `version_not_activatable` for a version that can never be
   * activated (for example, no reference solutions were archived). The route
   * is wave-gated — the server may still answer not-found until its wave.
   */
  activate(name: string, version: string): Promise<Dataset>;
  /**
   * Delete a dataset you own, with every version, task, and archived
   * solution. Refused (dataset_in_use) while any job still references it — a
   * dataset is never deleted out from under a job that measured against it,
   * and `err.details.sampleJobIds` names the jobs blocking it. A platform
   * dataset is refused with dataset_not_owned; a name you cannot see is a
   * plain not-found.
   */
  delete(name: string): Promise<void>;
}

/** Client for the caller's own private (bring-your-own) agents */
export interface AgentsClient {
  /**
   * Register a private agent. Provide either an install script
   * (`{ install_script }`) or a local directory (`{ directory }`), never both.
   * The name is then usable in job `agents[].name` like a built-in.
   */
  create(input: AgentInput): Promise<Agent>;
  /**
   * List the caller's registered agents (cursor-paged). Await the result for
   * one page, or `for await` it to walk them all.
   */
  list(options?: ListAgentsOptions): AgentList;
  /** Get one registered agent by name */
  get(name: string): Promise<Agent>;
  /** Delete a registered agent. Past jobs keep their recorded agent. */
  delete(name: string): Promise<void>;
  /**
   * Register or replace an agent in ONE call, under the name you give.
   *
   * Use this instead of delete()+create() to change an existing registration:
   * the pair leaves a window where the agent does not exist, and anything
   * naming it in that window fails for a change that was only ever meant to be
   * an edit. This is a full replacement, not a patch — every field comes from
   * this call, and an omitted `env` becomes empty.
   */
  upsert(name: string, input: AgentUpsertInput): Promise<Agent>;
}

/** Client for hosted jobs */
export interface JobsClient {
  /**
   * Start a job over one or more catalog datasets. Each dataset selector may
   * carry glob task filters; every agent arm must name a model. Supports
   * Idempotency-Key.
   */
  start(input: JobCreate, options?: StartJobOptions): Promise<Job>;
  /** Get one job */
  get(id: string): Promise<Job>;
  /**
   * List the caller's jobs, newest first (cursor-paged). Await the
   * result for one page, or `for await` it to walk every job across
   * cursor pages transparently.
   */
  list(options?: ListJobsOptions): JobList;
  /**
   * List a job's trials (cursor-paged; { status } filters, e.g. to
   * the failed trials). Await the result for one page, or `for await` it to
   * walk every trial across cursor pages transparently.
   */
  trials(id: string, options?: ListTrialsOptions): TrialList;
  /**
   * Per-task rollup of a job (cursor-paged): one row per distinct task with
   * its trial tally, mean reward, and cost. The route is wave-gated — the
   * server may still answer not-found until its wave lands.
   */
  tasks(id: string, options?: ListJobTasksOptions): JobTaskRollupList;
  /**
   * Watch a job's event stream (SSE). Replays from the beginning,
   * resumes with Last-Event-ID on reconnect (exponential backoff), and
   * finishes on the terminal event.
   *
   * The returned handle is dual-use: `await client.watch(id)` resolves with the
   * final Job, or `for await (const event of client.watch(id))` iterates
   * the events. The `onEvent` callback still fires in both forms.
   */
  watch(id: string, options?: WatchJobOptions): JobWatch;
  /** Request cancellation. Idempotent; a terminal job is a no-op. */
  cancel(id: string): Promise<Job>;
  /**
   * Resume a terminal job: a NEW linked job holding fresh trials for the
   * source's failed work (`source_jobs` records `action: "resume"`); the
   * source is never mutated. `request.filter_error_types` selects which
   * failures to resume by `exception_info.exception_type`. Supports
   * Idempotency-Key.
   */
  resume(id: string, request?: ResumeRequest, options?: StartJobOptions): Promise<Job>;
  /**
   * Regrade a terminal job: re-run the verifier of every REGRADABLE trial
   * against its recorded inputs, in fresh separate verifier boxes. The agent
   * phase is never re-run and the source trials are never modified. THE
   * RESPONSE IS A JOB — a regrade is an ordinary job whose `source_jobs`
   * records `action: "regrade"` and whose `is_regrade` is true; view it with
   * get(). `request` narrows the set by statuses and/or task.
   */
  regrade(id: string, request?: RegradeRequest): Promise<Job>;
  /**
   * Side-by-side comparison of 2-10 owned jobs: per-job
   * aggregates plus a per-task matrix with disagreement rows first.
   */
  compare(ids: string[]): Promise<CompareResponse>;
  /**
   * Download a terminal job's results archive (gzipped, standard results
   * layout, deterministic bytes). Default: Buffer — verified against the
   * response's Content-Length and, when the server states one, its digest.
   * { to } saves to a directory (temp-then-rename, same verification) and
   * returns the file path. { stream: true } returns the raw response stream,
   * the one shape the caller must verify themselves.
   */
  download(id: string): Promise<Buffer>;
  download(id: string, options: { to: string }): Promise<string>;
  download(id: string, options: { stream: true }): Promise<ReadableStream<Uint8Array>>;
  download(
    id: string,
    options?: DownloadJobOptions
  ): Promise<Buffer | string | ReadableStream<Uint8Array>>;
}

/**
 * The trace route's `?stream=` selectors, in the contract's own order — the
 * raw-artifact vocabulary. A runtime value (not only a type) so a drift gate
 * can hold it to the spec's enum, and the CLI can build its `--stream`
 * validation from the same list instead of a second copy.
 */
export const TRIAL_ARTIFACT_STREAMS = [
  "verifier",
  "trace-stdout",
  "trace-stderr",
  "trajectory",
  "agent-home",
] as const;

/** One raw-artifact selector on the trace route. */
export type TrialArtifactStream = (typeof TRIAL_ARTIFACT_STREAMS)[number];

/** Client for globally addressable trials — no job id in any signature */
export interface TrialsClient {
  /**
   * Get one trial by its globally addressable id. The body carries `job_id`
   * as the reverse pointer; `exception_info.exception_message` is untruncated
   * here, unlike list rows.
   */
  get(trialId: string): Promise<Trial>;
  /** Get one page of a trial's trace; resume with { cursor: page.nextCursor } */
  trace(trialId: string, options?: TraceOptions): Promise<TraceEventPage>;
  /**
   * Iterate a trial's trace events, fetching pages under the hood until
   * the currently available trace is drained. Resume later by passing the
   * last seen seq as { cursor }.
   */
  traceEvents(trialId: string, options?: TraceOptions): AsyncIterableIterator<TraceEvent>;
  /**
   * One RAW trace artifact, by the trace route's ?stream= selector.
   * "verifier" | "trace-stdout" | "trace-stderr" answer the log text;
   * "agent-home" answers the CLI's whole home folder (subagent transcripts
   * included), keyed by sandbox path. Null = never stored
   * (a normal answer, not an error). "trajectory" is in the vocabulary ahead
   * of its server wave — until that wave lands the route answers not-found,
   * reported honestly as the API error it is.
   */
  artifact(
    trialId: string,
    stream: Exclude<TrialArtifactStream, "agent-home">
  ): Promise<string | null>;
  artifact(trialId: string, stream: "agent-home"): Promise<Record<string, string> | null>;
  /**
   * Regrade one settled trial: re-run its verifier against its recorded
   * inputs in a fresh separate verifier box. Refused
   * (regrade_source_ineligible) for shared-mode or pre-persistence trials.
   * THE RESPONSE IS A JOB — a one-trial regrade job with `source_jobs`
   * recording the provenance.
   */
  regrade(trialId: string): Promise<Job>;
  /**
   * Stop selected in-flight trials without cancelling their job: each trial's
   * sandbox is killed and the trial is settled with its spend read from the
   * gateway. Only the caller's own trials; ids belonging to someone else are
   * reported in `not_found` (existence is never leaked). Idempotent —
   * already-terminal trials are reported as such and left untouched.
   */
  stop(trialIds: string[]): Promise<StopResponse>;
}

/** A key descriptor. The secret is never returned. */
export interface ApiKey {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Who the caller is and the key they used. */
export interface AuthStatus {
  user_id: string;
  email: string | null;
  key: ApiKey;
}

/**
 * Client for caller identity. The route is wave-gated — the server may still
 * answer not-found until its wave lands.
 */
export interface AuthClient {
  /** Identify the caller and the API key in use. */
  status(): Promise<AuthStatus>;
}

// =============================================================================
// ERROR VOCABULARY
// =============================================================================

/**
 * Every error code the hosted API can return, as a closed list.
 *
 * This exists so a typo cannot compile. `err.code === "insufficient_creidts"`
 * used to typecheck (code was `string`) and then silently never match, which is
 * the worst shape a bug can take: the branch looks handled and never runs.
 *
 * It mirrors the ErrorCode enum in spec/openapi.yaml and is published verbatim
 * at GET /api/meta as `error_codes`. A server newer than this SDK may send a
 * code that is not listed here — `EvolveApiError.code` widens to string for
 * exactly that case, so an unknown code is still readable, just not narrowable.
 *
 * Held to the spec by hosted-error-codes.json at the package root, the
 * checked-in copy both SDKs assert against; the list drifted silently before
 * that file existed. Adding a code means editing the spec, that file, this
 * list, and the Python pair.
 */
export const HOSTED_ERROR_CODES = [
  "missing_authorization",
  "invalid_api_key",
  "credential_service_unavailable",
  "rate_limited",
  "insufficient_credits",
  "invalid_json",
  "invalid_input",
  "invalid_limit",
  "invalid_status",
  "invalid_cursor",
  "invalid_after",
  "invalid_format",
  "invalid_ids",
  "invalid_multipart",
  "idempotency_key_reused",
  "dataset_not_found",
  "dataset_version_not_found",
  "dataset_name_taken",
  "dataset_in_use",
  "dataset_not_owned",
  "upstream_not_watchable",
  "no_active_version",
  "version_not_ready",
  "version_not_activatable",
  "unknown_task_names",
  "no_tasks",
  "agent_not_found",
  "agent_name_taken",
  "agent_name_reserved",
  "agent_invalid_name",
  "agent_source_required",
  "agent_source_conflict",
  "agent_invalid_env",
  "agent_too_large",
  "agent_limit_reached",
  "agent_version_not_found",
  "job_too_large",
  "provider_unsupported",
  "job_not_found",
  "job_not_terminal",
  "no_failed_trials",
  "trial_not_found",
  "concurrent_update",
  "regrade_source_ineligible",
  "no_regradable_trials",
  "import_not_found",
  "import_too_large",
  "invalid_archive",
  "package_not_retained",
  "package_corrupt",
  "package_missing",
  "internal_error",
] as const;

/** One of the API's stable error codes. */
export type HostedErrorCode = (typeof HOSTED_ERROR_CODES)[number];

/** True when `value` is a code this SDK version knows about (narrowing guard). */
export function isHostedErrorCode(value: unknown): value is HostedErrorCode {
  return (
    typeof value === "string" && (HOSTED_ERROR_CODES as readonly string[]).includes(value)
  );
}

// =============================================================================
// CAPABILITY DOCUMENT (GET /api/meta)
// =============================================================================

/** A closed vocabulary a client renders, with the members that end it. */
export interface StatusVocabulary {
  values: string[];
  /** Members after which nothing more happens — a watcher may stop here. */
  terminal: string[];
}

/** One built-in agent's declared capabilities. */
export interface AgentCapability {
  name: string;
  /** Whether job agents[].reasoning_effort reaches this agent. */
  effort_support: boolean;
  /** Whether job agents[].version may pin this agent. */
  version_pinnable: boolean;
  /**
   * Newest published version, for a "your pin is out of date" badge. Null
   * means "not known right now", never "up to date".
   */
  latest_version?: string | null;
}

/** One sandbox provider, its ceilings, and what it refuses. */
export interface ProviderCapability {
  name: string;
  default: boolean;
  sizing: {
    max_cpus: number;
    max_memory_mb: number;
    max_storage_mb: number;
    storage: "sized" | "fixed";
  };
  refuses: { capability: string; reason: string }[];
}

/**
 * One managed sandbox door and whether this deployment serves it — a
 * different question from ProviderCapability, which is about the eval lane.
 * A managed sandbox is one the caller drives directly holding nothing but an
 * Evolve key.
 */
export interface ManagedProviderCapability {
  name: string;
  /**
   * The operator config this door reads is present. NOT a health check: it
   * says nothing about whether the pass-through behind the door is deployed
   * or the credential behind it is valid.
   */
  configured: boolean;
  /** Config this door reads, so an operator sees what to set. */
  requires_config: string[];
  /** The subset of `requires_config` missing right now — empty when configured. */
  missing_config: string[];
  /** A full SDK agent session can run on this door. */
  agent_sessions: boolean;
  /** Why not, when `agent_sessions` is false. Null otherwise. */
  agent_sessions_reason: string | null;
}

/**
 * The capability document: everything a client would otherwise hardcode.
 *
 * Public and cacheable — no API key needed, so a signed-out page can populate
 * its own agent picker. `schema_version` bumps when a FIELD changes meaning,
 * never when a value changes.
 */
export interface CapabilityDocument {
  schema_version: number;
  /** Built-in agents and their declared capabilities. */
  agents: AgentCapability[];
  /** Rules a bring-your-own agent registration must satisfy. */
  agent_registration: {
    name_pattern: string;
    max_name_length: number;
    max_run_command_length: number;
    max_install_script_length: number;
    max_env_entries: number;
    max_per_user: number;
    max_upload_bytes: number;
    /** Built-in names a registration may not reuse. */
    reserved_names: string[];
    /** Env keys the platform owns; declaring one is refused at registration. */
    reserved_env_keys: string[];
  };
  sandbox_providers: ProviderCapability[];
  /** The managed doors this deployment serves, and what each can carry. */
  managed_providers: ManagedProviderCapability[];
  /** Constraints that hold on EVERY provider. */
  platform_constraints: { capability: string; reason: string }[];
  network_modes: string[];
  /** Every status vocabulary on the surface, with terminal members. */
  statuses: {
    job: StatusVocabulary;
    trial: StatusVocabulary;
    import: StatusVocabulary;
    dataset_version: StatusVocabulary;
  };
  limits: {
    job: {
      max_n_attempts: number;
      max_agents: number;
      max_trials: number;
      n_concurrent_trials: { default: number; max: number };
      default_max_trial_spend_usd: number;
      default_sandbox_provider: string;
      default_sizing: { cpus: number; memory_mb: number; storage_mb: number };
      /** Every agent must name a model; the server applies no default. */
      model_required: boolean;
      /**
       * Phase wall-clocks a task INHERITS when its own config declares none —
       * a task that declares its own always wins, so these fill in rather than
       * cap. Published because nothing else here says how long a trial may run.
       */
      default_agent_timeout_sec: number;
      default_verifier_timeout_sec: number;
      /** Values agents[].reasoning_effort accepts, and the one an omitted effort takes. */
      reasoning_efforts: string[];
      default_reasoning_effort: string;
    };
    compare: { min_ids: number; max_ids: number };
    pagination: {
      collections: { default: number; max: number };
      dataset_tasks: { default: number; max: number };
      trace_events: { default: number; max: number };
    };
    uploads: {
      dataset_archive_bytes: number;
      agent_tarball_bytes: number;
    };
    dataset_names: {
      pattern: string;
      max_name_length: number;
      max_version_length: number;
      max_git_url_length: number;
      max_git_ref_length: number;
    };
    /** How many items an error MESSAGE names before "and N more". */
    max_items_named_in_error_message: number;
  };
  /** The ImportWarning codes the platform can attach to an import. */
  import_warning_codes: string[];
  /** The closed error-code union, enumerated at runtime. */
  error_codes: string[];
}
