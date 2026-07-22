import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { DEFAULT_DASHBOARD_URL, ENV_EVOLVE_API_KEY } from "../constants";
import type {
  AgentSystem,
  Benchmark,
  BenchmarkImport,
  BenchmarkImportInput,
  BenchmarkVersion,
  BenchmarkVersionState,
  BenchmarksClient,
  ComparisonRow,
  Evaluation,
  EvaluationEvent,
  EvaluationInput,
  EvaluationPage,
  EvaluationStatus,
  EvaluationsClient,
  ExportEvaluationOptions,
  GetBenchmarkOptions,
  HostedClientConfig,
  ListEvaluationsOptions,
  ListTaskRunsOptions,
  ModelUsage,
  RunEvaluationOptions,
  Task,
  TaskRun,
  TaskRunCounts,
  TaskRunPage,
  TaskRunStatus,
  WatchEvaluationOptions,
} from "./types";

export type {
  AgentSystem,
  Benchmark,
  BenchmarkImport,
  BenchmarkImportInput,
  BenchmarkImportSource,
  BenchmarkVersion,
  BenchmarkVersionState,
  BenchmarksClient,
  ComparisonRow,
  Evaluation,
  EvaluationEvent,
  EvaluationInput,
  EvaluationPage,
  EvaluationStatus,
  EvaluationsClient,
  ExportEvaluationOptions,
  GetBenchmarkOptions,
  HostedClientConfig,
  ListEvaluationsOptions,
  ListTaskRunsOptions,
  ModelUsage,
  OutputFile,
  RunEvaluationOptions,
  Task,
  TaskRun,
  TaskRunCounts,
  TaskRunPage,
  TaskRunStatus,
  WatchEvaluationOptions,
} from "./types";

/**
 * Thrown by reserved hosted-evals methods whose server endpoints do not exist
 * yet (compare, taskRun detail, and the import trio). The surface is reserved
 * in the public plan; the SDK never invents server routes.
 */
export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(
      `${feature} is not implemented yet: this method is reserved in the hosted evals public surface, ` +
        `but the server endpoint does not exist yet. It will activate in a future release without a signature change.`
    );
    this.name = "NotImplementedError";
  }
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

const TERMINAL_EVALUATION_STATUSES: ReadonlySet<EvaluationStatus> = new Set([
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);

// The final event row a terminal evaluation writes; seeing one on the wire is
// the authoritative end-of-stream signal.
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "evaluation.completed",
  "evaluation.cancelled",
  "evaluation.failed",
]);

// =============================================================================
// SHARED HELPERS
// =============================================================================

interface ResolvedConfig {
  apiKey: string;
  dashboardUrl: string;
}

function resolveConfig(factory: string, config?: HostedClientConfig): ResolvedConfig {
  const apiKey = config?.apiKey || process.env[ENV_EVOLVE_API_KEY];
  if (!apiKey) {
    throw new Error(
      `${factory}() requires an API key. Set ${ENV_EVOLVE_API_KEY} or pass { apiKey } in config.`
    );
  }
  const dashboardUrl = (config?.dashboardUrl || process.env.EVOLVE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, "");
  return { apiKey, dashboardUrl };
}

async function request(
  cfg: ResolvedConfig,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(`${cfg.dashboardUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dashboard API error (${res.status}): ${text || res.statusText}`);
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
  // Only the three public AgentSystem fields — internal ids/digests never leak.
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
    taskCount: (raw.taskCount as number) ?? 0,
    ...(typeof raw.createdAt === "string" ? { createdAt: raw.createdAt } : {}),
  };
}

