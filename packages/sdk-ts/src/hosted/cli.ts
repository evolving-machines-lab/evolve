#!/usr/bin/env node
/**
 * evolve-evals — CLI for Evolve hosted benchmarks & jobs.
 *
 * Thin shell over the hosted client (benchmarks() / jobs()): plain node
 * arg parsing, no dependencies. Human-readable tables by default; --json emits
 * machine-readable JSON (NDJSON for --watch event streams).
 *
 * Exit codes: 0 success (watch: job COMPLETED / import IMPORTED), 1
 * runtime/API failure (watch: FAILED or CANCELLED), 2 usage error.
 */

import { readFileSync } from "fs";
import { pathToFileURL } from "url";
import { benchmarks, customHarnesses, jobs } from "./index";
import type {
  Benchmark,
  BenchmarkImport,
  BenchmarkImportInput,
  CustomHarness,
  CustomHarnessInput,
  EvalSandboxProvider,
  HostedClientConfig,
  Job,
  JobAgent,
  JobComparison,
  JobEvent,
  JobInput,
  RegradeJob,
  RegradeResult,
  Task,
  Trial,
  TrialDetail,
  TrialStatus,
  TrialTraceEvent,
  UpstreamStatus,
} from "./types";

// =============================================================================
// USAGE
// =============================================================================

