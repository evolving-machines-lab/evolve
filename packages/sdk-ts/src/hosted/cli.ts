#!/usr/bin/env node
/**
 * evolve-evals — CLI for Evolve hosted datasets & jobs.
 *
 * Noun-verb grammar over the hosted client: `evolve-evals <noun> <verb>`,
 * with `run` as the one top-level shortcut (alias of `job start`). Singular
 * nouns are canonical; the plurals parse as hidden aliases. The CLI speaks
 * ONLY through the SDK clients (datasets() / agents() / jobs() / trials() /
 * auth()) — no raw HTTP lives here.
 *
 * Output: human tables on a TTY, tab-separated rows when piped, --json for
 * the rendered machine shape (NDJSON for --watch event streams), -q for
 * ids-only lists. Exit codes: 0 success (watch: job COMPLETED / publish
 * COMPLETED), 1 runtime/API failure (watch: FAILED or CANCELLED), 2 usage
 * error.
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import {
  EVAL_SANDBOX_PROVIDERS,
  EvolveApiError,
  TRIAL_ARTIFACT_STREAMS,
  TRIAL_STATUSES,
  agents,
  auth,
  datasets,
  jobs,
  trials,
} from "./index";
import type {
  Agent,
  AgentArm,
  AgentArmInput,
  AgentInput,
  AuthStatus,
  CompareResponse,
  Dataset,
  DatasetImport,
  DatasetSelector,
  EvalSandboxProvider,
  HostedClientConfig,
  Job,
  JobCreate,
  JobEvent,
  JobTaskRollup,
  PublishDatasetInput,
  StopResponse,
  Task,
  TraceEvent,
  Trial,
  TrialStatus,
  UpstreamStatus,
} from "./types";

// =============================================================================
// GRAMMAR
// =============================================================================

/** Usage-level error: bad command line, not a runtime failure. Exit code 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

type FlagKind = "string" | "number" | "boolean" | "repeat";

interface FlagSpec {
  kind: FlagKind;
  /** Single-letter short form, e.g. "d" for -d. */
  short?: string;
  /** Extra long spellings, e.g. ["ae"] registers --ae. */
  aliases?: string[];
  /** Metavar for help output. */
  value?: string;
  help: string;
}

interface CommandSpec {
  summary: string;
  flags: Record<string, FlagSpec>;
  minPositionals: number;
  maxPositionals: number;
  positionalUsage?: string;
  example: string;
}

/**
 * The four global flags, valid on every command. -q is NOT global: it means
 * "ids only" on lists and "suppress the event log" on start, so each command
 * that has a quiet behavior declares it.
 */
const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: { kind: "boolean", help: "Machine-readable JSON output" },
  "api-key": { kind: "string", value: "<key>", help: "API key (default: $EVOLVE_API_KEY)" },
  "base-url": { kind: "string", value: "<url>", help: "API base URL (default: the Evolve dashboard API)" },
};

/** The shared read-side flags every list command carries. */
const LIST_FLAGS: Record<string, FlagSpec> = {
  limit: { kind: "number", short: "l", value: "<n>", help: "Page size" },
  cursor: { kind: "string", value: "<c>", help: "Resume from a page cursor" },
  columns: {
    kind: "string",
    value: "<keys|all|help>",
    help: "Choose and order columns (comma-separated keys; 'help' lists them)",
  },
  quiet: { kind: "boolean", short: "q", help: "Print only ids, one per line (for piping)" },
  "no-trunc": { kind: "boolean", help: "Full cell content instead of one-line truncation" },
  "no-headers": { kind: "boolean", help: "Omit the header row in piped (TSV) output" },
};

const JOB_START_FLAGS: Record<string, FlagSpec> = {
  config: {
    kind: "string",
    short: "c",
    value: "<path>",
    help: "Job config file (YAML or JSON, spec vocabulary); explicit flags override its fields",
  },
  "print-config": { kind: "boolean", help: "Print the resolved job body as JSON and exit without running" },
  "job-name": { kind: "string", value: "<name>", help: "User-facing label (server-generated when omitted)" },
  dataset: {
    kind: "repeat",
    short: "d",
    value: "<name[@version]>",
    help: "Dataset to run (repeatable; bare name = active version)",
  },
  "include-task-name": {
    kind: "repeat",
    short: "i",
    value: "<glob>",
    help: "Include filter over task names, applied to every dataset (repeatable)",
  },
  "exclude-task-name": {
    kind: "repeat",
    short: "x",
    value: "<glob>",
    help: "Exclude filter over task names, applied to every dataset (repeatable)",
  },
  "n-tasks": {
    kind: "number",
    short: "l",
    value: "<n>",
    help: "Cap the task count of EACH dataset after filters",
  },
  agent: { kind: "string", short: "a", value: "<name[@version]>", help: "Agent (built-in or registered)" },
  model: { kind: "repeat", short: "m", value: "<name>", help: "Model (repeatable; each model is one arm)" },
  effort: {
    kind: "string",
    value: "<value>",
    help:
      "Reasoning effort for EVERY arm (values: GET /api/meta). Applied verbatim — " +
      "an agent that cannot honor it is refused by the server, never silently skipped",
  },
  "agent-env": {
    kind: "repeat",
    aliases: ["ae"],
    value: "KEY=VALUE",
    help: "Env for every agent run (repeatable); a pass-through slot the server owns",
  },
  "verifier-env": {
    kind: "repeat",
    aliases: ["ve"],
    value: "KEY=VALUE",
    help: "Env for every verifier run (repeatable); a pass-through slot the server owns",
  },
  "n-attempts": { kind: "number", short: "k", value: "<n>", help: "Attempts per task x arm (default 1)" },
  "n-concurrent": { kind: "number", short: "n", value: "<n>", help: "Parallel trials (default 4)" },
  "max-trial-spend": {
    kind: "number",
    value: "<usd>",
    help: "Model-spend cap for EACH trial (default: the server's, $200)",
  },
  env: { kind: "string", short: "e", value: "<provider>", help: "Sandbox provider: e2b | daytona | modal (default e2b)" },
  watch: { kind: "boolean", help: "Stream events until the job finishes" },
  quiet: { kind: "boolean", short: "q", help: "With --watch: suppress the event log, print the final block only" },
  yes: {
    kind: "boolean",
    short: "y",
    // Reserved so the letter never grows a confirmation meaning: a hosted run
    // has no host environment to confirm access to, so there is nothing to say
    // yes to and the flag changes nothing.
    help: "Accepted for compatibility; hosted runs have no prompt to confirm",
  },
};

interface GroupSpec {
  summary: string;
  commands: Record<string, CommandSpec>;
}

