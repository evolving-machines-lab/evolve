#!/usr/bin/env node
/**
 * evolve — the CLI for Evolve hosted datasets & jobs.
 *
 * Noun-verb grammar over the hosted client: `evolve <noun> <verb>`, plus
 * first-class top-level commands that need no noun — `run` (which takes
 * `job start`'s flags), `analyze`, and `upload`, each spelled, helped and
 * dispatched as a command in its own right (Harbor registers all three the
 * same way, as top-level commands: their cli/main.py). Singular
 * nouns are canonical; `job`/`trial`/`analysis`/`dataset`/`skill` also answer
 * to their plurals as hidden aliases, but `agents` does NOT — that word is
 * reserved for the managed-agents CLI and refuses with the reason. `session`
 * is the managed-agents lane's first noun here — list and inspect the
 * sessions your SDK runs recorded, headless. The CLI speaks ONLY through the
 * SDK clients (datasets() / agents() / jobs() / trials() / analyses() /
 * skills() / auth() / sessions()) — no raw HTTP lives here.
 *
 * Output: human tables on a TTY, tab-separated rows when piped, --json for
 * the rendered machine shape (NDJSON for --watch event streams), -q for
 * ids-only lists. Exit codes: 0 success (watch: job COMPLETED / publish
 * COMPLETED / every analysis completed), 1 runtime/API failure (watch:
 * FAILED or CANCELLED / any analysis failed), 2 usage error.
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { LineCounter, type Tags, parse as parseYaml, parseDocument } from "yaml";
import { parse as parseToml } from "smol-toml";
import {
  ANALYSIS_ARTIFACT_STREAMS,
  ANALYSIS_STATUSES,
  EVAL_SANDBOX_PROVIDERS,
  EvolveApiError,
  ImportSettleError,
  JOB_LIST_SCOPES,
  TRIAL_ARTIFACT_STREAMS,
  TRIAL_STATUSES,
  agents,
  analyses,
  assembleAnalysisTree,
  assembleTrialTree,
  auth,
  datasets,
  jobEvolveRecord,
  jobs,
  orgs,
  passAtK,
  jobSpend,
  skills,
  type SpendStatement,
  trialAgentCost,
  trialEvolveRecord,
  trialJudgeCost,
  trialSpendNow,
  trials,
} from "../hosted/index";
import type {
  Agent,
  AgentArm,
  AgentArmInput,
  AgentInput,
  AnalysisArtifactStream,
  AnalysisStatus,
  AnalyzeConfigInput,
  AuthStatus,
  Organization,
  OrganizationDetail,
  CompareResponse,
  Dataset,
  DatasetFailedTask,
  DatasetImport,
  JobImport,
  JobImportProgress,
  DatasetImportProgress,
  DatasetPreflight,
  DatasetSelector,
  DatasetVersion,
  ImportPhaseProgress,
  EvalSandboxProvider,
  GrepJobOptions,
  HostedClientConfig,
  Job,
  JobAnalysisStats,
  JobCreate,
  JobEvent,
  JobListScope,
  JobSecretRef,
  JobSecretInline,
  JobTaskRollup,
  PublishDatasetInput,
  RetryConfigInput,
  RetryRequest,
  Rubric,
  SkillUpload,
  StopResponse,
  Task,
  TraceEvent,
  TraceOptions,
  Trial,
  TrialAnalysis,
  TrialStatus,
  UpstreamStatus,
  DatasetVersionSource,
  UsageReading,
} from "../hosted/types";
import {
  managedSecrets,
  type ManagedSecretMetadata,
  type ManagedSecretsClientConfig,
} from "../managed-secrets";
import { sessions } from "../sessions";
import type { SessionInfo, SessionsConfig } from "../sessions/types";

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

/**
 * Harbor's `--scope` (their `harbor hub job list`, cli/hub.py:816): the one
 * visibility knob every scoped list carries. `all` is deliberately not
 * offered — Harbor's `all` adds public rows, and nothing hosted is public.
 */
