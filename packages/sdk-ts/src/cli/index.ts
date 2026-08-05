#!/usr/bin/env node
/**
 * evolve — the CLI for Evolve hosted datasets & jobs.
 *
 * Noun-verb grammar over the hosted client: `evolve <noun> <verb>`, plus
 * first-class top-level commands that need no noun — today that is `run`,
 * which takes `job start`'s flags and is spelled, helped and dispatched as a
 * command in its own right (Harbor registers their `run` the same way, as the
 * `job start` function bound at the top level: cli/main.py:164). Singular
 * nouns are canonical; `job`/`trial`/`dataset` also answer to their plurals as
 * hidden aliases, but `agents` does NOT — that word is reserved for the
 * managed-agents CLI and refuses with the reason. The CLI speaks ONLY through
 * the SDK clients (datasets() / agents() / jobs() / trials() / auth()) — no
 * raw HTTP lives here.
 *
 * Output: human tables on a TTY, tab-separated rows when piped, --json for
 * the rendered machine shape (NDJSON for --watch event streams), -q for
 * ids-only lists. Exit codes: 0 success (watch: job COMPLETED / publish
 * COMPLETED), 1 runtime/API failure (watch: FAILED or CANCELLED), 2 usage
 * error.
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { LineCounter, type Tags, parse as parseYaml, parseDocument } from "yaml";
import { parse as parseToml } from "smol-toml";
import {
  EVAL_SANDBOX_PROVIDERS,
  EvolveApiError,
  TRIAL_ARTIFACT_STREAMS,
  TRIAL_STATUSES,
  agents,
  auth,
  datasets,
  jobs,
  passAtK,
  skills,
  trials,
} from "../hosted/index";
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
  RetryConfigInput,
  RetryRequest,
  StopResponse,
  Task,
  TraceEvent,
  Trial,
  TrialStatus,
  UpstreamStatus,
} from "../hosted/types";

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
  preset: {
    kind: "string",
    value: "<name>",
    help:
      "Named settings preset for EVERY arm: no-internet (vendor server-side web tools " +
      "off) or pinned-context (fixed context window). Applied verbatim — an agent that " +
      "cannot guarantee it is refused by the server, never silently skipped",
  },
  ak: {
    kind: "repeat",
    aliases: ["agent-kwarg"],
    value: "key=value",
    help:
      "Agent kwarg for EVERY arm (repeatable, Harbor grammar). The delivered key is " +
      "'config': --ak 'config=<path|inline JSON>' becomes the harness's native settings " +
      "file (user config is the base, platform routing on top); the server refuses " +
      "unsupported kwargs and config keys touching billing/base-URL/routing/env",
  },
  skill: {
    kind: "repeat",
    aliases: ["skills"],
    value: "<ref|path>",
    help:
      "Skill for EVERY agent arm (repeatable): skills.sh/<owner>/<repo>[/<skill>], " +
      "org/repo[@ref], an https git URL, upload:<id>, or a local folder " +
      "(uploaded to the platform first, then referenced)",
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
  "max-retries": {
    kind: "number",
    short: "r",
    value: "<n>",
    help:
      "Max automatic retries per trial on infrastructure errors " +
      "(default: the server's fleet default; 0 = off). Each attempt carries the full trial cap",
  },
  "retry-include": {
    kind: "repeat",
    value: "<exception>",
    help: "Exception types to retry on (repeatable; default: everything --retry-exclude admits)",
  },
  "retry-exclude": {
    kind: "repeat",
    value: "<exception>",
    help:
      "Exception types to NOT retry on (repeatable; wins over --retry-include; " +
      "default: Harbor's non-retryable set)",
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
        example: "evolve job start -d deep-swe@1.1 -a codex -m gpt-5.5 -k 2 --watch",
      },
      list: {
        summary: "List your jobs (newest first)",
        flags: {
          ...LIST_FLAGS,
          search: { kind: "string", value: "<text>", help: "Free-text filter over job name and dataset names" },
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve job list --limit 20 -q",
      },
      show: {
        summary: "Show one or more jobs in full (incl. pass@k, once attempts settle)",
        flags: {},
        minPositionals: 1,
        maxPositionals: Infinity,
        positionalUsage: "<id> [id...]",
        example: "evolve job show cme12ab34",
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
        example: "evolve job trials cme12ab34 --status FAILED,SCORING_ERROR",
      },
      tasks: {
        summary: "Per-task rollup of a job",
        flags: { ...LIST_FLAGS },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve job tasks cme12ab34",
      },
      compare: {
        summary: "Compare 2-10 jobs side by side",
        flags: {},
        minPositionals: 2,
        maxPositionals: 10,
        positionalUsage: "<id> <id> [...]",
        example: "evolve job compare cme12ab34 cme56cd78",
      },
      cancel: {
        summary: "Request cancellation of a job",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve job cancel cme12ab34",
      },
      stop: {
        summary: "Stop one dataset's live trials without cancelling the job",
        flags: {
          dataset: { kind: "string", value: "<name>", help: "The dataset whose live trials to stop (required)" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve job stop cme12ab34 --dataset deep-swe",
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
        example: "evolve job resume cme12ab34 -f InfrastructureError",
      },
      retry: {
        summary: "New linked job re-running selected trials (all, failed-only, or named ids)",
        flags: {
          "failed-only": {
            kind: "boolean",
            help:
              "Only retry failed trials (SCORING_ERROR, INFRASTRUCTURE_ERROR, INDETERMINATE); " +
              "stopped and scored trials are not failures",
          },
          trial: {
            kind: "repeat",
            short: "t",
            value: "<trial-id>",
            help:
              "Retry exactly this trial (repeatable, all-or-nothing; each must be settled, " +
              "the job may still be running). Not combinable with --failed-only",
          },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve job retry cme12ab34 --failed-only",
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
        example: "evolve job regrade cme12ab34 --task tricky-task",
      },
      download: {
        summary: "Download the job's results, unpacked as the standard job-directory tree",
        flags: {
          "output-dir": {
            kind: "string",
            short: "o",
            value: "<dir>",
            help: "Directory to unpack into (default: current dir); the tree lands in <dir>/job-<id>/",
          },
          overwrite: { kind: "boolean", help: "Replace an existing <dir>/job-<id>/" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve job download cme12ab34 -o results/",
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
        example: "evolve trial show cmt90ef12",
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
              "trace-stdout | trace-stderr | trace-atif (the ATIF trajectory) | " +
              "trajectory (reserved: the harness-native session file) | agent-home",
          },
          cursor: { kind: "string", value: "<seq>", help: "With --stream trace-parsed: resume after this seq" },
          limit: { kind: "number", value: "<n>", help: "With --stream trace-parsed: max events per page" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<trial-id>",
        example: "evolve trial download cmt90ef12 --stream trace-stdout",
      },
      retry: {
        summary: "Run one settled trial again (the result IS a job)",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<trial-id>",
        example: "evolve trial retry cmt90ef12",
      },
      regrade: {
        summary: "Verifier-only re-run of one trial (the result IS a job)",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<trial-id>",
        example: "evolve trial regrade cmt90ef12",
      },
      stop: {
        summary: "Stop in-flight trials without cancelling their job",
        flags: {},
        minPositionals: 1,
        maxPositionals: Infinity,
        positionalUsage: "<trial-id> [trial-id...]",
        example: "evolve trial stop cmt90ef12 cmt34gh56",
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
        example: "evolve dataset list -q",
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
        example: "evolve dataset show deep-swe@1.1",
      },
      publish: {
        summary: "Publish a dataset version from a git source or a local directory",
        flags: {
          git: { kind: "string", value: "<url>", help: "Git repository URL (with --ref)" },
          ref: { kind: "string", value: "<ref>", help: "Git ref: branch, tag, or commit (with --git)" },
          path: { kind: "string", value: "<subfolder>", help: "Repository subfolder holding the corpus (with --git; sparse checkout — only that folder is imported)" },
          dir: { kind: "string", value: "<path>", help: "Local corpus directory (tarred + uploaded)" },
          name: { kind: "string", value: "<dataset>", help: "Catalog dataset name to create or extend (optional with --dir when the corpus carries a dataset.toml manifest; required with --git)" },
          version: { kind: "string", value: "<v>", help: "Version label for the published version (optional with --dir when dataset.toml declares one; required with --git)" },
          watch: { kind: "boolean", help: "Poll until the publish is COMPLETED or FAILED" },
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve dataset publish --name my-swe --version 1.0 --dir ./corpus --watch",
      },
      download: {
        summary: "Download the original corpus package (owner only)",
        flags: {
          "output-dir": { kind: "string", short: "o", value: "<dir>", help: "Directory to save into (default: current dir)" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<name[@version]>",
        example: "evolve dataset download my-swe@1.0 -o corpora/",
      },
      activate: {
        summary: "Make a READY version the dataset's active version",
        flags: {},
        minPositionals: 2,
        maxPositionals: 2,
        positionalUsage: "<name> <version>",
        example: "evolve dataset activate my-swe 1.0",
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
        example: "evolve agent list",
      },
      show: {
        summary: "Show one registered agent",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<name>",
        example: "evolve agent show acme-cli",
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
        example: 'evolve agent add acme-cli --install-script ./install.sh --run "acme-cli --headless"',
      },
      remove: {
        summary: "Delete a registered agent (past jobs keep their record)",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<name>",
        example: "evolve agent remove acme-cli",
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
        example: "evolve auth status",
      },
    },
  },
};

/**
 * Commands that stand at the top level with no noun in front of them. `run` is
 * `job start` under a shorter name — the same flags, the same handler — but it
 * is a command in its own right, not a spelling that gets rewritten: `evolve
 * run --help` documents `evolve run`, and an error inside it names `evolve
 * run`. Harbor binds theirs identically, the `job start` function registered as
 * a top-level command (cli/main.py:164).
 */