export const USAGE = `evolve-evals — Evolve hosted jobs CLI

Usage: evolve-evals <command> [options]

Commands:
  run                               Create a job (add --watch to follow it)
  list                              List your jobs (newest first)
  get <id>                          Show one job
  trials <id>                       List a job's trials
  trial <id> <trial-id>             Show one trial in full detail
  trace <id> <trial-id>             Print a trial's trace events
  compare <id> <id> [...]           Compare 2-5 jobs side by side
  cancel <id>                       Request cancellation of a job
  rerun-failed <id>                 New job from a terminal job's failed trials
  regrade <id> [trial-id]           Re-run the verifier on recorded trials (whole job, or one trial)
  regrade-job <job-id>              Show a regrade job's results (rewards, deltas, lineage)
  export <id>                       Download the research archive (gzipped JSON)
  benchmarks                        List the benchmark catalog
  benchmarks get <name[@version]>   Show one benchmark (versions + tasks + providers)
  import                            Import a benchmark from a git source or a local directory (--watch to follow)
  import status <id>                Show one import job
  custom-harnesses                  List your registered custom harnesses
  custom-harnesses get <name>       Show one custom harness
  custom-harnesses add              Register a custom harness (install script or local directory)
  custom-harnesses remove <name>    Delete a custom harness
  help                              Show this help

Run options:
  --benchmark <name[@version]>        Benchmark (required; bare name = active version)
  --tasks <k1,k2,...>                 Task keys (default: every task of the version)
  --agent <harness:model[:version]>   Agent; repeatable (at least one required)
  --runs <n>                          Runs per task x agent (default 1)
  --concurrency <n>                   Parallel trials (default 1)
  --max-trial-spend <usd>             Model-spend cap for EACH trial (default: the server's, $200)
  --provider <e2b|daytona|modal>      e2b | daytona | modal, default e2b
  --watch                             Stream events until the job finishes

Trial options:
  --status <s1,s2,...>                Filter trials by status (e.g. INFRASTRUCTURE_ERROR)

Regrade options (whole-job regrade only):
  --status <s1,s2,...>                Only regrade source trials in these statuses
  --task <key>                        Only regrade source trials of this task

Trace options:
  --cursor <seq>                      Resume after this trace seq (a trace cursor IS a seq)
  --limit <n>                         Max events per page

Import options (a git source OR a local directory; --name and --version required):
  --git <url>                         Git repository URL (with --ref)
  --ref <ref>                         Git ref: branch, tag, or commit (with --git)
  --dir <path>                        Local corpus directory (tarred + uploaded)
  --name <benchmark>                  Catalog benchmark name to create or extend (required)
  --version <v>                       Version label for the imported version (required)
  --watch                             Poll until the import is IMPORTED or FAILED

Custom-harness options ("custom-harnesses add"; an install script OR a local directory):
  --name <harness>                    Harness name, later used in --agent (required)
  --install-script <path>             Install script file; its contents are uploaded
  --dir <path>                        Local harness directory (tarred + uploaded)
  --run <command>                     Run command, executed with sh -c (required)
  --env KEY=VALUE                     Env injected at run time; repeatable

Other options:
  --limit <n>, --cursor <c>           Pagination — one envelope on every collection
                                      (list, trials, trace, benchmarks, benchmarks get,
                                      custom-harnesses, regrade-job)
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
      agent: "repeat",
      runs: "number",
      concurrency: "number",
      "max-trial-spend": "number",
      provider: "string",
      watch: "boolean",
    },
    required: ["benchmark", "agent"],
    minPositionals: 0,
    maxPositionals: 0,
  },
  list: {
    flags: { limit: "number", cursor: "string" },
    minPositionals: 0,
    maxPositionals: 0,
  },
  get: { flags: {}, minPositionals: 1, maxPositionals: 1, positionalUsage: "<id>" },
  "trials": {
    flags: { status: "string", limit: "number", cursor: "string" },
    minPositionals: 1,
    maxPositionals: 1,
    positionalUsage: "<id>",
  },
  "trial": {
    flags: {},
    minPositionals: 2,
    maxPositionals: 2,
    positionalUsage: "<id> <trial-id>",
  },
  trace: {
    flags: { cursor: "string", limit: "number" },
    minPositionals: 2,
    maxPositionals: 2,
    positionalUsage: "<id> <trial-id>",
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
    positionalUsage: "<id> [trial-id]",
  },
  "regrade-job": {
    flags: { limit: "number", cursor: "string" },
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
  benchmarks: { flags: { limit: "number", cursor: "string" }, minPositionals: 0, maxPositionals: 2 },
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
  // "custom-harnesses" lists; "get <name>" / "remove <name>" take a name, and
  // "add" takes the registration flags (all validated in the handler).
  "custom-harnesses": {
    flags: {
      name: "string",
      "install-script": "string",
      dir: "string",
      run: "string",
      env: "repeat",
      limit: "number",
      cursor: "string",
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
export function parseJobAgent(spec: string): JobAgent {
  const first = spec.indexOf(":");
  if (first <= 0 || first === spec.length - 1) {
    throw new CliUsageError(`Invalid --agent "${spec}": expected harness:model[:version]`);
  }
  const harness = spec.slice(0, first);
  const rest = spec.slice(first + 1);
  const second = rest.indexOf(":");
  if (second === -1) return { harness, model: rest };
  const model = rest.slice(0, second);
  const version = rest.slice(second + 1);
  if (!model || !version) {
    throw new CliUsageError(`Invalid --agent "${spec}": expected harness:model[:version]`);
  }
  return { harness, model, harnessVersion: version };
}

/**
 * Build the POST /api/jobs body from a parsed `run` invocation.
 * Keys follow the contract field order: benchmark, tasks, agents,
 * runsPerTask, concurrency, maxTrialSpendUsd, sandboxProvider.
 */
export function buildJobInput(inv: Invocation): JobInput {
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
    agents: (f.agent as string[]).map(parseJobAgent),
    ...(f.runs !== undefined ? { runsPerTask: f.runs as number } : {}),
    ...(f.concurrency !== undefined ? { concurrency: f.concurrency as number } : {}),
    ...(f["max-trial-spend"] !== undefined
      ? { maxTrialSpendUsd: f["max-trial-spend"] as number }
      : {}),
    ...(f.provider !== undefined
      ? { sandboxProvider: f.provider as JobInput["sandboxProvider"] }
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

/** Parse repeatable `--env KEY=VALUE` into the declared run-time env map. */
export function parseHarnessEnv(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new CliUsageError(`Invalid --env "${pair}": expected KEY=VALUE`);
    }
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

/**
 * Build the customHarnesses().create() input from a parsed
 * `custom-harnesses add` invocation. `--install-script` names a FILE; its
 * contents are what the SDK uploads.
 */
export function buildCustomHarnessInput(
  inv: Invocation,
  readScript: (path: string) => string = (path) => readFileSync(path, "utf-8")
): CustomHarnessInput {
  const f = inv.flags;
  const hasDir = typeof f.dir === "string";
  const hasInstallScript = typeof f["install-script"] === "string";
  if (hasDir && hasInstallScript) {
    throw new CliUsageError(
      '"custom-harnesses add" takes EITHER --dir OR --install-script, not both'
    );
  }
  if (!hasDir && !hasInstallScript) {
    throw new CliUsageError(
      '"custom-harnesses add" requires --install-script (or --dir for a local harness directory)'
    );
  }
  for (const req of ["name", "run"] as const) {
    if (typeof f[req] !== "string") {
      throw new CliUsageError(`"custom-harnesses add" requires --${req}`);
    }
  }
  const env = parseHarnessEnv((f.env as string[] | undefined) ?? []);
  return {
    name: f.name as string,
    ...(hasDir
      ? { directory: f.dir as string }
      : { installScript: readScript(f["install-script"] as string) }),
    runCommand: f.run as string,
    ...(Object.keys(env).length > 0 ? { env } : {}),
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

function fmtAgent(agent: JobAgent): string {
  const base = `${agent.harness}:${agent.model}`;
  return agent.harnessVersion ? `${base}:${agent.harnessVersion}` : base;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function jobLines(e: Job): string[] {
  // Row order mirrors the input contract: benchmark, agents, size, runs/task,
  // concurrency, spend caps.
  const rows: string[][] = [
    ["id", e.id],
    ["status", e.status],
    ["benchmark", e.benchmark],
  ];
  rows.push(["agents", e.agents.map(fmtAgent).join(", ")]);
  rows.push([
    "size",
    `${e.counts.agents} agent(s) x ${e.counts.tasks} task(s) = ${e.trials.total} trial(s)`,
  ]);
  rows.push(["runs/task", String(e.runsPerTask)]);
  rows.push(["concurrency", String(e.concurrency)]);
  rows.push(["max spend/trial", fmtUsd(e.maxTrialSpendUsd)]);
  rows.push(["worst case", fmtUsd(e.worstCaseSpendUsd)]);
  rows.push(["provider", e.sandboxProvider]);
  rows.push(["spent", fmtUsd(e.spentUsd)]);
  rows.push(["mean reward", e.meanReward !== null ? String(e.meanReward) : "-"]);
  // Only the statuses actually present: the response names all of them (so a
  // client never hardcodes the enum), but a row of eight zeros helps nobody.
  const histogram = Object.entries(e.trials.byStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`)
    .join(" · ");
  if (histogram) rows.push(["trials", histogram]);
  if (e.sourceJobId) rows.push(["rerun of", e.sourceJobId]);
  if (e.idempotentReplay) rows.push(["note", "idempotent replay of an existing job"]);
  if (e.failure) rows.push(["failure", `${e.failure.code}: ${e.failure.message}`]);
  rows.push(["created", e.createdAt]);
  rows.push(["updated", e.updatedAt]);
  return table(rows);
}