const SCOPE_FLAG: FlagSpec = {
  kind: "string",
  value: "<my|shared>",
  help: "Visibility scope: my (what you created, the default) | shared (your organizations' rows that teammates created)",
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
      "org/repo[@ref], an https git URL, upload:<id>, name:<skill-name> (your " +
      "moving name pointer, resolved server-side), or a local folder " +
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
    help:
      "Env for every verifier run (repeatable); the server honors exactly " +
      "REWARDKIT_JUDGE and REWARDKIT_MODEL (rewardkit's judge override) and refuses any other key",
  },
  secret: {
    kind: "repeat",
    value: "NAME[@LABEL][=ENVNAME]",
    help:
      "Attach one of your stored env secrets to every agent run (repeatable). " +
      "NAME is the stored secret's name; @LABEL picks a labeled row (omitted = " +
      "the 'default' row, or the only row — several labels with no 'default' is " +
      "refused as ambiguous); =ENVNAME renames the env var inside the sandbox. " +
      "References only — the value never rides the command line or the wire",
  },
  "secret-inline": {
    kind: "repeat",
    value: "NAME[@LABEL]:DELIVERY=VALUE",
    help:
      "Save VALUE into your vault as an env secret and attach it to this job " +
      "in one step (repeatable). DELIVERY is 'brokered' or 'direct' and sits " +
      "before '=' so everything after the first '=' is the value, passed " +
      "through byte-for-byte ('=', ':' and '@' need no escaping). @LABEL " +
      "defaults to 'default'. An existing (NAME, LABEL) secret splits on " +
      "proof: restating it exactly (same value, same delivery) attaches it, " +
      "so re-running the same command converges; a DIFFERENT value or " +
      "delivery is refused as secret_exists — attach it with --secret or pick " +
      "a label. The job stores only the reference, never the value",
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
  analyze: {
    kind: "boolean",
    help:
      "Analyze each trial's trace server-side as it settles (Harbor's analyze, embedded; " +
      "CANCELLED trials are skipped). Bare = the defaults: claude-haiku-4-5, Harbor's default rubric",
  },
  "analyze-model": {
    kind: "string",
    value: "<name>",
    help: "Model the analyzer agent runs (implies --analyze; must be on the claude roster, GET /api/meta)",
  },
  "analyze-rubric": {
    kind: "string",
    value: "<path>",
    help: "Rubric file for the analyzer (TOML/YAML/JSON, Harbor's {criteria} shape; implies --analyze)",
  },
  "analyze-provider": {
    kind: "string",
    value: "<provider>",
    help:
      "Sandbox provider the analyzer runs on (implies --analyze; the job lineup, GET /api/meta; " +
      "default: the platform's analysis default)",
  },
  "analyze-effort": {
    kind: "string",
    value: "<value>",
    help:
      "Reasoning effort the analyzer runs at (implies --analyze; values: GET /api/meta analyze; " +
      "default: the per-model default — high on deepseek-v4-flash-vision, low on glm-5.3-flash)",
  },
  "timeout-multiplier": {
    kind: "number",
    value: "<x>",
    help:
      "Multiplier for task timeouts (default 1.0; > 0, server ceiling on GET /api/meta). " +
      "Multiplies each task's DECLARED timeouts for this job only — the task is never rewritten",
  },
  "agent-timeout-multiplier": {
    kind: "number",
    value: "<x>",
    help: "Multiplier for agent execution timeout (overrides --timeout-multiplier)",
  },
  "verifier-timeout-multiplier": {
    kind: "number",
    value: "<x>",
    help: "Multiplier for verifier timeout (overrides --timeout-multiplier)",
  },
  "agent-setup-timeout-multiplier": {
    kind: "number",
    value: "<x>",
    help: "Multiplier for agent setup timeout (overrides --timeout-multiplier)",
  },
  "environment-build-timeout-multiplier": {
    kind: "number",
    value: "<x>",
    help: "Multiplier for environment build timeout (overrides --timeout-multiplier)",
  },
  env: { kind: "string", short: "e", value: "<provider>", help: "Sandbox provider: e2b | daytona | modal (default daytona)" },
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
        summary: "List jobs (newest first): yours, or --scope shared for your teams'",
        flags: {
          ...LIST_FLAGS,
          search: { kind: "string", value: "<text>", help: "Free-text filter over job name and dataset names" },
          scope: SCOPE_FLAG,
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
      delete: {
        summary: "Permanently delete a job you created — trials, traces, analyses and stored files",
        flags: {
          yes: { kind: "boolean", short: "y", help: "Delete without a confirmation prompt" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve job delete cme12ab34 --yes",
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
      imports: {
        summary: "List your job imports (uploads) newest first — how an import id is found again",
        flags: {
          ...LIST_FLAGS,
          status: { kind: "string", value: "<QUEUED|RUNNING|COMPLETED|FAILED>", help: "Filter by import status" },
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve job imports --status RUNNING",
      },
      import: {
        summary: "Show one job import (an upload's record); --watch follows it to the job or its typed failure",
        flags: {
          watch: { kind: "boolean", help: "Poll until the import settles: COMPLETED (the job is printed) or FAILED" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<import-id>",
        example: "evolve job import 4f1c… --watch",
      },
      download: {
        summary:
          "Download the job's results, unpacked as the standard job-directory tree (plus evolve.json records)",
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
      grep: {
        summary: "Search every trial's parsed trace in one server-side pass",
        flags: {
          type: { kind: "string", value: "<event-type>", help: "Only search events of exactly this type" },
          limit: {
            kind: "number",
            short: "l",
            value: "<n>",
            help: "Per-trial match groups per page (default 50, max 200)",
          },
          cursor: { kind: "string", value: "<c>", help: "Resume after this trial id (the previous page's nextCursor)" },
        },
        minPositionals: 2,
        maxPositionals: 2,
        positionalUsage: "<id> <pattern>",
        example: "evolve job grep cme12ab34 'permission denied'",
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
      trace: {
        summary: "Print a trial's parsed trace, filtered server-side",
        flags: {
          type: { kind: "string", value: "<event-type>", help: "Only events of exactly this type" },
          grep: {
            kind: "string",
            value: "<pattern>",
            help:
              "Only events matching this case-insensitive regex over type + content " +
              "(a plain string is a plain substring — grep's own grammar)",
          },
          tail: { kind: "number", value: "<n>", help: "Only the last N matching events" },
          cursor: { kind: "string", value: "<seq>", help: "Resume after this seq" },
          limit: { kind: "number", short: "l", value: "<n>", help: "Events per page fetch (default 200, max 1000)" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<trial-id>",
        example: "evolve trial trace cmt90ef12 --grep 'permission denied' --tail 50",
      },
      download: {
        summary: "Save a trial as Harbor's trial tree (plus evolve.json), or stream one artifact",
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
  // An analysis run is the ANALYZER's own agent run — its id comes from the
  // `analysis` row of `trial show` (or `trial show --json` / the traces
  // page). These verbs read the analyzer's side of the record: the verdict
  // document, the analyzer's own transcript, and its stored artifacts —
  // never the analyzed trial's, which keep their own verbs above.
  analysis: {
    summary: "List, inspect, and download trace-analysis runs",
    commands: {
      list: {
        summary: "List analysis runs (newest first) with the trial, job, and task each judged",
        flags: {
          ...LIST_FLAGS,
          scope: SCOPE_FLAG,
          job: { kind: "string", value: "<job-id>", help: "Only analyses of this job's trials (id or an unambiguous prefix)" },
          status: {
            kind: "string",
            value: "<s1,s2,...>",
            help: `Filter by analysis status (${ANALYSIS_STATUSES.join(", ")})`,
          },
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve analysis list --job cme12ab34 --status failed",
      },
      show: {
        summary: "Show one analysis run in full (the verdict document)",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<analysis-id>",
        example: "evolve analysis show cma56ef12",
      },
      trace: {
        summary: "Print the analyzer's own parsed transcript",
        flags: {
          since: {
            kind: "number",
            value: "<n>",
            help:
              "Skip the first N events — to resume, pass the count you already hold " +
              "(seqs are dense from 0, so N is also the next seq)",
          },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<analysis-id>",
        example: "evolve analysis trace cma56ef12 --since 200",
      },
      download: {
        summary:
          "Save an analysis run whole (verdict + analyzer artifacts + evolve.json), or stream one artifact",
        flags: {
          "output-dir": {
            kind: "string",
            short: "o",
            value: "<dir>",
            help: "Directory to save under (default: analyses/); files land in <dir>/<analysis-id>/",
          },
          overwrite: { kind: "boolean", help: "Replace an existing <dir>/<analysis-id>/" },
          stream: {
            kind: "string",
            value: "<artifact>",
            help:
              "Print ONE artifact to stdout instead of saving: analysis (the verdict " +
              "document) | trace-parsed | trace-stdout | trace-stderr | agent-home",
          },
          since: {
            kind: "number",
            value: "<n>",
            help: "With --stream trace-parsed: skip the first N events",
          },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<analysis-id>",
        example: "evolve analysis download cma56ef12 --stream trace-stdout",
      },
    },
  },
  // Managed-agent SESSIONS — the other hosted lane, read-only here: the runs
  // the SDK's `.run()` recorded to the dashboard, listed and inspected
  // headless through sessions(). A session has one owner and no
  // organization, so there is no --scope: `my` is the only visibility.
  session: {
    summary: "List and inspect managed-agent sessions",
    commands: {
      list: {
        summary: "List your sessions (newest first)",
        flags: {
          ...LIST_FLAGS,
          state: { kind: "string", value: "<live|ended>", help: "Only live or only ended sessions" },
          agent: { kind: "string", value: "<name>", help: "Only sessions of this agent harness (exact match)" },
          "tag-prefix": { kind: "string", value: "<prefix>", help: "Only sessions whose tag starts with this prefix" },
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve session list --state ended --tag-prefix qa- -q",
      },
      show: {
        summary: "Show one session in full",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<session-id>",
        example: "evolve session show 5f2c1a0e-7b3d-4c21-9e10-2f8a6c4d1b7e",
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
      check: {
        summary: "Pre-flight a local corpus (dry run — nothing uploaded, nothing written)",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<dir>",
        example: "evolve dataset check ./corpus",
      },
      publish: {
        summary: "Publish a dataset version from a git source, a local directory, or a fetchable source (public tarball url / Harbor hub package)",
        flags: {
          git: { kind: "string", value: "<url>", help: "Git repository URL (with --ref)" },
          ref: { kind: "string", value: "<ref>", help: "Pinned git ref: a full 40-hex commit sha, or a tag (resolved to its commit at publish and verified at import). Branch names are refused — unpinned_git_ref (with --git)" },
          path: { kind: "string", value: "<subfolder>", help: "Repository subfolder holding the corpus (with --git; sparse checkout — only that folder is imported)" },
          dir: { kind: "string", value: "<path>", help: "Local corpus directory (tarred + uploaded; pre-flighted first — see --skip-preflight)" },
          from: { kind: "string", value: "<url|hub:org/name[@ref]>", help: "Fetchable source the SERVER pulls itself (no local bytes): a public https tarball url, or hub:org/name[@ref] — a public Harbor hub package (ref: latest tag by default, a revision number, or sha256:<digest>; resolved and digest-pinned when the publish is accepted)" },
          name: { kind: "string", value: "<dataset>", help: "Catalog dataset name to create or extend (optional with --dir when the corpus carries a dataset.toml manifest, and with --from hub:… which defaults to the package's short name; required with --git and --from <url>)" },
          version: { kind: "string", value: "<v>", help: "Version label for the published version (optional with --dir when dataset.toml declares one, and with --from hub:… which defaults to the resolved revision; required with --git and --from <url>)" },
          watch: { kind: "boolean", help: "Poll until the publish settles: the version READY (built and active) or FAILED" },
          "skip-preflight": { kind: "boolean", help: "Upload without the pre-flight check (a refused task then lands FAILED at import instead of being caught here)" },
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve dataset publish --from hub:cookbook/hello-world --watch",
      },
      watch: {
        summary:
          "Re-attach to a publish and follow it to READY/FAILED — the same follow `dataset publish --watch` renders (everything from the 202 on); works after the CLI exited, or from another machine",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<name | import-id>",
        example: "evolve dataset watch deep-swe",
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
  skill: {
    summary: "Upload and manage platform-stored skills",
    commands: {
      list: {
        summary: "List your uploaded skills (newest first)",
        flags: { ...LIST_FLAGS },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve skill list",
      },
      upload: {
        summary: "Upload a skill folder (its name becomes your moving name pointer)",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<dir>",
        example: "evolve skill upload ./my-skill",
      },
      show: {
        summary: "Show one uploaded skill (metadata + SKILL.md)",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id | name:<skill-name>>",
        example: "evolve skill show name:my-skill",
      },
      delete: {
        summary:
          "Delete an uploaded skill record (past jobs keep their locks); refused (skill_in_use, 409) while a running job references it",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<id>",
        example: "evolve skill delete 6f6f1f36-1c60-4f8e-9e2b-2a54cbb0f2aa",
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
    summary: "Identity, API keys, and your organizations",
    commands: {
      status: {
        summary: "Who am I: the caller and the API key in use",
        flags: {},
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve auth status",
      },
      // Harbor's `harbor auth org list` (their cli/auth.py `org_app`): the
      // organizations the caller belongs to, with Harbor's own flag set —
      // --search, --columns, -q, --no-trunc, --no-headers, --json (cli/
      // auth.py:140-170). Two-word verbs are the thin shell's answer to
      // Harbor's nested sub-app.
      "org list": {
        summary: "List the organizations you belong to",
        flags: {
          search: { kind: "string", value: "<text>", help: "Free-text filter over slug, display name and role" },
          columns: LIST_FLAGS.columns,
          quiet: { kind: "boolean", short: "q", help: "Print only slugs, one per line (for piping)" },
          "no-trunc": LIST_FLAGS["no-trunc"],
          "no-headers": LIST_FLAGS["no-headers"],
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve auth org list",
      },
      // The recorded hosted extension: an organization's quota and live
      // usage are hosted facts Harbor's closed server does not publish.
      "org show": {
        summary: "Show one organization: your role, members, its quota and live usage",
        flags: {},
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<slug>",
        example: "evolve auth org show acme",
      },
    },
  },
  secrets: {
    summary: "Store and manage env secrets (values are write-only; reads return metadata)",
    commands: {
      set: {
        summary:
          "Store an env secret, or re-shape delivery/scoping by restating the same value; " +
          "a DIFFERENT value under an existing name+label is refused (secret_exists, 409) — " +
          "delete first or use another label, never a silent overwrite",
        flags: {
          value: {
            kind: "string",
            value: "<value>",
            help: "The secret value; omit to pipe it on stdin (keeps it out of shell history)",
          },
          label: {
            kind: "string",
            value: "<label>",
            help: "Labeled-row identity — several values of one name live side by side (default: 'default')",
          },
          delivery: {
            kind: "string",
            value: "<mode>",
            help:
              "Required: 'brokered' (value never enters a sandbox; needs the --allowed-* scoping) " +
              "or 'direct' (raw value in the sandbox env; scoping refused)",
          },
          "allowed-host": {
            kind: "repeat",
            value: "<host>",
            help: "Brokered scoping: hostname or wildcard like *.example.com (repeatable)",
          },
          "allowed-path-prefix": {
            kind: "repeat",
            value: "</prefix>",
            help: "Brokered scoping: allowed URL path prefix (repeatable)",
          },
          "allowed-method": {
            kind: "repeat",
            value: "<METHOD>",
            help: "Brokered scoping: allowed HTTP method (repeatable)",
          },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<NAME>",
        example:
          'printf %s "$GITHUB_TOKEN" | evolve secrets set GITHUB_TOKEN --delivery brokered ' +
          "--allowed-host api.github.com --allowed-path-prefix / --allowed-method GET",
      },
      list: {
        summary: "List your env secrets (metadata only — values never leave the server)",
        flags: {
          columns: {
            kind: "string",
            value: "<keys|all|help>",
            help: "Choose and order columns (comma-separated keys; 'help' lists them)",
          },
          quiet: { kind: "boolean", short: "q", help: "Print only name[:label], one per line" },
          "no-trunc": { kind: "boolean", help: "Full cell content instead of one-line truncation" },
          "no-headers": { kind: "boolean", help: "Omit the header row in piped (TSV) output" },
        },
        minPositionals: 0,
        maxPositionals: 0,
        example: "evolve secrets list",
      },
      delete: {
        summary:
          "Delete an env secret by name (+ --label when several labeled rows share it); " +
          "revokes every runtime grant riding the row",
        flags: {
          label: { kind: "string", value: "<label>", help: "The labeled row to delete" },
        },
        minPositionals: 1,
        maxPositionals: 1,
        positionalUsage: "<NAME>",
        example: "evolve secrets delete GITHUB_TOKEN --label staging",
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
  // Harbor registers `analyze` at the top level too (their cli/main.py binds
  // analyze_command as its own command); theirs takes a local job directory,
  // ours the hosted job id — the platform's one recorded deviation, analysis
  // running server-side. -e/--env is Harbor's own analyze flag (their
  // cli/analyze.py: `"-e", "--env"`), re-aimed for that deviation: theirs
  // picks a local environment TYPE (docker, daytona); ours picks which hosted
  // provider's sandbox the analyzer boots — there is no local backend
  // server-side.
  analyze: {
    summary:
      "Analyze a terminal job's trial traces against a rubric (server-side; add --watch to follow the wave)",
    flags: {
      model: {
        kind: "string",
        short: "m",
        value: "<name>",
        help:
          "Model the analyzer agent runs (default: deepseek-v4-flash-vision; glm-5.3-flash and " +
          "haiku as alternatives, glm-5.3 to escalate; must be on the claude roster, GET /api/meta)",
      },
      // The one option beyond Harbor's analyze trio, recorded as the hosted
      // extension it is: `run`'s own --effort (the platform's reasoning_effort
      // vocabulary, GET /api/meta) applied to the analyzer, which IS the claude
      // harness. Same flag name as `run`; the server refuses an unknown value
      // exactly as it refuses an arm's.
      effort: {
        kind: "string",
        value: "<value>",
        help:
          "Reasoning effort the analyzer runs at (values: GET /api/meta analyze; default: the " +
          "per-model default — high on deepseek-v4-flash-vision, low on glm-5.3-flash)",
      },
      rubric: {
        kind: "string",
        short: "r",
        value: "<path>",
        help:
          "Rubric file (TOML/YAML/JSON, Harbor's {criteria: [{name, description, guidance}]} " +
          "shape; default: Harbor's default rubric — reward_hacking, task_specification)",
      },
      env: {
        kind: "string",
        short: "e",
        value: "<provider>",
        help:
          "Sandbox provider the analyzer runs on (Harbor's -e/--env; the job lineup, " +
          "GET /api/meta; default: the platform's analysis default)",
      },
      watch: {
        kind: "boolean",
        help:
          "Poll until every analysis settles (2 s between reads, backing off to 30 s while nothing changes)",
      },
      quiet: {
        kind: "boolean",
        short: "q",
        help: "With --watch: suppress the progress lines, print the final block only",
      },
    },
    minPositionals: 1,
    maxPositionals: 1,
    positionalUsage: "<job-id>",
    example: "evolve analyze cme12ab34 -r rubric.toml --watch",
  },
  // Harbor's `upload` is a top-level command too (their cli/upload.py bound in
  // cli/main.py); ours is a deliberate subset — no --public/--share-org/
  // --share-user/--org (no sharing surface yet; the flags adopt Harbor's exact
  // names when Teams lands) and no --concurrency (their protocol uploads
  // per-trial in parallel; ours is ONE archive POST, so the flag would have
  // nothing real to do).
  upload: {
    summary:
      "Upload a Harbor job directory (or its .tar.gz, or a public url of one) as a terminal job — Harbor's upload, in reverse; follows the import to the job",
    flags: {
      dataset: {
        kind: "string",
        short: "d",
        value: "<name[@version]>",
        help: "Link the uploaded trials to a published dataset version by task name",
      },
      from: {
        kind: "string",
        value: "<url>",
        help: "A public https url of the job archive (.tar.gz) the SERVER fetches itself — no local bytes (instead of <job_dir>)",
      },
      "no-wait": {
        kind: "boolean",
        help: "Return after the 202 with the import id instead of following the ingest to the job (re-attach with: evolve job import <id> --watch)",
      },
    },
    minPositionals: 0,
    maxPositionals: 1,
    positionalUsage: "<job_dir>",
    example: "evolve upload ./job-2026-08-27__12-00-00 -d deep-swe@1.1",
  },
};

/**
 * Hidden plural aliases — the singular noun is canonical. `secrets` is the
 * one deliberate exception (plural canonical, singular aliased): the noun
 * names the surface — the dashboard's Secrets page and the managed-secrets
 * API — not one record.
 */
const GROUP_ALIASES: Record<string, string> = {
  jobs: "job",
  trials: "trial",
  analyses: "analysis",
  sessions: "session",
  datasets: "dataset",
  skills: "skill",
  secret: "secrets",
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
  const resolved = resolveVerb(groupSpec, argv.slice(1));
  if (!resolved) {
    // The first word of a two-word verb on its own (`auth org`, `auth org
    // --help`) asks for the group's help, as Harbor's nested sub-app prints
    // its own when called bare (Typer's no_args_is_help, cli/auth.py:14-16)
    // — never a usage error.
    const next = argv[2];
    if (isVerbPrefix(groupSpec, rawVerb) && (next === undefined || next === "--help" || next === "-h")) {
      return { command: "help", positionals: [group, rawVerb], flags: {} };
    }
    throw new CliUsageError(
      `Unknown command "${group} ${rawVerb}" (supported: ${Object.keys(groupSpec.commands).join(", ")})`
    );
  }
  return parseCommandArgs(`${group} ${resolved.verb}`, resolved.spec, argv.slice(1 + resolved.words));
}

/**
 * A group's verb is one word (`list`) or two (`org list` — Harbor's nested
 * `auth org` sub-app, flattened into the thin shell's noun-verb grammar). The
 * two-word form is tried first so a one-word verb can never shadow it, and
 * `ls` aliases the last word either way.
 */
function resolveVerb(
  groupSpec: GroupSpec,
  words: string[]
): { verb: string; spec: CommandSpec; words: number } | null {
  const first = words[0];
  const second = words[1];
  if (first !== undefined && second !== undefined && !second.startsWith("-")) {
    const verb = `${first} ${VERB_ALIASES[second] ?? second}`;
    const spec = groupSpec.commands[verb];
    if (spec) return { verb, spec, words: 2 };
  }
  if (first === undefined) return null;
  const verb = VERB_ALIASES[first] ?? first;
  const spec = groupSpec.commands[verb];
  return spec ? { verb, spec, words: 1 } : null;
}

/** Whether a word begins one of the group's two-word verbs (`org` in `auth org list`). */
function isVerbPrefix(groupSpec: GroupSpec, word: string): boolean {
  return Object.keys(groupSpec.commands).some((verb) => verb.startsWith(`${word} `));
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
 * The published package carries the spec two directories above dist/cli/.
 * The contract's home is the private server repo, so a source checkout
 * without a staged copy points EVOLVE_OPENAPI_SPEC_PATH at it; the repo-root
 * candidate remains for legacy checkouts that still carry one.
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
  const candidates = SPEC_RELATIVE_CANDIDATES.map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url))
  );
  const envPath = process.env.EVOLVE_OPENAPI_SPEC_PATH;
  if (envPath) candidates.unshift(envPath);
  for (const specPath of candidates) {
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
    `spec/openapi.yaml not found (tried: ${tried.join(", ")}) — the package ships it; reinstall the SDK, or point EVOLVE_OPENAPI_SPEC_PATH at a contract checkout`
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

/**
 * Read and parse a local rubric file for `analyze -r` / `run --analyze-rubric`
 * into the spec's Rubric shape — Harbor's own loader law (their
 * cli/quality_checker/models.py load_rubric): TOML, YAML, or JSON by
 * extension, anything else refused by name. Ruled here: the shape, unknown
 * fields refused naming them, and the two spec MINIMUMS — a non-empty
 * criteria list, and each criterion's three fields present as non-empty
 * strings. The server owns the rest of the bounds (criteria count, field
 * lengths, the snake_case name grammar) and refuses them typed
 * (`invalid_rubric`).
 */
export function loadRubricFile(
  path: string,
  read: (path: string) => string = (p) => readFileSync(p, "utf-8")
): Rubric {
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    throw new CliUsageError(`--rubric: cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  if (path.endsWith(".toml")) {
    try {
      parsed = parseToml(text);
    } catch (error) {
      throw new CliUsageError(`--rubric: ${path} is not valid TOML: ${(error as Error).message}`);
    }
  } else if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    parsed = parseYamlConfig(text, path);
  } else if (path.endsWith(".json")) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CliUsageError(`--rubric: ${path} is not valid JSON: ${(error as Error).message}`);
    }
  } else {
    throw new CliUsageError(
      `--rubric: unsupported rubric format "${path}" — use a .toml, .yaml, .yml, or .json file (Harbor's own set)`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CliUsageError(`--rubric: ${path} must contain a {criteria: [...]} object`);
  }
  const unknownKeys = Object.keys(parsed).filter((key) => key !== "criteria");
  if (unknownKeys.length > 0) {
    throw new CliUsageError(
      `--rubric: unknown key${unknownKeys.length === 1 ? "" : "s"} ${unknownKeys
        .map((key) => `"${key}"`)
        .join(", ")} in ${path} — a rubric is {criteria: [{name, description, guidance}]}`
    );
  }
  const criteria = parsed.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new CliUsageError(
      `--rubric: ${path} needs a non-empty criteria list ([[criteria]] entries in TOML)`
    );
  }
  return {
    criteria: criteria.map((entry, index) => {
      const where = `criteria[${index}] in ${path}`;
      if (!isPlainObject(entry)) {
        throw new CliUsageError(`--rubric: ${where} must be a {name, description, guidance} object`);
      }
      const extras = Object.keys(entry).filter(
        (key) => key !== "name" && key !== "description" && key !== "guidance"
      );
      if (extras.length > 0) {
        throw new CliUsageError(
          `--rubric: unknown key${extras.length === 1 ? "" : "s"} ${extras
            .map((key) => `"${key}"`)
            .join(", ")} in ${where} — a criterion is {name, description, guidance}`
        );
      }
      for (const field of ["name", "description", "guidance"] as const) {
        if (typeof entry[field] !== "string" || entry[field].length === 0) {
          throw new CliUsageError(`--rubric: ${where} needs a non-empty string "${field}"`);
        }
      }
      return {
        name: entry.name as string,
        description: entry.description as string,
        guidance: entry.guidance as string,
      };
    }),
  };
}

/**
 * Parse repeatable --secret NAME[@LABEL][=ENVNAME] references into the wire's
 * secrets[] objects. The grammar splits on the FIRST '=' (everything after it
 * is the in-sandbox env name) and then the FIRST '@' (everything after it is
 * the label), so neither delimiter is legal inside the parts — which matches
 * the server's vocabularies (env-var-shaped names, [A-Za-z0-9._-] labels).
 * Only the shape is ruled here; name/label semantics (reserved names, the
 * 'default' fallback, the ambiguity refusal) are the server's.
 */
export function parseSecretRefs(values: string[]): JobSecretRef[] {
  return values.map((value) => {
    const eq = value.indexOf("=");
    const ref = eq === -1 ? value : value.slice(0, eq);
    const envName = eq === -1 ? undefined : value.slice(eq + 1);
    if (eq !== -1 && !envName) {
      throw new CliUsageError(`Invalid --secret "${value}": expected NAME[@LABEL][=ENVNAME]`);
    }
    const at = ref.indexOf("@");
    const name = at === -1 ? ref : ref.slice(0, at);
    const label = at === -1 ? undefined : ref.slice(at + 1);
    if (!name || (at !== -1 && !label)) {
      throw new CliUsageError(`Invalid --secret "${value}": expected NAME[@LABEL][=ENVNAME]`);
    }
    return {
      name,
      ...(label !== undefined ? { label } : {}),
      ...(envName !== undefined ? { as: envName } : {}),
    };
  });
}

/**
 * Parse repeatable --secret-inline NAME[@LABEL]:DELIVERY=VALUE entries into
 * the wire's inline secrets[] objects. DELIVERY sits BEFORE the '=' so the
 * value — everything after the FIRST '=' — is passed through byte-for-byte
 * and may contain '=', ':' and '@' unescaped. The head splits on its FIRST
 * '@' (label) and LAST ':' (delivery), matching the label grammar
 * ([A-Za-z0-9._-], no ':' possible). Only the shape is ruled here;
 * name/label semantics and the collision refusal are the server's.
 */
export function parseInlineSecrets(values: string[]): JobSecretInline[] {
  const expected = "NAME[@LABEL]:brokered|direct=VALUE";
  return values.map((value) => {
    const eq = value.indexOf("=");
    if (eq === -1) {
      throw new CliUsageError(`Invalid --secret-inline "${value}": expected ${expected}`);
    }
    const head = value.slice(0, eq);
    const secretValue = value.slice(eq + 1);
    if (!secretValue) {
      throw new CliUsageError(`Invalid --secret-inline "${value}": the value must not be empty`);
    }
    const colon = head.lastIndexOf(":");
    if (colon === -1) {
      throw new CliUsageError(
        `Invalid --secret-inline "${head}=...": a delivery mode is required — ${expected}`,
      );
    }
    const ref = head.slice(0, colon);
    const delivery = head.slice(colon + 1);
    if (delivery !== "brokered" && delivery !== "direct") {
      throw new CliUsageError(
        `Invalid --secret-inline delivery "${delivery}": expected brokered or direct`,
      );
    }
    const at = ref.indexOf("@");
    const name = at === -1 ? ref : ref.slice(0, at);
    const label = at === -1 ? undefined : ref.slice(at + 1);
    if (!name || (at !== -1 && !label)) {
      throw new CliUsageError(`Invalid --secret-inline "${head}=...": expected ${expected}`);
    }
    return {
      name,
      value: secretValue,
      delivery,
      ...(label !== undefined ? { label } : {}),
    };
  });
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
  // --secret/--secret-inline replace the file's list outright, like -d does:
  // the flags together are one complete attachment statement (references
  // first, then inline entries), never a merge whose halves could collide on
  // an env name only the server would notice.
  const secrets: Array<JobSecretRef | JobSecretInline> | undefined =
    f.secret !== undefined || f["secret-inline"] !== undefined
      ? [
          ...(f.secret !== undefined ? parseSecretRefs(f.secret as string[]) : []),
          ...(f["secret-inline"] !== undefined
            ? parseInlineSecrets(f["secret-inline"] as string[])
            : []),
        ]
      : base.secrets;

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

  // Embedded analysis: PRESENCE of the object is the switch (the spec's
  // AnalyzeConfigInput law), so the file's `analyze` or ANY of the five
  // flags arms it — --analyze bare means "all defaults" — and the sub-flags
  // override the file's fields one by one, the same merge rule as retry.
  const analyzeArmed =
    f.analyze === true ||
    f["analyze-model"] !== undefined ||
    f["analyze-rubric"] !== undefined ||
    f["analyze-provider"] !== undefined ||
    f["analyze-effort"] !== undefined ||
    base.analyze !== undefined;
  const analyze: AnalyzeConfigInput = { ...(base.analyze ?? {}) };
  if (f["analyze-model"] !== undefined) analyze.model_name = String(f["analyze-model"]);
  if (f["analyze-rubric"] !== undefined) {
    analyze.rubric = loadRubricFile(String(f["analyze-rubric"]), read);
  }
  // Unlike -e/--env, the value rides verbatim: the analyzer's provider lineup
  // is the server's roster (GET /api/meta), and its refusal (`invalid_input`,
  // lineup in the message) is the one copy of that list.
  if (f["analyze-provider"] !== undefined) {
    analyze.sandbox_provider = String(f["analyze-provider"]) as EvalSandboxProvider;
  }
  // Same verbatim ride as --effort on the arms: the server's effort
  // vocabulary (GET /api/meta) is the one copy, and its refusal names it.
  if (f["analyze-effort"] !== undefined) analyze.reasoning_effort = String(f["analyze-effort"]);

  // Timeout multipliers: Harbor's five flags verbatim (their
  // cli/jobs.py:378-424), flat on the body exactly as their JobConfig
  // carries them. The config file's fields are the base and each flag
  // overrides ITS field; omitted entirely, the server applies 1.0 to every
  // phase. The server owns the ceiling refusal — a client-side bound would
  // just be a second copy of the published limit that could drift.
  const timeoutMultipliers: Partial<JobCreate> = {};
  for (const [flag, field] of [
    ["timeout-multiplier", "timeout_multiplier"],
    ["agent-timeout-multiplier", "agent_timeout_multiplier"],
    ["verifier-timeout-multiplier", "verifier_timeout_multiplier"],
    ["agent-setup-timeout-multiplier", "agent_setup_timeout_multiplier"],
    ["environment-build-timeout-multiplier", "environment_build_timeout_multiplier"],
  ] as const) {
    const value = f[flag] !== undefined ? (f[flag] as number) : base[field];
    if (value !== undefined) (timeoutMultipliers as Record<string, number>)[field] = value;
  }

  return {
    ...(jobName !== undefined ? { job_name: jobName } : {}),
    datasets: selectors,
    agents: arms,
    ...(nAttempts !== undefined ? { n_attempts: nAttempts } : {}),
    ...(nConcurrent !== undefined ? { n_concurrent_trials: nConcurrent } : {}),
    ...(maxSpend !== undefined ? { max_trial_spend_usd: maxSpend } : {}),
    ...(provider !== undefined ? { sandbox_provider: provider } : {}),
    ...(Object.keys(retry).length > 0 ? { retry } : {}),
    ...(analyzeArmed ? { analyze } : {}),
    ...timeoutMultipliers,
    ...(agentEnv !== undefined ? { agent_env: agentEnv } : {}),
    ...(verifierEnv !== undefined ? { verifier_env: verifierEnv } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
  };
}

/**
 * Build the datasets().publish() input from a parsed `dataset publish`
 * invocation. `--name`/`--version` are optional with `--dir` (a corpus
 * carrying a dataset.toml manifest supplies them server-side — Harbor's
 * dataset layout — and the SDK refuses before uploading when neither the
 * flags nor a manifest exist) and with `--from hub:…` (the server defaults
 * them from the resolved package). A git or `--from <url>` source requires
 * both — its corpus is only fetched after the server accepts the publish.
 *
 * `--from` takes the FETCHABLE sources, one flag for both spellings: a plain
 * https URL is a public tarball (`archive_url` on the wire), and the `hub:`
 * prefix marks a Harbor hub package whose reference part is exactly Harbor's
 * own grammar (`org/name[@ref]` — their CLI takes the same reference as a
 * bare positional; the prefix exists only because this one flag also accepts
 * URLs).
 */
export function buildPublishInput(inv: Invocation): PublishDatasetInput {
  const f = inv.flags;
  const hasDir = typeof f.dir === "string";
  const hasGit =
    typeof f.git === "string" || typeof f.ref === "string" || typeof f.path === "string";
  const hasFrom = typeof f.from === "string";
  const offered = [hasDir, hasGit, hasFrom].filter(Boolean).length;
  if (offered > 1) {
    throw new CliUsageError(
      '"dataset publish" takes EXACTLY ONE source: --dir, --git/--ref/--path, or --from'
    );
  }
  if (hasFrom) {
    const from = (f.from as string).trim();
    if (from.startsWith("hub:")) {
      const hubRef = from.slice("hub:".length);
      if (hubRef === "") {
        throw new CliUsageError(
          '"--from hub:" needs a package reference — hub:org/name[@ref], e.g. hub:cookbook/hello-world'
        );
      }
      return {
        source: { hub_package: hubRef },
        ...(typeof f.name === "string" ? { name: f.name } : {}),
        ...(typeof f.version === "string" ? { version: f.version } : {}),
      };
    }
    if (!from.startsWith("https://")) {
      throw new CliUsageError(
        `"--from" takes a public https tarball url or hub:org/name[@ref] (got "${from}")`
      );
    }
    for (const req of ["name", "version"] as const) {
      if (typeof f[req] !== "string") {
        throw new CliUsageError(
          `"dataset publish" requires --${req} with --from <url> — the server fetches the tarball ` +
            "only after the publish is accepted, so nothing can supply it later"
        );
      }
    }
    return {
      source: { archive_url: from },
      name: f.name as string,
      version: f.version as string,
    };
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
  /**
   * Ask the human a yes/no question — the destructive-verb prompt. Present
   * only when stdin can actually answer (an interactive terminal); absent,
   * a destructive verb must be told --yes, exactly Harbor's non-TTY
   * posture. The question rides stderr so stdout stays machine-clean.
   */
  confirm?(question: string): Promise<boolean>;
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  tty: process.stdout.isTTY === true && process.env.TERM !== "dumb",
  ...(process.stdin.isTTY === true
    ? {
        confirm: async (question: string): Promise<boolean> => {
          const { createInterface } = await import("node:readline/promises");
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
            return answer === "y" || answer === "yes";
          } finally {
            rl.close();
          }
        },
      }
    : {}),
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

/**
 * A MONEY CELL IS ONE CELL WIDE, so it has to carry the lane inside it.
 *
 * `cost_usd` is only half of the API's statement — the lane beside it
 * (`spend_source`, `judge_spend_source`, or a job's count of trials its total
 * cannot account for) is what says how final the figure is. Printing the number
 * bare turned "nobody ever measured this" into "spent $0.00": measured in
 * production 2026-08-20, where an `assumed_cap` trial carried a literal 0 and
 * the platform read $0.057 for it minutes later. That lane is the ORDINARY
 * state of a freshly settled trial, so every one of these cells was wrong at
 * exactly the moment a user is most likely to look at it.
 *
 * Three lanes, three sentences (the rule itself is hosted/money.ts):
 *
 *   measured   $0.06                  the reading, final
 *   floor      at least $0.06         a total still being written — the same
 *                                     words the live row already uses, so one
 *                                     idiom covers every kind of lower bound
 *   unmeasured -                      no figure, because none exists
 */
function fmtSpend(spend: SpendStatement): string {
  if (spend.lane === "measured") return fmtUsd(spend.usd);
  if (spend.lane === "floor") return `at least ${fmtUsd(spend.usd)}`;
  return "-";
}

/**
 * THE UPLOADED JOB'S MONEY SLOT — the ruled render: an ingested record's
 * spent cell carries the archive's aggregated REPORTED figure, spelled
 * `reported $X.XX`, with `(N/M trials reporting)` where the detail view has
 * room — clearly labeled, never blended with metered spend, which is null
 * for uploads by law (the meter never saw the run). Null when the job is not
 * an upload (the metered lane rules the slot then); "-" when the archive
 * reported no cost — nothing is invented.
 */
function reportedSpent(e: Job, withCount: boolean): string | null {
  if (!e.upload) return null;
  const totals = e.upload.reported_totals;
  if (!totals || totals.cost_usd === null) return "-";
  const count = withCount
    ? ` (${totals.n_trials_reporting}/${e.n_total_trials} trials reporting)`
    : "";
  return `reported ${fmtUsd(totals.cost_usd)}${count}`;
}

/**
 * The token half of a usage reading, one row wide. Null when the reading
 * carries no token counts at all (money may land first) — the caller then
 * prints nothing rather than a row of dashes. The provisional marker rides
 * inside the cell for the same reason the money lane rides inside fmtSpend:
 * a count still being written must never read as the total.
 */
function fmtUsageTokens(usage: UsageReading): string | null {
  if (usage.input_tokens === null && usage.output_tokens === null) return null;
  const count = (n: number | null) => (n === null ? "-" : n.toLocaleString("en-US"));
  const cached =
    usage.cached_input_tokens !== null ? ` (${count(usage.cached_input_tokens)} cached)` : "";
  return (
    `in ${count(usage.input_tokens)}${cached} · out ${count(usage.output_tokens)}` +
    (usage.provisional ? " — provisional" : "")
  );
}

function fmtAgent(agent: AgentArm | AgentArmInput): string {
  const base = `${agent.name}:${agent.model_name}`;
  return agent.version ? `${base}:${agent.version}` : base;
}

/**
 * The one-line analysis tally — the job detail's "analysis" row and the
 * analyze verb's progress/final lines share it, so the same numbers always
 * read the same way. Four decimals like the other analyzer-spend figures:
 * an analysis costs cents, and "$0.00" would say nothing.
 */
function analysisTally(analysis: JobAnalysisStats): string {
  const parts = [
    `${analysis.n_completed} completed`,
    `${analysis.n_failed} failed`,
    `${analysis.n_pending} pending`,
  ];
  if (analysis.cost_usd != null) parts.push(`spent $${analysis.cost_usd.toFixed(4)}`);
  return parts.join(" · ");
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
  // THE RESULTS-HONESTY LABEL (partial-publish model): a whole-dataset (or
  // glob) run over a partially built version runs the READY tasks, and this
  // row is where the job says so plainly — "ran N of M tasks — K failed to
  // build". The note is the server's own sentence, rendered verbatim;
  // silent truncation is forbidden, so the row appears whenever the job
  // recorded an exclusion.
  for (const exclusion of e.build_exclusions) {
    rows.push(["build exclusions", exclusion.note]);
  }
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
  // The embedded-analysis policy, only when the create named one — the
  // resolved policy, so the row states what every settling trial is analyzed
  // under. The provider is defensive: an older server's echo may not name
  // one, and the row must not invent it.
  if (e.analyze) {
    rows.push([
      "analyze",
      `${e.analyze.model_name} · ${e.analyze.rubric.criteria.length} ` +
        `criteri${e.analyze.rubric.criteria.length === 1 ? "on" : "a"}` +
        (e.analyze.sandbox_provider ? ` · ${e.analyze.sandbox_provider}` : ""),
    ]);
  }
  // Timeout multipliers, only when the job stretches (or shrinks) anything —
  // a row saying "x1" on every default job would be noise. Phase overrides
  // are named beside the global so the row states the whole policy.
  {
    const phases: [string, number | null][] = [
      ["agent", e.agent_timeout_multiplier],
      ["verifier", e.verifier_timeout_multiplier],
      ["agent setup", e.agent_setup_timeout_multiplier],
      ["environment build", e.environment_build_timeout_multiplier],
    ];
    const overrides = phases.filter(([, m]) => m !== null && m !== undefined);
    if (e.timeout_multiplier !== 1 || overrides.length > 0) {
      rows.push([
        "timeouts",
        `x${e.timeout_multiplier}` +
          (overrides.length > 0
            ? ` (${overrides.map(([name, m]) => `${name} x${m}`).join(", ")})`
            : ""),
      ]);
    }
  }
  // The provider cell: a real provider, or — for an ingested record — the
  // word `ported`, RENDERED from the upload provenance, never a stored
  // value: the wire's sandbox_provider is null there because nothing
  // executed, and the closed provider vocabulary gains no fake member.
  rows.push(["provider", e.upload ? "ported" : (e.sandbox_provider ?? "-")]);
  // A JOB TOTAL IS A FLOOR whenever a trial nobody measured folded its zero in
  // — the wire counts them for exactly this reason (n_unmeasured_trials: "cost
  // _usd comes out LOWER than what was really spent"). A freshly finished job
  // is normally in that state for its first few minutes. For an ingested
  // record the slot carries the archive's REPORTED figure instead — see
  // reportedSpent.
  rows.push([
    "spent",
    reportedSpent(e, true) ?? fmtSpend(jobSpend(e.stats.cost_usd, e.stats.n_unmeasured_trials)),
  ]);
  // GPU compute is a SEPARATE labeled estimate (lane 5) — never summed into
  // the spent row above, and absent entirely for a job with no GPU trials.
  if (e.stats.gpu_cost_usd != null) {
    rows.push(["gpu compute (est.)", `$${e.stats.gpu_cost_usd.toFixed(4)}`]);
  }
  // The judge share of the bill, itemized only when one exists: `spent` above
  // is the WHOLE bill (agent + judge), and a job with no judge tasks holds a
  // judge share of 0 — a row saying "$0.00 of judging" would be noise.
  //
  // "EXISTS" IS NOT "IS POSITIVE". Judge trials fold their zeros into
  // judge_cost_usd exactly as agent trials do into the total, so a job whose
  // judges all sealed unmeasured holds a judge share of 0 with a positive
  // n_unmeasured_judge_trials — and suppressing the row there says "no judging
  // happened", which is false. The count is what decides whether there is
  // anything to report; the lane rule then decides how to say it, the same way
  // the whole-bill row above does.
  const judgeUnmeasured = e.stats.n_unmeasured_judge_trials;
  const judged =
    (e.stats.judge_cost_usd != null && e.stats.judge_cost_usd > 0) ||
    (typeof judgeUnmeasured === "number" && judgeUnmeasured > 0);
  if (judged) {
    rows.push([
      "spent (judge)",
      fmtSpend(jobSpend(e.stats.judge_cost_usd, judgeUnmeasured)),
    ]);
  }
  // The token half of the archive's claim, beside the reported spent slot
  // above — REPORTED like it, never the platform's counters (those stay
  // null for an upload).
  if (e.upload?.reported_totals) {
    const totals = e.upload.reported_totals;
    const reportedTokens = [
      totals.n_input_tokens !== null ? `in ${totals.n_input_tokens}` : null,
      totals.n_cache_tokens !== null ? `cache ${totals.n_cache_tokens}` : null,
      totals.n_output_tokens !== null ? `out ${totals.n_output_tokens}` : null,
    ].filter((part): part is string => part !== null);
    if (reportedTokens.length > 0) {
      rows.push(["reported tokens", reportedTokens.join(" · ")]);
    }
  }
  // The trace-analysis aggregate, only when the job has ever been analyzed —
  // null means never, and absence of analysis is stated as absence, not a
  // zero row. The analyzer's spend is its own metered line, never folded
  // into "spent" above; per-criterion tallies get a row each, like skill
  // locks.
  if (e.stats.analysis) {
    rows.push(["analysis", analysisTally(e.stats.analysis)]);
    for (const [name, tally] of Object.entries(e.stats.analysis.checks)) {
      rows.push([
        `  ${name}`,
        `${tally.n_pass} pass · ${tally.n_fail} fail · ${tally.n_not_applicable} n/a`,
      ]);
    }
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
  // Upload provenance, beside the derived-job rows it is the sibling of: when
  // this job is an ingested record, say when — and what the archive's own
  // record files called themselves, when they said anything.
  if (e.upload) {
    const origin = [e.upload.original_job_name, e.upload.original_job_id]
      .filter((part): part is string => part !== null)
      .join(" · ");
    rows.push(["uploaded", `${e.upload.uploaded_at}${origin ? ` — originally ${origin}` : ""}`]);
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
  {
    key: "spent",
    header: "SPENT",
    // One law with the detail row: an uploaded job's cell carries the
    // archive's REPORTED figure, labeled; a native job the metered lane.
    cell: (e) =>
      reportedSpent(e, false) ?? fmtSpend(jobSpend(e.stats.cost_usd, e.stats.n_unmeasured_trials)),
  },
  { key: "started", header: "STARTED", cell: (e) => e.started_at },
];
const JOB_DEFAULT_COLUMNS = ["id", "status", "datasets", "trials", "spent", "started"];

/** Exported for its test, like trialDetailLines above it. */
export const TRIAL_COLUMNS: ListColumn<Trial>[] = [
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
  // Same lane law as the detail row (fmtTrialSpend): a column is one cell wide
  // too, so an unmeasured trial shows "-" rather than the zero its column
  // happens to hold. A list of freshly settled trials is exactly where a wall
  // of "$0.00" would read as a free job. trialSpendNow folds in the live
  // floor from the usage reading, so a RUNNING trial that has demonstrably
  // spent shows "at least $X" instead of a dash — one idiom for every lower
  // bound.
  { key: "spent", header: "SPENT", cell: (r) => fmtSpend(trialSpendNow(r)) },
  {
    // The token half of the usage reading — opt-in via --columns; "-" until
    // the meter answers.
    key: "tokens",
    header: "TOKENS",
    cell: (r) => (r.usage && fmtUsageTokens(r.usage)) || "-",
  },
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

/**
 * "sha256:<hex>" cut to the length every digest surface prints — `sha256:` +
 * the first 12 hex + `…` — the skills DIGEST column and the dataset source line.
 */
function fmtDigestShort(digest: string): string {
  return digest.length > 19 ? `${digest.slice(0, 19)}…` : digest;
}

/** Compact byte count for the skills table — a skill is instructions-sized. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const SKILL_COLUMNS: ListColumn<SkillUpload>[] = [
  { key: "name", header: "NAME", cell: (s) => s.name },
  { key: "id", header: "ID", cell: (s) => s.id },
  { key: "digest", header: "DIGEST", cell: (s) => fmtDigestShort(s.digest) },
  { key: "size", header: "SIZE", cell: (s) => fmtBytes(s.size_bytes) },
  { key: "created", header: "CREATED", cell: (s) => s.created_at },
  { key: "description", header: "DESCRIPTION", cell: (s) => s.description ?? "-" },
  { key: "ref", header: "REF", cell: (s) => s.ref },
];
const SKILL_DEFAULT_COLUMNS = ["name", "id", "digest", "size", "created"];

const AGENT_COLUMNS: ListColumn<Agent>[] = [
  { key: "name", header: "NAME", cell: (a) => a.name },
  { key: "source", header: "SOURCE", cell: (a) => a.source },
  { key: "run", header: "RUN COMMAND", cell: (a) => a.run_command },
  { key: "updated", header: "UPDATED", cell: (a) => a.updated_at },
];
const AGENT_DEFAULT_COLUMNS = ["name", "source", "run", "updated"];

// Values never appear in any column — the server never returns them.
const SECRET_COLUMNS: ListColumn<ManagedSecretMetadata>[] = [
  { key: "name", header: "NAME", cell: (s) => s.name },
  { key: "label", header: "LABEL", cell: (s) => s.label ?? "default" },
  { key: "delivery", header: "DELIVERY", cell: (s) => s.delivery ?? "brokered" },
  { key: "hosts", header: "ALLOWED HOSTS", cell: (s) => s.allowedHosts.join(", ") || "-" },
  { key: "updated", header: "UPDATED", cell: (s) => s.updatedAt },
  { key: "last-used", header: "LAST USED", cell: (s) => s.lastUsedAt ?? "-" },
  { key: "id", header: "ID", cell: (s) => s.id },
];
const SECRET_DEFAULT_COLUMNS = ["name", "label", "delivery", "hosts", "updated"];

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
  rows.push(["spent", fmtSpend(trialAgentCost(run))]);
  // THE JUDGE'S SHARE, itemized beside the agent's when this task's verifier
  // ran an LLM judge on its own gateway key (judge_result present). The agent
  // figure above stays the agent's alone; the trial's whole bill is the sum.
  // Its own lane, read the same way: the judge key seals through the identical
  // settle, so it reaches `assumed_cap` for the identical reason and at the
  // identical moment, and a bare figure here would be the same lie one row
  // lower down.
  if (run.judge_result) {
    rows.push(["spent (judge)", fmtSpend(trialJudgeCost(run))]);
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
  // THE TOKEN HALF of the meter, from the one-home usage reading — the same
  // gateway records the money rows above were summed from, ticking while the
  // trial runs and settling with it. The provisional marker inside the cell
  // says whether the counts can still grow.
  if (run.usage) {
    const tokens = fmtUsageTokens(run.usage);
    if (tokens) rows.push(["tokens", tokens]);
  }
  // THE UPLOADED TRIAL'S OWN RECORD, labeled REPORTED and kept visually
  // apart from the metered rows above: those stay empty for an upload —
  // this platform's meter never saw the run — while these are the archive's
  // own claim, served for the reader and never folded into any total.
  if (run.upload) {
    const reported = run.upload.reported_agent_result;
    if (reported && reported.cost_usd !== null) {
      rows.push([
        "reported cost",
        `$${reported.cost_usd.toFixed(4)} (the original run's own record — not platform-metered)`,
      ]);
    }
    const reportedTokens = reported
      ? [
          reported.n_input_tokens !== null ? `in ${reported.n_input_tokens}` : null,
          reported.n_cache_tokens !== null ? `cache ${reported.n_cache_tokens}` : null,
          reported.n_output_tokens !== null ? `out ${reported.n_output_tokens}` : null,
        ].filter((part): part is string => part !== null)
      : [];
    if (reportedTokens.length > 0) {
      rows.push(["reported tokens", reportedTokens.join(" · ")]);
    }
    rows.push([
      "uploaded from",
      `${run.upload.original_trial_name} · task ${run.upload.original_task_name}` +
        (run.upload.original_trial_id ? ` · ${run.upload.original_trial_id}` : ""),
    ]);
  }
  if (run.attempt_phase) rows.push(["phase", run.attempt_phase]);
  // Same render law as the job's provider cell: an uploaded trial executed
  // on no platform sandbox (the wire field is null), and `ported` is the
  // word for that — derived from provenance, never stored.
  if (run.upload) rows.push(["provider", "ported"]);
  else if (run.sandbox_provider) rows.push(["provider", run.sandbox_provider]);
  // The GPU degrade, when one happened: where the job asked to run vs where
  // the boxes actually ran, with the refusing provider's own reason.
  if (run.sandbox_provider_degrade) {
    const d = run.sandbox_provider_degrade;
    rows.push(["provider degrade", `${d.from} → ${d.to}: ${d.reason}`]);
  }
  // GPU compute (lane 5): a SEPARATE labeled estimate, never folded into the
  // spent row above. Priced = the full audit sentence (what x how long x whose
  // rate card); unpriced = the server's own reason, verbatim — a number is
  // never invented client-side. The device named is the one priced
  // (`gpu_type`); a priced record always has one, so the fallback below can
  // only be reached by a malformed body.
  if (run.gpu_cost) {
    const g = run.gpu_cost;
    if (g.estimate_usd != null) {
      const type = g.gpu_type ?? "unknown type";
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
  // The trial's LATEST trace analysis (Harbor's analyze result verbatim):
  // status and the exact model THIS analysis ran under, one row per criterion
  // verdict, the summary, and the analyzer's own metered spend — its own
  // line by law, never part of the trial's bill above. A failed analysis
  // shows its typed failure, never a silent absence.
  if (run.analysis) {
    const analysis = run.analysis;
    // The id closes the loop to the analysis verbs: `evolve analysis
    // show|trace|download <id>` read the ANALYZER's own side of this row.
    rows.push(["analysis", `${analysis.status} · ${analysis.model_name} · ${analysis.id}`]);
    for (const [name, check] of Object.entries(analysis.checks ?? {})) {
      rows.push([`  ${name}`, `${check.outcome} — ${check.explanation}`]);
    }
    if (analysis.summary) rows.push(["  summary", analysis.summary]);
    if (analysis.estimated_cost_usd !== null) {
      rows.push(["  analyzer spend", `$${analysis.estimated_cost_usd.toFixed(4)}`]);
    }
    if (analysis.failure) {
      rows.push(["  failure", `${analysis.failure.phase}: ${analysis.failure.message}`]);
    }
  }
  if (run.session_ref) rows.push(["session", run.session_ref]);
  if (run.started_at) rows.push(["started", run.started_at]);
  if (run.finished_at) rows.push(["finished", run.finished_at]);
  return table(rows);
}

/**
 * Full-detail rendering of one analysis run — evolve analysis show. The same
 * facts `trial show` folds into its `analysis` rows, standing on their own:
 * status and model, one row per criterion verdict, the summary, the
 * analyzer's own metered spend (four decimals like every analyzer-spend
 * figure — an analysis costs cents), and the typed failure when there is
 * one. Exported for tests, like the other line renderers.
 */
export function analysisDetailLines(analysis: TrialAnalysis): string[] {
  const criteria = analysis.rubric.criteria.length;
  const rows: string[][] = [
    ["analysis id", analysis.id],
    ["status", analysis.status],
    ["model", analysis.model_name],
    ["rubric", `${criteria} criteri${criteria === 1 ? "on" : "a"}`],
  ];
  for (const [name, check] of Object.entries(analysis.checks ?? {})) {
    rows.push([`  ${name}`, `${check.outcome} — ${check.explanation}`]);
  }
  if (analysis.summary) rows.push(["summary", analysis.summary]);
  if (analysis.estimated_cost_usd !== null) {
    rows.push(["spent", `$${analysis.estimated_cost_usd.toFixed(4)}`]);
  }
  // The token half of the analyzer's one-home usage reading — same row, same
  // renderer, as a trial's.
  if (analysis.usage) {
    const tokens = fmtUsageTokens(analysis.usage);
    if (tokens) rows.push(["tokens", tokens]);
  }
  if (analysis.failure) {
    rows.push(["failure", `${analysis.failure.phase}: ${analysis.failure.message}`]);
  }
  rows.push(["created", analysis.created_at]);
  if (analysis.finished_at) rows.push(["finished", analysis.finished_at]);
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
    ["status", statusWithReceiving(job)],
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

/** Compact duration for the progress lines: 55s, 12m34s, 1h02m. */
function fmtDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${String(sec).padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${String(min % 60).padStart(2, "0")}m`;
}

/**
 * Compact one-line rendering of one live-progress change for --watch — the
 * poll-line adaptation of Harbor's publish progress display (their overall
 * bar is spinner + "M of N" + description + elapsed/remaining, rich Live at
 * 10 fps: REFERENCES/Harbor src/harbor/cli/publish.py:231-238; ours is a
 * line per observed server write, so it keeps the M-of-N and elapsed columns
 * and drops the animation). During the copy phase the line states "N of M
 * images already banked" — Harbor's "skipped (exists)" idea (publish.py:388)
 * in this platform's banked vocabulary.
 */
export function importProgressLine(progress: DatasetImportProgress, nowMs = Date.now()): string {
  const at = progress.phases[progress.phases.length - 1];
  const parts: string[] = [];
  if (at !== undefined && at.total > 0) {
    parts.push(`${at.done}/${at.total}`);
    if (at.banked !== undefined && at.banked > 0) {
      parts.push(
        at.name === "copying"
          ? `${at.banked} of ${at.total} images already banked`
          : `${at.banked} banked`
      );
    }
  }
  const startedMs = at !== undefined ? Date.parse(at.started_at) : NaN;
  if (Number.isFinite(startedMs)) parts.push(fmtDurationMs(nowMs - startedMs));
  return `phase  ${progress.phase}${parts.length > 0 ? ` ${parts.join(" · ")}` : ""}`;
}

/**
 * The settled progress record for the final --watch block: wall-clock per
 * phase, the publish's image economics (built / mirrored / banked), and the
 * CodeBuild copy-minutes meter — the shape of Harbor publish's settle
 * summary (per-item Build/Upload timing table + "Published N, skipped M
 * task(s) in X.XXs": REFERENCES/Harbor src/harbor/cli/publish.py:288-315).
 */
export function progressSettleLines(progress: DatasetImportProgress): string[] {
  const phaseParts = progress.phases.map((p: ImportPhaseProgress) => {
    const endMs = p.completed_at !== undefined ? Date.parse(p.completed_at) : NaN;
    const startMs = Date.parse(p.started_at);
    const wall =
      Number.isFinite(endMs) && Number.isFinite(startMs)
        ? fmtDurationMs(endMs - startMs)
        : "unfinished";
    return `${p.name} ${wall}`;
  });
  const images = progress.images;
  const codebuild = progress.codebuild;
  return table([
    ["phases", phaseParts.join(" · ")],
    ["images", `${images.built} built, ${images.mirrored} mirrored, ${images.banked} banked`],
    [
      "codebuild",
      `${codebuild.copy_builds} copy build(s), ${codebuild.billed_minutes} billed minute(s)`,
    ],
  ]);
}

/**
 * A status word with the register-first marker beside it: a QUEUED import
 * whose corpus is still uploading reads "QUEUED (receiving)" — same status
 * vocabulary, the flag the server states (`DatasetImport.receiving`) made
 * visible instead of sixteen indistinguishable minutes.
 */
function statusWithReceiving(job: DatasetImport): string {
  return job.receiving === true ? `${job.status} (receiving)` : job.status;
}

/** Compact one-line rendering of one publish status change for --watch. */
export function importStatusLine(job: DatasetImport): string {
  const parts: string[] = [];
  if (job.task_count !== undefined) parts.push(`tasks=${job.task_count}`);
  if (job.failure) parts.push(truncate(importFailureText(job.failure), 140));
  return `status ${statusWithReceiving(job).padEnd(12)} ${parts.join(" ")}`.trimEnd();
}

/**
 * Compact one-line rendering of one version state change for --watch's
 * settle phase: the version's own walk (BUILDING, then READY/ARCHIVED or
 * FAILED).
 */
export function versionStatusLine(version: DatasetVersion): string {
  return `state  ${version.state}`;
}

/**
 * The settled version's facts for the final --watch block: state, and
 * whether the dataset's ACTIVE version is now this publish — the fact a
 * re-publisher needs, because a bare name resolves to the active version.
 */
function versionSettleLines(version: DatasetVersion, detail: Dataset | null): string[] {
  const rows: string[][] = [["state", version.state]];
  if (detail) {
    const active = detail.active_version?.version ?? null;
    rows.push([
      "active",
      active === version.version
        ? `${active} (this publish)`
        : active
          ? `${active} (unchanged)`
          : "none",
    ]);
  }
  return table(rows);
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
    // The index walks the SCOPE the verb names: `analysis list --scope shared
    // --job <prefix>` resolves the prefix among the teammates' jobs it is
    // about to list, never among the caller's own — a prefix that could only
    // ever match the wrong scope's jobs would refuse every time.
    const scope = parseScopeFlag(inv);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.list({
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(scope !== undefined ? { scope } : {}),
      });
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

/** --scope, validated at the keyboard against the SDK's own vocabulary. */
function parseScopeFlag(inv: Invocation): JobListScope | undefined {
  if (inv.flags.scope === undefined) return undefined;
  const scope = String(inv.flags.scope);
  if (!(JOB_LIST_SCOPES as readonly string[]).includes(scope)) {
    throw new CliUsageError(
      `--scope must be one of: ${JOB_LIST_SCOPES.join(", ")}; got: ${scope}` +
        (scope === "all" ? " (Harbor's all adds public rows — nothing hosted is public)" : "")
    );
  }
  return scope as JobListScope;
}

/** --status on `analysis list`: the analysis object's own lowercase ladder. */
function parseAnalysisStatusFilter(inv: Invocation): AnalysisStatus[] | undefined {
  if (inv.flags.status === undefined) return undefined;
  const statuses = String(inv.flags.status)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (statuses.length === 0) {
    throw new CliUsageError("--status got an empty status list");
  }
  const unknown = statuses.filter((s) => !(ANALYSIS_STATUSES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw new CliUsageError(
      `--status must name analysis statuses (${ANALYSIS_STATUSES.join(", ")}); got: ${unknown.join(", ")}`
    );
  }
  return statuses as AnalysisStatus[];
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
  const scope = parseScopeFlag(inv);
  const client = jobs(clientConfig(inv));
  const page = await client.list({
    ...pageOptions(inv),
    ...(inv.flags.search !== undefined ? { search: String(inv.flags.search) } : {}),
    ...(scope !== undefined ? { scope } : {}),
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
 * Harbor's `hub job delete` posture (their cli/hub.py delete_cmd): a
 * destructive verb never fires bare — without --yes it names what would die
 * and asks, and a non-interactive stdin refuses with "re-run with --yes".
 * One id per invocation where Harbor's takes a list: the wire is one DELETE
 * per job and the house grammar is unary (recorded deviation). The server
 * owns every refusal — creator-only, terminal-only, no live analysis wave
 * or derived regrade — and each surfaces verbatim through the standard
 * error path.
 */
async function cmdJobDelete(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const id = await resolveJobId(inv, inv.positionals[0]);
  if (inv.flags.yes !== true) {
    if (io.confirm === undefined) {
      // Harbor's non-TTY refusal — reads may have happened (prefix
      // resolution, exactly as Harbor reads headers first), deletes never.
      throw new Error(
        "deleting a job is permanent — trials, traces, analyses and stored files. " +
          "Re-run with --yes to confirm."
      );
    }
    // Name what would die before asking — Harbor prints each id with its
    // job name ahead of the prompt. The naming line rides stderr with the
    // question: stdout stays machine-clean.
    const job = await client.get(id);
    io.err(`  ${job.id}  ${job.job_name || "—"}`);
    if (!(await io.confirm("Permanently delete this job and all associated trials?"))) {
      io.err("Delete cancelled.");
      return 1;
    }
  }
  const receipt = await client.delete(id);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(receipt));
  } else {
    io.out(
      `Deleted job ${receipt.job_id}: ${receipt.trials_deleted} trials, ` +
        `${receipt.analyses_deleted} analyses destroyed.`
    );
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
      io.out(
        JSON.stringify({ stopped: [], stopped_analyses: [], already_terminal: [], not_found: [] })
      );
    } else {
      io.out(`No trials in ${dataset}.`);
    }
    return 0;
  }
  // The trial-stop door caps one request at 100 ids and 400s above it, while a
  // dataset slice can hold thousands of trials — page the batch under the
  // cap and merge the reports into the one outcome the caller reads.
  const trialClient = trials(clientConfig(inv));
  const result: StopResponse = {
    stopped: [],
    stopped_analyses: [],
    already_terminal: [],
    not_found: [],
  };
  let reported = 0;
  try {
    for (let i = 0; i < trialIds.length; i += 100) {
      const batch = trialIds.slice(i, i + 100);
      const page = await trialClient.stop(batch);
      reported += batch.length;
      result.stopped.push(...page.stopped);
      // Trial ids only ride this door, so the server's list is empty here —
      // merged anyway so the report is the wire shape, never a subset of it.
      result.stopped_analyses.push(...page.stopped_analyses);
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

/**
 * The settled wave, one row per analyzed trial — Harbor's "Trial Analyses"
 * table carried over: the criterion verdicts, the analyzer's own cost, and a
 * summary excerpt. A failed analysis renders its typed failure in place of
 * verdicts and repeats it in full below the table — never a silent absence.
 * Exported for its test, like the other line renderers.
 */
export function analysisResultLines(runs: Trial[]): string[] {
  if (runs.length === 0) return ["No analyzed trials."];
  const rows: string[][] = [["TRIAL", "TASK", "CHECKS", "COST", "SUMMARY"]];
  const failures: string[] = [];
  for (const run of runs) {
    const analysis = run.analysis as TrialAnalysis;
    let checks: string;
    if (analysis.status === "failed") {
      checks = `FAILED${analysis.failure ? ` (${analysis.failure.phase})` : ""}`;
      if (analysis.failure) {
        failures.push(
          `analysis failed ${run.id} (${run.task_name}) — ` +
            `${analysis.failure.phase}: ${oneLine(analysis.failure.message)}`
        );
      }
    } else {
      checks =
        Object.entries(analysis.checks ?? {})
          .map(([name, check]) => `${name} ${check.outcome}`)
          .join(" · ") || analysis.status;
    }
    rows.push([
      run.id,
      run.task_name,
      checks,
      analysis.estimated_cost_usd !== null
        ? `$${analysis.estimated_cost_usd.toFixed(4)}`
        : "-",
      analysis.summary ? truncate(oneLine(analysis.summary), 60) : "-",
    ]);
  }
  return [...table(rows), ...failures];
}

async function cmdAnalyze(inv: Invocation, io: CliIO): Promise<number> {
  const json = inv.flags.json === true;
  const watch = inv.flags.watch === true;
  const quiet = inv.flags.quiet === true;
  const client = jobs(clientConfig(inv));
  const id = await resolveJobId(inv, inv.positionals[0]);
  // The config, parsed at the keyboard ({} = Harbor's defaults); the server
  // owns every acceptance refusal — the rubric bounds, the model roster, the
  // one-wave-at-a-time law.
  const req: AnalyzeConfigInput = {};
  if (inv.flags.model !== undefined) req.model_name = String(inv.flags.model);
  if (inv.flags.rubric !== undefined) req.rubric = loadRubricFile(String(inv.flags.rubric));
  // -e rides verbatim, like --analyze-provider on run: the analyzer's
  // provider lineup is the server's roster, and its `invalid_input` refusal
  // names it — no client-side copy to drift.
  if (inv.flags.env !== undefined) {
    req.sandbox_provider = String(inv.flags.env) as EvalSandboxProvider;
  }
  // --effort rides verbatim too (the run verb's own flag applied to the
  // analyzer): the server's effort vocabulary is the one copy.
  if (inv.flags.effort !== undefined) req.reasoning_effort = String(inv.flags.effort);
  // The 202 IS the queued batch — the job body, `stats.analysis` counting
  // the enqueued rows as pending — and the verb returns with it, the shape
  // of `job start` / `run`: Harbor's hosted launch prints the accepted job
  // and returns (their cli/hosted_jobs.py run_hosted_launch), and the wait
  // is a separate poll (their hub.py status_cmd: "polling this command is
  // the point of --json"). --watch is that poll, opted in.
  const accepted = await client.analyze(id, req);
  if (!watch) {
    if (json) {
      io.out(JSON.stringify(accepted));
    } else {
      for (const line of jobLines(accepted)) io.out(line);
      io.out("");
      io.out(`Follow it with: evolve job show ${accepted.id}`);
    }
    return 0;
  }

  if (json) {
    io.out(JSON.stringify({ kind: "analysis.accepted", job: accepted }));
  } else if (!quiet) {
    io.out(`Job ${accepted.id} — analyses enqueued, watching…`);
  }

  // Analyses have no event stream (the contract's own words: poll the job's
  // trials to watch them settle), so the follow is the SDK's poll —
  // -q keeps it silent and prints the final block only, like job start.
  const final = await client.watchAnalysis(accepted.id, {
    onStats: (job) => {
      if (quiet) return;
      if (!job.stats.analysis) return;
      io.out(
        json
          ? JSON.stringify({ kind: "analysis.stats", analysis: job.stats.analysis })
          : `analyses ${analysisTally(job.stats.analysis)}`
      );
    },
  });

  // The per-trial results ride the trials, not the job body.
  const analyzed: Trial[] = [];
  for await (const run of client.trials(final.id)) {
    if (run.analysis) analyzed.push(run);
  }

  if (json) {
    io.out(JSON.stringify({ kind: "analysis.final", job: final, trials: analyzed }));
  } else {
    io.out("");
    for (const line of analysisResultLines(analyzed)) io.out(line);
    if (final.stats.analysis) {
      io.out("");
      io.out(`analyses ${analysisTally(final.stats.analysis)}`);
    }
    io.out(`Details: evolve trial show <trial-id>`);
  }
  // Harbor's own exit law: any failed analysis is exit 1 — a wave that lost
  // trials never reads as a clean pass.
  return (final.stats.analysis?.n_failed ?? 0) > 0 ? 1 : 0;
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
    // The evolve.json records — the platform facts Harbor's layout has no
    // slot for (gateway money/tokens per lane, provider, user_id, regrade
    // lineage): one at the job root, one per trial directory, each trial
    // matched by the id its result.json's x_evolve extension names. Content
    // is the SDK's (jobEvolveRecord / trialEvolveRecord); this verb only
    // fetches, matches and writes.
    const { readdir, readFile: readFileAsync, writeFile } = await import("node:fs/promises");
    const jobBody = await client.get(id);
    const userId = await callerUserId(inv);
    const trialsById = new Map<string, Trial>();
    for await (const run of client.trials(id)) trialsById.set(run.id, run);
    await writeFile(
      join(targetDir, "evolve.json"),
      JSON.stringify(jobEvolveRecord(jobBody, userId), null, 2) + "\n"
    );
    files.push("evolve.json");
    for (const entry of await readdir(targetDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let trialId: string | undefined;
      try {
        const result = JSON.parse(
          await readFileAsync(join(targetDir, entry.name, "result.json"), "utf8")
        ) as { x_evolve?: { trialId?: string } };
        trialId = result.x_evolve?.trialId;
      } catch {
        continue;
      }
      const run = trialId !== undefined ? trialsById.get(trialId) : undefined;
      if (!run) continue;
      await writeFile(
        join(targetDir, entry.name, "evolve.json"),
        JSON.stringify(trialEvolveRecord(run, jobBody, userId), null, 2) + "\n"
      );
      files.push(`${entry.name}/evolve.json`);
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

/** The import id with its status, receiving marked — the job-import twin of statusWithReceiving. */
function jobImportStatus(imported: JobImport): string {
  return imported.receiving ? `${imported.status} (receiving)` : imported.status;
}

/** The detail rows of one job import (`job import <id>`, and the follow's settled record). */
function jobImportLines(imported: JobImport): string[] {
  const rows: string[][] = [
    ["id", imported.id],
    ["status", jobImportStatus(imported)],
  ];
  if (imported.source !== null) {
    rows.push([
      "source",
      imported.source.type === "archive"
        ? `archive (sha256:${imported.source.sha256.slice(0, 12)}…)`
        : imported.source.type === "archive_url"
          ? `url ${imported.source.url}`
          : `hub job ${imported.source.job_id}`,
    ]);
  }
  if (imported.dataset !== null) rows.push(["dataset", imported.dataset]);
  if (imported.job_id !== null) rows.push(["job", imported.job_id]);
  if (imported.n_trials_uploaded !== null) rows.push(["trials", String(imported.n_trials_uploaded)]);
  if (imported.progress !== null) rows.push(["phase", imported.progress.phase]);
  if (imported.failure !== null) rows.push(["failure", `${imported.failure.code}: ${imported.failure.message}`]);
  return table(rows);
}

/** One line per observed status change of a job import under --watch. */
function jobImportStatusLine(imported: JobImport): string {
  const detail =
    imported.failure !== null ? truncate(`${imported.failure.code}: ${imported.failure.message}`, 140) : "";
  return `status ${jobImportStatus(imported).padEnd(20)} ${detail}`.trimEnd();
}

/** One line per observed phase change of a job import under --watch. */
function jobImportProgressLine(progress: JobImportProgress, nowMs = Date.now()): string {
  const elapsed = fmtDurationMs(nowMs - Date.parse(progress.started_at));
  return `phase  ${progress.phase.padEnd(20)} ${elapsed} elapsed`;
}

/**
 * Follow a job import to its settle and render the outcome: COMPLETED
 * prints the ingested JOB (the record `evolve upload` printed before the
 * door became asynchronous) and the analyze hint; FAILED prints the typed
 * failure and exits 1 — the same exit and the same code a synchronous
 * refusal once produced, one hop later. In --json mode the follow is silent
 * and ONE document is printed at the end: the Job on success, the failure
 * envelope on FAILED — exactly the shapes scripts branched on before.
 */
async function followJobImport(
  inv: Invocation,
  imported: JobImport,
  io: CliIO,
  opening: "accepted" | "attached"
): Promise<number> {
  const client = jobs(clientConfig(inv));
  const json = inv.flags.json === true;
  if (!json) {
    io.out(
      opening === "accepted"
        ? `Upload accepted: import ${imported.id} ${jobImportStatus(imported)} — watching…`
        : `Import ${imported.id} ${jobImportStatus(imported)} — watching…`
    );
  }
  const final = await client.watchImport(imported.id, {
    onStatus: (current) => {
      if (!json) io.out(jobImportStatusLine(current));
    },
    onProgress: (progress) => {
      if (!json) io.out(jobImportProgressLine(progress));
    },
  });
  if (final.status === "FAILED" || final.job_id === null) {
    const failure = final.failure ?? {
      code: "import_failed",
      message: "the import settled without a job and without a recorded failure",
    };
    if (json) io.out(JSON.stringify({ error: failure }));
    io.err(`Error: ${failure.message}`);
    return 1;
  }
  const job = await client.get(final.job_id);
  if (json) {
    io.out(JSON.stringify(job));
    return 0;
  }
  io.out("");
  for (const line of jobLines(job)) io.out(line);
  io.out("");
  io.out(`Analyze it with: evolve analyze ${job.id}`);
  return 0;
}

/**
 * `evolve upload <job_dir>` — Harbor's top-level upload verb, in reverse:
 * the SDK validates the directory gate (their sentences), packs to a temp
 * file, and streams; the door answers 202 with the job import, and this
 * handler FOLLOWS it to the ingested job by default (the record the verb
 * always printed), or prints the import with `--no-wait`. `--from <url>`
 * hands the server a public archive url instead of local bytes (the
 * dataset publish verb's own flag). Transfer progress prints once per 10 %
 * in human mode; a resumable session's import id prints as soon as it is
 * registered so a watcher can re-attach from anywhere.
 */
async function cmdUpload(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const json = inv.flags.json === true;
  const dataset = inv.flags.dataset as string | undefined;
  const from = inv.flags.from as string | undefined;
  const positional = inv.positionals[0];
  if (from !== undefined && positional !== undefined) {
    throw new CliUsageError('"upload" takes EXACTLY ONE source: <job_dir>, or --from <url>');
  }
  if (from === undefined && positional === undefined) {
    throw new CliUsageError('"upload" needs a source: <job_dir> (or its .tar.gz), or --from <url>');
  }
  if (from !== undefined && !from.trim().startsWith("https://")) {
    throw new CliUsageError(`"--from" takes a public https url of a job archive (got "${from}")`);
  }
  let lastTenth = -1;
  const imported = await client.upload(from !== undefined ? { archive_url: from.trim() } : positional, {
    ...(dataset !== undefined ? { dataset } : {}),
    onUploadProgress: (sent, total) => {
      if (json) return;
      const tenth = total > 0 ? Math.floor((sent / total) * 10) : 10;
      if (tenth === lastTenth) return;
      lastTenth = tenth;
      io.out(`upload ${sent}/${total} (${Math.min(100, tenth * 10)}%)`);
    },
    onRegistered: (importId) => {
      if (json) return;
      io.out(`Registered import ${importId} — re-attach anytime with: evolve job import ${importId} --watch`);
    },
  });
  if (inv.flags["no-wait"] === true) {
    if (json) {
      io.out(JSON.stringify(imported));
      return 0;
    }
    for (const line of jobImportLines(imported)) io.out(line);
    io.out("");
    io.out(`Follow it with: evolve job import ${imported.id} --watch`);
    return 0;
  }
  return followJobImport(inv, imported, io, "accepted");
}

/** `evolve job imports` — the caller's job imports, newest first. */
async function cmdJobImports(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const status = inv.flags.status as string | undefined;
  if (status !== undefined && !["QUEUED", "RUNNING", "COMPLETED", "FAILED"].includes(status)) {
    throw new CliUsageError(`"--status" must be one of QUEUED, RUNNING, COMPLETED, FAILED (got "${status}")`);
  }
  const page = await client.listImports({
    ...pageOptions(inv),
    ...(status !== undefined ? { status: status as JobImport["status"] } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (inv.flags.quiet === true) {
    for (const imported of page.items) io.out(imported.id);
    return 0;
  }
  const rows = page.items.map((imported) => [
    imported.id,
    jobImportStatus(imported),
    imported.job_id ?? "-",
    imported.n_trials_uploaded === null ? "-" : String(imported.n_trials_uploaded),
    imported.dataset ?? "-",
    imported.created_at ?? "",
  ]);
  for (const line of table([["ID", "STATUS", "JOB", "TRIALS", "DATASET", "CREATED"], ...rows])) io.out(line);
  if (page.hasMore && page.nextCursor) io.out(`\nnext: --cursor ${page.nextCursor}`);
  return 0;
}

/** `evolve job import <id>` — one job import; `--watch` follows it to the job or its typed failure. */
async function cmdJobImport(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const imported = await client.getImport(inv.positionals[0]);
  if (inv.flags.watch === true) return followJobImport(inv, imported, io, "attached");
  if (inv.flags.json === true) {
    io.out(JSON.stringify(imported));
    return 0;
  }
  for (const line of jobImportLines(imported)) io.out(line);
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

  // Save mode: the trial as HARBOR'S TRIAL TREE under <output-dir>/<trial-id>/
  // — config.json, result.json, agent/ (trajectory, raw logs, parsed events,
  // sessions/), verifier/, PLUS evolve.json (the platform record Harbor has
  // no slot for: gateway money/tokens per lane, provider, user_id, regrade
  // lineage). The assembly is the SDK's (assembleTrialTree — the CLI only
  // fetches parts and writes files); absent artifacts are absent files.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const targetDir = join((inv.flags["output-dir"] as string | undefined) ?? "trials", trialId);
  if (existsSync(targetDir) && inv.flags.overwrite !== true) {
    throw new Error(`${targetDir} already exists (pass --overwrite to replace it)`);
  }
  const run = await client.get(trialId);
  // The job carries the regrade lineage; a trial without a reachable job
  // still downloads, with the lineage read as an original run's.
  let jobBody: Job | null = null;
  try {
    jobBody = await jobs(clientConfig(inv)).get(run.job_id);
  } catch {
    jobBody = null;
  }
  const events: TraceEvent[] = [];
  for await (const event of client.traceEvents(trialId)) events.push(event);
  const files = assembleTrialTree({
    trial: run,
    job: jobBody,
    events,
    atif: await client.artifact(trialId, "trace-atif"),
    verifierLog: await client.artifact(trialId, "verifier"),
    stdout: await client.artifact(trialId, "trace-stdout"),
    stderr: await client.artifact(trialId, "trace-stderr"),
    home: await client.artifact(trialId, "agent-home"),
    userId: await callerUserId(inv),
  });
  await mkdir(targetDir, { recursive: true });
  const saved: string[] = [];
  for (const path of Object.keys(files).sort()) {
    const target = join(targetDir, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, files[path]);
    saved.push(path);
    if (!json) io.out(path);
  }
  if (json) {
    io.out(JSON.stringify({ path: targetDir, saved }));
  } else {
    io.out(`Saved ${targetDir}`);
  }
  return 0;
}

/** The caller's USER id for evolve.json's `user_id` — null when unreachable. */
async function callerUserId(inv: Invocation): Promise<string | null> {
  try {
    return (await auth(clientConfig(inv)).status()).user_id;
  } catch {
    return null;
  }
}

async function cmdTrialTrace(inv: Invocation, io: CliIO): Promise<number> {
  const client = trials(clientConfig(inv));
  const json = inv.flags.json === true;
  // Parse, call, print: the filters travel verbatim — validation (regex
  // syntax included) is the server's, and its typed refusal is the answer.
  const options: TraceOptions = pageOptions(inv);
  if (inv.flags.type !== undefined) options.type = String(inv.flags.type);
  if (inv.flags.grep !== undefined) options.grep = String(inv.flags.grep);
  if (inv.flags.tail !== undefined) options.tail = inv.flags.tail as number;
  let count = 0;
  for await (const event of client.traceEvents(inv.positionals[0], options)) {
    io.out(json ? JSON.stringify(event) : traceEventLine(event));
    count += 1;
  }
  if (!json && count === 0) io.out("No trace events.");
  return 0;
}

async function cmdJobGrep(inv: Invocation, io: CliIO): Promise<number> {
  const client = jobs(clientConfig(inv));
  const id = await resolveJobId(inv, inv.positionals[0]);
  const options: GrepJobOptions = pageOptions(inv);
  if (inv.flags.type !== undefined) options.type = String(inv.flags.type);
  const page = await client.grep(id, inv.positionals[1], options);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.items.length === 0) {
    io.out("No matches.");
    return 0;
  }
  for (const group of page.items) {
    const label = group.match_count === 1 ? "match" : "matches";
    io.out(`${group.trial_id}  ${group.task_name ?? "-"}  ${group.match_count} ${label}`);
    for (const event of group.events) io.out(`  ${traceEventLine(event)}`);
  }
  if (page.hasMore && page.nextCursor) {
    io.out("");
    io.out(`More trials match — resume with --cursor ${page.nextCursor}`);
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
  // A stopped trace analysis is its own row — settled failed, phase
  // stopped — never silently absent from the report.
  for (const analysis of result.stopped_analyses) {
    io.out(`stopped analysis ${analysis.id} ${analysis.status}`);
  }
  for (const id of result.already_terminal) io.out(`already terminal ${id}`);
  for (const id of result.not_found) io.out(`not found ${id}`);
  return 0;
}

/**
 * An analysis's money cell, one cell wide like every other (fmtSpend's law):
 * the settled figure at the analyzer's four-decimal precision; while the run
 * is live, the usage reading's floor stated as a floor; nothing measured, "-".
 */
function fmtAnalysisSpent(a: TrialAnalysis): string {
  if (typeof a.estimated_cost_usd === "number") return `$${a.estimated_cost_usd.toFixed(4)}`;
  const live = a.usage?.spent_usd;
  return typeof live === "number" && a.usage?.provisional ? `at least $${live.toFixed(4)}` : "-";
}

const ANALYSIS_COLUMNS: ListColumn<TrialAnalysis>[] = [
  { key: "id", header: "ID", cell: (a) => a.id },
  { key: "status", header: "STATUS", cell: (a) => a.status },
  { key: "task", header: "TASK", cell: (a) => a.task_name },
  { key: "job", header: "JOB", cell: (a) => a.job_id },
  { key: "trial", header: "TRIAL", cell: (a) => a.trial_id },
  { key: "model", header: "MODEL", cell: (a) => a.model_name },
  { key: "attempts", header: "ATTEMPTS", cell: (a) => String(a.attempts ?? 1) },
  { key: "spent", header: "SPENT", cell: fmtAnalysisSpent },
  { key: "created", header: "CREATED", cell: (a) => a.created_at },
  { key: "finished", header: "FINISHED", cell: (a) => a.finished_at ?? "-" },
];
const ANALYSIS_DEFAULT_COLUMNS = ["id", "status", "task", "model", "spent", "created"];

async function cmdAnalysisList(inv: Invocation, io: CliIO): Promise<number> {
  if (columnsHelpRequested(inv, io, ANALYSIS_COLUMNS)) return 0;
  const scope = parseScopeFlag(inv);
  const status = parseAnalysisStatusFilter(inv);
  // --job takes a prefix like every verb that names a job.
  const job = inv.flags.job !== undefined ? await resolveJobId(inv, String(inv.flags.job)) : undefined;
  const client = analyses(clientConfig(inv));
  const page = await client.list({
    ...pageOptions(inv),
    ...(scope !== undefined ? { scope } : {}),
    ...(job !== undefined ? { job } : {}),
    ...(status !== undefined ? { status } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.items.length === 0) {
    if (inv.flags.quiet !== true) io.out("No analyses.");
    return 0;
  }
  renderList(inv, io, page.items, ANALYSIS_COLUMNS, ANALYSIS_DEFAULT_COLUMNS, (a) => a.id);
  if (page.nextCursor && io.tty === true && inv.flags.quiet !== true) {
    io.out(`\nMore: evolve analysis list --cursor ${page.nextCursor}`);
  }
  return 0;
}

async function cmdAnalysisShow(inv: Invocation, io: CliIO): Promise<number> {
  const analysis = await analyses(clientConfig(inv)).get(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(analysis));
  } else {
    for (const line of analysisDetailLines(analysis)) io.out(line);
  }
  return 0;
}

async function cmdAnalysisTrace(inv: Invocation, io: CliIO): Promise<number> {
  const client = analyses(clientConfig(inv));
  const json = inv.flags.json === true;
  // One read answers everything after --since — the feed has no server-side
  // paging or filters, so there is nothing here for --type/--grep/--tail to
  // ride (client-side filtering would be opinion, not wire).
  const since = inv.flags.since as number | undefined;
  const transcript = await client.transcript(
    inv.positionals[0],
    since !== undefined ? { since } : undefined
  );
  for (const event of transcript.events) {
    io.out(json ? JSON.stringify(event) : traceEventLine(event));
  }
  if (!json && transcript.events.length === 0) io.out("No trace events.");
  return 0;
}

/**
 * The five artifact names `analysis download --stream` accepts: the verdict
 * document and the parsed transcript (each with its own richer verb), plus
 * the SDK's own stored-selector list — no second copy of that vocabulary.
 * `verifier`/`trace-atif`/`trajectory` are deliberately absent: an analysis
 * never has them, and the server refuses them typed at its own door.
 */
const ANALYSIS_STREAM_ARTIFACTS = [
  "analysis",
  "trace-parsed",
  ...ANALYSIS_ARTIFACT_STREAMS,
] as const;
type AnalysisStreamArtifact = (typeof ANALYSIS_STREAM_ARTIFACTS)[number];

async function cmdAnalysisDownload(inv: Invocation, io: CliIO): Promise<number> {
  const client = analyses(clientConfig(inv));
  const analysisId = inv.positionals[0];
  const json = inv.flags.json === true;
  const stream = inv.flags.stream as string | undefined;

  // The trial-download law verbatim: --stream prints to stdout, -o/--overwrite
  // save to disk, mixing them is a usage error; --since pages only the parsed
  // events, so anywhere else it would be an accepted-but-dead flag.
  if (stream !== undefined && (inv.flags["output-dir"] !== undefined || inv.flags.overwrite === true)) {
    throw new CliUsageError('"analysis download" takes EITHER --stream OR -o/--overwrite, not both');
  }
  if (
    (stream === undefined || stream !== "trace-parsed") &&
    inv.flags.since !== undefined
  ) {
    throw new CliUsageError("--since pages the parsed events; it applies only to --stream trace-parsed");
  }

  if (stream !== undefined) {
    if (!ANALYSIS_STREAM_ARTIFACTS.includes(stream as AnalysisStreamArtifact)) {
      throw new CliUsageError(`--stream must be one of: ${ANALYSIS_STREAM_ARTIFACTS.join(", ")}`);
    }
    if (stream === "analysis") {
      // The verdict document itself — the same object the feed's
      // &format=log form downloads under Harbor's analysis.json name.
      // --json keeps the wire's {analysis} envelope, like {log} below.
      const analysis = await client.get(analysisId);
      io.out(json ? JSON.stringify({ analysis }) : JSON.stringify(analysis, null, 2));
      return 0;
    }
    if (stream === "trace-parsed") {
      const since = inv.flags.since as number | undefined;
      const transcript = await client.transcript(
        analysisId,
        since !== undefined ? { since } : undefined
      );
      for (const event of transcript.events) {
        io.out(json ? JSON.stringify(event) : traceEventLine(event));
      }
      if (!json && transcript.events.length === 0) io.out("No trace events.");
      return 0;
    }
    if (stream === "agent-home") {
      const files = await client.artifact(analysisId, stream);
      if (files === null) {
        io.out(json ? JSON.stringify({ files: null }) : `No ${stream} content was stored for this analysis.`);
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
    const log = await client.artifact(
      analysisId,
      stream as Exclude<AnalysisArtifactStream, "agent-home">
    );
    if (log === null) {
      io.out(json ? JSON.stringify({ log: null }) : `No ${stream} log was stored for this analysis.`);
      return 0;
    }
    io.out(json ? JSON.stringify({ log }) : log);
    return 0;
  }

  // Save mode: the run as the analysis tree under <output-dir>/<analysis-id>/
  // — analysis.json at the run's root, the analyzer's streams and home under
  // agent/, plus evolve.json (the platform record: the analyzed trial/job/
  // task, the analyzer's box, its meter). The assembly is the SDK's
  // (assembleAnalysisTree); absent artifacts are absent files.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const targetDir = join((inv.flags["output-dir"] as string | undefined) ?? "analyses", analysisId);
  if (existsSync(targetDir) && inv.flags.overwrite !== true) {
    throw new Error(`${targetDir} already exists (pass --overwrite to replace it)`);
  }
  // The verdict resolves FIRST: its door refuses a non-analysis id typed (a
  // trial id answers "analysis.json belongs to an analysis run"), so the
  // wrong species dies before any artifact byte is fetched.
  const analysis = await client.get(analysisId);
  const files = assembleAnalysisTree({
    analysis,
    transcript: await client.transcript(analysisId),
    stdout: await client.artifact(analysisId, "trace-stdout"),
    stderr: await client.artifact(analysisId, "trace-stderr"),
    home: await client.artifact(analysisId, "agent-home"),
    userId: await callerUserId(inv),
  });
  await mkdir(targetDir, { recursive: true });
  const saved: string[] = [];
  for (const path of Object.keys(files).sort()) {
    const target = join(targetDir, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, files[path]);
    saved.push(path);
    if (!json) io.out(path);
  }
  if (json) {
    io.out(JSON.stringify({ path: targetDir, saved }));
  } else {
    io.out(`Saved ${targetDir}`);
  }
  return 0;
}

/**
 * The `source:` line(s) of `dataset show`, one reading per publish kind. The
 * locator is printed in the spelling `dataset publish` takes back — the
 * repository @ ref for `--git`/`--ref`, the url for `--from <url>`,
 * `hub:org/name[@ref]` for `--from hub:…` — and the identity shortened: a
 * commit to 12 hex, bare; a digest in `fmtDigestShort`'s spelling, so it
 * never reads as a commit.
 */
function versionSourceLines(source: DatasetVersionSource): string[] {
  switch (source.kind) {
    case "git": {
      const refPart = source.ref === source.commit ? "" : ` @ ${source.ref}`;
      return [
        `source: ${source.git_url ?? "?"}${refPart} (commit ${source.commit.slice(0, 12)})`,
        ...(source.path ? [`  subfolder: ${source.path}`] : []),
      ];
    }
    case "archive":
      return [`source: uploaded archive (${fmtDigestShort(source.digest)})`];
    case "archive_url":
      return [`source: ${source.archive_url} (${fmtDigestShort(source.digest)})`];
    case "hub_package":
      return [`source: hub:${source.hub_package} (${fmtDigestShort(source.digest)})`];
  }
}

/** The versions table's SOURCE cell: a git version's commit (12 hex), any other kind's digest (`fmtDigestShort`). */
function versionSourceCell(source: DatasetVersionSource): string {
  return source.kind === "git" ? source.commit.slice(0, 12) : fmtDigestShort(source.digest);
}

function datasetDetailLines(b: Dataset): string[] {
  const lines = table([
    ["name", b.name],
    ["title", b.title ?? "-"],
    ["description", b.description ?? "-"],
    ["active version", b.active_version?.version ?? "-"],
  ]);
  // PROVENANCE: what the SHOWN version was built from, one line per publish
  // kind (versionSourceLines). The selected version's own `source` wins:
  // `dataset show name@version` must say what THAT version imported even
  // when its build FAILED and it can never activate — exactly the moment a
  // user needs the resolved sha or digest. `upstream` (the active version's
  // git provenance) is the fallback for a server that predates per-version
  // `source`. Quiet block, like the manifest below: a dataset that recorded
  // no source prints nothing.
  const shown = b.selected_version?.source ?? b.active_version?.source ?? null;
  if (shown) {
    lines.push(...versionSourceLines(shown));
  } else if (b.upstream) {
    const u = b.upstream;
    const refPart = u.ref === u.current_commit ? "" : ` @ ${u.ref}`;
    lines.push(`source: ${u.git_url ?? "?"}${refPart} (commit ${u.current_commit.slice(0, 12)})`);
    if (u.path) lines.push(`  subfolder: ${u.path}`);
  }
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
    // The SOURCE column appears when some version carries provenance, and
    // shows EVERY version's resolved identity — a commit for a git version, a
    // digest for the others (versionSourceCell). A FAILED version can never
    // activate, and this column is where its imported bytes stay observable.
    const anySource = b.versions.some((v) => v.source != null);
    // The FAILED column appears only when some version lost tasks to its
    // build (partial-publish model) — a fully built catalog keeps its exact
    // table. TASKS stays the READY (runnable) count.
    const anyFailed = b.versions.some((v) => v.n_failed_tasks > 0);
    const rows = [
      ["VERSION", "STATE", "TASKS", ...(anyFailed ? ["FAILED"] : []), "CREATED", ...(anySource ? ["SOURCE"] : [])],
    ];
    for (const v of b.versions) {
      rows.push([
        v.version,
        v.state,
        String(v.task_count),
        ...(anyFailed ? [v.n_failed_tasks > 0 ? String(v.n_failed_tasks) : "-"] : []),
        v.created_at ?? "-",
        ...(anySource ? [v.source ? versionSourceCell(v.source) : "-"] : []),
      ]);
    }
    lines.push(...table(rows));
  }
  if (b.tasks && b.tasks.items.length > 0) {
    lines.push("", `Tasks (version ${b.selected_version?.version ?? "?"}):`);
    // The GPU column appears only when some listed task declares GPUs — a
    // CPU-only dataset (the overwhelmingly common case) keeps its exact table.
    const anyGpu = b.tasks.items.some((t) => (t.gpus ?? 0) > 0);
    // The NOTES column appears only when some listed task carries a typed
    // note (a recorded degrade — e.g. tests_dockerfile_not_built); the
    // sentence behind each code prints once below the table.
    const anyNotes = b.tasks.items.some((t) => (t.notes ?? []).length > 0);
    const rows = [
      ["TASK", "AGENT TIMEOUT", "VERIFIER TIMEOUT", ...(anyGpu ? ["GPU"] : []), "PROVIDERS", ...(anyNotes ? ["NOTES"] : [])],
    ];
    for (const t of b.tasks.items) {
      rows.push([
        t.task_name,
        `${t.agent_timeout_sec}s`,
        `${t.verifier_timeout_sec}s`,
        ...(anyGpu ? [fmtGpu(t) ?? "-"] : []),
        fmtProviders(t.providers),
        ...(anyNotes ? [(t.notes ?? []).map((n) => n.code).join(", ") || "-"] : []),
      ]);
    }
    lines.push(...table(rows));
    if (anyNotes) {
      // One line per distinct note sentence, with the tasks it applies to —
      // the platform's own words, never paraphrased here.
      const byMessage = new Map<string, { code: string; tasks: string[] }>();
      for (const t of b.tasks.items) {
        for (const note of t.notes ?? []) {
          const entry = byMessage.get(note.message) ?? { code: note.code, tasks: [] };
          entry.tasks.push(t.task_name);
          byMessage.set(note.message, entry);
        }
      }
      lines.push("", "Task notes:");
      for (const [message, entry] of byMessage) {
        lines.push(`  ${entry.code} (${entry.tasks.length} task${entry.tasks.length === 1 ? "" : "s"}): ${message}`);
      }
    }
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
  // FAILED TASKS of the shown version (partial-publish model): every name
  // with its typed reason — the tasks a whole-dataset job will NOT run.
  // Quiet block on a fully built version. The count line uses the version's
  // exact n_failed_tasks; the list itself is capped at the task page limit.
  lines.push(...failedTaskLines(b));
  return lines;
}

/**
 * The failed-tasks block of `dataset show` — the READ of the partial-publish
 * model's per-task outcomes. One line per failed task: name, typed reason
 * (code + step), and the failure sentence. The failing-step excerpt and the
 * full build-log pointer live on the per-task build route
 * (datasets().getTaskBuild()); fixing a task is a re-publish (immutable
 * versions), and the trailing line says so.
 */
function failedTaskLines(b: Dataset): string[] {
  const failed: DatasetFailedTask[] = b.failed_tasks ?? [];
  const version = b.selected_version ?? b.active_version ?? null;
  const exactCount = version?.n_failed_tasks ?? failed.length;
  if (failed.length === 0 && exactCount === 0) return [];
  const lines: string[] = [
    "",
    `Failed tasks (version ${version?.version ?? "?"}) — not runnable in this version:`,
  ];
  const rows: string[][] = [];
  for (const entry of failed) {
    rows.push([
      `  ${entry.task_name}`,
      `${entry.failure.code} (${entry.failure.step}): ${entry.failure.message}`,
    ]);
  }
  lines.push(...table(rows));
  if (exactCount > failed.length) {
    lines.push(`  … ${exactCount - failed.length} more (${exactCount} failed in total)`);
  }
  lines.push("  Fix: re-publish a new version — versions are immutable.");
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
    // The suggested command must pass a PIN — the server refuses branch names
    // (unpinned_git_ref) — so it names the observed commit, not the moving
    // ref. latest_commit is non-null whenever moved is true; the fallback is
    // for a server that predates that invariant. git_url rides the upstream
    // field since git-pin-provenance, so the command is complete as printed.
    const pin = item.upstream.latest_commit ?? item.upstream.ref;
    const url = item.upstream.git_url ?? "<url>";
    const path = item.upstream.path ? ` --path ${item.upstream.path}` : "";
    lines.push(
      `${item.name}${at} · upstream ${item.upstream.ref} moved — ` +
        `run: evolve dataset publish --name ${item.name} --version <new-version> ` +
        `--git ${url} --ref ${pin}${path}`
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

/**
 * Render one pre-flight answer for humans: the refusals with the importer's
 * own sentences, provider notes for tasks that cannot run (or only degrade)
 * somewhere, and the honesty line naming what only the real import checks.
 */
function preflightLines(answer: DatasetPreflight): string[] {
  const lines: string[] = [
    `Pre-flight (importer ${answer.importer_version}): ${answer.tasks_total} task${answer.tasks_total === 1 ? "" : "s"} — ` +
      `${answer.tasks_ok} ok, ${answer.tasks_refused} refused`,
  ];
  if (answer.manifest !== null && answer.manifest.ok === false) {
    lines.push(`  dataset.toml REFUSED: ${answer.manifest.reason}`);
  }
  for (const task of answer.tasks) {
    if (!task.ok) {
      lines.push(`  ${task.name} REFUSED: ${task.reason}`);
      continue;
    }
    // Provider notes only where a provider is not plainly ok — quiet tasks
    // stay quiet.
    const notes = Object.entries(task.providers ?? {})
      .filter(([, verdict]) => verdict.ok !== true || "degrades_to" in verdict)
      .map(([provider, verdict]) =>
        verdict.ok
          ? `${provider}: runs via ${(verdict as { degrades_to?: string }).degrades_to}`
          : `${provider}: ${(verdict as { reason?: string }).reason}`
      );
    if (notes.length > 0) lines.push(`  ${task.name}: ${notes.join(" · ")}`);
    // Typed task notes the toml decides (recorded degrades, e.g. a
    // tests/Dockerfile the verifier will not build) — the platform's own
    // sentence, one line each.
    for (const note of task.notes ?? []) {
      lines.push(`  ${task.name} NOTE ${note.code}: ${note.message}`);
    }
  }
  lines.push(
    `Checked from task.toml alone; the import also checks: ${answer.deferred.map((d) => d.name).join(", ")}.`
  );
  return lines;
}

async function cmdDatasetCheck(inv: Invocation, io: CliIO): Promise<number> {
  const client = datasets(clientConfig(inv));
  const answer = await client.preflight({ source: { directory: inv.positionals[0] } });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(answer));
  } else {
    for (const line of preflightLines(answer)) io.out(line);
  }
  // A check that FOUND refusals succeeded as a check but the corpus is not
  // publishable as-is — exit 1, the linter convention, so scripts can gate on
  // it. A refused manifest is the same outcome.
  const manifestRefused = answer.manifest !== null && answer.manifest.ok === false;
  return answer.tasks_refused > 0 || manifestRefused ? 1 : 0;
}

async function cmdDatasetPublish(inv: Invocation, io: CliIO): Promise<number> {
  const json = inv.flags.json === true;
  const client = datasets(clientConfig(inv));
  const input = buildPublishInput(inv);
  // THE PRE-FLIGHT, automatic for a directory source: the metadata files
  // (kilobytes) go first, and refusals are printed BEFORE the corpus is
  // tarred and uploaded — the importer's own sentences, from the same
  // guards. --skip-preflight is the escape hatch; a git source has nothing
  // local to check (the server clones it after the 202) and skips naturally.
  if (input.source.directory !== undefined && inv.flags["skip-preflight"] !== true) {
    let answer: DatasetPreflight | null = null;
    try {
      answer = await client.preflight({ source: { directory: input.source.directory } });
    } catch (error) {
      // An older server without the door keeps publishing exactly as before
      // — loudly, never silently.
      if (error instanceof EvolveApiError && error.status === 404) {
        io.err("Pre-flight unavailable on this server — publishing without it.");
      } else {
        throw error;
      }
    }
    if (answer !== null) {
      const manifestRefused = answer.manifest !== null && answer.manifest.ok === false;
      if (answer.tasks_refused > 0 || manifestRefused) {
        if (json) {
          io.out(JSON.stringify({ kind: "preflight.refused", preflight: answer }));
        } else {
          for (const line of preflightLines(answer)) io.out(line);
          io.out("");
          io.out(
            "Nothing was uploaded. Fix the refused tasks, or pass --skip-preflight to publish anyway " +
              "(a refused task then lands FAILED at import)."
          );
        }
        return 1;
      }
      if (json) {
        // NDJSON is reserved for --watch streams (the header's law): there
        // the passing pre-flight is one event among the others. Non-watch
        // --json stays ONE parseable document — the import the publish
        // answers below — so JSON.parse(stdout) always works.
        if (inv.flags.watch === true) {
          io.out(JSON.stringify({ kind: "preflight.ok", preflight: answer }));
        }
      } else {
        for (const line of preflightLines(answer)) io.out(line);
      }
    }
  }
  // Register-first (the resumable chunked door): the session open pre-creates
  // the import before the first byte moves, and this prints its id so the
  // transfer is re-attachable from the very start — this terminal dying, or
  // another machine entirely: `evolve dataset watch <id>`. Non-watch --json
  // stays ONE parseable document (the header's law), so the event rides
  // NDJSON only under --watch; human mode prints the line either way.
  const onRegistered = (importId: string) => {
    if (json) {
      if (inv.flags.watch === true) {
        io.out(JSON.stringify({ kind: "import.registered", import_id: importId }));
      }
      return;
    }
    io.out(`Registered import ${importId} — re-attach anytime with: evolve dataset watch ${importId}`);
  };
  // Upload progress renders CLIENT-SIDE from the stream (the SDK's own byte
  // count — flushed bytes on the single-request door, acknowledged chunks
  // on the chunked one; no server call) — ONE counter, one cadence, two
  // renderings: a line per 10% step, so a multi-GB corpus shows life
  // without per-chunk spam. Human mode prints `upload M/N (P%)`; `--watch
  // --json` prints the same step as an `upload.progress` event
  // {sent_bytes, total_bytes, elapsed_sec} — the transfer is part of the
  // stream, so a piped consumer is never blind before `import.created` (an
  // 8 GB publish printed one line, then nothing for 20 minutes, 2026-09-01;
  // owner ruling 2026-09-02). elapsed_sec counts from the
  // moment the corpus was handed to the SDK — packing and hashing included
  // — the same seconds the caller has been waiting. Harbor renders its
  // uploads with the same M-of-N + elapsed columns in a rich Live display
  // and has no machine-readable stream (REFERENCES/Harbor
  // src/harbor/cli/upload.py:123-135, 152-159): a line-based CLI keeps the
  // counts and drops the animation, and the NDJSON event is the recorded
  // deviation — `--json` on every verb is this platform's law. Non-watch
  // --json wires no counter at all: ONE parseable document.
  const uploadStartedAt = Date.now();
  let lastUploadStep = -1;
  const onUploadProgress = (sentBytes: number, totalBytes: number) => {
    const step = totalBytes > 0 ? Math.floor((sentBytes / totalBytes) * 10) : 10;
    if (step <= lastUploadStep) return;
    lastUploadStep = step;
    if (json) {
      io.out(
        JSON.stringify({
          kind: "upload.progress",
          sent_bytes: sentBytes,
          total_bytes: totalBytes,
          elapsed_sec: (Date.now() - uploadStartedAt) / 1000,
        })
      );
      return;
    }
    io.out(`upload ${fmtBytes(sentBytes)}/${fmtBytes(totalBytes)} (${Math.min(step * 10, 100)}%)`);
  };
  const created = await client.publish(input, {
    onRegistered,
    ...(json && inv.flags.watch !== true ? {} : { onUploadProgress }),
  });
  if (inv.flags.watch !== true) {
    if (json) {
      io.out(JSON.stringify(created));
    } else {
      for (const line of importLines(created)) io.out(line);
      io.out("");
      // Version state (IMPORTING → BUILDING → READY/FAILED) lives on the dataset body.
      // `created.name`, not the flag: a manifest-derived publish had no --name,
      // and the 202 echoes the name the server actually chose.
      io.out(`Follow it with: evolve dataset show ${created.name}`);
    }
    return 0;
  }

  return followImport(client, created, io, json, "created");
}

/**
 * THE ONE RENDERING HOME for following a publish to its settled end — the
 * same stream whether the follower was there from the 202 (`dataset publish
 * --watch`, opening kind `import.created`) or re-attached later (`dataset
 * watch`, opening kind `import.attached` — after the CLI exited, or from
 * another machine). Everything after the opening line is byte-identical
 * between the two, which is the point: a re-attach is not a second renderer
 * that can drift.
 *
 * The follow runs to the publish's SETTLED end: the version READY (at least
 * one task built — the partial-publish model; providers build their boot
 * artifacts lazily at the first trial — and, on an owner dataset, already
 * ACTIVE) or FAILED. COMPLETED means READY under build-then-READY; the
 * SDK's settle phase adds one confirming read (and covers a mid-deploy
 * older server), and the exit code is the settled outcome. --json is NDJSON
 * (the header's law): `import.created|attached`, then `import.status` /
 * `import.progress` / `import.version` / `task.failed` events, then
 * `import.final`.
 */
async function followImport(
  client: ReturnType<typeof datasets>,
  imported: DatasetImport,
  io: CliIO,
  json: boolean,
  opening: "created" | "attached",
): Promise<number> {
  if (json) {
    io.out(JSON.stringify({ kind: `import.${opening}`, datasetImport: imported }));
  } else {
    io.out(
      opening === "created"
        ? `Publish ${imported.id} (${imported.name}) ${imported.status} — watching…`
        : `Import ${imported.id} (${imported.name}@${imported.version}) ${statusWithReceiving(imported)} — watching…`
    );
  }

  let lastVersion: DatasetVersion | null = null;
  let lastDetail: Dataset | null = null;
  // Per-task outcomes (partial-publish model): the server records every
  // task's outcome in ONE transaction when the version settles, so the
  // detail's failed_tasks stays empty while the build runs and fills in one
  // burst at settle. Print each entry ONCE whenever it becomes readable,
  // instead of dying on the first failure.
  const seenFailedTasks = new Set<string>();
  const printNewFailedTasks = (dataset: Dataset) => {
    for (const entry of dataset.failed_tasks ?? []) {
      if (seenFailedTasks.has(entry.task_name)) continue;
      seenFailedTasks.add(entry.task_name);
      io.out(
        json
          ? JSON.stringify({ kind: "task.failed", task: entry })
          : failedTaskOutcomeLine(entry)
      );
    }
  };
  let final: DatasetImport;
  try {
    final = await client.watchImport(imported.id, {
      onStatus: (job) => {
        io.out(json ? JSON.stringify({ kind: "import.status", datasetImport: job }) : importStatusLine(job));
      },
      // Live phase progress, at the server's own write cadence (phase
      // boundaries + coarse intervals), under the same 429-tolerant poll.
      onProgress: (progress) => {
        io.out(
          json
            ? JSON.stringify({ kind: "import.progress", progress })
            : importProgressLine(progress)
        );
      },
      onVersion: (version, dataset) => {
        lastVersion = version;
        lastDetail = dataset;
        io.out(json ? JSON.stringify({ kind: "import.version", version }) : versionStatusLine(version));
        printNewFailedTasks(dataset);
      },
    });
  } catch (error) {
    // A typed settle refusal is an outcome, not a crash: nothing settled, so
    // the exit code is 1 and the named cause plus the follow-up command are
    // printed — never exit 0 on an unproven wait.
    if (error instanceof ImportSettleError) {
      // jsonErrorBody is the ONE home for the --json error body's shape.
      if (json) io.out(JSON.stringify({ error: jsonErrorBody(error) }));
      io.err(`Error: ${error.message}`);
      io.err(`Follow it with: evolve dataset show ${error.dataset}@${error.version}`);
      return 1;
    }
    throw error;
  }

  // THE SETTLED SUMMARY of a partial build ("built N of M tasks — K failed
  // to build"). A settled build that lost tasks earns ONE confirming detail
  // read to name any failure the watch's last poll missed. The server caps
  // the detail's failed_tasks at its own task-page maximum (500) regardless
  // of the page size a poll requested — never at the poll's page — so this
  // read gains nothing below that cap; the exact count is the version's own
  // n_failed_tasks either way.
  // (cast: TS narrows the closure-assigned variable to its initializer here)
  const settled = lastVersion as DatasetVersion | null;
  if (settled !== null && settled.n_failed_tasks > 0) {
    try {
      const fullDetail = await client.get(`${final.name}@${final.version}`);
      lastDetail = fullDetail;
      printNewFailedTasks(fullDetail);
    } catch {
      // The summary below still states the exact counts; the reasons stay
      // readable with `evolve dataset show name@version`.
    }
  }

  if (json) {
    io.out(JSON.stringify({ kind: "import.final", datasetImport: final }));
  } else {
    io.out("");
    for (const line of importLines(final)) io.out(line);
    // The settled progress record: wall-clock per phase, images
    // built/mirrored/banked, CodeBuild copy minutes (progressSettleLines).
    if (final.progress !== null) {
      for (const line of progressSettleLines(final.progress)) io.out(line);
    }
    if (lastVersion !== null) {
      for (const line of versionSettleLines(lastVersion, lastDetail)) io.out(line);
      for (const line of buildSettleSummaryLines(lastVersion, final)) io.out(line);
    }
  }
  return final.status === "FAILED" ? 1 : 0;
}

/**
 * `evolve dataset watch <name|import-id>` — re-attach to a publish and render
 * the same follow `dataset publish --watch` renders — everything from the 202
 * on (followImport, the one rendering home); the transfer's own
 * `upload.progress` lines belong to the publishing process. Works after the
 * CLI exited, and from another machine: the argument is tried as an import
 * id first (the more specific address), then as a dataset name — the newest
 * QUEUED/RUNNING import of that dataset. A terminal import id still renders
 * its settled block (exit 0/1 by outcome); a NAME with no live import
 * refuses instead, naming the newest settled import — attaching a "watch"
 * to something that finished long ago is more often a typo than an intent.
 */
async function cmdDatasetWatch(inv: Invocation, io: CliIO): Promise<number> {
  const json = inv.flags.json === true;
  const client = datasets(clientConfig(inv));
  const ref = inv.positionals[0];

  let imported: DatasetImport | null = null;
  try {
    imported = await client.getImport(ref);
  } catch (error) {
    // 404 = not an import id; fall through to the name resolution. Every
    // other failure (auth, rate limit, outage) is real and propagates.
    if (!(error instanceof EvolveApiError && error.status === 404)) throw error;
  }
  if (imported === null) {
    // Newest first, exactly the list route's order; one page is plenty —
    // a live import is always among a dataset's newest.
    const page = await client.listImports({ dataset: ref, limit: 50 });
    const items = page.items;
    imported =
      items.find((job) => job.status === "QUEUED" || job.status === "RUNNING") ?? null;
    if (imported === null) {
      const newest = items[0];
      const detail =
        newest !== undefined
          ? `its newest import ${newest.id} is ${newest.status} — see it with: evolve dataset show ${ref}`
          : "no import id and no dataset of yours carries that name";
      const message = `Nothing to watch for "${ref}": ${detail}`;
      if (json) io.out(JSON.stringify({ error: { code: "nothing_to_watch", message } }));
      io.err(`Error: ${message}`);
      return 1;
    }
  }

  try {
    return await followImport(client, imported, io, json, "attached");
  } catch (error) {
    // Register-first's one honest vanish: a pre-arrival import whose upload
    // session was abandoned or refused is DELETED (reaper pass 8d /
    // deleteUnarrivedImport), so a watcher's next poll 404s. That is an
    // outcome, not a crash — say what it means and exit 1.
    if (error instanceof EvolveApiError && error.code === "import_not_found") {
      const message =
        `Import ${imported.id} no longer exists — its upload was abandoned or ` +
        "refused before the corpus arrived, so the publish never happened. " +
        "Re-run the publish to start a new one.";
      if (json) io.out(JSON.stringify({ error: { code: "import_not_found", message } }));
      io.err(`Error: ${message}`);
      return 1;
    }
    throw error;
  }
}

/**
 * The partial-publish model's honest ending for `dataset publish --watch`:
 * "built N of M tasks — K failed to build", plus where the reasons live and
 * the one fix (a re-publish — versions are immutable). Empty on a fully
 * built version, so the common case keeps its exact output.
 */
export function buildSettleSummaryLines(version: DatasetVersion, job: DatasetImport): string[] {
  if (version.n_failed_tasks <= 0) return [];
  const total = version.task_count + version.n_failed_tasks;
  return [
    `built ${version.task_count} of ${total} tasks — ${version.n_failed_tasks} failed to build`,
    `Reasons: evolve dataset show ${job.name}@${job.version}`,
    "Fix: re-publish a new version — versions are immutable.",
  ];
}

/** One live line per failed task outcome during `dataset publish --watch`. */
export function failedTaskOutcomeLine(entry: DatasetFailedTask): string {
  return `task   ${entry.task_name} FAILED — ${entry.failure.code} (${entry.failure.step}): ${truncate(entry.failure.message, 140)}`;
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
  // A version still building refuses with 409 version_not_ready (the
  // generic typed-error path prints it): the publish lands READY and active
  // on its own, so this verb only re-points the default at a built version.
  const dataset: Dataset = await client.activate(name, version);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(dataset));
  } else {
    for (const line of datasetDetailLines(dataset)) io.out(line);
  }
  return 0;
}

/**
 * One uploaded skill — evolve skill upload / show. The record's two handles
 * are both printed: `ref` (upload:<id>, immutable) and the name (a moving
 * pointer this record currently answers for right after an upload).
 */
function skillLines(skill: SkillUpload): string[] {
  const rows: string[][] = [
    ["name", skill.name],
    ["id", skill.id],
    ["ref", skill.ref],
    ["digest", skill.digest],
    ["size", fmtBytes(skill.size_bytes)],
  ];
  if (skill.description) rows.push(["description", skill.description]);
  rows.push(["created", skill.created_at]);
  return table(rows);
}

async function cmdSkillList(inv: Invocation, io: CliIO): Promise<number> {
  if (columnsHelpRequested(inv, io, SKILL_COLUMNS)) return 0;
  const client = skills(clientConfig(inv));
  const page = await client.list(pageOptions(inv));
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.items.length === 0) {
    if (inv.flags.quiet !== true) io.out("No uploaded skills.");
    return 0;
  }
  renderList(inv, io, page.items, SKILL_COLUMNS, SKILL_DEFAULT_COLUMNS, (s) => s.id);
  if (page.nextCursor && io.tty === true && inv.flags.quiet !== true) {
    io.out(`\nMore: evolve skill list --cursor ${page.nextCursor}`);
  }
  return 0;
}

async function cmdSkillUpload(inv: Invocation, io: CliIO): Promise<number> {
  const client = skills(clientConfig(inv));
  // One folder, 1..n records: a root of skills uploads each child as its own
  // record (the server's discovery law). --json prints ONE document: the
  // record for a single skill, an array for a root.
  const uploaded = await client.upload(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(uploaded.length === 1 ? uploaded[0] : uploaded));
    return 0;
  }
  uploaded.forEach((skill, index) => {
    if (index > 0) io.out("");
    for (const line of skillLines(skill)) io.out(line);
  });
  io.out("");
  io.out(
    `Use it with: evolve run --skill name:${uploaded[0].name} (moving pointer) ` +
      `or --skill ${uploaded[0].ref} (this exact content)`
  );
  return 0;
}

async function cmdSkillShow(inv: Invocation, io: CliIO): Promise<number> {
  // The positional is a record id, or name:<skill-name> — the server resolves
  // the name pointer to its current record; the CLI passes the string through.
  const skill = await skills(clientConfig(inv)).get(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(skill));
    return 0;
  }
  for (const line of skillLines(skill)) io.out(line);
  if (skill.skill_md) {
    io.out("");
    io.out(skill.skill_md);
  }
  return 0;
}

async function cmdSkillDelete(inv: Invocation, io: CliIO): Promise<number> {
  // A skill_in_use refusal (a live job references this record) surfaces
  // VERBATIM through the standard error path — nothing rewrites the server's
  // sentence.
  const id = inv.positionals[0];
  await skills(clientConfig(inv)).delete(id);
  if (inv.flags.json === true) {
    io.out(JSON.stringify({ id, deleted: true }));
  } else {
    io.out(`Deleted skill ${id}`);
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

/** sessions() takes the same two knobs as the hosted clients, by its own names. */
function sessionsConfig(inv: Invocation): SessionsConfig {
  const config: SessionsConfig = {};
  if (typeof inv.flags["api-key"] === "string") config.apiKey = inv.flags["api-key"];
  if (typeof inv.flags["base-url"] === "string") config.dashboardUrl = inv.flags["base-url"];
  return config;
}

/**
 * A session's money cell — the one-home usage reading first (a live session's
 * floor stated as a floor), the eventually-consistent `cost` when no reading
 * exists, "-" when the meter never answered.
 */
function fmtSessionCost(s: SessionInfo): string {
  const reading = s.usage;
  if (reading && typeof reading.spent_usd === "number") {
    return reading.provisional
      ? `at least $${reading.spent_usd.toFixed(2)}`
      : `$${reading.spent_usd.toFixed(2)}`;
  }
  return fmtUsd(s.cost);
}

const SESSION_COLUMNS: ListColumn<SessionInfo>[] = [
  { key: "id", header: "ID", cell: (s) => s.id },
  { key: "tag", header: "TAG", cell: (s) => s.tag },
  { key: "agent", header: "AGENT", cell: (s) => s.agent },
  { key: "model", header: "MODEL", cell: (s) => s.model ?? "-" },
  { key: "provider", header: "PROVIDER", cell: (s) => s.provider },
  { key: "sandbox", header: "SANDBOX", cell: (s) => s.sandboxId ?? "-" },
  { key: "state", header: "STATE", cell: (s) => s.state },
  { key: "runtime", header: "RUNTIME", cell: (s) => s.runtimeStatus },
  { key: "cost", header: "COST", cell: fmtSessionCost },
  { key: "steps", header: "STEPS", cell: (s) => String(s.stepCount) },
  { key: "created", header: "CREATED", cell: (s) => s.createdAt },
  { key: "ended", header: "ENDED", cell: (s) => s.endedAt ?? "-" },
];
const SESSION_DEFAULT_COLUMNS = ["id", "tag", "agent", "model", "state", "cost", "created"];

function sessionDetailLines(s: SessionInfo): string[] {
  const rows: string[][] = [
    ["id", s.id],
    ["tag", s.tag],
    ["agent", s.agent],
    ["model", s.model ?? "-"],
    ["provider", s.provider],
    ["sandbox", s.sandboxId ?? "-"],
    ["state", s.state],
    ["runtime", s.runtimeStatus],
    ["cost", fmtSessionCost(s)],
  ];
  if (s.usage) {
    rows.push([
      "tokens",
      `${s.usage.input_tokens ?? "-"} in / ${s.usage.cached_input_tokens ?? "-"} cached / ` +
        `${s.usage.output_tokens ?? "-"} out` +
        (s.usage.provisional ? " (provisional)" : ""),
    ]);
  }
  rows.push(["steps", String(s.stepCount)]);
  if (s.toolStats && Object.keys(s.toolStats).length > 0) {
    rows.push([
      "tools",
      Object.entries(s.toolStats)
        .map(([name, count]) => `${name} ${count}`)
        .join(", "),
    ]);
  }
  rows.push(["created", s.createdAt]);
  rows.push(["ended", s.endedAt ?? "-"]);
  return table(rows);
}

async function cmdSessionList(inv: Invocation, io: CliIO): Promise<number> {
  if (columnsHelpRequested(inv, io, SESSION_COLUMNS)) return 0;
  const state = inv.flags.state === undefined ? undefined : String(inv.flags.state);
  if (state !== undefined && state !== "live" && state !== "ended") {
    throw new CliUsageError(`--state must be live or ended; got: ${state}`);
  }
  const client = sessions(sessionsConfig(inv));
  const page = await client.list({
    ...pageOptions(inv),
    ...(state !== undefined ? { state } : {}),
    ...(inv.flags.agent !== undefined ? { agent: String(inv.flags.agent) } : {}),
    ...(inv.flags["tag-prefix"] !== undefined ? { tagPrefix: String(inv.flags["tag-prefix"]) } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(page));
    return 0;
  }
  if (page.items.length === 0) {
    if (inv.flags.quiet !== true) io.out("No sessions.");
    return 0;
  }
  renderList(inv, io, page.items, SESSION_COLUMNS, SESSION_DEFAULT_COLUMNS, (s) => s.id);
  if (page.nextCursor && io.tty === true && inv.flags.quiet !== true) {
    io.out(`\nMore: evolve session list --cursor ${page.nextCursor}`);
  }
  return 0;
}

async function cmdSessionShow(inv: Invocation, io: CliIO): Promise<number> {
  const info = await sessions(sessionsConfig(inv)).get(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(info));
  } else {
    for (const line of sessionDetailLines(info)) io.out(line);
  }
  return 0;
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

// Harbor's `auth org list` columns are name, display name, role, joined
// (cli/auth.py `org_columns`); ours name the org by its slug and date it by
// the org's own creation — the wire carries no membership date.
const ORG_COLUMNS: ListColumn<Organization>[] = [
  { key: "slug", header: "SLUG", cell: (o) => o.slug },
  { key: "display_name", header: "DISPLAY NAME", cell: (o) => o.display_name },
  { key: "role", header: "ROLE", cell: (o) => o.role ?? "-" },
  { key: "personal", header: "PERSONAL", cell: (o) => (o.personal ? "yes" : "no") },
  { key: "created", header: "CREATED", cell: (o) => o.created_at },
];
const ORG_DEFAULT_COLUMNS = ["slug", "display_name", "role", "created"];

/**
 * Harbor's `--search` on `auth org list` (cli/auth.py:219-227): the list
 * endpoint takes no filter, so the CLI narrows the rows itself — a
 * case-insensitive substring match over slug (their `name`), display name
 * and role, before every output mode (table, -q and --json alike).
 */
function searchOrgs(rows: Organization[], search: string): Organization[] {
  const needle = search.toLowerCase();
  return rows.filter(
    (o) =>
      o.slug.toLowerCase().includes(needle) ||
      o.display_name.toLowerCase().includes(needle) ||
      (o.role ?? "").toLowerCase().includes(needle)
  );
}

async function cmdAuthOrgList(inv: Invocation, io: CliIO): Promise<number> {
  if (columnsHelpRequested(inv, io, ORG_COLUMNS)) return 0;
  const listed = await orgs(clientConfig(inv)).list();
  const rows =
    inv.flags.search !== undefined ? searchOrgs(listed, String(inv.flags.search)) : listed;
  if (inv.flags.json === true) {
    io.out(JSON.stringify(rows));
    return 0;
  }
  if (rows.length === 0) {
    if (inv.flags.quiet !== true) io.out("No organizations found.");
    return 0;
  }
  renderList(inv, io, rows, ORG_COLUMNS, ORG_DEFAULT_COLUMNS, (o) => o.slug);
  return 0;
}

/**
 * The org in depth: identity, then every ceiling as `used/limit` beside its
 * live count — except the three per-provider sandbox ceilings, printed alone:
 * the wire carries no per-organization sandbox count (`OrgUsage` is six counts).
 */
function orgDetailLines(org: OrganizationDetail): string[] {
  const { quota, usage } = org;
  // Spend and budget are ONE meter — the gateway's, on the UTC calendar
  // month — so the fraction is honest; a spend the platform holds no copy
  // of prints `unavailable`, never $0.00, and a held copy says how old it is.
  const spend = usage.month_spend_usd === null ? "unavailable" : fmtUsd(usage.month_spend_usd);
  const asOf = usage.month_spend_as_of === null ? "" : ` (as of ${usage.month_spend_as_of})`;
  const budget =
    quota.monthly_budget_usd === null
      ? `${spend} / no budget${asOf}`
      : `${spend} / ${fmtUsd(quota.monthly_budget_usd)}${asOf}`;
  const rows: string[][] = [
    ["slug", org.slug],
    ["display name", org.display_name],
    ["personal", org.personal ? "yes" : "no"],
    ["role", org.role ?? "-"],
    ["members", String(org.member_count)],
    ["created", org.created_at],
    ["concurrent trials", `${usage.in_flight_trials}/${quota.max_concurrent_trials}`],
    ["queued trials", `${usage.queued_trials}/${quota.max_queued_trials}`],
    ["concurrent imports", `${usage.in_flight_imports}/${quota.max_concurrent_imports}`],
    ["concurrent analyses", `${usage.in_flight_analyses}/${quota.max_concurrent_analyses}`],
    ["concurrent sessions", `${usage.active_sessions}/${quota.max_concurrent_sessions}`],
    ["e2b sandbox ceiling", String(quota.max_concurrent_sandboxes_e2b)],
    ["daytona sandbox ceiling", String(quota.max_concurrent_sandboxes_daytona)],
    ["modal sandbox ceiling", String(quota.max_concurrent_sandboxes_modal)],
    ["month spend", budget],
  ];
  return table(rows);
}

async function cmdAuthOrgShow(inv: Invocation, io: CliIO): Promise<number> {
  const org = await orgs(clientConfig(inv)).get(inv.positionals[0]);
  if (inv.flags.json === true) {
    io.out(JSON.stringify(org));
  } else {
    for (const line of orgDetailLines(org)) io.out(line);
  }
  return 0;
}

/**
 * The secrets verbs speak the managed-agents door (dashboard base URL), not
 * the hosted jobs client — same key, same host, its own client config shape.
 */
function secretsClientConfig(inv: Invocation): ManagedSecretsClientConfig {
  const config: ManagedSecretsClientConfig = {};
  if (typeof inv.flags["api-key"] === "string") config.apiKey = inv.flags["api-key"];
  if (typeof inv.flags["base-url"] === "string") config.dashboardUrl = inv.flags["base-url"];
  return config;
}

/**
 * The value channel of `secrets set`: --value, or piped stdin when the flag
 * is absent — piping keeps the value out of shell history and process lists.
 * One trailing newline is stripped (every `printf`-less `echo` adds one); an
 * interactive terminal with no --value is a usage error, never a hang.
 */
function readSecretValue(inv: Invocation): string {
  const flag = inv.flags.value;
  if (typeof flag === "string") {
    if (flag.length === 0) throw new CliUsageError("--value must not be empty");
    return flag;
  }
  if (process.stdin.isTTY) {
    throw new CliUsageError(
      "no value given: pass --value <value> or pipe the value on stdin " +
        '(e.g. printf %s "$TOKEN" | evolve secrets set NAME --delivery ...)'
    );
  }
  const piped = readFileSync(0, "utf8");
  const value = piped.endsWith("\r\n")
    ? piped.slice(0, -2)
    : piped.endsWith("\n")
      ? piped.slice(0, -1)
      : piped;
  if (value.length === 0) throw new CliUsageError("stdin carried no value");
  return value;
}

async function cmdSecretsSet(inv: Invocation, io: CliIO): Promise<number> {
  const name = inv.positionals[0];
  const delivery = inv.flags.delivery;
  if (delivery !== "brokered" && delivery !== "direct") {
    throw new CliUsageError("--delivery is required: 'brokered' or 'direct'");
  }
  const value = readSecretValue(inv);
  const client = managedSecrets(secretsClientConfig(inv));
  const result = await client.set({
    name,
    value,
    delivery,
    ...(typeof inv.flags.label === "string" ? { label: inv.flags.label } : {}),
    ...(inv.flags["allowed-host"] !== undefined
      ? { allowedHosts: inv.flags["allowed-host"] as string[] }
      : {}),
    ...(inv.flags["allowed-path-prefix"] !== undefined
      ? { allowedPathPrefixes: inv.flags["allowed-path-prefix"] as string[] }
      : {}),
    ...(inv.flags["allowed-method"] !== undefined
      ? { allowedMethods: inv.flags["allowed-method"] as string[] }
      : {}),
  });
  // The value is NEVER echoed — not on success, not in --json output (the
  // server's response carries metadata only).
  if (inv.flags.json === true) {
    io.out(JSON.stringify(result));
    return 0;
  }
  const secret = result.secret;
  io.out(
    `${result.status === "created" ? "Stored" : "Updated"} env secret ${secret.name} ` +
      `(label ${secret.label ?? "default"}, delivery ${secret.delivery ?? "brokered"})`
  );
  return 0;
}

async function cmdSecretsList(inv: Invocation, io: CliIO): Promise<number> {
  if (columnsHelpRequested(inv, io, SECRET_COLUMNS)) return 0;
  const client = managedSecrets(secretsClientConfig(inv));
  const secrets = await client.list();
  if (inv.flags.json === true) {
    io.out(JSON.stringify({ secrets }));
    return 0;
  }
  if (secrets.length === 0) {
    if (inv.flags.quiet !== true) io.out("No env secrets stored.");
    return 0;
  }
  renderList(inv, io, secrets, SECRET_COLUMNS, SECRET_DEFAULT_COLUMNS, (s) =>
    s.label && s.label !== "default" ? `${s.name}:${s.label}` : s.name
  );
  return 0;
}

async function cmdSecretsDelete(inv: Invocation, io: CliIO): Promise<number> {
  const name = inv.positionals[0];
  const client = managedSecrets(secretsClientConfig(inv));
  const result = await client.delete({
    name,
    ...(typeof inv.flags.label === "string" ? { label: inv.flags.label } : {}),
  });
  if (inv.flags.json === true) {
    io.out(JSON.stringify(result));
    return 0;
  }
  io.out(`Deleted env secret ${result.name} (label ${result.label})`);
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
  const resolved = resolveVerb(groupSpec, topic.slice(1));
  if (!resolved) return { text: groupHelp(group), code: 0 };
  return { text: commandHelp(`${group} ${resolved.verb}`, resolved.spec), code: 0 };
}

const HANDLERS: Record<string, (inv: Invocation, io: CliIO) => Promise<number>> = {
  // `run` and `job start` are one command reached by two names — same spec,
  // same handler — so neither can drift into a second implementation.
  run: cmdJobStart,
  analyze: cmdAnalyze,
  upload: cmdUpload,
  "job start": cmdJobStart,
  "job list": cmdJobList,
  "job show": cmdJobShow,
  "job trials": cmdJobTrials,
  "job tasks": cmdJobTasks,
  "job compare": cmdJobCompare,
  "job cancel": cmdJobCancel,
  "job delete": cmdJobDelete,
  "job stop": cmdJobStop,
  "job resume": cmdJobResume,
  "job retry": cmdJobRetry,
  "job regrade": cmdJobRegrade,
  "job download": cmdJobDownload,
  "job imports": cmdJobImports,
  "job import": cmdJobImport,
  "job grep": cmdJobGrep,
  "trial show": cmdTrialShow,
  "trial trace": cmdTrialTrace,
  "trial download": cmdTrialDownload,
  "trial retry": cmdTrialRetry,
  "trial regrade": cmdTrialRegrade,
  "trial stop": cmdTrialStop,
  "analysis list": cmdAnalysisList,
  "analysis show": cmdAnalysisShow,
  "analysis trace": cmdAnalysisTrace,
  "analysis download": cmdAnalysisDownload,
  "session list": cmdSessionList,
  "session show": cmdSessionShow,
  "dataset list": cmdDatasetList,
  "dataset show": cmdDatasetShow,
  "dataset check": cmdDatasetCheck,
  "dataset publish": cmdDatasetPublish,
  "dataset watch": cmdDatasetWatch,
  "dataset download": cmdDatasetDownload,
  "dataset activate": cmdDatasetActivate,
  "skill list": cmdSkillList,
  "skill upload": cmdSkillUpload,
  "skill show": cmdSkillShow,
  "skill delete": cmdSkillDelete,
  "agent list": cmdAgentList,
  "agent show": cmdAgentShow,
  "agent add": cmdAgentAdd,
  "agent remove": cmdAgentRemove,
  "auth status": cmdAuthStatus,
  "auth org list": cmdAuthOrgList,
  "auth org show": cmdAuthOrgShow,
  "secrets set": cmdSecretsSet,
  "secrets list": cmdSecretsList,
  "secrets delete": cmdSecretsDelete,
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
  // A settle refusal carries its own named cause — not an invented code, the
  // SDK's typed one (settle_timeout).
  if (error instanceof ImportSettleError) {
    return { code: error.code, message: error.message };
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
    if (error instanceof EvolveApiError && error.code === "quota_exceeded") {
      // Harbor's own rendering of the hosted quota refusal — `Launch quota
      // exceeded:` + the server's sentence, exit 2 (cli/hosted_jobs.py:
      // 615-617). Before the rate-limit arm: this 429 carries no
      // Retry-After, because the wait is not a known number.
      io.err(`Launch quota exceeded: ${error.message}`);
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
    // A job create that NAMED a task whose build FAILED refuses typed
    // (partial-publish model), and the refusal's details.failed_tasks quotes
    // every named task's own build failure — render each one, so the caller
    // reads the reason here instead of hunting for it.
    if (error instanceof EvolveApiError && error.code === "task_failed_to_build") {
      const details = (error.details ?? {}) as Record<string, unknown>;
      const failedTasks = Array.isArray(details.failed_tasks) ? details.failed_tasks : [];
      for (const entry of failedTasks as Record<string, unknown>[]) {
        if (!entry || typeof entry !== "object") continue;
        const failure = (entry.failure ?? {}) as Record<string, unknown>;
        const reason =
          typeof failure.message === "string" && failure.message
            ? `${failure.code ?? "?"} (${failure.step ?? "?"}): ${failure.message}`
            : "build failed (reason not recorded)";
        io.err(`  ${entry.task_name}: ${reason}`);
      }
      io.err("  Fix: re-publish a new version, or drop the failed task(s) from --include-task-name.");
      return 1;
    }
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