const TOP_LEVEL_COMMANDS: Record<string, CommandSpec> = {
  run: {
    summary: "Start a job (add --watch to follow it) — the short form of `job start`",
    flags: JOB_START_FLAGS,
    minPositionals: 0,
    maxPositionals: 0,
    example: "evolve run -d deep-swe@1.1 -a codex -m gpt-5.5 -k 2 --watch",
  },
};

/** Hidden plural aliases — the singular noun is canonical. */
const GROUP_ALIASES: Record<string, string> = {
  jobs: "job",
  trials: "trial",
  datasets: "dataset",
};

/**
 * Words this CLI deliberately does not answer to yet. `agents` would be the
 * ordinary plural alias of `agent`, and it is withheld on purpose: it belongs
 * to the managed-agents CLI that ships after launch, and quietly aliasing it to
 * the eval agent-arm catalog now would make that later meaning a breaking
 * change. A reserved word refuses by name and points at the command that does
 * exist, rather than guessing.
 */
const RESERVED_GROUPS: Record<string, string> = {
  agents: '"agents" is reserved for the managed-agents CLI (not released yet) — for eval agent arms use "evolve agent"',
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

/**
 * One command's help page. `command` is the full command as it is typed —
 * "job start" for a noun-verb command, "run" for a top-level one — so the
 * usage line always echoes the words the caller used.
 */
function commandHelp(command: string, spec: CommandSpec): string {
  const positional = spec.positionalUsage ? ` ${spec.positionalUsage}` : "";
  const options = Object.keys(spec.flags).length > 0 ? " [options]" : "";
  const lines = [
    `Usage: evolve ${command}${positional}${options}`,
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
    `Usage: evolve ${group} <command> [options]`,
    "",
    spec.summary,
    "",
    "Commands:",
  ];
  const width = Math.max(...Object.keys(spec.commands).map((v) => v.length));
  for (const [verb, cmd] of Object.entries(spec.commands)) {
    lines.push(`  ${verb.padEnd(width)}  ${cmd.summary}`);
  }
  lines.push("", `Run "evolve ${group} <command> --help" for flags and an example.`);
  return lines.join("\n");
}

function rootHelp(): string {
  const lines = [
    "evolve — Evolve hosted jobs CLI",
    "",
    "Usage: evolve <command> [options]",
    "",
    "Commands:",
  ];
  for (const [name, spec] of Object.entries(TOP_LEVEL_COMMANDS)) {
    lines.push(`  ${name.padEnd(22)} ${spec.summary}`);
  }
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
    "  evolve run -d deep-swe@1.1 -a codex -m gpt-5.5 --watch"
  );
  return lines.join("\n");
}

export const USAGE = rootHelp();

