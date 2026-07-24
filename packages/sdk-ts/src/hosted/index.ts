import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { DEFAULT_DASHBOARD_URL, ENV_EVOLVE_API_KEY } from "../constants";
import type {
  ActiveBenchmark,
  AgentSystem,
  Benchmark,
  BenchmarkImport,
  BenchmarkImportError,
  BenchmarkImportInput,
  BenchmarkImportStatus,
  BenchmarkVersion,
  BenchmarkVersionState,
  BenchmarksClient,
  ComparisonAggregate,
  ComparisonCell,
  ComparisonCoverage,
  ComparisonTaskRow,
  CustomHarness,
  CustomHarnessesClient,
  CustomHarnessInput,
  CustomHarnessSource,
  EvalSandboxProvider,
  Evaluation,
  EvaluationComparison,
  EvaluationEvent,
  EvaluationInput,
  EvaluationList,
  EvaluationPage,
  EvaluationStatus,
  EvaluationsClient,
  EvaluationWatch,
  ExportEvaluationOptions,
  HostedClientConfig,
  ListEvaluationsOptions,
  ListTaskRunsOptions,
  ModelUsage,
  RegradeFilter,
  RegradeJob,
  RegradeJobStatus,
  RegradeOptions,
  RegradeResult,
  RegradeStatus,
  RunEvaluationOptions,
  Task,
  TaskRun,
  TaskRunCounts,
  TaskRunDetail,
  TaskRunList,
  TaskRunPage,
  TaskRunStatus,
  TaskRunTraceEvent,
  TaskRunTraceOptions,
  TaskRunTracePage,
  VerifierMode,
  WatchEvaluationOptions,
  WatchImportOptions,
} from "./types";

