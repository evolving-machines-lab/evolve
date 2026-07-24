/**
 * Public types for the hosted benchmarks/evaluations API.
 */

/** Configuration for the benchmarks() / evaluations() factories */
export interface HostedClientConfig {
  /** API key (default: process.env.EVOLVE_API_KEY) */
  apiKey?: string;
  /** API base URL override (default: the Evolve dashboard API) */
  baseUrl?: string;
}

/**
 * Evaluation lifecycle status (wire values, as the API emits them).
 */
export type EvaluationStatus =
  | "QUEUED"
  | "RUNNING"
  | "CANCELLING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

/**
 * TaskRun status law: a valid reward (including 0) = SCORED; verifier crash or
 * out-of-domain reward = SCORING_ERROR (never a fabricated zero);
 * INFRASTRUCTURE_ERROR: the run was lost before a result was recorded;
 * INDETERMINATE: the platform cannot tell whether the run completed.
 */
export type TaskRunStatus =
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
   * Where the task can run, per sandbox provider. Advisory for planning an
   * evaluation's provider choice — creating an evaluation whose tasks include
   * one refused on the chosen provider is rejected with the same reason, so
   * nothing is ever spent on a run that cannot execute.
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

/** One agent system: harness + model (+ optional pinned harness version) */
export interface AgentSystem {
  /** A built-in harness ("claude", "codex", ...) or a registered custom harness name */
  harness: string;
  model: string;
  /**
   * Pin the harness version. Omitted (or null) resolves the latest at dispatch
   * time; the version that actually ran is recorded on every task run as
   * `resolvedHarnessVersion`. Rejected at creation when the pin is not an exact
   * version (`invalid_input`), when the version is not published
   * (`harness_version_not_found`), or when the harness is a custom one — those
   * are versioned by the content of their own source (`invalid_input`).
   */
  harnessVersion?: string | null;
}

/**
 * Sandbox provider a hosted evaluation runs on. Named `EvalSandboxProvider` to
 * avoid colliding with the core SDK's `SandboxProvider` (the sandbox-abstraction
 * interface).
 */
export type EvalSandboxProvider = "e2b" | "daytona" | "modal";

/** Where a task run's verifier executed: a separate pristine box, or inside the agent box */
export type VerifierMode = "separate" | "shared";

/** The input contract for creating an evaluation */
export interface EvaluationInput {
  /**
   * Benchmark reference: "name@version" for a pinned run, or a bare "name" —
   * a bare name resolves server-side to the benchmark's active READY version.
   * Responses always echo the resolved "name@version".
   */
  benchmark: string;
  /** Task keys to run (omitted = every task of the version) */
  tasks?: string[];
  agentSystems: AgentSystem[];
  /** Runs per task x agent system (default: 1) */
  runsPerTask?: number;
  /** Parallel task runs (default: 1) */
  concurrency?: number;
  /**
   * Hard model-spend cap in USD for the whole evaluation. Optional: omitted,
   * the server applies its own default ($500, operator-tunable). The response
   * echoes the RESOLVED cap either way, so an omitted one is never invisible.
   */
  maxModelSpendUsd?: number;
  /** Optional per-task-run model-spend cap in USD */
  maxModelSpendUsdPerTaskRun?: number;
  /** Sandbox provider to run on (optional; server default: `e2b`) */
  sandboxProvider?: EvalSandboxProvider;
}

/** TaskRun count histogram by status */
export type TaskRunCounts = Partial<Record<TaskRunStatus, number>>;

/**
 * An evaluation = tasks x agentSystems x runsPerTask.
 *
 * Every shape (run/get/cancel/rerunFailed/list) carries counts; get() and
 * list() additionally return taskRunCounts and meanScore, and get() the
 * detail fields (agentSystems, error, updatedAt).
 */