function cliVersion(): string {
  // Two levels up from both src/cli/ and dist/cli/ sits package.json.
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

/** True when the token spells a flag this command (or the globals) defines. */
function isFlagToken(spec: CommandSpec, token: string): boolean {
  if (token === "--help" || token === "-h") return true;
  if (token.startsWith("--")) {
    const name = token.slice(2).split("=")[0];
    return resolveFlag(spec, { long: name }) !== undefined;
  }
  if (token.startsWith("-") && token.length > 1) {
    const name = token.slice(1).split("=")[0];
    return resolveFlag(spec, { short: name }) !== undefined;
  }
  return false;
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
      // A value may START with '-': a glob like -*, a negative number, a bare
      // "-". The next token is refused only when it IS a flag this command
      // knows (or -h/--help) — consuming that silently would swallow the
      // caller's next option, and any other dash token is the value it looks
      // like. When the value genuinely collides with a real flag, --name=value
      // states the intent.
      if (next === undefined || isFlagToken(spec, next)) {
        const remedy = next !== undefined ? ` (use --${name}=${next} if that is the value)` : "";
        throw new CliUsageError(`Option --${name} requires a value${remedy}`);
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
  const topLevel = TOP_LEVEL_COMMANDS[head];
  if (topLevel) {
    return parseCommandArgs(head, topLevel, argv.slice(1));
  }

  const reserved = RESERVED_GROUPS[head];
  if (reserved) {
    throw new CliUsageError(reserved);
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
    throw new CliUsageError(`"${group}" requires a command (run "evolve ${group} --help")`);
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
 * The 1.1 spec's bare `y`/`n` booleans are dropped, because PyYAML never
 * adopted them — `n: 3` keeps its key. The 1.1 schema carries one bool tag per
 * boolean, and each one is named by the boolean it identifies, never by the
 * text of its regex: a tag's `test` and its `resolve` are one pair, and reading
 * only the `test` cannot tell which value the tag will produce.
 */
function withoutBareYesNoBooleans(tags: Tags): Tags {
  return tags.map((tag) =>
    typeof tag === "object" && tag.tag === "tag:yaml.org,2002:bool" && tag.test
      ? {
          ...tag,
          test: tag.identify?.(true)
            ? /^(?:[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/
            : /^(?:[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
        }
      : tag
  );
}

/**
 * PyYAML's float pattern is narrower than the 1.1 spec's the library carries:
 * it requires a dot, and it requires a SIGN on the exponent. Under the spec's,
 * `e3` is a float whose `parseFloat` is NaN and `1e3` is the number 1000, where
 * PyYAML reads both as the text they are — so a build tag `e3` was refused as
 * `.nan`, naming a value nobody wrote, and a `1e3` dataset name printed and
 * shipped as a JSON number where the wire takes a string, at exit 0.
 */
const PYYAML_FLOAT = /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*|\.[0-9][0-9_]*)$/;
const PYYAML_FLOAT_EXP = /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*|\.[0-9][0-9_]*)[eE][-+][0-9]+$/;

/**
 * Four tags answer to `tag:yaml.org,2002:float` — plain, exponent, `.inf`/`.nan`,
 * and the sexagesimal `12:30.5` — and only the first two read wider than PyYAML.
 * Each is named by a value its own test accepts, never by the text of that test,
 * because a `test` and its `resolve` are one pair and the regex alone cannot say
 * which value the tag will produce.
 */
function withPyYamlFloatShapes(tags: Tags): Tags {
  return tags.map((tag) => {
    if (typeof tag !== "object" || tag.tag !== "tag:yaml.org,2002:float" || !tag.test) return tag;
    if (tag.test.test("1.5e+3")) return { ...tag, test: PYYAML_FLOAT_EXP };
    if (tag.test.test("1.5")) return { ...tag, test: PYYAML_FLOAT };
    return tag;
  });
}

/**
 * PyYAML's integer patterns are narrower than the 1.1 spec's the library
 * carries, in the same place twice: a LEADING ZERO. A decimal integer is `0`
 * or a digit string starting `1`-`9`, so `08` and `-09` are the text they are
 * — but the library reads any digit string, so a zero-padded `08` became the
 * number 8. A sexagesimal integer starts `1`-`9` too, so `0:0` and `08:00` are
 * text, where the library made them 0 and 480. The octal, binary and hex tags
 * already carry PyYAML's own patterns, and the sexagesimal FLOAT `0:0.5` reads
 * from a leading zero in PyYAML as well — those stay untouched.
 */
const PYYAML_INT = /^[-+]?(?:0|[1-9][0-9_]*)$/;
const PYYAML_INT_SEXAGESIMAL = /^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/;

/**
 * Five tags answer to `tag:yaml.org,2002:int` — binary, octal, decimal, hex
 * and the sexagesimal `1:00` — and only the decimal and the sexagesimal read
 * wider than PyYAML. Each is named by a value its own test accepts, never by
 * the text of that test, because a `test` and its `resolve` are one pair and
 * the regex alone cannot say which value the tag will produce.
 */
function withPyYamlIntShapes(tags: Tags): Tags {
  return tags.map((tag) => {
    if (typeof tag !== "object" || tag.tag !== "tag:yaml.org,2002:int" || !tag.test) return tag;
    if (tag.test.test("1:00")) return { ...tag, test: PYYAML_INT_SEXAGESIMAL };
    if (tag.test.test("19")) return { ...tag, test: PYYAML_INT };
    return tag;
  });
}

/**
 * -c reads real YAML through the standard `yaml` package — the hand-rolled
 * subset reader is retired. PyYAML's reading is the contract, so the schema is
 * YAML 1.1 (`yes`/`on` are booleans, `012` is octal, a flow mapping is a whole
 * sequence item) with two carve-outs: the 1.1 spec's bare `y`/`n` booleans,
 * which PyYAML never adopted — `n: 3` keeps its key — and the 1.1 spec's
 * number shapes PyYAML never adopted either, where a float needs a dot and a
 * signed exponent and an integer may not be zero-padded, so `e3`, `1e3`, `08`
 * and `0:0` stay the strings a caller wrote. The schema is PINNED, not
 * merely defaulted: PyYAML's resolver has no mode but 1.1 and reads a file the
 * same way whatever its `%YAML` directive says, while this library lets an
 * explicit `%YAML 1.2` swap in the 1.2 core schema. One file, one reading.
 * Three refusals sit on top of the library: a second document, an unresolvable
 * tag (both PyYAML refusals too), and a duplicate key — PyYAML silently keeps
 * the last value, and that silence is exactly the corruption a config file
 * cannot afford. Every refusal names its `source` and carries `:line` wherever
 * the parser places the problem — the library's alias-bomb guard fires at
 * resolution, after parsing, and has no position to give. An empty or
 * comment-only file is an empty object.
 */
export function parseYamlConfig(text: string, source: string): unknown {
  return parseYamlConfigLocated(text, source).value;
}

/** A path into the parsed config: object keys and list indices, root first. */
type ConfigPath = (string | number)[];

/**
 * `parseYamlConfig` plus a `locate` that answers "what line does this path
 * start on", so a schema refusal can point at the file the way a parse
 * refusal already does. JSON configs have no locator — JSON.parse keeps no
 * positions — and every message treats the line as optional for that reason.
 */
export function parseYamlConfigLocated(
  text: string,
  source: string
): { value: unknown; locate: (path: ConfigPath) => number | undefined } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    version: "1.1",
    schema: "yaml-1.1",
    resolveKnownTags: false,
    lineCounter,
    customTags: (tags) =>
      withPyYamlIntShapes(withPyYamlFloatShapes(withoutBareYesNoBooleans(tags))),
  });
  // Warnings refuse too: the library downgrades an unresolvable tag to a
  // warning and parses on, where PyYAML (and this CLI, always) refuses.
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    const line = problem.linePos?.[0]?.line ?? 1;
    const what =
      problem.code === "MULTIPLE_DOCS"
        ? "multi-document YAML is not supported here — one config per file"
        : problem.message.replace(/ at line \d+, column \d+:[\s\S]*$/, "");
    throw new CliUsageError(`${source}:${line}: ${what}`);
  }
  // Aliases resolve in `toJS`, not in the parse, so the library's own
  // resource-exhaustion guard throws PAST the check above. Unwrapped it left
  // this reader as a bare exit 1 naming no file, where every other config
  // refusal is a usage exit 2 naming its source. `toJS` also narrates on its
  // own account — a collection-valued key emits a Node warning about JS object
  // restrictions — and this CLI speaks its own refusals and nothing else. The
  // level is dropped HERE and not in the parse options, because a silent parse
  // also drops the library's second-document error, which is a refusal.
  doc.options.logLevel = "silent";
  let value: unknown;
  try {
    value = doc.toJS() ?? {};
  } catch (error) {
    throw new CliUsageError(`${source}: ${(error as Error).message}`);
  }
  const locate = (path: ConfigPath): number | undefined => {
    const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
    const offset = node?.range?.[0];
    return offset === undefined ? undefined : lineCounter.linePos(offset).line;
  };
  return { value, locate };
}

// -----------------------------------------------------------------------------
// SPEC-DERIVED CONFIG SCHEMA (-c validates against spec/openapi.yaml itself)
// -----------------------------------------------------------------------------

/**
 * The -c vocabulary is DERIVED from spec/openapi.yaml — the same file the
 * package ships and the drift gates read. The JobCreate schema, and everything
 * it references (DatasetSelector, AgentArmInput, SandboxProvider), IS the
 * closed key vocabulary, the per-field types, and the value constraints — so a
 * field the spec grows is accepted here with zero CLI edits, and one it drops
 * is refused the same day. Only the YAML-side value laws stay hand-written
 * (checkWireValue): what a JSON body can carry at all is not the spec's
 * subject.
 *
 * The published package carries the spec two directories above dist/cli/;
 * a source checkout reads the repo-root copy the staged one is built from.
 */
const SPEC_RELATIVE_CANDIDATES = ["../../spec/openapi.yaml", "../../../../spec/openapi.yaml"];

type SpecSchema = Record<string, unknown>;

interface JobSpecShapes {
  root: SpecSchema;
  components: Record<string, SpecSchema>;
}

let jobSpecShapes: JobSpecShapes | undefined;

function loadJobSpecShapes(): JobSpecShapes {
  if (jobSpecShapes) return jobSpecShapes;
  const tried: string[] = [];
  for (const relative of SPEC_RELATIVE_CANDIDATES) {
    const specPath = fileURLToPath(new URL(relative, import.meta.url));
    tried.push(specPath);
    if (!existsSync(specPath)) continue;
    const spec = parseYaml(readFileSync(specPath, "utf-8")) as {
      components?: { schemas?: Record<string, SpecSchema> };
    };
    const components = spec?.components?.schemas;
    const root = components?.JobCreate;
    // Non-vacuous on purpose: a spec that parses but carries no JobCreate
    // would otherwise validate nothing and accept everything.
    if (!components || !root || typeof root !== "object") {
      throw new Error(`${specPath} carries no components.schemas.JobCreate — the contract this CLI validates -c against`);
    }
    jobSpecShapes = { root, components };
    return jobSpecShapes;
  }
  throw new Error(
    `spec/openapi.yaml not found (tried: ${tried.join(", ")}) — the package ships it; reinstall the SDK`
  );
}

/** A schema node's `type`, normalized to a list ("string" and ["string","null"] alike). */
function schemaTypes(schema: SpecSchema): string[] {
  const type = schema.type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}

/** Follow a local $ref, returning the resolved schema and its component name. */
function resolveSchema(
  schema: SpecSchema,
  components: Record<string, SpecSchema>,
  specName: string
): { schema: SpecSchema; specName: string } {
  const ref = schema.$ref;
  if (typeof ref !== "string") return { schema, specName };
  const name = ref.replace("#/components/schemas/", "");
  const target = components[name];
  if (!target) throw new Error(`spec/openapi.yaml: unresolvable $ref "${ref}"`);
  return resolveSchema(target, components, name);
}

/** Render a config path the way every refusal names it: datasets[0].version. */
function renderConfigPath(path: ConfigPath): string {
  // A bare top-level key keeps its historical quoted spelling ("job_name").
  if (path.length === 1 && typeof path[0] === "string") return `"${path[0]}"`;
  return path
    .map((seg, i) => (typeof seg === "number" ? `[${seg}]` : i === 0 ? seg : `.${seg}`))
    .join("");
}

interface SchemaContext {
  source: string;
  locate?: (path: ConfigPath) => number | undefined;
  components: Record<string, SpecSchema>;
}

/** "<where> in <file>[:line]" — the position every schema refusal opens with. */
function describeSite(path: ConfigPath, ctx: SchemaContext): string {
  const line = ctx.locate?.(path);
  const site = `${ctx.source}${line !== undefined ? `:${line}` : ""}`;
  return path.length === 0 ? site : `${renderConfigPath(path)} in ${site}`;
}

function schemaRefusal(path: ConfigPath, ctx: SchemaContext, what: string, specName: string): never {
  throw new CliUsageError(`--config: ${describeSite(path, ctx)} ${what} [spec: ${specName}]`);
}

/** The last object key on the path, for the quoting remedy a string refusal shows. */
function lastKey(path: ConfigPath): string {
  for (let i = path.length - 1; i >= 0; i--) {
    if (typeof path[i] === "string") return path[i] as string;
  }
  return "value";
}

/** Name a list schema by what its items are, so the refusal reads as a remedy. */
function describeListSchema(items: SpecSchema | undefined, ctx: SchemaContext): string {
  if (!items) return "a list";
  const resolved = resolveSchema(items, ctx.components, "");
  const types = schemaTypes(resolved.schema);
  if (types.includes("string")) return "a list of strings";
  if (types.includes("object")) return "a list of objects";
  return "a list";
}

/**
 * Validate one config value against one spec schema, refusing with the config
 * path, the file (and line, when the YAML reader can place it), and the spec
 * shape that ruled. `topLevel` suppresses ONLY the root object's `required`:
 * a -c file is a partial the flags may complete (-d, -a/-m), and buildJobInput
 * enforces presence after the merge. Nested required keys hold — no flag
 * completes a selector entry.
 */
function checkAgainstSchema(
  value: unknown,
  rawSchema: SpecSchema,
  path: ConfigPath,
  specName: string,
  ctx: SchemaContext,
  topLevel = false
): void {
  const { schema, specName: name } = resolveSchema(rawSchema, ctx.components, specName);
  const types = schemaTypes(schema);
  const propertyName = (prop: string) => (name ? `${name}.${prop}` : prop);

  if (value === null) {
    if (types.includes("null")) return;
    schemaRefusal(path, ctx, `must be a ${types[0] ?? "value"}, not null`, name);
  }

  if (types.includes("object")) {
    const additional = isPlainObject(schema.additionalProperties)
      ? (schema.additionalProperties as SpecSchema)
      : undefined;
    if (!isPlainObject(value)) {
      // An env-style map (typed values, no fixed keys) refuses in its own
      // vocabulary — the remedy is KEY: "value" lines, not "an object".
      const what =
        additional && !schema.properties
          ? `must be a map of KEY: "value" pairs, not ${describeConfigValue(value)}`
          : `must be an object like {${firstRequiredKey(schema)}: "..."}, not ${describeConfigValue(value)}`;
      schemaRefusal(path, ctx, what, name);
    }
    const properties = isPlainObject(schema.properties)
      ? (schema.properties as Record<string, SpecSchema>)
      : undefined;
    if (properties) {
      if (!topLevel && Array.isArray(schema.required)) {
        for (const required of schema.required) {
          if (typeof required === "string" && value[required] === undefined) {
            schemaRefusal(path, ctx, `is missing the required key "${required}"`, name);
          }
        }
      }
      for (const key of Object.keys(value)) {
        if (properties[key] === undefined && !additional) {
          throw new CliUsageError(
            `--config: unknown key "${key}" in ${describeSite([...path, key], ctx)} ` +
              `(allowed: ${Object.keys(properties).join(", ")}) [spec: ${name}]`
          );
        }
      }
      for (const [key, propSchema] of Object.entries(properties)) {
        const item = value[key];
        if (item === undefined) continue;
        checkAgainstSchema(item, propSchema, [...path, key], propertyName(key), ctx);
      }
    }
    if (additional) {
      for (const [key, item] of Object.entries(value)) {
        if (properties?.[key] !== undefined) continue;
        checkAgainstSchema(item, additional, [...path, key], name, ctx);
      }
    }
    return;
  }

  if (types.includes("array")) {
    const items = isPlainObject(schema.items) ? (schema.items as SpecSchema) : undefined;
    if (!Array.isArray(value)) {
      schemaRefusal(
        path,
        ctx,
        `must be ${describeListSchema(items, ctx)}, not ${describeConfigValue(value)}`,
        name
      );
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      schemaRefusal(path, ctx, `needs at least ${schema.minItems} ${schema.minItems === 1 ? "entry" : "entries"}`, name);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      schemaRefusal(path, ctx, `takes at most ${schema.maxItems} entries`, name);
    }
    if (items) {
      value.forEach((item, index) => checkAgainstSchema(item, items, [...path, index], name, ctx));
    }
    return;
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      schemaRefusal(path, ctx, `must be one of: ${schema.enum.join(", ")}`, name);
    }
    return;
  }

  if (types.includes("string")) {
    if (typeof value !== "string") {
      schemaRefusal(
        path,
        ctx,
        `must be a string, not ${describeConfigValue(value)} — quote it (${lastKey(path)}: "...")`,
        name
      );
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      schemaRefusal(path, ctx, `must be at most ${schema.maxLength} characters (got ${value.length})`, name);
    }
    return;
  }

  if (types.includes("integer") || types.includes("number")) {
    const wantsInteger = types.includes("integer");
    if (typeof value !== "number" || (wantsInteger && !Number.isInteger(value))) {
      schemaRefusal(
        path,
        ctx,
        `must be ${wantsInteger ? "an integer" : "a number"}, not ${describeConfigValue(value)}`,
        name
      );
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      schemaRefusal(path, ctx, `must be at least ${schema.minimum}`, name);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      schemaRefusal(path, ctx, `must be at most ${schema.maximum}`, name);
    }
    return;
  }

  if (types.includes("boolean") && typeof value !== "boolean") {
    schemaRefusal(path, ctx, `must be a boolean, not ${describeConfigValue(value)}`, name);
  }
}

/** The first required key of an object schema, for the {key: "..."} example a refusal shows. */
function firstRequiredKey(schema: SpecSchema): string {
  const required = Array.isArray(schema.required) ? schema.required[0] : undefined;
  if (typeof required === "string") return required;
  const properties = isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
  return properties[0] ?? "name";
}

/** Validate a parsed -c file against the spec's own JobCreate shape. */
function validateJobConfigAgainstSpec(
  record: Record<string, unknown>,
  source: string,
  locate?: (path: ConfigPath) => number | undefined
): void {
  const { root, components } = loadJobSpecShapes();
  checkAgainstSchema(record, root, [], "JobCreate", { source, locate, components }, true);
}

/** Name a config value by what it is, for a refusal the reader can act on. */
function describeConfigValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return `a ${value.constructor?.name ?? "object"}`;
  return `a ${typeof value}`;
}

