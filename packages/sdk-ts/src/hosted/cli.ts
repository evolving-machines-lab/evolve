#!/usr/bin/env node
/**
 * evolve-evals — CLI for Evolve hosted benchmarks & evaluations.
 *
 * Thin shell over the hosted client (benchmarks() / evaluations()): plain node
 * arg parsing, no dependencies. Human-readable tables by default; --json emits
 * machine-readable JSON (NDJSON for --watch event streams).
 *
 * Exit codes: 0 success (watch: evaluation COMPLETED / import READY), 1
 * runtime/API failure (watch: FAILED or CANCELLED), 2 usage error.
 */

import { pathToFileURL } from "url";
import { benchmarks, evaluations } from "./index";
import type {
  AgentSystem,
  Benchmark,
  BenchmarkImport,
  BenchmarkImportInput,
  EvalSandboxProvider,
  Evaluation,
  EvaluationComparison,
  EvaluationEvent,
  EvaluationInput,
  HostedClientConfig,
  RegradeJob,
  RegradeResult,
  Task,
  TaskRun,
  TaskRunDetail,
  TaskRunStatus,
  TaskRunTraceEvent,
} from "./types";

// =============================================================================
// USAGE
// =============================================================================

export const USAGE = `evolve-evals — Evolve hosted evaluations CLI

Usage: evolve-evals <command> [options]

Commands:
  run                               Create an evaluation (add --watch to follow it)
  list                              List your evaluations (newest first)
  get <id>                          Show one evaluation
  task-runs <id>                    List an evaluation's task runs
  task-run <id> <run-id>            Show one task run in full detail
  trace <id> <run-id>               Print a task run's trace events
  compare <id> <id> [...]           Compare 2-5 evaluations side by side
  cancel <id>                       Request cancellation of an evaluation
  rerun-failed <id>                 New evaluation from a terminal evaluation's failed runs
  regrade <id> [run-id]             Re-run the verifier on recorded runs (whole eval, or one run)
  regrade-job <job-id>              Show a regrade job's results (scores, deltas, lineage)
  export <id>                       Download the research archive (gzipped JSON)
  benchmarks                        List the benchmark catalog
  benchmarks get <name[@version]>   Show one benchmark (versions + tasks + providers)
  import                            Import a benchmark from a git source or a local directory (--watch to follow)
  import status <id>                Show one import job
  help                              Show this help

Run options:
  --benchmark <name[@version]>        Benchmark (required; bare name = active version)
  --tasks <k1,k2,...>                 Task keys (default: every task of the version)
  --system <harness:model[:version]>  Agent system; repeatable (at least one required)
  --runs <n>                          Runs per task x system (default 1)
  --concurrency <n>                   Parallel task runs (default 1)
  --max-spend <usd>                   Evaluation-wide model-spend cap (required)
  --max-spend-per-run <usd>           Per-task-run model-spend cap
  --provider <e2b|daytona|modal>      e2b | daytona | modal, default e2b
  --watch                             Stream events until the evaluation finishes

Task-run options:
  --status <s1,s2,...>                Filter task-runs by status (e.g. INFRASTRUCTURE_ERROR)

Regrade options (whole-evaluation regrade only):
  --status <s1,s2,...>                Only regrade source runs in these statuses
  --task <key>                        Only regrade source runs of this task

Trace options:
  --after <seq>                       Resume after this trace seq
  --limit <n>                         Max events per page

Import options (a git source OR a local directory; --name and --version required):
  --git <url>                         Git repository URL (with --ref)
  --ref <ref>                         Git ref: branch, tag, or commit (with --git)
  --dir <path>                        Local corpus directory (tarred + uploaded)
  --name <benchmark>                  Catalog benchmark name to create or extend (required)
  --version <v>                       Version label for the imported version (required)
  --watch                             Poll until the import is IMPORTED or FAILED

Other options:
  --limit <n>, --cursor <c>           Pagination (list, task-runs)
  --to <dir>                          Export target directory (default: current dir)
  --format harbor                     Export the Harbor job-layout bundle
  --json                              Machine-readable JSON output
  --api-key <key>                     API key (default: $EVOLVE_API_KEY)
  --base-url <url>                    API base URL (default: the Evolve dashboard API)`;

// =============================================================================
// ARG PARSING
// =============================================================================

/** Usage-level error: bad command line, not a runtime failure. Exit code 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

type FlagKind = "string" | "number" | "boolean" | "repeat";

export interface Invocation {
  command: string;
  positionals: string[];
  flags: Record<string, string | number | boolean | string[]>;
}

const GLOBAL_FLAGS: Record<string, FlagKind> = {
  json: "boolean",
  "api-key": "string",
  "base-url": "string",
};

interface CommandSpec {
  flags: Record<string, FlagKind>;
  required?: string[];
  minPositionals: number;
  maxPositionals: number;
  /** Names the positionals in error messages, e.g. "<id>" */
  positionalUsage?: string;
}