export type {
  ActiveBenchmark,
  AgentSystem,
  Benchmark,
  BenchmarkImport,
  BenchmarkImportError,
  BenchmarkImportInput,
  BenchmarkImportSource,
  BenchmarkImportStatus,
  BenchmarkVersion,
  BenchmarkVersionState,
  BenchmarksClient,
  ComparisonAggregate,
  ComparisonCell,
  ComparisonCoverage,
  ComparisonTaskRow,
  CustomHarness,
  CustomHarnessesClient,
  CustomHarnessInput,
  CustomHarnessSource,
  EvalSandboxProvider,
  Evaluation,
  EvaluationComparison,
  EvaluationEvent,
  EvaluationInput,
  EvaluationList,
  EvaluationPage,
  EvaluationStatus,
  EvaluationsClient,
  EvaluationWatch,
  ExportEvaluationOptions,
  HostedClientConfig,
  ListEvaluationsOptions,
  ListTaskRunsOptions,
  ModelUsage,
  RegradeFilter,
  RegradeJob,
  RegradeJobStatus,
  RegradeOptions,
  RegradeResult,
  RegradeStatus,
  RunEvaluationOptions,
  SpendSource,
  Task,
  TaskProviderVerdict,
  TaskRun,
  TaskRunCounts,
  TaskRunDetail,
  TaskRunList,
  TaskRunPage,
  TaskRunStatus,
  TaskRunTraceEvent,
  TaskRunTraceOptions,
  TaskRunTracePage,
  VerifierMode,
  WatchEvaluationOptions,
  WatchImportOptions,
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

const TERMINAL_EVALUATION_STATUSES: ReadonlySet<EvaluationStatus> = new Set([
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);

// Seeing one of these on the wire is the authoritative end-of-stream signal.
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "evaluation.completed",
  "evaluation.cancelled",
  "evaluation.failed",
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

function mapAgentSystem(raw: Record<string, unknown>): AgentSystem {
  // Map only the public AgentSystem fields.
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

function mapEvaluation(raw: Record<string, unknown>): Evaluation {
  const evaluation: Evaluation = {
    id: raw.id as string,
    status: raw.status as EvaluationStatus,
    benchmark: raw.benchmark as string,
    runsPerTask: raw.runsPerTask as number,
    concurrency: raw.concurrency as number,
    maxModelSpendUsd: raw.maxModelSpendUsd as number,
    sandboxProvider: raw.sandboxProvider as EvalSandboxProvider,
    spentUsd: (raw.spentUsd as number) ?? 0,
    createdAt: raw.createdAt as string,
    counts: raw.counts as Evaluation["counts"],
  };
  if (typeof raw.maxModelSpendUsdPerTaskRun === "number") {
    evaluation.maxModelSpendUsdPerTaskRun = raw.maxModelSpendUsdPerTaskRun;
  }
  if (raw.taskRunCounts && typeof raw.taskRunCounts === "object") {
    evaluation.taskRunCounts = raw.taskRunCounts as TaskRunCounts;
  }
  if ("meanScore" in raw) {
    evaluation.meanScore = (raw.meanScore as number | null) ?? null;
  }
  if (Array.isArray(raw.agentSystems)) {
    evaluation.agentSystems = (raw.agentSystems as Record<string, unknown>[]).map(mapAgentSystem);
  }
  if ("error" in raw) {
    evaluation.error = (raw.error as string | null) ?? null;
  }
  if (typeof raw.updatedAt === "string") {
    evaluation.updatedAt = raw.updatedAt;
  }
  if (typeof raw.sourceEvaluationId === "string") {
    evaluation.sourceEvaluationId = raw.sourceEvaluationId;
  }
  if (raw.idempotentReplay === true) {
    evaluation.idempotentReplay = true;
  }
  return evaluation;
}

function mapTaskRun(raw: Record<string, unknown>): TaskRun {
  return {
    id: raw.id as string,
    taskKey: raw.taskKey as string,
    agentSystem: mapAgentSystem((raw.agentSystem as Record<string, unknown>) || {}),
    runNumber: raw.runNumber as number,
    status: raw.status as TaskRunStatus,
    score: (raw.score as number | null) ?? null,
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
    sourceTaskRunId: raw.sourceTaskRunId as string,
    taskKey: raw.taskKey as string,
    status: raw.status as RegradeStatus,
    score: (raw.score as number | null) ?? null,
    metrics: (raw.metrics as Record<string, number> | null) ?? null,
    sourceScore: (raw.sourceScore as number | null) ?? null,
    sourceStatus: raw.sourceStatus as string,
    scoreDelta: (raw.scoreDelta as number | null) ?? null,
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
  const counts = (raw.counts as Record<string, unknown>) ?? {};
  const job: RegradeJob = {
    id: raw.id as string,
    sourceEvaluationId: raw.sourceEvaluationId as string,
    status: raw.status as RegradeJobStatus,
    sandboxProvider: raw.sandboxProvider as EvalSandboxProvider,
    filter: (raw.filter as RegradeJob["filter"]) ?? null,
    counts: {
      results: (counts.results as number) ?? 0,
      byStatus: (counts.byStatus as RegradeJob["counts"]["byStatus"]) ?? {},
    },
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
  if (Array.isArray(raw.results)) {
    job.results = (raw.results as Record<string, unknown>[]).map(mapRegradeResult);
  }
  return job;
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
    status: raw.status as EvaluationStatus,
    meanScore: (raw.meanScore as number | null) ?? null,
    coverage: mapCoverage(raw.coverage),
    spentUsd: (raw.spentUsd as number) ?? 0,
    // Public AgentSystem fields only.
    agentSystems: ((raw.agentSystems as Record<string, unknown>[]) || []).map(mapAgentSystem),
    createdAt: raw.createdAt as string,
  };
}

function mapComparisonCell(raw: Record<string, unknown>): ComparisonCell {
  return {
    evaluationId: raw.evaluationId as string,
    status: raw.status as ComparisonCell["status"],
    meanScore: (raw.meanScore as number | null) ?? null,
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

function mapTraceEvent(raw: Record<string, unknown>): TaskRunTraceEvent {
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
function makePaginated<TRow, TPage extends { nextCursor: string | null }>(
  fetchPage: (opts: { limit?: number; cursor?: string }) => Promise<TPage>,
  rowsOf: (page: TPage) => TRow[],
  options?: { limit?: number; cursor?: string }
): PromiseLike<TPage> & AsyncIterable<TRow> {
  return {
    then<TResult1 = TPage, TResult2 = never>(
      onfulfilled?: ((value: TPage) => TResult1 | PromiseLike<TResult1>) | null,
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
        for (const row of rowsOf(page)) yield row;
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
      }
    },
  };
}

/**
 * Wrap a watch event generator as a value that is both awaitable (resolves the
 * final Evaluation) and async-iterable (yields each event). Both forms drive
 * the same generator, so a single handle is meant for one form or the other.
 */
function makeWatch(
  gen: AsyncGenerator<EvaluationEvent, Evaluation>
): EvaluationWatch {
  let drained: Promise<Evaluation> | undefined;
  const drain = (): Promise<Evaluation> => {
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
    then<TResult1 = Evaluation, TResult2 = never>(
      onfulfilled?: ((value: Evaluation) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
      return drain().then(onfulfilled, onrejected);
    },
    [Symbol.asyncIterator](): AsyncIterator<EvaluationEvent> {
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

  async function getBenchmark(ref: string): Promise<Benchmark> {
    const parsed = parseBenchmarkRef(ref);
    const query =
      parsed.version !== undefined ? `?version=${encodeURIComponent(parsed.version)}` : "";
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
      tasks: ((raw.tasks as Record<string, unknown>[]) || []).map(mapTask),
      createdAt: raw.createdAt as string,
      updatedAt: raw.updatedAt as string,
    };
  }

  return {
    async list(): Promise<Benchmark[]> {
      const res = await request(cfg, "/api/benchmarks");
      const data = (await res.json()) as { benchmarks?: Record<string, unknown>[] };
      return (data.benchmarks || []).map((raw) => ({
        name: raw.name as string,
        title: (raw.title as string | null) ?? null,
        description: (raw.description as string | null) ?? null,
        activeVersion: raw.activeVersion
          ? mapBenchmarkVersion(raw.activeVersion as Record<string, unknown>)
          : null,
      }));
    },

    get: getBenchmark,

    async getActive(name: string): Promise<ActiveBenchmark> {
      // get(name) with a bare name resolves the active version's task list; the
      // detail route echoes the active version so we can hard-require it here.
      const bench = await getBenchmark(name);
      if (bench.activeVersion === null) {
        throw new NoActiveVersionError(name);
      }
      return {
        name: bench.name,
        title: bench.title,
        description: bench.description,
        activeVersion: bench.activeVersion,
        version: bench.activeVersion.version,
        tasks: bench.tasks ?? [],
        versions: bench.versions ?? [],
        createdAt: bench.createdAt as string,
        updatedAt: bench.updatedAt as string,
      };
    },

    async import(input: BenchmarkImportInput): Promise<BenchmarkImport> {
      const src = input.source;
      // Directory import: deterministically tar+gzip the corpus and upload it
      // (the body IS the tarball, so benchmarkName/version ride the query string).
      if (src?.directory) {
        const { tarGzipDirectory } = await import("./tar");
        const gzipped = tarGzipDirectory(src.directory);
        const query = new URLSearchParams({
          benchmarkName: input.benchmarkName,
          version: input.version,
        }).toString();
        const res = await request(cfg, `/api/benchmarks/imports?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/gzip" },
          body: gzipped as unknown as BodyInit,
        });
        return mapBenchmarkImport((await res.json()) as Record<string, unknown>);
      }
      // Git import: JSON body with the pinned source.
      if (src?.gitUrl && src?.ref) {
        const res = await request(cfg, "/api/benchmarks/imports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: { type: "git", url: src.gitUrl, ref: src.ref },
            benchmarkName: input.benchmarkName,
            version: input.version,
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
 * Register a harness once, then name it in `agentSystems[].harness` exactly
 * like a built-in. Requires EVOLVE_API_KEY (or { apiKey } in config).
 *
 * @example
 * ```ts
 * import { customHarnesses, evaluations } from "@evolvingmachines/sdk";
 *
 * const harnesses = customHarnesses();
 * await harnesses.create({
 *   name: "acme-cli",
 *   installScript: "curl -fsSL https://acme.dev/install.sh | sh",
 *   runCommand: "acme-cli --headless",
 * });
 *
 * await evaluations().run({
 *   benchmark: "deep-swe",
 *   agentSystems: [{ harness: "acme-cli", model: "gpt-5.5" }],
 *   maxModelSpendUsd: 25,
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
      // Tarball source: deterministically tar+gzip the directory and upload it
      // (the body IS the tarball, so the metadata rides the query string —
      // repeated `env` pairs, exactly like the benchmark archive-import lane).
      if (hasDirectory) {
        const { tarGzipDirectory } = await import("./tar");
        const gzipped = tarGzipDirectory(input.directory as string);
        const params = new URLSearchParams({
          name: input.name,
          runCommand: input.runCommand,
        });
        for (const [key, value] of Object.entries(input.env ?? {})) {
          params.append("env", `${key}=${value}`);
        }
        const res = await request(cfg, `/api/custom-harnesses?${params.toString()}`, {
          method: "POST",
          headers: { "Content-Type": "application/gzip" },
          body: gzipped as unknown as BodyInit,
        });
        return mapCustomHarness((await res.json()) as Record<string, unknown>);
      }
      // Install-script source: JSON body.
      if (hasInstallScript) {
        const res = await request(cfg, "/api/custom-harnesses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: input.name,
            installScript: input.installScript,
            runCommand: input.runCommand,
            ...(input.env !== undefined ? { env: input.env } : {}),
          }),
        });
        return mapCustomHarness((await res.json()) as Record<string, unknown>);
      }
      throw new Error(
        "customHarnesses().create() requires either an install script ({ installScript }) " +
          "or a local directory ({ directory }), plus name and runCommand"
      );
    },

    async list(): Promise<CustomHarness[]> {
      const res = await request(cfg, "/api/custom-harnesses");
      const data = (await res.json()) as { customHarnesses?: Record<string, unknown>[] };
      return (data.customHarnesses || []).map(mapCustomHarness);
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
// EVALUATIONS CLIENT
// =============================================================================

/**
 * Create an EvaluationsClient for hosted evaluations.
 *
 * Requires EVOLVE_API_KEY (or { apiKey } in config).
 *
 * @example
 * ```ts
 * import { evaluations } from "@evolvingmachines/sdk";
 *
 * const e = evaluations();
 * // benchmark: bare name = active version; "name@version" pins a version
 * const evaluation = await e.run({
 *   benchmark: "deep-swe",
 *   agentSystems: [{ harness: "codex", model: "gpt-5.5" }],
 *   runsPerTask: 1,
 *   concurrency: 4,
 *   maxModelSpendUsd: 25,
 * });
 * const final = await e.watch(evaluation.id, {
 *   onEvent: (event) => console.log(event.type, event.data),
 * });
 * ```
 */
export function evaluations(config?: HostedClientConfig): EvaluationsClient {
  const cfg = resolveConfig("evaluations", config);

  async function getEvaluation(id: string): Promise<Evaluation> {
    const res = await request(cfg, `/api/evaluations/${encodeURIComponent(id)}`);
    return mapEvaluation((await res.json()) as Record<string, unknown>);
  }

  async function listPage(options?: ListEvaluationsOptions): Promise<EvaluationPage> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    const res = await request(cfg, `/api/evaluations${qs ? `?${qs}` : ""}`);
    const data = (await res.json()) as {
      evaluations?: Record<string, unknown>[];
      nextCursor?: string | null;
    };
    return {
      evaluations: (data.evaluations || []).map(mapEvaluation),
      nextCursor: data.nextCursor ?? null,
    };
  }

  async function taskRunsPage(
    id: string,
    options?: ListTaskRunsOptions
  ): Promise<TaskRunPage> {
    const params = new URLSearchParams();
    if (options?.status?.length) params.set("status", options.status.join(","));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    const res = await request(
      cfg,
      `/api/evaluations/${encodeURIComponent(id)}/task-runs${qs ? `?${qs}` : ""}`
    );
    const data = (await res.json()) as {
      taskRuns?: Record<string, unknown>[];
      nextCursor?: string | null;
    };
    return {
      taskRuns: (data.taskRuns || []).map(mapTaskRun),
      nextCursor: data.nextCursor ?? null,
    };
  }

  async function getTaskRunTrace(
    id: string,
    runId: string,
    options?: TaskRunTraceOptions
  ): Promise<TaskRunTracePage> {
    const params = new URLSearchParams();
    if (options?.after !== undefined) params.set("after", String(options.after));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    const res = await request(
      cfg,
      `/api/evaluations/${encodeURIComponent(id)}/task-runs/${encodeURIComponent(runId)}/trace${qs ? `?${qs}` : ""}`
    );
    const data = (await res.json()) as {
      events?: Record<string, unknown>[];
      nextAfter?: number | null;
    };
    return {
      events: (data.events || []).map(mapTraceEvent),
      nextAfter: data.nextAfter ?? null,
    };
  }

  async function exportResponse(id: string, format?: "harbor"): Promise<Response> {
    const qs = format ? `?format=${encodeURIComponent(format)}` : "";
    return request(cfg, `/api/evaluations/${encodeURIComponent(id)}/export${qs}`);
  }

  function exportFilename(res: Response, id: string): string {
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    return match ? match[1] : `evaluation-${id}-export.json.gz`;
  }

  /**
   * Drive the SSE watch stream, yielding each event and returning the final
   * Evaluation. Same reconnect / Last-Event-ID / terminal-drain semantics as
   * before; onEvent (when supplied) fires alongside every yield so the callback
   * form keeps working. makeWatch() wraps this as the dual-use watch handle.
   */
  async function* watchEvents(
    id: string,
    options?: WatchEvaluationOptions
  ): AsyncGenerator<EvaluationEvent, Evaluation> {
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
          `${cfg.baseUrl}/api/evaluations/${encodeURIComponent(id)}/events`,
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
      const pending: EvaluationEvent[] = [];
      const parser = createSseParser((frame) => {
        const seq = Number(frame.id);
        const event: EvaluationEvent = {
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
      const current = await getEvaluation(id);
      if (TERMINAL_EVALUATION_STATUSES.has(current.status)) {
        if (finalDrainDone) return current;
        finalDrainDone = true;
        continue;
      }
      if (receivedEvent) delayMs = initialDelayMs;
      await sleep(delayMs, signal);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }

    return getEvaluation(id);
  }

  return {
    async run(input: EvaluationInput, options?: RunEvaluationOptions): Promise<Evaluation> {
      const res = await request(cfg, "/api/evaluations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options?.idempotencyKey
            ? { "Idempotency-Key": options.idempotencyKey }
            : {}),
        },
        body: JSON.stringify(input),
      });
      return mapEvaluation((await res.json()) as Record<string, unknown>);
    },

    get: getEvaluation,

    list(options?: ListEvaluationsOptions): EvaluationList {
      // Await for one page (honoring options); for-await to walk every
      // evaluation across cursor pages.
      return makePaginated(listPage, (page) => page.evaluations, options);
    },

    taskRuns(id: string, options?: ListTaskRunsOptions): TaskRunList {
      // Await for one page; for-await to walk every task run across cursors.
      // The status filter rides along on every page fetch.
      return makePaginated(
        (opts) => taskRunsPage(id, { ...opts, status: options?.status }),
        (page) => page.taskRuns,
        options
      );
    },

    async taskRun(id: string, runId: string): Promise<TaskRunDetail> {
      const res = await request(
        cfg,
        `/api/evaluations/${encodeURIComponent(id)}/task-runs/${encodeURIComponent(runId)}`
      );
      const raw = (await res.json()) as Record<string, unknown>;
      return {
        ...mapTaskRun(raw),
        evaluationId: raw.evaluationId as string,
      };
    },

    taskRunTrace: getTaskRunTrace,

    async *taskRunTraceEvents(
      id: string,
      runId: string,
      options?: TaskRunTraceOptions
    ): AsyncIterableIterator<TaskRunTraceEvent> {
      let after = options?.after;
      for (;;) {
        const page = await getTaskRunTrace(id, runId, { after, limit: options?.limit });
        for (const event of page.events) yield event;
        // Drained the currently available trace: an empty page, or a short
        // page when the caller pinned an explicit page size.
        if (page.events.length === 0) return;
        if (options?.limit !== undefined && page.events.length < options.limit) return;
        if (page.nextAfter === null) return;
        after = page.nextAfter;
      }
    },

    watch(id: string, options?: WatchEvaluationOptions): EvaluationWatch {
      // Dual-use handle: await it for the final Evaluation, or `for await` its
      // events. onEvent (when given) fires from the generator in both forms.
      return makeWatch(watchEvents(id, options));
    },

    async cancel(id: string): Promise<Evaluation> {
      const res = await request(cfg, `/api/evaluations/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      });
      return mapEvaluation((await res.json()) as Record<string, unknown>);
    },

    async compare(ids: string[]): Promise<EvaluationComparison> {
      const query = ids.map(encodeURIComponent).join(",");
      const res = await request(cfg, `/api/evaluations/compare?ids=${query}`);
      const data = (await res.json()) as {
        evaluations?: Record<string, unknown>[];
        taskMatrix?: Record<string, unknown>[];
      };
      return {
        evaluations: (data.evaluations || []).map(mapComparisonAggregate),
        taskMatrix: (data.taskMatrix || []).map(mapComparisonTaskRow),
      };
    },

    async rerunFailed(id: string, options?: RunEvaluationOptions): Promise<Evaluation> {
      const res = await request(
        cfg,
        `/api/evaluations/${encodeURIComponent(id)}/rerun-failed`,
        {
          method: "POST",
          headers: options?.idempotencyKey
            ? { "Idempotency-Key": options.idempotencyKey }
            : undefined,
        }
      );
      return mapEvaluation((await res.json()) as Record<string, unknown>);
    },

    async regrade(id: string, options?: RegradeOptions): Promise<RegradeJob> {
      const body: Record<string, unknown> = {};
      if (options?.status?.length) body.status = options.status;
      if (options?.taskKey !== undefined) body.taskKey = options.taskKey;
      const res = await request(cfg, `/api/evaluations/${encodeURIComponent(id)}/regrade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return mapRegradeJob((await res.json()) as Record<string, unknown>);
    },

    async regradeTaskRun(id: string, runId: string): Promise<RegradeJob> {
      const res = await request(
        cfg,
        `/api/evaluations/${encodeURIComponent(id)}/task-runs/${encodeURIComponent(runId)}/regrade`,
        { method: "POST" }
      );
      return mapRegradeJob((await res.json()) as Record<string, unknown>);
    },

    async regradeJob(jobId: string): Promise<RegradeJob> {
      const res = await request(cfg, `/api/regrades/${encodeURIComponent(jobId)}`);
      return mapRegradeJob((await res.json()) as Record<string, unknown>);
    },

    export: (async (
      id: string,
      options?: ExportEvaluationOptions
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
    }) as EvaluationsClient["export"],
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