/** A mapping the wire can carry as an object — not a Date, a Set, a Buffer. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * YAML 1.1 resolves more than a JSON body can carry, and `JSON.stringify` does
 * not refuse the surplus — it REWRITES it: `2026-08-02` is a Date and leaves as
 * an ISO string, `.inf`/`.nan` leave as `null`, `!!binary` as a `{"type":
 * "Buffer"}` object, `!!set` as `{}`. `job_name` is typed loosely enough in the
 * spec that the server ACCEPTS the rewrite, so that one lands as the job's name
 * with nothing anywhere saying so. Every value is checked at every depth,
 * because selector fields ride the same wire.
 *
 * An alias may also point back at a collection that CONTAINS it — `agent_env:
 * &a` over `X: *a` is two lines of valid YAML and the library hands back an
 * object holding itself. The library's own alias guard counts resources and
 * one alias exhausts nothing, so it does not fire; `JSON.stringify` would
 * refuse the cycle, but this walk reaches it first and used to descend until
 * the stack ran out — a bare exit 1 reading `Maximum call stack size
 * exceeded`, naming no file and no key, the very shape the alias bomb was
 * moved off. `ancestors` carries the containers open on the path from the
 * root, so a value that reappears BENEATH itself is a cycle and refuses by
 * name, while the same anchor used twice side by side is a plain repeat and
 * still passes — hence the delete on the way back up.
 */
function checkWireValue(
  value: unknown,
  where: string,
  source: string,
  ancestors: WeakSet<object> = new WeakSet()
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new CliUsageError(
      `--config: ${where} in ${source} is ${Number.isNaN(value) ? ".nan" : "infinite"} — ` +
        `a JSON body carries finite numbers only`
    );
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (ancestors.has(value)) {
      throw new CliUsageError(
        `--config: ${where} in ${source} is an alias of a value that contains it — ` +
          `a JSON body cannot carry a cycle`
      );
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => checkWireValue(item, `${where}[${index}]`, source, ancestors));
    } else {
      for (const [key, item] of Object.entries(value)) {
        checkWireValue(item, `${where}.${key}`, source, ancestors);
      }
    }
    ancestors.delete(value);
    return;
  }
  throw new CliUsageError(
    `--config: ${where} in ${source} resolved to ${describeConfigValue(value)}, which a JSON body ` +
      `cannot carry — quote the value to keep it text`
  );
}

function loadJobConfig(path: string, read: (path: string) => string): Partial<JobCreate> {
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    throw new CliUsageError(`--config: cannot read ${path}: ${(error as Error).message}`);
  }
  let value: unknown;
  let locate: ((path: ConfigPath) => number | undefined) | undefined;
  if (path.endsWith(".json")) {
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new CliUsageError(`--config: ${path} is not valid JSON: ${(error as Error).message}`);
    }
  } else {
    ({ value, locate } = parseYamlConfigLocated(text, path));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(`--config: ${path} must contain a JSON/YAML object`);
  }
  const record = value as Record<string, unknown>;
  // The wire law first (cycles, Dates, .inf — what a JSON body can carry at
  // all), then the contract's own shapes: keys, types, ranges and vocabularies
  // all read out of spec/openapi.yaml. The file's own text decides its types,
  // so this reader owns them at the keyboard — `job_name: yes` is a boolean
  // and `version: 1.10` the float 1.1 in every YAML reading there is, and
  // both used to reach --print-config at exit 0 (1.10 and 1.1 name DIFFERENT
  // dataset versions). What only the server knows — whether a name exists —
  // stays the server's.
  for (const [key, item] of Object.entries(record)) checkWireValue(item, key, path);
  validateJobConfigAgainstSpec(record, path, locate);
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

