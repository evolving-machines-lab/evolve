/**
 * Public types for the hosted benchmarks/jobs API.
 */

/** Configuration for the benchmarks() / jobs() factories */
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

/** Benchmark version lifecycle state (wire values) */
export type BenchmarkVersionState =
  | "DRAFT"
  | "IMPORTING"
  | "BUILDING"
  | "VALIDATING"
  | "READY"
  | "FAILED"
  | "ARCHIVED";

/** One immutable version of a benchmark — one shape on every surface */
export interface BenchmarkVersion {
  version: string;
  state: BenchmarkVersionState;
  createdAt: string;
  taskCount: number;
}

/**
 * One provider's verdict for a task: runnable there, or refused with the
 * limitation named (e.g. a multi-container task on a provider that cannot
 * host its services, or declared resources above the provider's ceiling).
 */
export type TaskProviderVerdict = { ok: true } | { ok: false; reason: string };

/** Public task fields only — instructions, environments, and tests never leave the server */
export interface Task {
  taskKey: string;
  agentTimeoutSec: number;
  verifierTimeoutSec: number;
  /**
   * Where the task can run, per sandbox provider. Advisory for planning a
   * job's provider choice — creating a job whose tasks include
   * one refused on the chosen provider is rejected with the same reason, so
   * nothing is ever spent on a trial that cannot execute.
   */
  providers: Record<EvalSandboxProvider, TaskProviderVerdict>;
}

/**
 * A benchmark in the shared catalog.
 *
 * list() returns the summary fields; get() additionally populates versions,
 * selectedVersion, tasks, createdAt, and updatedAt.
 */
export interface Benchmark {
  name: string;
  title: string | null;
  description: string | null;
  /** The active version, or null when none is active */
  activeVersion: BenchmarkVersion | null;
  /** All versions, newest first (get() only) */
  versions?: BenchmarkVersion[];
  /** The version whose tasks are listed below (get() only) */
  selectedVersion?: BenchmarkVersion | null;
  /**
   * One page of the selected version's tasks (get() only). Paged like every
   * other collection: a SWE-bench-scale benchmark has thousands of tasks, so
   * pass { limit, cursor } to get() and follow nextCursor.
   */
  tasks?: Page<Task>;
  /**
   * Where this benchmark's git source points now, versus what its active
   * version was built from — the data behind a "new version available" badge.
   * Null when there is nothing to watch (an uploaded corpus, a seeded one, or
   * one imported before provenance was recorded); null is never "up to date".
   *
   * Nothing here imports anything. A new version is always a row you create.
   */
  upstream: UpstreamStatus | null;
  /** get() only */
  createdAt?: string;
  /** get() only */
  updatedAt?: string;
}

/**
 * A benchmark's active version resolved to a runnable shape.
 *
 * Unlike Benchmark, `version` and `tasks` are non-optional: benchmarks()
 * .getActive() throws NoActiveVersionError when there is no active version,
 * so callers never branch on a missing active version.
 */
export interface ActiveBenchmark {
  name: string;
  title: string | null;
  description: string | null;
  /** The active version (always present) */
  activeVersion: BenchmarkVersion;
  /** The active version string (identical to activeVersion.version) */
  version: string;
  /** One page of the active version's tasks */
  tasks: Page<Task>;
  /** All versions, newest first */
  versions: BenchmarkVersion[];
  createdAt: string;
  updatedAt: string;
}

/** One agent: harness + model (+ optional pinned harness version and effort) */
export interface JobAgent {
  /** A built-in harness ("claude", "codex", ...) or a registered custom harness name */
  harness: string;
  model: string;
  /**
   * Pin the harness version. Omitted (or null) resolves the latest at dispatch
   * time; the version that actually ran is recorded on every trial as
   * `resolvedHarnessVersion`. Rejected at creation when the pin is not an exact
   * version (`invalid_input`), when the version is not published
   * (`harness_version_not_found`), or when the harness is a custom one — those
   * are versioned by the content of their own source (`invalid_input`).
   */
  harnessVersion?: string | null;
  /**
   * How hard the model is asked to think. The accepted values are published at
   * `meta.limits.job.reasoningEfforts`, and omitted (or null) takes the value
   * published beside them as `defaultReasoningEffort` — read them from the
   * capability document rather than hardcoding either.
   *
   * PART OF THE AGENT'S IDENTITY, like the harness, the model and the version
   * pin: the same harness and model at "low" and at "high" are two systems,
   * they de-duplicate separately, and every trial echoes the effort back on
   * `trial.agent`. An effort a harness cannot apply is refused at creation
   * (`invalid_input`) rather than recorded and never sent — see
   * `HarnessCapability.effortSupport`.
   */
  reasoningEffort?: string | null;
}

/**
 * Sandbox provider a hosted job runs on. Named `EvalSandboxProvider` to
 * avoid colliding with the core SDK's `SandboxProvider` (the sandbox-abstraction
 * interface).
 */
export type EvalSandboxProvider = "e2b" | "daytona" | "modal";

/** Where a trial's verifier executed: a separate pristine box, or inside the agent box */
export type VerifierMode = "separate" | "shared";

/** The input contract for creating a job */
export interface JobInput {
  /**
   * Benchmark reference: "name@version" for a pinned run, or a bare "name" —
   * a bare name resolves server-side to the benchmark's active READY version.
   * Responses always echo the resolved "name@version".
   */
  benchmark: string;
  /** Task keys to run (omitted = every task of the version) */
  tasks?: string[];
  agents: JobAgent[];
  /** Runs per task x agent (default: 1) */
  runsPerTask?: number;
  /** Parallel trials (default: 1) */
  concurrency?: number;
  /**
   * Hard model-spend cap in USD for EACH TRIAL — the platform's only spend
   * enforcement, applied as the budget of the gateway key that trial runs on.
   * Optional: omitted, the server applies its own default ($200,
   * operator-tunable). The response echoes the RESOLVED cap either way, so an
   * omitted one is never invisible, and states the resulting worst case for
   * the job as a whole.
   */
  maxTrialSpendUsd?: number;
  /** Sandbox provider to run on (optional; server default: `e2b`) */
  sandboxProvider?: EvalSandboxProvider;
}

/**
 * Trial count histogram by status. EVERY status is present, zeros included, so
 * a status bar can be drawn straight off the response without hardcoding the
 * enum and discovering a new status only when a bar goes missing.
 */
export type TrialCounts = Record<TrialStatus, number>;

