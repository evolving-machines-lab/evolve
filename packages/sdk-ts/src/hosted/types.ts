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
  /** Tasks of the selected version (get() only) */
  tasks?: Task[];
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
  /** Tasks of the active version */
  tasks: Task[];
  /** All versions, newest first */
  versions: BenchmarkVersion[];
  createdAt: string;
  updatedAt: string;
}

/** One agent: harness + model (+ optional pinned harness version) */
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

/** Trial count histogram by status */
export type TrialCounts = Partial<Record<TrialStatus, number>>;

/**
 * A job = tasks x agents x runsPerTask.
 *
 * Every shape (run/get/cancel/rerunFailed/list) carries counts; get() and
 * list() additionally return trialCounts and meanReward, and get() the
 * detail fields (agents, error, updatedAt).
 */
export interface Job {
  id: string;
  status: JobStatus;
  /** "name@version" */
  benchmark: string;
  /** get() only */
  agents?: JobAgent[];
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
  /** Job size: agents x tasks -> trials (present on every shape) */
  counts: { agents: number; tasks: number; trials: number };
  /** Trial histogram by status (get/list) */
  trialCounts?: TrialCounts;
  /** Mean reward over SCORED trials only; null when none. Zero is a reward. (get/list) */
  meanReward?: number | null;
  /** get() only */
  error?: string | null;
  /** get() only */
  updatedAt?: string;
  /** Present on rerun-failed jobs: the job the failed trials came from */
  sourceJobId?: string;
  /** True when the server replayed an existing job for this Idempotency-Key */
  idempotentReplay?: boolean;
}

/**
 * Where a trial's spend figure came from: "measured" is the measured model
 * spend reported by the platform; "assumed_cap" means spend could not be
 * measured for this trial, so the per-trial cap is reported.
 */
export type SpendSource = "measured" | "assumed_cap";

/**
 * Model usage/spend recorded for a trial — purely spend/usage, in the one
 * money vocabulary (the cap is maxTrialSpendUsd, actuals are spentUsd). Open
 * map: harness-specific keys may appear.
 */
export interface ModelUsage {
  /** Model spend in USD for this trial */
  spentUsd?: number;
  /** Where the spend figure came from */
  spendSource?: SpendSource;
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
  modelUsage: ModelUsage | null;
  /** Sandbox provider the trial executed on; null until it has executed */
  sandboxProvider: EvalSandboxProvider | null;
  /** Where the verifier ran; null until recorded */
  verifierMode: VerifierMode | null;
  /** Harness version actually resolved and used for the trial; null until resolved */
  resolvedHarnessVersion: string | null;
  /** Reference to the agent session/trace, when recorded */
  sessionRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One server-sent event from jobs().watch() */
export interface JobEvent {
  /** Monotonic sequence number (SSE id; the Last-Event-ID resume position) */
  seq: number;
  /** Event type, e.g. "job.created", "trial.settled", "job.completed" */
  type: string;
  data: Record<string, unknown>;
}

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
  extends PromiseLike<Job>,
    AsyncIterable<JobEvent> {}

/** Cursor page of jobs (newest first) */
export interface JobPage {
  jobs: Job[];
  nextCursor: string | null;
}

/**
 * The handle returned by jobs().list(). Both:
 * - a promise for a single JobPage — `await client.list({ limit })`
 *   returns one page (the original form); and
 * - an async iterable — `for await (const item of client.list())` walks every
 *   job across cursor pages, fetching the next page for you.
 */
export interface JobList
  extends PromiseLike<JobPage>,
    AsyncIterable<Job> {}

/** Cursor page of trials */
export interface TrialPage {
  trials: Trial[];
  nextCursor: string | null;
}

/**
 * The handle returned by jobs().trials(). Both:
 * - a promise for a single TrialPage — `await client.trials(id, { limit })`
 *   returns one page (the original form); and
 * - an async iterable — `for await (const trial of client.trials(id))` walks
 *   every trial across cursor pages, fetching the next page for you.
 */
export interface TrialList
  extends PromiseLike<TrialPage>,
    AsyncIterable<Trial> {}

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

/** One seq-paged slice of a trial's trace — jobs().trialTrace() */
export interface TrialTracePage {
  events: TrialTraceEvent[];
  /**
   * Resume position: pass back as { after } to continue. An empty page echoes
   * the requested position (null when reading an empty trace from the start).
   */
  nextAfter: number | null;
}

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
 * A regrade job = a collection of regrade results. A per-trial regrade holds
 * one result; a per-job regrade holds one per eligible source trial. The
 * job's `status` is derived from its results. `results` is present on the read
 * (regradeJob) and create responses.
 */
export interface RegradeJob {
  id: string;
  /** The job the source trials belong to */
  sourceJobId: string;
  status: RegradeJobStatus;
  /** Sandbox provider the verifier boxes run on (independent of the source) */
  sandboxProvider: EvalSandboxProvider;
  /** The filter applied to select source trials (per-job regrade), or null */
  filter: RegradeFilter | null;
  counts: {
    results: number;
    /** Result histogram by RegradeStatus */
    byStatus: Partial<Record<RegradeStatus, number>>;
  };
  createdAt: string;
  updatedAt: string;
  /** The per-trial regrade results */
  results?: RegradeResult[];
}

// =============================================================================
// BENCHMARK IMPORT
// =============================================================================

/**
 * Source for benchmarks().import(): EITHER a git repository pinned to a ref, OR
 * a local corpus directory (tarred deterministically on the client and
 * uploaded). Provide `{ gitUrl, ref }` or `{ directory }`, not both.
 */
export interface BenchmarkImportSource {
  /** A git repository URL — pair with `ref`. */
  gitUrl?: string;
  /** A pinned branch, tag, or commit — pair with `gitUrl`. */
  ref?: string;
  /** A local Harbor-layout corpus directory — tarred + gzipped and uploaded. */
  directory?: string;
}

/** Input for benchmarks().import() */
export interface BenchmarkImportInput {
  source: BenchmarkImportSource;
  /** Catalog benchmark name the import creates or extends */
  benchmarkName: string;
  /** Version label for the imported benchmark version */
  version: string;
}

/**
 * Benchmark import job status — the import surface's own vocabulary.
 * Terminal: "IMPORTED" (the corpus landed as a benchmark version; it becomes
 * runnable once the platform activates it) and "FAILED".
 */
export type BenchmarkImportStatus = "IMPORTING" | "IMPORTED" | "FAILED";

/**
 * A benchmark import job. Terminal statuses: "IMPORTED" and "FAILED".
 * Self-describing: every response names the benchmark@version being imported.
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
  /** Failure detail when status is "FAILED" */
  error?: BenchmarkImportError | null;
  /** Number of tasks parsed, once counted (getImport() responses) */
  taskCount?: number;
}