/**
 * Parse one --ak value by Harbor's kwarg grammar (their cli/utils.py
 * parse_kwargs): JSON first, then the Python literals JSON does not know,
 * else the text verbatim — so `--ak key=3` is a number, `--ak key=True` a
 * boolean, and `--ak key=high` a string, exactly as `harbor run` reads them.
 */
function parseKwargValue(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    if (trimmed === "True") return true;
    if (trimmed === "False") return false;
    if (trimmed === "None") return null;
    return trimmed;
  }
}

/**
 * Parse repeatable --ak key=value pairs into the wire's agents[].kwargs
 * object. The `config` key gets the channel's one client-side mechanic: a
 * string value is a LOCAL settings file (the server never reads a client
 * path), resolved here to its parsed content — JSON or TOML by extension,
 * with a both-ways attempt for anything else. Every other key rides verbatim;
 * acceptance is the server's.
 */
export function parseAgentKwargs(
  pairs: string[],
  read: (path: string) => string = (path) => readFileSync(path, "utf-8")
): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new CliUsageError(`Invalid --ak "${pair}": expected key=value`);
    }
    const key = pair.slice(0, eq).trim();
    let value = parseKwargValue(pair.slice(eq + 1));
    if (key === "config" && typeof value === "string") {
      value = loadAgentConfigFile(value, read);
    }
    kwargs[key] = value;
  }
  return kwargs;
}

/** Read and parse a local agent settings file for --ak config=<path>. */
function loadAgentConfigFile(
  path: string,
  read: (path: string) => string
): Record<string, unknown> {
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    throw new CliUsageError(`--ak config: cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  if (path.endsWith(".toml")) {
    try {
      parsed = parseToml(text);
    } catch (error) {
      throw new CliUsageError(`--ak config: ${path} is not valid TOML: ${(error as Error).message}`);
    }
  } else if (path.endsWith(".json")) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CliUsageError(`--ak config: ${path} is not valid JSON: ${(error as Error).message}`);
    }
  } else {
    try {
      parsed = JSON.parse(text);
    } catch {
      try {
        parsed = parseToml(text);
      } catch {
        throw new CliUsageError(
          `--ak config: ${path} parses as neither JSON nor TOML; use a .json or .toml settings file`
        );
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliUsageError(`--ak config: ${path} must contain a settings object`);
  }
  return parsed as Record<string, unknown>;
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
 * Build the POST /api/jobs body from a parsed `job start` / `run` invocation:
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
    // Name the command the caller actually typed: someone who ran `evolve run`
    // is told about "run", not about a spelling they never used.
    throw new CliUsageError(`"${inv.command}" requires -d/--dataset (or datasets in --config)`);
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
    throw new CliUsageError(`"${inv.command}" requires -a/--agent and -m/--model (or agents in --config)`);
  }
  if (f.effort !== undefined) {
    // --effort is stamped on EVERY arm, verbatim. The server owns the
    // per-agent refusal, so the CLI never edits the list to dodge one —
    // silently dropping the value for some arms would run a sweep the flag no
    // longer describes.
    arms = arms.map((arm) => ({ ...arm, reasoning_effort: f.effort as string }));
  }
  if (f.ak !== undefined) {
    // --ak is stamped on EVERY arm, Harbor's own merge posture (their jobs.py
    // updates each configured agent's kwargs with the flag's pairs). Config
    // FILE paths are resolved to inline content here — the server never
    // reads a client path — and the server owns every refusal.
    const kwargs = parseAgentKwargs(f.ak as string[], read);
    arms = arms.map((arm) => ({ ...arm, kwargs: { ...(arm.kwargs ?? {}), ...kwargs } }));
  }
  if (f.preset !== undefined) {
    // --preset is stamped on EVERY arm, verbatim, like --effort: the server
    // owns the preset vocabulary and the per-agent guarantee refusal
    // (agent_preset_unsupported) — a client-side check would just be a second
    // copy of the server's table that could drift from what is enforced.
    arms = arms.map((arm) => ({ ...arm, preset: f.preset as string }));
  }
  if (f.skill !== undefined) {
    // --skill is stamped on EVERY arm, like --effort: one flag grammar, one
    // sweep. Local folder entries stay verbatim here — cmdJobStart uploads
    // them and swaps in the upload:<id> handles before the body is sent, so
    // --print-config shows the path you typed, not a side effect.
    arms = arms.map((arm) => ({ ...arm, skills: [...(f.skill as string[])] }));
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

  // Retry policy: the config file's `retry` object is the base and each flag
  // overrides ITS field — Harbor's own CLI merge rule (their jobs.py applies
  // --max-retries/--retry-include/--retry-exclude onto config.retry field by
  // field). Omitted entirely, the server applies its fleet defaults.
  const retry: RetryConfigInput = { ...(base.retry ?? {}) };
  if (f["max-retries"] !== undefined) retry.max_retries = f["max-retries"] as number;
  if (f["retry-include"] !== undefined) retry.include_exceptions = f["retry-include"] as string[];
  if (f["retry-exclude"] !== undefined) retry.exclude_exceptions = f["retry-exclude"] as string[];

  return {
    ...(jobName !== undefined ? { job_name: jobName } : {}),
    datasets: selectors,
    agents: arms,
    ...(nAttempts !== undefined ? { n_attempts: nAttempts } : {}),
    ...(nConcurrent !== undefined ? { n_concurrent_trials: nConcurrent } : {}),
    ...(maxSpend !== undefined ? { max_trial_spend_usd: maxSpend } : {}),
    ...(provider !== undefined ? { sandbox_provider: provider } : {}),
    ...(Object.keys(retry).length > 0 ? { retry } : {}),
    ...(agentEnv !== undefined ? { agent_env: agentEnv } : {}),
    ...(verifierEnv !== undefined ? { verifier_env: verifierEnv } : {}),
  };
}

/**
 * Build the datasets().publish() input from a parsed `dataset publish`
 * invocation. `--name`/`--version` are optional with `--dir`: a corpus
 * carrying a dataset.toml manifest supplies them server-side (Harbor's
 * dataset layout), and the SDK refuses before uploading when neither the
 * flags nor a manifest exist. A git source always requires both — its
 * manifest is only readable after the server clones it.
 */
export function buildPublishInput(inv: Invocation): PublishDatasetInput {
  const f = inv.flags;
  const hasDir = typeof f.dir === "string";
  const hasGit =
    typeof f.git === "string" || typeof f.ref === "string" || typeof f.path === "string";
  if (hasDir && hasGit) {
    throw new CliUsageError('"dataset publish" takes EITHER --dir OR --git/--ref/--path, not both');
  }
  if (hasDir) {
    return {
      source: { directory: f.dir as string },
      ...(typeof f.name === "string" ? { name: f.name } : {}),
      ...(typeof f.version === "string" ? { version: f.version } : {}),
    };
  }
  for (const req of ["git", "ref", "name", "version"] as const) {
    if (typeof f[req] !== "string") {
      const suffix =
        req === "git" || req === "ref"
          ? " (or --dir for a local corpus directory)"
          : " (a git source cannot take it from dataset.toml — the repository is only cloned after the publish is accepted)";
      throw new CliUsageError(`"dataset publish" requires --${req}${suffix}`);
    }
  }
  return {
    source: {
      git_url: f.git as string,
      git_ref: f.ref as string,
      // --path narrows the import to ONE repository subfolder (the server
      // fetches it with a sparse checkout); absent = the repository root.
      ...(typeof f.path === "string" ? { git_path: f.path } : {}),
    },
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
  // Skills, per arm: the requested (pinned) references, then — once the arm's
  // first trial has resolved them — the locks: exactly what mounted, at which
  // commit or content digest. Reproducibility is a thing you can read.
  for (const arm of e.agents) {
    if (arm.skills.length > 0) {
      rows.push(["skills", `${fmtAgent(arm)}: ${arm.skills.join(", ")}`]);
    }
    for (const lock of arm.skill_locks ?? []) {
      rows.push([
        "skill lock",
        `${lock.name} @ ${lock.git_commit_id ? lock.git_commit_id.slice(0, 12) : lock.digest.slice(0, 19)}`,
      ]);
    }
  }
  rows.push([
    "size",
    `${e.counts.agents} agent(s) x ${e.counts.tasks} task(s) = ${e.n_total_trials} trial(s)`,
  ]);
  rows.push(["attempts/task", String(e.n_attempts)]);
  rows.push(["concurrency", String(e.n_concurrent_trials)]);
  rows.push(["max spend/trial", fmtUsd(e.max_trial_spend_usd)]);
  rows.push(["worst case", fmtUsd(e.worst_case_spend_usd)]);
  // The retry policy and its consumption. "worst case" above already includes
  // the (max_retries + 1) product; this row says why.
  rows.push([
    "retries",
    `${e.retry.max_retries}/trial on infrastructure errors` +
      ((e.stats.n_retries ?? 0) > 0 ? ` (${e.stats.n_retries} used)` : ""),
  ]);
  rows.push(["provider", e.sandbox_provider]);
  rows.push(["spent", fmtUsd(e.stats.cost_usd)]);
  // GPU compute is a SEPARATE labeled estimate (lane 5) — never summed into
  // the spent row above, and absent entirely for a job with no GPU trials.
  if (e.stats.gpu_cost_usd != null) {
    rows.push(["gpu compute (est.)", `$${e.stats.gpu_cost_usd.toFixed(4)}`]);
  }
  // The judge share of the bill, itemized only when one exists: `spent` above
  // is the WHOLE bill (agent + judge), and a job with no judge tasks holds a
  // judge share of 0 — a row saying "$0.00 of judging" would be noise.
  if (e.stats.judge_cost_usd != null && e.stats.judge_cost_usd > 0) {
    rows.push(["spent (judge)", fmtUsd(e.stats.judge_cost_usd)]);
  }
  // Only the statuses actually present: the response names all of them (so a
  // client never hardcodes the enum), but a row of eight zeros helps nobody.
  const histogram = Object.entries(e.trials.byStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`)
    .join(" · ");
  if (histogram) rows.push(["trials", histogram]);
  for (const source of e.source_jobs) {
    // One label per verb — the stored action IS the word.
    rows.push([
      source.action === "regrade"
        ? "regrade of"
        : source.action === "retry"
          ? "retry of"
          : "resume of",
      source.job_id,
    ]);
  }
  if (e.idempotent_replay) rows.push(["note", "idempotent replay of an existing job"]);
  if (e.failure) rows.push(["failure", `${e.failure.code}: ${e.failure.message}`]);
  rows.push(["started", e.started_at]);
  rows.push(["updated", e.updated_at]);
  return [...table(rows), ...passAtKLines(e)];
}

