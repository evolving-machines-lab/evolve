import { createWriteStream } from "fs";
import { mkdir, rename, rm } from "fs/promises";
import { basename, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { DEFAULT_DASHBOARD_URL, ENV_EVOLVE_API_KEY } from "../constants";
import { RESUMABLE_UPLOAD_THRESHOLD_BYTES } from "./resumable";
import { readRetryAfterSec } from "./retry-after";
import type {
  ActiveDataset,
  Agent,
  AgentArm,
  AnalysisList,
  AnalysisPage,
  ListAnalysesOptions,
  AgentArmInput,
  AgentInfo,
  AgentInput,
  AgentList,
  AgentPage,
  AgentResult,
  AgentSource,
  AgentUpsertInput,
  AgentsClient,
  AnalysesClient,
  AnalysisArtifactStream,
  AnalysisTranscript,
  AnalysisTranscriptOptions,
  AnalyzeConfig,
  AnalyzeConfigInput,
  AttemptPhase,
  AuthClient,
  AuthStatus,
  Organization,
  OrganizationDetail,
  OrgQuota,
  OrgRole,
  OrgUsage,
  OrgsClient,
  CompareCell,
  CompareCoverage,
  CompareJobAggregate,
  CompareResponse,
  CompareTaskRow,
  Dataset,
  DatasetFailedTask,
  DatasetImport,
  DatasetImportFailure,
  DatasetImportList,
  DatasetImportProgress,
  DatasetImportStatus,
  DatasetList,
  DatasetPage,
  DatasetPreflight,
  DatasetPatch,
  DatasetRef,
  DatasetVersion,
  DatasetVersionArchiveSource,
  DatasetVersionArchiveUrlSource,
  DatasetVersionGitSource,
  DatasetVersionHubSource,
  DatasetVersionSource,
  DatasetVersionState,
  DatasetsClient,
  DownloadDatasetOptions,
  DownloadJobOptions,
  EvalSandboxProvider,
  ExceptionInfo,
  GetDatasetOptions,
  GrepJobOptions,
  HostedClientConfig,
  ImportWarning,
  Job,
  JobBuildExclusion,
  JobCreate,
  JobDeleteResult,
  JobEvent,
  JobFailure,
  JobGrepGroup,
  JobGrepPage,
  JobList,
  JobPage,
  JobStats,
  JobStatus,
  JobTaskRollup,
  JobTaskRollupList,
  JobWatch,
  JobsClient,
  JudgeResult,
  ListAgentsOptions,
  ListDatasetsOptions,
  ListImportsOptions,
  ListJobTasksOptions,
  ListJobsOptions,
  ListSkillsOptions,
  ListTrialFilesOptions,
  ListTrialsOptions,
  Page,
  PageOptions,
  PreflightDatasetInput,
  PublishDatasetInput,
  PublishDatasetOptions,
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
  TaskBuild,
  TaskBuildFailure,
  TaskBuildState,
  TimingInfo,
  TraceEvent,
  TraceEventPage,
  TraceOptions,
  Trial,
  TrialAnalysis,
  TrialArtifactStream,
  TrialCounts,
  TrialFile,
  TrialFilePage,
  TrialFileRange,
  TrialGpuCost,
  TrialList,
  TrialPage,
  TrialRetry,
  TrialStatus,
  TrialsClient,
  UploadJobOptions,
  UpstreamStatus,
  UsageReading,
  VerifierEnvironmentMode,
  VerifierResult,
  WatchAnalysisOptions,
  WatchImportOptions,
  WatchJobOptions,
} from "./types";

// Re-exported from the hosted barrel so the package root can hand them on.
export {
  AGENT_EFFORT_SUPPORT_VALUES,
  ANALYSIS_ARTIFACT_STREAMS,
  ANALYSIS_STATUSES,
  EVAL_SANDBOX_PROVIDERS,
  HOSTED_ERROR_CODES,
  JOB_LIST_SCOPES,
  TRIAL_ARTIFACT_STREAMS,
  TRIAL_STATUSES,
  isHostedErrorCode,
  mapUsageReading,
  passAtK,
} from "./types";
export type {
  ActiveDataset,
  Agent,
  AgentArm,
  AgentArmInput,
  AgentCapability,
  AgentDatasetStats,
  AgentEffortSupport,
  AgentInfo,
  AgentModelOption,
  AgentInput,
  AgentList,
  AgentPage,
  AgentResult,
  AgentSource,
  AgentSourceInput,
  AgentUpsertInput,
  AgentsClient,
  AnalysesClient,
  AnalysisArtifactStream,
  AnalysisCheck,
  AnalysisFailure,
  AnalysisList,
  AnalysisPage,
  AnalysisStatus,
  AnalysisTranscript,
  AnalysisTranscriptOptions,
  AnalyzeConfig,
  AnalyzeConfigInput,
  ApiKey,
  AttemptPhase,
  AuthClient,
  AuthStatus,
  Organization,
  OrganizationDetail,
  OrgQuota,
  OrgRole,
  OrgUsage,
  OrgsClient,
  Awaitable,
  CapabilityDocument,
  CompareCell,
  CompareCoverage,
  CompareJobAggregate,
  CompareResponse,
  CompareTaskRow,
  Dataset,
  DatasetFailedTask,
  DatasetImport,
  DatasetImportFailure,
  DatasetImportList,
  DatasetImportPage,
  DatasetImportProgress,
  DatasetImportStatus,
  DatasetList,
  DatasetPage,
  DatasetPreflight,
  DatasetPatch,
  DatasetRef,
  DatasetSelector,
  DatasetSource,
  DatasetVersion,
  DatasetVersionArchiveSource,
  DatasetVersionArchiveUrlSource,
  DatasetVersionGitSource,
  DatasetVersionHubSource,
  DatasetVersionSource,
  DatasetVersionState,
  DatasetsClient,
  DownloadDatasetOptions,
  DownloadJobOptions,
  EvalSandboxProvider,
  ExceptionInfo,
  GetDatasetOptions,
  GrepJobOptions,
  HostedClientConfig,
  HostedErrorCode,
  ImportPhase,
  ImportPhaseProgress,
  ImportWarning,
  Job,
  JobBuildExclusion,
  JobCreate,
  JobDeleteResult,
  JobEvent,
  JobFailure,
  JobGrepGroup,
  JobGrepPage,
  JobAnalysisStats,
  JobList,
  JobPage,
  JobStats,
  JobSecretRef,
  JobSecretInline,
  JobStatus,
  JobTaskRollup,
  JobTaskRollupList,
  JobTaskRollupPage,
  JobWatch,
  JobsClient,
  JudgeResult,
  ListAgentsOptions,
  ListDatasetsOptions,
  ListImportsOptions,
  ListJobTasksOptions,
  JobListScope,
  ListAnalysesOptions,
  ListJobsOptions,
  ListSkillsOptions,
  ListTrialFilesOptions,
  ListTrialsOptions,
  ManagedProviderCapability,
  ModelInfo,
  Page,
  PageOptions,
  PassAtKGroup,
  PassAtKPoint,
  ProviderCapability,
  PreflightDatasetInput,
  PreflightDeferredCheck,
  PreflightManifestVerdict,
  PreflightTaskVerdict,
  TaskNote,
  PublishDatasetInput,
  PublishDatasetOptions,
  RegradeRequest,
  ResumeRequest,
  RetryConfig,
  RetryConfigInput,
  RetryRequest,
  Rubric,
  RubricCriterion,
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
  TaskBuild,
  TaskBuildFailure,
  TaskBuildState,
  TaskProviderVerdict,
  TimingInfo,
  TraceEvent,
  TraceEventPage,
  TraceOptions,
  Trial,
  TrialAnalysis,
  TrialArtifactStream,
  TrialCounts,
  TrialFile,
  TrialFilePage,
  TrialFileRange,
  TrialGpuCost,
  TrialList,
  TrialPage,
  TrialRetry,
  TrialStatus,
  TrialStatusTally,
  TrialUploadProvenance,
  TrialsClient,
  UploadJobOptions,
  UploadProvenance,
  UpstreamStatus,
  UsageReading,
  VerifierEnvironmentMode,
  VerifierResult,
  WatchAnalysisOptions,
  WatchImportOptions,
  WatchJobOptions,
} from "./types";
import {
  isHostedErrorCode,
  mapUsageReading,
  type Awaitable,
  type CapabilityDocument,
  type HostedErrorCode,
} from "./types";

// The client-side Harbor-tree assembly behind `evolve trial download` /
// `evolve analysis download` / `evolve job download` — pure functions,
// re-exported so callers can materialize the same trees the CLI writes.
export {
  analysisEvolveRecord,
  assembleAnalysisTree,
  assembleTrialTree,
  jobEvolveRecord,
  trialEvolveRecord,
  visibleHomeTree,
  type AnalysisTreeParts,
  type TrialTreeParts,
} from "./trial-tree";

// THE MONEY LANE RULE — how a trial's agent spend may be stated to a reader.
// Exported because every surface that shows the number without the lane beside
// it has to make the same decision, and the wrong one prints "$0.00" for a
// trial nobody measured.
export {
  jobSpend,
  trialAgentCost,
  trialJudgeCost,
  trialSpendNow,
  type SpendStatement,
} from "./money";

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

/** Map a non-ok Response to the typed EvolveApiError and throw it. */
async function throwApiError(res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  // Header fallback, read before the body so an unparseable body still yields a
  // usable requestId. The retry delay follows its own law (body first).
  const headerRequestId = res.headers?.get?.("x-request-id") ?? undefined;
  const retryAfterSec = readRetryAfterSec(text, res);

  try {
    const body = JSON.parse(text) as {
      error?:
        | string
        | {
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
    if (typeof body?.error === "string") {
      // The viewer plane's refusal grammar — {error: "<sentence>"}, no code
      // (the traces feed analyses() rides; swarm_dashboard app/api/traces/…
      // routes). The sentence is the message; the code stays the honest
      // unknown_error, never one minted client-side.
      throw new EvolveApiError(res.status, "unknown_error", body.error, {
        retryAfterSec,
        requestId: headerRequestId,
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

/** Why datasets().watchImport() could not watch the version to a settled state. */
export type ImportSettleErrorCode = "settle_timeout";

/**
 * Thrown by datasets().watchImport() when the import itself COMPLETED but the
 * WATCH cannot truthfully report the version settled: the settleTimeoutMs
 * backstop elapsed first ("settle_timeout"). This bounds the WAIT, never the
 * publish — keep following with datasets().get("name@version"). When `state`
 * is "FAILED" the version DID settle and the budget was spent retrying the
 * final import read through rate limits — read the failure with
 * datasets().getImport(importId). Rare by construction: the server settles a
 * publish at import COMPLETED (COMPLETED means the version is READY), so the
 * settle phase normally confirms in one read; the timeout exists for a
 * mid-deploy older server still finishing a version after COMPLETED.
 *
 * NOT an EvolveApiError: no request failed — the caller's wait could not be
 * honestly satisfied. Carries the last observed version state so a handler
 * can say exactly where the publish stands.
 */
export class ImportSettleError extends Error {
  readonly name = "ImportSettleError";
  /** The named cause; "settle_timeout" is the only one. */
  readonly code: ImportSettleErrorCode;
  /** The import job whose version did not settle. */
  readonly importId: string;
  /** The dataset the import published into. */
  readonly dataset: string;
  /** The version the import created. */
  readonly version: string;
  /** The last observed version state; null when the version was never observed. */
  readonly state: string | null;
  constructor(
    code: ImportSettleErrorCode,
    message: string,
    facts: {
      importId: string;
      dataset: string;
      version: string;
      state: string | null;
    }
  ) {
    super(message);
    this.code = code;
    this.importId = facts.importId;
    this.dataset = facts.dataset;
    this.version = facts.version;
    this.state = facts.state;
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

/**
 * Backstop bound on watchImport's settle phase — how long past import
 * COMPLETED the watch may wait for the version to settle before refusing
 * with ImportSettleError("settle_timeout"). Normally one confirming read:
 * the server settles the publish at import COMPLETED (the version is
 * already READY), so this bound exists for a mid-deploy older server still
 * moving a version after COMPLETED; overridable per call.
 */
const DEFAULT_IMPORT_SETTLE_TIMEOUT_MS = 30 * 60_000;

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

/**
 * A version's own `source` — one shape per publish kind (git / archive /
 * archive_url / hub_package), served on every version, including one whose
 * build FAILED (it can never activate, so it never appears as `upstream`).
 * Absent (an older server, a version that recorded nothing readable) or
 * unreadable input is null — "nothing to report", never a fabricated value
 * and never a crash.
 */
function mapVersionSource(raw: unknown): DatasetVersion["source"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const blob = raw as Record<string, unknown>;
  const text = (key: string): string | null => (typeof blob[key] === "string" ? (blob[key] as string) : null);
  // One shape per publish kind, keyed by the wire's `kind`. A server from
  // before the kinds existed served the git shape alone, without `kind` —
  // its `commit` still names it. A kind this SDK does not know, or an object
  // missing its kind's fields, is null: nothing to report, never a guess.
  const kind = text("kind") ?? (text("commit") !== null ? "git" : null);
  switch (kind) {
    case "git": {
      const ref = text("ref");
      const commit = text("commit");
      if (ref === null || commit === null) return null;
      return { kind: "git", git_url: text("git_url"), ref, commit, path: text("path") };
    }
    case "archive": {
      const digest = text("digest");
      return digest === null ? null : { kind: "archive", digest };
    }
    case "archive_url": {
      const archive_url = text("archive_url");
      const digest = text("digest");
      return archive_url === null || digest === null ? null : { kind: "archive_url", archive_url, digest };
    }
    case "hub_package": {
      const hub_package = text("hub_package");
      const digest = text("digest");
      return hub_package === null || digest === null ? null : { kind: "hub_package", hub_package, digest };
    }
    default:
      return null;
  }
}

function mapDatasetVersion(raw: Record<string, unknown>): DatasetVersion {
  return {
    version: raw.version as string,
    state: raw.state as DatasetVersionState,
    created_at: raw.created_at as string,
    task_count: (raw.task_count as number) ?? 0,
    // Tasks that FAILED their independent build (partial-publish model).
    // Absent (an older server) reads as 0 — a fully built version.
    n_failed_tasks: typeof raw.n_failed_tasks === "number" ? raw.n_failed_tasks : 0,
    manifest: mapVersionManifest(raw.manifest),
    source: mapVersionSource(raw.source),
  };
}

/**
 * The ONE failure grammar of a task's independent build — served compact on
 * the dataset detail's `failed_tasks` (no excerpt) and in full on the
 * per-task build route.
 */
function mapTaskBuildFailure(raw: Record<string, unknown>): TaskBuildFailure {
  return {
    code: (raw.code as string) ?? "",
    step: (raw.step as string) ?? "",
    message: (raw.message as string) ?? "",
    excerpt: (raw.excerpt as string | null) ?? null,
  };
}

/**
 * The dataset detail's `failed_tasks` list (partial-publish model). Absent
 * (an older server, or a list row) reads as an empty list — never a crash.
 */
function mapFailedTasks(raw: unknown): DatasetFailedTask[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      task_name: (item.task_name as string) ?? "",
      failure: mapTaskBuildFailure((item.failure ?? {}) as Record<string, unknown>),
    }));
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
    // Typed task notes (recorded degrades). Absent (older server) reads as
    // "nothing to say" — never a crash.
    notes: Array.isArray(raw.notes) ? (raw.notes as Task["notes"]) : [],
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

/** A wire number or null — anything else (an older server, garbage) is null. */
function optionalNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** ONE job mapper for every call — nothing conditional, because nothing is optional. */
/**
 * The job body's `build_exclusions` — "ran N of M" per dataset (the
 * partial-publish model's honesty label). Absent (an older server) reads as
 * an empty list: nothing excluded.
 */
function mapBuildExclusions(raw: unknown): JobBuildExclusion[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const ran = typeof item.n_tasks_ran === "number" ? item.n_tasks_ran : 0;
      return {
        dataset: mapDatasetRef((item.dataset ?? {}) as Record<string, unknown>),
        n_tasks_ran: ran,
        // Absent on a body recorded before the field existed: the server's
        // own answer for those is n_tasks_ran (read as uncapped).
        n_tasks_selected: typeof item.n_tasks_selected === "number" ? item.n_tasks_selected : ran,
        n_tasks_failed_to_build:
          typeof item.n_tasks_failed_to_build === "number" ? item.n_tasks_failed_to_build : 0,
        failed_task_names: Array.isArray(item.failed_task_names)
          ? (item.failed_task_names as unknown[]).map(String)
          : [],
        note: (item.note as string) ?? "",
      };
    });
}

/**
 * The upload provenance echo — what an uploaded archive's own record files
 * said about themselves. Defensive like every mapper here: absent (a job this
 * platform executed, or an older server) and malformed both read null — "not
 * an uploaded job", never a crash. `uploaded_at` is the one required member;
 * an echo without it reads null whole rather than as a fabricated
 * half-provenance, and the two originals pass through as the null the archive
 * stated when it stated nothing.
 */
function mapUploadProvenance(raw: unknown): Job["upload"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const blob = raw as Record<string, unknown>;
  if (typeof blob.uploaded_at !== "string") return null;
  // The job-level sum of the trials' REPORTED figures. Null when absent (a
  // pre-field ingest) or malformed — n_trials_reporting is the one member
  // the shape cannot stand without, since the figures only mean anything
  // against how many trials claimed them.
  const totals = blob.reported_totals;
  const reportedNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const reportedTotals =
    totals &&
    typeof totals === "object" &&
    !Array.isArray(totals) &&
    // A genuine integer, as the contract states — a fractional count is a
    // malformed object and voids the totals whole (the Python mapper's rule).
    Number.isInteger((totals as Record<string, unknown>).n_trials_reporting)
      ? {
          cost_usd: reportedNumber((totals as Record<string, unknown>).cost_usd),
          n_input_tokens: reportedNumber((totals as Record<string, unknown>).n_input_tokens),
          n_cache_tokens: reportedNumber((totals as Record<string, unknown>).n_cache_tokens),
          n_output_tokens: reportedNumber((totals as Record<string, unknown>).n_output_tokens),
          n_trials_reporting: (totals as Record<string, unknown>).n_trials_reporting as number,
        }
      : null;
  return {
    original_job_id: typeof blob.original_job_id === "string" ? blob.original_job_id : null,
    original_job_name:
      typeof blob.original_job_name === "string" ? blob.original_job_name : null,
    uploaded_at: blob.uploaded_at,
    reported_totals: reportedTotals,
  };
}

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
    // The resolved embedded-analysis policy, or null: a create that named
    // none, and an older server that sends nothing, both mean "no embedded
    // analysis" — exactly what null states.
    analyze:
      raw.analyze && typeof raw.analyze === "object" && !Array.isArray(raw.analyze)
        ? (raw.analyze as AnalyzeConfig)
        : null,
    // Timeout multipliers, tolerant of an OLDER server that sends none: the
    // absent-field reading is every phase at 1.0 — exactly how such a server
    // behaves.
    timeout_multiplier:
      typeof raw.timeout_multiplier === "number" ? raw.timeout_multiplier : 1.0,
    agent_timeout_multiplier: optionalNumber(raw.agent_timeout_multiplier),
    verifier_timeout_multiplier: optionalNumber(raw.verifier_timeout_multiplier),
    agent_setup_timeout_multiplier: optionalNumber(raw.agent_setup_timeout_multiplier),
    environment_build_timeout_multiplier: optionalNumber(
      raw.environment_build_timeout_multiplier
    ),
    // Null exactly on an uploaded job — the record executed on no platform
    // sandbox, so naming a provider would be an execution claim.
    sandbox_provider: (raw.sandbox_provider as EvalSandboxProvider | null) ?? null,
    counts: raw.counts as Job["counts"],
    // THE RESULTS-HONESTY LABEL (partial-publish model): always an array —
    // absent (an older server) reads as "nothing was excluded".
    build_exclusions: mapBuildExclusions(raw.build_exclusions),
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
    upload: mapUploadProvenance(raw.upload),
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

/**
 * The wire's trial analysis, defensively: absent (an older server, or a
 * never-analyzed trial) and malformed both read null — "never analyzed",
 * never a fabricated empty object. The object rides otherwise verbatim; its
 * one nested reading, `usage`, goes through the same one rule as the trial's
 * own (mapUsageReading), so absent and malformed both read null there too.
 */
function mapTrialAnalysis(raw: unknown): TrialAnalysis | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    ...(raw as TrialAnalysis),
    usage: mapUsageReading((raw as Record<string, unknown>).usage),
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
    // The judge share of the bill, itemized (absent on older servers and on
    // every non-judge trial — null either way, and null never means $0).
    judge_result: (raw.judge_result as JudgeResult | null) ?? null,
    // The trial's LATEST trace analysis, its nested usage reading through
    // the one shared rule — see mapTrialAnalysis.
    analysis: mapTrialAnalysis(raw.analysis),
    environment_setup: mapTimingInfo(raw.environment_setup),
    agent_setup: mapTimingInfo(raw.agent_setup),
    agent_execution: mapTimingInfo(raw.agent_execution),
    verifier: mapTimingInfo(raw.verifier),
    // The finer pairs beside the four phase pairs — NOT a partition of them,
    // and never summed with them. They were documented on this type before
    // they were mapped, so a caller reading the reference block found
    // undefined where the server had sent a pair; an absent one still reads
    // null, the same "nothing to report" every other timing pair answers.
    queue_wait: mapTimingInfo(raw.queue_wait),
    harness_bundle: mapTimingInfo(raw.harness_bundle),
    image_prepare: mapTimingInfo(raw.image_prepare),
    shared_verify_setup: mapTimingInfo(raw.shared_verify_setup),
    // Null is unrecorded, never "miss": only a real boolean is a reading.
    harness_bundle_cache_hit:
      typeof raw.harness_bundle_cache_hit === "boolean" ? raw.harness_bundle_cache_hit : null,
    step_results: (raw.step_results as StepResult[] | null) ?? null,
    spend_source: (raw.spend_source as SpendSource | null) ?? null,
    judge_spend_source: (raw.judge_spend_source as SpendSource | null) ?? null,
    // Mid-run lower bound, kept beside the settled pair and never folded into
    // it: it lags the gateway and is CLEARED when the trial settles.
    live_spent_usd: (raw.live_spent_usd as number | null) ?? null,
    live_spend_at: (raw.live_spend_at as string | null) ?? null,
    // The one-home usage reading, verbatim. Defensive like its neighbours: a
    // malformed or absent object reads null — "the meter never answered".
    usage: mapUsageReading(raw.usage),
    max_trial_spend_usd: (raw.max_trial_spend_usd as number | null) ?? null,
    sandbox_provider: (raw.sandbox_provider as EvalSandboxProvider | null) ?? null,
    // GPU degrade record — defensive: a malformed object reads as null,
    // never a crash or a partial row.
    sandbox_provider_degrade: mapProviderDegrade(raw.sandbox_provider_degrade),
    // The GPU compute estimate. Same defensive rule; absent (an older server)
    // reads as null too. It was declared on the Trial type before the mapper
    // carried it, so a caller reading the documented field found undefined on
    // exactly the GPU trials that have one — the Python mapper had it all
    // along (hosted.py `_map_trial`), which is why the gap was one-sided.
    gpu_cost:
      raw.gpu_cost && typeof raw.gpu_cost === "object" && !Array.isArray(raw.gpu_cost)
        ? (raw.gpu_cost as TrialGpuCost)
        : null,
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
    upload: mapTrialUploadProvenance(raw.upload),
    started_at: (raw.started_at as string | null) ?? null,
    finished_at: (raw.finished_at as string | null) ?? null,
  };
}

/**
 * The trial-level upload provenance, defensively: absent (a native trial, or
 * an older server) and malformed both read null. The two names are the
 * spec's required strings — an echo missing either reads null whole rather
 * than as a fabricated half-identity — and `reported_agent_result` is the
 * archive's OWN claim: present it maps its four figures (each null when
 * unstated), absent or malformed it is null, and it never leaks into the
 * platform-metered fields beside it.
 */
function mapTrialUploadProvenance(raw: unknown): Trial["upload"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const blob = raw as Record<string, unknown>;
  if (typeof blob.original_trial_name !== "string" || typeof blob.original_task_name !== "string") {
    return null;
  }
  const reported = blob.reported_agent_result;
  const reportedNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    original_trial_id:
      typeof blob.original_trial_id === "string" ? blob.original_trial_id : null,
    original_trial_name: blob.original_trial_name,
    original_task_name: blob.original_task_name,
    reported_agent_result:
      reported && typeof reported === "object" && !Array.isArray(reported)
        ? {
            n_input_tokens: reportedNumber((reported as Record<string, unknown>).n_input_tokens),
            n_cache_tokens: reportedNumber((reported as Record<string, unknown>).n_cache_tokens),
            n_output_tokens: reportedNumber((reported as Record<string, unknown>).n_output_tokens),
            cost_usd: reportedNumber((reported as Record<string, unknown>).cost_usd),
          }
        : null,
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
    // no_solutions_archived permanently lacks its reference-solution record,
    // and dropping the field would hide that gap.
    warnings: (raw.warnings as ImportWarning[]) ?? [],
    // Live progress (spec DatasetImportProgress): null until the worker's
    // first report — and always null from an older server that never sends
    // the field, so a watcher needs no version check.
    progress: (raw.progress as DatasetImportProgress | null) ?? null,
  };
  // Register-first: true while the corpus is still uploading through its
  // resumable session. Carried only when the server states it — an older
  // server's silence stays absence, never an invented false.
  if (typeof raw.receiving === "boolean") datasetImport.receiving = raw.receiving;
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

function mapJobGrepGroup(raw: Record<string, unknown>): JobGrepGroup {
  return {
    trial_id: raw.trial_id as string,
    task_name: (raw.task_name as string | null) ?? null,
    match_count: raw.match_count as number,
    events: ((raw.events as Record<string, unknown>[]) || []).map(mapTraceEvent),
  };
}

/** The `Range: bytes=…` header for a TrialFileRange, or null for the whole file. */
function rangeHeaderFor(range?: TrialFileRange): string | null {
  if (!range) return null;
  if (range.suffix !== undefined) return `bytes=-${range.suffix}`;
  if (range.start === undefined) return null;
  return `bytes=${range.start}-${range.end ?? ""}`;
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
 * Build the multipart/form-data body the metadata-only upload routes take
 * (an agent registered from an install script, a dataset published from a
 * git source). Anything carrying an ARCHIVE goes through requestUpload
 * instead, which streams the file from disk — bytes never ride a FormData
 * here, because a Blob part holds them whole in memory (the F1 incident:
 * ~10x a corpus's size in RSS).
 */
function uploadForm(fields: Record<string, string | undefined>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(name, value);
  }
  return form;
}

/**
 * Collect the pre-flight payload from a local corpus directory — METADATA
 * ONLY (each task's task.toml, plus dataset.toml when the corpus ships one).
 * Mirrors the import's own corpus-shape reading (server: import-corpus.ts
 * resolveCorpusShape + listTaskDirs): a task.toml at the root is a SINGLE
 * task directory — a root that also carries corpus-shaped content is
 * ambiguous and refused, the import's own sentence structure; otherwise the
 * tasks dir is tasks/ when present, else the root, and EVERY non-hidden
 * child directory must be a task directory — one without task.toml fails
 * the import (never a skip), so it fails the check here, before any upload.
 * dataset.toml is read from beside the task directories or at the corpus
 * root — the two places the import looks, in the import's own priority: the
 * tasks-dir copy wins when both exist (server dataset-manifest.ts
 * findDatasetManifestPath).
 */
async function collectPreflightPayload(directory: string): Promise<{
  tasks: { name: string; task_toml: string }[];
  dataset_toml?: string;
}> {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { basename, join, resolve } = await import("node:path");
  const root = resolve(directory);
  const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() === true;
  const isDir = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  if (!isDir(root)) {
    throw new Error(`datasets().preflight(): not a directory: ${root}`);
  }
  const taskDirs: { name: string; dir: string }[] = [];
  let tasksDir = root;
  if (isFile(join(root, "task.toml"))) {
    const children = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .filter((e) => isFile(join(root, e.name, "task.toml")))
      .map((e) => e.name);
    if (isDir(join(root, "tasks")) || children.length > 0) {
      throw new Error(
        `${root} is ambiguous: it carries task.toml at its root (a single-task shape) AND ` +
          `corpus-shaped content — the import refuses this too; point at the one task ` +
          `directory or at a corpus of task directories, not a mix`
      );
    }
    taskDirs.push({ name: basename(root), dir: root });
  } else {
    tasksDir = isDir(join(root, "tasks")) ? join(root, "tasks") : root;
    for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(tasksDir, entry.name);
      if (!isFile(join(dir, "task.toml"))) {
        throw new Error(
          `${dir} has no task.toml — every directory of a corpus must be a task directory ` +
            `(the import fails on it rather than skipping it)`
        );
      }
      taskDirs.push({ name: entry.name, dir });
    }
    if (taskDirs.length === 0) {
      throw new Error(`${tasksDir} holds no task directories — nothing to check`);
    }
    taskDirs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  // The tasks-dir copy first — the import prefers the manifest sitting
  // beside the task dirs it pins (dataset-manifest.ts findDatasetManifestPath).
  const manifestPath = (tasksDir === root ? [root] : [tasksDir, root])
    .map((dir) => join(dir, "dataset.toml"))
    .find(isFile);
  return {
    tasks: taskDirs.map(({ name, dir }) => ({
      name,
      task_toml: readFileSync(join(dir, "task.toml"), "utf8"),
    })),
    ...(manifestPath !== undefined
      ? { dataset_toml: readFileSync(manifestPath, "utf8") }
      : {}),
  };
}

/**
 * One archive upload: metadata parts first, then `file` streamed from disk
 * as the `archive` part (hosted/upload.ts), the shared error mapping applied
 * to the reply. The streaming transport exists because both FormData-with-a-
 * Blob and fetch itself hold the whole body in memory — see upload.ts.
 */
async function requestUpload(
  cfg: ResolvedConfig,
  path: string,
  opts: {
    method?: "POST" | "PUT";
    fields: Record<string, string | undefined>;
    file: { path: string; filename: string };
    /** Client-side upload progress, from the stream itself (upload.ts onBytes). */
    onBytes?: (sentBytes: number, totalBytes: number) => void;
  }
): Promise<Response> {
  const { postMultipartFile } = await import("./upload");
  const res = await postMultipartFile({
    url: `${cfg.baseUrl}${path}`,
    method: opts.method ?? "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    fields: opts.fields,
    file: opts.file,
    ...(opts.onBytes !== undefined ? { onBytes: opts.onBytes } : {}),
  });
  if (!res.ok) {
    await throwApiError(res);
  }
  return res;
}

/**
 * Tar + gzip `directory` into a temp file and upload it via requestUpload —
 * the one flow every publish-a-directory surface (datasets, agents, skills,
 * jobs) shares. The archive only ever exists on disk; the temp dir is
 * removed however the upload ends.
 */
async function uploadDirectory(
  cfg: ResolvedConfig,
  path: string,
  opts: {
    method?: "POST" | "PUT";
    fields: Record<string, string | undefined>;
    directory: string;
    filename: string;
    /** Client-side upload progress, from the stream itself (upload.ts onBytes). */
    onBytes?: (sentBytes: number, totalBytes: number) => void;
    /**
     * Register-first (resumable door only): the pre-created import id from
     * the session open, forwarded to resumable.ts — see
     * PublishDatasetOptions.onRegistered.
     */
    onRegistered?: (importId: string) => void;
    /**
     * When set, an archive OVER this many bytes rides the resumable chunked
     * door instead of one single-request POST (hosted/resumable.ts — a
     * dropped link then resumes from the last acknowledged chunk instead of
     * restarting a multi-GB transfer from zero). Only the dataset publish
     * surface has that door; the callers without one leave this unset. The
     * switch is automatic, exactly as Harbor's uploader switches
     * (REFERENCES/Harbor src/harbor/upload/storage.py:55-67) — never a
     * caller-facing flag.
     */
    resumableThreshold?: number;
  }
): Promise<Response> {
  const { tarGzipDirectoryToFile } = await import("./tar");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmp = await mkdtemp(join(tmpdir(), "evolve-upload-"));
  try {
    const archive = join(tmp, opts.filename);
    await tarGzipDirectoryToFile(opts.directory, archive);
    if (opts.resumableThreshold !== undefined) {
      const { size } = await stat(archive);
      if (size > opts.resumableThreshold) {
        const { uploadArchiveResumable } = await import("./resumable");
        const res = await uploadArchiveResumable({
          baseUrl: cfg.baseUrl,
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
          file: { path: archive },
          fields: opts.fields,
          ...(opts.onBytes !== undefined ? { onBytes: opts.onBytes } : {}),
          ...(opts.onRegistered !== undefined ? { onRegistered: opts.onRegistered } : {}),
        });
        if (!res.ok) await throwApiError(res);
        return res;
      }
    }
    return await requestUpload(cfg, path, {
      method: opts.method,
      fields: opts.fields,
      file: { path: archive, filename: opts.filename },
      ...(opts.onBytes !== undefined ? { onBytes: opts.onBytes } : {}),
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
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

// The streaming upload transport's typed timeout, re-exported so callers can
// tell a dead-socket upload from a refused one without importing internals.
export { EvolveUploadTimeoutError, UPLOAD_TIMEOUT_MS } from "./upload";

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
      // The provenance half (git-pin-provenance): null on an older server.
      git_url: (value.git_url as string | null) ?? null,
      ref: value.ref as string,
      current_commit: value.current_commit as string,
      path: (value.path as string | null) ?? null,
      latest_commit: (value.latest_commit as string | null) ?? null,
      acked_commit: (value.acked_commit as string | null) ?? null,
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
      // The newest version row, active or not — served on both routes beside
      // it. Absent on an older server, which reads as null.
      latest_version: raw.latest_version
        ? mapDatasetVersion(raw.latest_version as Record<string, unknown>)
        : null,
      versions: ((raw.versions as Record<string, unknown>[]) || []).map(mapDatasetVersion),
      selected_version: raw.selected_version
        ? mapDatasetVersion(raw.selected_version as Record<string, unknown>)
        : null,
      tasks: mapPage(raw.tasks, mapTask),
      // Always present on the detail body (empty on a fully built version);
      // absent only on an older server, which reads the same way.
      failed_tasks: mapFailedTasks(raw.failed_tasks),
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

  /**
   * Phase two of watchImport — the confirming read behind the import surface.
   *
   * Under the build-then-READY model the server completes an import only
   * when the version is READY (the build settled with at least one task
   * ready — the partial-publish model; each provider builds its boot
   * artifact lazily at the first trial —
   * and, on an owner-stamped dataset, already ACTIVE), so COMPLETED and
   * "settled" are the same fact and this phase normally confirms it in one
   * dataset-detail read. It still POLLS rather than assumes, for exactly one
   * skew: a mid-deploy OLDER server can answer COMPLETED while its version
   * is still short of READY — the poll then follows the version's own state
   * until it lands:
   *
   *   - state READY or ARCHIVED       settled success (ARCHIVED = superseded
   *                                   by a newer publish while we watched —
   *                                   it completed all the same)
   *   - state FAILED                  the version's terminal failure lands
   *                                   its structured cause on the same row
   *                                   the import surface reads — re-read the
   *                                   import and return it FAILED, the one
   *                                   import shape
   *
   * Bounded on purpose (fail closed, never an infinite poll): settleTimeoutMs
   * backstops every stall (a server that answers nothing but 429/503 stalls
   * the polling itself): ImportSettleError("settle_timeout"), carrying the
   * last observed state.
   */
  async function settleImport(
    imported: DatasetImport,
    options?: WatchImportOptions
  ): Promise<DatasetImport> {
    const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_IMPORT_POLL_INTERVAL_MS;
    const settleTimeoutMs = options?.settleTimeoutMs ?? DEFAULT_IMPORT_SETTLE_TIMEOUT_MS;
    const deadline = Date.now() + settleTimeoutMs;
    const ref = `${imported.name}@${imported.version}`;
    let lastSeen: string | null = null;
    let lastVersion: DatasetVersion | null = null;

    // ONE home for the settle_timeout refusal, built from whatever was last
    // observed. Two true stories share the code: usually the version never
    // settled inside the budget; after a FAILED observation the version DID
    // settle — it is the final import read the server kept refusing.
    const settleTimeoutError = () => {
      if (lastVersion?.state === "FAILED") {
        return new ImportSettleError(
          "settle_timeout",
          `Import ${imported.id}'s dataset "${imported.name}" version ` +
            `"${imported.version}" settled FAILED, but the final import ` +
            `read kept answering rate-limited/unavailable past the ` +
            `${settleTimeoutMs}ms settle budget. Read the failure with ` +
            `datasets().getImport("${imported.id}").`,
          {
            importId: imported.id,
            dataset: imported.name,
            version: imported.version,
            state: lastVersion.state,
          }
        );
      }
      return new ImportSettleError(
        "settle_timeout",
        `Import ${imported.id} completed, but dataset "${imported.name}" version ` +
          `"${imported.version}" did not settle within ${settleTimeoutMs}ms: last ` +
          `observed state ${lastVersion?.state ?? "never observed"}. Keep following ` +
          `with datasets().get("${ref}").`,
        {
          importId: imported.id,
          dataset: imported.name,
          version: imported.version,
          state: lastVersion?.state ?? null,
        }
      );
    };

    // ONE home for the settle phase's delay-not-outcome law: every read — the
    // detail poll and the final import re-read alike — survives a 429/503 by
    // sleeping the server's delay, and the SAME settle deadline bounds the
    // retrying (a server answering nothing but rate limits must not turn this
    // bounded wait into an infinite loop).
    const readThroughRateLimits = async <T>(read: () => Promise<T>): Promise<T> => {
      for (;;) {
        throwIfAborted(options?.signal);
        try {
          return await read();
        } catch (error) {
          if (
            !(error instanceof EvolveApiError) ||
            (error.status !== 429 && error.status !== 503)
          ) {
            throw error;
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw settleTimeoutError();
          await sleep(
            Math.min(
              Math.max((error.retryAfterSec ?? 0) * 1000, pollIntervalMs),
              remainingMs
            ),
            options?.signal
          );
        }
      }
    };

    for (;;) {
      throwIfAborted(options?.signal);
      // limit=1: the watch reads the version's state, never the task list —
      // keep the poll as small as the route allows.
      const detail: Dataset = await readThroughRateLimits(() => getDataset(ref, { limit: 1 }));
      const version = detail.selected_version;
      if (version) {
        lastVersion = version;
        if (version.state !== lastSeen) {
          lastSeen = version.state;
          options?.onVersion?.(version, detail);
        }
        if (version.state === "FAILED") {
          // The failed version's row is what the import surface reads, so the
          // import answers FAILED with the structured cause on `failure` —
          // return that, the one import shape. The read lives under the same
          // delay-not-outcome law: a transient 429 here must not turn a
          // settled failure into a thrown rate-limit error.
          return readThroughRateLimits(() => getImport(imported.id));
        }
        if (version.state === "READY" || version.state === "ARCHIVED") return imported;
      }
      if (Date.now() >= deadline) throw settleTimeoutError();
      await sleep(pollIntervalMs, options?.signal);
    }
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
      // The newest version row, active or not — the field that lets a caller
      // watch a FIRST import from the list alone. Absent on an older server,
      // which reads as null.
      latest_version: raw.latest_version
        ? mapDatasetVersion(raw.latest_version as Record<string, unknown>)
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

    async getTaskBuild(ref: string, taskName: string): Promise<TaskBuild> {
      // The outcome is a fact about ONE immutable version, so the ref must
      // pin it — there is no active-version reading to guess client-side.
      const parsed = parseDatasetRef(ref);
      if (parsed.version === undefined) {
        throw new Error(
          `datasets().getTaskBuild() needs "name@version" — a task's build outcome ` +
            `belongs to one immutable version (got "${ref}")`
        );
      }
      const res = await request(
        cfg,
        `/api/datasets/${encodeURIComponent(parsed.name)}/versions/` +
          `${encodeURIComponent(parsed.version)}/tasks/${encodeURIComponent(taskName)}/build`
      );
      const raw = (await res.json()) as Record<string, unknown>;
      return {
        task_name: (raw.task_name as string) ?? taskName,
        state: raw.state as TaskBuild["state"],
        failure:
          raw.failure && typeof raw.failure === "object"
            ? mapTaskBuildFailure(raw.failure as Record<string, unknown>)
            : null,
        build_log_ref: (raw.build_log_ref as string | null) ?? null,
      };
    },

    async preflight(input: PreflightDatasetInput): Promise<DatasetPreflight> {
      // Directory sources only: a git source has nothing local to read — the
      // server validates it at publish, after the clone it alone can do.
      const directory = input?.source?.directory;
      if (typeof directory !== "string" || directory === "") {
        throw new Error(
          "datasets().preflight() requires { source: { directory } } — a local corpus " +
            "directory whose task.toml files are checked server-side before any upload"
        );
      }
      const payload = await collectPreflightPayload(directory);
      const res = await request(cfg, "/api/datasets/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // The wire shape IS the SDK shape (snake_case verdicts, verbatim).
      return (await res.json()) as DatasetPreflight;
    },

    async publish(
      input: PublishDatasetInput,
      options?: PublishDatasetOptions
    ): Promise<DatasetImport> {
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
        const res = await uploadDirectory(cfg, "/api/datasets/publish", {
          fields: { name: input.name, version: input.version },
          directory: src.directory,
          filename: "corpus.tar.gz",
          // Upload progress renders CLIENT-SIDE from the stream: the send
          // loop's own flushed-byte count, no server call (upload.ts).
          ...(options?.onUploadProgress !== undefined
            ? { onBytes: options.onUploadProgress }
            : {}),
          // Register-first: the resumable door's open answers the import id
          // before any byte moves; the callback hands it to the caller so a
          // watcher can attach mid-upload.
          ...(options?.onRegistered !== undefined
            ? { onRegistered: options.onRegistered }
            : {}),
          // Big corpora ride the resumable chunked door automatically — a
          // dropped link resumes from the last acknowledged chunk. Same 202
          // either way; the switch is invisible to callers.
          resumableThreshold: RESUMABLE_UPLOAD_THRESHOLD_BYTES,
        });
        return mapDatasetImport((await res.json()) as Record<string, unknown>);
      }
      // `"git_url" in src` rather than testing both fields: the union makes
      // git_ref REQUIRED on the git branch, so a source carrying git_url
      // without git_ref is already a compile error for a typed caller — and
      // for an untyped one, the server refuses it with a named param, which is
      // a better error than this function's generic sentence.
      // The two FETCHED sources move zero client bytes: the server pulls the
      // corpus itself. archive_url needs explicit name+version (the server
      // only fetches after the 202 has promised a name); hub_package may omit
      // both — the server defaults them from the resolved package.
      if (src && "archive_url" in src && src.archive_url) {
        if (input.name === undefined || input.version === undefined) {
          throw new Error(
            "datasets().publish() requires name and version for an archive_url source — the " +
              "server fetches the tarball only after the publish is accepted, so a manifest " +
              "cannot supply them"
          );
        }
        const res = await request(cfg, "/api/datasets/publish", {
          method: "POST",
          body: uploadForm({
            name: input.name,
            version: input.version,
            archive_url: src.archive_url,
          }),
        });
        return mapDatasetImport((await res.json()) as Record<string, unknown>);
      }
      if (src && "hub_package" in src && src.hub_package) {
        const res = await request(cfg, "/api/datasets/publish", {
          method: "POST",
          body: uploadForm({
            // Optional by design: absent parts default server-side to the
            // package's short name and resolved revision.
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.version !== undefined ? { version: input.version } : {}),
            hub_package: src.hub_package,
          }),
        });
        return mapDatasetImport((await res.json()) as Record<string, unknown>);
      }
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
        "datasets().publish() requires a source: a git source ({ source: { git_url, git_ref } }), " +
          "a local corpus directory ({ source: { directory } }), a public tarball url " +
          "({ source: { archive_url } }), or a Harbor hub package ({ source: { hub_package } }); " +
          "plus name and version (optional for a directory whose corpus carries a dataset.toml " +
          "manifest, and for a hub package, which supplies its own defaults)"
      );
    },

    getImport,

    async watchImport(id: string, options?: WatchImportOptions): Promise<DatasetImport> {
      const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_IMPORT_POLL_INTERVAL_MS;
      let lastStatus: string | null = null;
      // Change detection over the SERVER's own writes: the worker persists
      // progress at phase boundaries and coarse intervals, so comparing the
      // serialized blob fires onProgress exactly when the row moved.
      let lastProgress: string | null = null;
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
        // The receiving flip (register-first: the corpus finished uploading)
        // keeps status QUEUED, so the change key carries both — a watcher
        // sees "QUEUED (receiving)" become "QUEUED" instead of sixteen
        // silent minutes.
        const statusKey = `${current.status}${current.receiving === true ? ":receiving" : ""}`;
        if (statusKey !== lastStatus) {
          lastStatus = statusKey;
          options?.onStatus?.(current);
        }
        if (current.progress !== null) {
          const serialized = JSON.stringify(current.progress);
          if (serialized !== lastProgress) {
            lastProgress = serialized;
            options?.onProgress?.(current.progress, current);
          }
        }
        if (current.status === "FAILED") return current;
        // COMPLETED means the version is READY (built, and on an owner
        // dataset active) — the settle phase is one confirming read, plus
        // the poll that covers a mid-deploy older server (see settleImport).
        if (current.status === "COMPLETED") return settleImport(current, options);
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
      // Promotes a BUILT version (READY) to
      // the dataset's default; a version still building refuses with 409
      // version_not_ready (EvolveApiError) — the publish lands READY and
      // active on its own, so this verb is for re-pointing the default.
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
      const parts = agentUploadParts("agents().create()", input);
      const res = parts.directory
        ? await uploadDirectory(cfg, "/api/agents", {
            fields: parts.fields,
            directory: parts.directory,
            filename: "source.tar.gz",
          })
        : await request(cfg, "/api/agents", { method: "POST", body: uploadForm(parts.fields) });
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
      // delete()+create() makes it. Same body grammar as create(), name part
      // included — the URL names the agent too, and the server treats the
      // path as authoritative.
      const parts = agentUploadParts("agents().upsert()", { ...input, name });
      const res = parts.directory
        ? await uploadDirectory(cfg, `/api/agents/${encodeURIComponent(name)}`, {
            method: "PUT",
            fields: parts.fields,
            directory: parts.directory,
            filename: "source.tar.gz",
          })
        : await request(cfg, `/api/agents/${encodeURIComponent(name)}`, {
            method: "PUT",
            body: uploadForm(parts.fields),
          });
      return mapAgent((await res.json()) as Record<string, unknown>);
    },
  };
}

/**
 * The metadata parts both create() and upsert() send, plus the directory to
 * stream when the agent ships as an uploaded tarball. Shared because the two
 * differ only in method and URL: one grammar means an agent registered by
 * either route is byte-identical on the wire. The caller picks the transport
 * — plain multipart for an install script, the streaming archive upload for
 * a directory — because only the caller knows its URL and method.
 */
function agentUploadParts(
  caller: string,
  input: AgentInput
): { fields: Record<string, string | undefined>; directory?: string } {
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
  return hasDirectory ? { fields, directory: input.directory as string } : { fields };
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
      const { basename, resolve } = await import("node:path");
      // The archive packs the folder's CONTENT (SKILL.md at the archive
      // root); the folder's own name travels beside it, so a single-skill
      // upload is recorded — and later mounted — under its folder name.
      const folderName = basename(resolve(directory));
      const res = await uploadDirectory(cfg, "/api/skills", {
        fields: { name: folderName || undefined },
        directory,
        filename: "skill.tar.gz",
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
      `/api/jobs${pageQuery(options, { search: options?.search, scope: options?.scope })}`
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
      // job across cursor pages. The search filter and the scope ride along
      // on every page fetch — makePaginated forwards only limit/cursor.
      return makePaginated(
        (opts) => listPage({ ...opts, search: options?.search, scope: options?.scope }),
        options
      );
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

    async analyze(id: string, req?: AnalyzeConfigInput): Promise<Job> {
      // The config rides the body verbatim ({} = all defaults) and the server
      // owns every refusal — the rubric grammar, the model roster, the
      // one-wave-at-a-time law. THE RESPONSE IS THE JOB, analyses enqueued.
      const res = await request(cfg, `/api/jobs/${encodeURIComponent(id)}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req ?? {}),
      });
      return mapJob((await res.json()) as Record<string, unknown>);
    },

    async watchAnalysis(id: string, options?: WatchAnalysisOptions): Promise<Job> {
      // Analyses have no event stream — the contract says "poll the job's
      // trials to watch them settle" — so this is the poll, in one home,
      // watchImport's posture: a 429/503 mid-watch is a delay, not an
      // outcome. Settled means stats.analysis reports nothing pending; a
      // still-null tally is the enqueue race after an accepted POST, watched
      // through rather than misread as "never analyzed".
      const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_IMPORT_POLL_INTERVAL_MS;
      let lastTally: string | null = null;
      for (;;) {
        throwIfAborted(options?.signal);
        let current: Job;
        try {
          current = await getJob(id);
        } catch (error) {
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
        const analysis = current.stats.analysis ?? null;
        if (analysis) {
          const tally = JSON.stringify([
            analysis.n_completed,
            analysis.n_failed,
            analysis.n_pending,
          ]);
          if (tally !== lastTally) {
            lastTally = tally;
            options?.onStats?.(current);
          }
          if (analysis.n_pending === 0) return current;
        }
        await sleep(pollIntervalMs, options?.signal);
      }
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

    async upload(dirOrArchive: string, options?: UploadJobOptions): Promise<Job> {
      // download()'s inverse: a Harbor job directory in, the ordinary Job
      // shape out. A path to a regular file is a ready-packed .tar.gz (our
      // own download() output, or Harbor's) and rides the wire byte-for-byte;
      // anything else is treated as the job directory Harbor's CLI takes.
      if (typeof dirOrArchive !== "string" || !dirOrArchive.trim()) {
        throw new Error("jobs().upload() requires a job directory (or .tar.gz archive) path");
      }
      const { stat } = await import("node:fs/promises");
      const target = await stat(dirOrArchive).catch(() => null);
      if (target?.isFile()) {
        // A ready-packed archive streams from where it lies — never read
        // into memory, never re-packed, byte-for-byte on the wire.
        const res = await requestUpload(cfg, "/api/jobs/upload", {
          fields: { dataset: options?.dataset },
          file: { path: dirOrArchive, filename: "job.tar.gz" },
        });
        return mapJob((await res.json()) as Record<string, unknown>);
      }
      // Harbor's own gate (their cli/upload.py checks result.json, then
      // config.json), applied client-side with their sentences — the cheap
      // refusal that saves tarring and shipping a tree the server would
      // refuse the same way (`not_a_job_dir`). A nonexistent path lands
      // here too and reads as the first refusal, exactly as their CLI does.
      const { existsSync } = await import("node:fs");
      const { join, resolve } = await import("node:path");
      const root = resolve(dirOrArchive);
      for (const required of ["result.json", "config.json"]) {
        if (!existsSync(join(root, required))) {
          throw new Error(`${root} does not contain ${required}`);
        }
      }
      const res = await uploadDirectory(cfg, "/api/jobs/upload", {
        fields: { dataset: options?.dataset },
        directory: root,
        filename: "job.tar.gz",
      });
      return mapJob((await res.json()) as Record<string, unknown>);
    },

    async delete(id: string): Promise<JobDeleteResult> {
      // The verb is the wire, verbatim — the server owns every rule (creator
      // only, terminal only, no live analysis wave or derived regrade) and
      // every refusal arrives typed. The 200 is the receipt, its three
      // fields required by the contract, read in the same shape mapJob
      // reads required counts.
      const res = await request(cfg, `/api/jobs/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as Record<string, unknown>;
      return {
        job_id: (data.job_id as string) ?? id,
        trials_deleted: (data.trials_deleted as number) ?? 0,
        analyses_deleted: (data.analyses_deleted as number) ?? 0,
      };
    },

    async grep(id: string, q: string, options?: GrepJobOptions): Promise<JobGrepPage> {
      const res = await request(
        cfg,
        `/api/jobs/${encodeURIComponent(id)}/grep${pageQuery(options, { q, type: options?.type })}`
      );
      return mapPage((await res.json()) as Record<string, unknown>, mapJobGrepGroup);
    },
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
      `/api/trials/${encodeURIComponent(trialId)}/trace${pageQuery(options, {
        // The parsed-event filters (type / grep / tail), spelled exactly as
        // the contract spells them; they compose with cursor paging.
        type: options?.type,
        grep: options?.grep,
        tail: options?.tail !== undefined ? String(options.tail) : undefined,
      })}`
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
        // The filters ride every page — a filtered drain is still one drain.
        const page = await getTrace(trialId, { ...options, cursor });
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
        // Stopped trace analyses ride the same answer under their own list
        // (they are not Trials). Each row rides verbatim beside its one
        // normalized key — the Trial.analysis rule, one home
        // (mapTrialAnalysis); a non-object row cannot become an analysis and
        // reads nothing, and an older server that sends no list reads the
        // empty one — "no analyses were stopped", exactly how such a server
        // behaves.
        stopped_analyses: ((body.stopped_analyses as unknown[]) ?? [])
          .map(mapTrialAnalysis)
          .filter((row): row is TrialAnalysis => row !== null),
        already_terminal: (body.already_terminal as string[]) ?? [],
        not_found: (body.not_found as string[]) ?? [],
      };
    },

    async files(trialId: string, options?: ListTrialFilesOptions): Promise<TrialFilePage> {
      const res = await request(
        cfg,
        `/api/trials/${encodeURIComponent(trialId)}/files${pageQuery(options)}`
      );
      return mapPage((await res.json()) as Record<string, unknown>, (raw) => ({
        path: raw.path as string,
        size_bytes: raw.size_bytes as number,
      }));
    },

    async file(trialId: string, path: string, range?: TrialFileRange): Promise<Buffer> {
      // Each path segment encodes separately — the slashes ARE the route.
      const encodedPath = path
        .split("/")
        .filter(Boolean)
        .map(encodeURIComponent)
        .join("/");
      const rangeHeader = rangeHeaderFor(range);
      const res = await request(
        cfg,
        `/api/trials/${encodeURIComponent(trialId)}/files/${encodedPath}`,
        rangeHeader ? { headers: { Range: rangeHeader } } : undefined
      );
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

// =============================================================================
// ANALYSES CLIENT (globally addressable analyzer runs)
// =============================================================================

/**
 * The one event-type law of the traces feed, mirrored: the viewer names an
 * event by its ACP `update.sessionUpdate` string and calls everything else
 * "unknown" (swarm_dashboard lib/trace-events.ts traceEventType). The feed
 * serves the stored payloads bare — unlike /api/trials/{id}/trace, which
 * stamps `type` server-side through that same function — so this client
 * applies the identical reading to keep one vocabulary across both doors.
 */
function feedEventType(data: unknown): string {
  const update = (data as { update?: { sessionUpdate?: unknown } } | null)?.update;
  return typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "unknown";
}

/**
 * Create an AnalysesClient. An analysis id is globally addressable, exactly
 * like a trial's; the transcript carries `analyzed_trial_id` and `job_id` as
 * the reverse pointers.
 *
 * DELIBERATELY OFF-CONTRACT — the reads ride the dashboard's traces feed
 * (`/api/traces/trials/{id}/events`, `…/artifacts`), which spec/openapi.yaml
 * does not carry: `traces` is outside the platform drift gate's
 * CONTRACT_PREFIXES (swarm_dashboard __tests__/api/spec-drift-gate.test.ts),
 * the way that gate's RUNTIME_INTERNAL_ROUTES keeps the UI's own session
 * transcript door (`api/sessions/[id]/events`) off the spec. The feed
 * authenticates Bearer API keys through the same dual-auth door as every
 * contract route (swarm_dashboard lib/auth-dual.ts authenticateRequest; both
 * feed routes call it first), so no server change is involved — see
 * AnalysesClient in ./types for the full note and the recorded tension.
 *
 * Requires EVOLVE_API_KEY (or { apiKey } in config).
 */
export function analyses(config?: HostedClientConfig): AnalysesClient {
  const cfg = resolveConfig("analyses", config);

  // Ids this client has already proven to be analysis runs. A run id's
  // species never changes, so one proof per id is enough — the whole-tree
  // download reads three streams and must not re-spend the gate on each.
  const provenAnalyses = new Set<string>();

  /**
   * THE SPECIES GATE for the stored streams. The feed's artifacts door
   * resolves trial and regrade ids BEFORE analyses (swarm_dashboard
   * app/api/traces/trials/[trialId]/artifacts/route.ts — the analysis lookup
   * is its not-found fallback), and the stored selectors (?what=trace-stdout
   * / trace-stderr / agent-home) answer for EITHER species — so a
   * wrong-species id typed at a stream selector would be answered with THAT
   * run's bytes, silently. The ?what=analysis door is the one selector the
   * server refuses typed for a trial or a regrade ("analysis.json belongs to
   * an analysis run", 400; an analysis id can only answer 200 there), so
   * every stream read resolves that door FIRST — the wrong species dies
   * before any artifact byte is fetched, and the CLI inherits the refusal.
   */
  async function assertAnalysisRun(analysisId: string): Promise<void> {
    if (provenAnalyses.has(analysisId)) return;
    let res: Response;
    try {
      res = await request(
        cfg,
        `/api/traces/trials/${encodeURIComponent(analysisId)}/artifacts?what=analysis`
      );
    } catch (error) {
      if (error instanceof EvolveApiError && error.status === 400) {
        // The door's 400 IS the species refusal — rethrown in this client's
        // own grammar, the sentence transcript() speaks for the same mistake.
        throw new Error(
          `"${analysisId}" is not an analysis run (the artifacts door refuses it typed) — ` +
            `for a trial's artifacts use trials()`
        );
      }
      throw error;
    }
    // Drain the small verdict body so the connection is reusable; the gate
    // needs only the door's yes.
    await res.text().catch(() => {});
    provenAnalyses.add(analysisId);
  }

  async function getArtifact(
    analysisId: string,
    stream: Exclude<AnalysisArtifactStream, "agent-home">
  ): Promise<string | null>;
  async function getArtifact(
    analysisId: string,
    stream: "agent-home"
  ): Promise<Record<string, string> | null>;
  async function getArtifact(
    analysisId: string,
    stream: AnalysisArtifactStream
  ): Promise<string | Record<string, string> | null> {
    await assertAnalysisRun(analysisId);
    const res = await request(
      cfg,
      `/api/traces/trials/${encodeURIComponent(analysisId)}/artifacts?what=${stream}`
    );
    const body = (await res.json()) as { log?: string | null; files?: Record<string, string> | null };
    return stream === "agent-home" ? (body.files ?? null) : (body.log ?? null);
  }

  async function listPage(options?: ListAnalysesOptions): Promise<AnalysisPage> {
    const res = await request(
      cfg,
      `/api/analyses${pageQuery(options, {
        scope: options?.scope,
        job: options?.job,
        status: options?.status && options.status.length > 0 ? options.status.join(",") : undefined,
      })}`
    );
    // The page's rows are TrialAnalysis objects; a malformed row cannot be
    // served as "never analyzed" the way the OPTIONAL Trial.analysis slot
    // is — here the row IS the answer, so it fails closed like get().
    return mapPage((await res.json()) as Record<string, unknown>, (raw) => {
      const verdict = mapTrialAnalysis(raw);
      if (verdict === null) {
        throw new Error("The analyses list served an unreadable analysis object");
      }
      return verdict;
    });
  }

  return {
    list(options?: ListAnalysesOptions): AnalysisList {
      // Await for one page; for-await to walk every analysis across cursor
      // pages. The scope and filters ride along on every page fetch.
      return makePaginated(
        (opts) =>
          listPage({ ...opts, scope: options?.scope, job: options?.job, status: options?.status }),
        options
      );
    },

    async get(analysisId: string): Promise<TrialAnalysis> {
      // The feed's own verdict door: ?what=analysis answers { analysis } —
      // the wire's TrialAnalysis for EVERY analysis, not only completed ones
      // (the same document its &format=log form downloads as Harbor's
      // analysis.json). A trial id refuses typed server-side ("analysis.json
      // belongs to an analysis run"), so the wrong species never answers.
      const res = await request(
        cfg,
        `/api/traces/trials/${encodeURIComponent(analysisId)}/artifacts?what=analysis`
      );
      const body = (await res.json()) as Record<string, unknown>;
      const verdict = mapTrialAnalysis(body.analysis);
      if (verdict === null) {
        // mapTrialAnalysis reads malformed as "never analyzed" for the
        // OPTIONAL Trial.analysis slot; here the verdict IS the answer, so
        // absence fails closed instead of fabricating an empty object.
        throw new Error(`The analysis feed served no readable verdict object for "${analysisId}"`);
      }
      return verdict;
    },

    async transcript(
      analysisId: string,
      options?: AnalysisTranscriptOptions
    ): Promise<AnalysisTranscript> {
      const since = options?.since;
      if (since !== undefined && (!Number.isInteger(since) || since < 0)) {
        // Refused at the keyboard: the feed would parseInt a fraction into a
        // different position and the synthesized seqs below would lie.
        throw new Error(`transcript() since must be a non-negative integer, got ${since}`);
      }
      const res = await request(
        cfg,
        `/api/traces/trials/${encodeURIComponent(analysisId)}/events` +
          (since !== undefined ? `?since=${since}` : "")
      );
      const raw = (await res.json()) as Record<string, unknown>;
      const session = (raw.session ?? {}) as Record<string, unknown>;
      // THE SPECIES GATE. The feed resolves trial ids first (its resolution
      // order), and a trial envelope carries no `kind` while a regrade says
      // 'regrade' — either way these are not the analyzer's events, and
      // handing them back would be the wrong run's transcript.
      if (session.kind !== "analysis") {
        const species = typeof session.kind === "string" ? session.kind : "trial";
        throw new Error(
          `"${analysisId}" is not an analysis run (the feed resolves it as a ${species}) — ` +
            `for a trial's trace use trials()`
        );
      }
      const base = since ?? 0;
      const events = (Array.isArray(raw.events) ? raw.events : []) as unknown[];
      return {
        id: typeof session.id === "string" ? session.id : analysisId,
        analyzed_trial_id:
          typeof session.analyzedTrialId === "string" ? session.analyzedTrialId : null,
        job_id: typeof session.jobId === "string" ? session.jobId : null,
        task_name: typeof session.tag === "string" ? session.tag : null,
        model_name: typeof session.model === "string" ? session.model : null,
        sandbox_provider: typeof session.provider === "string" ? session.provider : null,
        sandbox_id: typeof session.sandboxId === "string" ? session.sandboxId : null,
        is_ended: session.isEnded === true,
        total: typeof raw.total === "number" ? raw.total : base + events.length,
        // seq = since + index is exact, not an estimate: an analysis's rows
        // are seq-allocated densely from 0 in arrival order (the feed's own
        // stated law), and `since` means "everything from seq N on".
        events: events.map((data, i) => ({
          seq: base + i,
          type: feedEventType(data),
          data: (data && typeof data === "object" && !Array.isArray(data)
            ? data
            : {}) as Record<string, unknown>,
        })),
      };
    },

    artifact: getArtifact,
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

// =============================================================================
// ORGS CLIENT — the read pair (Harbor's `auth org list` shape + the hosted
// `auth org show` extension: quota and usage are hosted facts)
// =============================================================================

function mapOrganization(raw: Record<string, unknown>): Organization {
  return {
    org_id: raw.org_id as string,
    slug: raw.slug as string,
    display_name: raw.display_name as string,
    personal: raw.personal === true,
    ...(raw.role === "owner" || raw.role === "member" ? { role: raw.role } : {}),
    created_at: raw.created_at as string,
  };
}

function mapOrganizationDetail(raw: Record<string, unknown>): OrganizationDetail {
  const quota = (raw.quota ?? {}) as Record<string, unknown>;
  const usage = (raw.usage ?? {}) as Record<string, unknown>;
  const count = (value: unknown): number => (typeof value === "number" ? value : 0);
  return {
    ...mapOrganization(raw),
    member_count: count(raw.member_count),
    quota: {
      max_concurrent_trials: count(quota.max_concurrent_trials),
      max_queued_trials: count(quota.max_queued_trials),
      max_concurrent_imports: count(quota.max_concurrent_imports),
      max_concurrent_analyses: count(quota.max_concurrent_analyses),
      max_concurrent_sessions: count(quota.max_concurrent_sessions),
      monthly_budget_usd:
        typeof quota.monthly_budget_usd === "number" ? quota.monthly_budget_usd : null,
    },
    usage: {
      in_flight_trials: count(usage.in_flight_trials),
      queued_trials: count(usage.queued_trials),
      in_flight_imports: count(usage.in_flight_imports),
      in_flight_analyses: count(usage.in_flight_analyses),
      active_sessions: count(usage.active_sessions),
      month_spend_usd: count(usage.month_spend_usd),
    },
  };
}

/**
 * Create an OrgsClient for the caller's organizations.
 *
 * Requires EVOLVE_API_KEY (or { apiKey } in config).
 */
export function orgs(config?: HostedClientConfig): OrgsClient {
  const cfg = resolveConfig("orgs", config);

  return {
    async list(): Promise<Organization[]> {
      const res = await request(cfg, "/api/orgs");
      const raw = (await res.json()) as { items?: unknown };
      return (Array.isArray(raw.items) ? raw.items : []).map((item) =>
        mapOrganization(item as Record<string, unknown>)
      );
    },

    async get(org: string): Promise<OrganizationDetail> {
      const res = await request(cfg, `/api/orgs/${encodeURIComponent(org)}`);
      return mapOrganizationDetail((await res.json()) as Record<string, unknown>);
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
  /** Jobs: start, watch, compare, resume, retry, regrade, analyze, download. */
  readonly jobs: JobsClient;
  /** Platform-stored skills, referenced as `upload:<id>` in agents[].skills. */
  readonly skills: SkillsClient;
  /** Globally addressable trials: get, trace, artifact, regrade, stop. */
  readonly trials: TrialsClient;
  /** Analysis runs: verdict, the analyzer's own transcript, stored artifacts. */
  readonly analyses: AnalysesClient;
  /** Your organizations: list them, read one's quota and usage. */
  readonly orgs: OrgsClient;
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
  let analysesClient: AnalysesClient | undefined;
  let skillsClient: SkillsClient | undefined;
  let orgsClient: OrgsClient | undefined;

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
    get analyses(): AnalysesClient {
      return (analysesClient ??= analyses(config));
    },
    get skills(): SkillsClient {
      return (skillsClient ??= skills(config));
    },
    get orgs(): OrgsClient {
      return (orgsClient ??= orgs(config));
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
