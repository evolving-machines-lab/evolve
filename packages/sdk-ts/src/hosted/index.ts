import { createWriteStream } from "fs";
import { mkdir, rename, rm } from "fs/promises";
import { basename, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { DEFAULT_DASHBOARD_URL, ENV_EVOLVE_API_KEY } from "../constants";
import type {
  ActiveDataset,
  Agent,
  AgentArm,
  AgentArmInput,
  AgentInfo,
  AgentInput,
  AgentList,
  AgentPage,
  AgentResult,
  AgentSource,
  AgentUpsertInput,
  AgentsClient,
  AttemptPhase,
  AuthClient,
  AuthStatus,
  CompareCell,
  CompareCoverage,
  CompareJobAggregate,
  CompareResponse,
  CompareTaskRow,
  Dataset,
  DatasetImport,
  DatasetImportFailure,
  DatasetImportList,
  DatasetImportStatus,
  DatasetList,
  DatasetPage,
  DatasetPatch,
  DatasetRef,
  DatasetVersion,
  DatasetVersionGate,
  DatasetVersionGateFailedTask,
  DatasetVersionState,
  DatasetsClient,
  DownloadDatasetOptions,
  DownloadJobOptions,
  EvalSandboxProvider,
  ExceptionInfo,
  GetDatasetOptions,
  HostedClientConfig,
  ImportWarning,
  Job,
  JobCreate,
  JobEvent,
  JobFailure,
  JobList,
  JobPage,
  JobStats,
  JobStatus,
  JobTaskRollup,
  JobTaskRollupList,
  JobWatch,
  JobsClient,
  ListAgentsOptions,
  ListDatasetsOptions,
  ListImportsOptions,
  ListJobTasksOptions,
  ListJobsOptions,
  ListSkillsOptions,
  ListTrialsOptions,
  Page,
  PageOptions,
  PublishDatasetInput,
  RegradeRequest,
  ResumeRequest,
  RetryConfig,
  RetryRequest,
  SkillLock,
  SkillUpload,
  SkillUploadList,
  SkillUploadPage,
  SkillsClient,
  SourceJob,
  SpendSource,
  StartJobOptions,
  StepResult,
  StopResponse,
  Task,
  TimingInfo,
  TraceEvent,
  TraceEventPage,
  TraceOptions,
  Trial,
  TrialArtifactStream,
  TrialCounts,
  TrialList,
  TrialPage,
  TrialRetry,
  TrialStatus,
  TrialsClient,
  UpstreamStatus,
  VerifierEnvironmentMode,
  VerifierResult,
  WatchImportOptions,
  WatchJobOptions,
} from "./types";

// Re-exported from the hosted barrel so the package root can hand them on.
export {
  EVAL_SANDBOX_PROVIDERS,
  HOSTED_ERROR_CODES,
  TRIAL_ARTIFACT_STREAMS,
  TRIAL_STATUSES,
  isHostedErrorCode,
  passAtK,
} from "./types";
export type {
  ActiveDataset,
  Agent,
  AgentArm,
  AgentArmInput,
  AgentCapability,
  AgentDatasetStats,
  AgentInfo,
  AgentInput,
  AgentList,
  AgentPage,
  AgentResult,
  AgentSource,
  AgentSourceInput,
  AgentUpsertInput,
  AgentsClient,
  ApiKey,
  AttemptPhase,
  AuthClient,
  AuthStatus,
  Awaitable,
  CapabilityDocument,
  CompareCell,
  CompareCoverage,
  CompareJobAggregate,
  CompareResponse,
  CompareTaskRow,
  Dataset,
  DatasetImport,
  DatasetImportFailure,
  DatasetImportList,
  DatasetImportPage,
  DatasetImportStatus,
  DatasetList,
  DatasetPage,
  DatasetPatch,
  DatasetRef,
  DatasetSelector,
  DatasetSource,
  DatasetVersion,
  DatasetVersionGate,
  DatasetVersionGateFailedTask,
  DatasetVersionState,
  DatasetsClient,
  DownloadDatasetOptions,
  DownloadJobOptions,
  EvalSandboxProvider,
  ExceptionInfo,
  GetDatasetOptions,
  HostedClientConfig,
  HostedErrorCode,
  ImportWarning,
  Job,
  JobCreate,
  JobEvent,
  JobFailure,
  JobList,
  JobPage,
  JobStats,
  JobStatus,
  JobTaskRollup,
  JobTaskRollupList,
  JobTaskRollupPage,
  JobWatch,
  JobsClient,
  ListAgentsOptions,
  ListDatasetsOptions,
  ListImportsOptions,
  ListJobTasksOptions,
  ListJobsOptions,
  ListSkillsOptions,
  ListTrialsOptions,
  ManagedProviderCapability,
  ModelInfo,
  Page,
  PageOptions,
  PassAtKGroup,
  PassAtKPoint,
  ProviderCapability,
  PublishDatasetInput,
  RegradeRequest,
  ResumeRequest,
  RetryConfig,
  RetryConfigInput,
  RetryRequest,
  SkillLock,
  SkillUpload,
  SkillUploadList,
  SkillUploadPage,
  SkillsClient,
  SourceJob,
  SpendSource,
  StartJobOptions,
  StatusVocabulary,
  StepResult,
  StopResponse,
  Task,
  TaskProviderVerdict,
  TimingInfo,
  TraceEvent,
  TraceEventPage,
  TraceOptions,
  Trial,
  TrialArtifactStream,
  TrialCounts,
  TrialList,
  TrialPage,
  TrialRetry,
  TrialStatus,
  TrialStatusTally,
  TrialsClient,
  UpstreamStatus,
  VerifierEnvironmentMode,
  VerifierResult,
  WatchImportOptions,
  WatchJobOptions,
} from "./types";
import {
  isHostedErrorCode,
  type Awaitable,
  type CapabilityDocument,
  type HostedErrorCode,
} from "./types";

/**
 * A typed failure from the hosted evals API.
 *
 * `message` is the server's own product sentence and `code` is the stable
 * machine-readable identifier, so callers branch on codes and never on English.
 * `code` is typed as the closed HostedErrorCode union (widened to string for
 * forward compatibility with a newer server), which is what makes a typo like
 * `insufficient_creidts` a compile error instead of a branch that never runs.
 *
 * `param` and `details` are the machine-readable half of the refusal:
 *
 *   catch (err) {
 *     if (err instanceof EvolveApiError && err.code === "provider_unsupported") {
 *       // every refused task WITH its reason — not a sentence to regex
 *       const refused = err.details?.refused_tasks as { task_name: string }[];
 *     }
 *   }
 *
 * The server truncates the MESSAGE when a list is long and never truncates
 * `details`, so the data is always complete even when the sentence says
 * "and 8 more".
 */
export class EvolveApiError extends Error {
  /** HTTP status of the failed response */
  readonly status: number;
  /** Stable snake_case error code from the API ("unknown_error" when absent) */
  readonly code: HostedErrorCode | "unknown_error" | (string & {});
  /**
   * The input field this refusal is about — a body path ("agents[0].name"),
   * a query parameter ("limit"), or a multipart part name ("run_command").
   * Undefined when the failure is not about a particular field.
   */
  readonly param?: string;
  /** The complete machine-readable data behind the message. Never truncated. */
  readonly details?: Record<string, unknown>;
  /**
   * Seconds to wait before retrying (429/503). Read from the body first and the
   * Retry-After header second, because a browser fetch cannot always see the
   * header on a cross-origin response.
   */
  readonly retryAfterSec?: number;
  /** Server-side id for this failure; the string to quote in a support thread. */
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: {
      param?: string;
      details?: Record<string, unknown>;
      retryAfterSec?: number;
      requestId?: string;
    }
  ) {
    super(message);
    this.name = "EvolveApiError";
    this.status = status;
    this.code = code;
    if (extra?.param !== undefined) this.param = extra.param;
    if (extra?.details !== undefined) this.details = extra.details;
    if (extra?.retryAfterSec !== undefined) this.retryAfterSec = extra.retryAfterSec;
    if (extra?.requestId !== undefined) this.requestId = extra.requestId;
  }

  /** True when this code is one this SDK version knows about. */
  isKnownCode(): boolean {
    return isHostedErrorCode(this.code);
  }
}

/**
 * The ONE Retry-After reading: the envelope's `retryAfterSec` first and the
 * `Retry-After` header second, because a cross-origin browser fetch cannot
 * always see the header. Every retry path reads the delay through here — the
 * typed error AND the SSE follow's own backoff — so the same 429 delays the
 * same amount whichever half of the wire carries the number.
 */
function readRetryAfterSec(text: string, res: Response): number | undefined {
  try {
    const body = JSON.parse(text) as { error?: { retryAfterSec?: unknown } };
    const fromBody = body?.error?.retryAfterSec;
    // Finite or absent, in the BODY too: `JSON.parse('1e400')` is Infinity, and
    // a caller sleeping Infinity is parked forever with no bound and no output.
    // A delay that cannot be waited is no reading at all.
    if (typeof fromBody === "number" && Number.isFinite(fromBody)) return fromBody;
  } catch {
    // Unparseable body: the header is the only reading left.
  }
  // An ABSENT header is no reading at all, never zero: `Number(null)` is 0 and
  // 0 is finite, so a bare Number() told the caller to retry instantly — the
  // one thing a rate limit forbids. Empty is absent, and the HTTP-date form
  // (which we do not parse) is unreadable — both leave "retry shortly".
  const rawHeader = res.headers?.get?.("retry-after");
  if (typeof rawHeader !== "string" || rawHeader.trim() === "") return undefined;
  const fromHeader = Number(rawHeader);
  return Number.isFinite(fromHeader) ? fromHeader : undefined;
}

