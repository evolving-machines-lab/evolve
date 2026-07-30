#!/usr/bin/env node
/**
 * evolve-evals — CLI for Evolve hosted datasets & jobs.
 *
 * Thin shell over the hosted client (datasets() / jobs() / trials()): plain
 * node arg parsing, no dependencies. Human-readable tables by default; --json
 * emits machine-readable JSON (NDJSON for --watch event streams).
 *
 * Exit codes: 0 success (watch: job COMPLETED / import COMPLETED), 1
 * runtime/API failure (watch: FAILED or CANCELLED), 2 usage error.
 *
 * SDK-RENAME SHIM — the command grammar below is the OLD grammar, kept only so
 * this file compiles and behaves against the renamed SDK surface; the CLI
 * regrammar is the NEXT stage's work. Every place where an old command is
 * bridged onto a renamed SDK verb or field is marked "CLI-STAGE:".
 */

import { readFileSync, realpathSync } from "fs";
import { pathToFileURL } from "url";
import { agents, datasets, jobs, trials } from "./index";
import type {
  Agent,
  AgentArm,
  AgentArmInput,
  AgentInput,
  CompareResponse,
  Dataset,
  DatasetImport,
  EvalSandboxProvider,
  HostedClientConfig,
  Job,
  JobCreate,
  JobEvent,
  PublishDatasetInput,
  Task,
  TraceEvent,
  Trial,
  TrialStatus,
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
  trial <trial-id>                  Show one trial in full detail
  trace <trial-id>                  Print a trial's trace events (--stream <raw-artifact>, --save <dir> for all)
  compare <id> <id> [...]           Compare 2-10 jobs side by side
  cancel <id>                       Request cancellation of a job
  rerun-failed <id>                 New job from a terminal job's failed trials
  regrade <id> [trial-id]           Re-run the verifier on recorded trials (whole job, or one trial)
  regrade-job <job-id>              Show a regrade job (a regrade IS a job)
  export <id>                       Download the results archive (gzipped)
  benchmarks                        List the dataset catalog
  benchmarks get <name[@version]>   Show one dataset (versions + tasks + providers)
  import                            Publish a dataset from a git source or a local directory (--watch to follow)
  import status <id>                Show one import job
  download <name[@version]>         Download the original corpus package (owner only)
  custom-harnesses                  List your registered agents
  custom-harnesses get <name>       Show one registered agent
  custom-harnesses add              Register an agent (install script or local directory)
  custom-harnesses remove <name>    Delete a registered agent
  help                              Show this help

Run options:
  --benchmark <name[@version]>        Dataset (required; bare name = active version)
  --tasks <k1,k2,...>                 Task names (default: every task of the version)
  --agent <agent:model[:version]>     Agent; repeatable (at least one required)
  --effort <value>                    Reasoning effort for EVERY agent (values:
                                      GET /api/meta limits.job.reasoning_efforts).
                                      Applied verbatim — an agent that cannot
                                      honor it is refused by the server,
                                      never silently skipped. Per-agent efforts
                                      need the SDK. Omitted: the server default.
  --runs <n>                          Attempts per task x agent (default 1)
  --concurrency <n>                   Parallel trials (default 4)
  --max-trial-spend <usd>             Model-spend cap for EACH trial (default: the server's, $200)
  --provider <e2b|daytona|modal>      e2b | daytona | modal, default e2b
  --watch                             Stream events until the job finishes

Trial options:
  --status <s1,s2,...>                Filter trials by status (e.g. INFRASTRUCTURE_ERROR)

Regrade options (whole-job regrade only):
  --status <s1,s2,...>                Only regrade source trials in these statuses
  --task <name>                       Only regrade source trials of this task

Trace options (--stream and --save are exclusive; --cursor/--limit page the events only):
  --cursor <seq>                      Resume after this trace seq (a trace cursor IS a seq)
  --limit <n>                         Max events per page
  --stream <artifact>                 Print ONE raw artifact instead: verifier |
                                      trace-stdout | trace-stderr | agent-home
  --save <dir>                        Save everything the trial recorded into <dir>:
                                      trace-parsed.jsonl, each raw log, agent-home/

Import options (a git source OR a local directory; --name and --version required):
  --git <url>                         Git repository URL (with --ref)
  --ref <ref>                         Git ref: branch, tag, or commit (with --git)
  --dir <path>                        Local corpus directory (tarred + uploaded)
  --name <dataset>                    Catalog dataset name to create or extend (required)
  --version <v>                       Version label for the imported version (required)
  --watch                             Poll until the import is COMPLETED or FAILED

Custom-harness options ("custom-harnesses add"; an install script OR a local directory):
  --name <agent>                      Agent name, later used in --agent (required)
  --install-script <path>             Install script file; its contents are uploaded
  --dir <path>                        Local agent directory (tarred + uploaded)
  --run <command>                     Run command, executed with sh -c (required)
  --env KEY=VALUE                     Env injected at run time; repeatable

Other options:
  --limit <n>, --cursor <c>           Pagination — one envelope on every collection
                                      (list, trials, trace, benchmarks, benchmarks get,
                                      custom-harnesses)
  --to <dir>                          Directory to save into, for export and download (default: current dir)
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
      effort: "string",
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
  // CLI-STAGE: a trial id is globally addressable now — one positional.
  "trial": {
    flags: {},
    minPositionals: 1,
    maxPositionals: 1,
    positionalUsage: "<trial-id>",
  },
  trace: {
    flags: { cursor: "string", limit: "number", stream: "string", save: "string" },
    minPositionals: 1,
    maxPositionals: 1,
    positionalUsage: "<trial-id>",
  },
  compare: {
    flags: {},
    minPositionals: 2,
    maxPositionals: 10,
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
  // CLI-STAGE: a regrade IS a job now; this verb is a plain job read.
  "regrade-job": {
    flags: {},
    minPositionals: 1,
    maxPositionals: 1,
    positionalUsage: "<job-id>",
  },
  export: {
    flags: { to: "string" },
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
  // CLI-STAGE: the positional is a dataset ref now (packages are addressed by
  // dataset name@version, not by import id).
  download: {
    flags: { to: "string" },
    minPositionals: 1,
    maxPositionals: 1,
    positionalUsage: "<name[@version]>",
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

/** Parse "agent:model[:version]" (version may itself contain colons). */
export function parseJobAgent(spec: string): AgentArmInput {
  const first = spec.indexOf(":");
  if (first <= 0 || first === spec.length - 1) {
    throw new CliUsageError(`Invalid --agent "${spec}": expected agent:model[:version]`);
  }
  const name = spec.slice(0, first);
  const rest = spec.slice(first + 1);
  const second = rest.indexOf(":");
  if (second === -1) return { name, model_name: rest };
  const model = rest.slice(0, second);
  const version = rest.slice(second + 1);
  if (!model || !version) {
    throw new CliUsageError(`Invalid --agent "${spec}": expected agent:model[:version]`);
  }
  return { name, model_name: model, version };
}

/**
 * Build the POST /api/jobs body from a parsed `run` invocation.
 *
 * CLI-STAGE: --benchmark/--tasks are bridged onto the datasets-list shape —
 * one selector, exact task names as the include filter. The multi-dataset and
 * glob grammar arrives with the CLI regrammar.
 */
export function buildJobInput(inv: Invocation): JobCreate {
  const f = inv.flags;
  let taskNames: string[] | undefined;
  if (f.tasks !== undefined) {
    taskNames = String(f.tasks)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (taskNames.length === 0) {
      throw new CliUsageError("--tasks got an empty task list");
    }
  }
  const ref = String(f.benchmark);
  const at = ref.indexOf("@");
  const selector: JobCreate["datasets"][number] = {
    name: at === -1 ? ref : ref.slice(0, at),
    ...(at !== -1 ? { version: ref.slice(at + 1) } : {}),
    ...(taskNames !== undefined ? { task_names: taskNames } : {}),
  };
  return {
    datasets: [selector],
    // --effort is stamped on EVERY agent, verbatim. The server owns the
    // per-agent refusal (a level on gemini is a 400 naming the agent), so
    // the CLI never edits the list to dodge one — silently dropping the value
    // for some agents would run a sweep the flag no longer describes.
    agents: (f.agent as string[]).map((spec) => {
      const agent = parseJobAgent(spec);
      return f.effort !== undefined ? { ...agent, reasoning_effort: f.effort as string } : agent;
    }),
    ...(f.runs !== undefined ? { n_attempts: f.runs as number } : {}),
    ...(f.concurrency !== undefined ? { n_concurrent_trials: f.concurrency as number } : {}),
    ...(f["max-trial-spend"] !== undefined
      ? { max_trial_spend_usd: f["max-trial-spend"] as number }
      : {}),
    ...(f.provider !== undefined
      ? { sandbox_provider: f.provider as EvalSandboxProvider }
      : {}),
  };
}

/** Build the datasets().publish() input from a parsed `import` invocation. */
export function buildImportInput(inv: Invocation): PublishDatasetInput {
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
      name: f.name as string,
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
    source: { git_url: f.git as string, git_ref: f.ref as string },
    name: f.name as string,
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
 * Build the agents().create() input from a parsed `custom-harnesses add`
 * invocation. `--install-script` names a FILE; its contents are what the SDK
 * uploads.
 */
export function buildCustomHarnessInput(
  inv: Invocation,
  readScript: (path: string) => string = (path) => readFileSync(path, "utf-8")
): AgentInput {
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
      '"custom-harnesses add" requires --install-script (or --dir for a local agent directory)'
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
      : { install_script: readScript(f["install-script"] as string) }),
    run_command: f.run as string,
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

function fmtAgent(agent: AgentArm | AgentArmInput): string {
  const base = `${agent.name}:${agent.model_name}`;
  return agent.version ? `${base}:${agent.version}` : base;
}

function fmtDatasets(refs: { name: string; version: string }[]): string {
  return refs.map((ref) => `${ref.name}@${ref.version}`).join(", ") || "-";
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function jobLines(e: Job): string[] {
  // Row order mirrors the input contract: datasets, agents, size, attempts,
  // concurrency, spend caps.
  const rows: string[][] = [
    ["id", e.id],
    ["status", e.status],
    ["datasets", fmtDatasets(e.datasets)],
  ];
  rows.push(["agents", e.agents.map(fmtAgent).join(", ")]);
  rows.push([
    "size",
    `${e.counts.agents} agent(s) x ${e.counts.tasks} task(s) = ${e.n_total_trials} trial(s)`,
  ]);
  rows.push(["attempts/task", String(e.n_attempts)]);
  rows.push(["concurrency", String(e.n_concurrent_trials)]);
  rows.push(["max spend/trial", fmtUsd(e.max_trial_spend_usd)]);
  rows.push(["worst case", fmtUsd(e.worst_case_spend_usd)]);
  rows.push(["provider", e.sandbox_provider]);
  rows.push(["spent", fmtUsd(e.stats.cost_usd)]);
  // Only the statuses actually present: the response names all of them (so a
  // client never hardcodes the enum), but a row of eight zeros helps nobody.
  const histogram = Object.entries(e.trials.byStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`)
    .join(" · ");
  if (histogram) rows.push(["trials", histogram]);
  for (const source of e.source_jobs) {
    rows.push([source.action === "regrade" ? "regrade of" : "resume of", source.job_id]);
  }
  if (e.idempotent_replay) rows.push(["note", "idempotent replay of an existing job"]);
  if (e.failure) rows.push(["failure", `${e.failure.code}: ${e.failure.message}`]);
  rows.push(["started", e.started_at]);
  rows.push(["updated", e.updated_at]);
  return table(rows);
}

function jobRow(e: Job): string[] {
  return [
    e.id,
    e.status,
    fmtDatasets(e.datasets),
    String(e.trials.total),
    fmtUsd(e.stats.cost_usd),
    e.started_at,
  ];
}

function trialRow(run: Trial): string[] {
  return [
    run.task_name,
    fmtAgent({
      name: run.agent_info.name,
      model_name: run.agent_info.model_info.name,
      version: run.agent_info.version,
      reasoning_effort: run.agent_info.reasoning_effort ?? null,
    }),
    String(run.attempt),
    run.status,
    run.reward !== null ? String(run.reward) : "-",
    fmtUsd(run.agent_result?.cost_usd),
    run.id,
  ];
}

/**
 * Full-detail rendering of one trial — evolve-evals trial. Exported for tests,
 * like the other line renderers.
 */
export function trialDetailLines(run: Trial): string[] {
  const rows: string[][] = [
    ["trial id", run.id],
    ["job", run.job_id],
    ["task", run.task_name],
    ["dataset", run.source],
    ["agent", `${run.agent_info.name}:${run.agent_info.model_info.name}`],
    ["attempt", String(run.attempt)],
    ["status", run.status],
    ["reward", run.reward !== null ? String(run.reward) : "-"],
  ];
  const rewards = run.verifier_result?.rewards;
  if (rewards && Object.keys(rewards).length > 0) {
    rows.push([
      "rewards",
      Object.entries(rewards)
        .map(([key, value]) => `${key}=${value}`)
        .join(" · "),
    ]);
  }
  rows.push(["spent", fmtUsd(run.agent_result?.cost_usd)]);
  // WHILE THE TRIAL RUNS, show the live sample beside the (still empty) settled
  // figure. It is a lagging lower bound, and the row says so with "at least";
  // once the trial settles, agent_result.cost_usd is the truth and this row
  // disappears. Four decimals rather than fmtUsd's two: a run minutes in has
  // often spent fractions of a cent, and "at least $0.00" would say nothing.
  if (
    (run.status === "RUNNING" || run.status === "SCORING") &&
    run.live_spent_usd !== null
  ) {
    const asOf = run.live_spend_at ? ` as of ${run.live_spend_at}` : "";
    rows.push(["spent (live)", `at least $${run.live_spent_usd.toFixed(4)}${asOf}`]);
  }
  if (run.attempt_phase) rows.push(["phase", run.attempt_phase]);
  if (run.sandbox_provider) rows.push(["provider", run.sandbox_provider]);
  if (run.sandbox_id) rows.push(["sandbox", run.sandbox_id]);
  if (run.verifier_environment_mode) rows.push(["verifier", run.verifier_environment_mode]);
  if (run.verifier_sandbox_id) rows.push(["verifier sandbox", run.verifier_sandbox_id]);
  if (run.agent_info.version) rows.push(["agent version", run.agent_info.version]);
  if (run.exception_info) {
    rows.push(["failure type", run.exception_info.exception_type]);
    rows.push(["failure detail", run.exception_info.exception_message]);
  }
  if (run.session_ref) rows.push(["session", run.session_ref]);
  if (run.started_at) rows.push(["started", run.started_at]);
  if (run.finished_at) rows.push(["finished", run.finished_at]);
  return table(rows);
}

/**
 * One registered agent — evolve-evals custom-harnesses get / add. Declared env
 * is shown by KEY only; the values were the caller's to set and are not echoed
 * back into a terminal. `--json` carries the response verbatim.
 */
function customHarnessLines(agent: Agent): string[] {
  const rows: string[][] = [
    ["name", agent.name],
    ["source", agent.source],
    ["run command", agent.run_command],
  ];
  const envKeys = Object.keys(agent.env ?? {});
  if (envKeys.length > 0) rows.push(["env", envKeys.sort().join(", ")]);
  rows.push(["created", agent.created_at]);
  rows.push(["updated", agent.updated_at]);
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
export function traceEventLine(event: TraceEvent): string {
  const detail = truncate(JSON.stringify(event.data ?? {}), 140);
  return `#${String(event.seq).padStart(4)} ${event.type.padEnd(26)} ${detail}`.trimEnd();
}

/** One line for a structured import failure: the message plus a failure count. */
function importFailureText(failure: NonNullable<DatasetImport["failure"]>): string {
  const failures = failure.failures?.length
    ? ` (${failure.failures.length} task failure${failure.failures.length === 1 ? "" : "s"})`
    : "";
  return `${failure.message}${failures}`;
}

function importLines(job: DatasetImport): string[] {
  const rows: string[][] = [
    ["id", job.id],
    ["status", job.status],
  ];
  if (job.name !== undefined) rows.push(["dataset", job.name]);
  if (job.version !== undefined) rows.push(["version", job.version]);
  if (job.task_count !== undefined) rows.push(["tasks", String(job.task_count)]);
  for (const warning of job.warnings) {
    rows.push(["warning", warning.message ?? warning.code]);
  }
  if (job.failure) {
    rows.push(["failure", importFailureText(job.failure)]);
    for (const failure of job.failure.failures ?? []) {
      rows.push([`  ${failure.task_name}`, failure.error]);
    }
  }
  return table(rows);
}

/** Compact one-line rendering of one import status change for --watch. */
export function importStatusLine(job: DatasetImport): string {
  const parts: string[] = [];
  if (job.task_count !== undefined) parts.push(`tasks=${job.task_count}`);
  if (job.failure) parts.push(truncate(importFailureText(job.failure), 140));
  return `status ${job.status.padEnd(12)} ${parts.join(" ")}`.trimEnd();
}

/** Compact one-line rendering of one SSE event for --watch. */
export function eventLine(event: JobEvent): string {
  // JobEvent is a discriminated union, so `data` is a different shape per
  // type. This renderer is deliberately shape-agnostic — it prints the salient
  // fields first and then everything else — so it reads the payload as a plain
  // record ONCE, here, rather than narrowing nine ways to print one line.
  const data: Record<string, unknown> = { ...(event.data ?? {}) };
  const parts: string[] = [];
  if (typeof data.trial_id === "string") parts.push(data.trial_id);
  if (typeof data.task_name === "string") parts.push(data.task_name);
  if (typeof data.status === "string") parts.push(data.status);
  if (typeof data.reward === "number") parts.push(`reward=${data.reward}`);
  const used = new Set(["trial_id", "task_name", "status", "reward"]);
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

  const created = await client.start(input);
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
    io.out(`Job ${created.id} (${fmtDatasets(created.datasets)}) ${created.status} — watching…`);
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
  const rows = [["ID", "STATUS", "DATASETS", "TRIALS", "SPENT", "STARTED"]];
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
  const rows = [["TASK", "AGENT", "ATTEMPT", "STATUS", "REWARD", "SPENT", "TRIAL ID"]];
  for (const run of page.items) rows.push(trialRow(run));
  for (const line of table(rows)) io.out(line);
  io.out(`\n${page.items.length} trial(s) shown`);
  if (page.nextCursor) {
    io.out(`More: evolve-evals trials ${inv.positionals[0]} --cursor ${page.nextCursor}`);
  }
  return 0;
}

async function cmdTrial(inv: Invocation, io: CliIO): Promise<number> {
  // CLI-STAGE: globally addressable — one positional, the trial id.
  const client = trials(clientConfig(inv));
  const run = await client.get(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(run));
  } else {
    for (const line of trialDetailLines(run)) io.out(line);
  }
  return 0;
}

async function cmdTrace(inv: Invocation, io: CliIO): Promise<number> {
  // CLI-STAGE: globally addressable — one positional, the trial id.
  const client = trials(clientConfig(inv));
  const trialId = inv.positionals[0];
  const json = inv.flags.json === true;

  // --stream, --save, and the paged event listing are three mutually
  // exclusive output modes; mixing them is a usage error, never a silent
  // precedence. --stream + --save is ambiguous (one artifact or all of
  // them?), and --cursor/--limit page only the parsed events — under
  // --stream/--save they would be accepted-but-dead flags.
  const stream = inv.flags.stream as string | undefined;
  const saveDir = inv.flags.save as string | undefined;
  if (stream !== undefined && saveDir !== undefined) {
    throw new CliUsageError('"trace" takes EITHER --stream OR --save, not both');
  }
  if ((stream !== undefined || saveDir !== undefined) && (inv.flags.cursor !== undefined || inv.flags.limit !== undefined)) {
    throw new CliUsageError("--cursor/--limit page the parsed events; they do not apply to --stream/--save");
  }

  // --stream: one RAW artifact instead of the parsed events.
  if (stream !== undefined) {
    if (stream === "verifier" || stream === "trace-stdout" || stream === "trace-stderr") {
      const log = await client.artifact(trialId, stream);
      if (log === null) {
        io.out(json ? JSON.stringify({ log: null }) : `No ${stream} log was stored for this trial.`);
        return 0;
      }
      io.out(json ? JSON.stringify({ log }) : log);
      return 0;
    }
    if (stream === "agent-home") {
      const files = await client.artifact(trialId, stream);
      if (files === null) {
        io.out(json ? JSON.stringify({ files: null }) : `No ${stream} content was stored for this trial.`);
        return 0;
      }
      if (json) {
        io.out(JSON.stringify({ files }));
      } else {
        for (const [path, content] of Object.entries(files)) {
          io.out(`===== ${path} (${Buffer.byteLength(content, "utf8")} bytes) =====`);
          io.out(content);
        }
      }
      return 0;
    }
    throw new CliUsageError('--stream must be "verifier", "trace-stdout", "trace-stderr" or "agent-home"');
  }

  // --save <dir>: everything a trial recorded, one directory. The parsed
  // events land as trace-parsed.jsonl; each raw log under its own name; the
  // agent's home folder under agent-home/ with its sandbox paths preserved.
  if (saveDir !== undefined) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    await mkdir(saveDir, { recursive: true });
    const lines: string[] = [];
    for await (const event of client.traceEvents(trialId)) {
      lines.push(JSON.stringify(event));
    }
    await writeFile(join(saveDir, "trace-parsed.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""));
    io.out(`trace-parsed.jsonl (${lines.length} events)`);
    for (const which of ["verifier", "trace-stdout", "trace-stderr"] as const) {
      const log = await client.artifact(trialId, which);
      if (log === null) continue;
      await writeFile(join(saveDir, `${which}.log`), log);
      io.out(`${which}.log (${Buffer.byteLength(log, "utf8")} bytes)`);
    }
    const home = await client.artifact(trialId, "agent-home");
    if (home !== null) {
      for (const [path, content] of Object.entries(home)) {
        const target = join(saveDir, "agent-home", ...path.split("/").filter(Boolean));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      io.out(`agent-home/ (${Object.keys(home).length} files)`);
    }
    return 0;
  }

  let count = 0;
  for await (const event of client.traceEvents(trialId, {
    ...(inv.flags.cursor !== undefined ? { cursor: String(inv.flags.cursor) } : {}),
    ...(inv.flags.limit !== undefined ? { limit: inv.flags.limit as number } : {}),
  })) {
    io.out(json ? JSON.stringify(event) : traceEventLine(event));
    count += 1;
  }
  if (!json && count === 0) io.out("No trace events.");
  return 0;
}

function comparisonLines(comparison: CompareResponse): string[] {
  const lines: string[] = [];
  const aggregateRows = [["ID", "DATASETS", "STATUS", "MEAN REWARD", "COVERAGE", "SPENT"]];
  for (const agg of comparison.jobs) {
    aggregateRows.push([
      agg.id,
      fmtDatasets(agg.datasets),
      agg.status,
      fmtReward(agg.mean_reward),
      `${agg.coverage.scored}/${agg.coverage.total}`,
      fmtUsd(agg.cost_usd),
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
      const cellById = new Map(row.cells.map((cell) => [cell.job_id, cell]));
      matrixRows.push([
        row.task_name,
        row.disagreement ? "!" : "",
        ...columnOrder.map((id) => {
          const cell = cellById.get(id);
          if (!cell) return "-";
          return cell.mean_reward !== null
            ? `${cell.status} ${fmtReward(cell.mean_reward)}`
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
  // CLI-STAGE: "rerun-failed" is bridged onto jobs().resume().
  const client = jobs(clientConfig(inv));
  const e = await client.resume(inv.positionals[0]);
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
  // CLI-STAGE: a regrade returns a JOB now; both forms print the job body.
  const [id, trialId] = inv.positionals;
  let job: Job;
  if (trialId !== undefined) {
    // Per-trial regrade takes no --status/--task filter (a single trial needs none).
    if (inv.flags.status !== undefined || inv.flags.task !== undefined) {
      throw new CliUsageError("--status/--task apply to a whole-job regrade, not a single trial");
    }
    job = await trials(clientConfig(inv)).regrade(trialId);
  } else {
    const req: { statuses?: TrialStatus[]; task_name?: string } = {};
    if (inv.flags.status !== undefined) {
      const statuses = String(inv.flags.status)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as TrialStatus[];
      if (statuses.length === 0) throw new CliUsageError("--status got an empty status list");
      req.statuses = statuses;
    }
    if (inv.flags.task !== undefined) req.task_name = String(inv.flags.task);
    job = await jobs(clientConfig(inv)).regrade(id, req);
  }
  if (inv.flags.json === true) {
    io.out(JSON.stringify(job));
  } else {
    for (const line of jobLines(job)) io.out(line);
    io.out("");
    io.out(`Follow it with: evolve-evals get ${job.id}`);
  }
  return 0;
}

async function cmdRegradeJob(inv: Invocation, io: CliIO): Promise<number> {
  // CLI-STAGE: a regrade IS a job — this verb is a plain job read now.
  const client = jobs(clientConfig(inv));
  const job = await client.get(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(job));
  } else {
    for (const line of jobLines(job)) io.out(line);
  }
  return 0;
}

async function cmdExport(inv: Invocation, io: CliIO): Promise<number> {
  // CLI-STAGE: "export" is bridged onto jobs().download(); the standard
  // results layout is the only layout, so --format is gone.
  const client = jobs(clientConfig(inv));
  const filePath = await client.download(inv.positionals[0], {
    to: (inv.flags.to as string | undefined) ?? process.cwd(),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify({ path: filePath }));
  } else {
    io.out(`Saved ${filePath}`);
  }
  return 0;
}

/**
 * Save a version's original corpus package. The mirror image of `import`, and
 * shaped like `export`: default to the working directory, print the path.
 *
 * OWNER ONLY on the server, so a dataset someone else owns reports not-found —
 * the same answer as a bad name, on purpose.
 */
async function cmdDownload(inv: Invocation, io: CliIO): Promise<number> {
  const client = datasets(clientConfig(inv));
  const filePath = await client.download(inv.positionals[0], {
    to: (inv.flags.to as string | undefined) ?? process.cwd(),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify({ path: filePath }));
  } else {
    io.out(`Saved ${filePath}`);
  }
  return 0;
}

function benchmarkDetailLines(b: Dataset): string[] {
  const lines = table([
    ["name", b.name],
    ["title", b.title ?? "-"],
    ["description", b.description ?? "-"],
    ["active version", b.active_version?.version ?? "-"],
  ]);
  if (b.versions && b.versions.length > 0) {
    lines.push("");
    const rows = [["VERSION", "STATE", "TASKS", "CREATED"]];
    for (const v of b.versions) {
      rows.push([v.version, v.state, String(v.task_count), v.created_at ?? "-"]);
    }
    lines.push(...table(rows));
  }
  if (b.tasks && b.tasks.items.length > 0) {
    lines.push("", `Tasks (version ${b.selected_version?.version ?? "?"}):`);
    const rows = [["TASK", "AGENT TIMEOUT", "VERIFIER TIMEOUT", "PROVIDERS"]];
    for (const t of b.tasks.items) {
      rows.push([t.task_name, `${t.agent_timeout_sec}s`, `${t.verifier_timeout_sec}s`, fmtProviders(t.providers)]);
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
  // CLI-STAGE: "benchmarks" is bridged onto the datasets() client.
  const client = datasets(clientConfig(inv));
  const [sub, ref] = inv.positionals;

  if (sub === undefined) {
    const catalog = await client.list(pageOptions(inv));
    if (inv.flags.json === true) {
      io.out(JSON.stringify(catalog));
      return 0;
    }
    if (catalog.items.length === 0) {
      io.out("No datasets.");
      return 0;
    }
    const rows = [["NAME", "ACTIVE", "STATE", "TASKS", "TITLE"]];
    for (const b of catalog.items) {
      rows.push([
        b.name,
        b.active_version?.version ?? "-",
        b.active_version?.state ?? "-",
        b.active_version ? String(b.active_version.task_count) : "-",
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
 * One quiet line per dataset whose upstream has moved, and the command that
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
  items: { name: string; active_version: { version: string } | null; upstream: UpstreamStatus | null }[]
): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (!item.upstream?.moved) continue;
    const at = item.active_version ? `@${item.active_version.version}` : "";
    lines.push(
      `${item.name}${at} · upstream ${item.upstream.ref} moved — ` +
        `run: evolve-evals import --name ${item.name} --version <new-version> ` +
        `--git <url> --ref ${item.upstream.ref}`
    );
  }
  return lines;
}

async function cmdImport(inv: Invocation, io: CliIO): Promise<number> {
  // CLI-STAGE: "import" is bridged onto datasets().publish().
  const [sub, id] = inv.positionals;
  const json = inv.flags.json === true;
  const client = datasets(clientConfig(inv));

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
  const created = await client.publish(input);
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
    io.out(JSON.stringify({ kind: "import.created", datasetImport: created }));
  } else {
    io.out(`Import ${created.id} (${input.name}) ${created.status} — watching…`);
  }

  const final = await client.watchImport(created.id, {
    onStatus: (job) => {
      io.out(json ? JSON.stringify({ kind: "import.status", datasetImport: job }) : importStatusLine(job));
    },
  });

  if (json) {
    io.out(JSON.stringify({ kind: "import.final", datasetImport: final }));
  } else {
    io.out("");
    for (const line of importLines(final)) io.out(line);
  }
  return final.status === "FAILED" ? 1 : 0;
}

async function cmdCustomHarnesses(inv: Invocation, io: CliIO): Promise<number> {
  // CLI-STAGE: "custom-harnesses" is bridged onto the agents() client.
  const client = agents(clientConfig(inv));
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
    for (const agent of registered.items) {
      rows.push([
        agent.name,
        agent.source,
        truncate(agent.run_command, 60),
        agent.updated_at,
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
    const agent = await client.get(name);
    if (json) {
      io.out(JSON.stringify(agent));
    } else {
      for (const line of customHarnessLines(agent)) io.out(line);
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
      case "download":
        return await cmdDownload(inv, io);
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
//
// argv[1] is the path the process was STARTED with, which after a normal
// install is node_modules/.bin/evolve-evals — a SYMLINK. Node dereferences
// symlinks when it builds import.meta.url, so the two agree only once argv[1]
// is resolved as well; comparing the raw path made the installed bin a silent
// no-op. The raw form is still tried first: it serves direct, relative and
// Windows-shim invocation without a syscall, and the realpath fallback is what
// makes the symlinked bin work. (A --preserve-symlinks-main bin never reaches
// this gate — the bundle's chunk import fails resolution before it.)
const invokedAsBin = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const isThisModule = (path: string): boolean => {
    try {
      return import.meta.url === pathToFileURL(path).href;
    } catch {
      return false;
    }
  };
  if (isThisModule(entry)) return true;
  try {
    return isThisModule(realpathSync(entry));
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