const COMMAND_SPECS: Record<string, CommandSpec> = {
  run: {
    flags: {
      benchmark: "string",
      tasks: "string",
      system: "repeat",
      runs: "number",
      concurrency: "number",
      "max-spend": "number",
      "max-spend-per-run": "number",
      provider: "string",
      watch: "boolean",
    },
    required: ["benchmark", "system", "max-spend"],
    minPositionals: 0,
    maxPositionals: 0,
  },
  list: {
    flags: { limit: "number", cursor: "string" },
    minPositionals: 0,
    maxPositionals: 0,
  },
  get: { flags: {}, minPositionals: 1, maxPositionals: 1, positionalUsage: "<id>" },
  "task-runs": {
    flags: { status: "string", limit: "number", cursor: "string" },
    minPositionals: 1,
    maxPositionals: 1,
    positionalUsage: "<id>",
  },
  "task-run": {
    flags: {},
    minPositionals: 2,
    maxPositionals: 2,
    positionalUsage: "<id> <run-id>",
  },
  trace: {
    flags: { after: "number", limit: "number" },
    minPositionals: 2,
    maxPositionals: 2,
    positionalUsage: "<id> <run-id>",
  },
  compare: {
    flags: {},
    minPositionals: 2,
    maxPositionals: 5,
    positionalUsage: "<id> <id> [...]",
  },
  cancel: { flags: {}, minPositionals: 1, maxPositionals: 1, positionalUsage: "<id>" },
  "rerun-failed": {
    flags: {},
    minPositionals: 1,
    maxPositionals: 1,
    positionalUsage: "<id>",
  },
  regrade: {
    flags: { status: "string", task: "string" },
    minPositionals: 1,
    maxPositionals: 2,
    positionalUsage: "<id> [run-id]",
  },
  "regrade-job": {
    flags: {},
    minPositionals: 1,
    maxPositionals: 1,
    positionalUsage: "<job-id>",
  },
  export: {
    flags: { to: "string", format: "string" },
    minPositionals: 1,
    maxPositionals: 1,
    positionalUsage: "<id>",
  },
  // "benchmarks" lists; "benchmarks get <ref>" shows detail (validated in the handler)
  benchmarks: { flags: {}, minPositionals: 0, maxPositionals: 2 },
  // "import" creates a job (required flags validated in the handler, since
  // "import status <id>" takes none); "import status <id>" shows one job.
  import: {
    flags: {
      git: "string",
      ref: "string",
      dir: "string",
      name: "string",
      version: "string",
      watch: "boolean",
    },
    minPositionals: 0,
    maxPositionals: 2,
  },
  help: { flags: {}, minPositionals: 0, maxPositionals: 0 },
};

const HELP_INVOCATION: Invocation = { command: "help", positionals: [], flags: {} };

export function parseArgs(argv: string[]): Invocation {
  if (argv.length === 0) {
    throw new CliUsageError("No command given");
  }
  if (argv[0] === "--help" || argv[0] === "-h") return HELP_INVOCATION;

  const command = argv[0];
  const spec = COMMAND_SPECS[command];
  if (!spec) {
    throw new CliUsageError(`Unknown command "${command}"`);
  }

  const flags: Invocation["flags"] = {};
  const positionals: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") return HELP_INVOCATION;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    let name = token.slice(2);
    let inlineValue: string | undefined;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    const kind = spec.flags[name] ?? GLOBAL_FLAGS[name];
    if (!kind) {
      throw new CliUsageError(`Unknown option --${name} for "${command}"`);
    }

    if (kind === "boolean") {
      if (inlineValue !== undefined) {
        throw new CliUsageError(`Option --${name} takes no value`);
      }
      flags[name] = true;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliUsageError(`Option --${name} requires a value`);
      }
      value = next;
      i++;
    }

    if (kind === "number") {
      const num = Number(value);
      if (value.trim() === "" || !Number.isFinite(num)) {
        throw new CliUsageError(`Option --${name} expects a number, got "${value}"`);
      }
      flags[name] = num;
    } else if (kind === "repeat") {
      const existing = (flags[name] as string[] | undefined) ?? [];
      existing.push(value);
      flags[name] = existing;
    } else {
      flags[name] = value;
    }
  }

  if (positionals.length < spec.minPositionals) {
    throw new CliUsageError(
      `"${command}" requires ${spec.positionalUsage ?? `${spec.minPositionals} argument(s)`}`
    );
  }
  if (positionals.length > spec.maxPositionals) {
    throw new CliUsageError(`"${command}" got unexpected argument "${positionals[spec.maxPositionals]}"`);
  }
  for (const req of spec.required ?? []) {
    if (!(req in flags)) {
      throw new CliUsageError(`"${command}" requires --${req}`);
    }
  }

  return { command, positionals, flags };
}