/** Map a non-ok Response to the typed EvolveApiError and throw it. */
async function throwApiError(res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  // Header fallback, read before the body so an unparseable body still yields a
  // usable requestId. The retry delay follows its own law (body first).
  const headerRequestId = res.headers?.get?.("x-request-id") ?? undefined;
  const retryAfterSec = readRetryAfterSec(text, res);

  try {
    const body = JSON.parse(text) as {
      error?: {
        code?: unknown;
        message?: unknown;
        param?: unknown;
        details?: unknown;
        retryAfterSec?: unknown;
        requestId?: unknown;
      };
    };
    if (body?.error && typeof body.error === "object") {
      const code = typeof body.error.code === "string" ? body.error.code : "unknown_error";
      const message =
        typeof body.error.message === "string" ? body.error.message : res.statusText;
      throw new EvolveApiError(res.status, code, message, {
        param: typeof body.error.param === "string" ? body.error.param : undefined,
        details:
          body.error.details && typeof body.error.details === "object"
            ? (body.error.details as Record<string, unknown>)
            : undefined,
        retryAfterSec,
        requestId:
          typeof body.error.requestId === "string" ? body.error.requestId : headerRequestId,
      });
    }
  } catch (error) {
    if (error instanceof EvolveApiError) throw error;
    // Fall through: unparseable body.
  }
  throw new EvolveApiError(res.status, "unknown_error", text || res.statusText, {
    retryAfterSec,
    requestId: headerRequestId,
  });
}

/**
 * Thrown by datasets().getActive() when the named dataset exists but has no
 * active version, so there is no runnable version to resolve. Use get() to
 * inspect a dataset that may not have an active version yet.
 */
export class NoActiveVersionError extends Error {
  /** The dataset name that had no active version */
  readonly dataset: string;
  constructor(dataset: string) {
    super(`Dataset "${dataset}" has no active version`);
    this.name = "NoActiveVersionError";
    this.dataset = dataset;
  }
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);

// Seeing one of these on the wire is the authoritative end-of-stream signal.
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "job.completed",
  "job.cancelled",
  "job.failed",
]);

const DEFAULT_IMPORT_POLL_INTERVAL_MS = 2_000;

// Terminal import statuses.
const TERMINAL_IMPORT_STATUSES: ReadonlySet<string> = new Set(["COMPLETED", "FAILED"]);

// =============================================================================
// SHARED HELPERS
// =============================================================================

interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
}

function resolveConfig(factory: string, config?: HostedClientConfig): ResolvedConfig {
  const apiKey = config?.apiKey || process.env[ENV_EVOLVE_API_KEY];
  if (!apiKey) {
    throw new Error(
      `${factory}() requires an API key. Set ${ENV_EVOLVE_API_KEY} or pass { apiKey } in config.`
    );
  }
  const baseUrl = (config?.baseUrl || process.env.EVOLVE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, "");
  return { apiKey, baseUrl };
}

async function request(
  cfg: ResolvedConfig,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...init?.headers,
    },
  });
  if (!res.ok) {
    await throwApiError(res);
  }
  return res;
}

/** Parse "name" or "name@version" into its parts. */
function parseDatasetRef(ref: string): { name: string; version?: string } {
  const at = ref.indexOf("@");
  if (at === -1) return { name: ref.trim() };
  const name = ref.slice(0, at).trim();
  const version = ref.slice(at + 1).trim();
  if (!name || !version) {
    throw new Error(`Invalid dataset ref "${ref}": expected "name" or "name@version"`);
  }
  return { name, version };
}

function mapDatasetRef(raw: Record<string, unknown>): DatasetRef {
  return {
    name: raw.name as string,
    version: raw.version as string,
  };
}

function mapAgentArm(raw: Record<string, unknown>): AgentArm {
  // Map only the public arm fields.
  const kwargs = raw.kwargs;
  // Older servers carry no skills fields:
  // absent or garbage reads as "no skills" ([] / null), never a crash.
  const skills = Array.isArray(raw.skills)
    ? (raw.skills as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const rawLocks = Array.isArray(raw.skill_locks) ? (raw.skill_locks as unknown[]) : null;
  const skillLocks = rawLocks
    ? rawLocks.flatMap((entry): SkillLock[] => {
        if (!entry || typeof entry !== "object") return [];
        const lock = entry as Record<string, unknown>;
        if (typeof lock.name !== "string" || typeof lock.digest !== "string") return [];
        return [
          {
            name: lock.name,
            source: typeof lock.source === "string" ? lock.source : "",
            digest: lock.digest,
            git_url: typeof lock.git_url === "string" ? lock.git_url : null,
            git_commit_id: typeof lock.git_commit_id === "string" ? lock.git_commit_id : null,
          },
        ];
      })
    : null;
  return {
    name: raw.name as string,
    model_name: raw.model_name as string,
    version: (raw.version as string | null) ?? null,
    reasoning_effort: (raw.reasoning_effort as string | null) ?? null,
    // Absent on older servers = no kwargs were declared; anything non-object
    // is unreadable and reads as none rather than crashing a list page.
    kwargs:
      kwargs && typeof kwargs === "object" && !Array.isArray(kwargs)
        ? (kwargs as Record<string, unknown>)
        : null,
    // Same law for the preset: absent on older servers = none declared.
    preset: typeof raw.preset === "string" ? raw.preset : null,
    skills,
    skill_locks: skillLocks,
  };
}

/**
 * Map a version's activation-gate field, tolerating every server generation:
 * an older server that has no `gate` field at all, the current server's
 * nested form ({status, attempts, failure: {code, message, failed_tasks}}),
 * and the flat form ({status, attempts, code, message}). Anything unreadable becomes null
 * — a missing gate is "nothing to report", never a crash and never "passed".
 */
function mapVersionGate(raw: unknown): DatasetVersionGate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.status !== "string") return null;
  const failure =
    value.failure && typeof value.failure === "object" && !Array.isArray(value.failure)
      ? (value.failure as Record<string, unknown>)
      : {};
  const code = typeof value.code === "string" ? value.code : failure.code;
  const message = typeof value.message === "string" ? value.message : failure.message;
  return {
    status: value.status,
    attempts: typeof value.attempts === "number" ? value.attempts : 0,
    code: typeof code === "string" ? code : null,
    message: typeof message === "string" ? message : null,
    failed_tasks: mapGateFailedTasks(
      Array.isArray(value.failed_tasks) ? value.failed_tasks : failure.failed_tasks
    ),
  };
}

/**
 * The per-task cause list behind a FAILED gate. Same tolerance as the gate
 * itself: absent or unreadable input is an empty list, an entry without a
 * task name is dropped, and non-string reasons are filtered — an older or
 * misbehaving server must never crash the CLI here.
 */
function mapGateFailedTasks(raw: unknown): DatasetVersionGateFailedTask[] {
  if (!Array.isArray(raw)) return [];
  const tasks: DatasetVersionGateFailedTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.task_name !== "string") continue;
    tasks.push({
      task_name: entry.task_name,
      outcome: typeof entry.outcome === "string" ? entry.outcome : null,
      reasons: Array.isArray(entry.reasons)
        ? entry.reasons.filter((r): r is string => typeof r === "string")
        : [],
    });
  }
  return tasks;
}

/**
 * The dataset.toml metadata a version imported under. Defensive like every
 * mapper here: an older server (no field) or garbage reads as null, and a
 * present manifest gets its arrays normalized so a caller can iterate without
 * guarding — absence is "nothing to report", never a crash.
 */
function mapVersionManifest(raw: unknown): DatasetVersion["manifest"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const blob = raw as Record<string, unknown>;
  if (typeof blob.name !== "string") return null;
  const authors = Array.isArray(blob.authors)
    ? blob.authors.flatMap((a) => {
        if (!a || typeof a !== "object" || Array.isArray(a)) return [];
        const row = a as Record<string, unknown>;
        if (typeof row.name !== "string") return [];
        return [{ name: row.name, email: typeof row.email === "string" ? row.email : null }];
      })
    : [];
  return {
    name: blob.name,
    version: typeof blob.version === "string" ? blob.version : null,
    description: typeof blob.description === "string" ? blob.description : "",
    authors,
    keywords: Array.isArray(blob.keywords)
      ? blob.keywords.filter((k): k is string => typeof k === "string")
      : [],
    task_count: typeof blob.task_count === "number" ? blob.task_count : null,
  };
}

function mapDatasetVersion(raw: Record<string, unknown>): DatasetVersion {
  return {
    version: raw.version as string,
    state: raw.state as DatasetVersionState,
    created_at: raw.created_at as string,
    task_count: (raw.task_count as number) ?? 0,
    manifest: mapVersionManifest(raw.manifest),
    gate: mapVersionGate(raw.gate),
  };
}

function mapTask(raw: Record<string, unknown>): Task {
  return {
    task_name: raw.task_name as string,
    agent_timeout_sec: raw.agent_timeout_sec as number,
    verifier_timeout_sec: raw.verifier_timeout_sec as number,
    // The declared GPU requirement (Harbor's fields). Absent (older server)
    // or garbage reads as "a CPU task" — never a crash.
    gpus: typeof raw.gpus === "number" && raw.gpus > 0 ? raw.gpus : 0,
    gpu_types:
      Array.isArray(raw.gpu_types) && raw.gpu_types.length > 0
        ? (raw.gpu_types as string[]).map(String)
        : null,
    // Per-provider capability verdicts — the law: where a task can run is
    // visible before any money is spent.
    providers: raw.providers as Task["providers"],
  };
}

function mapSourceJob(raw: Record<string, unknown>): SourceJob {
  return {
    action: raw.action as SourceJob["action"],
    type: raw.type as SourceJob["type"],
    job_id: raw.job_id as string,
  };
}

/**
 * The resolved retry policy off a job body. Tolerant of an OLDER server that
 * does not send one yet: the absent-field reading is the retries-off policy
 * with Harbor's defaults — exactly how such a server behaves.
 */