/**
 * The pass@k block, one line per evals group that has numbers — its own table
 * below the detail rows, because an evals key is far wider than any label
 * column and folding it in would pad every other row to its width.
 *
 * Silent when nothing is computed: a single-attempt job has no k to answer,
 * and a group whose rewards are not binary, or whose attempts are still in
 * flight, deliberately reports nothing rather than a number that would mean
 * something else. `--json` always carries the raw `stats.evals[].pass_at_k`.
 */
function passAtKLines(e: Job): string[] {
  const groups = passAtK(e);
  if (groups.length === 0) return [];
  const rows = groups.map((group) => [
    `  ${group.evals_key}`,
    group.points.map((point) => `pass@${point.k} ${point.value.toFixed(3)}`).join("  "),
  ]);
  return ["", "pass@k", ...table(rows)];
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
  {
    // GPU compute estimate — its own column, never folded into SPENT (lane-5
    // law). Opt-in via --columns; "-" for non-GPU trials and unpriced ones.
    key: "gpu",
    header: "GPU (EST)",
    cell: (r) =>
      r.gpu_cost?.estimate_usd != null ? `$${r.gpu_cost.estimate_usd.toFixed(4)}` : "-",
  },
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
 * Full-detail rendering of one trial — evolve trial show. Exported for
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
  // THE JUDGE'S SHARE, itemized beside the agent's when this task's verifier
  // ran an LLM judge on its own gateway key (judge_result present). The agent
  // figure above stays the agent's alone; the trial's whole bill is the sum.
  if (run.judge_result) {
    rows.push(["spent (judge)", fmtUsd(run.judge_result.cost_usd)]);
  }
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
  // The GPU degrade, when one happened: where the job asked to run vs where
  // the boxes actually ran, with the refusing provider's own reason.
  if (run.sandbox_provider_degrade) {
    const d = run.sandbox_provider_degrade;
    rows.push(["provider degrade", `${d.from} → ${d.to}: ${d.reason}`]);
  }
  // GPU compute (lane 5): a SEPARATE labeled estimate, never folded into the
  // spent row above. Priced = the full audit sentence (what x how long x whose
  // rate card); unpriced = the server's own reason, verbatim — a number is
  // never invented client-side.
  if (run.gpu_cost) {
    const g = run.gpu_cost;
    if (g.estimate_usd != null) {
      const type = g.gpu_type ?? g.declared_gpu_type;
      const duration =
        g.duration_sec != null ? `${Math.round(g.duration_sec)}s` : "unmeasured";
      const card = `rate card v${g.rate_card.version}${
        g.rate_card.source ? `, ${g.rate_card.source} ${g.rate_card.source_date ?? ""}`.trimEnd() : ""
      }`;
      rows.push([
        "gpu compute (est.)",
        `$${g.estimate_usd.toFixed(4)} — ${type} x${g.gpu_count}, ${duration} on ${g.provider} (${card})`,
      ]);
    } else {
      rows.push(["gpu compute (est.)", `not priced — ${g.unpriced_reason ?? "no reason recorded"}`]);
    }
  }
  if (run.sandbox_id) rows.push(["sandbox", run.sandbox_id]);
  if (run.verifier_environment_mode) rows.push(["verifier", run.verifier_environment_mode]);
  if (run.verifier_sandbox_id) rows.push(["verifier sandbox", run.verifier_sandbox_id]);
  if (run.agent_info.version) rows.push(["agent version", run.agent_info.version]);
  if (run.exception_info) {
    rows.push(["failure type", run.exception_info.exception_type]);
    rows.push(["failure detail", run.exception_info.exception_message]);
  }
  // ATTEMPT LINEAGE: one row per retried-away attempt, oldest first — the
  // trial body above is the FINAL attempt, so a scored trial that took three
  // attempts shows where the other two died and what they cost.
  if (run.n_retries > 0) {
    rows.push(["auto-retries", String(run.n_retries)]);
    for (const attempt of run.retries) {
      rows.push([
        `attempt ${attempt.attempt_number}`,
        `${attempt.exception_info.exception_type}` +
          ` · spent ${fmtUsd(attempt.cost_usd)}` +
          (attempt.settled_at ? ` · settled ${attempt.settled_at}` : ""),
      ]);
    }
  }
  if (run.session_ref) rows.push(["session", run.session_ref]);
  if (run.started_at) rows.push(["started", run.started_at]);
  if (run.finished_at) rows.push(["finished", run.finished_at]);
  return table(rows);
}

/**
 * One registered agent — evolve agent show / add. Declared env is shown
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

/**
 * Compact per-provider verdicts, e.g. "e2b ok · daytona ok · modal NO".
 * A GPU degrade renders as "e2b →modal": the job runs there, on modal.
 */
function fmtProviders(providers: Task["providers"]): string {
  return PROVIDER_ORDER.filter((provider) => providers?.[provider] !== undefined)
    .map((provider) => {
      const verdict = providers[provider];
      if (!verdict.ok) return `${provider} NO`;
      return verdict.degrades_to ? `${provider} →${verdict.degrades_to}` : `${provider} ok`;
    })
    .join(" · ");
}

/** "1x any GPU" / "2x H100|A100" — the task's declared GPU requirement. */
function fmtGpu(t: Task): string | null {
  const gpus = t.gpus ?? 0;
  if (gpus <= 0) return null;
  const types = t.gpu_types && t.gpu_types.length > 0 ? t.gpu_types.join("|") : "any GPU";
  return `${gpus}x ${types}`;
}

function fmtReward(reward: number | null): string {
  return reward !== null ? String(Math.round(reward * 1000) / 1000) : "-";
}

/** One trace event line — evolve trial download --stream trace-parsed. */
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
 * ONE walk of the caller's job list per invocation, not one per id.
 * `job compare <a> <b> <c>` resolves three prefixes and used to paginate the
 * whole list three times to answer a question one walk answers; the promise
 * is cached, so the ids are also read once when the resolutions overlap.
 * Per INVOCATION, never process-wide: a long-lived host importing runCli must
 * not answer a later command from an older list.
 */
const JOB_ID_INDEX = new WeakMap<Invocation, Promise<string[]>>();

function jobIdIndex(inv: Invocation): Promise<string[]> {
  const cached = JOB_ID_INDEX.get(inv);
  if (cached) return cached;
  const walk = (async () => {
    const client = jobs(clientConfig(inv));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const job of page.items) ids.push(job.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  })();
  JOB_ID_INDEX.set(inv, walk);
  return walk;
}

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
  const prefix = ref.toLowerCase();
  // A SET of ids, not a list: the cursor window shifts while paging (jobs are
  // created newest-first), so one job can be read on two pages — counting it
  // twice refused an unambiguous prefix as "ambiguous — it matches 2 jobs"
  // naming the same id twice. Ambiguity is about distinct jobs.
  const matches = new Set<string>();
  for (const id of await jobIdIndex(inv)) {
    if (id.startsWith(prefix)) matches.add(id);
  }
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