function jobRow(e: Job): string[] {
  return [
    e.id,
    e.status,
    e.benchmark,
    String(e.trials.total),
    fmtReward(e.meanReward),
    fmtUsd(e.spentUsd),
    e.createdAt,
  ];
}

function trialRow(run: Trial): string[] {
  return [
    run.taskKey,
    fmtAgent(run.agent),
    String(run.runNumber),
    run.status,
    run.reward !== null ? String(run.reward) : "-",
    fmtUsd(run.modelUsage?.spentUsd ?? null),
    run.id,
  ];
}

/** Full-detail rendering of one trial — evolve-evals trial. */
function trialDetailLines(run: TrialDetail): string[] {
  const rows: string[][] = [
    ["trial id", run.id],
    ["job", run.jobId],
    ["task", run.taskKey],
    ["agent", fmtAgent(run.agent)],
    ["run", String(run.runNumber)],
    ["status", run.status],
    ["reward", run.reward !== null ? String(run.reward) : "-"],
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
    fmtReward(result.sourceReward),
    fmtReward(result.reward),
    fmtDelta(result.rewardDelta),
    result.sourceTrialId,
  ];
}

/** Job envelope + per-trial results — evolve-evals regrade / regrade-job. */
function regradeJobLines(job: RegradeJob): string[] {
  const rows: string[][] = [
    ["job id", job.id],
    ["status", job.status],
    ["source job", job.sourceJobId],
    ["provider", job.sandboxProvider],
    ["results", String(job.results.total)],
  ];
  const byStatus = Object.entries(job.results.byStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`)
    .join(" · ");
  if (byStatus) rows.push(["by status", byStatus]);
  if (job.filter && (job.filter.status?.length || job.filter.taskKey)) {
    const parts: string[] = [];
    if (job.filter.status?.length) parts.push(`status=${job.filter.status.join(",")}`);
    if (job.filter.taskKey) parts.push(`task=${job.filter.taskKey}`);
    rows.push(["filter", parts.join(" · ")]);
  }
  rows.push(["created", job.createdAt]);
  const lines = table(rows);
  if (job.results.items.length > 0) {
    lines.push("");
    const resultRows = [["TASK", "STATUS", "WAS", "NOW", "Δ", "SOURCE TRIAL ID"]];
    for (const result of job.results.items) resultRows.push(regradeResultRow(result));
    lines.push(...table(resultRows));
    if (job.results.nextCursor) {
      lines.push(
        "",
        `More: evolve-evals regrade-job ${job.id} --cursor ${job.results.nextCursor}`
      );
    }
  }
  return lines;
}

/**
 * One custom harness — evolve-evals custom-harnesses get / add. Declared env is
 * shown by KEY only; the values were the caller's to set and are not echoed
 * back into a terminal. `--json` carries the response verbatim.
 */
function customHarnessLines(harness: CustomHarness): string[] {
  const rows: string[][] = [
    ["name", harness.name],
    ["source", harness.source],
    ["run command", harness.runCommand],
  ];
  const envKeys = Object.keys(harness.env ?? {});
  if (envKeys.length > 0) rows.push(["env", envKeys.sort().join(", ")]);
  rows.push(["created", harness.createdAt]);
  rows.push(["updated", harness.updatedAt]);
  return table(rows);
}

const PROVIDER_ORDER: EvalSandboxProvider[] = ["e2b", "daytona", "modal"];

/** Compact per-provider verdicts, e.g. "e2b ok · daytona ok · modal NO". */
function fmtProviders(providers: Task["providers"]): string {
  return PROVIDER_ORDER.filter((provider) => providers?.[provider] !== undefined)
    .map((provider) => `${provider} ${providers[provider].ok ? "ok" : "NO"}`)
    .join(" · ");
}

function fmtReward(reward: number | null): string {
  return reward !== null ? String(Math.round(reward * 1000) / 1000) : "-";
}

/** One trace event line — evolve-evals trace. */
export function traceEventLine(event: TrialTraceEvent): string {
  const detail = truncate(JSON.stringify(event.data ?? {}), 140);
  return `#${String(event.seq).padStart(4)} ${event.type.padEnd(26)} ${detail}`.trimEnd();
}

/** One line for a structured import failure: the message plus a failure count. */
function importFailureText(failure: NonNullable<BenchmarkImport["failure"]>): string {
  const failures = failure.failures?.length
    ? ` (${failure.failures.length} task failure${failure.failures.length === 1 ? "" : "s"})`
    : "";
  return `${failure.message}${failures}`;
}

function importLines(job: BenchmarkImport): string[] {
  const rows: string[][] = [
    ["id", job.id],
    ["status", job.status],
  ];
  if (job.benchmarkName !== undefined) rows.push(["benchmark", job.benchmarkName]);
  if (job.version !== undefined) rows.push(["version", job.version]);
  if (job.taskCount !== undefined) rows.push(["tasks", String(job.taskCount)]);
  if (job.failure) {
    rows.push(["failure", importFailureText(job.failure)]);
    for (const failure of job.failure.failures ?? []) {
      rows.push([`  ${failure.taskKey}`, failure.error]);
    }
  }
  return table(rows);
}

/** Compact one-line rendering of one import status change for --watch. */
export function importStatusLine(job: BenchmarkImport): string {
  const parts: string[] = [];
  if (job.taskCount !== undefined) parts.push(`tasks=${job.taskCount}`);
  if (job.failure) parts.push(truncate(importFailureText(job.failure), 140));
  return `status ${job.status.padEnd(12)} ${parts.join(" ")}`.trimEnd();
}

/** Compact one-line rendering of one SSE event for --watch. */
export function eventLine(event: JobEvent): string {
  const data = event.data ?? {};
  const parts: string[] = [];
  if (typeof data.trialId === "string") parts.push(data.trialId);
  if (typeof data.taskKey === "string") parts.push(data.taskKey);
  if (typeof data.status === "string") parts.push(data.status);
  if (typeof data.reward === "number") parts.push(`reward=${data.reward}`);
  const used = new Set(["trialId", "taskKey", "status", "reward"]);
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

/** The one { limit, cursor } pair every paged command accepts. */
function pageOptions(inv: Invocation): { limit?: number; cursor?: string } {
  return {
    ...(inv.flags.limit !== undefined ? { limit: inv.flags.limit as number } : {}),
    ...(inv.flags.cursor !== undefined ? { cursor: String(inv.flags.cursor) } : {}),
  };
}

function statusExitCode(e: Job): number {
  return e.status === "COMPLETED" ? 0 : e.status === "FAILED" || e.status === "CANCELLED" ? 1 : 0;
}

async function cmdRun(inv: Invocation, io: CliIO): Promise<number> {
  const input = buildJobInput(inv);
  const json = inv.flags.json === true;
  const watch = inv.flags.watch === true;
  const client = jobs(clientConfig(inv));

  const created = await client.run(input);
  if (!watch) {
    if (json) {
      io.out(JSON.stringify(created));
    } else {
      for (const line of jobLines(created)) io.out(line);
      io.out("");
      io.out(`Follow it with: evolve-evals get ${created.id}`);
    }
    return 0;
  }

  if (json) {
    io.out(JSON.stringify({ kind: "job.created", job: created }));
  } else {
    io.out(`Job ${created.id} (${created.benchmark}) ${created.status} — watching…`);
  }

  const final = await client.watch(created.id, {
    onEvent: (event) => {
      io.out(json ? JSON.stringify({ kind: "event", ...event }) : eventLine(event));
    },
  });

  if (json) {
    io.out(JSON.stringify({ kind: "job.final", job: final }));
  } else {
    io.out("");
    for (const line of jobLines(final)) io.out(line);
  }
  return statusExitCode(final);
}

async function cmdList(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const page = await client.list({
    ...(inv.flags.limit !== undefined ? { limit: inv.flags.limit as number } : {}),
    ...(inv.flags.cursor !== undefined ? { cursor: inv.flags.cursor as string } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.items.length === 0) {
    io.out("No jobs.");
    return 0;
  }
  const rows = [["ID", "STATUS", "BENCHMARK", "TRIALS", "MEAN REWARD", "SPENT", "CREATED"]];
  for (const e of page.items) rows.push(jobRow(e));
  for (const line of table(rows)) io.out(line);
  if (page.nextCursor) io.out(`\nMore: evolve-evals list --cursor ${page.nextCursor}`);
  return 0;
}

async function cmdGet(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const e = await client.get(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(e));
  } else {
    for (const line of jobLines(e)) io.out(line);
  }
  return 0;
}

async function cmdTrials(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  let status: TrialStatus[] | undefined;
  if (inv.flags.status !== undefined) {
    status = String(inv.flags.status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as TrialStatus[];
    if (status.length === 0) {
      throw new CliUsageError("--status got an empty status list");
    }
  }
  const page = await client.trials(inv.positionals[0], {
    ...(status !== undefined ? { status } : {}),
    ...(inv.flags.limit !== undefined ? { limit: inv.flags.limit as number } : {}),
    ...(inv.flags.cursor !== undefined ? { cursor: inv.flags.cursor as string } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.items.length === 0) {
    io.out("No trials.");
    return 0;
  }
  const rows = [["TASK", "AGENT", "RUN", "STATUS", "REWARD", "SPENT", "TRIAL ID"]];
  for (const run of page.items) rows.push(trialRow(run));
  for (const line of table(rows)) io.out(line);
  io.out(`\n${page.items.length} trial(s) shown`);
  if (page.nextCursor) {
    io.out(`More: evolve-evals trials ${inv.positionals[0]} --cursor ${page.nextCursor}`);
  }
  return 0;
}

async function cmdTrial(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const run = await client.trial(inv.positionals[0], inv.positionals[1]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(run));
  } else {
    for (const line of trialDetailLines(run)) io.out(line);
  }
  return 0;
}

async function cmdTrace(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const json = inv.flags.json === true;
  let count = 0;
  for await (const event of client.trialTraceEvents(inv.positionals[0], inv.positionals[1], {
    ...(inv.flags.cursor !== undefined ? { cursor: String(inv.flags.cursor) } : {}),
    ...(inv.flags.limit !== undefined ? { limit: inv.flags.limit as number } : {}),
  })) {
    io.out(json ? JSON.stringify(event) : traceEventLine(event));
    count += 1;
  }
  if (!json && count === 0) io.out("No trace events.");
  return 0;
}

function comparisonLines(comparison: JobComparison): string[] {
  const lines: string[] = [];
  const aggregateRows = [["ID", "BENCHMARK", "STATUS", "MEAN REWARD", "COVERAGE", "SPENT"]];
  for (const agg of comparison.jobs) {
    aggregateRows.push([
      agg.id,
      agg.benchmark,
      agg.status,
      fmtReward(agg.meanReward),
      `${agg.coverage.scored}/${agg.coverage.total}`,
      fmtUsd(agg.spentUsd),
    ]);
  }
  lines.push(...table(aggregateRows));

  if (comparison.taskMatrix.length > 0) {
    lines.push("", "Task matrix (disagreements first; columns in the order above):");
    const matrixRows = [
      ["TASK", "DIFF", ...comparison.jobs.map((_, index) => `JOB ${index + 1}`)],
    ];
    const columnOrder = comparison.jobs.map((agg) => agg.id);
    for (const row of comparison.taskMatrix) {
      const cellById = new Map(row.cells.map((cell) => [cell.jobId, cell]));
      matrixRows.push([
        row.taskKey,
        row.disagreement ? "!" : "",
        ...columnOrder.map((id) => {
          const cell = cellById.get(id);
          if (!cell) return "-";
          return cell.meanReward !== null
            ? `${cell.status} ${fmtReward(cell.meanReward)}`
            : cell.status;
        }),
      ]);
    }
    lines.push(...table(matrixRows));
  }
  return lines;
}

async function cmdCompare(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const comparison = await client.compare(inv.positionals);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(comparison));
  } else {
    for (const line of comparisonLines(comparison)) io.out(line);
  }
  return 0;
}

async function cmdCancel(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const e = await client.cancel(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(e));
  } else {
    for (const line of jobLines(e)) io.out(line);
  }
  return 0;
}

async function cmdRerunFailed(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const e = await client.rerunFailed(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(e));
  } else {
    for (const line of jobLines(e)) io.out(line);
    io.out("");
    io.out(`Follow it with: evolve-evals get ${e.id}`);
  }
  return 0;
}

async function cmdRegrade(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const [id, trialId] = inv.positionals;
  let job: RegradeJob;
  if (trialId !== undefined) {
    // Per-trial regrade takes no --status/--task filter (a single trial needs none).
    if (inv.flags.status !== undefined || inv.flags.task !== undefined) {
      throw new CliUsageError("--status/--task apply to a whole-job regrade, not a single trial");
    }
    job = await client.regradeTrial(id, trialId);
  } else {
    const options: { status?: TrialStatus[]; taskKey?: string } = {};
    if (inv.flags.status !== undefined) {
      const status = String(inv.flags.status)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as TrialStatus[];
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
  const client = jobs(clientConfig(inv));
  const job = await client.regradeJob(inv.positionals[0], pageOptions(inv));
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
  const client = jobs(clientConfig(inv));
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
  if (b.tasks && b.tasks.items.length > 0) {
    lines.push("", `Tasks (version ${b.selectedVersion?.version ?? "?"}):`);
    const rows = [["TASK", "AGENT TIMEOUT", "VERIFIER TIMEOUT", "PROVIDERS"]];
    for (const t of b.tasks.items) {
      rows.push([t.taskKey, `${t.agentTimeoutSec}s`, `${t.verifierTimeoutSec}s`, fmtProviders(t.providers)]);
    }
    lines.push(...table(rows));
    if (b.tasks.nextCursor) {
      lines.push(`More tasks: evolve-evals benchmarks get ${b.name} --cursor ${b.tasks.nextCursor}`);
    }
    // Name each refusal once below the table; the runner refuses with the
    // same reason at run time.
    const refusals = new Map<string, string>();
    for (const t of b.tasks.items) {
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
    const catalog = await client.list(pageOptions(inv));
    if (inv.flags.json === true) {
      io.out(JSON.stringify(catalog));
      return 0;
    }
    if (catalog.items.length === 0) {
      io.out("No benchmarks.");
      return 0;
    }
    const rows = [["NAME", "ACTIVE", "STATE", "TASKS", "TITLE"]];
    for (const b of catalog.items) {
      rows.push([
        b.name,
        b.activeVersion?.version ?? "-",
        b.activeVersion?.state ?? "-",
        b.activeVersion ? String(b.activeVersion.taskCount) : "-",
        b.title ?? "-",
      ]);
    }
    for (const line of table(rows)) io.out(line);
    for (const line of upstreamNotices(catalog.items)) io.out(line);
    return 0;
  }

  if (sub !== "get") {
    throw new CliUsageError(`Unknown benchmarks subcommand "${sub}" (did you mean "benchmarks get ${sub}"?)`);
  }
  if (!ref) {
    throw new CliUsageError('"benchmarks get" requires a <name[@version]> ref');
  }
  const detail = await client.get(ref, pageOptions(inv));
  if (inv.flags.json === true) {
    io.out(JSON.stringify(detail));
  } else {
    for (const line of benchmarkDetailLines(detail)) io.out(line);
    for (const line of upstreamNotices([detail])) io.out(line);
  }
  return 0;
}

/**
 * One quiet line per benchmark whose upstream has moved, and the command that
 * acts on it.
 *
 * QUIET IS THE REQUIREMENT. This is an FYI printed under a table nobody asked
 * to be interrupted, so it is one line, it never appears when nothing moved,
 * and it never appears in --json output (a machine-readable stream must stay
 * machine-readable — the same fact is already on the `upstream` field there).
 *
 * It never offers to import for you. Importing creates an immutable version and
 * costs a build; that is a decision, and the line's whole job is to hand the
 * decision back with the exact command already written out.
 */
function upstreamNotices(
  items: { name: string; activeVersion: { version: string } | null; upstream: UpstreamStatus | null }[]
): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (!item.upstream?.moved) continue;
    const at = item.activeVersion ? `@${item.activeVersion.version}` : "";
    lines.push(
      `${item.name}${at} · upstream ${item.upstream.ref} moved — ` +
        `run: evolve-evals import --benchmark ${item.name} --version <new-version> ` +
        `--git-url <url> --ref ${item.upstream.ref}`
    );
  }
  return lines;
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

async function cmdCustomHarnesses(inv: Invocation, io: CliIO): Promise<number> {
  const client = customHarnesses(clientConfig(inv));
  const [sub, name] = inv.positionals;
  const json = inv.flags.json === true;

  if (sub === undefined) {
    const registered = await client.list(pageOptions(inv));
    if (json) {
      io.out(JSON.stringify(registered));
      return 0;
    }
    if (registered.items.length === 0) {
      io.out("No custom harnesses.");
      return 0;
    }
    const rows = [["NAME", "SOURCE", "RUN COMMAND", "UPDATED"]];
    for (const harness of registered.items) {
      rows.push([
        harness.name,
        harness.source,
        truncate(harness.runCommand, 60),
        harness.updatedAt,
      ]);
    }
    for (const line of table(rows)) io.out(line);
    return 0;
  }

  if (sub === "add") {
    if (name !== undefined) {
      throw new CliUsageError(`"custom-harnesses add" got unexpected argument "${name}"`);
    }
    const created = await client.create(buildCustomHarnessInput(inv));
    if (json) {
      io.out(JSON.stringify(created));
    } else {
      for (const line of customHarnessLines(created)) io.out(line);
      io.out("");
      io.out(`Use it with: evolve-evals run --agent ${created.name}:<model> …`);
    }
    return 0;
  }

  if (sub === "get") {
    if (!name) {
      throw new CliUsageError('"custom-harnesses get" requires a <name>');
    }
    const harness = await client.get(name);
    if (json) {
      io.out(JSON.stringify(harness));
    } else {
      for (const line of customHarnessLines(harness)) io.out(line);
    }
    return 0;
  }

  if (sub === "remove") {
    if (!name) {
      throw new CliUsageError('"custom-harnesses remove" requires a <name>');
    }
    await client.delete(name);
    if (json) {
      io.out(JSON.stringify({ name, deleted: true }));
    } else {
      io.out(`Deleted custom harness ${name}`);
    }
    return 0;
  }

  throw new CliUsageError(
    `Unknown custom-harnesses subcommand "${sub}" (supported: add, get, remove)`
  );
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
      case "trials":
        return await cmdTrials(inv, io);
      case "trial":
        return await cmdTrial(inv, io);
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
      case "custom-harnesses":
        return await cmdCustomHarnesses(inv, io);
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
