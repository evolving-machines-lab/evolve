/**
 * Hosted evals public types.
 *
 * Mirrors the hosted benchmarks/evaluations API 1-1. Exposed types follow the
 * evals-rebuild plan's public surface exactly: Benchmark, BenchmarkVersion,
 * Task, AgentSystem, EvaluationInput, Evaluation, TaskRun, EvaluationEvent,
 * ModelUsage, OutputFile, ComparisonRow, BenchmarkImport + cursor pages.
 * Nothing Evolve-internal (worker, templates, credentials) leaks here.
 */

/** Configuration for the benchmarks() / evaluations() factories */
export interface HostedClientConfig {
  /** API key (default: process.env.EVOLVE_API_KEY) */
  apiKey?: string;
  /** Dashboard URL override (default: DEFAULT_DASHBOARD_URL) */
  dashboardUrl?: string;
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
 * out-of-domain reward = SCORING_ERROR (never a fabricated zero); sandbox loss
 * before a durable artifact = INFRASTRUCTURE_ERROR; dispatch/completion
 * uncertainty = INDETERMINATE.
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

/** Public task fields only — instructions, environments, and tests never leave the server */
export interface Task {
  taskKey: string;
  agentTimeoutSec: number;
  verifierTimeoutSec: number;
}

/**
 * A benchmark in the shared catalog.
 *
 * list() returns the summary fields; get() additionally populates versions,
 * tasksVersion, tasks, createdAt, and updatedAt.
 */
export interface Benchmark {
  name: string;
  displayTitle: string | null;
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

/** One agent system: harness + model (+ optional pinned harness version) */
export interface AgentSystem {
  harness: string;
  model: string;
  harnessVersion?: string | null;
}

/** The six-input contract for creating an evaluation */
export interface EvaluationInput {
  /** Benchmark reference in the form "name@version" */
  benchmark: string;
  agentSystems: AgentSystem[];
  /** Task keys to run (omitted = every task of the version) */
  tasks?: string[];
  /** Runs per task x agent system (default: 1) */
  runsPerTask?: number;
  /** Parallel task runs (default: 1) */
  concurrency?: number;
  /** Hard model-spend cap in USD for the whole evaluation */
  maxModelSpendUsd: number;
}

/** TaskRun count histogram by status */
export type TaskRunCounts = Partial<Record<TaskRunStatus, number>>;

/**
 * An evaluation = tasks x agentSystems x runsPerTask.
 *
 * run()/cancel()/rerunFailed()/list() return the summary fields (counts);
 * get() returns the detail fields (agentSystems, taskRunCounts, taskRunTotal,
 * error, updatedAt).
 */
export interface Evaluation {
  id: string;
  status: EvaluationStatus;
  /** "name@version" */
  benchmark: string;
  runsPerTask: number;
  concurrency: number;
  maxModelSpendUsd: number;
  spentUsd: number;
  createdAt: string;
  /** Summary-shape counts (run/cancel/rerunFailed/list) */
  counts?: { agentSystems: number; tasks: number; taskRuns: number };
  /** TaskRun histogram by status (get/list) */
  taskRunCounts?: TaskRunCounts;
  /** get() only */
  taskRunTotal?: number;
  /** get() only */
  agentSystems?: AgentSystem[];
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

/** Model usage/spend recorded for a task run. Open map: harness-specific keys may appear. */
export interface ModelUsage {
  /** Model spend in USD (LiteLLM is the only spend truth) */
  spendUsd?: number;
  /** "key_info" (read back from the gateway) or "assumed_cap" (conservative fallback) */
  spendSource?: string;
  maxBudgetUsd?: number;
  /** Resolved harness version actually used for the run */
  harnessVersion?: string;
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

/** Cursor page of evaluations (newest first) */
export interface EvaluationPage {
  evaluations: Evaluation[];
  nextCursor: string | null;
}

/** Cursor page of task runs */
export interface TaskRunPage {
  taskRuns: TaskRun[];
  totalCount: number;
  nextCursor: string | null;
}

// =============================================================================
// RESERVED SURFACE — typed, but the server endpoints do not exist yet.
// Calling the matching client methods throws NotImplementedError.
// =============================================================================

/**
 * RESERVED: an output file collected from a task run.
 * Belongs to the taskRun(runId) detail surface, which the server does not
 * expose yet. Shape may be refined when the endpoint ships.
 */
export interface OutputFile {
  path: string;
  sizeBytes?: number;
  url?: string;
}

/**
 * RESERVED: one row of evaluations().compare([ids]).
 * The compare endpoint does not exist on the server yet. Shape may be refined
 * when the endpoint ships.
 */
export interface ComparisonRow {
  evaluationId: string;
  benchmark: string;
  agentSystem: AgentSystem;
  meanScore: number | null;
  /** Aggregates cover scored runs only; coverage is always shown */
  scoredTaskRuns: number;
  taskRuns: number;
}

/**
 * RESERVED: source for benchmarks().import() — exactly three source kinds
 * (archive upload, git URL + ref, Harbor Hub ref). The import endpoints do not
 * exist on the server yet.
 */
export type BenchmarkImportSource =
  | { archivePath: string }
  | { gitUrl: string; ref: string }
  | { harborHubRef: string };

/** RESERVED: input for benchmarks().import() */
export interface BenchmarkImportInput {
  source: BenchmarkImportSource;
}

/**
 * RESERVED: a benchmark import job (parse -> validate -> activate pipeline).
 * The import endpoints do not exist on the server yet.
 */
export interface BenchmarkImport {
  id: string;
  status: string;
  benchmark?: string;
  error?: string | null;
}

// =============================================================================
// OPTIONS
// =============================================================================

/** Options for benchmarks().get() */
export interface GetBenchmarkOptions {
  /**
   * Version override. May also be given inline as "name@version" in the ref;
   * providing both with different values is an error.
   */
  version?: string;
}

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
  get(ref: string, options?: GetBenchmarkOptions): Promise<Benchmark>;
  /** RESERVED — throws NotImplementedError (no server endpoint yet) */
  import(input: BenchmarkImportInput): Promise<BenchmarkImport>;
  /** RESERVED — throws NotImplementedError (no server endpoint yet) */
  getImport(id: string): Promise<BenchmarkImport>;
  /** RESERVED — throws NotImplementedError (no server endpoint yet) */
  watchImport(id: string): Promise<BenchmarkImport>;
}

/** Client for hosted evaluations */
export interface EvaluationsClient {
  /** Create an evaluation (the six-input contract). Supports Idempotency-Key. */
  run(input: EvaluationInput, options?: RunEvaluationOptions): Promise<Evaluation>;
  /** Get one evaluation with agent systems + task-run status counts */
  get(id: string): Promise<Evaluation>;
  /** List the caller's evaluations, newest first (cursor-paged) */
  list(options?: ListEvaluationsOptions): Promise<EvaluationPage>;
  /** List an evaluation's task runs (cursor-paged) */
  taskRuns(id: string, options?: ListTaskRunsOptions): Promise<TaskRunPage>;
  /** RESERVED — throws NotImplementedError (no server endpoint yet) */
  taskRun(runId: string): Promise<TaskRun>;
  /**
   * Watch an evaluation's event stream (SSE). Replays from the beginning,
   * resumes with Last-Event-ID on reconnect (exponential backoff), and
   * resolves with the final evaluation once it reaches a terminal status.
   */
  watch(id: string, options?: WatchEvaluationOptions): Promise<Evaluation>;
  /** Request cancellation. Idempotent; a terminal evaluation is a no-op. */
  cancel(id: string): Promise<Evaluation>;
  /**
   * Create a NEW linked evaluation of only the failed (and never-dispatched)
   * task runs of a terminal evaluation. Supports Idempotency-Key.
   */
  rerunFailed(id: string, options?: RunEvaluationOptions): Promise<Evaluation>;
  /** RESERVED — throws NotImplementedError (no server endpoint yet) */
  compare(ids: string[]): Promise<ComparisonRow[]>;
  /**
   * Download the full research archive (gzipped JSON) of a terminal
   * evaluation. Default: Buffer. { to } saves to a directory and returns the
   * file path. { stream: true } returns the raw response stream.
   */
  export(id: string): Promise<Buffer>;
  export(id: string, options: { to: string }): Promise<string>;
  export(id: string, options: { stream: true }): Promise<ReadableStream<Uint8Array>>;
  export(
    id: string,
    options?: ExportEvaluationOptions
  ): Promise<Buffer | string | ReadableStream<Uint8Array>>;
}