const GROUPS: Record<string, GroupSpec> = {
  job: {
    summary: "Start, follow, and derive jobs",
    commands: {
      start: {
        summary: "Start a job (add --watch to follow it)",
        flags: JOB_START_FLAGS,
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve-evals job start -d deep-swe@1.1 -a codex -m gpt-5.5 -k 2 --watch",
      },
      list: {
        summary: "List your jobs (newest first)",
        flags: {
          ...LIST_FLAGS,
          search: { kind: "string", value: "<text>", help: "Free-text filter over job name and dataset names" },
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve-evals job list --limit 20 -q",
      },
      show: {
        summary: "Show one or more jobs in full",
        flags: {},
        minPositionals: 1,
        maxPositionals: Infinity,
        positionalUsage: "<id> [id...]",
        example: "evolve-evals job show cme12ab34",
      },
      trials: {
        summary: "List a job's trials",
        flags: {
          ...LIST_FLAGS,
          status: { kind: "string", value: "<s1,s2,...>", help: "Filter by trial status (e.g. INFRASTRUCTURE_ERROR)" },
          dataset: { kind: "string", value: "<name>", help: "Filter to one dataset's trials" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve-evals job trials cme12ab34 --status FAILED,SCORING_ERROR",
      },
      tasks: {
        summary: "Per-task rollup of a job",
        flags: { ...LIST_FLAGS },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve-evals job tasks cme12ab34",
      },
      compare: {
        summary: "Compare 2-10 jobs side by side",
        flags: {},
        minPositionals: 2,
        maxPositionals: 10,
        positionalUsage: "<id> <id> [...]",
        example: "evolve-evals job compare cme12ab34 cme56cd78",
      },
      cancel: {
        summary: "Request cancellation of a job",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve-evals job cancel cme12ab34",
      },
      stop: {
        summary: "Stop one dataset's live trials without cancelling the job",
        flags: {
          dataset: { kind: "string", value: "<name>", help: "The dataset whose live trials to stop (required)" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve-evals job stop cme12ab34 --dataset deep-swe",
      },
      resume: {
        summary: "New linked job over a terminal job's failed or stopped trials",
        flags: {
          "filter-error-type": {
            kind: "repeat",
            short: "f",
            value: "<type>",
            help:
              "Failure types to resume, matched on exception_info.exception_type " +
              "(repeatable; default: the standard failure set plus stopped trials)",
          },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve-evals job resume cme12ab34 -f InfrastructureError",
      },
      regrade: {
        summary: "Verifier-only re-run of a terminal job (the result IS a job)",
        flags: {
          status: { kind: "string", value: "<s1,s2,...>", help: "Only regrade source trials in these statuses" },
          task: { kind: "string", value: "<name>", help: "Only regrade source trials of this task" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve-evals job regrade cme12ab34 --task tricky-task",
      },
      download: {
        summary: "Download the results archive (gzipped)",
        flags: {
          "output-dir": { kind: "string", short: "o", value: "<dir>", help: "Directory to save into (default: current dir)" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve-evals job download cme12ab34 -o results/",
      },
    },
  },
  trial: {
    summary: "Inspect, download, and act on single trials",
    commands: {
      show: {
        summary: "Show one trial in full detail",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<trial-id>",
        example: "evolve-evals trial show cmt90ef12",
      },
      download: {
        summary: "Save everything a trial recorded, or stream one artifact",
        flags: {
          "output-dir": {
            kind: "string",
            short: "o",
            value: "<dir>",
            help: "Directory to save under (default: trials/); files land in <dir>/<trial-id>/",
          },
          overwrite: { kind: "boolean", help: "Replace an existing <dir>/<trial-id>/" },
          stream: {
            kind: "string",
            value: "<artifact>",
            help:
              "Print ONE artifact to stdout instead of saving: trace-parsed | verifier | " +
              "trace-stdout | trace-stderr | trajectory (not served yet) | agent-home",
          },
          cursor: { kind: "string", value: "<seq>", help: "With --stream trace-parsed: resume after this seq" },
          limit: { kind: "number", value: "<n>", help: "With --stream trace-parsed: max events per page" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<trial-id>",
        example: "evolve-evals trial download cmt90ef12 --stream trace-stdout",
      },
      regrade: {
        summary: "Verifier-only re-run of one trial (the result IS a job)",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<trial-id>",
        example: "evolve-evals trial regrade cmt90ef12",
      },
      stop: {
        summary: "Stop in-flight trials without cancelling their job",
        flags: {},
        minPositionals: 1,
        maxPositionals: Infinity,
        positionalUsage: "<trial-id> [trial-id...]",
        example: "evolve-evals trial stop cmt90ef12 cmt34gh56",
      },
    },
  },
  dataset: {
    summary: "Browse and publish the dataset catalog",
    commands: {
      list: {
        summary: "List the dataset catalog",
        flags: {
          ...LIST_FLAGS,
          search: { kind: "string", value: "<text>", help: "Free-text filter over name and description" },
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve-evals dataset list -q",
      },
      show: {
        summary: "Show one dataset (versions + tasks + providers)",
        flags: {
          limit: { kind: "number", short: "l", value: "<n>", help: "Task-list page size" },
          cursor: { kind: "string", value: "<c>", help: "Resume the task list from a cursor" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<name[@version]>",
        example: "evolve-evals dataset show deep-swe@1.1",
      },
      publish: {
        summary: "Publish a dataset version from a git source or a local directory",
        flags: {
          git: { kind: "string", value: "<url>", help: "Git repository URL (with --ref)" },
          ref: { kind: "string", value: "<ref>", help: "Git ref: branch, tag, or commit (with --git)" },
          dir: { kind: "string", value: "<path>", help: "Local corpus directory (tarred + uploaded)" },
          name: { kind: "string", value: "<dataset>", help: "Catalog dataset name to create or extend (required)" },
          version: { kind: "string", value: "<v>", help: "Version label for the published version (required)" },
          watch: { kind: "boolean", help: "Poll until the publish is COMPLETED or FAILED" },
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve-evals dataset publish --name my-swe --version 1.0 --dir ./corpus --watch",
      },
      download: {
        summary: "Download the original corpus package (owner only)",
        flags: {
          "output-dir": { kind: "string", short: "o", value: "<dir>", help: "Directory to save into (default: current dir)" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<name[@version]>",
        example: "evolve-evals dataset download my-swe@1.0 -o corpora/",
      },
      activate: {
        summary: "Make a READY version the dataset's active version",
        flags: {},
        minPositionals: 2,
        maxPositionals: 2,
        positionalUsage: "<name> <version>",
        example: "evolve-evals dataset activate my-swe 1.0",
      },
    },
  },
  agent: {
    summary: "Register and manage your own agents",
    commands: {
      list: {
        summary: "List your registered agents",
        flags: { ...LIST_FLAGS },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve-evals agent list",
      },
      show: {
        summary: "Show one registered agent",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<name>",
        example: "evolve-evals agent show acme-cli",
      },
      add: {
        summary: "Register an agent (install script or local directory)",
        flags: {
          "install-script": { kind: "string", value: "<path>", help: "Install script file; its contents are uploaded" },
          dir: { kind: "string", value: "<path>", help: "Local agent directory (tarred + uploaded)" },
          run: { kind: "string", value: "<command>", help: "Run command, executed with sh -c (required)" },
          "agent-env": {
            kind: "repeat",
            aliases: ["ae"],
            value: "KEY=VALUE",
            help: "Env injected at run time (repeatable)",
          },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<name>",
        example: 'evolve-evals agent add acme-cli --install-script ./install.sh --run "acme-cli --headless"',
      },
      remove: {
        summary: "Delete a registered agent (past jobs keep their record)",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<name>",
        example: "evolve-evals agent remove acme-cli",
      },
    },
  },
  auth: {
    summary: "Identity and API keys",
    commands: {
      status: {
        summary: "Who am I: the caller and the API key in use",
        flags: {},
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve-evals auth status",
      },
    },
  },
};

/** Hidden plural aliases — the singular noun is canonical. */
const GROUP_ALIASES: Record<string, string> = {
  jobs: "job",
  trials: "trial",
  datasets: "dataset",
  agents: "agent",
};

/** Hidden `ls` alias on every list verb. */
const VERB_ALIASES: Record<string, string> = { ls: "list" };

// =============================================================================
// HELP
// =============================================================================

function flagLabel(name: string, spec: FlagSpec): string {
  const forms = [
    ...(spec.short ? [`-${spec.short}`] : []),
    ...(spec.aliases ?? []).map((a) => `--${a}`),
    `--${name}`,
  ];
  return `${forms.join(", ")}${spec.value ? ` ${spec.value}` : ""}`;
}

function flagLines(flags: Record<string, FlagSpec>): string[] {
  const entries = Object.entries(flags);
  if (entries.length === 0) return [];
  const labels = entries.map(([name, spec]) => flagLabel(name, spec));
  const width = Math.min(Math.max(...labels.map((l) => l.length)), 36);
  return entries.map(([, spec], i) => {
    const label = labels[i];
    return label.length > width
      ? `  ${label}\n  ${"".padEnd(width)}  ${spec.help}`
      : `  ${label.padEnd(width)}  ${spec.help}`;
  });
}

function commandHelp(group: string, verb: string, spec: CommandSpec): string {
  const positional = spec.positionalUsage ? ` ${spec.positionalUsage}` : "";
  const options = Object.keys(spec.flags).length > 0 ? " [options]" : "";
  const lines = [
    `Usage: evolve-evals ${group} ${verb}${positional}${options}`,
    "",
    spec.summary,
  ];
  if (Object.keys(spec.flags).length > 0) {
    lines.push("", "Options:", ...flagLines(spec.flags));
  }
  lines.push("", "Global options:", ...flagLines(GLOBAL_FLAGS));
  lines.push("", "Example:", `  ${spec.example}`);
  return lines.join("\n");
}

function groupHelp(group: string): string {
  const spec = GROUPS[group];
  const lines = [
    `Usage: evolve-evals ${group} <command> [options]`,
    "",
    spec.summary,
    "",
    "Commands:",
  ];
  const width = Math.max(...Object.keys(spec.commands).map((v) => v.length));
  for (const [verb, cmd] of Object.entries(spec.commands)) {
    lines.push(`  ${verb.padEnd(width)}  ${cmd.summary}`);
  }
  lines.push("", `Run "evolve-evals ${group} <command> --help" for flags and an example.`);
  return lines.join("\n");
}

function rootHelp(): string {
  const lines = [
    "evolve-evals — Evolve hosted jobs CLI",
    "",
    "Usage: evolve-evals <command> [options]",
    "",
    "Commands:",
    "  run                    Start a job — alias for `job start`",
  ];
  for (const [group, spec] of Object.entries(GROUPS)) {
    const verbs = Object.keys(spec.commands).join(" | ");
    lines.push(`  ${group.padEnd(22)} ${spec.summary}`);
    lines.push(`  ${"".padEnd(22)}   ${verbs}`);
  }
  lines.push(
    "  help [command]         Show help (also -h/--help on any command)",
    "",
    "Global options:",
    ...flagLines(GLOBAL_FLAGS),
    "  -v, --version                     Print the CLI version",
    "",
    "Example:",
    "  evolve-evals run -d deep-swe@1.1 -a codex -m gpt-5.5 --watch"
  );
  return lines.join("\n");
}

export const USAGE = rootHelp();

function cliVersion(): string {
  // Two levels up from both src/hosted/ and dist/hosted/ sits package.json.
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf-8")
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// =============================================================================
// ARG PARSING
// =============================================================================

export interface Invocation {
  /** Canonical "<group> <verb>", or "help" / "version". */
  command: string;
  positionals: string[];
  flags: Record<string, string | number | boolean | string[]>;
}

/** Resolve a flag token (long name, alias, or short letter) to its canonical name. */
function resolveFlag(
  spec: CommandSpec,
  token: { long?: string; short?: string }
): { name: string; flag: FlagSpec } | undefined {
  const tables: Record<string, FlagSpec>[] = [spec.flags, GLOBAL_FLAGS];
  for (const table of tables) {
    for (const [name, flag] of Object.entries(table)) {
      if (token.long !== undefined) {
        if (name === token.long || (flag.aliases ?? []).includes(token.long)) {
          return { name, flag };
        }
      } else if (token.short !== undefined && flag.short === token.short) {
        return { name, flag };
      }
    }
  }
  return undefined;
}

function parseCommandArgs(
  command: string,
  spec: CommandSpec,
  argv: string[]
): Invocation {
  const flags: Invocation["flags"] = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      return { command: "help", positionals: command.split(" "), flags: {} };
    }
    let lookup: { long?: string; short?: string };
    let inlineValue: string | undefined;
    if (token.startsWith("--")) {
      let name = token.slice(2);
      const eq = name.indexOf("=");
      if (eq !== -1) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      lookup = { long: name };
    } else if (token.startsWith("-") && token.length > 1) {
      let name = token.slice(1);
      const eq = name.indexOf("=");
      if (eq !== -1) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      lookup = { short: name };
    } else {
      positionals.push(token);
      continue;
    }

    const resolved = resolveFlag(spec, lookup);
    if (!resolved) {
      throw new CliUsageError(`Unknown option ${token.split("=")[0]} for "${command}"`);
    }
    const { name, flag } = resolved;

    if (flag.kind === "boolean") {
      if (inlineValue !== undefined) {
        throw new CliUsageError(`Option --${name} takes no value`);
      }
      flags[name] = true;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next.length > 1 && isNaN(Number(next)))) {
        throw new CliUsageError(`Option --${name} requires a value`);
      }
      value = next;
      i++;
    }

    if (flag.kind === "number") {
      const num = Number(value);
      if (value.trim() === "" || !Number.isFinite(num)) {
        throw new CliUsageError(`Option --${name} expects a number, got "${value}"`);
      }
      flags[name] = num;
    } else if (flag.kind === "repeat") {
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
    throw new CliUsageError(
      `"${command}" got unexpected argument "${positionals[spec.maxPositionals]}"`
    );
  }

  return { command, positionals, flags };
}

export function parseArgs(argv: string[]): Invocation {
  // Bare invocation and help forms print help at exit 0 — a shell asking
  // "what can you do" is not an error.
  if (argv.length === 0) return { command: "help", positionals: [], flags: {} };
  const head = argv[0];
  if (head === "--help" || head === "-h" || head === "help") {
    return { command: "help", positionals: argv.slice(1), flags: {} };
  }
  if (head === "--version" || head === "-v") {
    return { command: "version", positionals: [], flags: {} };
  }
  if (head === "run") {
    return parseCommandArgs("job start", GROUPS.job.commands.start, argv.slice(1));
  }

  const group = GROUP_ALIASES[head] ?? head;
  const groupSpec = GROUPS[group];
  if (!groupSpec) {
    throw new CliUsageError(`Unknown command "${head}"`);
  }
  const rawVerb = argv[1];
  if (rawVerb === undefined || rawVerb === "--help" || rawVerb === "-h") {
    return { command: "help", positionals: [group], flags: {} };
  }
  if (rawVerb.startsWith("-")) {
    throw new CliUsageError(`"${group}" requires a command (run "evolve-evals ${group} --help")`);
  }
  const verb = VERB_ALIASES[rawVerb] ?? rawVerb;
  const spec = groupSpec.commands[verb];
  if (!spec) {
    throw new CliUsageError(
      `Unknown command "${group} ${rawVerb}" (supported: ${Object.keys(groupSpec.commands).join(", ")})`
    );
  }
  return parseCommandArgs(`${group} ${verb}`, spec, argv.slice(2));
}

// =============================================================================
// JOB CONFIG (-c file + flag merge)
// =============================================================================

/**
 * The YAML this CLI reads is a deliberate subset, enough for a job config and
 * nothing more: block maps, block sequences, quoted/bare scalars, flow
 * collections on one line, and comments (full-line or trailing). Anchors,
 * aliases, tags, multi-line scalars, and multi-document files are refused
 * loudly rather than parsed wrong — a config that needs them can be written
 * as JSON. The subset's one hard law: malformed input refuses with a
 * line-numbered error, and a comment NEVER lands inside a value.
 */
export function parseYamlSubset(text: string, source: string): unknown {
  interface Line {
    indent: number;
    text: string;
    no: number;
  }
  const refuse = (no: number, what: string): never => {
    throw new CliUsageError(`${source}:${no}: ${what}`);
  };

  /**
   * Does the quote at `i` DELIMIT a scalar, or is it an ordinary character?
   * YAML reads a quote as a delimiter only where a scalar may begin: the start
   * of the line, or straight after a `: ` / `- ` separator (both need the
   * space — `a:'b'` is the plain scalar `a:'b'`) or a flow `,` `[` `{`.
   * Everywhere else it is content. Treating every quote as a delimiter made
   * the apostrophe in `name: brando's run` open a string that never closed,
   * and the whole line — trailing comment included — survived unstripped.
   */
  const delimitsScalar = (line: string, i: number): boolean => {
    let j = i - 1;
    while (j >= 0 && (line[j] === " " || line[j] === "\t")) j--;
    if (j < 0) return true;
    if (line[j] === "," || line[j] === "[" || line[j] === "{") return true;
    return (line[j] === ":" || line[j] === "-") && j < i - 1;
  };

  /**
   * Cut a trailing comment off one line: a `#` outside quotes that sits at the
   * start or after whitespace (YAML's own rule — `url: http://x#frag` keeps
   * its `#`). Runs BEFORE any scalar is read, so a comment cannot be folded
   * into a value. A line whose quote never closes is passed through whole for
   * the scalar parser to refuse with its line number.
   */
  const stripTrailingComment = (line: string): string => {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (quote === '"' && ch === "\\") i++;
        else if (ch === quote) {
          if (quote === "'" && line[i + 1] === "'") i++;
          else quote = null;
        }
      } else if ((ch === '"' || ch === "'") && delimitsScalar(line, i)) {
        quote = ch;
      } else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
        return line.slice(0, i).trimEnd();
      }
    }
    return line;
  };

  const lines: Line[] = [];
  text.split("\n").forEach((raw, index) => {
    const no = index + 1;
    if (raw.trim() === "" || raw.trim().startsWith("#")) return;
    if (raw.trim() === "---" || raw.trim() === "...") {
      refuse(no, "multi-document YAML is not supported here — one config per file");
    }
    const indent = raw.length - raw.trimStart().length;
    if (raw.slice(0, indent).includes("\t")) {
      refuse(no, "tabs in indentation — use spaces");
    }
    const stripped = stripTrailingComment(raw.trim());
    if (stripped === "") return;
    lines.push({ indent, text: stripped, no });
  });

  /**
   * One-line YAML flow collection (`{k: v}` / `[a, b]`), unquoted keys and
   * scalars included — the JSON-only reading refused plain YAML like
   * `{ MARKER: prod }`. Still a subset: the collection must close on its own
   * line, and every malformation refuses with the line number.
   */
  function parseFlow(input: string, no: number): unknown {
    let pos = 0;
    const skipSpaces = (): void => {
      while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) pos++;
    };

    const parseQuoted = (): string => {
      const open = input[pos];
      let end = pos + 1;
      while (end < input.length) {
        if (open === '"' && input[end] === "\\") end += 2;
        else if (input[end] === open) {
          if (open === "'" && input[end + 1] === "'") end += 2;
          else break;
        } else end++;
      }
      if (end >= input.length) {
        refuse(no, `unterminated ${open === '"' ? "double" : "single"}-quoted string in flow collection`);
      }
      const lexeme = input.slice(pos, end + 1);
      pos = end + 1;
      if (open === "'") return lexeme.slice(1, -1).replace(/''/g, "'");
      try {
        return JSON.parse(lexeme) as string;
      } catch {
        return refuse(no, "invalid double-quoted string in flow collection") as never;
      }
    };

    const parseBare = (stops: string): unknown => {
      const start = pos;
      while (pos < input.length && !stops.includes(input[pos])) pos++;
      const raw = input.slice(start, pos).trim();
      if (raw === "") refuse(no, "empty value in flow collection");
      if (raw.startsWith("&") || raw.startsWith("*") || raw.startsWith("!")) {
        refuse(no, `YAML ${raw[0] === "!" ? "tags" : "anchors/aliases"} are not supported here`);
      }
      if (raw === "null" || raw === "~") return null;
      if (raw === "true") return true;
      if (raw === "false") return false;
      if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
      return raw;
    };

    const parseValue = (stops: string): unknown => {
      skipSpaces();
      if (pos >= input.length) refuse(no, "unterminated flow collection");
      const ch = input[pos];
      if (ch === "{") return parseMap();
      if (ch === "[") return parseSeq();
      if (ch === '"' || ch === "'") return parseQuoted();
      return parseBare(stops);
    };

    const parseMap = (): Record<string, unknown> => {
      pos++; // {
      const map: Record<string, unknown> = {};
      skipSpaces();
      if (input[pos] === "}") {
        pos++;
        return map;
      }
      for (;;) {
        skipSpaces();
        if (pos >= input.length) refuse(no, "unterminated flow mapping — missing }");
        if (input[pos] === "{" || input[pos] === "[") {
          refuse(no, "flow mapping keys must be scalars");
        }
        const key = input[pos] === '"' || input[pos] === "'" ? parseQuoted() : String(parseBare(":,}]"));
        skipSpaces();
        if (input[pos] !== ":") refuse(no, 'expected ":" in flow mapping');
        pos++;
        map[String(key)] = parseValue(",}]");
        skipSpaces();
        if (input[pos] === ",") {
          pos++;
          skipSpaces();
          // A comma before the closer is a trailing comma, valid YAML — not
          // the empty entry the bare-scalar reader would otherwise refuse.
          if (input[pos] === "}") {
            pos++;
            return map;
          }
          continue;
        }
        if (input[pos] === "}") {
          pos++;
          return map;
        }
        refuse(no, 'expected "," or "}" in flow mapping');
      }
    };

    const parseSeq = (): unknown[] => {
      pos++; // [
      const items: unknown[] = [];
      skipSpaces();
      if (input[pos] === "]") {
        pos++;
        return items;
      }
      for (;;) {
        items.push(parseValue(",]}"));
        skipSpaces();
        if (pos >= input.length) refuse(no, "unterminated flow sequence — missing ]");
        if (input[pos] === ",") {
          pos++;
          skipSpaces();
          // Same trailing-comma law as the flow mapping: `[a, b,]` is valid.
          if (input[pos] === "]") {
            pos++;
            return items;
          }
          continue;
        }
        if (input[pos] === "]") {
          pos++;
          return items;
        }
        refuse(no, 'expected "," or "]" in flow sequence');
      }
    };

    const value = input[0] === "{" ? parseMap() : parseSeq();
    skipSpaces();
    if (pos < input.length) {
      refuse(no, "unexpected content after flow collection");
    }
    return value;
  }

  function parseScalar(value: string, no: number): unknown {
    if (value.startsWith("&") || value.startsWith("*") || value.startsWith("!")) {
      refuse(no, `YAML ${value[0] === "!" ? "tags" : "anchors/aliases"} are not supported here`);
    }
    if (value === "|" || value === ">") {
      refuse(no, "multi-line scalars are not supported here — use JSON");
    }
    if (value.startsWith("[") || value.startsWith("{")) {
      return parseFlow(value, no);
    }
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        refuse(no, "unterminated double-quoted string");
      }
    }
    if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) {
        refuse(no, "unterminated single-quoted string");
      }
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value === "null" || value === "~") return null;
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value;
  }

  /** Parse the block starting at `start`, all lines with indent >= `indent`. */
  function parseBlock(start: number, indent: number): { value: unknown; next: number } {
    const first = lines[start];
    if (first.text.startsWith("- ") || first.text === "-") {
      const items: unknown[] = [];
      let i = start;
      while (i < lines.length && lines[i].indent >= indent) {
        const line = lines[i];
        if (line.indent > indent || (!line.text.startsWith("- ") && line.text !== "-")) {
          refuse(line.no, "inconsistent indentation in sequence");
        }
        const rest = line.text === "-" ? "" : line.text.slice(2);
        if (rest === "") {
          if (i + 1 >= lines.length || lines[i + 1].indent <= indent) {
            refuse(line.no, "empty sequence item");
          }
          const nested = parseBlock(i + 1, lines[i + 1].indent);
          items.push(nested.value);
          i = nested.next;
        } else if (findKeyColon(rest) === -1) {
          items.push(parseScalar(rest, line.no));
          i++;
        } else {
          // Inline item: re-enter the parser with the rest of the line placed
          // at the item's column, so `- key: value` opens a map whose further
          // keys sit below at that column.
          const virtual: Line = { indent: line.indent + 2, text: rest, no: line.no };
          lines.splice(i, 1, virtual);
          const nested = parseBlock(i, virtual.indent);
          items.push(nested.value);
          i = nested.next;
        }
      }
      return { value: items, next: i };
    }

    const map: Record<string, unknown> = {};
    let i = start;
    while (i < lines.length && lines[i].indent >= indent) {
      const line = lines[i];
      if (line.indent > indent) refuse(line.no, "inconsistent indentation in map");
      const colon = findKeyColon(line.text);
      if (colon === -1) refuse(line.no, `expected "key: value", got "${line.text}"`);
      const key = stripKeyQuotes(line.text.slice(0, colon).trim());
      const rest = line.text.slice(colon + 1).trim();
      if (rest !== "") {
        map[key] = parseScalar(rest, line.no);
        i++;
      } else if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseBlock(i + 1, lines[i + 1].indent);
        map[key] = nested.value;
        i = nested.next;
      } else {
        map[key] = null;
        i++;
      }
    }
    return { value: map, next: i };
  }

  /** The colon ending the key: the first `:` at end-of-text or followed by a space, outside quotes. */
  function findKeyColon(text: string): number {
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if ((ch === '"' || ch === "'") && delimitsScalar(text, i)) {
        quote = ch;
      } else if (ch === ":" && (i === text.length - 1 || text[i + 1] === " ")) {
        return i;
      }
    }
    return -1;
  }

  function stripKeyQuotes(key: string): string {
    if (key.length >= 2 && ((key[0] === '"' && key.endsWith('"')) || (key[0] === "'" && key.endsWith("'")))) {
      return key.slice(1, -1);
    }
    return key;
  }

  if (lines.length === 0) return {};
  const { value, next } = parseBlock(0, lines[0].indent);
  if (next < lines.length) {
    refuse(lines[next].no, "content outside the root block — check indentation");
  }
  return value;
}

/** The closed key vocabulary a -c config file may use (the spec's JobCreate). */
const JOB_CONFIG_KEYS = new Set([
  "job_name",
  "datasets",
  "agents",
  "n_attempts",
  "n_concurrent_trials",
  "max_trial_spend_usd",
  "sandbox_provider",
  "agent_env",
  "verifier_env",
]);

function loadJobConfig(path: string, read: (path: string) => string): Partial<JobCreate> {
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    throw new CliUsageError(`--config: cannot read ${path}: ${(error as Error).message}`);
  }
  let value: unknown;
  if (path.endsWith(".json")) {
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new CliUsageError(`--config: ${path} is not valid JSON: ${(error as Error).message}`);
    }
  } else {
    value = parseYamlSubset(text, path);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(`--config: ${path} must contain a JSON/YAML object`);
  }
  for (const key of Object.keys(value)) {
    if (!JOB_CONFIG_KEYS.has(key)) {
      throw new CliUsageError(
        `--config: unknown key "${key}" in ${path} (allowed: ${[...JOB_CONFIG_KEYS].join(", ")})`
      );
    }
  }
  return value as Partial<JobCreate>;
}

/** Parse "name" or "name@version" (dataset refs and agent pins share the grammar). */
function parseAtRef(value: string, flag: string): { name: string; version?: string } {
  const at = value.indexOf("@");
  if (at === -1) return { name: value };
  const name = value.slice(0, at);
  const version = value.slice(at + 1);
  if (!name || !version) {
    throw new CliUsageError(`Invalid ${flag} "${value}": expected name or name@version`);
  }
  return { name, version };
}

/** Parse repeatable KEY=VALUE pairs into an env map. */
export function parseEnvPairs(pairs: string[], flag: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new CliUsageError(`Invalid ${flag} "${pair}": expected KEY=VALUE`);
    }
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

/**
 * Build the POST /api/jobs body from a parsed `job start` invocation:
 * -c loads a base config in the spec's own vocabulary, then every explicitly
 * passed flag overrides the corresponding field. -i/-x/-l are stamped onto
 * EVERY dataset selector — per-selector filters with one flag grammar, so a
 * glob that matches nothing in one dataset simply filters nothing there.
 */
export function buildJobInput(
  inv: Invocation,
  read: (path: string) => string = (path) => readFileSync(path, "utf-8")
): JobCreate {
  const f = inv.flags;
  const base: Partial<JobCreate> =
    typeof f.config === "string" ? loadJobConfig(f.config, read) : {};

  // Datasets: -d replaces the file's list outright.
  let selectors: DatasetSelector[];
  if (f.dataset !== undefined) {
    selectors = (f.dataset as string[]).map((ref) => {
      const parsed = parseAtRef(ref, "--dataset");
      return { name: parsed.name, ...(parsed.version ? { version: parsed.version } : {}) };
    });
  } else if (Array.isArray(base.datasets) && base.datasets.length > 0) {
    selectors = base.datasets.map((selector) => ({ ...selector }));
  } else {
    throw new CliUsageError('"job start" requires -d/--dataset (or datasets in --config)');
  }
  if (f["include-task-name"] !== undefined) {
    for (const s of selectors) s.task_names = f["include-task-name"] as string[];
  }
  if (f["exclude-task-name"] !== undefined) {
    for (const s of selectors) s.exclude_task_names = f["exclude-task-name"] as string[];
  }
  if (f["n-tasks"] !== undefined) {
    for (const s of selectors) s.n_tasks = f["n-tasks"] as number;
  }

  // Agents: -a + -m form the arms (one arm per model); either replaces the file's list.
  let arms: AgentArmInput[];
  const hasAgentFlag = f.agent !== undefined || f.model !== undefined;
  if (hasAgentFlag) {
    if (f.agent === undefined) {
      throw new CliUsageError("-m/--model requires -a/--agent");
    }
    if (f.model === undefined) {
      throw new CliUsageError("-a/--agent requires at least one -m/--model (the server applies no model default)");
    }
    const parsed = parseAtRef(String(f.agent), "--agent");
    arms = (f.model as string[]).map((model) => ({
      name: parsed.name,
      model_name: model,
      ...(parsed.version ? { version: parsed.version } : {}),
    }));
  } else if (Array.isArray(base.agents) && base.agents.length > 0) {
    arms = base.agents.map((arm) => ({ ...arm }));
  } else {
    throw new CliUsageError('"job start" requires -a/--agent and -m/--model (or agents in --config)');
  }
  if (f.effort !== undefined) {
    // --effort is stamped on EVERY arm, verbatim. The server owns the
    // per-agent refusal, so the CLI never edits the list to dodge one —
    // silently dropping the value for some arms would run a sweep the flag no
    // longer describes.
    arms = arms.map((arm) => ({ ...arm, reasoning_effort: f.effort as string }));
  }

  const agentEnv =
    f["agent-env"] !== undefined
      ? parseEnvPairs(f["agent-env"] as string[], "--agent-env")
      : base.agent_env;
  const verifierEnv =
    f["verifier-env"] !== undefined
      ? parseEnvPairs(f["verifier-env"] as string[], "--verifier-env")
      : base.verifier_env;

  const jobName = f["job-name"] !== undefined ? String(f["job-name"]) : base.job_name;
  const nAttempts = f["n-attempts"] !== undefined ? (f["n-attempts"] as number) : base.n_attempts;
  const nConcurrent =
    f["n-concurrent"] !== undefined ? (f["n-concurrent"] as number) : base.n_concurrent_trials;
  const maxSpend =
    f["max-trial-spend"] !== undefined
      ? (f["max-trial-spend"] as number)
      : base.max_trial_spend_usd;
  // Same posture as --stream and --status: a bad provider is a usage error
  // at the keyboard, not a 400 after a round trip.
  if (f.env !== undefined && !(EVAL_SANDBOX_PROVIDERS as readonly string[]).includes(String(f.env))) {
    throw new CliUsageError(`-e/--env must be one of: ${EVAL_SANDBOX_PROVIDERS.join(", ")}`);
  }
  const provider =
    f.env !== undefined ? (f.env as EvalSandboxProvider) : base.sandbox_provider;

  return {
    ...(jobName !== undefined ? { job_name: jobName } : {}),
    datasets: selectors,
    agents: arms,
    ...(nAttempts !== undefined ? { n_attempts: nAttempts } : {}),
    ...(nConcurrent !== undefined ? { n_concurrent_trials: nConcurrent } : {}),
    ...(maxSpend !== undefined ? { max_trial_spend_usd: maxSpend } : {}),
    ...(provider !== undefined ? { sandbox_provider: provider } : {}),
    ...(agentEnv !== undefined ? { agent_env: agentEnv } : {}),
    ...(verifierEnv !== undefined ? { verifier_env: verifierEnv } : {}),
  };
}

/** Build the datasets().publish() input from a parsed `dataset publish` invocation. */
export function buildPublishInput(inv: Invocation): PublishDatasetInput {
  const f = inv.flags;
  const hasDir = typeof f.dir === "string";
  const hasGit = typeof f.git === "string" || typeof f.ref === "string";
  if (hasDir && hasGit) {
    throw new CliUsageError('"dataset publish" takes EITHER --dir OR --git/--ref, not both');
  }
  if (hasDir) {
    for (const req of ["name", "version"] as const) {
      if (typeof f[req] !== "string") {
        throw new CliUsageError(`"dataset publish" requires --${req}`);
      }
    }
    return {
      source: { directory: f.dir as string },
      name: f.name as string,
      version: f.version as string,
    };
  }
  for (const req of ["git", "ref", "name", "version"] as const) {
    if (typeof f[req] !== "string") {
      const suffix = req === "git" || req === "ref" ? " (or --dir for a local corpus directory)" : "";
      throw new CliUsageError(`"dataset publish" requires --${req}${suffix}`);
    }
  }
  return {
    source: { git_url: f.git as string, git_ref: f.ref as string },
    name: f.name as string,
    version: f.version as string,
  };
}

/**
 * Build the agents().create() input from a parsed `agent add` invocation.
 * `--install-script` names a FILE; its contents are what the SDK uploads.
 */
export function buildAgentInput(
  inv: Invocation,
  readScript: (path: string) => string = (path) => readFileSync(path, "utf-8")
): AgentInput {
  const f = inv.flags;
  const hasDir = typeof f.dir === "string";
  const hasInstallScript = typeof f["install-script"] === "string";
  if (hasDir && hasInstallScript) {
    throw new CliUsageError('"agent add" takes EITHER --dir OR --install-script, not both');
  }
  if (!hasDir && !hasInstallScript) {
    throw new CliUsageError(
      '"agent add" requires --install-script (or --dir for a local agent directory)'
    );
  }
  if (typeof f.run !== "string") {
    throw new CliUsageError('"agent add" requires --run');
  }
  const env = parseEnvPairs((f["agent-env"] as string[] | undefined) ?? [], "--agent-env");
  return {
    name: inv.positionals[0],
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
  /**
   * True when stdout is an interactive terminal. Drives the table-vs-TSV
   * split on list commands; TERM=dumb counts as non-interactive. Defaults to
   * false when absent so redirected output always gets machine-safe rows.
   */
  tty?: boolean;
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  tty: process.stdout.isTTY === true && process.env.TERM !== "dumb",
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

/** Collapse a cell to one line — a TSV row must never contain the separators. */
function oneLine(text: string): string {
  return text.replace(/[\t\n\r]+/g, " ");
}

interface ListColumn<T> {
  key: string;
  header: string;
  cell(row: T): string;
}

/**
 * The one list renderer, implementing the shared output precedence:
 * --json is handled by the callers (it carries the whole page envelope);
 * -q prints the id column only; a TTY gets an aligned, truncated table
 * (--no-trunc lifts the truncation); anything else gets TSV with a header
 * unless --no-headers. Interactive paging is deliberately absent — pages are
 * one-shot, and --cursor is the paging surface.
 */
function renderList<T>(
  inv: Invocation,
  io: CliIO,
  rows: T[],
  registry: ListColumn<T>[],
  defaults: string[],
  quietCell: (row: T) => string
): void {
  if (inv.flags.quiet === true) {
    for (const row of rows) io.out(quietCell(row));
    return;
  }
  const columns = selectColumns(inv, registry, defaults);
  const tty = io.tty === true;
  if (tty) {
    const noTrunc = inv.flags["no-trunc"] === true;
    const out = [columns.map((c) => c.header)];
    for (const row of rows) {
      out.push(columns.map((c) => (noTrunc ? oneLine(c.cell(row)) : truncate(oneLine(c.cell(row)), 60))));
    }
    for (const line of table(out)) io.out(line);
  } else {
    if (inv.flags["no-headers"] !== true) {
      io.out(columns.map((c) => c.header).join("\t"));
    }
    for (const row of rows) {
      io.out(columns.map((c) => oneLine(c.cell(row))).join("\t"));
    }
  }
}

function selectColumns<T>(
  inv: Invocation,
  registry: ListColumn<T>[],
  defaults: string[]
): ListColumn<T>[] {
  const spec = inv.flags.columns as string | undefined;
  if (spec === undefined) {
    return defaults.map((key) => registry.find((c) => c.key === key)!);
  }
  if (spec === "all") return registry;
  const keys = spec
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    throw new CliUsageError("--columns got an empty column list");
  }
  return keys.map((key) => {
    const column = registry.find((c) => c.key === key);
    if (!column) {
      throw new CliUsageError(
        `Unknown column "${key}" (available: ${registry.map((c) => c.key).join(", ")}, or "all")`
      );
    }
    return column;
  });
}

/** `--columns help` answers from the registry alone — no request is made. */
function columnsHelpRequested<T>(
  inv: Invocation,
  io: CliIO,
  registry: ListColumn<T>[]
): boolean {
  if (inv.flags.columns !== "help") return false;
  for (const column of registry) io.out(column.key);
  return true;
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

const JOB_COLUMNS: ListColumn<Job>[] = [
  { key: "id", header: "ID", cell: (e) => e.id },
  { key: "name", header: "NAME", cell: (e) => e.job_name ?? "-" },
  { key: "status", header: "STATUS", cell: (e) => e.status },
  { key: "datasets", header: "DATASETS", cell: (e) => fmtDatasets(e.datasets) },
  { key: "agents", header: "AGENTS", cell: (e) => e.agents.map(fmtAgent).join(", ") },
  { key: "trials", header: "TRIALS", cell: (e) => String(e.trials.total) },
  { key: "spent", header: "SPENT", cell: (e) => fmtUsd(e.stats.cost_usd) },
  { key: "started", header: "STARTED", cell: (e) => e.started_at },
];
const JOB_DEFAULT_COLUMNS = ["id", "status", "datasets", "trials", "spent", "started"];

const TRIAL_COLUMNS: ListColumn<Trial>[] = [
  { key: "task", header: "TASK", cell: (r) => r.task_name },
  {
    key: "agent",
    header: "AGENT",
    cell: (r) =>
      fmtAgent({
        name: r.agent_info.name,
        model_name: r.agent_info.model_info.name,
        version: r.agent_info.version,
        reasoning_effort: r.agent_info.reasoning_effort ?? null,
      }),
  },
  { key: "attempt", header: "ATTEMPT", cell: (r) => String(r.attempt) },
  { key: "status", header: "STATUS", cell: (r) => r.status },
  { key: "reward", header: "REWARD", cell: (r) => (r.reward !== null ? String(r.reward) : "-") },
  { key: "spent", header: "SPENT", cell: (r) => fmtUsd(r.agent_result?.cost_usd) },
  { key: "id", header: "TRIAL ID", cell: (r) => r.id },
];
const TRIAL_DEFAULT_COLUMNS = ["task", "agent", "attempt", "status", "reward", "spent", "id"];

const TASK_ROLLUP_COLUMNS: ListColumn<JobTaskRollup>[] = [
  { key: "task", header: "TASK", cell: (r) => r.task_name },
  { key: "source", header: "DATASET", cell: (r) => r.source },
  { key: "trials", header: "TRIALS", cell: (r) => String(r.trials.total) },
  {
    key: "statuses",
    header: "STATUSES",
    cell: (r) =>
      Object.entries(r.trials.byStatus)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${status} ${count}`)
        .join(" · ") || "-",
  },
  { key: "reward", header: "MEAN REWARD", cell: (r) => fmtReward(r.mean_reward) },
  { key: "spent", header: "SPENT", cell: (r) => fmtUsd(r.cost_usd) },
];
const TASK_ROLLUP_DEFAULT_COLUMNS = ["task", "source", "trials", "statuses", "reward", "spent"];

const DATASET_COLUMNS: ListColumn<Dataset>[] = [
  { key: "name", header: "NAME", cell: (b) => b.name },
  { key: "active", header: "ACTIVE", cell: (b) => b.active_version?.version ?? "-" },
  { key: "state", header: "STATE", cell: (b) => b.active_version?.state ?? "-" },
  {
    key: "tasks",
    header: "TASKS",
    cell: (b) => (b.active_version ? String(b.active_version.task_count) : "-"),
  },
  { key: "title", header: "TITLE", cell: (b) => b.title ?? "-" },
];
const DATASET_DEFAULT_COLUMNS = ["name", "active", "state", "tasks", "title"];

const AGENT_COLUMNS: ListColumn<Agent>[] = [
  { key: "name", header: "NAME", cell: (a) => a.name },
  { key: "source", header: "SOURCE", cell: (a) => a.source },
  { key: "run", header: "RUN COMMAND", cell: (a) => a.run_command },
  { key: "updated", header: "UPDATED", cell: (a) => a.updated_at },
];
const AGENT_DEFAULT_COLUMNS = ["name", "source", "run", "updated"];

/**
 * Full-detail rendering of one trial — evolve-evals trial show. Exported for
 * tests, like the other line renderers.
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
 * One registered agent — evolve-evals agent show / add. Declared env is shown
 * by KEY only; the values were the caller's to set and are not echoed back
 * into a terminal. `--json` carries the response verbatim.
 */
function agentLines(agent: Agent): string[] {
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

/** One trace event line — evolve-evals trial download --stream trace-parsed. */
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

/** Compact one-line rendering of one publish status change for --watch. */
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

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_ID_PREFIX_RE = /^[0-9a-f][0-9a-f-]{7,34}$/i;
const JOB_ID_PREFIX_MIN = 8;

/**
 * ONE prefix law for every job-id verb: a full uuid passes through untouched;
 * an id-shaped prefix of at least 8 characters is resolved against the
 * caller's own job list (every page) to the one job it names — zero or
 * several matches refuse loudly. The wire always carries the full id, so no
 * verb depends on server-side prefix leniency and no verb lacks it. (It used
 * to be per-verb luck: show/cancel accepted prefixes, regrade/trials 404'd.)
 * Anything not id-shaped passes through for the server to refuse by name.
 * Trial ids are NOT prefix-resolved — there is no bounded list to resolve
 * them against; trial verbs take full ids.
 */
async function resolveJobId(inv: Invocation, ref: string): Promise<string> {
  if (ref === undefined || FULL_UUID_RE.test(ref)) return ref;
  if (/^[0-9a-f][0-9a-f-]*$/i.test(ref) && ref.length < JOB_ID_PREFIX_MIN) {
    throw new CliUsageError(
      `"${ref}" is too short to name a job — id prefixes need at least ${JOB_ID_PREFIX_MIN} characters`
    );
  }
  if (!JOB_ID_PREFIX_RE.test(ref)) return ref;
  const client = jobs(clientConfig(inv));
  const prefix = ref.toLowerCase();
  // A SET of ids, not a list: the cursor window shifts while paging (jobs are
  // created newest-first), so one job can be read on two pages — counting it
  // twice refused an unambiguous prefix as "ambiguous — it matches 2 jobs"
  // naming the same id twice. Ambiguity is about distinct jobs.
  const matches = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const job of page.items) {
      if (job.id.startsWith(prefix)) matches.add(job.id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const ids = [...matches];
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) {
    throw new CliUsageError(`no job id starts with "${ref}"`);
  }
  throw new CliUsageError(
    `"${ref}" is ambiguous — it matches ${ids.length} jobs: ` +
      `${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}`
  );
}

/** The one { limit, cursor } pair every paged command accepts. */
function pageOptions(inv: Invocation): { limit?: number; cursor?: string } {
  return {
    ...(inv.flags.limit !== undefined ? { limit: inv.flags.limit as number } : {}),
    ...(inv.flags.cursor !== undefined ? { cursor: String(inv.flags.cursor) } : {}),
  };
}

function parseStatusFilter(inv: Invocation): TrialStatus[] | undefined {
  if (inv.flags.status === undefined) return undefined;
  const statuses = String(inv.flags.status)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (statuses.length === 0) {
    throw new CliUsageError("--status got an empty status list");
  }
  // Validated here like --stream, not left to the server: a typo'd status is a
  // usage error the moment it is typed, never a round trip later.
  const unknown = statuses.filter((s) => !(TRIAL_STATUSES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw new CliUsageError(
      `--status must name trial statuses (${TRIAL_STATUSES.join(", ")}); got: ${unknown.join(", ")}`
    );
  }
  return statuses as TrialStatus[];
}

function statusExitCode(e: Job): number {
  return e.status === "COMPLETED" ? 0 : e.status === "FAILED" || e.status === "CANCELLED" ? 1 : 0;
}

async function cmdJobStart(inv: Invocation, io: CliIO): Promise<number> {
  const input = buildJobInput(inv);
  if (inv.flags["print-config"] === true) {
    // The resolved body, nothing sent: the dry-run a paid remote run deserves.
    io.out(JSON.stringify(input, null, 2));
    return 0;
  }
  const json = inv.flags.json === true;
  const watch = inv.flags.watch === true;
  const quiet = inv.flags.quiet === true;
  const client = jobs(clientConfig(inv));

  const created = await client.start(input);
  if (!watch) {
    if (json) {
      io.out(JSON.stringify(created));
    } else {
      for (const line of jobLines(created)) io.out(line);
      io.out("");
      io.out(`Follow it with: evolve-evals job show ${created.id}`);
    }
    return 0;
  }

  if (json) {
    io.out(JSON.stringify({ kind: "job.created", job: created }));
  } else {
    io.out(`Job ${created.id} (${fmtDatasets(created.datasets)}) ${created.status} — watching…`);
  }

  // -q keeps the stream open but silent: the final block (and, in --json, the
  // job.created/job.final envelopes) are the whole story.
  const final = await client.watch(created.id, {
    onEvent: (event) => {
      if (quiet) return;
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

async function cmdJobList(inv: Invocation, io: CliIO): Promise<number> {
  if (columnsHelpRequested(inv, io, JOB_COLUMNS)) return 0;
  const client = jobs(clientConfig(inv));
  const page = await client.list({
    ...pageOptions(inv),
    ...(inv.flags.search !== undefined ? { search: String(inv.flags.search) } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.items.length === 0) {
    if (inv.flags.quiet !== true) io.out("No jobs.");
    return 0;
  }
  renderList(inv, io, page.items, JOB_COLUMNS, JOB_DEFAULT_COLUMNS, (e) => e.id);
  if (page.nextCursor && io.tty === true && inv.flags.quiet !== true) {
    io.out(`\nMore: evolve-evals job list --cursor ${page.nextCursor}`);
  }
  return 0;
}

async function cmdJobShow(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  // N ids = one combined view, fetched in the caller's order. --json prints
  // ONE document: the job object for one id, an array for several.
  const bodies: Job[] = [];
  for (const id of inv.positionals) {
    bodies.push(await client.get(await resolveJobId(inv, id)));
  }
  if (inv.flags.json === true) {
    io.out(JSON.stringify(bodies.length === 1 ? bodies[0] : bodies));
    return 0;
  }
  bodies.forEach((e, index) => {
    if (index > 0) io.out("");
    for (const line of jobLines(e)) io.out(line);
  });
  return 0;
}

async function cmdJobTrials(inv: Invocation, io: CliIO): Promise<number> {
  if (columnsHelpRequested(inv, io, TRIAL_COLUMNS)) return 0;
  const client = jobs(clientConfig(inv));
  const status = parseStatusFilter(inv);
  const dataset = inv.flags.dataset as string | undefined;
  const page = await client.trials(await resolveJobId(inv, inv.positionals[0]), {
    ...(status !== undefined ? { status } : {}),
    ...(dataset !== undefined ? { dataset } : {}),
    ...pageOptions(inv),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.items.length === 0) {
    if (inv.flags.quiet !== true) io.out("No trials.");
    return 0;
  }
  renderList(inv, io, page.items, TRIAL_COLUMNS, TRIAL_DEFAULT_COLUMNS, (r) => r.id);
  if (io.tty === true && inv.flags.quiet !== true) {
    io.out(`\n${page.items.length} trial(s) shown`);
    if (page.nextCursor) {
      io.out(`More: evolve-evals job trials ${inv.positionals[0]} --cursor ${page.nextCursor}`);
    }
  }
  return 0;
}

async function cmdJobTasks(inv: Invocation, io: CliIO): Promise<number> {
  if (columnsHelpRequested(inv, io, TASK_ROLLUP_COLUMNS)) return 0;
  const client = jobs(clientConfig(inv));
  const page = await client.tasks(await resolveJobId(inv, inv.positionals[0]), pageOptions(inv));
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.items.length === 0) {
    if (inv.flags.quiet !== true) io.out("No tasks.");
    return 0;
  }
  renderList(inv, io, page.items, TASK_ROLLUP_COLUMNS, TASK_ROLLUP_DEFAULT_COLUMNS, (r) => r.task_name);
  if (page.nextCursor && io.tty === true && inv.flags.quiet !== true) {
    io.out(`\nMore: evolve-evals job tasks ${inv.positionals[0]} --cursor ${page.nextCursor}`);
  }
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

async function cmdJobCompare(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const ids: string[] = [];
  for (const ref of inv.positionals) ids.push(await resolveJobId(inv, ref));
  const comparison = await client.compare(ids);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(comparison));
  } else {
    for (const line of comparisonLines(comparison)) io.out(line);
  }
  return 0;
}

async function cmdJobCancel(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const e = await client.cancel(await resolveJobId(inv, inv.positionals[0]));
  if (inv.flags.json === true) {
    io.out(JSON.stringify(e));
  } else {
    for (const line of jobLines(e)) io.out(line);
  }
  return 0;
}

/**
 * PURE SUGAR over surfaces that already exist — the job body's datasets[],
 * the trial list's dataset filter, and the trial-stop door. Stops ONE
 * dataset's live trials and leaves the job (and every other dataset) running;
 * cancelling the whole job is `job cancel`.
 */
async function cmdJobStop(inv: Invocation, io: CliIO): Promise<number> {
  const dataset = inv.flags.dataset as string | undefined;
  if (!dataset) {
    throw new CliUsageError(
      "job stop needs --dataset <name> (to stop the whole job, use: evolve-evals job cancel <id>)"
    );
  }
  const client = jobs(clientConfig(inv));
  const job = await client.get(await resolveJobId(inv, inv.positionals[0]));
  const names = job.datasets.map((d) => d.name);
  if (!names.includes(dataset)) {
    // A refusal, not an empty no-op: stopping a dataset the job never spanned
    // is a typo, and silence would read as "nothing was running".
    throw new Error(
      `job ${job.id} does not run dataset ${dataset}; its datasets: ${names.join(", ")}`
    );
  }
  // EVERY trial of the dataset, across every cursor page — deliberately not
  // pre-filtered to live ones. The stop door files each id under stopped /
  // already_terminal / not_found itself, and it is that classification the
  // caller reads: a pre-filter made an all-terminal dataset print the same
  // empty report as one with no trials at all (campaign D6). With the whole
  // slice named, an empty report honestly means "this dataset has no trials".
  const trialIds: string[] = [];
  for await (const trial of client.trials(job.id, { dataset })) {
    trialIds.push(trial.id);
  }
  if (trialIds.length === 0) {
    if (inv.flags.json === true) {
      io.out(JSON.stringify({ stopped: [], already_terminal: [], not_found: [] }));
    } else {
      io.out(`No trials in ${dataset}.`);
    }
    return 0;
  }
  // The trial-stop door caps one request at 100 ids and 400s above it, while a
  // dataset slice can hold thousands of trials — page the batch under the
  // cap and merge the reports into the one outcome the caller reads.
  const trialClient = trials(clientConfig(inv));
  const result: StopResponse = { stopped: [], already_terminal: [], not_found: [] };
  for (let i = 0; i < trialIds.length; i += 100) {
    const page = await trialClient.stop(trialIds.slice(i, i + 100));
    result.stopped.push(...page.stopped);
    result.already_terminal.push(...page.already_terminal);
    result.not_found.push(...page.not_found);
  }
  if (inv.flags.json === true) {
    io.out(JSON.stringify(result));
    return 0;
  }
  for (const run of result.stopped) {
    io.out(`stopped ${run.id} (${run.task_name}) ${run.status}`);
  }
  for (const id of result.already_terminal) io.out(`already terminal ${id}`);
  for (const id of result.not_found) io.out(`not found ${id}`);
  io.out(
    `${result.stopped.length} stopped, ${result.already_terminal.length} already terminal, ` +
      `${result.not_found.length} not found (${dataset})`
  );
  return 0;
}

async function cmdJobResume(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const filter = inv.flags["filter-error-type"] as string[] | undefined;
  const e = await client.resume(
    await resolveJobId(inv, inv.positionals[0]),
    filter !== undefined ? { filter_error_types: filter } : undefined
  );
  if (inv.flags.json === true) {
    io.out(JSON.stringify(e));
  } else {
    for (const line of jobLines(e)) io.out(line);
    io.out("");
    io.out(`Follow it with: evolve-evals job show ${e.id}`);
  }
  return 0;
}

async function cmdJobRegrade(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const req: { statuses?: TrialStatus[]; task_name?: string } = {};
  const statuses = parseStatusFilter(inv);
  if (statuses !== undefined) req.statuses = statuses;
  if (inv.flags.task !== undefined) req.task_name = String(inv.flags.task);
  const job = await client.regrade(await resolveJobId(inv, inv.positionals[0]), req);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(job));
  } else {
    for (const line of jobLines(job)) io.out(line);
    io.out("");
    io.out(`Follow it with: evolve-evals job show ${job.id}`);
  }
  return 0;
}

async function cmdJobDownload(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const filePath = await client.download(await resolveJobId(inv, inv.positionals[0]), {
    to: (inv.flags["output-dir"] as string | undefined) ?? process.cwd(),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify({ path: filePath }));
  } else {
    io.out(`Saved ${filePath}`);
  }
  return 0;
}

async function cmdTrialShow(inv: Invocation, io: CliIO): Promise<number> {
  const client = trials(clientConfig(inv));
  const run = await client.get(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(run));
  } else {
    for (const line of trialDetailLines(run)) io.out(line);
  }
  return 0;
}

/**
 * The six artifact names `--stream` accepts — the contract's own `?stream=`
 * enum (the parsed trace first, then the raw selectors), from the SDK's own
 * list so there is no second copy of the vocabulary to keep in step.
 */
const STREAM_ARTIFACTS = TRIAL_ARTIFACT_STREAMS;
type StreamArtifact = (typeof STREAM_ARTIFACTS)[number];

async function cmdTrialDownload(inv: Invocation, io: CliIO): Promise<number> {
  const client = trials(clientConfig(inv));
  const trialId = inv.positionals[0];
  const json = inv.flags.json === true;
  const stream = inv.flags.stream as string | undefined;

  // --stream prints to stdout; -o/--overwrite save to disk. Mixing them is a
  // usage error, never a silent precedence; --cursor/--limit page only the
  // parsed events, so anywhere else they would be accepted-but-dead flags.
  if (stream !== undefined && (inv.flags["output-dir"] !== undefined || inv.flags.overwrite === true)) {
    throw new CliUsageError('"trial download" takes EITHER --stream OR -o/--overwrite, not both');
  }
  if (
    (stream === undefined || stream !== "trace-parsed") &&
    (inv.flags.cursor !== undefined || inv.flags.limit !== undefined)
  ) {
    throw new CliUsageError('--cursor/--limit page the parsed events; they apply only to --stream trace-parsed');
  }

  if (stream !== undefined) {
    if (!STREAM_ARTIFACTS.includes(stream as StreamArtifact)) {
      throw new CliUsageError(`--stream must be one of: ${STREAM_ARTIFACTS.join(", ")}`);
    }
    if (stream === "trace-parsed") {
      let count = 0;
      for await (const event of client.traceEvents(trialId, pageOptions(inv))) {
        io.out(json ? JSON.stringify(event) : traceEventLine(event));
        count += 1;
      }
      if (!json && count === 0) io.out("No trace events.");
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
    // Log-shaped selectors, "trajectory" included — that slot may be refused
    // by a server whose wave has not landed yet, and the refusal surfaces as
    // the API error it is.
    const log = await client.artifact(trialId, stream as Exclude<StreamArtifact, "trace-parsed" | "agent-home">);
    if (log === null) {
      io.out(json ? JSON.stringify({ log: null }) : `No ${stream} log was stored for this trial.`);
      return 0;
    }
    io.out(json ? JSON.stringify({ log }) : log);
    return 0;
  }

  // Save mode: everything the trial recorded lands under <output-dir>/<trial-id>/.
  // The parsed events as trace-parsed.jsonl; each raw log under its own name;
  // the agent's home folder under agent-home/ with its sandbox paths preserved.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const targetDir = join((inv.flags["output-dir"] as string | undefined) ?? "trials", trialId);
  if (existsSync(targetDir) && inv.flags.overwrite !== true) {
    throw new Error(`${targetDir} already exists (pass --overwrite to replace it)`);
  }
  await mkdir(targetDir, { recursive: true });
  const saved: string[] = [];
  const report = (line: string) => {
    saved.push(line);
    if (!json) io.out(line);
  };
  const lines: string[] = [];
  for await (const event of client.traceEvents(trialId)) {
    lines.push(JSON.stringify(event));
  }
  await writeFile(join(targetDir, "trace-parsed.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""));
  report(`trace-parsed.jsonl (${lines.length} events)`);
  for (const which of ["verifier", "trace-stdout", "trace-stderr"] as const) {
    const log = await client.artifact(trialId, which);
    if (log === null) continue;
    await writeFile(join(targetDir, `${which}.log`), log);
    report(`${which}.log (${Buffer.byteLength(log, "utf8")} bytes)`);
  }
  const home = await client.artifact(trialId, "agent-home");
  if (home !== null) {
    for (const [path, content] of Object.entries(home)) {
      const target = join(targetDir, "agent-home", ...path.split("/").filter(Boolean));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    report(`agent-home/ (${Object.keys(home).length} files)`);
  }
  if (json) {
    io.out(JSON.stringify({ path: targetDir, saved }));
  } else {
    io.out(`Saved ${targetDir}`);
  }
  return 0;
}

async function cmdTrialRegrade(inv: Invocation, io: CliIO): Promise<number> {
  const job = await trials(clientConfig(inv)).regrade(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(job));
  } else {
    for (const line of jobLines(job)) io.out(line);
    io.out("");
    io.out(`Follow it with: evolve-evals job show ${job.id}`);
  }
  return 0;
}

async function cmdTrialStop(inv: Invocation, io: CliIO): Promise<number> {
  const client = trials(clientConfig(inv));
  const result = await client.stop(inv.positionals);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(result));
    return 0;
  }
  for (const run of result.stopped) {
    io.out(`stopped ${run.id} (${run.task_name}) ${run.status}`);
  }
  for (const id of result.already_terminal) io.out(`already terminal ${id}`);
  for (const id of result.not_found) io.out(`not found ${id}`);
  return 0;
}

function datasetDetailLines(b: Dataset): string[] {
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
      lines.push(`More tasks: evolve-evals dataset show ${b.name} --cursor ${b.tasks.nextCursor}`);
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

/**
 * One quiet line per dataset whose upstream has moved, and the command that
 * acts on it.
 *
 * QUIET IS THE REQUIREMENT. This is an FYI printed under a table nobody asked
 * to be interrupted, so it is one line, it never appears when nothing moved,
 * and it never appears in --json or -q output (a machine-readable stream must
 * stay machine-readable — the same fact is already on the `upstream` field).
 *
 * It never offers to publish for you. Publishing creates an immutable version
 * and costs a build; that is a decision, and the line's whole job is to hand
 * the decision back with the exact command already written out.
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
        `run: evolve-evals dataset publish --name ${item.name} --version <new-version> ` +
        `--git <url> --ref ${item.upstream.ref}`
    );
  }
  return lines;
}

async function cmdDatasetList(inv: Invocation, io: CliIO): Promise<number> {
  if (columnsHelpRequested(inv, io, DATASET_COLUMNS)) return 0;
  const client = datasets(clientConfig(inv));
  const catalog = await client.list({
    ...pageOptions(inv),
    ...(inv.flags.search !== undefined ? { search: String(inv.flags.search) } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(catalog));
    return 0;
  }
  if (catalog.items.length === 0) {
    if (inv.flags.quiet !== true) io.out("No datasets.");
    return 0;
  }
  renderList(inv, io, catalog.items, DATASET_COLUMNS, DATASET_DEFAULT_COLUMNS, (b) => b.name);
  if (inv.flags.quiet !== true) {
    for (const line of upstreamNotices(catalog.items)) io.out(line);
  }
  return 0;
}

async function cmdDatasetShow(inv: Invocation, io: CliIO): Promise<number> {
  const client = datasets(clientConfig(inv));
  const detail = await client.get(inv.positionals[0], pageOptions(inv));
  if (inv.flags.json === true) {
    io.out(JSON.stringify(detail));
  } else {
    for (const line of datasetDetailLines(detail)) io.out(line);
    for (const line of upstreamNotices([detail])) io.out(line);
  }
  return 0;
}

async function cmdDatasetPublish(inv: Invocation, io: CliIO): Promise<number> {
  const json = inv.flags.json === true;
  const client = datasets(clientConfig(inv));
  const input = buildPublishInput(inv);
  const created = await client.publish(input);
  if (inv.flags.watch !== true) {
    if (json) {
      io.out(JSON.stringify(created));
    } else {
      for (const line of importLines(created)) io.out(line);
      io.out("");
      // Version state (VALIDATING → READY/FAILED) lives on the dataset body.
      io.out(`Follow it with: evolve-evals dataset show ${input.name}`);
    }
    return 0;
  }

  if (json) {
    io.out(JSON.stringify({ kind: "import.created", datasetImport: created }));
  } else {
    io.out(`Publish ${created.id} (${input.name}) ${created.status} — watching…`);
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

/**
 * Save a version's original corpus package. The mirror image of publish:
 * default to the working directory, print the path.
 *
 * OWNER ONLY on the server, so a dataset someone else owns reports not-found —
 * the same answer as a bad name, on purpose.
 */
async function cmdDatasetDownload(inv: Invocation, io: CliIO): Promise<number> {
  const client = datasets(clientConfig(inv));
  const filePath = await client.download(inv.positionals[0], {
    to: (inv.flags["output-dir"] as string | undefined) ?? process.cwd(),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify({ path: filePath }));
  } else {
    io.out(`Saved ${filePath}`);
  }
  return 0;
}

async function cmdDatasetActivate(inv: Invocation, io: CliIO): Promise<number> {
  const client = datasets(clientConfig(inv));
  const [name, version] = inv.positionals;
  const dataset = await client.activate(name, version);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(dataset));
  } else {
    for (const line of datasetDetailLines(dataset)) io.out(line);
  }
  return 0;
}

async function cmdAgentList(inv: Invocation, io: CliIO): Promise<number> {
  if (columnsHelpRequested(inv, io, AGENT_COLUMNS)) return 0;
  const client = agents(clientConfig(inv));
  const registered = await client.list(pageOptions(inv));
  if (inv.flags.json === true) {
    io.out(JSON.stringify(registered));
    return 0;
  }
  if (registered.items.length === 0) {
    if (inv.flags.quiet !== true) io.out("No registered agents.");
    return 0;
  }
  renderList(inv, io, registered.items, AGENT_COLUMNS, AGENT_DEFAULT_COLUMNS, (a) => a.name);
  return 0;
}

async function cmdAgentShow(inv: Invocation, io: CliIO): Promise<number> {
  const client = agents(clientConfig(inv));
  const agent = await client.get(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(agent));
  } else {
    for (const line of agentLines(agent)) io.out(line);
  }
  return 0;
}

async function cmdAgentAdd(inv: Invocation, io: CliIO): Promise<number> {
  const client = agents(clientConfig(inv));
  const created = await client.create(buildAgentInput(inv));
  if (inv.flags.json === true) {
    io.out(JSON.stringify(created));
  } else {
    for (const line of agentLines(created)) io.out(line);
    io.out("");
    io.out(`Use it with: evolve-evals run -d <dataset> -a ${created.name} -m <model>`);
  }
  return 0;
}

async function cmdAgentRemove(inv: Invocation, io: CliIO): Promise<number> {
  const client = agents(clientConfig(inv));
  const name = inv.positionals[0];
  await client.delete(name);
  if (inv.flags.json === true) {
    io.out(JSON.stringify({ name, deleted: true }));
  } else {
    io.out(`Deleted agent ${name}`);
  }
  return 0;
}

function authStatusLines(status: AuthStatus): string[] {
  const rows: string[][] = [
    ["user", status.user_id],
    ["email", status.email ?? "-"],
    ["key", status.key.id],
  ];
  if (status.key.label) rows.push(["key label", status.key.label]);
  rows.push(["key created", status.key.created_at]);
  if (status.key.last_used_at) rows.push(["key last used", status.key.last_used_at]);
  return table(rows);
}

async function cmdAuthStatus(inv: Invocation, io: CliIO): Promise<number> {
  const status = await auth(clientConfig(inv)).status();
  if (inv.flags.json === true) {
    io.out(JSON.stringify(status));
  } else {
    for (const line of authStatusLines(status)) io.out(line);
  }
  return 0;
}

// =============================================================================
// ENTRY
// =============================================================================

function helpFor(topic: string[]): { text: string; code: number } {
  if (topic.length === 0) return { text: rootHelp(), code: 0 };
  const group = GROUP_ALIASES[topic[0]] ?? topic[0];
  const groupSpec = GROUPS[group];
  if (!groupSpec) return { text: rootHelp(), code: 0 };
  if (topic.length === 1) return { text: groupHelp(group), code: 0 };
  const verb = VERB_ALIASES[topic[1]] ?? topic[1];
  const spec = groupSpec.commands[verb];
  if (!spec) return { text: groupHelp(group), code: 0 };
  return { text: commandHelp(group, verb, spec), code: 0 };
}

const HANDLERS: Record<string, (inv: Invocation, io: CliIO) => Promise<number>> = {
  "job start": cmdJobStart,
  "job list": cmdJobList,
  "job show": cmdJobShow,
  "job trials": cmdJobTrials,
  "job tasks": cmdJobTasks,
  "job compare": cmdJobCompare,
  "job cancel": cmdJobCancel,
  "job stop": cmdJobStop,
  "job resume": cmdJobResume,
  "job regrade": cmdJobRegrade,
  "job download": cmdJobDownload,
  "trial show": cmdTrialShow,
  "trial download": cmdTrialDownload,
  "trial regrade": cmdTrialRegrade,
  "trial stop": cmdTrialStop,
  "dataset list": cmdDatasetList,
  "dataset show": cmdDatasetShow,
  "dataset publish": cmdDatasetPublish,
  "dataset download": cmdDatasetDownload,
  "dataset activate": cmdDatasetActivate,
  "agent list": cmdAgentList,
  "agent show": cmdAgentShow,
  "agent add": cmdAgentAdd,
  "agent remove": cmdAgentRemove,
  "auth status": cmdAuthStatus,
};

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

  if (inv.command === "help") {
    const { text, code } = helpFor(inv.positionals);
    io.out(text);
    return code;
  }
  if (inv.command === "version") {
    io.out(cliVersion());
    return 0;
  }

  try {
    const handler = HANDLERS[inv.command];
    if (!handler) {
      // parseArgs guarantees a known command; defensive fallback
      io.err(`Error: unknown command "${inv.command}"`);
      return 2;
    }
    return await handler(inv, io);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(`Error: ${error.message}`);
      io.err(`Run "evolve-evals ${inv.command} --help" for usage.`);
      return 2;
    }
    if (error instanceof EvolveApiError && error.status === 429) {
      // A rate limit is a delay, not a mystery: name it and honor the
      // server's Retry-After instead of echoing the raw message.
      const wait = error.retryAfterSec !== undefined ? `retry in ${error.retryAfterSec}s` : "retry shortly";
      io.err(`Error: rate limited by the server — ${wait}.`);
      return 1;
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