function mapRetryConfig(raw: unknown): RetryConfig {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    max_retries: typeof value.max_retries === "number" ? value.max_retries : 0,
    include_exceptions: Array.isArray(value.include_exceptions)
      ? (value.include_exceptions as string[])
      : null,
    exclude_exceptions: Array.isArray(value.exclude_exceptions)
      ? (value.exclude_exceptions as string[])
      : [],
    wait_multiplier: typeof value.wait_multiplier === "number" ? value.wait_multiplier : 1.0,
    min_wait_sec: typeof value.min_wait_sec === "number" ? value.min_wait_sec : 1.0,
    max_wait_sec: typeof value.max_wait_sec === "number" ? value.max_wait_sec : 60.0,
  };
}

/** One retired attempt of a trial (the auto-retry lineage). */
function mapTrialRetry(raw: Record<string, unknown>): TrialRetry {
  return {
    attempt_number: raw.attempt_number as number,
    exception_info: (raw.exception_info as ExceptionInfo) ?? {
      exception_type: "InfrastructureError",
      exception_message: "",
    },
    cost_usd: (raw.cost_usd as number | null) ?? null,
    started_at: (raw.started_at as string | null) ?? null,
    settled_at: (raw.settled_at as string | null) ?? null,
  };
}

/** ONE job mapper for every call — nothing conditional, because nothing is optional. */
function mapJob(raw: Record<string, unknown>): Job {
  const trials = (raw.trials ?? {}) as Record<string, unknown>;
  return {
    id: raw.id as string,
    job_name: raw.job_name as string,
    status: raw.status as JobStatus,
    datasets: ((raw.datasets as Record<string, unknown>[]) ?? []).map(mapDatasetRef),
    agents: ((raw.agents as Record<string, unknown>[]) ?? []).map(mapAgentArm),
    n_attempts: raw.n_attempts as number,
    n_concurrent_trials: raw.n_concurrent_trials as number,
    max_trial_spend_usd: raw.max_trial_spend_usd as number,
    worst_case_spend_usd: raw.worst_case_spend_usd as number,
    retry: mapRetryConfig(raw.retry),
    sandbox_provider: raw.sandbox_provider as EvalSandboxProvider,
    counts: raw.counts as Job["counts"],
    n_total_trials: (raw.n_total_trials as number) ?? 0,
    trials: {
      total: (trials.total as number) ?? 0,
      // byStatus is one of the four frozen camelCase wire keys.
      byStatus: (trials.byStatus as TrialCounts) ?? ({} as TrialCounts),
    },
    stats: (raw.stats as JobStats) ?? {},
    failure: (raw.failure as JobFailure | null) ?? null,
    source_jobs: ((raw.source_jobs as Record<string, unknown>[]) ?? []).map(mapSourceJob),
    is_regrade: raw.is_regrade === true,
    idempotent_replay: raw.idempotent_replay === true,
    started_at: raw.started_at as string,
    updated_at: raw.updated_at as string,
    finished_at: (raw.finished_at as string | null) ?? null,
  };
}

/** The one page envelope, mapped: {items, nextCursor, hasMore}. */
function mapPage<T>(
  raw: unknown,
  mapItem: (item: Record<string, unknown>) => T
): Page<T> {
  const page = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(page.items)
    ? (page.items as Record<string, unknown>[]).map(mapItem)
    : [];
  return {
    items,
    nextCursor: (page.nextCursor as string | null) ?? null,
    hasMore: page.hasMore === true,
  };
}

/** Serialize { limit, cursor } (plus anything else) into a query string. */
function pageQuery(
  options?: PageOptions,
  extra?: Record<string, string | undefined>
): string {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.cursor) params.set("cursor", options.cursor);
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function mapTimingInfo(raw: unknown): TimingInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  return {
    started_at: (value.started_at as string | null) ?? null,
    finished_at: (value.finished_at as string | null) ?? null,
  };
}

function mapAgentInfo(raw: Record<string, unknown>): AgentInfo {
  const modelInfo = (raw.model_info ?? {}) as Record<string, unknown>;
  return {
    name: raw.name as string,
    // The version actually RESOLVED and used — null until resolved; the
    // requested pin lives on the job's agents[].version.
    version: (raw.version as string | null) ?? null,
    model_info: {
      name: modelInfo.name as string,
      provider: (modelInfo.provider as string | null) ?? null,
    },
    reasoning_effort: (raw.reasoning_effort as string | null) ?? null,
  };
}

/** The wire degrade object, defensively: anything malformed answers null. */
function mapProviderDegrade(raw: unknown): Trial["sandbox_provider_degrade"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { from, to, reason } = raw as Record<string, unknown>;
  if (typeof from !== "string" || typeof to !== "string" || typeof reason !== "string") return null;
  return { from: from as EvalSandboxProvider, to: to as EvalSandboxProvider, reason };
}

function mapTrial(raw: Record<string, unknown>): Trial {
  return {
    id: raw.id as string,
    job_id: raw.job_id as string,
    task_name: raw.task_name as string,
    source: raw.source as string,
    agent_info: mapAgentInfo((raw.agent_info as Record<string, unknown>) || {}),
    attempt: raw.attempt as number,
    status: raw.status as TrialStatus,
    reward: (raw.reward as number | null) ?? null,
    verifier_result: (raw.verifier_result as VerifierResult | null) ?? null,
    exception_info: (raw.exception_info as ExceptionInfo | null) ?? null,
    agent_result: (raw.agent_result as AgentResult | null) ?? null,
    environment_setup: mapTimingInfo(raw.environment_setup),
    agent_setup: mapTimingInfo(raw.agent_setup),
    agent_execution: mapTimingInfo(raw.agent_execution),
    verifier: mapTimingInfo(raw.verifier),
    step_results: (raw.step_results as StepResult[] | null) ?? null,
    spend_source: (raw.spend_source as SpendSource | null) ?? null,
    // Mid-run lower bound, kept beside the settled pair and never folded into
    // it: it lags the gateway and is CLEARED when the trial settles.
    live_spent_usd: (raw.live_spent_usd as number | null) ?? null,
    live_spend_at: (raw.live_spend_at as string | null) ?? null,
    max_trial_spend_usd: (raw.max_trial_spend_usd as number | null) ?? null,
    sandbox_provider: (raw.sandbox_provider as EvalSandboxProvider | null) ?? null,
    // GPU degrade record — defensive: a malformed object reads as null,
    // never a crash or a partial row.
    sandbox_provider_degrade: mapProviderDegrade(raw.sandbox_provider_degrade),
    // Where the trial ran. Absent reads the same as "never booted a box": null.
    sandbox_id: (raw.sandbox_id as string | null) ?? null,
    verifier_sandbox_id: (raw.verifier_sandbox_id as string | null) ?? null,
    verifier_environment_mode:
      (raw.verifier_environment_mode as VerifierEnvironmentMode | null) ?? null,
    attempt_phase: (raw.attempt_phase as AttemptPhase | null) ?? null,
    // Auto-retry lineage. An older server sends neither key; 0 / [] is
    // exactly what such a server's behavior means.
    n_retries: (raw.n_retries as number) ?? 0,
    retries: Array.isArray(raw.retries)
      ? (raw.retries as Record<string, unknown>[]).map(mapTrialRetry)
      : [],
    session_ref: (raw.session_ref as string | null) ?? null,
    started_at: (raw.started_at as string | null) ?? null,
    finished_at: (raw.finished_at as string | null) ?? null,
  };
}

function mapAgent(raw: Record<string, unknown>): Agent {
  return {
    name: raw.name as string,
    source: raw.source as AgentSource,
    run_command: raw.run_command as string,
    env: (raw.env as Record<string, string>) ?? {},
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
  };
}

function mapDatasetImport(raw: Record<string, unknown>): DatasetImport {
  const datasetImport: DatasetImport = {
    id: raw.id as string,
    status: raw.status as DatasetImportStatus,
    name: raw.name as string,
    version: raw.version as string,
    failure: (raw.failure as DatasetImportFailure | null) ?? null,
    // Consequential, not cosmetic: an import whose warnings include
    // no_solutions_archived can never be activated, and dropping the field
    // made it look identical to one that can.
    warnings: (raw.warnings as ImportWarning[]) ?? [],
  };
  if (typeof raw.task_count === "number") {
    datasetImport.task_count = raw.task_count;
  }
  if (typeof raw.created_at === "string") datasetImport.created_at = raw.created_at;
  if (typeof raw.updated_at === "string") datasetImport.updated_at = raw.updated_at;
  return datasetImport;
}

function mapCoverage(raw: unknown): CompareCoverage {
  const coverage = (raw ?? {}) as Record<string, unknown>;
  return {
    scored: (coverage.scored as number) ?? 0,
    total: (coverage.total as number) ?? 0,
  };
}

function mapCompareJobAggregate(raw: Record<string, unknown>): CompareJobAggregate {
  return {
    id: raw.id as string,
    datasets: ((raw.datasets as Record<string, unknown>[]) ?? []).map(mapDatasetRef),
    status: raw.status as JobStatus,
    mean_reward: (raw.mean_reward as number | null) ?? null,
    coverage: mapCoverage(raw.coverage),
    cost_usd: (raw.cost_usd as number) ?? 0,
    // Public arm fields only.
    agents: ((raw.agents as Record<string, unknown>[]) || []).map(mapAgentArm),
    started_at: raw.started_at as string,
  };
}

function mapCompareCell(raw: Record<string, unknown>): CompareCell {
  return {
    job_id: raw.job_id as string,
    status: raw.status as CompareCell["status"],
    mean_reward: (raw.mean_reward as number | null) ?? null,
    coverage: mapCoverage(raw.coverage),
  };
}

function mapCompareTaskRow(raw: Record<string, unknown>): CompareTaskRow {
  return {
    task_name: raw.task_name as string,
    disagreement: raw.disagreement === true,
    cells: ((raw.cells as Record<string, unknown>[]) || []).map(mapCompareCell),
  };
}