/** How many trials there are, and how they break down by status */
export interface TrialTally {
  total: number;
  byStatus: TrialCounts;
}

/**
 * Why a job FAILED — the same {code, message} grammar as an API failure, and
 * deliberately NOT under the key `error`, which on this surface means "this
 * request failed". `if (body.error) throw` stays correct on a healthy read of a
 * failed job.
 */
export interface JobFailure {
  /** Stable machine-readable cause, e.g. "job_execution_failed" */
  code: string;
  message: string;
}

/**
 * A job = tasks x agents x runsPerTask.
 *
 * ONE shape from every call — run, get, cancel, rerunFailed and each list row
 * are the same fields, so a job card renders from any of them without knowing
 * where it came from. Nothing here is optional and nothing is "get() only".
 */
export interface Job {
  id: string;
  status: JobStatus;
  /** "name@version" */
  benchmark: string;
  agents: JobAgent[];
  runsPerTask: number;
  concurrency: number;
  /** The resolved per-trial cap every trial of this job runs under */
  maxTrialSpendUsd: number;
  /**
   * The most this job can cost: its trial count times the per-trial cap. There
   * is no job-wide budget, so this product is the real ceiling — stated here
   * rather than left to you to multiply.
   */
  worstCaseSpendUsd: number;
  /** Sandbox provider this job runs on */
  sandboxProvider: EvalSandboxProvider;
  /** What the trials have actually spent so far (reporting, not a limit) */
  spentUsd: number;
  createdAt: string;
  updatedAt: string;
  /** Entity cardinality only — the parts of a job that have no status of their own */
  counts: { agents: number; tasks: number };
  /** How many trials, and the status histogram (all statuses, zeros included) */
  trials: TrialTally;
  /** Mean reward over SCORED trials only; null when none. Zero is a reward. */
  meanReward: number | null;
  /** Why the job FAILED, or null. Never the key `error` — see JobFailure. */
  failure: JobFailure | null;
  /** The job whose failed trials this one reruns; null for an original job */
  sourceJobId: string | null;
  /** True when the server replayed an existing job for this Idempotency-Key */
  idempotentReplay: boolean;
}

/**
 * Where a trial's spend figure came from.
 *
 *   "measured"              the platform's settled figure — final.
 *   "measured_provisional"  a real reading taken before the gateway finished
 *                           writing this trial's spend. It is a LOWER BOUND and
 *                           can only ever move UP; the platform re-reads and
 *                           finalizes it within about half an hour of the trial
 *                           settling. Treat it as "at least this much".
 *   "assumed_cap"           spend could not be measured at all, so the
 *                           per-trial cap is reported conservatively.
 *
 * Only "measured" is final. A freshly settled trial commonly shows one of the
 * other two for a few minutes.
 */
export type SpendSource = "measured" | "measured_provisional" | "assumed_cap";

/**
 * Open-ended per-harness detail recorded for a trial: bundle identity, token
 * counts, whatever the harness found worth keeping.
 *
 * SPEND IS NO LONGER HERE. spentUsd and spendSource are first-class fields of
 * Trial, because they are columns on the server rather than keys in an untyped
 * blob — so a client reads them off the trial and there is exactly one place
 * each fact is stated. The one spend-adjacent key that remains is the CAP,
 * which is history rather than a queryable dimension: it is the cap THIS
 * trial's key carried, which can differ from the job's current cap for a trial
 * settled before a change.
 */
export interface ModelUsage {
  /** The per-trial model-spend cap that applied to this trial */
  maxTrialSpendUsd?: number;
  [key: string]: unknown;
}