/** A --skill value the server would refuse verbatim: a local folder path. */
function isLocalSkillPath(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.startsWith("~")
  );
}

/**
 * Upload every local-folder skill entry and swap in its `upload:<id>` handle.
 * One upload per distinct path even when several arms carry it; a folder that
 * is a root of skills becomes one handle per contained skill, in name order.
 */
async function resolveLocalSkillUploads(
  input: JobCreate,
  inv: Invocation,
  io: CliIO
): Promise<JobCreate> {
  const localPaths = new Set<string>();
  for (const arm of input.agents) {
    for (const ref of arm.skills ?? []) {
      if (isLocalSkillPath(ref)) localPaths.add(ref);
    }
  }
  if (localPaths.size === 0) return input;

  const client = skills(clientConfig(inv));
  const uploadedRefs = new Map<string, string[]>();
  for (const path of localPaths) {
    const uploaded = await client.upload(path);
    uploadedRefs.set(path, uploaded.map((u) => u.ref));
    if (inv.flags.json !== true) {
      for (const u of uploaded) {
        io.err(`Uploaded skill ${u.name} (${u.ref}, ${u.digest.slice(0, 19)}…)`);
      }
    }
  }
  return {
    ...input,
    agents: input.agents.map((arm) => ({
      ...arm,
      ...(arm.skills !== undefined && arm.skills !== null
        ? { skills: arm.skills.flatMap((ref) => uploadedRefs.get(ref) ?? [ref]) }
        : {}),
    })),
  };
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

  const created = await client.start(await resolveLocalSkillUploads(input, inv, io));
  if (!watch) {
    if (json) {
      io.out(JSON.stringify(created));
    } else {
      for (const line of jobLines(created)) io.out(line);
      io.out("");
      io.out(`Follow it with: evolve job show ${created.id}`);
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
    io.out(`\nMore: evolve job list --cursor ${page.nextCursor}`);
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
      io.out(`More: evolve job trials ${inv.positionals[0]} --cursor ${page.nextCursor}`);
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
    io.out(`\nMore: evolve job tasks ${inv.positionals[0]} --cursor ${page.nextCursor}`);
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
      "job stop needs --dataset <name> (to stop the whole job, use: evolve job cancel <id>)"
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
  let reported = 0;
  try {
    for (let i = 0; i < trialIds.length; i += 100) {
      const batch = trialIds.slice(i, i + 100);
      const page = await trialClient.stop(batch);
      reported += batch.length;
      result.stopped.push(...page.stopped);
      result.already_terminal.push(...page.already_terminal);
      result.not_found.push(...page.not_found);
    }
  } catch (error) {
    // STOP IS DESTRUCTIVE AND ALREADY APPLIED. Every trial in `result` is dead
    // server-side and this report is the only place its id exists, so a batch
    // that fails mid-loop — a 429 on the third request of fifty — may not take
    // the settled half down with it: the caller saw an empty stdout and one
    // rate-limit line while 200 trials had already been killed. Print what
    // landed, state the half that has no report, then let the failure
    // propagate to its own exit code.
    emitStopReport(result, dataset, trialIds.length, reported, inv, io);
    throw error;
  }
  emitStopReport(result, dataset, trialIds.length, reported, inv, io);
  return 0;
}

/**
 * The one dataset-stop report, printed whether the batch finished or died in
 * the middle of it. `unreported` counts the ids whose outcome never came back
 * — not "not stopped": a request can settle server-side and lose its answer,
 * which is exactly why the count is stated instead of guessed at. Rerunning
 * the command finishes the rest and returns the already-dead under
 * `already_terminal`.
 */
function emitStopReport(
  result: StopResponse,
  dataset: string,
  total: number,
  reported: number,
  inv: Invocation,
  io: CliIO
): void {
  const unreported = total - reported;
  if (inv.flags.json === true) {
    io.out(JSON.stringify(unreported > 0 ? { ...result, partial: true, unreported } : result));
    return;
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
  if (unreported > 0) {
    // Name the batch the failure landed on — the first 100 (or fewer) of the
    // unreported slice — so the caller knows WHERE it died, not just how much.
    // "No answer came back", never "failed": that request may well have
    // settled server-side, which is the whole reason this line exists.
    io.out(
      `PARTIAL: ${unreported} of ${total} trials have no report — ` +
        `no answer came back for trials ${reported + 1}-${Math.min(reported + 100, total)}; ` +
        `rerun the same command to finish the rest.`
    );
  }
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
    io.out(`Follow it with: evolve job show ${e.id}`);
  }
  return 0;
}

async function cmdJobRetry(inv: Invocation, io: CliIO): Promise<number> {
  // The selection grammar mirrors the API's XOR verbatim: -t/--trial names
  // exact settled trials (all-or-nothing, job may still run), --failed-only
  // narrows a terminal job to its failures, bare = the whole terminal job.
  // The contradiction is refused HERE with the same sentence the server
  // would use, so the caller never spends a round-trip on it.
  const trialIds = inv.flags.trial as string[] | undefined;
  const failedOnly = inv.flags["failed-only"] === true;
  if (trialIds !== undefined && failedOnly) {
    throw new CliUsageError(
      '"job retry" takes EITHER -t/--trial OR --failed-only, not both — explicit ids are already a selection'
    );
  }
  const req: RetryRequest = {};
  if (trialIds !== undefined) req.trial_ids = trialIds;
  if (failedOnly) req.failed_only = true;
  const job = await jobs(clientConfig(inv)).retry(
    await resolveJobId(inv, inv.positionals[0]),
    req
  );
  if (inv.flags.json === true) {
    io.out(JSON.stringify(job));
  } else {
    for (const line of jobLines(job)) io.out(line);
    io.out("");
    io.out(`Follow it with: evolve job show ${job.id}`);
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
    io.out(`Follow it with: evolve job show ${job.id}`);
  }
  return 0;
}

// `job download` UNPACKS: the SDK's jobs().download() hands over the archive
// itself (Buffer / file / stream — the caller decides what to do with the
// bytes), but the CLI's contract is the job-directory TREE on disk. The
// archive lands in a scratch directory (so the download's truncation + digest
// checks still run against a real file), extracts to <output-dir>/job-<id>/,
// and the scratch copy never survives — the tree IS the result, not a
// .tar.gz the user still has to unpack by hand.
async function cmdJobDownload(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const id = await resolveJobId(inv, inv.positionals[0]);
  const { join } = await import("node:path");
  const outputDir = (inv.flags["output-dir"] as string | undefined) ?? process.cwd();
  const root = `job-${id}`;
  const targetDir = join(outputDir, root);
  if (existsSync(targetDir) && inv.flags.overwrite !== true) {
    throw new Error(`${targetDir} already exists (pass --overwrite to replace it)`);
  }
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { extractTarGz } = await import("../hosted/tar");
  const scratch = await mkdtemp(join(tmpdir(), "evolve-job-download-"));
  try {
    const archivePath = await client.download(id, { to: scratch });
    // --overwrite replaces the tree only once the archive has fully arrived
    // and verified — a failed download never costs the previous copy.
    if (inv.flags.overwrite === true) {
      await rm(targetDir, { recursive: true, force: true });
    }
    let files: string[];
    try {
      files = await extractTarGz(archivePath, outputDir, root);
    } catch (error) {
      // A half-extracted tree that looks like a job directory and is not one
      // is worse than no tree at all.
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    if (inv.flags.json === true) {
      io.out(JSON.stringify({ path: targetDir, files: files.length }));
    } else {
      io.out(`Saved ${targetDir} (${files.length} files)`);
    }
    return 0;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
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
    // Log-shaped selectors, "trace-atif" included — the normalized ATIF
    // document rides the same {log} envelope as the raw logs. "trajectory"
    // (the reserved harness-native session file) is in the vocabulary ahead
    // of its server wave: the server refuses it not-found, and the refusal
    // surfaces as the API error it is.
    const log = await client.artifact(trialId, stream as Exclude<StreamArtifact, "trace-parsed" | "agent-home">);
    if (log === null) {
      io.out(json ? JSON.stringify({ log: null }) : `No ${stream} log was stored for this trial.`);
      return 0;
    }
    io.out(json ? JSON.stringify({ log }) : log);
    return 0;
  }

  // Save mode: everything the trial recorded lands under <output-dir>/<trial-id>/.
  // The parsed events as trace-parsed.jsonl; the normalized ATIF document as
  // trace-atif.json (its selector name — the job archive is where it wears
  // Harbor's own agent/trajectory.json path); each raw log under its own
  // name; the agent's home folder under agent-home/ with its sandbox paths
  // preserved.
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
  // Every artifact saves under its selector name — the ATIF document
  // included (trace-atif.json; Harbor's trajectory.json filename belongs to
  // the job archive's Harbor-layout tree, not to this per-trial folder).
  const atif = await client.artifact(trialId, "trace-atif");
  if (atif !== null) {
    await writeFile(join(targetDir, "trace-atif.json"), atif);
    report(`trace-atif.json (${Buffer.byteLength(atif, "utf8")} bytes)`);
  }
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

async function cmdTrialRetry(inv: Invocation, io: CliIO): Promise<number> {
  // One settled trial, run again — the result IS a job, same output shape as
  // every other job-creating verb.
  const job = await trials(clientConfig(inv)).retry(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(job));
  } else {
    for (const line of jobLines(job)) io.out(line);
    io.out("");
    io.out(`Follow it with: evolve job show ${job.id}`);
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
    io.out(`Follow it with: evolve job show ${job.id}`);
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
  // The dataset.toml identity the active version imported under, when it had
  // one — the manifest's own org/name and its declared metadata. One quiet
  // block; a version without a manifest prints nothing.
  const manifest = b.active_version?.manifest;
  if (manifest) {
    lines.push(
      `manifest: ${manifest.name}${manifest.version ? `@${manifest.version}` : ""}` +
        (manifest.task_count !== null ? ` (${manifest.task_count} tasks pinned)` : "")
    );
    if (manifest.authors.length > 0) {
      lines.push(`  authors: ${manifest.authors.map((a) => (a.email ? `${a.name} <${a.email}>` : a.name)).join(", ")}`);
    }
    if (manifest.keywords.length > 0) {
      lines.push(`  keywords: ${manifest.keywords.join(", ")}`);
    }
  }
  if (b.versions && b.versions.length > 0) {
    lines.push("");
    // The GATE column appears only when the server reports gate progress —
    // an older server without the field keeps the four-column table.
    const anyGate = b.versions.some((v) => v.gate != null);
    const rows = [["VERSION", "STATE", "TASKS", "CREATED", ...(anyGate ? ["GATE"] : [])]];
    for (const v of b.versions) {
      rows.push([
        v.version,
        v.state,
        String(v.task_count),
        v.created_at ?? "-",
        ...(anyGate ? [v.gate?.status ?? "-"] : []),
      ]);
    }
    lines.push(...table(rows));
    // A failed gate is terminal and must be unmissable: the version cannot be
    // activated or run until it is republished, so say why, right here.
    for (const v of b.versions) {
      if (v.gate?.status === "FAILED") {
        const reason = v.gate.message ?? v.gate.code ?? "no reason reported";
        lines.push(`version ${v.version} activation gate FAILED: ${reason}`);
        // The cause, task by task: the gate's own reasons, indented under the
        // verdict — nobody should need --json to learn WHY a publish died.
        for (const t of v.gate.failed_tasks) {
          const why = t.reasons.length > 0 ? t.reasons.join("; ") : (t.outcome ?? "no reason reported");
          lines.push(`  ${t.task_name}: ${why}`);
        }
      }
    }
  }
  if (b.tasks && b.tasks.items.length > 0) {
    lines.push("", `Tasks (version ${b.selected_version?.version ?? "?"}):`);
    // The GPU column appears only when some listed task declares GPUs — a
    // CPU-only dataset (the overwhelmingly common case) keeps its exact table.
    const anyGpu = b.tasks.items.some((t) => (t.gpus ?? 0) > 0);
    const rows = [["TASK", "AGENT TIMEOUT", "VERIFIER TIMEOUT", ...(anyGpu ? ["GPU"] : []), "PROVIDERS"]];
    for (const t of b.tasks.items) {
      rows.push([
        t.task_name,
        `${t.agent_timeout_sec}s`,
        `${t.verifier_timeout_sec}s`,
        ...(anyGpu ? [fmtGpu(t) ?? "-"] : []),
        fmtProviders(t.providers),
      ]);
    }
    lines.push(...table(rows));
    if (b.tasks.nextCursor) {
      lines.push(`More tasks: evolve dataset show ${b.name} --cursor ${b.tasks.nextCursor}`);
    }
    // Name each refusal once below the table; the runner refuses with the
    // same reason at run time. A GPU degrade is named the same way — it is
    // not a refusal, so the line says where the task actually runs.
    const refusals = new Map<string, string>();
    for (const t of b.tasks.items) {
      for (const provider of PROVIDER_ORDER) {
        const verdict = t.providers?.[provider];
        if (!verdict) continue;
        if (!verdict.ok) {
          if (!refusals.has(`${provider}:${verdict.reason}`)) {
            refusals.set(`${provider}:${verdict.reason}`, `${provider}: ${verdict.reason}`);
          }
        } else if (verdict.degrades_to && verdict.reason) {
          const key = `${provider}:degrade:${verdict.reason}`;
          if (!refusals.has(key)) {
            refusals.set(key, `${provider}: runs on ${verdict.degrades_to} — ${verdict.reason}`);
          }
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
        `run: evolve dataset publish --name ${item.name} --version <new-version> ` +
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
      // `created.name`, not the flag: a manifest-derived publish had no --name,
      // and the 202 echoes the name the server actually chose.
      io.out(`Follow it with: evolve dataset show ${created.name}`);
    }
    return 0;
  }

  if (json) {
    io.out(JSON.stringify({ kind: "import.created", datasetImport: created }));
  } else {
    io.out(`Publish ${created.id} (${created.name}) ${created.status} — watching…`);
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
    io.out(`Use it with: evolve run -d <dataset> -a ${created.name} -m <model>`);
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
  const topLevel = TOP_LEVEL_COMMANDS[topic[0]];
  if (topLevel) return { text: commandHelp(topic[0], topLevel), code: 0 };
  // A reserved word asked about by name answers with the reason it is
  // reserved, not with the root page — "help agents" is exactly the question
  // that deserves the honest sentence.
  const reserved = RESERVED_GROUPS[topic[0]];
  if (reserved) return { text: reserved, code: 0 };
  const group = GROUP_ALIASES[topic[0]] ?? topic[0];
  const groupSpec = GROUPS[group];
  if (!groupSpec) return { text: rootHelp(), code: 0 };
  if (topic.length === 1) return { text: groupHelp(group), code: 0 };
  const verb = VERB_ALIASES[topic[1]] ?? topic[1];
  const spec = groupSpec.commands[verb];
  if (!spec) return { text: groupHelp(group), code: 0 };
  return { text: commandHelp(`${group} ${verb}`, spec), code: 0 };
}

const HANDLERS: Record<string, (inv: Invocation, io: CliIO) => Promise<number>> = {
  // `run` and `job start` are one command reached by two names — same spec,
  // same handler — so neither can drift into a second implementation.
  run: cmdJobStart,
  "job start": cmdJobStart,
  "job list": cmdJobList,
  "job show": cmdJobShow,
  "job trials": cmdJobTrials,
  "job tasks": cmdJobTasks,
  "job compare": cmdJobCompare,
  "job cancel": cmdJobCancel,
  "job stop": cmdJobStop,
  "job resume": cmdJobResume,
  "job retry": cmdJobRetry,
  "job regrade": cmdJobRegrade,
  "job download": cmdJobDownload,
  "trial show": cmdTrialShow,
  "trial download": cmdTrialDownload,
  "trial retry": cmdTrialRetry,
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

/**
 * The body of the --json error object. An API refusal reuses the server's own
 * envelope keys verbatim (code, message, param, details, retryAfterSec,
 * request_id — present only when the server sent them); a local failure is a
 * bare {message}, honestly code-less rather than wearing an invented one.
 */
function jsonErrorBody(error: unknown): Record<string, unknown> {
  if (error instanceof EvolveApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.param !== undefined ? { param: error.param } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
      ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
      ...(error.requestId !== undefined ? { request_id: error.requestId } : {}),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  let inv: Invocation;
  try {
    inv = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(`Error: ${error.message}`);
      io.err('Run "evolve help" for usage.');
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
      io.err(`Run "evolve ${inv.command} --help" for usage.`);
      return 2;
    }
    // --json promised a machine-readable stdout, and a refusal is part of that
    // story: one {error: {...}} object carrying the server's own envelope
    // fields (or a bare message for a local failure), so a script never has to
    // scrape stderr prose. The human stderr line and the exit code do not
    // change — stderr is for eyes, stdout is for parsers.
    if (inv.flags.json === true) {
      io.out(JSON.stringify({ error: jsonErrorBody(error) }));
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

// Run only when invoked as the `evolve` bin — never on test/library import.
//
// argv[1] is the path the process was STARTED with, which after a normal
// install is node_modules/.bin/evolve — a SYMLINK. Node dereferences
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
