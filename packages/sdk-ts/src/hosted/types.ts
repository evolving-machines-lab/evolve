/**
 * Public types for the hosted benchmarks/evaluations API.
 */

/** Configuration for the benchmarks() / evaluations() factories */
export interface HostedClientConfig {
  /** API key (default: process.env.EVOLVE_API_KEY) */
  apiKey?: string;
  /** API base URL override (default: DEFAULT_DASHBOARD_URL) */
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

/** One immutable version of a benchmark */
export interface BenchmarkVersion {
  version: string;
  state: BenchmarkVersionState;
  taskCount: number;
  /** Present on benchmarks().get() responses only */
  createdAt?: string;
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
   * evaluation's provider choice — a run on a provider marked { ok: false }
   * fails fast with the same reason instead of running with degraded
   * semantics. Absent on responses from older servers.
   */
  providers?: Record<EvalSandboxProvider, TaskProviderVerdict>;
}

/**
 * A benchmark in the shared catalog.
 *
 * list() returns the summary fields; get() additionally populates versions,
 * tasksVersion, tasks, createdAt, and updatedAt.
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
  tasksVersion?: string | null;
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
  harness: string;
  model: string;
  harnessVersion?: string | null;
}

/**
 * Sandbox provider a hosted evaluation runs on. Named `EvalSandboxProvider` to
 * avoid colliding with the core SDK's `SandboxProvider` (the sandbox-abstraction
 * interface).
 */
export type EvalSandboxProvider = "e2b" | "daytona" | "modal";

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
  /** Hard model-spend cap in USD for the whole evaluation */
  maxModelSpendUsd: number;
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
 * Every shape (run/get/cancel/rerunFailed/list) carries counts; get()
 * additionally returns the detail fields (agentSystems, taskRunCounts,
 * error, updatedAt).
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
  sandboxProvider?: EvalSandboxProvider;
  spentUsd: number;
  createdAt: string;
  /** Evaluation size: agentSystems x tasks -> taskRuns (present on every shape) */
  counts: { agentSystems: number; tasks: number; taskRuns: number };
  /** TaskRun histogram by status (get/list) */
  taskRunCounts?: TaskRunCounts;
  /** get() only */
  benchmarkVersionState?: BenchmarkVersionState;
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

/** Model usage/spend recorded for a task run. Open map: harness-specific keys may appear. */
export interface ModelUsage {
  /** Model spend in USD */
  spendUsd?: number;
  /** Where the spend figure came from */
  spendSource?: SpendSource;
  maxBudgetUsd?: number;
  /** Resolved harness version actually used for the run */
  resolvedHarnessVersion?: string;
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
  totalCount: number;
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
 * RESERVED: an output file collected from a task run.
 * No server endpoint exposes output files yet. Shape may be refined when one
 * ships.
 */
export interface OutputFile {
  path: string;
  sizeBytes?: number;
  url?: string;
}

/**
 * Full detail of one task run — evaluations().taskRun(id, runId).
 * Unlike list rows, failureDetail is untruncated here.
 */
export interface TaskRunDetail extends TaskRun {
  /** The evaluation this run belongs to */
  evaluationId: string;
  /** Harness version actually resolved and used for the run; null until resolved */
  resolvedHarnessVersion: string | null;
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
  score: number | null;
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
// BENCHMARK IMPORT
// =============================================================================

/**
 * Source for benchmarks().import() — three source kinds. Git (URL + ref) is
 * live; archive upload and Harbor Hub refs remain RESERVED (no server
 * endpoint yet) and throw NotImplementedError.
 */
export type BenchmarkImportSource =
  | { archivePath: string }
  | { gitUrl: string; ref: string }
  | { harborHubRef: string };

/** Input for benchmarks().import() */
export interface BenchmarkImportInput {
  source: BenchmarkImportSource;
  /** Catalog benchmark name the import creates or extends */
  benchmarkName: string;
  /** Version label for the imported version (server-assigned when omitted) */
  version?: string;
}

/** Benchmark import job lifecycle status (wire values). Terminal: "READY", "FAILED". */
export type BenchmarkImportStatus =
  | "IMPORTING"
  | "BUILDING"
  | "VALIDATING"
  | "READY"
  | "FAILED";

/**
 * A benchmark import job. Terminal statuses: "READY" and "FAILED".
 */
export interface BenchmarkImport {
  /** Import job id */
  id: string;
  /** Pipeline status */
  status: BenchmarkImportStatus;
  /** Catalog benchmark name the import creates or extends (create responses) */
  benchmarkName?: string;
  /** Version label of the imported version (create responses) */
  version?: string;
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
  /** Max items per page (default: 50, max: 200) */
  limit?: number;
  /** Cursor from TaskRunPage.nextCursor */
  cursor?: string;
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
   * Start a benchmark import job. Git sources ({ gitUrl, ref }) are live;
   * archive and Harbor Hub sources still throw NotImplementedError (no server
   * endpoint yet).
   */
  import(input: BenchmarkImportInput): Promise<BenchmarkImport>;
  /** Get an import job's status (error and taskCount when available) */
  getImport(id: string): Promise<BenchmarkImport>;
  /**
   * Poll getImport() until the job reaches a terminal status ("READY" or
   * "FAILED") and resolve with the final import.
   */
  watchImport(id: string, options?: WatchImportOptions): Promise<BenchmarkImport>;
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
   * List an evaluation's task runs (cursor-paged). Await the result for one
   * page, or `for await` it to walk every task run across cursor pages
   * transparently.
   */
  taskRuns(id: string, options?: ListTaskRunsOptions): TaskRunList;
  /** Get one task run's full detail (untruncated failureDetail, resolved harness version, sessionRef) */
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