function mapTraceEvent(raw: Record<string, unknown>): TraceEvent {
  return {
    seq: raw.seq as number,
    type: raw.type as string,
    data: (raw.data as Record<string, unknown>) ?? {},
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Watch aborted");
  }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (error as { name?: string })?.name;
  return name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Watch aborted")
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// =============================================================================
// SSE PARSER
// =============================================================================

interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Incremental server-sent-events parser. Frames are separated by a blank line;
 * comment lines (":") are ignored (the server uses them as heartbeats).
 *
 * The SSE grammar ends a line on CRLF, LF, or a LONE CR, so all three
 * normalize to LF before the frame split — a CR-terminated stream used to sit
 * in the buffer forever, never producing a frame. A CR that ends a chunk is
 * held back until the next push: normalized eagerly it would read a CRLF pair
 * split across chunks as two terminators, minting a frame boundary nobody sent.
 */
function createSseParser(onFrame: (frame: SseFrame) => void): { push(chunk: string): void } {
  let buffer = "";
  let pendingCr = false;
  return {
    push(chunk: string) {
      if (pendingCr) {
        chunk = "\r" + chunk;
        pendingCr = false;
      }
      if (chunk.endsWith("\r")) {
        chunk = chunk.slice(0, -1);
        pendingCr = true;
      }
      buffer += chunk.replace(/\r\n|\r/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let id: string | undefined;
        let event: string | undefined;
        const dataLines: string[] = [];
        for (const line of rawFrame.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "id") id = value;
          else if (field === "event") event = value;
          else if (field === "data") dataLines.push(value);
        }
        if (id !== undefined || event !== undefined || dataLines.length > 0) {
          onFrame({ id, event, data: dataLines.join("\n") });
        }
      }
    },
  };
}

// =============================================================================
// HYBRID HANDLES (awaitable + async-iterable)
// =============================================================================

/**
 * Wrap a cursor-paged fetch as a value that is both awaitable (resolves the
 * first page, honoring the caller's limit/cursor) and async-iterable (walks
 * every row across pages, starting from the caller's cursor).
 */
function makePaginated<TRow>(
  fetchPage: (opts: PageOptions) => Promise<Page<TRow>>,
  options?: PageOptions
): Awaitable<Page<TRow>> & AsyncIterable<TRow> {
  // ONE underlying request per handle, no matter which promise method reaches
  // it first. Without the memo, `handle.then(...)` and a later `handle.catch()`
  // would each issue their own fetch — two pages billed for one await.
  let firstPage: Promise<Page<TRow>> | undefined;
  const page = (): Promise<Page<TRow>> =>
    (firstPage ??= fetchPage({ limit: options?.limit, cursor: options?.cursor }));

  return {
    then<TResult1 = Page<TRow>, TResult2 = never>(
      onfulfilled?: ((value: Page<TRow>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
      return page().then(onfulfilled, onrejected);
    },
    catch<TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
    ): Promise<Page<TRow> | TResult> {
      return page().catch(onrejected);
    },
    finally(onfinally?: (() => void) | null): Promise<Page<TRow>> {
      return page().finally(onfinally);
    },
    async *[Symbol.asyncIterator](): AsyncIterator<TRow> {
      let cursor = options?.cursor;
      for (;;) {
        const page = await fetchPage({ limit: options?.limit, cursor });
        for (const row of page.items) yield row;
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
      }
    },
  };
}

/**
 * Build the multipart/form-data body both upload routes take: metadata as
 * named parts FIRST, then the bytes as an `archive` part. Order matters — the
 * server refuses a name it will never accept before receiving the upload, and
 * it can only do that if the metadata arrives first.
 */
function uploadForm(
  fields: Record<string, string | undefined>,
  archive?: { bytes: Uint8Array; filename: string }
): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(name, value);
  }
  if (archive) {
    form.set(
      "archive",
      new Blob([archive.bytes as unknown as BlobPart], { type: "application/gzip" }),
      archive.filename
    );
  }
  return form;
}

/**
 * Wrap a watch event generator as a value that is both awaitable (resolves the
 * final Job) and async-iterable (yields each event). Both forms drive
 * the same generator, so a single handle is meant for one form or the other.
 */
function makeWatch(
  gen: AsyncGenerator<JobEvent, Job>
): JobWatch {
  let drained: Promise<Job> | undefined;
  const drain = (): Promise<Job> => {
    if (!drained) {
      drained = (async () => {
        let result = await gen.next();
        while (!result.done) result = await gen.next();
        return result.value;
      })();
    }
    return drained;
  };
  return {
    then<TResult1 = Job, TResult2 = never>(
      onfulfilled?: ((value: Job) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
      return drain().then(onfulfilled, onrejected);
    },
    // drain() is already memoized, so catching or finally-ing a handle drives
    // the same single SSE stream rather than opening a second one.
    catch<TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
    ): Promise<Job | TResult> {
      return drain().catch(onrejected);
    },
    finally(onfinally?: (() => void) | null): Promise<Job> {
      return drain().finally(onfinally);
    },
    [Symbol.asyncIterator](): AsyncIterator<JobEvent> {
      return gen;
    },
  };
}

/**
 * The server states the verified digest of a package here. When it is present
 * the client re-checks it: the server hashes the stored object before sending,
 * and this closes the other half of the chain — the wire. A digest nobody
 * verifies is decoration.
 */
export const PACKAGE_DIGEST_HEADER = "x-package-sha256";

/**
 * Downloaded bytes did not match the digest the server stated for them.
 *
 * NOT an EvolveApiError: the request succeeded, so it gets its own type rather
 * than an invented error code.
 */
export class EvolveDigestMismatchError extends Error {
  readonly name = "EvolveDigestMismatchError";
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `downloaded bytes do not match the digest the server stated ` +
        `(expected ${expected}, got ${actual})`
    );
  }
}

/**
 * A download ended early: fewer bytes arrived than Content-Length promised.
 *
 * Its own type because a truncated body is not a wrong body — the distinction
 * tells a caller whether to retry (yes) or to stop trusting the stored object
 * (that is the digest error).
 */
export class EvolveIncompleteDownloadError extends Error {
  readonly name = "EvolveIncompleteDownloadError";
  constructor(
    readonly expectedBytes: number,
    readonly receivedBytes: number
  ) {
    super(
      `download ended early: the server declared ${expectedBytes} bytes and ` +
        `${receivedBytes} arrived`
    );
  }
}

/** Throw when fewer bytes arrived than Content-Length promised (no header = nothing to check). */
function assertCompleteBody(res: Response, received: number): void {
  const declared = res.headers.get("Content-Length");
  if (declared === null) return;
  const expected = Number(declared);
  if (Number.isFinite(expected) && received !== expected) {
    throw new EvolveIncompleteDownloadError(expected, received);
  }
}

/**
 * Throw unless `bytes` hash to the digest the response declared (no header =
 * nothing to check). The in-memory shape only — the to-disk shape hashes while
 * streaming, because it must not hold the package in memory to check it.
 */
async function verifyPackageDigest(res: Response, bytes: Buffer): Promise<void> {
  const expected = res.headers.get(PACKAGE_DIGEST_HEADER);
  if (!expected) return;
  const { createHash } = await import("crypto");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new EvolveDigestMismatchError(expected, actual);
}

/**
 * The filename to save a download under, taken from Content-Disposition.
 *
 * THE SERVER DOES NOT GET TO CHOOSE A PATH. This value is joined onto a
 * directory the user picked, so a filename carrying "/" or ".." would write
 * outside it — and the dataset download's filename interpolates a
 * user-supplied version label, which makes it attacker-influenced rather than
 * merely server-supplied. basename() strips any directory part, and anything
 * that still looks like a path component, is empty, or is a dot-entry falls
 * back to the caller's own name.
 *
 * One helper for both download surfaces on purpose: the job download had the
 * same bug, and a second copy is how one of them gets fixed and the other does
 * not.
 */
function safeDownloadFilename(res: Response, fallback: string): string {
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  if (!match) return fallback;
  const candidate = basename(match[1]);
  if (
    candidate === "" ||
    candidate === "." ||
    candidate === ".." ||
    /[/\\]/.test(candidate) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(candidate)
  ) {
    return fallback;
  }
  return candidate;
}

/**
 * Stream a download to `dir` with the full integrity dance, and return the
 * saved path. ONE implementation for both download surfaces (dataset package
 * and job archive) — the job download used to do a bare pipeline with no
 * Content-Length or digest check twelve lines below the hardened package path,
 * and Python never had that hole because both of its shapes share one helper.
 *
 * TEMP-THEN-RENAME. Bytes never appear at the final path until they are
 * complete AND verified, so a transfer that dies partway leaves nothing a
 * later run could mistake for the real object. rename within one directory is
 * atomic on every platform we target.
 *
 * THE SUFFIX IS PER CALL, and it is not decoration. Two concurrent downloads
 * of one object into one directory shared `<file>.part` verbatim: they
 * interleaved writes into the same file, then the first rename won and the
 * second died on a bare ENOENT with no hint of why. Worse quietly: each call
 * hashed ITS OWN stream, so the digest check proved something about bytes that
 * were never the ones on disk. With a random name per call, each stream owns
 * its file end to end, the verification covers exactly what gets promoted, and
 * both callers get the object.
 *
 * Hashed WHILE streaming, never buffered: a package can be 512 MB, and reading
 * it into memory to check a digest would trade one correctness problem for a
 * heap one.
 */
async function downloadToDir(res: Response, dir: string, fallback: string): Promise<string> {
  if (!res.body) throw new Error("Download response has no body");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, safeDownloadFilename(res, fallback));
  const { createHash, randomBytes } = await import("crypto");
  const partPath = `${filePath}.${randomBytes(8).toString("hex")}.part`;
  const hash = createHash("sha256");
  let received = 0;
  const nodeStream = Readable.fromWeb(
    res.body as import("stream/web").ReadableStream
  );
  nodeStream.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
  });
  try {
    await pipeline(nodeStream, createWriteStream(partPath));
    // TRUNCATION. A socket cut mid-body is not an error to fetch — the stream
    // simply ends — so a short read returned a partial file as success.
    // Content-Length is the server's own count; disagreeing with it means the
    // body did not all arrive.
    const declared = res.headers.get("Content-Length");
    if (declared !== null && received !== Number(declared)) {
      throw new EvolveIncompleteDownloadError(Number(declared), received);
    }
    const expected = res.headers.get(PACKAGE_DIGEST_HEADER);
    const actual = hash.digest("hex");
    if (expected && actual !== expected) {
      throw new EvolveDigestMismatchError(expected, actual);
    }
    await rename(partPath, filePath);
  } catch (error) {
    // The partial never gets promoted, and never survives: a file that looks
    // like the real object and is not is worse than no file at all.
    await rm(partPath, { force: true }).catch(() => {});
    throw error;
  }
  return filePath;
}