/** Parse "harness:model[:version]" (version may itself contain colons). */
export function parseAgentSystem(spec: string): AgentSystem {
  const first = spec.indexOf(":");
  if (first <= 0 || first === spec.length - 1) {
    throw new CliUsageError(`Invalid --system "${spec}": expected harness:model[:version]`);
  }
  const harness = spec.slice(0, first);
  const rest = spec.slice(first + 1);
  const second = rest.indexOf(":");
  if (second === -1) return { harness, model: rest };
  const model = rest.slice(0, second);
  const version = rest.slice(second + 1);
  if (!model || !version) {
    throw new CliUsageError(`Invalid --system "${spec}": expected harness:model[:version]`);
  }
  return { harness, model, harnessVersion: version };
}

/**
 * Build the POST /api/evaluations body from a parsed `run` invocation.
 * Keys follow the contract field order: benchmark, tasks, agentSystems,
 * runsPerTask, concurrency, maxModelSpendUsd, maxModelSpendUsdPerTaskRun,
 * sandboxProvider.
 */
export function buildEvaluationInput(inv: Invocation): EvaluationInput {
  const f = inv.flags;
  let tasks: string[] | undefined;
  if (f.tasks !== undefined) {
    tasks = String(f.tasks)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tasks.length === 0) {
      throw new CliUsageError("--tasks got an empty task list");
    }
  }
  return {
    benchmark: f.benchmark as string,
    ...(tasks !== undefined ? { tasks } : {}),
    agentSystems: (f.system as string[]).map(parseAgentSystem),
    ...(f.runs !== undefined ? { runsPerTask: f.runs as number } : {}),
    ...(f.concurrency !== undefined ? { concurrency: f.concurrency as number } : {}),
    maxModelSpendUsd: f["max-spend"] as number,
    ...(f["max-spend-per-run"] !== undefined
      ? { maxModelSpendUsdPerTaskRun: f["max-spend-per-run"] as number }
      : {}),
    ...(f.provider !== undefined
      ? { sandboxProvider: f.provider as EvaluationInput["sandboxProvider"] }
      : {}),
  };
}

/** Build the benchmarks().import() input from a parsed `import` invocation. */
export function buildImportInput(inv: Invocation): BenchmarkImportInput {
  const f = inv.flags;
  const hasDir = typeof f.dir === "string";
  const hasGit = typeof f.git === "string" || typeof f.ref === "string";
  if (hasDir && hasGit) {
    throw new CliUsageError('"import" takes EITHER --dir OR --git/--ref, not both');
  }
  if (hasDir) {
    for (const req of ["name", "version"] as const) {
      if (typeof f[req] !== "string") {
        throw new CliUsageError(`"import" requires --${req}`);
      }
    }
    return {
      source: { directory: f.dir as string },
      benchmarkName: f.name as string,
      version: f.version as string,
    };
  }
  // Git source (the default when no --dir). Original required-flag order —
  // git, ref, name, version — with --dir offered as the source alternative.
  for (const req of ["git", "ref", "name", "version"] as const) {
    if (typeof f[req] !== "string") {
      const suffix = req === "git" || req === "ref" ? " (or --dir for a local corpus directory)" : "";
      throw new CliUsageError(`"import" requires --${req}${suffix}`);
    }
  }
  return {
    source: { gitUrl: f.git as string, ref: f.ref as string },
    benchmarkName: f.name as string,
    version: f.version as string,
  };
}

// =============================================================================
// OUTPUT FORMATTING
// =============================================================================

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
};

function table(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
}

function fmtUsd(value: number | undefined | null): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "-";
}

