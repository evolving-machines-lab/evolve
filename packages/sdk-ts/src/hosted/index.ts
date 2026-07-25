import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { DEFAULT_DASHBOARD_URL, ENV_EVOLVE_API_KEY } from "../constants";
import type {
  ActiveBenchmark,
  Benchmark,
  BenchmarkImport,
  BenchmarkImportError,
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
  ListBenchmarksOptions,
  ListCustomHarnessesOptions,
  ListJobsOptions,
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
  VerifierMode,
  WatchImportOptions,
  WatchJobOptions,
} from "./types";

export type {
  ActiveBenchmark,
  Benchmark,
  BenchmarkImport,
  BenchmarkImportError,
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
 * A typed failure from the hosted evals API. `message` is the server's own
 * product sentence; `code` is the stable machine-readable identifier (e.g.
 * "benchmark_not_found", "version_not_ready", "provider_unsupported",
 * "rate_limited") so callers branch on codes, never on English.
 */
export class EvolveApiError extends Error {
  /** HTTP status of the failed response */
  readonly status: number;
  /** Stable snake_case error code from the API ("unknown_error" when absent) */
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "EvolveApiError";
    this.status = status;
    this.code = code;
  }
}

/** Map a non-ok Response to the typed EvolveApiError and throw it. */
async function throwApiError(res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    if (body?.error && typeof body.error === "object") {
      const code = typeof body.error.code === "string" ? body.error.code : "unknown_error";
      const message =
        typeof body.error.message === "string" ? body.error.message : res.statusText;
      throw new EvolveApiError(res.status, code, message);
    }
  } catch (error) {
    if (error instanceof EvolveApiError) throw error;
    // Fall through: unparseable body.
  }
  throw new EvolveApiError(res.status, "unknown_error", text || res.statusText);
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
const TERMINAL_IMPORT_STATUSES: ReadonlySet<string> = new Set(["IMPORTED", "FAILED"]);

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
    resolvedHarnessVersion: (raw.resolvedHarnessVersion as string | null) ?? null,
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
  };
  if ("error" in raw) {
    benchmarkImport.error = (raw.error as BenchmarkImportError | null) ?? null;
  }
  if (typeof raw.taskCount === "number") {
    benchmarkImport.taskCount = raw.taskCount;
  }
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
): PromiseLike<Page<TRow>> & AsyncIterable<TRow> {
  return {
    then<TResult1 = Page<TRow>, TResult2 = never>(
      onfulfilled?: ((value: Page<TRow>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
      return fetchPage({ limit: options?.limit, cursor: options?.cursor }).then(
        onfulfilled,
        onrejected
      );
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
    [Symbol.asyncIterator](): AsyncIterator<JobEvent> {
      return gen;
    },
  };
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
      if (src?.gitUrl && src?.ref) {
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
      const hasInstallScript = typeof input.installScript === "string";
      const hasDirectory = typeof input.directory === "string";
      if (hasInstallScript && hasDirectory) {
        throw new Error(
          "customHarnesses().create() takes EITHER an install script ({ installScript }) " +
            "or a local directory ({ directory }), not both"
        );
      }
      if (!hasInstallScript && !hasDirectory) {
        throw new Error(
          "customHarnesses().create() requires either an install script ({ installScript }) " +
            "or a local directory ({ directory }), plus name and runCommand"
        );
      }
      // ONE body grammar: multipart/form-data. The run command and the declared
      // env are named PARTS — they used to ride the query string of an upload,
      // which put a shell command and a set of environment values into every
      // access log and proxy buffer on the way here.
      const fields: Record<string, string | undefined> = {
        name: input.name,
        runCommand: input.runCommand,
        ...(input.env !== undefined ? { env: JSON.stringify(input.env) } : {}),
        ...(hasInstallScript ? { installScript: input.installScript } : {}),
      };
      let body: FormData;
      if (hasDirectory) {
        const { tarGzipDirectory } = await import("./tar");
        const gzipped = tarGzipDirectory(input.directory as string);
        body = uploadForm(fields, { bytes: gzipped, filename: "source.tar.gz" });
      } else {
        body = uploadForm(fields);
      }
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

  async function exportResponse(id: string, format?: "harbor"): Promise<Response> {
    const qs = format ? `?format=${encodeURIComponent(format)}` : "";
    return request(cfg, `/api/jobs/${encodeURIComponent(id)}/export${qs}`);
  }

  function exportFilename(res: Response, id: string): string {
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    return match ? match[1] : `job-${id}-export.json.gz`;
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
        const event: JobEvent = {
          seq: Number.isInteger(seq) ? seq : -1,
          type: frame.event || "message",
          data: frame.data ? safeJsonParse(frame.data) : {},
        };
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

    async regradeJob(jobId: string, options?: RegradeJobOptions): Promise<RegradeJob> {
      const res = await request(
        cfg,
        `/api/regrades/${encodeURIComponent(jobId)}${pageQuery(options)}`
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
        const filePath = join(dir, exportFilename(res, id));
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