/** One task x one agent x one runNumber */
export interface Trial {
  id: string;
  taskKey: string;
  agent: JobAgent;
  /** 1-based user-requested run number */
  runNumber: number;
  status: TrialStatus;
  /** The reward-file reward; null until scored */
  reward: number | null;
  /** Named metrics map (reward.json sub-scores) */
  metrics: Record<string, number> | null;
  /** Phase where an infrastructure failure occurred, when status is a failure */
  failurePhase: string | null;
  /** Failure detail (truncated to 2000 chars in list responses) */
  failureDetail: string | null;
  /** Wall-clock per phase, e.g. { agentMs, verifyMs } */
  phaseTimingsMs: Record<string, number> | null;
  /** Open-ended per-harness detail (bundle identity, token counts). Never spend. */
  modelUsage: ModelUsage | null;
  /** Sandbox provider the trial executed on; null until it has executed */
  sandboxProvider: EvalSandboxProvider | null;
  /** Where the verifier ran; null until recorded */
  verifierMode: VerifierMode | null;
  /**
   * What this trial's model calls cost, in USD. NULL means the trial never ran
   * (QUEUED, CANCELLED) — never zero. Zero is a real measurement, and it only
   * appears when no gateway key was ever minted for the trial.
   */
  spentUsd: number | null;
  /** Whether spentUsd was measured or is the cap charged conservatively */
  spendSource: SpendSource | null;
  /**
   * A mid-run reading of this trial's spend, and a LOWER BOUND rather than its
   * cost. Two feeds raise it, and each misses what the other sees: the door
   * accumulates the gateway's per-response cost the moment a non-streaming
   * call completes (seconds fresh, but blind to streamed completions), and the
   * platform's ~120s key poll sees everything, 40-70s late. The row keeps
   * whichever bound is higher, only ever climbs while the trial runs, and
   * `liveSpendAt` says how fresh it is. Null is "no reading yet", never $0.
   *
   * CLEARED when the trial settles, on the same statement as the terminal
   * status: on a terminal trial read spentUsd and spendSource — those are the
   * settled truth, and the only one.
   */
  liveSpentUsd: number | null;
  /** When that reading was taken — show its age, never the figure alone */
  liveSpendAt: string | null;
  /** Harness version actually resolved and used for the trial; null until resolved */
  resolvedHarnessVersion: string | null;
  /**
   * WHERE THIS TRIAL RAN: the provider id of the box the agent executed in.
   * Null is honest and common — a QUEUED or CANCELLED trial never booted a
   * box. Also null from servers that predate the field.
   */
  sandboxId: string | null;
  /**
   * The separate box the verifier ran in. Null when the verifier ran inside
   * the agent's box (shared mode), when the trial never got that far, or from
   * servers that predate the field.
   */
  verifierSandboxId: string | null;
  /** Reference to the agent session/trace, when recorded */
  sessionRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields every job event carries, whatever its type. */
interface JobEventBase {
  /** Monotonic sequence number (SSE id; the Last-Event-ID resume position) */
  seq: number;
}

/** The job's resolved creation inputs, echoed so a watcher that joined late knows what it is watching. */
export interface JobCreatedData {
  /** Resolved "name@version", never the caller's bare name */
  benchmark: string;
  taskCount: number;
  agents: JobAgent[];
  runsPerTask: number;
  concurrency: number;
  maxTrialSpendUsd: number;
  sandboxProvider: EvalSandboxProvider;
  trialCount: number;
}

export interface JobCancellingData {
  jobId: string;
  /** Queued trials cancelled outright by the request */
  cancelledTrials: number;
  /** Trials still in flight, which wind down on their own before the job settles */
  activeTrials: number;
}

export interface JobCancelledData {
  jobId: string;
  /** Total queued trials cancelled across the request and the settle */
  cancelledTrials: number;
}

export interface JobCompletedData {
  jobId: string;
  /**
   * Always 0. Retained for wire compatibility: a QUEUED trial now blocks the
   * COMPLETED settle outright, so the "undispatched trial" concept has no
   * referent under trial-level claiming.
   */
  undispatched: number;
}

export interface TrialRunningData {
  trialId: string;
  taskKey: string;
}

export interface TrialScoringData {
  trialId: string;
  /** Bytes of agent stdout retained for the failure detail */
  capturedBytes: number;
}

/**
 * A mid-run spend sample landed on a still-live trial. Emitted only when the
 * reading actually updated a RUNNING/SCORING row, so a poll that raced the
 * settle never fires one.
 */
export interface TrialSpendData {
  trialId: string;
  taskKey: string;
  /** The same lagging lower bound as Trial.liveSpentUsd — not the trial's cost */
  liveSpentUsd: number;
}

/**
 * A trial reached a terminal status. `reward` is present only on the scored
 * path; `failurePhase` only on a failure. `attemptId`/`attemptPhase` appear
 * only when the REAPER settled the trial (its worker died), which is exactly
 * the case where knowing which attempt and which phase is worth having.
 */
export interface TrialSettledData {
  trialId: string;
  taskKey: string;
  status: TrialStatus;
  /** The reward-file reward. Zero is a reward; absent means the trial did not score. */
  reward?: number | null;
  failurePhase?: string;
  attemptId?: string;
  attemptPhase?: string | null;
}

/**
 * One server-sent event from jobs().watch(), as a DISCRIMINATED UNION on `type`.
 *
 * `data: Record<string, unknown>` was the worst-typed line in this SDK: it is
 * the payload of the headline docs example, and it told a reader nothing about
 * what a trial.settled actually carries. Switching on `type` now narrows `data`.
 *
 * Every member below was read off its emit site in the server, not inferred:
 *   job.created    api/jobs/route.ts, api/jobs/[id]/rerun-failed/route.ts
 *   job.running    worker/runner.ts, worker/reaper.ts
 *   job.cancelling api/jobs/[id]/cancel/route.ts
 *   job.cancelled  worker/settle.ts, api/jobs/[id]/cancel/route.ts
 *   job.completed  worker/settle.ts
 *   trial.*        worker/executor.ts, worker/runner.ts, worker/reaper.ts
 *
 * job.failed is declared terminal by the event stream and by this SDK, but NO
 * SERVER PATH EMITS IT and nothing sets a job's status to FAILED. It stays in
 * the union because both consumers already treat it as terminal — removing it
 * is the breaking half of a change nobody asked for — so treat it as RESERVED
 * rather than expected.
 */
export type JobEvent =
  | (JobEventBase & { type: "job.created"; data: JobCreatedData })
  | (JobEventBase & { type: "job.running"; data: { jobId: string } })
  | (JobEventBase & { type: "job.cancelling"; data: JobCancellingData })
  | (JobEventBase & { type: "job.cancelled"; data: JobCancelledData })
  | (JobEventBase & { type: "job.completed"; data: JobCompletedData })
  | (JobEventBase & { type: "job.failed"; data: { jobId: string } })
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
export interface JobWatch
  extends Awaitable<Job>,
    AsyncIterable<JobEvent> {}

/** Cursor page of jobs (newest first) */
export type JobPage = Page<Job>;

/**
 * The handle returned by jobs().list(). Both:
 * - a promise for a single JobPage — `await client.list({ limit })`
 *   returns one page (the original form); and
 * - an async iterable — `for await (const item of client.list())` walks every
 *   job across cursor pages, fetching the next page for you.
 */
export interface JobList
  extends Awaitable<JobPage>,
    AsyncIterable<Job> {}

/** Cursor page of trials */
export type TrialPage = Page<Trial>;

/**
 * The handle returned by jobs().trials(). Both:
 * - a promise for a single TrialPage — `await client.trials(id, { limit })`
 *   returns one page (the original form); and
 * - an async iterable — `for await (const trial of client.trials(id))` walks
 *   every trial across cursor pages, fetching the next page for you.
 */
export interface TrialList
  extends Awaitable<TrialPage>,
    AsyncIterable<Trial> {}

/** Cursor page of benchmarks */
export type BenchmarkPage = Page<Benchmark>;

/** Dual-use handle from benchmarks().list(): await one page, or iterate them all */
export interface BenchmarkList
  extends Awaitable<BenchmarkPage>,
    AsyncIterable<Benchmark> {}

/** Options for benchmarks().listImports() */
export interface ListImportsOptions extends PageOptions {
  /** Only imports in this status */
  status?: BenchmarkImportStatus;
  /** Only imports of this benchmark name */
  benchmark?: string;
}

/** Cursor page of benchmark imports */
export type BenchmarkImportPage = Page<BenchmarkImport>;

/** Dual-use handle from benchmarks().listImports(): await one page, or iterate them all */
export interface BenchmarkImportList
  extends Awaitable<BenchmarkImportPage>,
    AsyncIterable<BenchmarkImport> {}

/**
 * A custom-harness upsert body. Same shape as CustomHarnessInput minus `name`,
 * which the upsert takes as its first argument — the name is the resource
 * identity, not a field of it.
 */
export type CustomHarnessUpsertInput = CustomHarnessSourceInput & {
  /** Command run headless with `sh -c` at the task working directory */
  runCommand: string;
  /** Env injected at RUN time only; may not override the run contract's keys */
  env?: Record<string, string>;
};

/** Cursor page of custom harnesses */
export type CustomHarnessPage = Page<CustomHarness>;

/** Dual-use handle from customHarnesses().list(): await one page, or iterate them all */
export interface CustomHarnessList
  extends Awaitable<CustomHarnessPage>,
    AsyncIterable<CustomHarness> {}

// =============================================================================
// TRIAL DETAIL + TRACE
// =============================================================================

/**
 * Full detail of one trial — jobs().trial(id, trialId).
 * Same shape as a list row, plus the owning job; unlike list rows,
 * failureDetail is untruncated here.
 */
export interface TrialDetail extends Trial {
  /** The job this trial belongs to */
  jobId: string;
}

/** One trace event of a trial (seq-ordered timeline) */
export interface TrialTraceEvent {
  /** Monotonic sequence number (the ?after= resume position) */
  seq: number;
  /** Event type */
  type: string;
  data: Record<string, unknown>;
}

/**
 * One page of a trial's trace — jobs().trialTrace().
 *
 * Same envelope as every other collection, and nextCursor means the same
 * thing: pass it back as { cursor } for the next page, and NULL MEANS CAUGHT
 * UP. To resume a poll later, keep the last event's `seq` and pass it as
 * { cursor } — the trace's cursor IS its position in the seq timeline.
 */
export type TrialTracePage = Page<TrialTraceEvent>;

// =============================================================================
// COMPARE
// =============================================================================

/** Scored-trial coverage behind an aggregate (means cover SCORED trials only) */
export interface ComparisonCoverage {
  scored: number;
  total: number;
}

/**
 * One (taskKey x job) cell of the compare matrix. status is the shared
 * TrialStatus when the cell's trials agree, "MIXED" when they differ, and
 * "MISSING" when the job has no trials for the task.
 */
export interface ComparisonCell {
  jobId: string;
  status: TrialStatus | "MIXED" | "MISSING";
  /** Mean reward over the cell's SCORED trials; null when none. Zero is a reward. */
  meanReward: number | null;
  coverage: ComparisonCoverage;
}

/** One matrix row of jobs().compare(): a task across the compared jobs */
export interface ComparisonTaskRow {
  taskKey: string;
  /** True when the jobs' cells differ in status or reward for this task */
  disagreement: boolean;
  /** Cells in the caller's job-id order */
  cells: ComparisonCell[];
}

/** Per-job aggregate of jobs().compare() */
export interface ComparisonAggregate {
  id: string;
  /** "name@version" */
  benchmark: string;
  status: JobStatus;
  /** Mean reward over SCORED trials only; null when none. Zero is a reward. */
  meanReward: number | null;
  coverage: ComparisonCoverage;
  spentUsd: number;
  agents: JobAgent[];
  createdAt: string;
}

/**
 * Result of jobs().compare([ids]): per-job aggregates plus a
 * per-task matrix (disagreement rows first).
 */
export interface JobComparison {
  /** Aggregates in the caller's id order */
  jobs: ComparisonAggregate[];
  taskMatrix: ComparisonTaskRow[];
}

// =============================================================================
// REGRADE
// =============================================================================

/**
 * A regrade result's verdict status. Mirrors the reward law: a valid reward
 * (including 0) = SCORED; verifier crash/out-of-domain = SCORING_ERROR; no
 * reward file = INDETERMINATE; a verifier box lost before a durable verdict =
 * INFRASTRUCTURE_ERROR. QUEUED/RUNNING while the regrade is in flight.
 */
export type RegradeStatus =
  | "QUEUED"
  | "RUNNING"
  | "SCORED"
  | "SCORING_ERROR"
  | "INFRASTRUCTURE_ERROR"
  | "INDETERMINATE";

/** A regrade job's derived status: QUEUED until any result starts, then RUNNING, then COMPLETED. */
export type RegradeJobStatus = "QUEUED" | "RUNNING" | "COMPLETED";

/**
 * One regrade of one source trial: the verifier re-run against that trial's
 * RECORDED inputs, in a fresh separate verifier box. The agent phase is never
 * re-run, and the source trial is never modified — `sourceReward`/`sourceStatus`
 * are immutable snapshots taken when the regrade was created.
 */
export interface RegradeResult {
  /** Regrade result id */
  id: string;
  /** The source trial this regrade re-scored (immutable) */
  sourceTrialId: string;
  /** The source trial's task key */
  taskKey: string;
  status: RegradeStatus;
  /** The regrade's reward-file reward; null until scored */
  reward: number | null;
  /** Named metrics map (reward.json sub-scores) */
  metrics: Record<string, number> | null;
  /** The recorded source-trial reward at regrade time (immutable snapshot) */
  sourceReward: number | null;
  /** The recorded source-trial status at regrade time (immutable snapshot) */
  sourceStatus: string;
  /** reward − sourceReward when both are real numbers, else null (Harbor's per-trial delta) */
  rewardDelta: number | null;
  /** Where the verifier ran — always "separate" (regrade only re-runs separate verifiers) */
  verifierMode: VerifierMode;
  /**
   * Content digest of the resolved target verifier spec — the "verifier
   * version". A digest equal to the source trial's own verifier reproduces the
   * recorded reward; a different digest is a genuine new-verifier prediction.
   * Null until the regrade runs.
   */
  verifierDigest: string | null;
  /** Provider box id of the verifier sandbox, recorded for provenance */
  verifierSandboxId: string | null;
  failurePhase: string | null;
  failureDetail: string | null;
  phaseTimingsMs: Record<string, number> | null;
  createdAt: string;
  /** When the regrade settled; null while QUEUED/RUNNING */
  settledAt: string | null;
}

/** The filter applied when selecting source trials for a per-job regrade */
export interface RegradeFilter {
  status?: string[];
  taskKey?: string;
}

/**
 * A regrade job's results: how many there are in the WHOLE job, how they break
 * down by status (every status, zeros included), and one page of them.
 *
 * One key named for the collection rather than a `counts` object sitting beside
 * a separately-named array — and paged, because a regrade of a 10,000-trial job
 * holds 10,000 results.
 */
export interface RegradeResultsPage extends Page<RegradeResult> {
  /** Results in the whole job, not in this page */
  total: number;
  byStatus: Record<RegradeStatus, number>;
}

/**
 * A regrade job = a collection of regrade results. A per-trial regrade holds
 * one result; a per-job regrade holds one per eligible source trial. The
 * job's `status` is derived from the whole result set, never from one page.
 */
export interface RegradeJob {
  id: string;
  /** The job the source trials belong to */
  sourceJobId: string;
  status: RegradeJobStatus;
  /** Sandbox provider the verifier boxes run on (copied from the source job) */
  sandboxProvider: EvalSandboxProvider;
  /** The filter applied to select source trials (per-job regrade), or null */
  filter: RegradeFilter | null;
  /** How many results, their status histogram, and one page of them */
  results: RegradeResultsPage;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// BENCHMARK IMPORT
// =============================================================================

/**
 * Source for benchmarks().import(): EITHER a git repository pinned to a ref, OR
 * a local corpus directory (tarred deterministically on the client and
 * uploaded).
 *
 * A UNION, not three optional fields. The old shape accepted `{}` and accepted
 * both branches at once and threw at run time — exactly where a first-time user
 * errs, and the one place a type could have said so first. `?: never` on the
 * absent branch's keys is what makes `{ gitUrl, directory }` a compile error
 * rather than a run-time one; a bare union would happily accept the excess
 * property through a variable.
 *
 * Note that `ref` is REQUIRED on the git branch. It always was, in the sense
 * that the server refuses without it — the type simply used to disagree.
 */
export type BenchmarkImportSource =
  | {
      /**
       * A git repository URL. https:// only — the import runs on a worker with
       * no ssh client, so ssh:// and git@ remotes are refused at validation.
       * For a private repository, put a token in the https url.
       */
      gitUrl: string;
      /** A pinned branch, tag, or commit. Required: an unpinned import is not reproducible. */
      ref: string;
      directory?: never;
    }
  | {
      /** A local Harbor-layout corpus directory — tarred + gzipped and uploaded. */
      directory: string;
      gitUrl?: never;
      ref?: never;
    };

/** Input for benchmarks().import() */
export interface BenchmarkImportInput {
  source: BenchmarkImportSource;
  /** Catalog benchmark name the import creates or extends */
  benchmarkName: string;
  /** Version label for the imported benchmark version */
  version: string;
}

/**
 * Benchmark import job status.
 *
 * These are the SAME four words a job and a regrade use, and that is the point:
 * an import used to speak a private IMPORTING/IMPORTED/FAILED vocabulary, so a
 * status chip rendering all three had to carry a translation table for three
 * spellings of the same four ideas.
 *
 * Terminal: "COMPLETED" (the corpus landed as a benchmark version; it becomes
 * runnable once the platform activates it) and "FAILED".
 */
export type BenchmarkImportStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

/**
 * A benchmark import job. Terminal statuses: "COMPLETED" and "FAILED".
 *
 * Self-describing: every response names the benchmark@version being imported,
 * and every route that returns one — the 202 from import(), getImport(), and
 * listImports() — returns this same shape, so a caller can render the row it
 * just created without a follow-up read.
 */
export interface BenchmarkImport {
  /** Import job id */
  id: string;
  /** Job status */
  status: BenchmarkImportStatus;
  /** Catalog benchmark name the import creates or extends */
  benchmarkName: string;
  /** Version label of the imported version */
  version: string;
  /**
   * Why the import failed, when status is "FAILED"; null otherwise.
   *
   * Named `failure` and NOT `error`, deliberately: `error` is the key the
   * FAILURE envelope uses, so the obvious client idiom `if (body.error) throw`
   * has to stay correct on a perfectly healthy read of a failed import.
   */
  failure: BenchmarkImportFailure | null;
  /** Number of tasks parsed, once counted */
  taskCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Structured failure detail for a FAILED import. */
export interface BenchmarkImportFailure {
  /** Stable machine-readable cause; "import_failed" when none was recorded. */
  code: string;
  /** What went wrong, e.g. "2/113 task(s) failed to parse" */
  message: string;
  /** Per-task parse/validation failures, when the corpus was reachable */
  failures?: { taskKey: string; error: string }[];
}

// =============================================================================
// CUSTOM HARNESSES
// =============================================================================

/**
 * Where a custom harness's executables came from: a publicly fetchable install
 * script run in a throwaway builder sandbox, or a tarball uploaded from a local
 * directory. Echoed on every response; the SDK never guesses it.
 */
export type CustomHarnessSource = "install_script" | "tarball";

/**
 * A private harness registered by the caller. Once registered, its `name` is
 * usable in `agents[].harness` exactly like a built-in ("claude",
 * "codex", ...).
 *
 * Private to its owner: another user's name reads as
 * `custom_harness_not_found`, never as a permission error — existence is never
 * leaked.
 */
export interface CustomHarness {
  /** The harness name to put in agents[].harness */
  name: string;
  /** How the executables were produced */
  source: CustomHarnessSource;
  /** The command run headless with `sh -c` at the task working directory */
  runCommand: string;
  /**
   * Caller-declared env injected at RUN time only. It may not override the run
   * contract's own keys (see the docs) — the server rejects that at
   * registration with `custom_harness_invalid_env`.
   */
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/**
 * The two sources a custom harness's executables can come from. A union, not
 * two optional fields — see BenchmarkImportSource for why `?: never` is
 * load-bearing rather than decorative.
 */
export type CustomHarnessSourceInput =
  | {
      /**
       * The install script itself (not a path). It runs in a throwaway builder
       * sandbox that has internet and ZERO secrets, so everything it fetches
       * must be publicly fetchable, and it must leave executables in
       * `$PREFIX/bin`.
       */
      installScript: string;
      directory?: never;
    }
  | {
      /**
       * A local directory holding the harness — tarred + gzipped and uploaded.
       * Same build rules as an install script.
       */
      directory: string;
      installScript?: never;
    };

/**
 * Input for customHarnesses().create(): a name, a run command, and EXACTLY ONE
 * source. The source half is a union, so omitting both or passing both is a
 * compile error rather than a 400 the caller discovers at run time.
 */
export type CustomHarnessInput = CustomHarnessSourceInput & {
  /** Harness name; also the value used later in agents[].harness */
  name: string;
  /** Command run headless with `sh -c` at the task working directory */
  runCommand: string;
  /** Env injected at RUN time only; may not override the run contract's keys */
  env?: Record<string, string>;
};

// =============================================================================
// OPTIONS
// =============================================================================

/** Options for jobs().run() and rerunFailed() */
export interface RunJobOptions {
  /**
   * Idempotency-Key header value: retries with the same key return the
   * original job (idempotentReplay: true) instead of creating a new one.
   */
  idempotencyKey?: string;
}

/** Options for jobs().list() (default page 50, max 200) */
export interface ListJobsOptions extends PageOptions {}

/** Options for jobs().trials() (default page 50, max 200) */
export interface ListTrialsOptions extends PageOptions {
  /** Only trials in these statuses (e.g. the failures behind a rerun decision) */
  status?: TrialStatus[];
}

/** Options for benchmarks().list() (default page 50, max 200) */
export interface ListBenchmarksOptions extends PageOptions {}

/** Options for customHarnesses().list() (default page 50, max 200) */
export interface ListCustomHarnessesOptions extends PageOptions {}

/** Options for benchmarks().get() / getActive(): pages the TASK list (default 200, max 500) */
export interface GetBenchmarkOptions extends PageOptions {}

/** Options for jobs().regradeJob(): pages the RESULT list (default 50, max 200) */
export interface RegradeJobOptions extends PageOptions {}

/** Options for jobs().listRegrades() (default page 50, max 200) */
export interface ListRegradesOptions extends PageOptions {
  /** Only regrades of this job (the SOURCE job's id) */
  jobId?: string;
}

/** Cursor page of regrade jobs */
export type RegradePage = Page<RegradeJob>;

/**
 * The handle returned by jobs().listRegrades(). Both:
 * - a promise for a single RegradePage — `await client.listRegrades()` returns
 *   one page; and
 * - an async iterable — `for await (const regrade of client.listRegrades())`
 *   walks every regrade across cursor pages, fetching the next page for you.
 */
export interface RegradeList
  extends Awaitable<RegradePage>,
    AsyncIterable<RegradeJob> {}

/**
 * Options for jobs().regrade() (per-job): narrow the set of
 * source trials. A trial is regradable only if it recorded separate-mode verifier
 * inputs; these filters further restrict that set.
 */
export interface RegradeOptions {
  /** Only regrade source trials in these statuses */
  status?: TrialStatus[];
  /** Only regrade source trials of this task */
  taskKey?: string;
}

/** Options for jobs().trialTrace() and trialTraceEvents() */
export interface TrialTraceOptions extends PageOptions {
  /**
   * Resume position: events with seq strictly greater than this cursor (omit =
   * from the beginning). A trace cursor IS a seq, so to resume a poll later
   * pass the last event's `seq` here as a string.
   */
  cursor?: string;
  /** Max events per page (server default: 200, max: 1000) */
  limit?: number;
}

/** Options for benchmarks().watchImport() */
export interface WatchImportOptions {
  /** Called on every observed status change (including the first status seen) */
  onStatus?: (benchmarkImport: BenchmarkImport) => void;
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

/** Options for benchmarks().downloadPackage() */
export interface DownloadPackageOptions {
  /** Directory to save the package into (returns the file path) */
  to?: string;
  /** Return the raw response stream instead of a Buffer */
  stream?: boolean;
}

/** Options for jobs().export() */
export interface ExportJobOptions {
  /** Directory to save the archive into (returns the file path) */
  to?: string;
  /** Return the raw response stream instead of a Buffer */
  stream?: boolean;
  /**
   * Export layout. Omit for the canonical research archive; "harbor" requests
   * the Harbor job-layout bundle (?format=harbor on the export endpoint).
   */
  format?: "harbor";
}

// =============================================================================
// CLIENTS
// =============================================================================

/** Client for the shared benchmark catalog */
export interface BenchmarksClient {
  /**
   * List benchmarks with their active versions (cursor-paged). Await the
   * result for one page, or `for await` it to walk the whole catalog.
   */
  list(options?: ListBenchmarksOptions): BenchmarkList;
  /**
   * Get one benchmark: all versions + one page of the selected version's tasks.
   * ref is "name" (active version's tasks) or "name@version"; { limit, cursor }
   * page the tasks.
   */
  get(ref: string, options?: GetBenchmarkOptions): Promise<Benchmark>;
  /**
   * Get a benchmark's active version resolved to a runnable shape: unlike
   * get(), `version` and `tasks` are guaranteed present. Throws
   * NoActiveVersionError when the benchmark has no active version. Use get()
   * for the full multi-version detail with optional fields.
   */
  getActive(name: string, options?: GetBenchmarkOptions): Promise<ActiveBenchmark>;
  /**
   * Start a benchmark import job from a git source pinned to a ref.
   * Returns immediately; poll with getImport()/watchImport().
   */
  import(input: BenchmarkImportInput): Promise<BenchmarkImport>;
  /** Get an import job's status (error and taskCount when available) */
  getImport(id: string): Promise<BenchmarkImport>;
  /**
   * Poll getImport() until the job reaches a terminal status ("IMPORTED" or
   * "FAILED") and resolve with the final import.
   */
  watchImport(id: string, options?: WatchImportOptions): Promise<BenchmarkImport>;
  /**
   * List the caller's own imports, newest first (cursor-paged). This is how you
   * find an import again after losing the id that import() returned — without
   * it, closing a tab made a running import permanently unwatchable.
   *
   * Await for one page, or `for await` to walk them all. { status } filters on
   * the import vocabulary ("IMPORTING" | "IMPORTED" | "FAILED"); { benchmark }
   * narrows to one benchmark name.
   */
  listImports(options?: ListImportsOptions): BenchmarkImportList;
  /**
   * Download the ORIGINAL corpus package a version was imported from — the
   * gzipped tarball you uploaded, or, for a git import, the checked-out tree
   * packed at import time. `id` is the import id (what import() returned).
   *
   * OWNER ONLY. This is the one call that returns task files, and it returns
   * them only to the account that owns the benchmark; a platform-curated
   * benchmark has no owner, so nobody can download it. Someone else's import is
   * a plain `import_not_found`, never a 403.
   *
   * The server verifies the stored bytes against their recorded sha256 before
   * sending anything, so a successful call is byte-identical to what was
   * imported.
   *
   * A version imported before packages were retained has none, and it cannot be
   * reconstructed: that is `package_not_retained`, distinct from "not found" so
   * you can say so. Re-import the corpus as a new version to get one.
   *
   * Default: Buffer. { to } saves into a directory and returns the file path.
   * { stream: true } returns the raw response stream.
   */
  downloadPackage(id: string): Promise<Buffer>;
  downloadPackage(id: string, options: { to: string }): Promise<string>;
  downloadPackage(
    id: string,
    options: { stream: true }
  ): Promise<ReadableStream<Uint8Array>>;
  downloadPackage(
    id: string,
    options?: DownloadPackageOptions
  ): Promise<Buffer | string | ReadableStream<Uint8Array>>;
  /**
   * Delete a benchmark you own, with every version, task, and archived
   * solution. Refused (benchmark_in_use) while any job still references it —
   * a benchmark is never deleted out from under a job that measured against it,
   * and `err.details.sampleJobIds` names the jobs blocking it. A platform
   * benchmark is refused with benchmark_not_owned; a name you cannot see is a
   * plain not-found.
   */
  delete(name: string): Promise<void>;
}

/** Client for the caller's own private (bring-your-own) harnesses */
export interface CustomHarnessesClient {
  /**
   * Register a private harness. Provide either an install script
   * (`{ installScript }`) or a local directory (`{ directory }`), never both.
   * The name is then usable in `agents[].harness` like a built-in.
   */
  create(input: CustomHarnessInput): Promise<CustomHarness>;
  /**
   * List the caller's registered custom harnesses (cursor-paged). Await the
   * result for one page, or `for await` it to walk them all.
   */
  list(options?: ListCustomHarnessesOptions): CustomHarnessList;
  /** Get one custom harness by name */
  get(name: string): Promise<CustomHarness>;
  /** Delete a custom harness. Past jobs keep their recorded harness. */
  delete(name: string): Promise<void>;
  /**
   * Register or replace a harness in ONE call, under the name you give.
   *
   * Use this instead of delete()+create() to change an existing registration:
   * the pair leaves a window where the harness does not exist, and anything
   * naming it in that window fails for a change that was only ever meant to be
   * an edit. This is a full replacement, not a patch — every field comes from
   * this call, and an omitted `env` becomes empty.
   */
  upsert(name: string, input: CustomHarnessUpsertInput): Promise<CustomHarness>;
}

/** Client for hosted jobs */
export interface JobsClient {
  /**
   * Create a job. benchmark may be a bare "name" (resolved to the
   * active READY version) or a pinned "name@version". Supports Idempotency-Key.
   */
  run(input: JobInput, options?: RunJobOptions): Promise<Job>;
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
  /** Get one trial's full detail (untruncated failureDetail) */
  trial(id: string, trialId: string): Promise<TrialDetail>;
  /** Get one page of a trial's trace; resume with { cursor: page.nextCursor } */
  trialTrace(
    id: string,
    trialId: string,
    options?: TrialTraceOptions
  ): Promise<TrialTracePage>;
  /**
   * Iterate a trial's trace events, fetching pages under the hood until
   * the currently available trace is drained. Resume later by passing the
   * last seen seq as { cursor }.
   */
  trialTraceEvents(
    id: string,
    trialId: string,
    options?: TrialTraceOptions
  ): AsyncIterableIterator<TrialTraceEvent>;
  /**
   * One RAW trace artifact, by the trace route's ?stream= selector.
   * "verifier" | "trace-stdout" | "trace-stderr" answer the log text;
   * "agent-home" answers the CLI's whole home folder (subagent transcripts
   * included), keyed by sandbox path. Null = never stored
   * (a normal answer, not an error).
   */
  trialArtifact(
    id: string,
    trialId: string,
    stream: "verifier" | "trace-stdout" | "trace-stderr"
  ): Promise<string | null>;
  trialArtifact(
    id: string,
    trialId: string,
    stream: "agent-home"
  ): Promise<Record<string, string> | null>;
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
   * Create a NEW linked job of only the failed (and never-dispatched)
   * trials of a terminal job. Supports Idempotency-Key.
   */
  rerunFailed(id: string, options?: RunJobOptions): Promise<Job>;
  /**
   * Regrade a terminal job: re-run the verifier of every REGRADABLE trial
   * (settled separate-mode trials, which recorded their verifier inputs) against
   * those recorded inputs, in fresh separate verifier boxes. The agent phase is
   * never re-run and the source trials are never modified. `options` narrows the
   * set by status and/or task. Returns a new regrade job (one result per trial).
   */
  regrade(id: string, options?: RegradeOptions): Promise<RegradeJob>;
  /**
   * Regrade one settled trial: re-run its verifier against its recorded
   * inputs in a fresh separate verifier box. Refused (regrade_source_ineligible)
   * for shared-mode or pre-persistence trials. Returns a regrade job with one
   * result.
   */
  regradeTrial(id: string, trialId: string): Promise<RegradeJob>;
  /**
   * Read ONE regrade job by the REGRADE's id (the id returned by regrade() or
   * regradeTrial(), and echoed in their Location header) — with one page of its
   * per-trial results, their lineage and reward deltas.
   *
   * Renamed from regradeJob(). That name read as a verb, sat directly beside
   * regrade() which IS that verb, and took a parameter called jobId that was
   * not a job id — so the natural call, regradeJob(someJobId), compiled and
   * 404'd.
   */
  getRegrade(regradeId: string, options?: RegradeJobOptions): Promise<RegradeJob>;
  /**
   * List the caller's regrade jobs, newest first (cursor-paged); { jobId }
   * narrows to the regrades OF ONE JOB — the question regradeJob(jobId) looked
   * like it answered and did not. Await for one page, or `for await` to walk
   * them all.
   */
  listRegrades(options?: ListRegradesOptions): RegradeList;
  /**
   * Side-by-side comparison of 2-5 owned jobs: per-job
   * aggregates plus a per-task matrix with disagreement rows first.
   */
  compare(ids: string[]): Promise<JobComparison>;
  /**
   * Download the full research archive (gzipped JSON) of a terminal
   * job. Default: Buffer. { to } saves to a directory and returns the
   * file path. { stream: true } returns the raw response stream.
   * { format: "harbor" } selects the Harbor job-layout bundle instead of the
   * canonical archive (composable with any of the delivery shapes).
   */
  export(id: string, options?: { format?: "harbor" }): Promise<Buffer>;
  export(id: string, options: { to: string; format?: "harbor" }): Promise<string>;
  export(
    id: string,
    options: { stream: true; format?: "harbor" }
  ): Promise<ReadableStream<Uint8Array>>;
  export(
    id: string,
    options?: ExportJobOptions
  ): Promise<Buffer | string | ReadableStream<Uint8Array>>;
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
 * It mirrors HOSTED_API_ERROR_CODES on the server and is published verbatim at
 * GET /api/meta as `errorCodes`. A server newer than this SDK may send a code
 * that is not listed here — `EvolveApiError.code` widens to string for exactly
 * that case, so an unknown code is still readable, just not narrowable.
 *
 * Held to the server's list by hosted-error-codes.json at the package root, the
 * checked-in copy the dashboard regenerates and both SDKs assert against; the
 * list drifted silently before that file existed. Adding a code means editing
 * the server array, that file, this list, and the Python pair.
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
  "benchmark_not_found",
  "benchmark_version_not_found",
  "benchmark_name_taken",
  "benchmark_in_use",
  "benchmark_not_owned",
  "upstream_not_watchable",
  "no_active_version",
  "version_not_ready",
  "unknown_task_keys",
  "no_tasks",
  "custom_harness_not_found",
  "custom_harness_name_taken",
  "custom_harness_name_reserved",
  "custom_harness_invalid_name",
  "custom_harness_source_required",
  "custom_harness_source_conflict",
  "custom_harness_invalid_env",
  "custom_harness_too_large",
  "custom_harness_limit_reached",
  "harness_version_not_found",
  "job_too_large",
  "provider_unsupported",
  "job_not_found",
  "job_not_terminal",
  "no_failed_runs",
  "trial_not_found",
  "concurrent_update",
  "regrade_source_ineligible",
  "no_regradable_runs",
  "regrade_not_found",
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
  description: string;
}

/** One model a harness can drive. */
export interface HarnessModel {
  alias: string;
  modelId: string;
  description: string | null;
}

/** One harness the platform can run. */
export interface HarnessCapability {
  name: string;
  /** false = registered but not runnable; `reason` says why. */
  runnable: boolean;
  reason: string | null;
  /**
   * What the local SDK would run if no model were named. The hosted API always
   * requires an explicit model, so this is a picker's pre-selection, not a
   * server-side default.
   */
  defaultModel: string | null;
  models: HarnessModel[];
  /**
   * What this harness does with `agents[].reasoningEffort`: "level" = the value
   * reaches the CLI as one, "binary" = thinking on/off only (a level is refused
   * at creation), "none" = no effort input at all (any effort is refused). Grey
   * the control out instead of learning the refusal from a POST.
   */
  effortSupport: "level" | "binary" | "none";
  /** Whether `agents[].harnessVersion` may pin this harness. */
  versionPinnable: boolean;
  /**
   * Newest published version, for a "your pin is out of date" badge. Null means
   * "not known right now", never "up to date".
   */
  latestVersion: string | null;
}

/** One sandbox provider, its ceilings, and what it refuses. */
export interface ProviderCapability {
  name: string;
  default: boolean;
  sizing: {
    maxCpus: number;
    maxMemoryMb: number;
    maxStorageMb: number;
    storage: "sized" | "fixed";
  };
  refuses: { capability: string; reason: string }[];
}

/**
 * The capability document: everything a client would otherwise hardcode.
 *
 * Public and cacheable — no API key needed, so a signed-out page can populate
 * its own harness picker.
 */
export interface CapabilityDocument {
  /** Bumped when a FIELD changes meaning, never when a value changes. */
  schemaVersion: number;
  harnesses: HarnessCapability[];
  customHarnesses: {
    namePattern: string;
    maxNameLength: number;
    maxRunCommandLength: number;
    maxInstallScriptLength: number;
    maxEnvEntries: number;
    maxPerUser: number;
    maxUploadBytes: number;
    /** Built-in names a registration may not reuse. */
    reservedNames: string[];
    /** Env keys the platform owns; declaring one is refused at registration. */
    reservedEnvKeys: string[];
  };
  sandboxProviders: ProviderCapability[];
  /** Constraints that hold on EVERY provider. */
  platformConstraints: { capability: string; reason: string }[];
  networkModes: string[];
  statuses: {
    job: StatusVocabulary;
    trial: StatusVocabulary;
    import: StatusVocabulary;
    regradeJob: StatusVocabulary;
    regradeResult: StatusVocabulary;
    benchmarkVersion: StatusVocabulary;
  };
  limits: {
    job: {
      maxRunsPerTask: number;
      maxAgents: number;
      maxTrials: number;
      concurrency: { default: number; max: number };
      defaultMaxTrialSpendUsd: number;
      defaultSandboxProvider: string;
      defaultSizing: { cpus: number; memoryMb: number; storageMb: number };
      /** Every agent must name a model; the server applies no default. */
      modelRequired: boolean;
      /**
       * Phase wall-clocks a task INHERITS when its own config declares none —
       * a task that declares its own always wins, so these fill in rather than
       * cap. Published because nothing else here says how long a trial may run.
       */
      defaultAgentTimeoutSec: number;
      defaultVerifierTimeoutSec: number;
      /** Values `agents[].reasoningEffort` accepts, and the one an omitted effort takes. */
      reasoningEfforts: string[];
      defaultReasoningEffort: string;
    };
    pagination: {
      collections: { default: number; max: number };
      benchmarkTasks: { default: number; max: number };
      regradeResults: { default: number; max: number };
    };
    uploads: {
      benchmarkArchiveBytes: number;
      customHarnessTarballBytes: number;
    };
    benchmarkNames: {
      pattern: string;
      maxNameLength: number;
      maxVersionLength: number;
      maxGitUrlLength: number;
      maxGitRefLength: number;
    };
    /** How many items an error MESSAGE names before "and N more". */
    maxItemsNamedInErrorMessage: number;
  };
  errorCodes: string[];
}

// =============================================================================
// UPSTREAM (version awareness)
// =============================================================================

/**
 * Where a benchmark's git source points now, versus what its active version was
 * built from. Null on a benchmark whose source cannot be re-resolved — an
 * uploaded corpus, a seeded one, or one imported before provenance was
 * recorded. Null is "nothing to watch", never "up to date".
 */
export interface UpstreamStatus {
  /** The ref the active version was imported from. */
  ref: string;
  /** The commit the active version was built from. */
  currentCommit: string;
  /** Where the ref points upstream now; null when the last check failed. */
  latestCommit: string | null;
  /** True when upstream has moved off the built-from commit. Branch on this. */
  moved: boolean;
  /**
   * Always null today. Counting commits between two SHAs needs the commit
   * graph, i.e. a real fetch per benchmark per check; the watcher deliberately
   * only does a reference advertisement. Reserved so a host comparison API
   * could fill it later without a wire change.
   */
  behindBy: number | null;
  /** When the cached answer was taken; null before the first check. */
  checkedAt: string | null;
  /** Why the last check failed. Show "could not check", not "up to date". */
  error: string | null;
}