function fmtSystem(system: AgentSystem): string {
  const base = `${system.harness}:${system.model}`;
  return system.harnessVersion ? `${base}:${system.harnessVersion}` : base;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function evaluationLines(e: Evaluation): string[] {
  // Row order mirrors the input contract: benchmark, systems, size, runs/task,
  // concurrency, spend caps.
  const rows: string[][] = [
    ["id", e.id],
    ["status", e.status],
    ["benchmark", e.benchmark],
  ];
  if (e.agentSystems) {
    rows.push(["systems", e.agentSystems.map(fmtSystem).join(", ")]);
  }
  if (e.counts) {
    rows.push([
      "size",
      `${e.counts.agentSystems} system(s) x ${e.counts.tasks} task(s) = ${e.counts.taskRuns} task run(s)`,
    ]);
  }
  rows.push(["runs/task", String(e.runsPerTask)]);
  rows.push(["concurrency", String(e.concurrency)]);
  rows.push(["max spend", fmtUsd(e.maxModelSpendUsd)]);
  if (e.maxModelSpendUsdPerTaskRun !== undefined) {
    rows.push(["max spend/run", fmtUsd(e.maxModelSpendUsdPerTaskRun)]);
  }
  rows.push(["provider", e.sandboxProvider]);
  rows.push(["spent", fmtUsd(e.spentUsd)]);
  if (e.meanScore !== undefined) {
    rows.push(["mean score", e.meanScore !== null ? String(e.meanScore) : "-"]);
  }
  if (e.taskRunCounts && Object.keys(e.taskRunCounts).length > 0) {
    const histogram = Object.entries(e.taskRunCounts)
      .map(([status, count]) => `${status} ${count}`)
      .join(" · ");
    rows.push(["task runs", histogram]);
  }
  if (e.sourceEvaluationId) rows.push(["rerun of", e.sourceEvaluationId]);
  if (e.idempotentReplay) rows.push(["note", "idempotent replay of an existing evaluation"]);
  if (e.error) rows.push(["error", e.error]);
  rows.push(["created", e.createdAt]);
  if (e.updatedAt) rows.push(["updated", e.updatedAt]);
  return table(rows);
}

function evaluationRow(e: Evaluation): string[] {
  return [
    e.id,
    e.status,
    e.benchmark,
    e.counts ? String(e.counts.taskRuns) : "-",
    fmtScore(e.meanScore ?? null),
    fmtUsd(e.spentUsd),
    e.createdAt,
  ];
}

function taskRunRow(run: TaskRun): string[] {
  return [
    run.taskKey,
    fmtSystem(run.agentSystem),
    String(run.runNumber),
    run.status,
    run.score !== null ? String(run.score) : "-",
    fmtUsd(run.modelUsage?.spentUsd ?? null),
    run.id,
  ];
}

/** Full-detail rendering of one task run — evolve-evals task-run. */
function taskRunDetailLines(run: TaskRunDetail): string[] {
  const rows: string[][] = [
    ["run id", run.id],
    ["evaluation", run.evaluationId],
    ["task", run.taskKey],
    ["system", fmtSystem(run.agentSystem)],
    ["run", String(run.runNumber)],
    ["status", run.status],
    ["score", run.score !== null ? String(run.score) : "-"],
  ];
  if (run.metrics && Object.keys(run.metrics).length > 0) {
    rows.push([
      "metrics",
      Object.entries(run.metrics)
        .map(([key, value]) => `${key}=${value}`)
        .join(" · "),
    ]);
  }
  rows.push(["spent", fmtUsd(run.modelUsage?.spentUsd ?? null)]);
  if (run.sandboxProvider) rows.push(["provider", run.sandboxProvider]);
  if (run.verifierMode) rows.push(["verifier", run.verifierMode]);
  if (run.resolvedHarnessVersion) rows.push(["harness version", run.resolvedHarnessVersion]);
  if (run.phaseTimingsMs && Object.keys(run.phaseTimingsMs).length > 0) {
    rows.push([
      "timings",
      Object.entries(run.phaseTimingsMs)
        .map(([key, value]) => `${key}=${value}ms`)
        .join(" · "),
    ]);
  }
  if (run.failurePhase) rows.push(["failure phase", run.failurePhase]);
  if (run.failureDetail) rows.push(["failure detail", run.failureDetail]);
  if (run.sessionRef) rows.push(["session", run.sessionRef]);
  rows.push(["created", run.createdAt]);
  rows.push(["updated", run.updatedAt]);
  return table(rows);
}

function fmtDelta(delta: number | null): string {
  if (delta === null) return "-";
  const rounded = Math.round(delta * 1000) / 1000;
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function regradeResultRow(result: RegradeResult): string[] {
  return [
    result.taskKey,
    result.status,
    fmtScore(result.sourceScore),
    fmtScore(result.score),
    fmtDelta(result.scoreDelta),
    result.sourceTaskRunId,
  ];
}

/** Job envelope + per-run results — evolve-evals regrade / regrade-job. */
function regradeJobLines(job: RegradeJob): string[] {
  const rows: string[][] = [
    ["job id", job.id],
    ["status", job.status],
    ["source evaluation", job.sourceEvaluationId],
    ["provider", job.sandboxProvider],
    ["results", String(job.counts.results)],
  ];
  if (job.counts.byStatus && Object.keys(job.counts.byStatus).length > 0) {
    rows.push([
      "by status",
      Object.entries(job.counts.byStatus)
        .map(([status, count]) => `${status} ${count}`)
        .join(" · "),
    ]);
  }
  if (job.filter && (job.filter.status?.length || job.filter.taskKey)) {
    const parts: string[] = [];
    if (job.filter.status?.length) parts.push(`status=${job.filter.status.join(",")}`);
    if (job.filter.taskKey) parts.push(`task=${job.filter.taskKey}`);
    rows.push(["filter", parts.join(" · ")]);
  }
  rows.push(["created", job.createdAt]);
  const lines = table(rows);
  if (job.results && job.results.length > 0) {
    lines.push("");
    const resultRows = [["TASK", "STATUS", "WAS", "NOW", "Δ", "SOURCE RUN ID"]];
    for (const result of job.results) resultRows.push(regradeResultRow(result));
    lines.push(...table(resultRows));
  }
  return lines;
}

const PROVIDER_ORDER: EvalSandboxProvider[] = ["e2b", "daytona", "modal"];

/** Compact per-provider verdicts, e.g. "e2b ok · daytona ok · modal NO". */
function fmtProviders(providers: Task["providers"]): string {
  return PROVIDER_ORDER.filter((provider) => providers?.[provider] !== undefined)
    .map((provider) => `${provider} ${providers[provider].ok ? "ok" : "NO"}`)
    .join(" · ");
}

function fmtScore(score: number | null): string {
  return score !== null ? String(Math.round(score * 1000) / 1000) : "-";
}

/** One trace event line — evolve-evals trace. */
export function traceEventLine(event: TaskRunTraceEvent): string {
  const detail = truncate(JSON.stringify(event.data ?? {}), 140);
  return `#${String(event.seq).padStart(4)} ${event.type.padEnd(26)} ${detail}`.trimEnd();
}

/** One line for a structured import error: the message plus a failure count. */
function importErrorText(error: NonNullable<BenchmarkImport["error"]>): string {
  const failures = error.failures?.length
    ? ` (${error.failures.length} task failure${error.failures.length === 1 ? "" : "s"})`
    : "";
  return `${error.message}${failures}`;
}

function importLines(job: BenchmarkImport): string[] {
  const rows: string[][] = [
    ["id", job.id],
    ["status", job.status],
  ];
  if (job.benchmarkName !== undefined) rows.push(["benchmark", job.benchmarkName]);
  if (job.version !== undefined) rows.push(["version", job.version]);
  if (job.taskCount !== undefined) rows.push(["tasks", String(job.taskCount)]);
  if (job.error) {
    rows.push(["error", importErrorText(job.error)]);
    for (const failure of job.error.failures ?? []) {
      rows.push([`  ${failure.taskKey}`, failure.error]);
    }
  }
  return table(rows);
}

/** Compact one-line rendering of one import status change for --watch. */
export function importStatusLine(job: BenchmarkImport): string {
  const parts: string[] = [];
  if (job.taskCount !== undefined) parts.push(`tasks=${job.taskCount}`);
  if (job.error) parts.push(truncate(importErrorText(job.error), 140));
  return `status ${job.status.padEnd(12)} ${parts.join(" ")}`.trimEnd();
}

/** Compact one-line rendering of one SSE event for --watch. */
export function eventLine(event: EvaluationEvent): string {
  const data = event.data ?? {};
  const parts: string[] = [];
  if (typeof data.taskRunId === "string") parts.push(data.taskRunId);
  if (typeof data.taskKey === "string") parts.push(data.taskKey);
  if (typeof data.status === "string") parts.push(data.status);
  if (typeof data.score === "number") parts.push(`score=${data.score}`);
  const used = new Set(["taskRunId", "taskKey", "status", "score"]);
  for (const [key, value] of Object.entries(data)) {
    if (used.has(key)) continue;
    parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  const detail = truncate(parts.join(" "), 140);
  return `#${String(event.seq).padStart(4)} ${event.type.padEnd(26)} ${detail}`.trimEnd();
}

// =============================================================================
// COMMAND HANDLERS
// =============================================================================

function clientConfig(inv: Invocation): HostedClientConfig {
  const config: HostedClientConfig = {};
  if (typeof inv.flags["api-key"] === "string") config.apiKey = inv.flags["api-key"];
  if (typeof inv.flags["base-url"] === "string") config.baseUrl = inv.flags["base-url"];
  return config;
}

function statusExitCode(e: Evaluation): number {
  return e.status === "COMPLETED" ? 0 : e.status === "FAILED" || e.status === "CANCELLED" ? 1 : 0;
}

async function cmdRun(inv: Invocation, io: CliIO): Promise<number> {
  const input = buildEvaluationInput(inv);
  const json = inv.flags.json === true;
  const watch = inv.flags.watch === true;
  const client = evaluations(clientConfig(inv));

  const created = await client.run(input);
  if (!watch) {
    if (json) {
      io.out(JSON.stringify(created));
    } else {
      for (const line of evaluationLines(created)) io.out(line);
      io.out("");
      io.out(`Follow it with: evolve-evals get ${created.id}`);
    }
    return 0;
  }

  if (json) {
    io.out(JSON.stringify({ kind: "evaluation.created", evaluation: created }));
  } else {
    io.out(`Evaluation ${created.id} (${created.benchmark}) ${created.status} — watching…`);
  }

  const final = await client.watch(created.id, {
    onEvent: (event) => {
      io.out(json ? JSON.stringify({ kind: "event", ...event }) : eventLine(event));
    },
  });

  if (json) {
    io.out(JSON.stringify({ kind: "evaluation.final", evaluation: final }));
  } else {
    io.out("");
    for (const line of evaluationLines(final)) io.out(line);
  }
  return statusExitCode(final);
}

async function cmdList(inv: Invocation, io: CliIO): Promise<number> {
  const client = evaluations(clientConfig(inv));
  const page = await client.list({
    ...(inv.flags.limit !== undefined ? { limit: inv.flags.limit as number } : {}),
    ...(inv.flags.cursor !== undefined ? { cursor: inv.flags.cursor as string } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.evaluations.length === 0) {
    io.out("No evaluations.");
    return 0;
  }
  const rows = [["ID", "STATUS", "BENCHMARK", "TASK RUNS", "MEAN SCORE", "SPENT", "CREATED"]];
  for (const e of page.evaluations) rows.push(evaluationRow(e));
  for (const line of table(rows)) io.out(line);
  if (page.nextCursor) io.out(`\nMore: evolve-evals list --cursor ${page.nextCursor}`);
  return 0;
}

async function cmdGet(inv: Invocation, io: CliIO): Promise<number> {
  const client = evaluations(clientConfig(inv));
  const e = await client.get(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(e));
  } else {
    for (const line of evaluationLines(e)) io.out(line);
  }
  return 0;
}

async function cmdTaskRuns(inv: Invocation, io: CliIO): Promise<number> {
  const client = evaluations(clientConfig(inv));
  let status: TaskRunStatus[] | undefined;
  if (inv.flags.status !== undefined) {
    status = String(inv.flags.status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as TaskRunStatus[];
    if (status.length === 0) {
      throw new CliUsageError("--status got an empty status list");
    }
  }
  const page = await client.taskRuns(inv.positionals[0], {
    ...(status !== undefined ? { status } : {}),
    ...(inv.flags.limit !== undefined ? { limit: inv.flags.limit as number } : {}),
    ...(inv.flags.cursor !== undefined ? { cursor: inv.flags.cursor as string } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.taskRuns.length === 0) {
    io.out("No task runs.");
    return 0;
  }
  const rows = [["TASK", "SYSTEM", "RUN", "STATUS", "SCORE", "SPENT", "RUN ID"]];
  for (const run of page.taskRuns) rows.push(taskRunRow(run));
  for (const line of table(rows)) io.out(line);
  io.out(`\n${page.taskRuns.length} task run(s) shown`);
  if (page.nextCursor) {
    io.out(`More: evolve-evals task-runs ${inv.positionals[0]} --cursor ${page.nextCursor}`);
  }
  return 0;
}

async function cmdTaskRun(inv: Invocation, io: CliIO): Promise<number> {
  const client = evaluations(clientConfig(inv));
  const run = await client.taskRun(inv.positionals[0], inv.positionals[1]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(run));
  } else {
    for (const line of taskRunDetailLines(run)) io.out(line);
  }
  return 0;
}

async function cmdTrace(inv: Invocation, io: CliIO): Promise<number> {
  const client = evaluations(clientConfig(inv));
  const json = inv.flags.json === true;
  let count = 0;
  for await (const event of client.taskRunTraceEvents(inv.positionals[0], inv.positionals[1], {
    ...(inv.flags.after !== undefined ? { after: inv.flags.after as number } : {}),
    ...(inv.flags.limit !== undefined ? { limit: inv.flags.limit as number } : {}),
  })) {
    io.out(json ? JSON.stringify(event) : traceEventLine(event));
    count += 1;
  }
  if (!json && count === 0) io.out("No trace events.");
  return 0;
}

function comparisonLines(comparison: EvaluationComparison): string[] {
  const lines: string[] = [];
  const aggregateRows = [["ID", "BENCHMARK", "STATUS", "MEAN SCORE", "COVERAGE", "SPENT"]];
  for (const agg of comparison.evaluations) {
    aggregateRows.push([
      agg.id,
      agg.benchmark,
      agg.status,
      fmtScore(agg.meanScore),
      `${agg.coverage.scored}/${agg.coverage.total}`,
      fmtUsd(agg.spentUsd),
    ]);
  }
  lines.push(...table(aggregateRows));

  if (comparison.taskMatrix.length > 0) {
    lines.push("", "Task matrix (disagreements first; columns in the order above):");
    const matrixRows = [
      ["TASK", "DIFF", ...comparison.evaluations.map((_, index) => `EVAL ${index + 1}`)],
    ];
    const columnOrder = comparison.evaluations.map((agg) => agg.id);
    for (const row of comparison.taskMatrix) {
      const cellById = new Map(row.cells.map((cell) => [cell.evaluationId, cell]));
      matrixRows.push([
        row.taskKey,
        row.disagreement ? "!" : "",
        ...columnOrder.map((id) => {
          const cell = cellById.get(id);
          if (!cell) return "-";
          return cell.meanScore !== null
            ? `${cell.status} ${fmtScore(cell.meanScore)}`
            : cell.status;
        }),
      ]);
    }
    lines.push(...table(matrixRows));
  }
  return lines;
}

async function cmdCompare(inv: Invocation, io: CliIO): Promise<number> {
  const client = evaluations(clientConfig(inv));
  const comparison = await client.compare(inv.positionals);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(comparison));
  } else {
    for (const line of comparisonLines(comparison)) io.out(line);
  }
  return 0;
}

async function cmdCancel(inv: Invocation, io: CliIO): Promise<number> {
  const client = evaluations(clientConfig(inv));
  const e = await client.cancel(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(e));
  } else {
    for (const line of evaluationLines(e)) io.out(line);
  }
  return 0;
}

async function cmdRerunFailed(inv: Invocation, io: CliIO): Promise<number> {
  const client = evaluations(clientConfig(inv));
  const e = await client.rerunFailed(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(e));
  } else {
    for (const line of evaluationLines(e)) io.out(line);
    io.out("");
    io.out(`Follow it with: evolve-evals get ${e.id}`);
  }
  return 0;
}

async function cmdRegrade(inv: Invocation, io: CliIO): Promise<number> {
  const client = evaluations(clientConfig(inv));
  const [id, runId] = inv.positionals;
  let job: RegradeJob;
  if (runId !== undefined) {
    // Per-run regrade takes no --status/--task filter (a single run needs none).
    if (inv.flags.status !== undefined || inv.flags.task !== undefined) {
      throw new CliUsageError("--status/--task apply to a whole-evaluation regrade, not a single run");
    }
    job = await client.regradeTaskRun(id, runId);
  } else {
    const options: { status?: TaskRunStatus[]; taskKey?: string } = {};
    if (inv.flags.status !== undefined) {
      const status = String(inv.flags.status)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as TaskRunStatus[];
      if (status.length === 0) throw new CliUsageError("--status got an empty status list");
      options.status = status;
    }
    if (inv.flags.task !== undefined) options.taskKey = String(inv.flags.task);
    job = await client.regrade(id, options);
  }
  if (inv.flags.json === true) {
    io.out(JSON.stringify(job));
  } else {
    for (const line of regradeJobLines(job)) io.out(line);
    io.out("");
    io.out(`Follow it with: evolve-evals regrade-job ${job.id}`);
  }
  return 0;
}

async function cmdRegradeJob(inv: Invocation, io: CliIO): Promise<number> {
  const client = evaluations(clientConfig(inv));
  const job = await client.regradeJob(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(job));
  } else {
    for (const line of regradeJobLines(job)) io.out(line);
  }
  return 0;
}

async function cmdExport(inv: Invocation, io: CliIO): Promise<number> {
  const format = inv.flags.format as string | undefined;
  if (format !== undefined && format !== "harbor") {
    throw new CliUsageError(`Unknown --format "${format}" (supported: harbor)`);
  }
  const client = evaluations(clientConfig(inv));
  const filePath = await client.export(inv.positionals[0], {
    to: (inv.flags.to as string | undefined) ?? process.cwd(),
    ...(format === "harbor" ? { format: "harbor" as const } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify({ path: filePath }));
  } else {
    io.out(`Saved ${filePath}`);
  }
  return 0;
}

function benchmarkDetailLines(b: Benchmark): string[] {
  const lines = table([
    ["name", b.name],
    ["title", b.title ?? "-"],
    ["description", b.description ?? "-"],
    ["active version", b.activeVersion?.version ?? "-"],
  ]);
  if (b.versions && b.versions.length > 0) {
    lines.push("");
    const rows = [["VERSION", "STATE", "TASKS", "CREATED"]];
    for (const v of b.versions) {
      rows.push([v.version, v.state, String(v.taskCount), v.createdAt ?? "-"]);
    }
    lines.push(...table(rows));
  }
  if (b.tasks && b.tasks.length > 0) {
    lines.push("", `Tasks (version ${b.selectedVersion?.version ?? "?"}):`);
    const rows = [["TASK", "AGENT TIMEOUT", "VERIFIER TIMEOUT", "PROVIDERS"]];
    for (const t of b.tasks) {
      rows.push([t.taskKey, `${t.agentTimeoutSec}s`, `${t.verifierTimeoutSec}s`, fmtProviders(t.providers)]);
    }
    lines.push(...table(rows));
    // Name each refusal once below the table; the runner refuses with the
    // same reason at run time.
    const refusals = new Map<string, string>();
    for (const t of b.tasks) {
      for (const provider of PROVIDER_ORDER) {
        const verdict = t.providers?.[provider];
        if (verdict && !verdict.ok && !refusals.has(`${provider}:${verdict.reason}`)) {
          refusals.set(`${provider}:${verdict.reason}`, `${provider}: ${verdict.reason}`);
        }
      }
    }
    if (refusals.size > 0) {
      lines.push("", "Provider limitations:");
      for (const reason of refusals.values()) lines.push(`  ${reason}`);
    }
  }
  return lines;
}

async function cmdBenchmarks(inv: Invocation, io: CliIO): Promise<number> {
  const client = benchmarks(clientConfig(inv));
  const [sub, ref] = inv.positionals;

  if (sub === undefined) {
    const catalog = await client.list();
    if (inv.flags.json === true) {
      io.out(JSON.stringify({ benchmarks: catalog }));
      return 0;
    }
    if (catalog.length === 0) {
      io.out("No benchmarks.");
      return 0;
    }
    const rows = [["NAME", "ACTIVE", "STATE", "TASKS", "TITLE"]];
    for (const b of catalog) {
      rows.push([
        b.name,
        b.activeVersion?.version ?? "-",
        b.activeVersion?.state ?? "-",
        b.activeVersion ? String(b.activeVersion.taskCount) : "-",
        b.title ?? "-",
      ]);
    }
    for (const line of table(rows)) io.out(line);
    return 0;
  }

  if (sub !== "get") {
    throw new CliUsageError(`Unknown benchmarks subcommand "${sub}" (did you mean "benchmarks get ${sub}"?)`);
  }
  if (!ref) {
    throw new CliUsageError('"benchmarks get" requires a <name[@version]> ref');
  }
  const detail = await client.get(ref);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(detail));
  } else {
    for (const line of benchmarkDetailLines(detail)) io.out(line);
  }
  return 0;
}