export interface Evaluation {
  id: string;
  status: EvaluationStatus;
  /** "name@version" */
  benchmark: string;
  /** get() only */
  agentSystems?: AgentSystem[];
  runsPerTask: number;
  concurrency: number;
  maxModelSpendUsd: number;
  /** Per-task-run model-spend cap, when one was set */
  maxModelSpendUsdPerTaskRun?: number;
  /** Sandbox provider this evaluation runs on */
  sandboxProvider: EvalSandboxProvider;
  spentUsd: number;
  createdAt: string;
  /** Evaluation size: agentSystems x tasks -> taskRuns (present on every shape) */
  counts: { agentSystems: number; tasks: number; taskRuns: number };
  /** TaskRun histogram by status (get/list) */
  taskRunCounts?: TaskRunCounts;
  /** Mean score over SCORED runs only; null when none. Zero is a score. (get/list) */
  meanScore?: number | null;
  /** get() only */
  error?: string | null;
  /** get() only */
  updatedAt?: string;
  /** Present on rerun-failed evaluations: the evaluation the failed runs came from */
  sourceEvaluationId?: string;
  /** True when the server replayed an existing evaluation for this Idempotency-Key */
  idempotentReplay?: boolean;
}

/**
 * Where a task run's spend figure came from: "measured" is the measured model
 * spend reported by the platform; "assumed_cap" means spend could not be
 * measured for this run, so the per-run cap is reported.
 */
export type SpendSource = "measured" | "assumed_cap";

/**
 * Model usage/spend recorded for a task run — purely spend/usage, in the one
 * money vocabulary (caps are maxModelSpend*, actuals are spentUsd). Open map:
 * harness-specific keys may appear.
 */
export interface ModelUsage {
  /** Model spend in USD for this run */
  spentUsd?: number;
  /** Where the spend figure came from */
  spendSource?: SpendSource;
  /** The per-run model-spend cap that applied to this run */
  maxModelSpendUsd?: number;
  [key: string]: unknown;
}

