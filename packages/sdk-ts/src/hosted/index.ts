import { createWriteStream } from "fs";
import { mkdir, rename, rm } from "fs/promises";
import { basename, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { DEFAULT_DASHBOARD_URL, ENV_EVOLVE_API_KEY } from "../constants";
import type {
  ActiveBenchmark,
  Benchmark,
  BenchmarkImport,
  BenchmarkImportFailure,
  BenchmarkImportInput,
  BenchmarkImportStatus,
  BenchmarkList,
  BenchmarkPage,
  BenchmarksClient,
  BenchmarkVersion,
  BenchmarkVersionState,
  ComparisonAggregate,
  ComparisonCell,
  ComparisonCoverage,
  ComparisonTaskRow,
  CustomHarness,
  CustomHarnessesClient,
  CustomHarnessInput,
  CustomHarnessList,
  CustomHarnessSource,
  EvalSandboxProvider,
  ExportJobOptions,
  GetBenchmarkOptions,
  HostedClientConfig,
  Job,
  JobAgent,
  JobComparison,
  JobEvent,
  JobFailure,
  JobInput,
  JobList,
  JobPage,
  JobsClient,
  JobStatus,
  JobWatch,
  BenchmarkImportList,
  CustomHarnessUpsertInput,
  ListBenchmarksOptions,
  ListCustomHarnessesOptions,
  ListImportsOptions,
  DownloadPackageOptions,
  ListJobsOptions,
  ListRegradesOptions,
  RegradeList,
  ListTrialsOptions,
  ModelUsage,
  SpendSource,
  Page,
  PageOptions,
  RegradeFilter,
  RegradeJob,
  RegradeJobOptions,
  RegradeJobStatus,
  RegradeOptions,
  RegradeResult,
  RegradeResultsPage,
  RegradeStatus,
  RunJobOptions,
  Task,
  Trial,
  TrialCounts,
  TrialDetail,
  TrialList,
  TrialPage,
  TrialStatus,
  TrialTraceEvent,
  TrialTraceOptions,
  TrialTracePage,
  UpstreamStatus,
  VerifierMode,
  WatchImportOptions,
  WatchJobOptions,
} from "./types";

// Re-exported from the hosted barrel so the package root can hand them on.
export { HOSTED_ERROR_CODES, isHostedErrorCode } from "./types";
export type {
  Awaitable,
  BenchmarkImportList,
  BenchmarkImportPage,
  CapabilityDocument,
  CustomHarnessUpsertInput,
  HarnessCapability,
  HarnessModel,
  HostedErrorCode,
  ListImportsOptions,
  ProviderCapability,
  StatusVocabulary,
  UpstreamStatus,
} from "./types";
import {
  isHostedErrorCode,
  type Awaitable,
  type CapabilityDocument,
  type HostedErrorCode,
} from "./types";

export type {
  ActiveBenchmark,
  Benchmark,
  BenchmarkImport,
  BenchmarkImportFailure,
  BenchmarkImportInput,
  BenchmarkImportSource,
  BenchmarkImportStatus,
  BenchmarkList,
  BenchmarkPage,
  BenchmarksClient,
  BenchmarkVersion,
  BenchmarkVersionState,
  ComparisonAggregate,
  ComparisonCell,
  ComparisonCoverage,
  ComparisonTaskRow,
  CustomHarness,
  CustomHarnessesClient,
  CustomHarnessInput,
  CustomHarnessList,
  CustomHarnessPage,
  CustomHarnessSource,
  EvalSandboxProvider,
  ExportJobOptions,
  GetBenchmarkOptions,
  HostedClientConfig,
  Job,
  JobAgent,
  JobComparison,
  JobEvent,
  JobFailure,
  JobInput,
  JobList,
  JobPage,
  JobsClient,
  JobStatus,
  JobWatch,
  ListBenchmarksOptions,
  ListCustomHarnessesOptions,
  ListJobsOptions,
  ListRegradesOptions,
  RegradeList,
  ListTrialsOptions,
  ModelUsage,
  Page,
  PageOptions,
  RegradeFilter,
  RegradeJob,
  RegradeJobOptions,
  RegradeJobStatus,
  RegradeOptions,
  RegradeResult,
  RegradeResultsPage,
  RegradeStatus,
  RunJobOptions,
  SpendSource,
  Task,
  TaskProviderVerdict,
  Trial,
  TrialCounts,
  TrialDetail,
  TrialList,
  TrialPage,
  TrialStatus,
  TrialTally,
  TrialTraceEvent,
  TrialTraceOptions,
  TrialTracePage,
  VerifierMode,
  WatchImportOptions,
  WatchJobOptions,
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
 *       const refused = err.details?.refusedTasks as { taskKey: string }[];
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
   * The input field this refusal is about — a body path ("agents[0].harness"),
   * a query parameter ("limit"), or a multipart part name ("runCommand").
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
  // Header fallbacks, read before the body so an unparseable body still yields
  // a usable requestId and retry delay.
  const headerRequestId = res.headers?.get?.("x-request-id") ?? undefined;
  const headerRetryAfter = Number(res.headers?.get?.("retry-after"));
  const retryAfterFromHeader = Number.isFinite(headerRetryAfter)
    ? headerRetryAfter
    : undefined;

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
        retryAfterSec:
          typeof body.error.retryAfterSec === "number"
            ? body.error.retryAfterSec
            : retryAfterFromHeader,
        requestId:
          typeof body.error.requestId === "string" ? body.error.requestId : headerRequestId,
      });
    }
  } catch (error) {
    if (error instanceof EvolveApiError) throw error;
    // Fall through: unparseable body.
  }
  throw new EvolveApiError(res.status, "unknown_error", text || res.statusText, {
    retryAfterSec: retryAfterFromHeader,
    requestId: headerRequestId,
  });
}