async function cmdImport(inv: Invocation, io: CliIO): Promise<number> {
  const [sub, id] = inv.positionals;
  const json = inv.flags.json === true;
  const client = benchmarks(clientConfig(inv));

  if (sub === "status") {
    if (!id) {
      throw new CliUsageError('"import status" requires an <id>');
    }
    const job = await client.getImport(id);
    if (json) {
      io.out(JSON.stringify(job));
    } else {
      for (const line of importLines(job)) io.out(line);
    }
    return 0;
  }
  if (sub !== undefined) {
    throw new CliUsageError(`Unknown import subcommand "${sub}" (supported: status)`);
  }

  const input = buildImportInput(inv);
  const created = await client.import(input);
  if (inv.flags.watch !== true) {
    if (json) {
      io.out(JSON.stringify(created));
    } else {
      for (const line of importLines(created)) io.out(line);
      io.out("");
      io.out(`Follow it with: evolve-evals import status ${created.id}`);
    }
    return 0;
  }

  if (json) {
    io.out(JSON.stringify({ kind: "import.created", benchmarkImport: created }));
  } else {
    io.out(`Import ${created.id} (${input.benchmarkName}) ${created.status} — watching…`);
  }

  const final = await client.watchImport(created.id, {
    onStatus: (job) => {
      io.out(json ? JSON.stringify({ kind: "import.status", benchmarkImport: job }) : importStatusLine(job));
    },
  });

  if (json) {
    io.out(JSON.stringify({ kind: "import.final", benchmarkImport: final }));
  } else {
    io.out("");
    for (const line of importLines(final)) io.out(line);
  }
  return final.status === "FAILED" ? 1 : 0;
}