// =============================================================================
// DATASETS CLIENT
// =============================================================================

/**
 * Create a DatasetsClient for the shared dataset catalog.
 *
 * Requires EVOLVE_API_KEY (or { apiKey } in config).
 *
 * @example
 * ```ts
 * import { datasets } from "@evolvingmachines/sdk";
 *
 * const d = datasets();
 * const catalog = await d.list();
 * const deepSwe = await d.get("deep-swe@1.1");
 * ```
 */
export function datasets(config?: HostedClientConfig): DatasetsClient {
  const cfg = resolveConfig("datasets", config);

  async function getImport(id: string): Promise<DatasetImport> {
    const res = await request(cfg, `/api/datasets/imports/${encodeURIComponent(id)}`);
    return mapDatasetImport((await res.json()) as Record<string, unknown>);
  }

  /**
   * Map the `upstream` field, tolerating an older server that omits it.
   *
   * A missing field and an explicit null mean the same thing to a caller —
   * nothing to watch — so both become null rather than undefined, and a client
   * never has to distinguish "this server is old" from "this dataset has no
   * git source".
   */
  function mapUpstream(raw: unknown): UpstreamStatus | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    return {
      ref: value.ref as string,
      current_commit: value.current_commit as string,
      latest_commit: (value.latest_commit as string | null) ?? null,
      moved: value.moved === true,
      behind_by: typeof value.behind_by === "number" ? value.behind_by : null,
      checked_at: (value.checked_at as string | null) ?? null,
      error: (value.error as string | null) ?? null,
      auto_import: value.auto_import === true,
    };
  }

  /** The full detail Dataset shape: get() and activate() echo it. */
  function mapDatasetDetail(raw: Record<string, unknown>): Dataset {
    return {
      name: raw.name as string,
      title: (raw.title as string | null) ?? null,
      description: (raw.description as string | null) ?? null,
      // active_version is the full version object on every route (list + detail).
      active_version: raw.active_version
        ? mapDatasetVersion(raw.active_version as Record<string, unknown>)
        : null,
      versions: ((raw.versions as Record<string, unknown>[]) || []).map(mapDatasetVersion),
      selected_version: raw.selected_version
        ? mapDatasetVersion(raw.selected_version as Record<string, unknown>)
        : null,
      tasks: mapPage(raw.tasks, mapTask),
      upstream: mapUpstream(raw.upstream),
      created_at: raw.created_at as string,
      updated_at: raw.updated_at as string,
    };
  }

  async function getDataset(
    ref: string,
    options?: GetDatasetOptions
  ): Promise<Dataset> {
    const parsed = parseDatasetRef(ref);
    const query = pageQuery(options, { version: parsed.version });
    const res = await request(
      cfg,
      `/api/datasets/${encodeURIComponent(parsed.name)}${query}`
    );
    return mapDatasetDetail((await res.json()) as Record<string, unknown>);
  }

  /** The summary Dataset shape: list rows and the update() echo share it. */
  function mapDatasetSummary(raw: Record<string, unknown>): Dataset {
    return {
      name: raw.name as string,
      title: (raw.title as string | null) ?? null,
      description: (raw.description as string | null) ?? null,
      active_version: raw.active_version
        ? mapDatasetVersion(raw.active_version as Record<string, unknown>)
        : null,
      upstream: mapUpstream(raw.upstream),
    };
  }

  async function listPage(options?: ListDatasetsOptions): Promise<DatasetPage> {
    const res = await request(
      cfg,
      `/api/datasets${pageQuery(options, { search: options?.search })}`
    );
    return mapPage((await res.json()) as Record<string, unknown>, mapDatasetSummary);
  }

  return {
    list(options?: ListDatasetsOptions): DatasetList {
      // Await for one page; for-await to walk the catalog across cursor
      // pages. The search filter rides along on every page fetch.
      return makePaginated((opts) => listPage({ ...opts, search: options?.search }), options);
    },

    get: getDataset,

    async getActive(name: string, options?: GetDatasetOptions): Promise<ActiveDataset> {
      // get(name) with a bare name resolves the active version's task list; the
      // detail route echoes the active version so we can hard-require it here.
      const dataset = await getDataset(name, options);
      if (dataset.active_version === null) {
        throw new NoActiveVersionError(name);
      }
      return {
        name: dataset.name,
        title: dataset.title,
        description: dataset.description,
        active_version: dataset.active_version,
        version: dataset.active_version.version,
        tasks: dataset.tasks ?? { items: [], nextCursor: null, hasMore: false },
        versions: dataset.versions ?? [],
        created_at: dataset.created_at as string,
        updated_at: dataset.updated_at as string,
      };
    },

    async publish(input: PublishDatasetInput): Promise<DatasetImport> {
      const src = input.source;
      // ONE body grammar: multipart/form-data, metadata in named parts. The
      // corpus is the `archive` part; a git source is the git_url + git_ref
      // parts. Nothing rides the query string, where it would land in access
      // logs.
      //
      // The run-time checks below STAY even though DatasetSource is a union
      // that makes `{}` and both-at-once uncompilable. The type guards
      // TypeScript callers; these guard JavaScript ones, and anything that
      // arrived through a JSON.parse — a config file, an HTTP body, a CLI flag
      // — where no type was ever checked.
      if (src?.directory) {
        // name/version may be omitted when the corpus carries a dataset.toml
        // manifest — the SERVER derives them from it (the manifest is also
        // what drives selection and digest verification there). The only
        // client-side check is the cheap one that saves a wasted upload: if
        // neither the flags nor a manifest file exist, say so before tarring
        // and shipping the corpus.
        if (input.name === undefined || input.version === undefined) {
          const { existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          const hasManifest =
            existsSync(join(src.directory, "dataset.toml")) ||
            existsSync(join(src.directory, "tasks", "dataset.toml"));
          if (!hasManifest) {
            throw new Error(
              `datasets().publish() needs ${input.name === undefined ? "a name" : "a version"} — ` +
                "pass it explicitly, or add a dataset.toml manifest to the corpus directory " +
                "(the server then derives name and version from it)"
            );
          }
        }
        const { tarGzipDirectory } = await import("./tar");
        const gzipped = await tarGzipDirectory(src.directory);
        const res = await request(cfg, "/api/datasets/publish", {
          method: "POST",
          body: uploadForm(
            { name: input.name, version: input.version },
            { bytes: gzipped, filename: "corpus.tar.gz" }
          ),
        });
        return mapDatasetImport((await res.json()) as Record<string, unknown>);
      }
      // `"git_url" in src` rather than testing both fields: the union makes
      // git_ref REQUIRED on the git branch, so a source carrying git_url
      // without git_ref is already a compile error for a typed caller — and
      // for an untyped one, the server refuses it with a named param, which is
      // a better error than this function's generic sentence.
      if (src && "git_url" in src && src.git_url) {
        // A git source cannot lean on its manifest: the server only reads it
        // after the clone, long after the 202 has promised a name. Refuse
        // here with the reason instead of a round trip to the same refusal.
        if (input.name === undefined || input.version === undefined) {
          throw new Error(
            "datasets().publish() requires name and version for a git source — a dataset.toml " +
              "manifest can only supply them for a directory source, because a git repository " +
              "is cloned server-side after the publish is accepted"
          );
        }
        const res = await request(cfg, "/api/datasets/publish", {
          method: "POST",
          body: uploadForm({
            name: input.name,
            version: input.version,
            git_url: src.git_url,
            git_ref: src.git_ref,
            // Only when narrowing to a subfolder: an absent part means "the
            // repository root", and sending an empty part would be refused.
            ...(src.git_path !== undefined ? { git_path: src.git_path } : {}),
          }),
        });
        return mapDatasetImport((await res.json()) as Record<string, unknown>);
      }
      throw new Error(
        "datasets().publish() requires either a git source ({ source: { git_url, git_ref } }) " +
          "or a local corpus directory ({ source: { directory } }), plus name and version " +
          "(both optional for a directory whose corpus carries a dataset.toml manifest)"
      );
    },

    getImport,

    async watchImport(id: string, options?: WatchImportOptions): Promise<DatasetImport> {
      const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_IMPORT_POLL_INTERVAL_MS;
      let lastStatus: string | null = null;
      for (;;) {
        throwIfAborted(options?.signal);
        let current: DatasetImport;
        try {
          current = await getImport(id);
        } catch (error) {
          // A rate limit or hiccup mid-watch is a delay, not an outcome: honor
          // the server's Retry-After and keep watching. Dying here turned a
          // 429 into a failed watch while the import kept running.
          if (
            error instanceof EvolveApiError &&
            (error.status === 429 || error.status === 503)
          ) {
            await sleep(
              Math.max((error.retryAfterSec ?? 0) * 1000, pollIntervalMs),
              options?.signal
            );
            continue;
          }
          throw error;
        }
        if (current.status !== lastStatus) {
          lastStatus = current.status;
          options?.onStatus?.(current);
        }
        if (TERMINAL_IMPORT_STATUSES.has(current.status)) return current;
        await sleep(pollIntervalMs, options?.signal);
      }
    },

    download: (async (
      ref: string,
      options?: DownloadDatasetOptions
    ): Promise<Buffer | string | ReadableStream<Uint8Array>> => {
      // Same three delivery shapes as jobs().download(), because it is the
      // same job for the caller: a potentially large binary that they want in
      // memory, on disk, or piped somewhere.
      const parsed = parseDatasetRef(ref);
      const query = parsed.version
        ? `?version=${encodeURIComponent(parsed.version)}`
        : "";
      const res = await request(
        cfg,
        `/api/datasets/${encodeURIComponent(parsed.name)}/download${query}`
      );
      if (options?.stream) {
        if (!res.body) throw new Error("Package response has no body");
        // The ONLY shape that cannot be verified here: the caller consumes the
        // stream, so only they ever hold the whole body. Read
        // PACKAGE_DIGEST_HEADER off the response and hash as you go.
        return res.body as ReadableStream<Uint8Array>;
      }
      if (options?.to) {
        return downloadToDir(res, options.to, `${parsed.name}-corpus.tar.gz`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      assertCompleteBody(res, bytes.length);
      await verifyPackageDigest(res, bytes);
      return bytes;
    }) as DatasetsClient["download"],

    listImports(options?: ListImportsOptions): DatasetImportList {
      // Await for one page; for-await to walk them all across cursor pages.
      return makePaginated(async (opts) => {
        const query = new URLSearchParams();
        if (opts.limit !== undefined) query.set("limit", String(opts.limit));
        if (opts.cursor !== undefined) query.set("cursor", opts.cursor);
        if (options?.status !== undefined) query.set("status", options.status);
        if (options?.dataset !== undefined) query.set("dataset", options.dataset);
        const suffix = query.toString() ? `?${query}` : "";
        const res = await request(cfg, `/api/datasets/imports${suffix}`);
        return mapPage((await res.json()) as Record<string, unknown>, mapDatasetImport);
      }, options);
    },

    async activate(name: string, version: string): Promise<Dataset> {
      const res = await request(
        cfg,
        `/api/datasets/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/activate`,
        { method: "POST" }
      );
      return mapDatasetDetail((await res.json()) as Record<string, unknown>);
    },

    async update(name: string, patch: DatasetPatch): Promise<Dataset> {
      // The one settable field, upstream_auto_import. Refused with
      // upstream_not_watchable when the dataset has no moving git ref to
      // follow, and dataset_not_owned on a platform-curated dataset — both
      // typed EvolveApiError, not silent no-ops.
      const res = await request(cfg, `/api/datasets/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return mapDatasetSummary((await res.json()) as Record<string, unknown>);
    },

    async delete(name: string): Promise<void> {
      // 204 No Content — nothing to map. A dataset some job still references
      // is refused with dataset_in_use, and err.details.sampleJobIds names
      // the jobs blocking it.
      await request(cfg, `/api/datasets/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
  };
}

// =============================================================================
// AGENTS CLIENT (bring-your-own)
// =============================================================================

/**
 * Create an AgentsClient for the caller's own private registered agents.
 *
 * Register an agent once, then name it in job `agents[].name` exactly
 * like a built-in. Requires EVOLVE_API_KEY (or { apiKey } in config).
 *
 * @example
 * ```ts
 * import { agents, jobs } from "@evolvingmachines/sdk";
 *
 * const registered = agents();
 * await registered.create({
 *   name: "acme-cli",
 *   install_script: "curl -fsSL https://acme.dev/install.sh | sh",
 *   run_command: "acme-cli --headless",
 * });
 *
 * await jobs().start({
 *   datasets: [{ name: "deep-swe" }],
 *   agents: [{ name: "acme-cli", model_name: "gpt-5.5" }],
 *   max_trial_spend_usd: 25,
 * });
 * ```
 */
export function agents(config?: HostedClientConfig): AgentsClient {
  const cfg = resolveConfig("agents", config);

  return {
    async create(input: AgentInput): Promise<Agent> {
      // ONE body grammar: multipart/form-data. The run command and the declared
      // env are named PARTS — they used to ride the query string of an upload,
      // which put a shell command and a set of environment values into every
      // access log and proxy buffer on the way here.
      const body = await agentUploadBody("agents().create()", input);
      const res = await request(cfg, "/api/agents", { method: "POST", body });
      return mapAgent((await res.json()) as Record<string, unknown>);
    },

    list(options?: ListAgentsOptions): AgentList {
      // Await for one page; for-await to walk them all across cursor pages.
      return makePaginated(async (opts) => {
        const res = await request(cfg, `/api/agents${pageQuery(opts)}`);
        return mapPage((await res.json()) as Record<string, unknown>, mapAgent);
      }, options);
    },

    async get(name: string): Promise<Agent> {
      const res = await request(cfg, `/api/agents/${encodeURIComponent(name)}`);
      return mapAgent((await res.json()) as Record<string, unknown>);
    },

    async delete(name: string): Promise<void> {
      // 204 No Content — nothing to map.
      await request(cfg, `/api/agents/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    },

    async upsert(name: string, input: AgentUpsertInput): Promise<Agent> {
      // One request, so the name never briefly stops resolving the way
      // delete()+create() makes it. Same body grammar as create(), minus the
      // name part — the URL carries it.
      const body = await agentUploadBody("agents().upsert()", { ...input, name });
      const res = await request(cfg, `/api/agents/${encodeURIComponent(name)}`, {
        method: "PUT",
        body,
      });
      return mapAgent((await res.json()) as Record<string, unknown>);
    },
  };
}

/**
 * The multipart body both create() and upsert() send. Shared because the two
 * differ only in method and URL: one grammar means an agent registered by
 * either route is byte-identical on the wire.
 */
async function agentUploadBody(
  caller: string,
  input: AgentInput
): Promise<FormData> {
  // Same division of labour as datasets().publish(): AgentSourceInput is a
  // union, so a TypeScript caller cannot pass both or neither. These checks
  // are for JavaScript callers and for values that crossed a JSON boundary
  // with no type behind them.
  const hasInstallScript = typeof input.install_script === "string";
  const hasDirectory = typeof input.directory === "string";
  if (hasInstallScript && hasDirectory) {
    throw new Error(
      `${caller} takes EITHER an install script ({ install_script }) ` +
        "or a local directory ({ directory }), not both"
    );
  }
  if (!hasInstallScript && !hasDirectory) {
    throw new Error(
      `${caller} requires either an install script ({ install_script }) ` +
        "or a local directory ({ directory }), plus run_command"
    );
  }
  const fields: Record<string, string | undefined> = {
    name: input.name,
    run_command: input.run_command,
    ...(input.env !== undefined ? { env: JSON.stringify(input.env) } : {}),
    ...(hasInstallScript ? { install_script: input.install_script } : {}),
  };
  if (hasDirectory) {
    const { tarGzipDirectory } = await import("./tar");
    const gzipped = await tarGzipDirectory(input.directory as string);
    return uploadForm(fields, { bytes: gzipped, filename: "source.tar.gz" });
  }
  return uploadForm(fields);
}

// =============================================================================
// SKILLS CLIENT
// =============================================================================

function mapSkillUpload(raw: Record<string, unknown>): SkillUpload {
  return {
    id: raw.id as string,
    name: raw.name as string,
    digest: raw.digest as string,
    size_bytes: (raw.size_bytes as number) ?? 0,
    description: (raw.description as string | null) ?? null,
    ref: (raw.ref as string) ?? `upload:${raw.id as string}`,
    created_at: raw.created_at as string,
  };
}

/**
 * Create a SkillsClient for platform-stored skills.
 *
 * An uploaded skill is an immutable folder (content-digested with Harbor's
 * recipe) that jobs reference as `upload:<id>` in `agents[].skills`, next to
 * skills.sh and git references. Requires EVOLVE_API_KEY (or { apiKey }).
 *
 * @example
 * ```ts
 * import { skills, jobs } from "@evolvingmachines/sdk";
 *
 * const [uploaded] = await skills().upload("./my-skill");
 * await jobs().start({
 *   datasets: [{ name: "deep-swe" }],
 *   agents: [{ name: "claude", model_name: "claude-opus-4-1", skills: [uploaded.ref] }],
 * });
 * ```
 */
export function skills(config?: HostedClientConfig): SkillsClient {
  const cfg = resolveConfig("skills", config);

  return {
    async upload(directory: string): Promise<SkillUpload[]> {
      if (typeof directory !== "string" || !directory.trim()) {
        throw new Error("skills().upload() requires a local skill directory path");
      }
      const { tarGzipDirectory } = await import("./tar");
      const { basename, resolve } = await import("node:path");
      // The archive packs the folder's CONTENT (SKILL.md at the archive
      // root); the folder's own name travels beside it, so a single-skill
      // upload is recorded — and later mounted — under its folder name.
      const folderName = basename(resolve(directory));
      const gzipped = await tarGzipDirectory(directory);
      const res = await request(cfg, "/api/skills", {
        method: "POST",
        body: uploadForm(
          { name: folderName || undefined },
          { bytes: gzipped, filename: "skill.tar.gz" },
        ),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const items = Array.isArray(body.skills) ? (body.skills as Record<string, unknown>[]) : [body];
      return items.map(mapSkillUpload);
    },

    list(options?: ListSkillsOptions): SkillUploadList {
      return makePaginated(async (opts) => {
        const res = await request(cfg, `/api/skills${pageQuery(opts)}`);
        return mapPage((await res.json()) as Record<string, unknown>, mapSkillUpload);
      }, options);
    },

    async get(id: string): Promise<SkillUpload & { skill_md: string | null }> {
      const res = await request(cfg, `/api/skills/${encodeURIComponent(id)}`);
      const raw = (await res.json()) as Record<string, unknown>;
      return {
        ...mapSkillUpload(raw),
        skill_md: (raw.skill_md as string | null) ?? null,
      };
    },

    async delete(id: string): Promise<void> {
      await request(cfg, `/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}

// =============================================================================
// JOBS CLIENT
// =============================================================================

/**
 * Create a JobsClient for hosted jobs.
 *
 * Requires EVOLVE_API_KEY (or { apiKey } in config).
 *
 * @example
 * ```ts
 * import { jobs } from "@evolvingmachines/sdk";
 *
 * const client = jobs();
 * // datasets: bare name = active version; { name, version } pins one
 * const job = await client.start({
 *   datasets: [{ name: "deep-swe" }],
 *   agents: [{ name: "codex", model_name: "gpt-5.5" }],
 *   n_attempts: 1,
 *   n_concurrent_trials: 4,
 *   max_trial_spend_usd: 25,
 * });
 * const final = await client.watch(job.id, {
 *   onEvent: (event) => console.log(event.type, event.data),
 * });
 * ```
 */
export function jobs(config?: HostedClientConfig): JobsClient {
  const cfg = resolveConfig("jobs", config);

  async function getJob(id: string): Promise<Job> {
    const res = await request(cfg, `/api/jobs/${encodeURIComponent(id)}`);
    return mapJob((await res.json()) as Record<string, unknown>);
  }

  async function listPage(options?: ListJobsOptions): Promise<JobPage> {
    const res = await request(
      cfg,
      `/api/jobs${pageQuery(options, { search: options?.search })}`
    );
    return mapPage((await res.json()) as Record<string, unknown>, mapJob);
  }

  function mapJobTaskRollup(raw: Record<string, unknown>): JobTaskRollup {
    const trials = (raw.trials ?? {}) as Record<string, unknown>;
    return {
      task_name: raw.task_name as string,
      source: raw.source as string,
      trials: {
        total: (trials.total as number) ?? 0,
        byStatus: (trials.byStatus as TrialCounts) ?? ({} as TrialCounts),
      },
      mean_reward: (raw.mean_reward as number | null) ?? null,
      cost_usd: (raw.cost_usd as number | null) ?? null,
    };
  }

  async function trialsPage(
    id: string,
    options?: ListTrialsOptions
  ): Promise<TrialPage> {
    const query = pageQuery(options, {
      status: options?.status?.length ? options.status.join(",") : undefined,
      dataset: options?.dataset,
    });
    const res = await request(cfg, `/api/jobs/${encodeURIComponent(id)}/trials${query}`);
    return mapPage((await res.json()) as Record<string, unknown>, mapTrial);
  }

  /**
   * Drive the SSE watch stream, yielding each event and returning the final
   * Job. Same reconnect / Last-Event-ID / terminal-drain semantics as
   * before; onEvent (when supplied) fires alongside every yield so the callback
   * form keeps working. makeWatch() wraps this as the dual-use watch handle.
   */
  async function* watchEvents(
    id: string,
    options?: WatchJobOptions
  ): AsyncGenerator<JobEvent, Job> {
    const { onEvent, signal } = options ?? {};
    const initialDelayMs = options?.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const maxDelayMs = options?.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS;

    let lastSeq: number | null = null;
    let terminal = false;
    let finalDrainDone = false;
    let delayMs = initialDelayMs;

    while (!terminal) {
      throwIfAborted(signal);

      let res: Response;
      try {
        res = await fetch(
          `${cfg.baseUrl}/api/jobs/${encodeURIComponent(id)}/events`,
          {
            headers: {
              Authorization: `Bearer ${cfg.apiKey}`,
              Accept: "text/event-stream",
              ...(lastSeq !== null ? { "Last-Event-ID": String(lastSeq) } : {}),
            },
            signal,
          }
        );
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        // Network failure: back off and reconnect from lastSeq.
        await sleep(delayMs, signal);
        delayMs = Math.min(delayMs * 2, maxDelayMs);
        continue;
      }

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          const text = await res.text().catch(() => "");
          // A Retry-After from the server outranks the local backoff guess, and
          // it is read by the ONE law — body first, header second — so a 429
          // that carries the delay only in its envelope is honored here too.
          const retryAfterSec = readRetryAfterSec(text, res) ?? 0;
          const waitMs =
            retryAfterSec > 0 ? Math.max(retryAfterSec * 1000, delayMs) : delayMs;
          await sleep(waitMs, signal);
          delayMs = Math.min(delayMs * 2, maxDelayMs);
          continue;
        }
        await throwApiError(res);
      }
      if (!res.body) {
        throw new Error("Event stream response has no body");
      }

      let receivedEvent = false;
      // The parser callback cannot yield, so it stages events here; the read
      // loop drains and yields them after each chunk, in wire order.
      const pending: JobEvent[] = [];
      const parser = createSseParser((frame) => {
        const seq = Number(frame.id);
        // The ONE place the wire crosses into the typed union, and it belongs
        // here rather than at every call site: the server is the authority on
        // which `type` carries which `data`, and every member of JobEvent was
        // read off the contract. A frame whose type is not in the union still
        // flows through (an older or newer server may send one) — it simply
        // will not narrow to a known member for the caller.
        const event = {
          seq: Number.isInteger(seq) ? seq : -1,
          type: frame.event || "message",
          data: frame.data ? safeJsonParse(frame.data) : {},
        } as unknown as JobEvent;
        if (Number.isInteger(seq)) lastSeq = seq;
        receivedEvent = true;
        if (TERMINAL_EVENT_TYPES.has(event.type)) terminal = true;
        pending.push(event);
      });

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      try {
        while (!terminal) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
          // Drain in-order: the terminal event (if any) is delivered here
          // before the loop condition re-checks and exits.
          for (const event of pending) {
            onEvent?.(event);
            yield event;
          }
          pending.length = 0;
        }
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        // Broken stream: fall through to reconnect from lastSeq.
      } finally {
        await reader.cancel().catch(() => {});
      }

      if (terminal) break;
      throwIfAborted(signal);

      // The stream closed without a terminal event (server drain fallback or
      // connection loss). Events may still be in flight just after the status
      // turns terminal, so drain once more from lastSeq before finishing on
      // status alone.
      const current = await getJob(id);
      if (TERMINAL_JOB_STATUSES.has(current.status)) {
        if (finalDrainDone) return current;
        finalDrainDone = true;
        continue;
      }
      if (receivedEvent) delayMs = initialDelayMs;
      await sleep(delayMs, signal);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }

    return getJob(id);
  }

  return {
    async start(input: JobCreate, options?: StartJobOptions): Promise<Job> {
      const res = await request(cfg, "/api/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options?.idempotencyKey
            ? { "Idempotency-Key": options.idempotencyKey }
            : {}),
        },
        body: JSON.stringify(input),
      });
      return mapJob((await res.json()) as Record<string, unknown>);
    },

    get: getJob,

    list(options?: ListJobsOptions): JobList {
      // Await for one page (honoring options); for-await to walk every
      // job across cursor pages. The search filter rides along on every
      // page fetch — makePaginated forwards only limit/cursor.
      return makePaginated((opts) => listPage({ ...opts, search: options?.search }), options);
    },

    trials(id: string, options?: ListTrialsOptions): TrialList {
      // Await for one page; for-await to walk every trial across cursors.
      // The status and dataset filters ride along on every page fetch.
      return makePaginated(
        (opts) => trialsPage(id, { ...opts, status: options?.status, dataset: options?.dataset }),
        options
      );
    },

    tasks(id: string, options?: ListJobTasksOptions): JobTaskRollupList {
      // Await for one page; for-await to walk every rollup across cursors.
      return makePaginated(async (opts) => {
        const res = await request(
          cfg,
          `/api/jobs/${encodeURIComponent(id)}/tasks${pageQuery(opts)}`
        );
        return mapPage((await res.json()) as Record<string, unknown>, mapJobTaskRollup);
      }, options);
    },

    watch(id: string, options?: WatchJobOptions): JobWatch {
      // Dual-use handle: await it for the final Job, or `for await` its
      // events. onEvent (when given) fires from the generator in both forms.
      return makeWatch(watchEvents(id, options));
    },

    async cancel(id: string): Promise<Job> {
      const res = await request(cfg, `/api/jobs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      });
      return mapJob((await res.json()) as Record<string, unknown>);
    },

    async compare(ids: string[]): Promise<CompareResponse> {
      const idsQuery = ids.map(encodeURIComponent).join(",");
      const res = await request(cfg, `/api/jobs/compare?ids=${idsQuery}`);
      const data = (await res.json()) as {
        jobs?: Record<string, unknown>[];
        taskMatrix?: Record<string, unknown>[];
      };
      return {
        jobs: (data.jobs || []).map(mapCompareJobAggregate),
        taskMatrix: (data.taskMatrix || []).map(mapCompareTaskRow),
      };
    },

    async resume(
      id: string,
      req?: ResumeRequest,
      options?: StartJobOptions
    ): Promise<Job> {
      const res = await request(
        cfg,
        `/api/jobs/${encodeURIComponent(id)}/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(options?.idempotencyKey
              ? { "Idempotency-Key": options.idempotencyKey }
              : {}),
          },
          body: JSON.stringify(req ?? {}),
        }
      );
      return mapJob((await res.json()) as Record<string, unknown>);
    },

    async retry(
      id: string,
      req?: RetryRequest,
      options?: StartJobOptions
    ): Promise<Job> {
      // Manual retry — the selection rides the body verbatim (trial_ids XOR
      // failed_only; {} = the whole terminal job) and the server owns every
      // refusal. Same Idempotency-Key plumbing as resume, under retry's own
      // server-side fingerprint.
      const res = await request(
        cfg,
        `/api/jobs/${encodeURIComponent(id)}/retry`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(options?.idempotencyKey
              ? { "Idempotency-Key": options.idempotencyKey }
              : {}),
          },
          body: JSON.stringify(req ?? {}),
        }
      );
      return mapJob((await res.json()) as Record<string, unknown>);
    },

    async regrade(id: string, req?: RegradeRequest): Promise<Job> {
      // A regrade IS a job: the response is the ordinary job body with
      // source_jobs recording {action: "regrade"} — view it with get().
      const body: Record<string, unknown> = {};
      if (req?.statuses?.length) body.statuses = req.statuses;
      if (req?.task_name !== undefined) body.task_name = req.task_name;
      const res = await request(cfg, `/api/jobs/${encodeURIComponent(id)}/regrade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return mapJob((await res.json()) as Record<string, unknown>);
    },

    download: (async (
      id: string,
      options?: DownloadJobOptions
    ): Promise<Buffer | string | ReadableStream<Uint8Array>> => {
      const res = await request(cfg, `/api/jobs/${encodeURIComponent(id)}/download`);
      if (options?.stream) {
        if (!res.body) throw new Error("Download response has no body");
        return res.body as ReadableStream<Uint8Array>;
      }
      if (options?.to) {
        // The same hardened path as the dataset package download — this shape
        // used to skip both the truncation and the digest check while the
        // package path twelve lines away did the full dance.
        return downloadToDir(res, options.to, `job-${id}-results.tar.gz`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      assertCompleteBody(res, bytes.length);
      await verifyPackageDigest(res, bytes);
      return bytes;
    }) as JobsClient["download"],
  };
}

// =============================================================================
// TRIALS CLIENT (globally addressable)
// =============================================================================

/**
 * Create a TrialsClient. A trial id is globally addressable — no method here
 * takes a job id; the trial body carries `job_id` as the reverse pointer.
 *
 * Requires EVOLVE_API_KEY (or { apiKey } in config).
 */
export function trials(config?: HostedClientConfig): TrialsClient {
  const cfg = resolveConfig("trials", config);

  async function getTrace(
    trialId: string,
    options?: TraceOptions
  ): Promise<TraceEventPage> {
    const res = await request(
      cfg,
      `/api/trials/${encodeURIComponent(trialId)}/trace${pageQuery(options)}`
    );
    return mapPage((await res.json()) as Record<string, unknown>, mapTraceEvent);
  }

  /**
   * One raw trace artifact for a trial, by the trace route's ?stream=
   * selector: "verifier" | "trace-stdout" | "trace-stderr" answer
   * { log: string | null }; "trace-atif" answers the same envelope carrying
   * the normalized ATIF v1.7 document as JSON text (built server-side from
   * the stored parsed trace); "trajectory" — the reserved harness-native
   * session file — is refused not-found by the server until its wave lands,
   * and the refusal surfaces as the API error it is; "agent-home" (the CLI's
   * whole home folder, subagent transcripts included by construction) answers
   * { files: Record<sandbox-path, text> | null }. Null = never stored
   * (normal answer, not an error): a QUEUED/CANCELLED trial, a harness that
   * wrote nothing, or a purged trace.
   */
  async function getArtifact(
    trialId: string,
    stream: Exclude<TrialArtifactStream, "trace-parsed" | "agent-home">
  ): Promise<string | null>;
  async function getArtifact(
    trialId: string,
    stream: "agent-home"
  ): Promise<Record<string, string> | null>;
  async function getArtifact(
    trialId: string,
    stream: Exclude<TrialArtifactStream, "trace-parsed">
  ): Promise<string | Record<string, string> | null> {
    const res = await request(
      cfg,
      `/api/trials/${encodeURIComponent(trialId)}/trace?stream=${stream}`
    );
    const body = (await res.json()) as { log?: string | null; files?: Record<string, string> | null };
    return stream === "agent-home" ? (body.files ?? null) : (body.log ?? null);
  }

  return {
    async get(trialId: string): Promise<Trial> {
      const res = await request(cfg, `/api/trials/${encodeURIComponent(trialId)}`);
      return mapTrial((await res.json()) as Record<string, unknown>);
    },

    trace: getTrace,
    artifact: getArtifact,

    async *traceEvents(
      trialId: string,
      options?: TraceOptions
    ): AsyncIterableIterator<TraceEvent> {
      let cursor = options?.cursor;
      for (;;) {
        const page = await getTrace(trialId, { cursor, limit: options?.limit });
        for (const event of page.items) yield event;
        // Drained: nextCursor is null when there is no next page, which says
        // "caught up" rather than echoing the position back.
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
      }
    },

    async regrade(trialId: string): Promise<Job> {
      // A one-trial regrade is still a JOB — same body, source_jobs recording
      // the provenance.
      const res = await request(
        cfg,
        `/api/trials/${encodeURIComponent(trialId)}/regrade`,
        { method: "POST" }
      );
      return mapJob((await res.json()) as Record<string, unknown>);
    },

    async retry(trialId: string, options?: StartJobOptions): Promise<Job> {
      // A one-trial retry is still a JOB — same body, source_jobs recording
      // {action: "retry"}. Identical to jobs().retry(jobId, {trial_ids:
      // [trialId]}) down to the idempotency fingerprint.
      const res = await request(
        cfg,
        `/api/trials/${encodeURIComponent(trialId)}/retry`,
        {
          method: "POST",
          ...(options?.idempotencyKey
            ? { headers: { "Idempotency-Key": options.idempotencyKey } }
            : {}),
        }
      );
      return mapJob((await res.json()) as Record<string, unknown>);
    },

    async stop(trialIds: string[]): Promise<StopResponse> {
      const res = await request(cfg, "/api/trials/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trial_ids: trialIds }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      return {
        stopped: ((body.stopped as Record<string, unknown>[]) ?? []).map(mapTrial),
        already_terminal: (body.already_terminal as string[]) ?? [],
        not_found: (body.not_found as string[]) ?? [],
      };
    },
  };
}

// =============================================================================
// AUTH CLIENT
// =============================================================================

/**
 * Create an AuthClient for caller identity.
 *
 * Requires EVOLVE_API_KEY (or { apiKey } in config).
 */
export function auth(config?: HostedClientConfig): AuthClient {
  const cfg = resolveConfig("auth", config);

  return {
    async status(): Promise<AuthStatus> {
      const res = await request(cfg, "/api/auth/status");
      const raw = (await res.json()) as Record<string, unknown>;
      const key = (raw.key ?? {}) as Record<string, unknown>;
      return {
        user_id: raw.user_id as string,
        email: (raw.email as string | null) ?? null,
        key: {
          id: key.id as string,
          label: (key.label as string | null) ?? null,
          created_at: key.created_at as string,
          last_used_at: (key.last_used_at as string | null) ?? null,
        },
      };
    },
  };
}

function safeJsonParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw: text };
  }
}

// =============================================================================
// FRONT DOOR
// =============================================================================

/**
 * The hosted surface, configured once.
 *
 * The four factories are the right decomposition — a dataset catalog, your own
 * agent registrations, jobs, and globally addressable trials are genuinely
 * different lifetimes — but they made you say the same thing four times:
 *
 *   const d = datasets({ apiKey, baseUrl });
 *   const a = agents({ apiKey, baseUrl });     // again
 *   const j = jobs({ apiKey, baseUrl });       // and again
 *
 * and any one of those going out of sync with the others is a bug that looks
 * like a permissions problem. One door, one config:
 *
 *   const evolve = hosted({ apiKey });
 *   const catalog = await evolve.datasets.list();
 *   const job = await evolve.jobs.start({ ... });
 *
 * The clients are built LAZILY, on first access. That matters because they
 * throw when no API key is present, and `meta()` needs no key at all — so
 * `hosted().meta()` works on a signed-out page, while `hosted().jobs` still
 * fails loudly and immediately the moment you reach for something that does
 * need credentials.
 */
export interface HostedEvolve {
  /** The dataset catalog: list, get, publish, download, delete. */
  readonly datasets: DatasetsClient;
  /** Your own bring-your-own agent registrations. */
  readonly agents: AgentsClient;
  /** Jobs: start, watch, compare, resume, retry, regrade, download. */
  readonly jobs: JobsClient;
  /** Platform-stored skills, referenced as `upload:<id>` in agents[].skills. */
  readonly skills: SkillsClient;
  /** Globally addressable trials: get, trace, artifact, regrade, stop. */
  readonly trials: TrialsClient;
  /**
   * The capability document — every agent, provider, status, limit, and
   * error code the platform supports. Public: no API key required.
   *
   * Fetch it once and stop hardcoding. It is what tells you the legal agent
   * names without having to send a bad one and read the 400.
   */
  meta(): Promise<CapabilityDocument>;
}

/**
 * Open the hosted surface with one configuration.
 *
 * Named `hosted()` rather than `evolve()` deliberately: `Evolve` is already the
 * local-sandbox SDK class in this same package, and two exports one shift key
 * apart that do completely different things is a trap. `hosted()` says which
 * half of the SDK you are reaching for.
 *
 * @example
 * ```ts
 * import { hosted } from "@evolvingmachines/sdk";
 *
 * const evolve = hosted();                    // EVOLVE_API_KEY from env
 * const { agents } = await evolve.meta();     // no key needed for this one
 * const job = await evolve.jobs.start({
 *   datasets: [{ name: "deep-swe" }],
 *   agents: [{ name: "claude", model_name: "claude-fable-5" }],
 * });
 * ```
 */
export function hosted(config?: HostedClientConfig): HostedEvolve {
  let datasetsClient: DatasetsClient | undefined;
  let agentsClient: AgentsClient | undefined;
  let jobsClient: JobsClient | undefined;
  let trialsClient: TrialsClient | undefined;
  let skillsClient: SkillsClient | undefined;

  return {
    get datasets(): DatasetsClient {
      return (datasetsClient ??= datasets(config));
    },
    get agents(): AgentsClient {
      return (agentsClient ??= agents(config));
    },
    get jobs(): JobsClient {
      return (jobsClient ??= jobs(config));
    },
    get trials(): TrialsClient {
      return (trialsClient ??= trials(config));
    },
    get skills(): SkillsClient {
      return (skillsClient ??= skills(config));
    },
    meta(): Promise<CapabilityDocument> {
      return meta(config);
    },
  };
}

/**
 * Fetch the capability document.
 *
 * NO API KEY. The document is the same information the docs publish, and
 * requiring credentials would mean a signed-out page could not populate its own
 * agent picker — so this is the one hosted call that takes only a base URL.
 */
export async function meta(config?: HostedClientConfig): Promise<CapabilityDocument> {
  const baseUrl = (
    config?.baseUrl ||
    process.env.EVOLVE_DASHBOARD_URL ||
    DEFAULT_DASHBOARD_URL
  ).replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/api/meta`);
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as CapabilityDocument;
}