/**
 * Thrown by benchmarks().getActive() when the named benchmark exists but has no
 * active version, so there is no runnable version to resolve. Use get() to
 * inspect a benchmark that may not have an active version yet.
 */
export class NoActiveVersionError extends Error {
  /** The benchmark name that had no active version */
  readonly benchmark: string;
  constructor(benchmark: string) {
    super(`Benchmark "${benchmark}" has no active version`);
    this.name = "NoActiveVersionError";
    this.benchmark = benchmark;
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
function parseBenchmarkRef(ref: string): { name: string; version?: string } {
  const at = ref.indexOf("@");
  if (at === -1) return { name: ref.trim() };
  const name = ref.slice(0, at).trim();
  const version = ref.slice(at + 1).trim();
  if (!name || !version) {
    throw new Error(`Invalid benchmark ref "${ref}": expected "name" or "name@version"`);
  }
  return { name, version };
}

function mapJobAgent(raw: Record<string, unknown>): JobAgent {
  // Map only the public JobAgent fields.
  return {
    harness: raw.harness as string,
    model: raw.model as string,
    harnessVersion: (raw.harnessVersion as string | null) ?? null,
    reasoningEffort: (raw.reasoningEffort as string | null) ?? null,
  };
}

function mapBenchmarkVersion(raw: Record<string, unknown>): BenchmarkVersion {
  return {
    version: raw.version as string,
    state: raw.state as BenchmarkVersionState,
    createdAt: raw.createdAt as string,
    taskCount: (raw.taskCount as number) ?? 0,
  };
}

function mapTask(raw: Record<string, unknown>): Task {
  return {
    taskKey: raw.taskKey as string,
    agentTimeoutSec: raw.agentTimeoutSec as number,
    verifierTimeoutSec: raw.verifierTimeoutSec as number,
    // Per-provider capability verdicts — the law: where a task can run is
    // visible before any money is spent.
    providers: raw.providers as Task["providers"],
  };
}

/** ONE job mapper for every call — nothing conditional, because nothing is optional. */
function mapJob(raw: Record<string, unknown>): Job {
  const trials = (raw.trials ?? {}) as Record<string, unknown>;
  return {
    id: raw.id as string,
    status: raw.status as JobStatus,
    benchmark: raw.benchmark as string,
    agents: ((raw.agents as Record<string, unknown>[]) ?? []).map(mapJobAgent),
    runsPerTask: raw.runsPerTask as number,
    concurrency: raw.concurrency as number,
    maxTrialSpendUsd: raw.maxTrialSpendUsd as number,
    worstCaseSpendUsd: raw.worstCaseSpendUsd as number,
    sandboxProvider: raw.sandboxProvider as EvalSandboxProvider,
    spentUsd: (raw.spentUsd as number) ?? 0,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
    counts: raw.counts as Job["counts"],
    trials: {
      total: (trials.total as number) ?? 0,
      byStatus: (trials.byStatus as TrialCounts) ?? ({} as TrialCounts),
    },
    meanReward: (raw.meanReward as number | null) ?? null,
    failure: (raw.failure as JobFailure | null) ?? null,
    sourceJobId: (raw.sourceJobId as string | null) ?? null,
    idempotentReplay: raw.idempotentReplay === true,
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

function mapTrial(raw: Record<string, unknown>): Trial {
  return {
    id: raw.id as string,
    taskKey: raw.taskKey as string,
    agent: mapJobAgent((raw.agent as Record<string, unknown>) || {}),
    runNumber: raw.runNumber as number,
    status: raw.status as TrialStatus,
    reward: (raw.reward as number | null) ?? null,
    metrics: (raw.metrics as Record<string, number> | null) ?? null,
    failurePhase: (raw.failurePhase as string | null) ?? null,
    failureDetail: (raw.failureDetail as string | null) ?? null,
    phaseTimingsMs: (raw.phaseTimingsMs as Record<string, number> | null) ?? null,
    modelUsage: (raw.modelUsage as ModelUsage | null) ?? null,
    sandboxProvider: (raw.sandboxProvider as EvalSandboxProvider | null) ?? null,
    verifierMode: (raw.verifierMode as VerifierMode | null) ?? null,
    // First-class since the server promoted these out of the modelUsage blob.
    // NULL means the trial never ran — never zero.
    spentUsd: (raw.spentUsd as number | null) ?? null,
    spendSource: (raw.spendSource as SpendSource | null) ?? null,
    // Mid-run lower bound, kept beside the settled pair and never folded into
    // it: it lags the gateway and is CLEARED when the trial settles.
    liveSpentUsd: (raw.liveSpentUsd as number | null) ?? null,
    liveSpendAt: (raw.liveSpendAt as string | null) ?? null,
    resolvedHarnessVersion: (raw.resolvedHarnessVersion as string | null) ?? null,
    // Where the trial ran. Absent entirely from servers that predate the
    // fields, which reads the same as "never booted a box": null.
    sandboxId: (raw.sandboxId as string | null) ?? null,
    verifierSandboxId: (raw.verifierSandboxId as string | null) ?? null,
    sessionRef: (raw.sessionRef as string | null) ?? null,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
}

function mapRegradeResult(raw: Record<string, unknown>): RegradeResult {
  return {
    id: raw.id as string,
    sourceTrialId: raw.sourceTrialId as string,
    taskKey: raw.taskKey as string,
    status: raw.status as RegradeStatus,
    reward: (raw.reward as number | null) ?? null,
    metrics: (raw.metrics as Record<string, number> | null) ?? null,
    sourceReward: (raw.sourceReward as number | null) ?? null,
    sourceStatus: raw.sourceStatus as string,
    rewardDelta: (raw.rewardDelta as number | null) ?? null,
    verifierMode: (raw.verifierMode as VerifierMode) ?? "separate",
    verifierDigest: (raw.verifierDigest as string | null) ?? null,
    verifierSandboxId: (raw.verifierSandboxId as string | null) ?? null,
    failurePhase: (raw.failurePhase as string | null) ?? null,
    failureDetail: (raw.failureDetail as string | null) ?? null,
    phaseTimingsMs: (raw.phaseTimingsMs as Record<string, number> | null) ?? null,
    createdAt: raw.createdAt as string,
    settledAt: (raw.settledAt as string | null) ?? null,
  };
}

function mapRegradeJob(raw: Record<string, unknown>): RegradeJob {
  const results = (raw.results ?? {}) as Record<string, unknown>;
  return {
    id: raw.id as string,
    sourceJobId: raw.sourceJobId as string,
    status: raw.status as RegradeJobStatus,
    sandboxProvider: raw.sandboxProvider as EvalSandboxProvider,
    filter: (raw.filter as RegradeJob["filter"]) ?? null,
    results: {
      ...mapPage(results, mapRegradeResult),
      total: (results.total as number) ?? 0,
      byStatus:
        (results.byStatus as RegradeResultsPage["byStatus"]) ??
        ({} as RegradeResultsPage["byStatus"]),
    },
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
}

function mapCustomHarness(raw: Record<string, unknown>): CustomHarness {
  return {
    name: raw.name as string,
    source: raw.source as CustomHarnessSource,
    runCommand: raw.runCommand as string,
    env: (raw.env as Record<string, string>) ?? {},
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
}

function mapBenchmarkImport(raw: Record<string, unknown>): BenchmarkImport {
  const benchmarkImport: BenchmarkImport = {
    id: raw.id as string,
    status: raw.status as BenchmarkImportStatus,
    benchmarkName: raw.benchmarkName as string,
    version: raw.version as string,
    failure: (raw.failure as BenchmarkImportFailure | null) ?? null,
  };
  if (typeof raw.taskCount === "number") {
    benchmarkImport.taskCount = raw.taskCount;
  }
  if (typeof raw.createdAt === "string") benchmarkImport.createdAt = raw.createdAt;
  if (typeof raw.updatedAt === "string") benchmarkImport.updatedAt = raw.updatedAt;
  return benchmarkImport;
}

function mapCoverage(raw: unknown): ComparisonCoverage {
  const coverage = (raw ?? {}) as Record<string, unknown>;
  return {
    scored: (coverage.scored as number) ?? 0,
    total: (coverage.total as number) ?? 0,
  };
}

function mapComparisonAggregate(raw: Record<string, unknown>): ComparisonAggregate {
  return {
    id: raw.id as string,
    benchmark: raw.benchmark as string,
    status: raw.status as JobStatus,
    meanReward: (raw.meanReward as number | null) ?? null,
    coverage: mapCoverage(raw.coverage),
    spentUsd: (raw.spentUsd as number) ?? 0,
    // Public JobAgent fields only.
    agents: ((raw.agents as Record<string, unknown>[]) || []).map(mapJobAgent),
    createdAt: raw.createdAt as string,
  };
}

function mapComparisonCell(raw: Record<string, unknown>): ComparisonCell {
  return {
    jobId: raw.jobId as string,
    status: raw.status as ComparisonCell["status"],
    meanReward: (raw.meanReward as number | null) ?? null,
    coverage: mapCoverage(raw.coverage),
  };
}

function mapComparisonTaskRow(raw: Record<string, unknown>): ComparisonTaskRow {
  return {
    taskKey: raw.taskKey as string,
    disagreement: raw.disagreement === true,
    cells: ((raw.cells as Record<string, unknown>[]) || []).map(mapComparisonCell),
  };
}

function mapTraceEvent(raw: Record<string, unknown>): TrialTraceEvent {
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
 */
function createSseParser(onFrame: (frame: SseFrame) => void): { push(chunk: string): void } {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, "\n");
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
 * named parts FIRST, then the bytes as a `file` part. Order matters — the
 * server refuses a name it will never accept before receiving the upload, and
 * it can only do that if the metadata arrives first.
 */
function uploadForm(
  fields: Record<string, string | undefined>,
  file?: { bytes: Uint8Array; filename: string }
): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(name, value);
  }
  if (file) {
    form.set(
      "file",
      new Blob([file.bytes as unknown as BlobPart], { type: "application/gzip" }),
      file.filename
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
 * outside it — and the benchmark download's filename interpolates a
 * user-supplied version label, which makes it attacker-influenced rather than
 * merely server-supplied. basename() strips any directory part, and anything
 * that still looks like a path component, is empty, or is a dot-entry falls
 * back to the caller's own name.
 *
 * One helper for both download surfaces on purpose: exportFilename had the same
 * bug, and a second copy is how one of them gets fixed and the other does not.
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

// =============================================================================
// BENCHMARKS CLIENT
// =============================================================================

/**
 * Create a BenchmarksClient for the shared benchmark catalog.
 *
 * Requires EVOLVE_API_KEY (or { apiKey } in config).
 *
 * @example
 * ```ts
 * import { benchmarks } from "@evolvingmachines/sdk";
 *
 * const b = benchmarks();
 * const catalog = await b.list();
 * const deepSwe = await b.get("deep-swe@1.1");
 * ```
 */
export function benchmarks(config?: HostedClientConfig): BenchmarksClient {
  const cfg = resolveConfig("benchmarks", config);

  async function getImport(id: string): Promise<BenchmarkImport> {
    const res = await request(cfg, `/api/benchmarks/imports/${encodeURIComponent(id)}`);
    return mapBenchmarkImport((await res.json()) as Record<string, unknown>);
  }

  /**
   * Map the `upstream` field, tolerating an older server that omits it.
   *
   * A missing field and an explicit null mean the same thing to a caller —
   * nothing to watch — so both become null rather than undefined, and a client
   * never has to distinguish "this server is old" from "this benchmark has no
   * git source".
   */
  function mapUpstream(raw: unknown): UpstreamStatus | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    return {
      ref: value.ref as string,
      currentCommit: value.currentCommit as string,
      latestCommit: (value.latestCommit as string | null) ?? null,
      moved: value.moved === true,
      behindBy: typeof value.behindBy === "number" ? value.behindBy : null,
      checkedAt: (value.checkedAt as string | null) ?? null,
      error: (value.error as string | null) ?? null,
    };
  }

  async function getBenchmark(
    ref: string,
    options?: GetBenchmarkOptions
  ): Promise<Benchmark> {
    const parsed = parseBenchmarkRef(ref);
    const query = pageQuery(options, { version: parsed.version });
    const res = await request(
      cfg,
      `/api/benchmarks/${encodeURIComponent(parsed.name)}${query}`
    );
    const raw = (await res.json()) as Record<string, unknown>;
    return {
      name: raw.name as string,
      title: (raw.title as string | null) ?? null,
      description: (raw.description as string | null) ?? null,
      // activeVersion is the full version object on every route (list + detail).
      activeVersion: raw.activeVersion
        ? mapBenchmarkVersion(raw.activeVersion as Record<string, unknown>)
        : null,
      versions: ((raw.versions as Record<string, unknown>[]) || []).map(mapBenchmarkVersion),
      selectedVersion: raw.selectedVersion
        ? mapBenchmarkVersion(raw.selectedVersion as Record<string, unknown>)
        : null,
      tasks: mapPage(raw.tasks, mapTask),
      upstream: mapUpstream(raw.upstream),
      createdAt: raw.createdAt as string,
      updatedAt: raw.updatedAt as string,
    };
  }

  async function listPage(options?: ListBenchmarksOptions): Promise<BenchmarkPage> {
    const res = await request(cfg, `/api/benchmarks${pageQuery(options)}`);
    return mapPage((await res.json()) as Record<string, unknown>, (raw) => ({
      name: raw.name as string,
      title: (raw.title as string | null) ?? null,
      description: (raw.description as string | null) ?? null,
      activeVersion: raw.activeVersion
        ? mapBenchmarkVersion(raw.activeVersion as Record<string, unknown>)
        : null,
      upstream: mapUpstream(raw.upstream),
    }));
  }

  return {
    list(options?: ListBenchmarksOptions): BenchmarkList {
      // Await for one page; for-await to walk the catalog across cursor pages.
      return makePaginated(listPage, options);
    },

    get: getBenchmark,

    async getActive(name: string, options?: GetBenchmarkOptions): Promise<ActiveBenchmark> {
      // get(name) with a bare name resolves the active version's task list; the
      // detail route echoes the active version so we can hard-require it here.
      const bench = await getBenchmark(name, options);
      if (bench.activeVersion === null) {
        throw new NoActiveVersionError(name);
      }
      return {
        name: bench.name,
        title: bench.title,
        description: bench.description,
        activeVersion: bench.activeVersion,
        version: bench.activeVersion.version,
        tasks: bench.tasks ?? { items: [], nextCursor: null, hasMore: false },
        versions: bench.versions ?? [],
        createdAt: bench.createdAt as string,
        updatedAt: bench.updatedAt as string,
      };
    },

    async import(input: BenchmarkImportInput): Promise<BenchmarkImport> {
      const src = input.source;
      // ONE body grammar: multipart/form-data, metadata in named parts. The
      // corpus is the `file` part; a git source is the gitUrl + ref parts.
      // Nothing rides the query string, where it would land in access logs.
      //
      // The run-time checks below STAY even though BenchmarkImportSource is a
      // union that makes `{}` and both-at-once uncompilable. The type guards
      // TypeScript callers; these guard JavaScript ones, and anything that
      // arrived through a JSON.parse — a config file, an HTTP body, a CLI flag
      // — where no type was ever checked.
      if (src?.directory) {
        const { tarGzipDirectory } = await import("./tar");
        const gzipped = tarGzipDirectory(src.directory);
        const res = await request(cfg, "/api/benchmarks/imports", {
          method: "POST",
          body: uploadForm(
            { benchmarkName: input.benchmarkName, version: input.version },
            { bytes: gzipped, filename: "corpus.tar.gz" }
          ),
        });
        return mapBenchmarkImport((await res.json()) as Record<string, unknown>);
      }
      // `"gitUrl" in src` rather than testing both fields: the union makes ref
      // REQUIRED on the git branch, so a source carrying gitUrl without ref is
      // already a compile error for a typed caller — and for an untyped one,
      // the server refuses it with a named param, which is a better error than
      // this function's generic sentence.
      if (src && "gitUrl" in src && src.gitUrl) {
        const res = await request(cfg, "/api/benchmarks/imports", {
          method: "POST",
          body: uploadForm({
            benchmarkName: input.benchmarkName,
            version: input.version,
            gitUrl: src.gitUrl,
            ref: src.ref,
          }),
        });
        return mapBenchmarkImport((await res.json()) as Record<string, unknown>);
      }
      throw new Error(
        "benchmarks().import() requires either a git source ({ source: { gitUrl, ref } }) " +
          "or a local corpus directory ({ source: { directory } }), plus benchmarkName and version"
      );
    },

    getImport,

    async watchImport(id: string, options?: WatchImportOptions): Promise<BenchmarkImport> {
      const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_IMPORT_POLL_INTERVAL_MS;
      let lastStatus: string | null = null;
      for (;;) {
        throwIfAborted(options?.signal);
        const current = await getImport(id);
        if (current.status !== lastStatus) {
          lastStatus = current.status;
          options?.onStatus?.(current);
        }
        if (TERMINAL_IMPORT_STATUSES.has(current.status)) return current;
        await sleep(pollIntervalMs, options?.signal);
      }
    },

    downloadPackage: (async (
      id: string,
      options?: DownloadPackageOptions
    ): Promise<Buffer | string | ReadableStream<Uint8Array>> => {
      // Same three delivery shapes as jobs().export(), because it is the same
      // job for the caller: a potentially large binary that they want in
      // memory, on disk, or piped somewhere.
      const res = await request(
        cfg,
        `/api/benchmarks/imports/${encodeURIComponent(id)}/package`
      );
      if (options?.stream) {
        if (!res.body) throw new Error("Package response has no body");
        // The ONLY shape that cannot be verified here: the caller consumes the
        // stream, so only they ever hold the whole body. Read
        // PACKAGE_DIGEST_HEADER off the response and hash as you go.
        return res.body as ReadableStream<Uint8Array>;
      }
      if (options?.to) {
        if (!res.body) throw new Error("Package response has no body");
        const dir = options.to;
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, safeDownloadFilename(res, `import-${id}-corpus.tar.gz`));
        // TEMP-THEN-RENAME. Bytes never appear at the final path until they are
        // complete AND verified, so a transfer that dies partway leaves nothing
        // a later run could mistake for the corpus. rename within one directory
        // is atomic on every platform we target.
        //
        // THE SUFFIX IS PER CALL, and it is not decoration. Two concurrent
        // downloads of one package into one directory shared `<file>.part`
        // verbatim: they interleaved writes into the same file, then the first
        // rename won and the second died on a bare ENOENT with no hint of why.
        // Worse quietly: each call hashed ITS OWN stream, so the digest check
        // proved something about bytes that were never the ones on disk. With a
        // random name per call, each stream owns its file end to end, the
        // verification covers exactly what gets promoted, and both callers get
        // the package.
        const { createHash, randomBytes } = await import("crypto");
        const partPath = `${filePath}.${randomBytes(8).toString("hex")}.part`;
        // Hashed WHILE streaming, never buffered: a package can be 512 MB, and
        // reading it into memory to check a digest would trade one correctness
        // problem for a heap one.
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
          // TRUNCATION. A socket cut mid-body is not an error to fetch — the
          // stream simply ends — so a short read returned a partial file as
          // success. Content-Length is the server's own count; disagreeing with
          // it means the body did not all arrive.
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
          // The partial never gets promoted, and never survives: a file that
          // looks like the corpus and is not is worse than no file at all.
          await rm(partPath, { force: true }).catch(() => {});
          throw error;
        }
        return filePath;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      assertCompleteBody(res, bytes.length);
      await verifyPackageDigest(res, bytes);
      return bytes;
    }) as BenchmarksClient["downloadPackage"],

    listImports(options?: ListImportsOptions): BenchmarkImportList {
      // Await for one page; for-await to walk them all across cursor pages.
      return makePaginated(async (opts) => {
        const query = new URLSearchParams();
        if (opts.limit !== undefined) query.set("limit", String(opts.limit));
        if (opts.cursor !== undefined) query.set("cursor", opts.cursor);
        if (options?.status !== undefined) query.set("status", options.status);
        if (options?.benchmark !== undefined) query.set("benchmark", options.benchmark);
        const suffix = query.toString() ? `?${query}` : "";
        const res = await request(cfg, `/api/benchmarks/imports${suffix}`);
        return mapPage((await res.json()) as Record<string, unknown>, mapBenchmarkImport);
      }, options);
    },

    async delete(name: string): Promise<void> {
      // 204 No Content — nothing to map. A benchmark some job still references
      // is refused with benchmark_in_use, and err.details.sampleJobIds names
      // the jobs blocking it.
      await request(cfg, `/api/benchmarks/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
  };
}

// =============================================================================
// CUSTOM HARNESSES CLIENT
// =============================================================================

/**
 * Create a CustomHarnessesClient for the caller's own private harnesses.
 *
 * Register a harness once, then name it in `agents[].harness` exactly
 * like a built-in. Requires EVOLVE_API_KEY (or { apiKey } in config).
 *
 * @example
 * ```ts
 * import { customHarnesses, jobs } from "@evolvingmachines/sdk";
 *
 * const harnesses = customHarnesses();
 * await harnesses.create({
 *   name: "acme-cli",
 *   installScript: "curl -fsSL https://acme.dev/install.sh | sh",
 *   runCommand: "acme-cli --headless",
 * });
 *
 * await jobs().run({
 *   benchmark: "deep-swe",
 *   agents: [{ harness: "acme-cli", model: "gpt-5.5" }],
 *   maxTrialSpendUsd: 25,
 * });
 * ```
 */
export function customHarnesses(config?: HostedClientConfig): CustomHarnessesClient {
  const cfg = resolveConfig("customHarnesses", config);

  return {
    async create(input: CustomHarnessInput): Promise<CustomHarness> {
      // ONE body grammar: multipart/form-data. The run command and the declared
      // env are named PARTS — they used to ride the query string of an upload,
      // which put a shell command and a set of environment values into every
      // access log and proxy buffer on the way here.
      const body = await harnessUploadBody("customHarnesses().create()", input);
      const res = await request(cfg, "/api/custom-harnesses", { method: "POST", body });
      return mapCustomHarness((await res.json()) as Record<string, unknown>);
    },

    list(options?: ListCustomHarnessesOptions): CustomHarnessList {
      // Await for one page; for-await to walk them all across cursor pages.
      return makePaginated(async (opts) => {
        const res = await request(cfg, `/api/custom-harnesses${pageQuery(opts)}`);
        return mapPage((await res.json()) as Record<string, unknown>, mapCustomHarness);
      }, options);
    },

    async get(name: string): Promise<CustomHarness> {
      const res = await request(cfg, `/api/custom-harnesses/${encodeURIComponent(name)}`);
      return mapCustomHarness((await res.json()) as Record<string, unknown>);
    },

    async delete(name: string): Promise<void> {
      // 204 No Content — nothing to map.
      await request(cfg, `/api/custom-harnesses/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    },

    async upsert(name: string, input: CustomHarnessUpsertInput): Promise<CustomHarness> {
      // One request, so the name never briefly stops resolving the way
      // delete()+create() makes it. Same body grammar as create(), minus the
      // name part — the URL carries it.
      const body = await harnessUploadBody("customHarnesses().upsert()", { ...input, name });
      const res = await request(cfg, `/api/custom-harnesses/${encodeURIComponent(name)}`, {
        method: "PUT",
        body,
      });
      return mapCustomHarness((await res.json()) as Record<string, unknown>);
    },
  };
}

/**
 * The multipart body both create() and upsert() send. Shared because the two
 * differ only in method and URL: one grammar means a harness registered by
 * either route is byte-identical on the wire.
 */
async function harnessUploadBody(
  caller: string,
  input: CustomHarnessInput
): Promise<FormData> {
  // Same division of labour as benchmarks().import(): CustomHarnessSourceInput
  // is a union, so a TypeScript caller cannot pass both or neither. These
  // checks are for JavaScript callers and for values that crossed a JSON
  // boundary with no type behind them.
  const hasInstallScript = typeof input.installScript === "string";
  const hasDirectory = typeof input.directory === "string";
  if (hasInstallScript && hasDirectory) {
    throw new Error(
      `${caller} takes EITHER an install script ({ installScript }) ` +
        "or a local directory ({ directory }), not both"
    );
  }
  if (!hasInstallScript && !hasDirectory) {
    throw new Error(
      `${caller} requires either an install script ({ installScript }) ` +
        "or a local directory ({ directory }), plus runCommand"
    );
  }
  const fields: Record<string, string | undefined> = {
    name: input.name,
    runCommand: input.runCommand,
    ...(input.env !== undefined ? { env: JSON.stringify(input.env) } : {}),
    ...(hasInstallScript ? { installScript: input.installScript } : {}),
  };
  if (hasDirectory) {
    const { tarGzipDirectory } = await import("./tar");
    const gzipped = tarGzipDirectory(input.directory as string);
    return uploadForm(fields, { bytes: gzipped, filename: "source.tar.gz" });
  }
  return uploadForm(fields);
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
 * // benchmark: bare name = active version; "name@version" pins a version
 * const job = await client.run({
 *   benchmark: "deep-swe",
 *   agents: [{ harness: "codex", model: "gpt-5.5" }],
 *   runsPerTask: 1,
 *   concurrency: 4,
 *   maxTrialSpendUsd: 25,
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
    const res = await request(cfg, `/api/jobs${pageQuery(options)}`);
    return mapPage((await res.json()) as Record<string, unknown>, mapJob);
  }

  async function trialsPage(
    id: string,
    options?: ListTrialsOptions
  ): Promise<TrialPage> {
    const query = pageQuery(options, {
      status: options?.status?.length ? options.status.join(",") : undefined,
    });
    const res = await request(cfg, `/api/jobs/${encodeURIComponent(id)}/trials${query}`);
    return mapPage((await res.json()) as Record<string, unknown>, mapTrial);
  }

  async function getTrialTrace(
    id: string,
    trialId: string,
    options?: TrialTraceOptions
  ): Promise<TrialTracePage> {
    const res = await request(
      cfg,
      `/api/jobs/${encodeURIComponent(id)}/trials/${encodeURIComponent(trialId)}/trace${pageQuery(options)}`
    );
    return mapPage((await res.json()) as Record<string, unknown>, mapTraceEvent);
  }

  /**
   * One raw trace artifact for a trial, by the trace route's ?stream=
   * selector: "verifier" | "trace-stdout" | "trace-stderr" answer
   * { log: string | null }; "agent-home" (the CLI's whole home folder) and
   * "trace-native" (just its conversation transcript) answer
   * { files: Record<sandbox-path, text> | null }. Null = never stored
   * (normal answer, not an error): a QUEUED/CANCELLED trial, a harness that
   * wrote nothing, or a purged trace.
   */
  async function getTrialArtifact(
    id: string,
    trialId: string,
    stream: "verifier" | "trace-stdout" | "trace-stderr"
  ): Promise<string | null>;
  async function getTrialArtifact(
    id: string,
    trialId: string,
    stream: "agent-home" | "trace-native"
  ): Promise<Record<string, string> | null>;
  async function getTrialArtifact(
    id: string,
    trialId: string,
    stream: "verifier" | "trace-stdout" | "trace-stderr" | "agent-home" | "trace-native"
  ): Promise<string | Record<string, string> | null> {
    const res = await request(
      cfg,
      `/api/jobs/${encodeURIComponent(id)}/trials/${encodeURIComponent(trialId)}/trace?stream=${stream}`
    );
    const body = (await res.json()) as { log?: string | null; files?: Record<string, string> | null };
    return stream === "agent-home" || stream === "trace-native" ? (body.files ?? null) : (body.log ?? null);
  }

  async function exportResponse(id: string, format?: "harbor"): Promise<Response> {
    const qs = format ? `?format=${encodeURIComponent(format)}` : "";
    return request(cfg, `/api/jobs/${encodeURIComponent(id)}/export${qs}`);
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
          await res.text().catch(() => "");
          await sleep(delayMs, signal);
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
        // read off its emit site. A frame whose type is not in the union still
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
    async run(input: JobInput, options?: RunJobOptions): Promise<Job> {
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
      // job across cursor pages.
      return makePaginated(listPage, options);
    },

    trials(id: string, options?: ListTrialsOptions): TrialList {
      // Await for one page; for-await to walk every trial across cursors.
      // The status filter rides along on every page fetch.
      return makePaginated(
        (opts) => trialsPage(id, { ...opts, status: options?.status }),
        options
      );
    },

    async trial(id: string, trialId: string): Promise<TrialDetail> {
      const res = await request(
        cfg,
        `/api/jobs/${encodeURIComponent(id)}/trials/${encodeURIComponent(trialId)}`
      );
      const raw = (await res.json()) as Record<string, unknown>;
      return {
        ...mapTrial(raw),
        jobId: raw.jobId as string,
      };
    },

    trialTrace: getTrialTrace,
    trialArtifact: getTrialArtifact,

    async *trialTraceEvents(
      id: string,
      trialId: string,
      options?: TrialTraceOptions
    ): AsyncIterableIterator<TrialTraceEvent> {
      let cursor = options?.cursor;
      for (;;) {
        const page = await getTrialTrace(id, trialId, { cursor, limit: options?.limit });
        for (const event of page.items) yield event;
        // Drained: nextCursor is null when there is no next page, which now
        // says "caught up" rather than echoing the position back.
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
      }
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

    async compare(ids: string[]): Promise<JobComparison> {
      const idsQuery = ids.map(encodeURIComponent).join(",");
      const res = await request(cfg, `/api/jobs/compare?ids=${idsQuery}`);
      const data = (await res.json()) as {
        jobs?: Record<string, unknown>[];
        taskMatrix?: Record<string, unknown>[];
      };
      return {
        jobs: (data.jobs || []).map(mapComparisonAggregate),
        taskMatrix: (data.taskMatrix || []).map(mapComparisonTaskRow),
      };
    },

    async rerunFailed(id: string, options?: RunJobOptions): Promise<Job> {
      const res = await request(
        cfg,
        `/api/jobs/${encodeURIComponent(id)}/rerun-failed`,
        {
          method: "POST",
          headers: options?.idempotencyKey
            ? { "Idempotency-Key": options.idempotencyKey }
            : undefined,
        }
      );
      return mapJob((await res.json()) as Record<string, unknown>);
    },

    async regrade(id: string, options?: RegradeOptions): Promise<RegradeJob> {
      const body: Record<string, unknown> = {};
      if (options?.status?.length) body.status = options.status;
      if (options?.taskKey !== undefined) body.taskKey = options.taskKey;
      const res = await request(cfg, `/api/jobs/${encodeURIComponent(id)}/regrade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return mapRegradeJob((await res.json()) as Record<string, unknown>);
    },

    async regradeTrial(id: string, trialId: string): Promise<RegradeJob> {
      const res = await request(
        cfg,
        `/api/jobs/${encodeURIComponent(id)}/trials/${encodeURIComponent(trialId)}/regrade`,
        { method: "POST" }
      );
      return mapRegradeJob((await res.json()) as Record<string, unknown>);
    },

    listRegrades(options?: ListRegradesOptions): RegradeList {
      // Await for one page; for-await to walk every regrade across cursors.
      // ?jobId= rides along on every page fetch, exactly as the trials list
      // carries its status filter.
      return makePaginated(
        async (opts) => {
          const res = await request(
            cfg,
            `/api/regrades${pageQuery(opts, { jobId: options?.jobId })}`
          );
          const body = (await res.json()) as {
            items: Record<string, unknown>[];
            nextCursor: string | null;
            hasMore: boolean;
          };
          return {
            items: body.items.map(mapRegradeJob),
            nextCursor: body.nextCursor,
            hasMore: body.hasMore,
          };
        },
        options
      );
    },

    async getRegrade(regradeId: string, options?: RegradeJobOptions): Promise<RegradeJob> {
      const res = await request(
        cfg,
        `/api/regrades/${encodeURIComponent(regradeId)}${pageQuery(options)}`
      );
      return mapRegradeJob((await res.json()) as Record<string, unknown>);
    },

    export: (async (
      id: string,
      options?: ExportJobOptions
    ): Promise<Buffer | string | ReadableStream<Uint8Array>> => {
      const res = await exportResponse(id, options?.format);
      if (options?.stream) {
        if (!res.body) throw new Error("Export response has no body");
        return res.body as ReadableStream<Uint8Array>;
      }
      if (options?.to) {
        if (!res.body) throw new Error("Export response has no body");
        const dir = options.to;
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, safeDownloadFilename(res, `job-${id}-export.json.gz`));
        const nodeStream = Readable.fromWeb(
          res.body as import("stream/web").ReadableStream
        );
        await pipeline(nodeStream, createWriteStream(filePath));
        return filePath;
      }
      const bytes = await res.arrayBuffer();
      return Buffer.from(bytes);
    }) as JobsClient["export"],
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
 * The three factories are the right decomposition — a benchmark catalog, your
 * own harness registrations, and jobs are three genuinely different lifetimes —
 * but they made you say the same thing three times:
 *
 *   const b = benchmarks({ apiKey, baseUrl });
 *   const h = customHarnesses({ apiKey, baseUrl });   // again
 *   const j = jobs({ apiKey, baseUrl });              // and again
 *
 * and any one of those going out of sync with the others is a bug that looks
 * like a permissions problem. One door, one config:
 *
 *   const evolve = hosted({ apiKey });
 *   const catalog = await evolve.benchmarks.list();
 *   const job = await evolve.jobs.run({ ... });
 *
 * The three clients are built LAZILY, on first access. That matters because
 * they throw when no API key is present, and `meta()` needs no key at all — so
 * `hosted().meta()` works on a signed-out page, while `hosted().jobs` still
 * fails loudly and immediately the moment you reach for something that does
 * need credentials.
 */
export interface HostedEvolve {
  /** The benchmark catalog: list, get, import, delete. */
  readonly benchmarks: BenchmarksClient;
  /** Your own bring-your-own harness registrations. */
  readonly customHarnesses: CustomHarnessesClient;
  /** Jobs: run, watch, compare, regrade, export. */
  readonly jobs: JobsClient;
  /**
   * The capability document — every harness, provider, status, limit, and
   * error code the platform supports. Public: no API key required.
   *
   * Fetch it once and stop hardcoding. It is what tells you the legal harness
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
 * const evolve = hosted();                       // EVOLVE_API_KEY from env
 * const { harnesses } = await evolve.meta();     // no key needed for this one
 * const job = await evolve.jobs.run({
 *   benchmark: "deep-swe",
 *   agents: [{ harness: "claude", model: harnesses[0].defaultModel! }],
 * });
 * ```
 */
export function hosted(config?: HostedClientConfig): HostedEvolve {
  let benchmarksClient: BenchmarksClient | undefined;
  let customHarnessesClient: CustomHarnessesClient | undefined;
  let jobsClient: JobsClient | undefined;

  return {
    get benchmarks(): BenchmarksClient {
      return (benchmarksClient ??= benchmarks(config));
    },
    get customHarnesses(): CustomHarnessesClient {
      return (customHarnessesClient ??= customHarnesses(config));
    },
    get jobs(): JobsClient {
      return (jobsClient ??= jobs(config));
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
 * harness picker — so this is the one hosted call that takes only a base URL.
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