// =============================================================================
// ENTRY
// =============================================================================

export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  let inv: Invocation;
  try {
    inv = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(`Error: ${error.message}`);
      io.err('Run "evolve-evals help" for usage.');
      return 2;
    }
    throw error;
  }

  try {
    switch (inv.command) {
      case "help":
        io.out(USAGE);
        return 0;
      case "run":
        return await cmdRun(inv, io);
      case "list":
        return await cmdList(inv, io);
      case "get":
        return await cmdGet(inv, io);
      case "task-runs":
        return await cmdTaskRuns(inv, io);
      case "task-run":
        return await cmdTaskRun(inv, io);
      case "trace":
        return await cmdTrace(inv, io);
      case "compare":
        return await cmdCompare(inv, io);
      case "cancel":
        return await cmdCancel(inv, io);
      case "rerun-failed":
        return await cmdRerunFailed(inv, io);
      case "regrade":
        return await cmdRegrade(inv, io);
      case "regrade-job":
        return await cmdRegradeJob(inv, io);
      case "export":
        return await cmdExport(inv, io);
      case "benchmarks":
        return await cmdBenchmarks(inv, io);
      case "import":
        return await cmdImport(inv, io);
      default:
        // parseArgs guarantees a known command; defensive fallback
        io.err(`Error: unknown command "${inv.command}"`);
        return 2;
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(`Error: ${error.message}`);
      io.err('Run "evolve-evals help" for usage.');
      return 2;
    }
    io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}

// Run only when invoked as the `evolve-evals` bin — never on test/library import.
const invokedAsBin = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (invokedAsBin) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`Error: ${(error as Error)?.message ?? error}\n`);
      process.exitCode = 1;
    }
  );
}