/** One task x one agent system x one runNumber */
export interface TaskRun {
  id: string;
  taskKey: string;
  agentSystem: AgentSystem;
  /** 1-based user-requested run number */
  runNumber: number;
  status: TaskRunStatus;
  /** The reward-file score; null until scored */
  score: number | null;
  /** Named metrics map (reward.json sub-scores) */
  metrics: Record<string, number> | null;
  /** Phase where an infrastructure failure occurred, when status is a failure */
  failurePhase: string | null;
  /** Failure detail (truncated to 2000 chars in list responses) */
  failureDetail: string | null;
  /** Wall-clock per phase, e.g. { agentMs, verifyMs } */
  phaseTimingsMs: Record<string, number> | null;
  modelUsage: ModelUsage | null;
  /** Sandbox provider the run executed on; null until it has executed */
  sandboxProvider: EvalSandboxProvider | null;
  /** Where the verifier ran; null until recorded */
  verifierMode: VerifierMode | null;
  /** Harness version actually resolved and used for the run; null until resolved */
  resolvedHarnessVersion: string | null;
  /** Reference to the agent session/trace, when recorded */
  sessionRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One server-sent event from evaluations().watch() */
export interface EvaluationEvent {
  /** Monotonic sequence number (SSE id; the Last-Event-ID resume position) */
  seq: number;
  /** Event type, e.g. "evaluation.created", "task_run.settled", "evaluation.completed" */
  type: string;
  data: Record<string, unknown>;
}

/**
 * The handle returned by evaluations().watch(). It is both:
 * - a promise for the final Evaluation — `await evals.watch(id)` resolves once
 *   the evaluation reaches a terminal status (the original form); and
 * - an async iterable of events — `for await (const event of evals.watch(id))`
 *   yields each EvaluationEvent and completes on the terminal event.
 *
 * Pick one form per call: both drive the same underlying SSE stream, so a
 * single handle should not be awaited and iterated at once.
 */
export interface EvaluationWatch
  extends PromiseLike<Evaluation>,
    AsyncIterable<EvaluationEvent> {}

/** Cursor page of evaluations (newest first) */
export interface EvaluationPage {
  evaluations: Evaluation[];
  nextCursor: string | null;
}

/**
 * The handle returned by evaluations().list(). Both:
 * - a promise for a single EvaluationPage — `await evals.list({ limit })`
 *   returns one page (the original form); and
 * - an async iterable — `for await (const item of evals.list())` walks every
 *   evaluation across cursor pages, fetching the next page for you.
 */
export interface EvaluationList
  extends PromiseLike<EvaluationPage>,
    AsyncIterable<Evaluation> {}

/** Cursor page of task runs */
export interface TaskRunPage {
  taskRuns: TaskRun[];
  nextCursor: string | null;
}

/**
 * The handle returned by evaluations().taskRuns(). Both:
 * - a promise for a single TaskRunPage — `await evals.taskRuns(id, { limit })`
 *   returns one page (the original form); and
 * - an async iterable — `for await (const run of evals.taskRuns(id))` walks
 *   every task run across cursor pages, fetching the next page for you.
 */
export interface TaskRunList
  extends PromiseLike<TaskRunPage>,
    AsyncIterable<TaskRun> {}

// =============================================================================
// TASK RUN DETAIL + TRACE
// =============================================================================

/**
 * Full detail of one task run — evaluations().taskRun(id, runId).
 * Same shape as a list row, plus the owning evaluation; unlike list rows,
 * failureDetail is untruncated here.
 */
export interface TaskRunDetail extends TaskRun {
  /** The evaluation this run belongs to */
  evaluationId: string;
}

/** One trace event of a task run (seq-ordered timeline) */
export interface TaskRunTraceEvent {
  /** Monotonic sequence number (the ?after= resume position) */
  seq: number;
  /** Event type */
  type: string;
  data: Record<string, unknown>;
}

/** One seq-paged slice of a task run's trace — evaluations().taskRunTrace() */
export interface TaskRunTracePage {
  events: TaskRunTraceEvent[];
  /**
   * Resume position: pass back as { after } to continue. An empty page echoes
   * the requested position (null when reading an empty trace from the start).
   */
  nextAfter: number | null;
}

// =============================================================================
// COMPARE
// =============================================================================

/** Scored-run coverage behind an aggregate (means cover SCORED runs only) */
export interface ComparisonCoverage {
  scored: number;
  total: number;
}

/**
 * One (taskKey x evaluation) cell of the compare matrix. status is the shared
 * TaskRunStatus when the cell's runs agree, "MIXED" when they differ, and
 * "MISSING" when the evaluation has no runs for the task.
 */
export interface ComparisonCell {
  evaluationId: string;
  status: TaskRunStatus | "MIXED" | "MISSING";
  /** Mean score over the cell's SCORED runs; null when none. Zero is a score. */
  meanScore: number | null;
  coverage: ComparisonCoverage;
}

/** One matrix row of evaluations().compare(): a task across the compared evaluations */
export interface ComparisonTaskRow {
  taskKey: string;
  /** True when the evaluations' cells differ in status or score for this task */
  disagreement: boolean;
  /** Cells in the caller's evaluation-id order */
  cells: ComparisonCell[];
}

/** Per-evaluation aggregate of evaluations().compare() */
export interface ComparisonAggregate {
  id: string;
  /** "name@version" */
  benchmark: string;
  status: EvaluationStatus;
  /** Mean score over SCORED runs only; null when none. Zero is a score. */
  meanScore: number | null;
  coverage: ComparisonCoverage;
  spentUsd: number;
  agentSystems: AgentSystem[];
  createdAt: string;
}

/**
 * Result of evaluations().compare([ids]): per-evaluation aggregates plus a
 * per-task matrix (disagreement rows first).
 */
export interface EvaluationComparison {
  /** Aggregates in the caller's id order */
  evaluations: ComparisonAggregate[];
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
 * One regrade of one source task run: the verifier re-run against that run's
 * RECORDED inputs, in a fresh separate verifier box. The agent phase is never
 * re-run, and the source run is never modified — `sourceScore`/`sourceStatus`
 * are immutable snapshots taken when the regrade was created.
 */
export interface RegradeResult {
  /** Regrade result id */
  id: string;
  /** The source task run this regrade re-scored (immutable) */
  sourceTaskRunId: string;
  /** The source run's task key */
  taskKey: string;
  status: RegradeStatus;
  /** The regrade's reward-file score; null until scored */
  score: number | null;
  /** Named metrics map (reward.json sub-scores) */
  metrics: Record<string, number> | null;
  /** The recorded source-run score at regrade time (immutable snapshot) */
  sourceScore: number | null;
  /** The recorded source-run status at regrade time (immutable snapshot) */
  sourceStatus: string;
  /** score − sourceScore when both are real numbers, else null (Harbor's per-trial delta) */
  scoreDelta: number | null;
  /** Where the verifier ran — always "separate" (regrade only re-runs separate verifiers) */
  verifierMode: VerifierMode;
  /**
   * Content digest of the resolved target verifier spec — the "verifier
   * version". A digest equal to the source run's own verifier reproduces the
   * recorded score; a different digest is a genuine new-verifier prediction.
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

/** The filter applied when selecting source runs for a per-evaluation regrade */
export interface RegradeFilter {
  status?: string[];
  taskKey?: string;
}

/**
 * A regrade job = a collection of regrade results. A per-task-run regrade holds
 * one result; a per-evaluation regrade holds one per eligible source run. The
 * job's `status` is derived from its results. `results` is present on the read
 * (regradeJob) and create responses.
 */
export interface RegradeJob {
  id: string;
  /** The evaluation the source runs belong to */
  sourceEvaluationId: string;
  status: RegradeJobStatus;
  /** Sandbox provider the verifier boxes run on (independent of the source) */
  sandboxProvider: EvalSandboxProvider;
  /** The filter applied to select source runs (per-evaluation regrade), or null */
  filter: RegradeFilter | null;
  counts: {
    results: number;
    /** Result histogram by RegradeStatus */
    byStatus: Partial<Record<RegradeStatus, number>>;
  };
  createdAt: string;
  updatedAt: string;
  /** The per-run regrade results */
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
 * usable in `agentSystems[].harness` exactly like a built-in ("claude",
 * "codex", ...).
 *
 * Private to its owner: another user's name reads as
 * `custom_harness_not_found`, never as a permission error — existence is never
 * leaked.
 */
export interface CustomHarness {
  /** The harness name to put in agentSystems[].harness */
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
  /** Harness name; also the value used later in agentSystems[].harness */
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

/** Options for evaluations().run() and rerunFailed() */
export interface RunEvaluationOptions {
  /**
   * Idempotency-Key header value: retries with the same key return the
   * original evaluation (idempotentReplay: true) instead of creating a new one.
   */
  idempotencyKey?: string;
}

/** Options for evaluations().list() */
export interface ListEvaluationsOptions {
  /** Max items per page (default: 50, max: 200) */
  limit?: number;
  /** Cursor from EvaluationPage.nextCursor */
  cursor?: string;
}

/** Options for evaluations().taskRuns() */
export interface ListTaskRunsOptions {
  /** Only task runs in these statuses (e.g. the failures behind a rerun decision) */
  status?: TaskRunStatus[];
  /** Max items per page (default: 50, max: 200) */
  limit?: number;
  /** Cursor from TaskRunPage.nextCursor */
  cursor?: string;
}

/**
 * Options for evaluations().regrade() (per-evaluation): narrow the set of
 * source runs. A run is regradable only if it recorded separate-mode verifier
 * inputs; these filters further restrict that set.
 */
export interface RegradeOptions {
  /** Only regrade source runs in these statuses */
  status?: TaskRunStatus[];
  /** Only regrade source runs of this task */
  taskKey?: string;
}

/** Options for evaluations().taskRunTrace() and taskRunTraceEvents() */
export interface TaskRunTraceOptions {
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

/** Options for evaluations().watch() */
export interface WatchEvaluationOptions {
  /** Called for every event (replayed + live) */
  onEvent?: (event: EvaluationEvent) => void;
  /** Abort the watch (rejects with the abort reason) */
  signal?: AbortSignal;
  /** Initial reconnect backoff (default: 1000ms; doubles up to maxReconnectDelayMs) */
  reconnectDelayMs?: number;
  /** Backoff ceiling (default: 30000ms) */
  maxReconnectDelayMs?: number;
}

/** Options for evaluations().export() */
export interface ExportEvaluationOptions {
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
   * The name is then usable in `agentSystems[].harness` like a built-in.
   */
  create(input: CustomHarnessInput): Promise<CustomHarness>;
  /** List the caller's registered custom harnesses */
  list(): Promise<CustomHarness[]>;
  /** Get one custom harness by name */
  get(name: string): Promise<CustomHarness>;
  /** Delete a custom harness. Past evaluations keep their recorded harness. */
  delete(name: string): Promise<void>;
}

/** Client for hosted evaluations */
export interface EvaluationsClient {
  /**
   * Create an evaluation. benchmark may be a bare "name" (resolved to the
   * active READY version) or a pinned "name@version". Supports Idempotency-Key.
   */
  run(input: EvaluationInput, options?: RunEvaluationOptions): Promise<Evaluation>;
  /** Get one evaluation with agent systems + task-run status counts */
  get(id: string): Promise<Evaluation>;
  /**
   * List the caller's evaluations, newest first (cursor-paged). Await the
   * result for one page, or `for await` it to walk every evaluation across
   * cursor pages transparently.
   */
  list(options?: ListEvaluationsOptions): EvaluationList;
  /**
   * List an evaluation's task runs (cursor-paged; { status } filters, e.g. to
   * the failed runs). Await the result for one page, or `for await` it to
   * walk every task run across cursor pages transparently.
   */
  taskRuns(id: string, options?: ListTaskRunsOptions): TaskRunList;
  /** Get one task run's full detail (untruncated failureDetail) */
  taskRun(id: string, runId: string): Promise<TaskRunDetail>;
  /** Get one seq-paged slice of a task run's trace; resume with { after: page.nextAfter } */
  taskRunTrace(
    id: string,
    runId: string,
    options?: TaskRunTraceOptions
  ): Promise<TaskRunTracePage>;
  /**
   * Iterate a task run's trace events, fetching pages under the hood until
   * the currently available trace is drained. Resume later by passing the
   * last seen seq as { after }.
   */
  taskRunTraceEvents(
    id: string,
    runId: string,
    options?: TaskRunTraceOptions
  ): AsyncIterableIterator<TaskRunTraceEvent>;
  /**
   * Watch an evaluation's event stream (SSE). Replays from the beginning,
   * resumes with Last-Event-ID on reconnect (exponential backoff), and
   * finishes on the terminal event.
   *
   * The returned handle is dual-use: `await evals.watch(id)` resolves with the
   * final Evaluation, or `for await (const event of evals.watch(id))` iterates
   * the events. The `onEvent` callback still fires in both forms.
   */
  watch(id: string, options?: WatchEvaluationOptions): EvaluationWatch;
  /** Request cancellation. Idempotent; a terminal evaluation is a no-op. */
  cancel(id: string): Promise<Evaluation>;
  /**
   * Create a NEW linked evaluation of only the failed (and never-dispatched)
   * task runs of a terminal evaluation. Supports Idempotency-Key.
   */
  rerunFailed(id: string, options?: RunEvaluationOptions): Promise<Evaluation>;
  /**
   * Regrade a terminal evaluation: re-run the verifier of every REGRADABLE run
   * (settled separate-mode runs, which recorded their verifier inputs) against
   * those recorded inputs, in fresh separate verifier boxes. The agent phase is
   * never re-run and the source runs are never modified. `options` narrows the
   * set by status and/or task. Returns a new regrade job (one result per run).
   */
  regrade(id: string, options?: RegradeOptions): Promise<RegradeJob>;
  /**
   * Regrade one settled task run: re-run its verifier against its recorded
   * inputs in a fresh separate verifier box. Refused (regrade_source_ineligible)
   * for shared-mode or pre-persistence runs. Returns a regrade job with one
   * result.
   */
  regradeTaskRun(id: string, runId: string): Promise<RegradeJob>;
  /** Read a regrade job and its per-run results (with lineage + score deltas). */
  regradeJob(jobId: string): Promise<RegradeJob>;
  /**
   * Side-by-side comparison of 2-5 owned evaluations: per-evaluation
   * aggregates plus a per-task matrix with disagreement rows first.
   */
  compare(ids: string[]): Promise<EvaluationComparison>;
  /**
   * Download the full research archive (gzipped JSON) of a terminal
   * evaluation. Default: Buffer. { to } saves to a directory and returns the
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
    options?: ExportEvaluationOptions
  ): Promise<Buffer | string | ReadableStream<Uint8Array>>;
}