function mapTask(raw: Record<string, unknown>): Task {
  return {
    taskKey: raw.taskKey as string,
    agentTimeoutSec: raw.agentTimeoutSec as number,
    verifierTimeoutSec: raw.verifierTimeoutSec as number,
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
    spentUsd: (raw.spentUsd as number) ?? 0,
    createdAt: raw.createdAt as string,
  };
  if (raw.counts && typeof raw.counts === "object") {
    evaluation.counts = raw.counts as Evaluation["counts"];
  }
  if (raw.taskRunCounts && typeof raw.taskRunCounts === "object") {
    evaluation.taskRunCounts = raw.taskRunCounts as TaskRunCounts;
  }
  if (typeof raw.taskRunTotal === "number") {
    evaluation.taskRunTotal = raw.taskRunTotal;
  }
  if (Array.isArray(raw.agentSystems)) {
    evaluation.agentSystems = (raw.agentSystems as Record<string, unknown>[]).map(mapAgentSystem);
  }
  if (typeof raw.benchmarkVersionState === "string") {
    evaluation.benchmarkVersionState = raw.benchmarkVersionState as BenchmarkVersionState;
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
    sessionRef: (raw.sessionRef as string | null) ?? null,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
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

  return {
    async list(): Promise<Benchmark[]> {
      const res = await request(cfg, "/api/benchmarks");
      const data = (await res.json()) as { benchmarks?: Record<string, unknown>[] };
      return (data.benchmarks || []).map((raw) => ({
        name: raw.name as string,
        displayTitle: (raw.displayTitle as string | null) ?? null,
        description: (raw.description as string | null) ?? null,
        activeVersion: raw.activeVersion
          ? mapBenchmarkVersion(raw.activeVersion as Record<string, unknown>)
          : null,
      }));
    },

    async get(ref: string, options?: GetBenchmarkOptions): Promise<Benchmark> {
      const parsed = parseBenchmarkRef(ref);
      if (
        options?.version !== undefined &&
        parsed.version !== undefined &&
        options.version !== parsed.version
      ) {
        throw new Error(
          `Conflicting versions: ref "${ref}" says "${parsed.version}" but options.version is "${options.version}"`
        );
      }
      const version = options?.version ?? parsed.version;
      const query = version !== undefined ? `?version=${encodeURIComponent(version)}` : "";
      const res = await request(
        cfg,
        `/api/benchmarks/${encodeURIComponent(parsed.name)}${query}`
      );
      const raw = (await res.json()) as Record<string, unknown>;
      const versions = ((raw.versions as Record<string, unknown>[]) || []).map(
        mapBenchmarkVersion
      );
      // The detail route names the active version; resolve it to its full
      // version object so activeVersion has one shape across list() and get().
      const activeVersionName = (raw.activeVersion as string | null) ?? null;
      const activeVersion =
        activeVersionName !== null
          ? versions.find((v) => v.version === activeVersionName) ?? null
          : null;
      return {
        name: raw.name as string,
        displayTitle: (raw.displayTitle as string | null) ?? null,
        description: (raw.description as string | null) ?? null,
        activeVersion,
        versions,
        tasksVersion: (raw.tasksVersion as string | null) ?? null,
        tasks: ((raw.tasks as Record<string, unknown>[]) || []).map(mapTask),
        createdAt: raw.createdAt as string,
        updatedAt: raw.updatedAt as string,
      };
    },

    async import(_input: BenchmarkImportInput): Promise<BenchmarkImport> {
      throw new NotImplementedError("benchmarks().import()");
    },

    async getImport(_id: string): Promise<BenchmarkImport> {
      throw new NotImplementedError("benchmarks().getImport()");
    },

    async watchImport(_id: string): Promise<BenchmarkImport> {
      throw new NotImplementedError("benchmarks().watchImport()");
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
 * const evaluation = await e.run({
 *   benchmark: "deep-swe@1.1",
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

  async function exportResponse(id: string, format?: "harbor"): Promise<Response> {
    const qs = format ? `?format=${encodeURIComponent(format)}` : "";
    return request(cfg, `/api/evaluations/${encodeURIComponent(id)}/export${qs}`);
  }

  function exportFilename(res: Response, id: string): string {
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    return match ? match[1] : `evaluation-${id}-export.json.gz`;
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

    async list(options?: ListEvaluationsOptions): Promise<EvaluationPage> {
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
    },

    async taskRuns(id: string, options?: ListTaskRunsOptions): Promise<TaskRunPage> {
      const params = new URLSearchParams();
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      if (options?.cursor) params.set("cursor", options.cursor);
      const qs = params.toString();
      const res = await request(
        cfg,
        `/api/evaluations/${encodeURIComponent(id)}/task-runs${qs ? `?${qs}` : ""}`
      );
      const data = (await res.json()) as {
        taskRuns?: Record<string, unknown>[];
        totalCount?: number;
        nextCursor?: string | null;
      };
      return {
        taskRuns: (data.taskRuns || []).map(mapTaskRun),
        totalCount: data.totalCount ?? 0,
        nextCursor: data.nextCursor ?? null,
      };
    },

    async taskRun(_runId: string): Promise<TaskRun> {
      throw new NotImplementedError("evaluations().taskRun()");
    },

    async watch(id: string, options?: WatchEvaluationOptions): Promise<Evaluation> {
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
            `${cfg.dashboardUrl}/api/evaluations/${encodeURIComponent(id)}/events`,
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
          const text = await res.text().catch(() => "");
          throw new Error(`Dashboard API error (${res.status}): ${text || res.statusText}`);
        }
        if (!res.body) {
          throw new Error("Event stream response has no body");
        }

        let receivedEvent = false;
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
          onEvent?.(event);
        });

        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        try {
          while (!terminal) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
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
        // connection loss). If the evaluation is already terminal, drain ONCE
        // more from lastSeq first: the server writes the status flip and the
        // terminal/tail events in adjacent transactions, so events past lastSeq
        // may still be undelivered — returning immediately would silently drop
        // them from onEvent. One drain reconnect delivers them; if it also
        // closes without a terminal event, finish on the status.
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
    },

    async cancel(id: string): Promise<Evaluation> {
      const res = await request(cfg, `/api/evaluations/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      });
      return mapEvaluation((await res.json()) as Record<string, unknown>);
    },

    async compare(_ids: string[]): Promise<ComparisonRow[]> {
      throw new NotImplementedError("evaluations().compare()");
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