/** Structured failure detail for a FAILED import. */
export interface BenchmarkImportError {
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
 * Input for customHarnesses().create(): a name, a run command, and EITHER an
 * install script (`installScript`, the script itself — sent as JSON) OR a local
 * directory (`directory`, tarred deterministically on the client and uploaded).
 * Provide one source, not both.
 */
export interface CustomHarnessInput {
  /** Harness name; also the value used later in agents[].harness */
  name: string;
  /**
   * The install script itself (not a path). It runs in a throwaway builder
   * sandbox that has internet and ZERO secrets, so everything it fetches must
   * be publicly fetchable, and it must leave executables in `$PREFIX/bin`.
   */
  installScript?: string;
  /**
   * A local directory holding the harness — tarred + gzipped and uploaded.
   * Same build rules as an install script.
   */
  directory?: string;
  /** Command run headless with `sh -c` at the task working directory */
  runCommand: string;
  /** Env injected at RUN time only; may not override the run contract's keys */
  env?: Record<string, string>;
}

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

/** Options for jobs().list() */
export interface ListJobsOptions {
  /** Max items per page (default: 50, max: 200) */
  limit?: number;
  /** Cursor from JobPage.nextCursor */
  cursor?: string;
}

/** Options for jobs().trials() */
export interface ListTrialsOptions {
  /** Only trials in these statuses (e.g. the failures behind a rerun decision) */
  status?: TrialStatus[];
  /** Max items per page (default: 50, max: 200) */
  limit?: number;
  /** Cursor from TrialPage.nextCursor */
  cursor?: string;
}

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
export interface TrialTraceOptions {
  /** Return events with seq strictly greater than this (omit = from the beginning) */
  after?: number;
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
  /** List every benchmark with its active version */
  list(): Promise<Benchmark[]>;
  /**
   * Get one benchmark: all versions + the selected version's task list.
   * ref is "name" (active version's tasks) or "name@version".
   */
  get(ref: string): Promise<Benchmark>;
  /**
   * Get a benchmark's active version resolved to a runnable shape: unlike
   * get(), `version` and `tasks` are guaranteed present. Throws
   * NoActiveVersionError when the benchmark has no active version. Use get()
   * for the full multi-version detail with optional fields.
   */
  getActive(name: string): Promise<ActiveBenchmark>;
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
}

/** Client for the caller's own private (bring-your-own) harnesses */
export interface CustomHarnessesClient {
  /**
   * Register a private harness. Provide either an install script
   * (`{ installScript }`) or a local directory (`{ directory }`), never both.
   * The name is then usable in `agents[].harness` like a built-in.
   */
  create(input: CustomHarnessInput): Promise<CustomHarness>;
  /** List the caller's registered custom harnesses */
  list(): Promise<CustomHarness[]>;
  /** Get one custom harness by name */
  get(name: string): Promise<CustomHarness>;
  /** Delete a custom harness. Past jobs keep their recorded harness. */
  delete(name: string): Promise<void>;
}

/** Client for hosted jobs */
export interface JobsClient {
  /**
   * Create a job. benchmark may be a bare "name" (resolved to the
   * active READY version) or a pinned "name@version". Supports Idempotency-Key.
   */
  run(input: JobInput, options?: RunJobOptions): Promise<Job>;
  /** Get one job with agents + trial status counts */
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
  /** Get one seq-paged slice of a trial's trace; resume with { after: page.nextAfter } */
  trialTrace(
    id: string,
    trialId: string,
    options?: TrialTraceOptions
  ): Promise<TrialTracePage>;
  /**
   * Iterate a trial's trace events, fetching pages under the hood until
   * the currently available trace is drained. Resume later by passing the
   * last seen seq as { after }.
   */
  trialTraceEvents(
    id: string,
    trialId: string,
    options?: TrialTraceOptions
  ): AsyncIterableIterator<TrialTraceEvent>;
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
  /** Read a regrade job and its per-trial results (with lineage + reward deltas). */
  regradeJob(jobId: string): Promise<RegradeJob>;
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
