#!/usr/bin/env tsx
/**
 * Unit Test: evolve CLI (src/cli/index.ts)
 *
 * The noun-verb grammar: group resolution (singular canonical, plural and
 * `ls` hidden aliases, `agents` reserved and refused by name), the first-class
 * top-level `run`, short flags, repeatables,
 * the -c config loader (JSON + real YAML via the yaml package, PyYAML's
 * readings pinned differentially) with flag-over-file merging,
 * --print-config, per-command help with a worked example, --version, the
 * shared list output precedence (--json / -q / TSV / TTY table, --columns,
 * --no-trunc, --no-headers), and one mocked end-to-end pass over every verb:
 * job start/--watch/list/show/trials/tasks/compare/cancel/resume/regrade/
 * download, trial show/download/regrade/stop, analysis show/trace/download,
 * dataset
 * list/show/publish/download/activate, agent list/show/add/remove, auth
 * status. Exit codes: 0/1/2 pinned throughout.
 *
 * Uses mock fetch to test without real network calls.
 *
 * Usage:
 *   npx tsx tests/unit/cli.test.ts
 */

// =============================================================================
// TEST HELPERS
// =============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (!match) {
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
  assert(match, message);
}

function assertThrowsUsage(fn: () => unknown, needle: string, message: string): void {
  let threw = false;
  try {
    fn();
  } catch (e: any) {
    threw = true;
    assert(e instanceof CliUsageError, `${message} — throws CliUsageError`);
    assert(e.message.includes(needle), `${message} — message mentions "${needle}"`);
  }
  assert(threw, `${message} — throws`);
}

// =============================================================================
// MOCK FETCH
// =============================================================================

const fetchCalls: { url: string; init?: RequestInit }[] = [];
interface MockResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** If set, response.body will be a ReadableStream of this string */
  streamBody?: string;
  /** If set, response.body streams these bytes (binary downloads). */
  bodyBytes?: Buffer;
}

let mockResponses: Map<string, MockResponse> = new Map();

function setMockResponse(urlPattern: string, response: MockResponse) {
  mockResponses.set(urlPattern, response);
}

function buildMockResponse(resp: MockResponse): Response {
  let body: ReadableStream | null = null;
  const streamSource =
    resp.streamBody != null ? Buffer.from(resp.streamBody, "utf-8") : resp.bodyBytes;
  if (streamSource != null) {
    const nodeStream = Readable.from(streamSource);
    body = Readable.toWeb(nodeStream) as ReadableStream;
  }
  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    statusText: resp.status < 300 ? "OK" : "Error",
    headers: new Headers(resp.headers || {}),
    json: async () => resp.body,
    text: async () => resp.streamBody ?? JSON.stringify(resp.body),
    body,
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;

function installMockFetch() {
  fetchCalls.length = 0;
  mockResponses = new Map();
  (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    fetchCalls.push({ url: urlStr, init });
    for (const [pattern, resp] of mockResponses) {
      if (urlStr.includes(pattern)) {
        return buildMockResponse(resp);
      }
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "not found",
      body: null,
    } as unknown as Response;
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// =============================================================================
// IMPORT (after mock setup)
// =============================================================================

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";

import {
  buildAgentInput,
  buildJobInput,
  buildPublishInput,
  CliUsageError,
  eventLine,
  importProgressLine,
  importStatusLine,
  progressSettleLines,
  TRIAL_COLUMNS,
  loadRubricFile,
  parseAgentKwargs,
  parseArgs,
  parseEnvPairs,
  parseInlineSecrets,
  parseSecretRefs,
  parseYamlConfig,
  runCli,
  trialDetailLines,
} from "../../src/cli/index.ts";
import type { CliIO } from "../../src/cli/index.ts";
import type { Trial } from "../../src/hosted/types.ts";

const BASE = "http://localhost:3000";

function captureIO(tty = false): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l), tty }, out, err };
}

const AUTH = ["--api-key", "test-key", "--base-url", BASE];

// The -c validation vocabulary reads out of the contract itself, and the
// contract lives in the private server repo — resolvable here through the
// same doors the CLI tries: EVOLVE_OPENAPI_SPEC_PATH, the staged package
// copy, the legacy repo-root copy. Without any of them the -c suites skip.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_AVAILABLE = [
  process.env.EVOLVE_OPENAPI_SPEC_PATH,
  join(PACKAGE_ROOT, "spec", "openapi.yaml"),
  join(PACKAGE_ROOT, "..", "..", "spec", "openapi.yaml"),
].some((candidate) => candidate !== undefined && existsSync(candidate));
const SPEC_SKIP_REASON =
  "SKIP: spec not present — gate runs in private CI or with EVOLVE_OPENAPI_SPEC_PATH";

// =============================================================================
// PARSING — grammar resolution
// =============================================================================

function testGrammarResolution() {
  console.log("\n--- parseArgs: noun-verb resolution and aliases ---");
  assertEqual(parseArgs(["job", "list"]).command, "job list", "noun verb resolves");
  assertEqual(parseArgs(["jobs", "list"]).command, "job list", "plural noun is a hidden alias");
  assertEqual(parseArgs(["job", "ls"]).command, "job list", "`ls` is a hidden alias of list");
  assertEqual(parseArgs(["run"]).command, "run", "`run` is a command in its own right, not rewritten to job start");
  assertEqual(
    parseArgs(["run", "-d", "deep-swe", "-a", "codex", "-m", "gpt-5.5"]).flags,
    { dataset: ["deep-swe"], agent: "codex", model: ["gpt-5.5"] },
    "`run` parses job start's flags"
  );
  assertEqual(
    parseArgs(["run", "-h"]),
    { command: "help", positionals: ["run"], flags: {} },
    "-h on run asks for run's own help page"
  );
  assertThrowsUsage(
    () => parseArgs(["agents", "list"]),
    "reserved for the managed-agents CLI",
    "`agents` is reserved, not a hidden plural alias of `agent`"
  );
  assertThrowsUsage(
    () => parseArgs(["agents"]),
    'use "evolve agent"',
    "the reserved word points at the command that does exist"
  );
  assertEqual(parseArgs(["agent", "list"]).command, "agent list", "the singular `agent` still resolves");
  assertEqual(parseArgs(["skill", "list"]).command, "skill list", "the skill noun resolves");
  assertEqual(parseArgs(["skills", "list"]).command, "skill list", "`skills` is a hidden plural alias of `skill`");
  assertEqual(parseArgs([]).command, "help", "bare invocation is help, not an error");
  assertEqual(parseArgs(["help"]).command, "help", "help command");
  assertEqual(parseArgs(["--version"]).command, "version", "--version resolves");
  assertEqual(parseArgs(["-v"]).command, "version", "-v resolves");
  assertEqual(
    parseArgs(["job"]),
    { command: "help", positionals: ["job"], flags: {} },
    "a bare group shows the group help (no_args_is_help)"
  );
  assertEqual(
    parseArgs(["job", "start", "-h"]),
    { command: "help", positionals: ["job", "start"], flags: {} },
    "-h on a command resolves to that command's help"
  );
  assertThrowsUsage(() => parseArgs(["frobnicate"]), "Unknown command", "unknown group");
  assertThrowsUsage(
    () => parseArgs(["job", "frobnicate"]),
    "supported:",
    "unknown verb names the supported ones"
  );
  assertThrowsUsage(() => parseArgs(["job", "--json"]), "requires a command", "group with only flags");
}

function testShortFlags() {
  console.log("\n--- parseArgs: short flags and the -l dual use ---");
  const inv = parseArgs([
    "job", "start",
    "-d", "deep-swe@1.1",
    "-a", "codex",
    "-m", "gpt-5.5",
    "-k", "2",
    "-n", "8",
    "-e", "daytona",
    "-i", "cache-*",
    "-x", "flaky-*",
    "-l", "5",
    "-q",
    "-y",
  ]);
  assertEqual(inv.command, "job start", "command resolved");
  assertEqual(inv.flags.dataset, ["deep-swe@1.1"], "-d is --dataset (repeatable)");
  assertEqual(inv.flags.agent, "codex", "-a is --agent");
  assertEqual(inv.flags.model, ["gpt-5.5"], "-m is --model (repeatable)");
  assertEqual(inv.flags["n-attempts"], 2, "-k is --n-attempts");
  assertEqual(inv.flags["n-concurrent"], 8, "-n is --n-concurrent");
  assertEqual(inv.flags.env, "daytona", "-e is --env, the sandbox provider");
  assertEqual(inv.flags["include-task-name"], ["cache-*"], "-i is --include-task-name");
  assertEqual(inv.flags["exclude-task-name"], ["flaky-*"], "-x is --exclude-task-name");
  assertEqual(inv.flags["n-tasks"], 5, "-l is --n-tasks ON job start");
  assertEqual(inv.flags.quiet, true, "-q parses");
  assertEqual(inv.flags.yes, true, "-y is accepted (and does nothing — no prompts exist)");

  const list = parseArgs(["job", "list", "-l", "20"]);
  assertEqual(list.flags.limit, 20, "-l is --limit ON list commands");

  const ae = parseArgs([
    "job", "start", "-d", "b", "-a", "codex", "-m", "m",
    "--ae", "A=1", "--ae", "B=2", "--ve", "C=3",
  ]);
  assertEqual(ae.flags["agent-env"], ["A=1", "B=2"], "--ae is the alias of --agent-env, repeatable");
  assertEqual(ae.flags["verifier-env"], ["C=3"], "--ve is the alias of --verifier-env");

  assertEqual(
    parseArgs(["job", "start", "-d=deep-swe", "-a=codex", "-m=m"]).flags.dataset,
    ["deep-swe"],
    "-d=value inline form works"
  );
  assertThrowsUsage(() => parseArgs(["job", "list", "-z"]), "Unknown option", "unknown short flag");
  assertThrowsUsage(() => parseArgs(["job", "list", "--frob", "x"]), "Unknown option", "unknown long flag");
  assertThrowsUsage(() => parseArgs(["job", "list", "--cursor"]), "requires a value", "flag missing its value");

  // A value may START with '-'. Only a token that IS a flag of the command is
  // refused — consuming it silently would swallow the caller's next option —
  // and the refusal offers the --name=value spelling for the collision case.
  assertEqual(
    parseArgs(["job", "start", "-d", "b", "-a", "a", "-m", "m", "-x", "-*"]).flags["exclude-task-name"],
    ["-*"],
    "a glob starting with '-' is a value, not a missing-value error"
  );
  assertEqual(
    parseArgs(["job", "list", "--cursor", "-abc123"]).flags.cursor,
    "-abc123",
    "a cursor starting with '-' is a value when it spells no known flag"
  );
  assertEqual(parseArgs(["job", "list", "-l", "-5"]).flags.limit, -5, "a negative number stays a value");
  assertThrowsUsage(
    () => parseArgs(["job", "list", "--cursor", "--json"]),
    "requires a value",
    "a KNOWN flag after a value flag still refuses"
  );
  assertThrowsUsage(
    () => parseArgs(["job", "list", "--cursor", "--json"]),
    "--cursor=--json",
    "and the refusal shows the = spelling that states the intent"
  );
  assertThrowsUsage(
    () => parseArgs(["job", "start", "-k", "lots", "-d", "b", "-a", "a", "-m", "m"]),
    "expects a number",
    "non-numeric number flag"
  );
  assertThrowsUsage(() => parseArgs(["job", "show"]), "<id>", "job show without id");
  assertThrowsUsage(() => parseArgs(["job", "cancel", "a", "b"]), "unexpected argument", "extra positional");
  assertThrowsUsage(() => parseArgs(["job", "compare", "only-one"]), "<id> <id>", "compare needs at least 2 ids");
}

// =============================================================================
// buildJobInput — flags, arms, config merge
// =============================================================================

function testBuildJobInputFlags() {
  console.log("\n--- buildJobInput: -d/-a/-m/-i/-x/-l/--effort/--ae/--ve ---");
  const inv = parseArgs([
    "job", "start",
    "-d", "deep-swe@1.1",
    "-d", "frontier-swe",
    "-i", "cache-*",
    "-x", "flaky-*",
    "-l", "5",
    "-a", "codex@2.0",
    "-m", "gpt-5.5",
    "-m", "gpt-5.5-mini",
    "--effort", "low",
    "-k", "2",
    "-n", "8",
    "--max-trial-spend", "25",
    "-e", "daytona",
    "--ae", "A=1",
    "--ve", "B=2",
    "--job-name", "sweep-7",
  ]);
  const input = buildJobInput(inv);
  assertEqual(
    input,
    {
      job_name: "sweep-7",
      datasets: [
        { name: "deep-swe", version: "1.1", task_names: ["cache-*"], exclude_task_names: ["flaky-*"], n_tasks: 5 },
        { name: "frontier-swe", task_names: ["cache-*"], exclude_task_names: ["flaky-*"], n_tasks: 5 },
      ],
      agents: [
        // --effort is stamped on EVERY arm: the server owns the per-agent
        // refusal, and the CLI never edits the list to dodge one.
        { name: "codex", model_name: "gpt-5.5", version: "2.0", reasoning_effort: "low" },
        { name: "codex", model_name: "gpt-5.5-mini", version: "2.0", reasoning_effort: "low" },
      ],
      n_attempts: 2,
      n_concurrent_trials: 8,
      max_trial_spend_usd: 25,
      sandbox_provider: "daytona",
      agent_env: { A: "1" },
      verifier_env: { B: "2" },
    },
    "full body: -d repeatable, filters stamped on EVERY selector, one arm per -m, effort on every arm"
  );
  assertEqual(
    Object.keys(input),
    [
      "job_name",
      "datasets",
      "agents",
      "n_attempts",
      "n_concurrent_trials",
      "max_trial_spend_usd",
      "sandbox_provider",
      "agent_env",
      "verifier_env",
    ],
    "body keys follow the contract field order"
  );

  const minimal = buildJobInput(parseArgs(["job", "start", "-d", "deep-swe", "-a", "codex", "-m", "m"]));
  assertEqual(
    minimal,
    { datasets: [{ name: "deep-swe" }], agents: [{ name: "codex", model_name: "m" }] },
    "minimal body: bare name selector, no optional keys"
  );
  assert(!("max_trial_spend_usd" in minimal), "no cap key when --max-trial-spend omitted (the server's default is the ask)");
  assert(!("agent_env" in minimal), "no env key when --ae omitted");

  assertThrowsUsage(
    () => buildJobInput(parseArgs(["job", "start", "-a", "codex", "-m", "m"])),
    "--dataset",
    "missing -d"
  );
  assertThrowsUsage(
    () => buildJobInput(parseArgs(["job", "start", "-d", "b", "-a", "codex"])),
    "--model",
    "-a without -m (the server applies no model default)"
  );
  assertThrowsUsage(
    () => buildJobInput(parseArgs(["job", "start", "-d", "b", "-m", "m"])),
    "--agent",
    "-m without -a"
  );
  assertThrowsUsage(
    () => buildJobInput(parseArgs(["job", "start", "-d", "b@", "-a", "a", "-m", "m"])),
    "name@version",
    "malformed dataset ref"
  );
  assertThrowsUsage(() => parseEnvPairs(["NOEQUALS"], "--agent-env"), "KEY=VALUE", "malformed env pair");
}

function testSecretRefs() {
  console.log("\n--- --secret NAME[@LABEL][=ENVNAME] -> JobCreate.secrets ---");
  assertEqual(
    parseSecretRefs(["GITHUB_TOKEN"]),
    [{ name: "GITHUB_TOKEN" }],
    "bare NAME is a ref with no label and no rename"
  );
  assertEqual(
    parseSecretRefs(["API_KEY@staging"]),
    [{ name: "API_KEY", label: "staging" }],
    "@LABEL picks a labeled row"
  );
  assertEqual(
    parseSecretRefs(["API_KEY=SERVICE_KEY"]),
    [{ name: "API_KEY", as: "SERVICE_KEY" }],
    "=ENVNAME renames the env var in the sandbox"
  );
  assertEqual(
    parseSecretRefs(["API_KEY@prod=SERVICE_KEY"]),
    [{ name: "API_KEY", label: "prod", as: "SERVICE_KEY" }],
    "full grammar: NAME@LABEL=ENVNAME"
  );
  assertThrowsUsage(() => parseSecretRefs(["@nolabel"]), "NAME[@LABEL][=ENVNAME]", "empty name");
  assertThrowsUsage(() => parseSecretRefs(["NAME@"]), "NAME[@LABEL][=ENVNAME]", "empty label");
  assertThrowsUsage(() => parseSecretRefs(["NAME="]), "NAME[@LABEL][=ENVNAME]", "empty env name");

  const built = buildJobInput(
    parseArgs([
      "job", "start",
      "-d", "deep-swe",
      "-a", "codex",
      "-m", "m",
      "--secret", "GITHUB_TOKEN",
      "--secret", "API_KEY@prod=SERVICE_KEY",
    ])
  );
  assertEqual(
    built.secrets,
    [{ name: "GITHUB_TOKEN" }, { name: "API_KEY", label: "prod", as: "SERVICE_KEY" }],
    "--secret is repeatable and lands as JobCreate.secrets in order"
  );
  const withoutFlag = buildJobInput(
    parseArgs(["job", "start", "-d", "deep-swe", "-a", "codex", "-m", "m"])
  );
  assert(!("secrets" in withoutFlag), "no secrets key when no --secret given");
}

function testInlineSecrets() {
  console.log("\n--- --secret-inline NAME[@LABEL]:DELIVERY=VALUE -> JobCreate.secrets ---");
  assertEqual(
    parseInlineSecrets(["GRPC_API_KEY:direct=raw-value"]),
    [{ name: "GRPC_API_KEY", value: "raw-value", delivery: "direct" }],
    "bare NAME:direct=VALUE is an inline entry with no label"
  );
  assertEqual(
    parseInlineSecrets(["API_KEY@ci:direct=a=b:c@d"]),
    [{ name: "API_KEY", value: "a=b:c@d", delivery: "direct", label: "ci" }],
    "the value is everything after the FIRST '=' — '=', ':' and '@' ride through"
  );
  assertEqual(
    parseInlineSecrets(["HOOK_TOKEN:brokered=v"]),
    [{ name: "HOOK_TOKEN", value: "v", delivery: "brokered" }],
    "brokered parses too — the server owns the refusal in the evals lane"
  );
  assertThrowsUsage(() => parseInlineSecrets(["NAME=value"]), "delivery mode is required", "missing delivery");
  assertThrowsUsage(() => parseInlineSecrets(["NAME:proxied=value"]), "brokered or direct", "unknown delivery");
  assertThrowsUsage(() => parseInlineSecrets(["NAME:direct="]), "must not be empty", "empty value");
  assertThrowsUsage(() => parseInlineSecrets(["NAME:direct"]), "NAME[@LABEL]:brokered|direct=VALUE", "no value at all");
  assertThrowsUsage(() => parseInlineSecrets(["@nolabel:direct=v"]), "NAME[@LABEL]:brokered|direct=VALUE", "empty name");
  assertThrowsUsage(() => parseInlineSecrets(["NAME@:direct=v"]), "NAME[@LABEL]:brokered|direct=VALUE", "empty label");

  const built = buildJobInput(
    parseArgs([
      "job", "start",
      "-d", "deep-swe",
      "-a", "codex",
      "-m", "m",
      "--secret", "GITHUB_TOKEN",
      "--secret-inline", "GRPC_API_KEY@ci:direct=raw-value",
    ])
  );
  assertEqual(
    built.secrets,
    [
      { name: "GITHUB_TOKEN" },
      { name: "GRPC_API_KEY", value: "raw-value", delivery: "direct", label: "ci" },
    ],
    "--secret and --secret-inline form one attachment list, references first"
  );
}

function testBuildJobInputRetry() {
  console.log("\n--- buildJobInput: -r/--max-retries, --retry-include, --retry-exclude ---");
  // All three flags land under one `retry` object, Harbor's field names.
  const withFlags = buildJobInput(
    parseArgs([
      "job", "start",
      "-d", "deep-swe",
      "-a", "codex",
      "-m", "m",
      "-r", "3",
      "--retry-include", "InfrastructureError",
      "--retry-exclude", "AgentAuthenticationError",
      "--retry-exclude", "ModelNotFoundError",
    ])
  );
  assertEqual(
    withFlags.retry,
    {
      max_retries: 3,
      include_exceptions: ["InfrastructureError"],
      exclude_exceptions: ["AgentAuthenticationError", "ModelNotFoundError"],
    },
    "retry flags become the JobCreate.retry object (Harbor vocabulary)"
  );

  // No flags, no key: the server's fleet default is the ask.
  const minimal = buildJobInput(parseArgs(["job", "start", "-d", "deep-swe", "-a", "codex", "-m", "m"]));
  assert(!("retry" in minimal), "no retry key when no retry flag given");

  // Config-file base is merged FIELD BY FIELD, a flag overriding its field —
  // Harbor's own CLI merge rule. A -c file validates against the contract, so
  // this half runs only where a spec is present.
  if (!SPEC_AVAILABLE) {
    console.log(`  - ${SPEC_SKIP_REASON}`);
    return;
  }
  const merged = buildJobInput(
    parseArgs([
      "job", "start",
      "--config", "job.json",
      "-d", "deep-swe",
      "-a", "codex",
      "-m", "m",
      "-r", "0",
    ]),
    () =>
      JSON.stringify({
        datasets: [{ name: "deep-swe" }],
        agents: [{ name: "codex", model_name: "m" }],
        retry: { max_retries: 5, min_wait_sec: 10 },
      })
  );
  assertEqual(
    merged.retry,
    { max_retries: 0, min_wait_sec: 10 },
    "-r overrides the config file's max_retries; its other fields survive"
  );

  // A Harbor config file's EXPLICIT `exclude_exceptions: null` survives the
  // merge untouched. On the server (as in Harbor's pydantic) null means "no
  // exclusions at all" — NOT the same as omitting the field, which keeps
  // Harbor's default set — so the CLI must never drop or rewrite it.
  const nullExclude = buildJobInput(
    parseArgs(["job", "start", "--config", "job.json", "-d", "deep-swe", "-a", "codex", "-m", "m"]),
    () =>
      JSON.stringify({
        datasets: [{ name: "deep-swe" }],
        agents: [{ name: "codex", model_name: "m" }],
        retry: { max_retries: 5, exclude_exceptions: null },
      })
  );
  assertEqual(
    nullExclude.retry,
    { max_retries: 5, exclude_exceptions: null },
    "an explicit exclude_exceptions null passes through the merge (Harbor's None: exclusions off)"
  );
}

function testBuildJobInputTimeoutMultipliers() {
  console.log("\n--- buildJobInput: the five --*timeout-multiplier flags (Harbor's names) ---");
  // The five flags land FLAT on the body, Harbor's JobConfig fields verbatim
  // (their cli/jobs.py:378-424) — never nested under an object.
  const withFlags = buildJobInput(
    parseArgs([
      "job", "start",
      "-d", "deep-swe",
      "-a", "codex",
      "-m", "m",
      "--timeout-multiplier", "2",
      "--verifier-timeout-multiplier", "3",
      "--agent-setup-timeout-multiplier", "1.5",
    ])
  );
  assertEqual(withFlags.timeout_multiplier, 2, "--timeout-multiplier -> timeout_multiplier");
  assertEqual(
    withFlags.verifier_timeout_multiplier,
    3,
    "--verifier-timeout-multiplier -> verifier_timeout_multiplier"
  );
  assertEqual(
    withFlags.agent_setup_timeout_multiplier,
    1.5,
    "--agent-setup-timeout-multiplier -> agent_setup_timeout_multiplier"
  );
  assert(
    !("agent_timeout_multiplier" in withFlags),
    "an unset phase flag sends NO key — the server's global-applies default is the ask"
  );
  assert(!("environment_build_timeout_multiplier" in withFlags), "same for environment build");

  // No flags, no keys: the server's 1.0 default is the ask.
  const minimal = buildJobInput(parseArgs(["job", "start", "-d", "deep-swe", "-a", "codex", "-m", "m"]));
  assert(!("timeout_multiplier" in minimal), "no multiplier key when no flag given");

  // Config-file base is merged FIELD BY FIELD, a flag overriding its field —
  // the same rule the retry flags follow (Harbor's own CLI merge posture).
  // A -c file validates against the contract, so this half runs only where a
  // spec is present.
  if (!SPEC_AVAILABLE) {
    console.log(`  - ${SPEC_SKIP_REASON}`);
    return;
  }
  const merged = buildJobInput(
    parseArgs([
      "job", "start",
      "--config", "job.json",
      "-d", "deep-swe",
      "-a", "codex",
      "-m", "m",
      "--timeout-multiplier", "4",
    ]),
    () =>
      JSON.stringify({
        datasets: [{ name: "deep-swe" }],
        agents: [{ name: "codex", model_name: "m" }],
        timeout_multiplier: 2,
        agent_timeout_multiplier: 5,
      })
  );
  assertEqual(merged.timeout_multiplier, 4, "the flag overrides the config file's field");
  assertEqual(merged.agent_timeout_multiplier, 5, "the file's other multiplier fields survive");
}

function testBuildJobInputSkills() {
  console.log("\n--- buildJobInput: --skill stamps every arm, local paths stay verbatim ---");
  const input = buildJobInput(parseArgs([
    "job", "start",
    "-d", "deep-swe",
    "-a", "codex",
    "-m", "gpt-5.5",
    "-m", "gpt-5.5-mini",
    "--skill", "skills.sh/o/r/frontend-design",
    "--skill", "./my-skill",
  ]));
  assertEqual(
    input.agents,
    [
      // --skill is stamped on EVERY arm, like --effort: one flag grammar,
      // one sweep. The local folder stays verbatim in the built body —
      // cmdJobStart uploads it and swaps the upload:<id> handle at send
      // time, so --print-config shows the path the caller typed.
      { name: "codex", model_name: "gpt-5.5", skills: ["skills.sh/o/r/frontend-design", "./my-skill"] },
      { name: "codex", model_name: "gpt-5.5-mini", skills: ["skills.sh/o/r/frontend-design", "./my-skill"] },
    ],
    "--skill repeatable, stamped on every arm in caller order"
  );

  const without = buildJobInput(parseArgs(["job", "start", "-d", "b", "-a", "a", "-m", "m"]));
  assert(
    without.agents.every((arm) => !("skills" in arm)),
    "no skills key when --skill omitted (absent, not [])"
  );

  const withName = buildJobInput(
    parseArgs(["job", "start", "-d", "b", "-a", "a", "-m", "m", "--skill", "name:frontend-design"])
  );
  assertEqual(
    withName.agents[0].skills,
    ["name:frontend-design"],
    "name:<skill-name> stays verbatim — the SERVER resolves the moving pointer at create"
  );
}

function testBuildJobInputYesIsInert() {
  console.log("\n--- buildJobInput: -y changes nothing (reserved, no prompts) ---");
  const withYes = buildJobInput(parseArgs(["job", "start", "-d", "b", "-a", "a", "-m", "m", "-y"]));
  const without = buildJobInput(parseArgs(["job", "start", "-d", "b", "-a", "a", "-m", "m"]));
  assertEqual(withYes, without, "-y leaves the body untouched");
}

async function testConfigFileMerge() {
  console.log("\n--- buildJobInput: -c config file + flag-over-file merge ---");
  const dir = await mkdtemp(join(tmpdir(), "evolve-cli-config-"));
  try {
    const jsonPath = join(dir, "job.json");
    await writeFile(
      jsonPath,
      JSON.stringify({
        job_name: "from-file",
        datasets: [{ name: "deep-swe", version: "1.0", task_names: ["old-*"] }],
        agents: [{ name: "claude", model_name: "sonnet" }],
        n_attempts: 3,
        sandbox_provider: "modal",
        agent_env: { FILE: "yes" },
      })
    );

    const fileOnly = buildJobInput(parseArgs(["job", "start", "-c", jsonPath]));
    assertEqual(
      fileOnly,
      {
        job_name: "from-file",
        datasets: [{ name: "deep-swe", version: "1.0", task_names: ["old-*"] }],
        agents: [{ name: "claude", model_name: "sonnet" }],
        n_attempts: 3,
        sandbox_provider: "modal",
        agent_env: { FILE: "yes" },
      },
      "a config file alone builds the whole body"
    );

    const merged = buildJobInput(
      parseArgs(["job", "start", "-c", jsonPath, "-a", "codex", "-m", "gpt-5.5", "-i", "new-*", "-k", "1"])
    );
    assertEqual(merged.agents, [{ name: "codex", model_name: "gpt-5.5" }], "-a/-m replace the file's agents");
    assertEqual(
      merged.datasets,
      [{ name: "deep-swe", version: "1.0", task_names: ["new-*"] }],
      "-i overrides the file's per-selector include filter"
    );
    assertEqual(merged.n_attempts, 1, "an explicit flag beats the file field");
    assertEqual(merged.sandbox_provider, "modal", "an unset flag keeps the file field");

    const yamlPath = join(dir, "job.yaml");
    await writeFile(
      yamlPath,
      [
        "# a job config in the spec vocabulary",
        "job_name: yaml-job",
        "datasets:",
        "  - name: deep-swe",
        '    version: "1.1"',
        '    task_names: ["cache-*", "abs-*"]',
        "  - name: frontier-swe",
        "agents:",
        "  - name: codex",
        "    model_name: gpt-5.5",
        "    reasoning_effort: low",
        "n_attempts: 2",
        "n_concurrent_trials: 8",
        "max_trial_spend_usd: 25.5",
        "sandbox_provider: e2b",
      ].join("\n")
    );
    const fromYaml = buildJobInput(parseArgs(["job", "start", "-c", yamlPath]));
    assertEqual(
      fromYaml,
      {
        job_name: "yaml-job",
        datasets: [
          { name: "deep-swe", version: "1.1", task_names: ["cache-*", "abs-*"] },
          { name: "frontier-swe" },
        ],
        agents: [{ name: "codex", model_name: "gpt-5.5", reasoning_effort: "low" }],
        n_attempts: 2,
        n_concurrent_trials: 8,
        max_trial_spend_usd: 25.5,
        sandbox_provider: "e2b",
      },
      "a YAML config builds the same body as JSON"
    );

    // A `%YAML` directive is a reading instruction, not a schema swap: PyYAML
    // reads a file the same way whatever the directive says, and this reader
    // is pinned to that one reading. Under a real 1.2 core schema `on` would
    // be the string "on" and sail through as a job name — here it stays the
    // boolean the 1.1 schema makes it, and the spec's string law refuses it.
    const directivePath = join(dir, "directive.yaml");
    await writeFile(
      directivePath,
      ["%YAML 1.2", "---", "job_name: on", "datasets: [{name: swe-bench}]", "agents: [{name: claude, model_name: opus}]"].join(
        "\n"
      )
    );
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", directivePath])),
      '"job_name" in',
      "a %YAML 1.2 directive does not swap the reading — on is still a boolean and refuses"
    );
    const directiveEnvPath = join(dir, "directive-env.yaml");
    await writeFile(
      directiveEnvPath,
      ["%YAML 1.2", "---", "datasets: [{name: swe-bench}]", "agents: [{name: claude, model_name: opus}]", "agent_env:", "  STRICT: false"].join(
        "\n"
      )
    );
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", directiveEnvPath])),
      "agent_env.STRICT",
      "under the directive, false is still a boolean — the env-string law fires instead of shipping the string \"false\""
    );

    const badPath = join(dir, "bad.yaml");
    await writeFile(badPath, 'datasets: [{"name": "deep-swe"}]\nfrobnicate: 1\n');
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", badPath])),
      'unknown key "frobnicate"',
      "an unknown config key is refused by name"
    );
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", join(dir, "missing.yaml")])),
      "cannot read",
      "an unreadable config file is a usage error"
    );

    // A dataset/agent element is an OBJECT. buildJobInput spreads every one
    // into a fresh selector, and spreading a string spreads its characters —
    // `datasets: [swe-bench]` built the character-indexed body
    // `[{"0":"s","1":"w",...}]` and rode to the wire at exit 0. Both the YAML
    // and the JSON spelling reach the same spread, so both are pinned.
    const bareNamePath = join(dir, "bare-name.yaml");
    await writeFile(bareNamePath, "datasets: [swe-bench]\nagents: [{name: claude, model_name: opus}]\n");
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", bareNamePath])),
      "datasets[0]",
      "a bare dataset name in the config refuses by name instead of spreading to characters"
    );
    const bareAgentPath = join(dir, "bare-agent.json");
    await writeFile(bareAgentPath, JSON.stringify({ datasets: [{ name: "deep-swe" }], agents: ["claude"] }));
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", bareAgentPath])),
      "agents[0]",
      "a bare agent name refuses in JSON too — the spread is the same one"
    );
    const scalarListPath = join(dir, "scalar-list.yaml");
    await writeFile(scalarListPath, "datasets: deep-swe\nagents: [{name: claude, model_name: opus}]\n");
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", scalarListPath])),
      "must be a list of objects",
      'a scalar "datasets" is named for what it is, not reported as a missing -d'
    );

    // A real YAML reader resolves types the hand-written subset never could,
    // and JSON.stringify REWRITES the surplus instead of refusing it: a Date
    // leaves as an ISO string, .inf/.nan as null, !!binary as a Buffer object.
    // job_name is a plain string with maxLength 200 in the spec, so the server
    // ACCEPTS the rewritten date — the one bad value that passes every gate and
    // still lands, under a name the caller never wrote.
    const wireCases: Array<[string, string, string]> = [
      ["date-name", "job_name: 2026-08-02", "resolved to a Date"],
      ["binary-name", "job_name: !!binary aGVsbG8=", "resolved to a Buffer"],
      ["inf-spend", "max_trial_spend_usd: .inf", "is infinite"],
      ["nan-spend", "max_trial_spend_usd: .nan", "is .nan"],
      ["set-env", "agent_env: !!set {a: null}", "resolved to a Set"],
      ["date-env", "agent_env: {WHEN: 2026-08-02}", "agent_env.WHEN"],
      ["bool-name", "job_name: yes", '"job_name" in'],
      ["text-spend", "max_trial_spend_usd: abc", '"max_trial_spend_usd" in'],
      ["bool-env", "verifier_env: {DEBUG: on}", "verifier_env.DEBUG"],
    ];
    for (const [name, line, needle] of wireCases) {
      const casePath = join(dir, `${name}.yaml`);
      await writeFile(casePath, `${line}\ndatasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus}]\n`);
      assertThrowsUsage(
        () => buildJobInput(parseArgs(["job", "start", "-c", casePath])),
        needle,
        `\`${line}\` refuses at the keyboard instead of riding the wire rewritten`
      );
    }

    // Quoting is the fix every one of those refusals points at, and it works.
    const quotedPath = join(dir, "quoted.yaml");
    await writeFile(
      quotedPath,
      ['job_name: "2026-08-02"', 'agent_env: {WHEN: "2026-08-02", DEBUG: "on"}', "max_trial_spend_usd: 25", "datasets: [{name: deep-swe}]", "agents: [{name: claude, model_name: opus}]"].join("\n")
    );
    const quoted = buildJobInput(parseArgs(["job", "start", "-c", quotedPath]));
    assertEqual(quoted.job_name, "2026-08-02", "a quoted date is the literal string the caller wrote");
    assertEqual(
      quoted.agent_env,
      { WHEN: "2026-08-02", DEBUG: "on" },
      "quoted env values pass through as the strings the wire takes"
    );

    // Ordinary text that only LOOKS numeric: PyYAML's float pattern needs a dot
    // and a signed exponent, so `e3` and `1e3` are the strings a caller wrote.
    // Under the 1.1 spec's wider pattern the library carries, `e3` resolved to
    // NaN and was refused as `.nan` — a value nobody typed, with no remedy
    // offered — and a `1e3` dataset name shipped as a JSON number at exit 0.
    const exponentPath = join(dir, "exponent.yaml");
    await writeFile(
      exponentPath,
      [
        "job_name: 1e3",
        "agent_env: {BUILD_TAG: e3, RELEASE: 1e3}",
        "datasets: [{name: 1e3}]",
        "agents: [{name: claude, model_name: E3}]",
      ].join("\n")
    );
    assertEqual(
      buildJobInput(parseArgs(["job", "start", "-c", exponentPath])),
      {
        job_name: "1e3",
        datasets: [{ name: "1e3" }],
        agents: [{ name: "claude", model_name: "E3" }],
        agent_env: { BUILD_TAG: "e3", RELEASE: "1e3" },
      },
      "e3 and 1e3 stay the text they are — no NaN refusal, no JSON number under a name field"
    );
    const exponentIO = captureIO();
    assertEqual(
      await runCli(["job", "start", "-c", exponentPath, "--print-config", ...AUTH], exponentIO.io),
      0,
      "and the body resolves at exit 0"
    );
    assert(
      exponentIO.out.join("\n").includes('"name": "1e3"'),
      "--print-config prints the dataset name QUOTED, where the wire number rode through unnoticed"
    );
    // The same law read the other way: PyYAML makes `1e3` a string, so a field
    // the file's own text must decide as a number is refused, not coerced.
    const exponentSpendPath = join(dir, "exponent-spend.yaml");
    await writeFile(
      exponentSpendPath,
      "max_trial_spend_usd: 1e3\ndatasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus}]\n"
    );
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", exponentSpendPath])),
      '"max_trial_spend_usd" in',
      "an unsigned exponent is a string to PyYAML, so a money field refuses it instead of spending 1000"
    );

    // The same law on the integer side: PyYAML will not read a zero-padded
    // number, so a build number `08` and a maintenance window `08:00` stay the
    // text they are. The 1.1 spec's wider patterns the library carries made
    // them 8 and 480, and a version pin shipped as a JSON number at exit 0.
    const paddedPath = join(dir, "padded.yaml");
    await writeFile(
      paddedPath,
      [
        "job_name: 08",
        "agent_env: {BUILD: 08, WINDOW: 08:00}",
        "datasets: [{name: deep-swe, version: 08}]",
        "agents: [{name: claude, model_name: 09}]",
      ].join("\n")
    );
    assertEqual(
      buildJobInput(parseArgs(["job", "start", "-c", paddedPath])),
      {
        job_name: "08",
        datasets: [{ name: "deep-swe", version: "08" }],
        agents: [{ name: "claude", model_name: "09" }],
        agent_env: { BUILD: "08", WINDOW: "08:00" },
      },
      "a zero-padded number stays the text it is — no 8, no 480, no number under a string field"
    );

    // A dataset or agent pin is a STRING on the wire, and `1.10` is the float
    // 1.1 in PyYAML too — which is exactly why this reader has to catch it:
    // 1.10 and 1.1 name DIFFERENT dataset versions, so an unquoted pin either
    // runs the wrong corpus at real spend or refuses after the round trip
    // --print-config promised to save. The top-level law reaches inside the
    // selectors, where it used to stop at the element being an object at all.
    const selectorCases: Array<[string, string, string]> = [
      ["ds-version", "datasets: [{name: deep-swe, version: 1.10}]\nagents: [{name: claude, model_name: opus}]", "datasets[0].version"],
      ["ds-name", "datasets: [{name: on}]\nagents: [{name: claude, model_name: opus}]", "datasets[0].name"],
      ["ds-tasks", "datasets: [{name: deep-swe, n_tasks: two}]\nagents: [{name: claude, model_name: opus}]", "datasets[0].n_tasks"],
      ["ds-globs", "datasets: [{name: deep-swe, task_names: [1.10]}]\nagents: [{name: claude, model_name: opus}]", "datasets[0].task_names[0]"],
      ["ds-glob-scalar", "datasets: [{name: deep-swe, exclude_task_names: slow}]\nagents: [{name: claude, model_name: opus}]", "must be a list of strings"],
      ["ag-version", "datasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus, version: 2.0}]", "agents[0].version"],
      ["ag-model", "datasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: 4.5}]", "agents[0].model_name"],
      ["ag-effort", "datasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus, reasoning_effort: on}]", "agents[0].reasoning_effort"],
    ];
    for (const [name, body, needle] of selectorCases) {
      const casePath = join(dir, `selector-${name}.yaml`);
      await writeFile(casePath, `${body}\n`);
      assertThrowsUsage(
        () => buildJobInput(parseArgs(["job", "start", "-c", casePath])),
        needle,
        `a selector field typed by the file's own text refuses at the keyboard (${name})`
      );
    }
    const pinIO = captureIO();
    assertEqual(
      await runCli(["job", "start", "-c", join(dir, "selector-ds-version.yaml"), "--print-config", ...AUTH], pinIO.io),
      2,
      "--print-config exits 2 over a numeric version pin, where it printed 1.1 at exit 0"
    );
    assert(
      pinIO.err.some((l) => l.includes('quote it (version: "...")')),
      "and the refusal carries the remedy, because quoting is the whole fix"
    );

    // The vocabulary, the types, the ranges and the enums above all read out
    // of spec/openapi.yaml itself (JobCreate and the shapes it references) —
    // no hand-kept field list. These pin the constraints only the spec knows:
    // a schema refusal names the config path, the file AND LINE, and the spec
    // shape that ruled, so the fix is findable from the message alone.
    const specCases: Array<[string, string, string[]]> = [
      [
        "unknown-arm-key",
        "datasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus, thinking: true}]",
        ['unknown key "thinking"', "agents[0]", "[spec: AgentArmInput]"],
      ],
      [
        "armless-model",
        "datasets: [{name: deep-swe}]\nagents: [{name: claude}]",
        ['missing the required key "model_name"', "[spec: AgentArmInput]"],
      ],
      [
        "nameless-selector",
        "datasets: [{version: \"1.0\"}]\nagents: [{name: claude, model_name: opus}]",
        ['missing the required key "name"', "[spec: DatasetSelector]"],
      ],
      [
        "bad-provider",
        "sandbox_provider: gcp\ndatasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus}]",
        ["must be one of: e2b, daytona, modal"],
      ],
      [
        "fractional-attempts",
        "n_attempts: 1.5\ndatasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus}]",
        ["must be an integer", "[spec: JobCreate.n_attempts]"],
      ],
      [
        // The ceiling's VALUE is the contract's to move (it has moved once
        // already, 16 -> 150), so the needle pins the refusal and the ruling
        // shape, not the number — 100000 sits above any ceiling the spec
        // would ever state.
        "over-concurrency",
        "n_concurrent_trials: 100000\ndatasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus}]",
        ["must be at most", "[spec: JobCreate.n_concurrent_trials]"],
      ],
      [
        "zero-tasks",
        "datasets: [{name: deep-swe, n_tasks: 0}]\nagents: [{name: claude, model_name: opus}]",
        ["datasets[0].n_tasks", "must be at least 1"],
      ],
      [
        "negative-spend",
        "max_trial_spend_usd: -1\ndatasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus}]",
        ["must be at least 0"],
      ],
      [
        "long-name",
        `job_name: "${"x".repeat(201)}"\ndatasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus}]`,
        ["must be at most 200 characters"],
      ],
      [
        "nine-arms",
        "datasets: [{name: deep-swe}]\nagents:\n" +
          Array.from({ length: 9 }, (_, i) => `  - {name: a${i}, model_name: m}`).join("\n"),
        ["takes at most 8 entries", "[spec: JobCreate.agents]"],
      ],
    ];
    for (const [name, body, needles] of specCases) {
      const casePath = join(dir, `spec-${name}.yaml`);
      await writeFile(casePath, `${body}\n`);
      for (const needle of needles) {
        assertThrowsUsage(
          () => buildJobInput(parseArgs(["job", "start", "-c", casePath])),
          needle,
          `spec-derived refusal (${name}) carries ${JSON.stringify(needle)}`
        );
      }
    }

    // The YAML reader knows where every value sits, so the refusal names the
    // line — the second line here — while the same body as JSON, which keeps
    // no positions, refuses without one.
    const linePath = join(dir, "line.yaml");
    await writeFile(
      linePath,
      "datasets: [{name: deep-swe}]\nn_attempts: 1.5\nagents: [{name: claude, model_name: opus}]\n"
    );
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", linePath])),
      `${linePath}:2`,
      "a YAML schema refusal points at the offending line"
    );
    const lineJsonPath = join(dir, "line.json");
    await writeFile(
      lineJsonPath,
      JSON.stringify({ datasets: [{ name: "deep-swe" }], agents: [{ name: "claude", model_name: "opus" }], n_attempts: 1.5 })
    );
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", lineJsonPath])),
      `${lineJsonPath} must be an integer`,
      "the JSON spelling refuses the same law, without a line"
    );

    // Quoting is that remedy, and the pin survives it intact.
    const pinnedPath = join(dir, "pinned.yaml");
    await writeFile(
      pinnedPath,
      'datasets: [{name: deep-swe, version: "1.10", n_tasks: 5, task_names: ["a*"]}]\nagents: [{name: claude, model_name: opus, version: "2.0"}]\n'
    );
    const pinnedIO = captureIO();
    assertEqual(
      await runCli(["job", "start", "-c", pinnedPath, "--print-config", ...AUTH], pinnedIO.io),
      0,
      "a quoted pin resolves at exit 0"
    );
    assert(
      pinnedIO.out.join("\n").includes('"version": "1.10"'),
      "and --print-config prints 1.10, not the 1.1 that named another corpus"
    );

    // --print-config is the dry run a paid remote run deserves, so the exit
    // code is the promise: the date-named job printed a rewritten body at
    // exit 0, where every config refusal is a usage exit 2.
    const printIO = captureIO();
    assertEqual(
      await runCli(["job", "start", "-c", join(dir, "date-name.yaml"), "--print-config", ...AUTH], printIO.io),
      2,
      "--print-config exits 2 over a body it would have rewritten, never 0"
    );
    assert(
      printIO.out.length === 0 && printIO.err.some((l) => l.includes("resolved to a Date")),
      "and prints the refusal, not a config body"
    );

    // The library's alias-bomb guard throws from toJS(), past the parse's own
    // error list — unwrapped it was a bare exit 1 naming no file.
    const bombPath = join(dir, "alias-bomb.yaml");
    const rows = ["a1: &a1 [x, x, x, x, x, x, x, x, x]"];
    for (let i = 2; i <= 5; i++) {
      rows.push(`a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(", ")}]`);
    }
    rows.push("job_name: *a5", "datasets: [{name: deep-swe}]", "agents: [{name: claude, model_name: opus}]");
    await writeFile(bombPath, rows.join("\n"));
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", bombPath])),
      bombPath,
      "a recursive-alias config refuses as a usage error naming its source"
    );
    assertEqual(
      await runCli(["job", "start", "-c", bombPath, "--print-config", ...AUTH], captureIO().io),
      2,
      "and exits 2 like every other config refusal, not 1"
    );

    // One alias exhausts nothing, so the library's guard lets a SELF-referential
    // anchor through as an object holding itself, and the wire-value walk
    // descended it until the stack ran out — the same nameless exit 1 the bomb
    // above was moved off, in two lines of valid YAML.
    const cyclePath = join(dir, "cycle.yaml");
    await writeFile(cyclePath, "agent_env: &a\n  X: *a\ndatasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus}]\n");
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", cyclePath])),
      "agent_env.X in " + cyclePath,
      "a self-referential anchor refuses by key and file, not as a stack overflow"
    );
    const cycleIO = captureIO();
    assertEqual(
      await runCli(["job", "start", "-c", cyclePath, "--print-config", ...AUTH], cycleIO.io),
      2,
      "and exits 2, not the 1 a bare RangeError left"
    );
    assert(
      cycleIO.err.some((l) => l.includes("cannot carry a cycle")),
      "and says what a JSON body cannot carry"
    );

    // A cycle hides equally well under a list, and the root document itself can
    // be the anchor — both terminate on the same ancestor check.
    const listCyclePath = join(dir, "cycle-list.yaml");
    await writeFile(listCyclePath, "datasets: &d\n  - name: deep-swe\n    task_names: *d\nagents: [{name: claude, model_name: opus}]\n");
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", listCyclePath])),
      "cannot carry a cycle",
      "a cycle through a selector list refuses too"
    );
    const rootCyclePath = join(dir, "cycle-root.yaml");
    await writeFile(rootCyclePath, "&root\njob_name: *root\n");
    assertThrowsUsage(
      () => buildJobInput(parseArgs(["job", "start", "-c", rootCyclePath])),
      "cannot carry a cycle",
      "and a document anchored on itself refuses instead of recursing"
    );

    // The guard is the ancestor path, not every value ever seen: one anchor
    // read twice side by side is a plain repeat and rides the wire as two
    // copies, which is what PyYAML and JSON both do with it.
    const sharedPath = join(dir, "shared-anchor.yaml");
    await writeFile(
      sharedPath,
      "datasets: [{name: deep-swe, task_names: &t [\"a*\"]}, {name: swe-bench, task_names: *t}]\nagents: [{name: claude, model_name: opus}]\n"
    );
    const sharedIO = captureIO();
    assertEqual(
      await runCli(["job", "start", "-c", sharedPath, "--print-config", ...AUTH], sharedIO.io),
      0,
      "a shared anchor is not a cycle and still resolves at exit 0"
    );
    assertEqual(
      sharedIO.out.join("\n").match(/"a\*"/g)?.length,
      2,
      "and both entries carry the anchor's value"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function testYamlConfig() {
  console.log("\n--- parseYamlConfig: real YAML through the yaml package ---");
  assertEqual(
    parseYamlConfig(
      ["a: 1", "b: true", "c: null", "d: 'single''quoted'", 'e: "double"', "f: bare string", "g: [1, 2]"].join("\n"),
      "t.yaml"
    ),
    { a: 1, b: true, c: null, d: "single'quoted", e: "double", f: "bare string", g: [1, 2] },
    "scalars, quotes, and flow lists"
  );
  assertEqual(
    parseYamlConfig(["list:", "  - one", '  - "two"', "  - 3"].join("\n"), "t.yaml"),
    { list: ["one", "two", 3] },
    "block sequences of scalars"
  );
  assertEqual(
    parseYamlConfig(["outer:", "  inner:", "    k: v"].join("\n"), "t.yaml"),
    { outer: { inner: { k: "v" } } },
    "nested block maps"
  );
  assertEqual(parseYamlConfig("# only comments\n\n", "t.yaml"), {}, "an empty document is an empty object");

  // The subset reader refused what it could not parse; the library parses it.
  // Every expectation below is PyYAML's reading of the same input.
  assertEqual(parseYamlConfig("a: &anchor 1", "t.yaml"), { a: 1 }, "anchors resolve instead of refusing");
  assertEqual(
    parseYamlConfig(["base: &b claude", "name: *b"].join("\n"), "t.yaml"),
    { base: "claude", name: "claude" },
    "an alias reads back its anchor's value"
  );
  assertEqual(parseYamlConfig("a: |", "t.yaml"), { a: "" }, "an empty block scalar is the empty string");
  assertEqual(
    parseYamlConfig(["a: |", "  line1", "  line2", ""].join("\n"), "t.yaml"),
    { a: "line1\nline2\n" },
    "a literal block scalar keeps its newlines"
  );
  assertEqual(
    parseYamlConfig("---\na: 1", "t.yaml"),
    { a: 1 },
    "a --- directive-end marker opens the one document, it is not a second one"
  );
  assertThrowsUsage(
    () => parseYamlConfig("a: 1\n---\nb: 2", "t.yaml"),
    "multi-document",
    "a SECOND document refuses loudly, as PyYAML's single-document load refuses it"
  );
  assertThrowsUsage(
    () => parseYamlConfig("a: !foo 1", "t.yaml"),
    "Unresolved tag",
    "an unresolvable tag refuses — the library's warning is promoted to the refusal PyYAML gives"
  );
  assertThrowsUsage(() => parseYamlConfig("\ta: 1", "t.yaml"), "Tabs", "tab indentation refused");
  assertThrowsUsage(() => parseYamlConfig("a: [1, 2", "t.yaml"), "t.yaml:1", "broken flow list refused with its line number");

  // Campaign A1's law, now the library's: a comment never lands inside a
  // value. Every expectation was taken from PyYAML on the same input.
  console.log("\n--- parseYamlConfig: trailing comments never land in values (A1) ---");
  assertEqual(
    parseYamlConfig('version: "1.3"          # pinned', "t.yaml"),
    { version: "1.3" },
    "a trailing comment after a double-quoted scalar is dropped, not an error"
  );
  assertEqual(
    parseYamlConfig("name: e2e-prod-check    # bare name -> active version resolution", "t.yaml"),
    { name: "e2e-prod-check" },
    "a trailing comment after a BARE scalar is dropped — never folded into the value"
  );
  assertEqual(
    parseYamlConfig(["datasets:", "  - name: claude            # alias-only probe"].join("\n"), "t.yaml"),
    { datasets: [{ name: "claude" }] },
    "the same law holds inside block sequences"
  );
  assertEqual(
    parseYamlConfig("url: http://x#frag", "t.yaml"),
    { url: "http://x#frag" },
    "a # without whitespace before it is content, not a comment (YAML's own rule)"
  );
  assertEqual(
    parseYamlConfig('note: "a # b"   # real comment', "t.yaml"),
    { note: "a # b" },
    "a # inside quotes is content; the one outside still strips"
  );

  // A quote mid-word is a letter, not a delimiter — the apostrophe corpus.
  assertEqual(
    parseYamlConfig("job_name: brando's run # the comment", "t.yaml"),
    { job_name: "brando's run" },
    "an apostrophe inside a bare value does not open a string — the comment still strips"
  );
  assertEqual(
    parseYamlConfig("desc: it's fine # trailing", "t.yaml"),
    { desc: "it's fine" },
    "the same holds for an apostrophe in the middle of a word"
  );
  assertEqual(
    parseYamlConfig('name: 5" wide # comment', "t.yaml"),
    { name: '5" wide' },
    "a double quote mid-value is content too"
  );
  assertEqual(
    parseYamlConfig(["datasets:", "  - name: brando's run  # picked"].join("\n"), "t.yaml"),
    { datasets: [{ name: "brando's run" }] },
    "the law reaches inside block sequences"
  );
  assertEqual(
    parseYamlConfig("it's: value", "t.yaml"),
    { "it's": "value" },
    "an apostrophe in a KEY leaves the key colon findable (PyYAML reads it the same way)"
  );
  assertEqual(
    parseYamlConfig(["'quoted key': v", '"dq key": w'].join("\n"), "t.yaml"),
    { "quoted key": "v", "dq key": "w" },
    "a quote that DOES begin a scalar still delimits — quoted keys unchanged"
  );
  assertEqual(
    parseYamlConfig("env: { A: 'x # y', B: don't }", "t.yaml"),
    { env: { A: "x # y", B: "don't" } },
    "inside flow, a quote after ', ' delimits while one mid-word does not"
  );

  console.log("\n--- parseYamlConfig: flow collections, unquoted scalars included (A1) ---");
  assertEqual(
    parseYamlConfig("agent_env:    { CAMPAIGN_MARKER: prod-aug01 }", "t.yaml"),
    { agent_env: { CAMPAIGN_MARKER: "prod-aug01" } },
    "a flow mapping with unquoted key and value parses"
  );
  assertEqual(
    parseYamlConfig("mix: { n: 3, flag: true, name: 'x', list: [a, 1] }", "t.yaml"),
    { mix: { n: 3, flag: true, name: "x", list: ["a", 1] } },
    "typed scalars, quotes, and nesting inside flow — and n stays the key n"
  );
  assertEqual(
    parseYamlConfig("tag: { MARKER: prod:tag }", "t.yaml"),
    { tag: { MARKER: "prod:tag" } },
    "a colon inside a flow value stays in the value"
  );
  assertEqual(
    parseYamlConfig('json: {"a": [1, 2], "b": {"c": null}}', "t.yaml"),
    { json: { a: [1, 2], b: { c: null } } },
    "strict JSON still parses unchanged"
  );
  assertEqual(
    parseYamlConfig("a: [1, 2,]\nenv: { A: 1, B: 2, }", "t.yaml"),
    { a: [1, 2], env: { A: 1, B: 2 } },
    "a trailing comma closes the collection — valid YAML"
  );
  assertEqual(
    parseYamlConfig("env: { A 1 }", "t.yaml"),
    { env: { "A 1": null } },
    "a colon-less flow entry is a key with a null value — PyYAML's reading, not a refusal"
  );
  assertThrowsUsage(() => parseYamlConfig("a: [1, , 2]", "t.yaml"), "Unexpected ,", "a comma with nothing between still refuses");
  assertThrowsUsage(() => parseYamlConfig("a: 1\nenv: { A: 1", "t.yaml"), "t.yaml:2", "an unclosed flow mapping refuses with its line number");
  assertThrowsUsage(() => parseYamlConfig("env: { A: 1 } trailing", "t.yaml"), "Unexpected scalar", "content after a closed flow collection refuses loudly");

  // A flow collection is a WHOLE sequence item — the shape that silently
  // corrupted under the hand parser. PyYAML's reading throughout.
  assertEqual(
    parseYamlConfig(["agents:", "  - {name: claude, model: opus}"].join("\n"), "t.yaml"),
    { agents: [{ name: "claude", model: "opus" }] },
    "a flow mapping as a sequence item keeps its inner colons (PyYAML's reading)"
  );
  assertEqual(
    parseYamlConfig(
      ["agents:", "  - {name: claude, model_name: opus}", "  - name: codex", "    model_name: gpt-5.5"].join("\n"),
      "t.yaml"
    ),
    { agents: [{ name: "claude", model_name: "opus" }, { name: "codex", model_name: "gpt-5.5" }] },
    "a flow item and a block item sit side by side in one sequence"
  );
  assertEqual(
    parseYamlConfig(["datasets:", "  - {name: deep-swe, task_names: [a, b]}   # picked"].join("\n"), "t.yaml"),
    { datasets: [{ name: "deep-swe", task_names: ["a", "b"] }] },
    "nesting and the trailing-comment law both hold inside a flow sequence item"
  );
  assertThrowsUsage(
    () => parseYamlConfig(["a:", "  - {b: 1"].join("\n"), "t.yaml"),
    "t.yaml:2",
    "an unclosed flow item refuses with its line number instead of parsing to a garbage key"
  );
  assertThrowsUsage(
    () => parseYamlConfig(["a:", "  - {b: 1} trailing"].join("\n"), "t.yaml"),
    "Unexpected scalar",
    "content after a closed flow item refuses loudly, as PyYAML refuses it"
  );

  // A colon followed by a space opens a mapping pair inside flow — the
  // unbraced shapes the subset reader refused now parse to PyYAML's readings.
  assertEqual(
    parseYamlConfig("datasets: [name: swe-bench]", "t.yaml"),
    { datasets: [{ name: "swe-bench" }] },
    "an unbraced single-pair mapping in a flow sequence is a one-key object (PyYAML's reading)"
  );
  assertEqual(
    parseYamlConfig("agents: [name: claude, model_name: opus]", "t.yaml"),
    { agents: [{ name: "claude" }, { model_name: "opus" }] },
    "comma-separated bare pairs are SEPARATE one-key objects — loadJobConfig refuses the missing model downstream"
  );
  assertEqual(
    parseYamlConfig("a: [x:]", "t.yaml"),
    { a: [{ x: null }] },
    "a colon before the closer opens a pair with a null value — PyYAML reads [{x: null}]"
  );
  assertThrowsUsage(
    () => parseYamlConfig("a: {b: c: d}", "t.yaml"),
    "not allowed within flow",
    "a second colon in a flow mapping value refuses, as PyYAML refuses it"
  );
  assertThrowsUsage(
    () => parseYamlConfig("a: [#c]", "t.yaml"),
    "Comments must be separated",
    "a # glued to flow content refuses — PyYAML reads the rest as a comment and finds no content"
  );
  assertEqual(
    parseYamlConfig("tag: { MARKER: prod:tag, url: [http://x.co/a] }", "t.yaml"),
    { tag: { MARKER: "prod:tag", url: ["http://x.co/a"] } },
    "a glued colon stays a letter — prod:tag and a URL survive"
  );

  // The schema is PyYAML's: YAML 1.1 resolution minus the bare y/n booleans
  // PyYAML never adopted, plus a duplicate-key refusal where PyYAML silently
  // keeps the last value.
  console.log("\n--- parseYamlConfig: PyYAML's 1.1 schema, differentially pinned ---");
  assertEqual(
    parseYamlConfig("a: yes\nb: no\nc: on\nd: off", "t.yaml"),
    { a: true, b: false, c: true, d: false },
    "yes/no/on/off are booleans, as PyYAML reads them (1.2 would keep them strings)"
  );
  assertEqual(
    parseYamlConfig("vals: [y, n]\ny: 2", "t.yaml"),
    { vals: ["y", "n"], y: 2 },
    "bare y/n stay strings and keys — the 1.1 spec booleans PyYAML never adopted"
  );
  assertEqual(
    parseYamlConfig("a: 012", "t.yaml"),
    { a: 10 },
    "a leading zero is octal in the 1.1 schema, as PyYAML reads it (1.2 would read 12)"
  );
  assertThrowsUsage(
    () => parseYamlConfig("a: b\na: c", "t.yaml"),
    "t.yaml:2",
    "a duplicate key refuses with its line instead of silently keeping the last value"
  );

  // PyYAML's float pattern needs a dot AND a signed exponent; the 1.1 spec's,
  // which the library carries, needs neither. Under the spec's, `e3` was a
  // float whose parseFloat is NaN — an ordinary build tag refused as `.nan`,
  // naming a value nobody wrote — and `1e3` was the number 1000. Every reading
  // below was taken from PyYAML 6.0.3 on the identical text.
  const floatShapes: Array<[string, unknown]> = [
    ["e3", "e3"],
    ["E3", "E3"],
    ["e10", "e10"],
    ["-e3", "-e3"],
    [".", "."],
    ["+.", "+."],
    ["-.", "-."],
    ["._", "._"],
    ["1e3", "1e3"],
    ["1E3", "1E3"],
    ["1.0e3", "1.0e3"],
    ["-1e3", "-1e3"],
    ["5e-3", "5e-3"],
    ["1.5e3", "1.5e3"],
    [".5e3", ".5e3"],
    ["1e+3", "1e+3"],
    ["-.5", "-.5"],
    ["+.5", "+.5"],
    ["-.5e+3", "-.5e+3"],
    [".5", 0.5],
    ["1.", 1],
    ["-1.", -1],
    ["1.5", 1.5],
    ["1.5e+3", 1500],
    ["1.e+3", 1000],
    ["+1.5e+3", 1500],
    [".5e+3", 500],
    ["1.0E+3", 1000],
    ["1_0.0", 10],
    ["12:30.5", 750.5],
    ["12:30", 750],
  ];
  for (const [text, expected] of floatShapes) {
    assertEqual(
      parseYamlConfig(`a: ${text}`, "t.yaml"),
      { a: expected },
      `\`${text}\` reads as ${JSON.stringify(expected)}, as PyYAML reads it`
    );
  }
  assertEqual(
    parseYamlConfig("%YAML 1.2\n---\ntag: e3\nspend: 1.5e+3", "t.yaml"),
    { tag: "e3", spend: 1500 },
    "the float carve-out survives the directive too"
  );

  // PyYAML's integer patterns are narrower than the 1.1 spec's in the same
  // place twice — a LEADING ZERO. A decimal integer is `0` or starts 1-9, and
  // a sexagesimal one starts 1-9, so a zero-padded build number `08` and a
  // clock-shaped `08:00` are text. Under the spec's, which the library carries,
  // they were the numbers 8 and 480. The octal, binary and hex tags already
  // carry PyYAML's patterns, and the sexagesimal FLOAT `0:0.5` reads from a
  // leading zero in PyYAML too, so those stay put. Every reading below was
  // taken from PyYAML 6.0.3 on the identical text.
  const intShapes: Array<[string, unknown]> = [
    ["08", "08"],
    ["09", "09"],
    ["0888", "0888"],
    ["+08", "+08"],
    ["-09", "-09"],
    ["0b12", "0b12"],
    ["0o17", "0o17"],
    ["0:0", "0:0"],
    ["00:30", "00:30"],
    ["0:5:0", "0:5:0"],
    ["-0:30", "-0:30"],
    ["08:00", "08:00"],
    ["09:30:00", "09:30:00"],
    ["1:60", "1:60"],
    ["0", 0],
    ["+0", 0],
    ["-0", 0],
    ["00", 0],
    ["00000", 0],
    ["0_0", 0],
    ["007", 7],
    ["010", 8],
    ["012", 10],
    ["0644", 420],
    ["0b1", 1],
    ["0x1f", 31],
    ["19", 19],
    ["+19", 19],
    ["-19", -19],
    ["1_0", 10],
    ["1_000", 1000],
    ["2026", 2026],
    ["1:00", 60],
    ["9:00", 540],
    ["12:30", 750],
    ["1:2:3", 3723],
    ["10:00:00", 36000],
    ["0:0.5", 0.5],
    ["00:30.5", 30.5],
    ["0.0", 0],
  ];
  for (const [text, expected] of intShapes) {
    assertEqual(
      parseYamlConfig(`a: ${text}`, "t.yaml"),
      { a: expected },
      `\`${text}\` reads as ${JSON.stringify(expected)}, as PyYAML reads it`
    );
  }
  assertEqual(
    parseYamlConfig("%YAML 1.2\n---\nbuild: 08\nstart: 0:0\noct: 012\nclock: 12:30", "t.yaml"),
    { build: "08", start: "0:0", oct: 10, clock: 750 },
    "the integer carve-out survives the directive too"
  );

  // PyYAML's resolver has ONE mode, so a `%YAML` directive changes nothing
  // about how values read. The library lets the directive pick the schema, and
  // the 1.2 core schema's single bool tag carries a `resolve` of
  // `str[0] === "t"` — under it `yes` had resolved to FALSE and `false` had
  // stopped being a boolean at all, silently, at exit 0. Every reading below
  // is PyYAML 6.0.3's on the identical text.
  const withDirective = (directive: string) =>
    parseYamlConfig([directive, "---", "thinking: yes", "strict: false", "oct: 012", "n: 3"].join("\n"), "t.yaml");
  const directiveFree = { thinking: true, strict: false, oct: 10, n: 3 };
  assertEqual(withDirective("%YAML 1.2"), directiveFree, "a %YAML 1.2 directive does not invert yes or unmake false");
  assertEqual(withDirective("%YAML 1.1"), directiveFree, "an explicit %YAML 1.1 directive reads the same");
  assertEqual(
    parseYamlConfig("%YAML 1.2\n---\nvals: [y, n, yes, no, on, off]", "t.yaml"),
    { vals: ["y", "n", true, false, true, false] },
    "the bare y/n carve-out survives the directive too"
  );

  // The library speaks to stdio on its own account — a collection-valued key
  // makes it emit a Node warning about JS object keys before this reader gets
  // to refuse the key. The CLI owes its caller its own refusals and no
  // library-internal chatter, so the library's log level is silent.
  const realEmitWarning = process.emitWarning;
  const emitted: unknown[] = [];
  process.emitWarning = ((warning: unknown) => {
    emitted.push(warning);
  }) as typeof process.emitWarning;
  try {
    parseYamlConfig("? [a, b]\n: 1", "t.yaml");
  } finally {
    process.emitWarning = realEmitWarning;
  }
  assertEqual(emitted, [], "a collection-valued key leaks no library warning onto the CLI's stdio");
}

async function testPrintConfig() {
  console.log("\n--- runCli: --print-config prints the resolved body, no network ---");
  installMockFetch();
  try {
    const { io, out } = captureIO();
    const code = await runCli(
      ["job", "start", "-d", "deep-swe@1.1", "-a", "codex", "-m", "gpt-5.5", "--print-config", ...AUTH],
      io
    );
    assertEqual(code, 0, "exit 0");
    assertEqual(fetchCalls.length, 0, "nothing was sent");
    assertEqual(
      JSON.parse(out.join("\n")),
      { datasets: [{ name: "deep-swe", version: "1.1" }], agents: [{ name: "codex", model_name: "gpt-5.5" }] },
      "prints the resolved JobCreate body"
    );

    // --print-config is the dry-run a paid remote run deserves, so it owes an
    // honest exit code: a config it cannot resolve exits 2 with the reason on
    // stderr, never 0 over a character-indexed body the server would refuse.
    if (SPEC_AVAILABLE) {
      const dir = await mkdtemp(join(tmpdir(), "evolve-cli-print-"));
      try {
        const bare = join(dir, "bare.yaml");
        await writeFile(bare, "job_name: nightly\ndatasets: [swe-bench]\nagents: [{name: claude, model_name: opus}]\n");
        const bad = captureIO();
        const badCode = await runCli(["job", "start", "-c", bare, "--print-config", ...AUTH], bad.io);
        assertEqual(badCode, 2, "a bare dataset name exits 2, not 0");
        assertEqual(bad.out.join("\n"), "", "nothing was printed as a body");
        assert(bad.err.join("\n").includes("datasets[0]"), "stderr names the offending element");
        assertEqual(fetchCalls.length, 0, "still nothing was sent");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else {
      console.log(`  - ${SPEC_SKIP_REASON}`);
    }
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// HELP + VERSION
// =============================================================================

async function testHelpAndVersion() {
  console.log("\n--- runCli: help forms and --version ---");
  const root = captureIO();
  assertEqual(await runCli([], root.io), 0, "bare invocation exits 0");
  const rootText = root.out.join("\n");
  assert(rootText.includes("Usage: evolve"), "root help prints usage");
  assert(rootText.includes("job") && rootText.includes("dataset"), "root help names the groups");

  const group = captureIO();
  assertEqual(await runCli(["job"], group.io), 0, "bare group exits 0");
  assert(group.out.join("\n").includes("start"), "group help lists its verbs");

  const cmd = captureIO();
  assertEqual(await runCli(["job", "start", "--help"], cmd.io), 0, "command --help exits 0");
  const cmdText = cmd.out.join("\n");
  assert(cmdText.includes("-d, --dataset"), "command help shows the short + long flags");
  assert(cmdText.includes("Example:"), "command help carries a worked example");
  assert(cmdText.includes("evolve job start -d "), "the example is a runnable line");

  // `run` is first-class: its help page documents `run`, never `job start`.
  // The old behavior rewrote the command before help was rendered, so a caller
  // who typed `evolve run --help` was handed a page for words they never used.
  const runCmd = captureIO();
  assertEqual(await runCli(["run", "--help"], runCmd.io), 0, "run --help exits 0");
  const runText = runCmd.out.join("\n");
  assert(runText.includes("Usage: evolve run"), "run --help documents `evolve run`");
  assert(!runText.includes("Usage: evolve job start"), "run --help does not deflect to job start");
  assert(runText.includes("-d, --dataset"), "run --help carries job start's flags");
  assert(runText.includes("evolve run -d "), "run's example is spelled as run");
  assert(rootText.includes("  run "), "root help lists run as its own command");

  // A refusal raised inside `run` names `run`. Reaching for job start's
  // spelling here would send the caller to a command they did not type.
  const runNoDataset = captureIO();
  assertEqual(await runCli(["run", ...AUTH], runNoDataset.io), 2, "run with no dataset is a usage error");
  assert(
    runNoDataset.err.join("\n").includes('"run" requires -d/--dataset'),
    "the refusal inside run names run, not job start"
  );
  const startNoDataset = captureIO();
  assertEqual(await runCli(["job", "start", ...AUTH], startNoDataset.io), 2, "job start with no dataset is a usage error");
  assert(
    startNoDataset.err.join("\n").includes('"job start" requires -d/--dataset'),
    "the same refusal under job start still names job start"
  );

  // The reserved word answers with its reason on every road in.
  const reservedHelp = captureIO();
  assertEqual(await runCli(["help", "agents"], reservedHelp.io), 0, "help agents exits 0");
  assert(
    reservedHelp.out.join("\n").includes("reserved for the managed-agents CLI"),
    "help agents explains the reservation instead of printing the root page"
  );
  const reservedRun = captureIO();
  assertEqual(await runCli(["agents", "list", ...AUTH], reservedRun.io), 2, "agents <verb> is a usage error");
  assert(
    reservedRun.err.join("\n").includes("reserved for the managed-agents CLI"),
    "running a reserved word refuses by name"
  );

  // The old binary name is gone from every rendered surface — a stray
  // `evolve-evals` in help is an instruction to type a command that no
  // installer writes.
  const allHelp = [rootText, group.out.join("\n"), cmdText, runText].join("\n");
  assert(!allHelp.includes("evolve-evals"), "no help surface still says evolve-evals");

  const trialCmd = captureIO();
  await runCli(["help", "trial", "download"], trialCmd.io);
  const trialCmdText = trialCmd.out.join("\n");
  assert(trialCmdText.includes("--stream"), "help <group> <verb> resolves the command help");
  assert(
    trialCmdText.includes("trace-atif (the ATIF trajectory)"),
    "--stream help names the served ATIF artifact by its trace-atif name"
  );
  assert(
    trialCmdText.includes("trajectory (reserved"),
    "--stream help tells the truth about the reserved harness-native trajectory slot"
  );

  const resumeCmd = captureIO();
  await runCli(["job", "resume", "--help"], resumeCmd.io);
  const resumeText = resumeCmd.out.join("\n");
  assert(resumeText.includes("failed or stopped trials"), "resume summary owns the stopped trials it picks up");
  assert(
    resumeText.includes("plus stopped trials"),
    "the -f default names stopped trials as part of the standard set"
  );

  const version = captureIO();
  assertEqual(await runCli(["--version"], version.io), 0, "--version exits 0");
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf-8")
  );
  assertEqual(version.out, [pkg.version], "--version prints the package version");
}

// =============================================================================
// RENDERERS
// =============================================================================

function testImportStatusLine() {
  console.log("\n--- importStatusLine: compact status lines ---");
  const job = { id: "imp-1", name: "my-bench", version: "1.0", warnings: [], progress: null };
  const imported = importStatusLine({ ...job, status: "COMPLETED", failure: null, task_count: 12 });
  assert(imported.includes("COMPLETED"), "includes the status");
  assert(imported.includes("tasks=12"), "includes the task count");
  const failedLine = importStatusLine({ ...job, status: "FAILED", failure: { code: "import_failed", message: "bad tasks.json", failures: [{ task_name: "t1", error: "boom" }] } });
  assert(failedLine.includes("FAILED") && failedLine.includes("bad tasks.json") && failedLine.includes("1 task failure"), "FAILED line carries message + failure count");
}

function testImportProgressLines() {
  console.log("\n--- importProgressLine / progressSettleLines: live phase progress ---");
  const phase = (
    name: "extracting" | "parsing" | "building" | "copying" | "verifying",
    startedAt: string,
    completedAt: string | undefined,
    done: number,
    total: number,
    banked?: number
  ) => ({
    name,
    started_at: startedAt,
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
    done,
    total,
    ...(banked !== undefined ? { banked } : {}),
  });

  // Live line: M-of-N + elapsed (the poll-line adaptation of Harbor's
  // publish progress columns, REFERENCES/Harbor src/harbor/cli/publish.py:231-238).
  const building = importProgressLine(
    {
      phase: "building",
      started_at: "2026-08-31T10:00:00.000Z",
      phases: [phase("building", "2026-08-31T10:00:00.000Z", undefined, 3, 9, 1)],
      images: { built: 2, mirrored: 0, banked: 1 },
      codebuild: { copy_builds: 2, billed_minutes: 4 },
    },
    Date.parse("2026-08-31T10:12:34.000Z")
  );
  assert(building.includes("building"), "names the phase");
  assert(building.includes("3/9"), "carries M of N");
  assert(building.includes("1 banked"), "carries the phase's banked count");
  assert(building.includes("12m34s"), "carries the phase's elapsed wall-clock");

  // The copy phase states "N of M images already banked".
  const copying = importProgressLine(
    {
      phase: "copying",
      started_at: "2026-08-31T10:00:00.000Z",
      phases: [phase("copying", "2026-08-31T10:20:00.000Z", undefined, 40, 120, 38)],
      images: { built: 0, mirrored: 2, banked: 38 },
      codebuild: { copy_builds: 0, billed_minutes: 0 },
    },
    Date.parse("2026-08-31T10:21:10.000Z")
  );
  assert(copying.includes("38 of 120 images already banked"), "copy phase states N of M already banked");

  // A unit-less phase (extracting) renders without a 0/0.
  const extracting = importProgressLine(
    {
      phase: "extracting",
      started_at: "2026-08-31T10:00:00.000Z",
      phases: [phase("extracting", "2026-08-31T10:00:00.000Z", undefined, 0, 0)],
      images: { built: 0, mirrored: 0, banked: 0 },
      codebuild: { copy_builds: 0, billed_minutes: 0 },
    },
    Date.parse("2026-08-31T10:00:12.000Z")
  );
  assert(extracting.includes("extracting") && !extracting.includes("0/0"), "no counts on a unit-less phase");

  // Settled record: wall-clock per phase + images built/mirrored/banked +
  // CodeBuild minutes (the shape of Harbor publish's settle summary,
  // REFERENCES/Harbor src/harbor/cli/publish.py:288-315).
  const settled = progressSettleLines({
    phase: "verifying",
    started_at: "2026-08-31T10:00:00.000Z",
    phases: [
      phase("extracting", "2026-08-31T10:00:00.000Z", "2026-08-31T10:00:12.000Z", 0, 0),
      phase("parsing", "2026-08-31T10:00:12.000Z", "2026-08-31T10:00:16.000Z", 113, 113),
      phase("building", "2026-08-31T10:00:16.000Z", "2026-08-31T10:42:26.000Z", 9, 9, 2),
      phase("copying", "2026-08-31T10:42:26.000Z", "2026-08-31T10:45:27.000Z", 120, 120, 115),
      phase("verifying", "2026-08-31T10:45:27.000Z", "2026-08-31T10:46:22.000Z", 113, 113),
    ],
    images: { built: 7, mirrored: 5, banked: 117 },
    codebuild: { copy_builds: 12, billed_minutes: 19 },
  }).join("\n");
  assert(settled.includes("extracting 12s"), "per-phase wall-clock: extracting");
  assert(settled.includes("building 42m10s"), "per-phase wall-clock: building");
  assert(settled.includes("verifying 55s"), "per-phase wall-clock: verifying");
  assert(settled.includes("7 built, 5 mirrored, 117 banked"), "image economics line");
  assert(settled.includes("12 copy build(s), 19 billed minute(s)"), "CodeBuild meter line");

  // A FAILED import's dying phase has no completed_at: stated, never faked.
  const died = progressSettleLines({
    phase: "building",
    started_at: "2026-08-31T10:00:00.000Z",
    phases: [phase("building", "2026-08-31T10:00:00.000Z", undefined, 4, 9)],
    images: { built: 0, mirrored: 0, banked: 0 },
    codebuild: { copy_builds: 0, billed_minutes: 0 },
  }).join("\n");
  assert(died.includes("building unfinished"), "an open phase reads unfinished, never a fabricated duration");
}

function testEventLine() {
  console.log("\n--- eventLine: compact status lines ---");
  const line = eventLine({
    seq: 2,
    type: "trial.settled",
    data: { trial_id: "run-1", task_name: "abs-module-cache-flags", status: "SCORED", reward: 1 },
  });
  assert(line.includes("#   2"), "includes padded seq");
  assert(line.includes("trial.settled"), "includes event type");
  assert(line.includes("run-1"), "includes trial_id");
  assert(line.includes("SCORED"), "includes status");
  assert(line.includes("reward=1"), "includes reward");

  // The live-spend beat: --watch must show money moving while a trial runs.
  const spend = eventLine({
    seq: 3,
    type: "trial.spend",
    data: { trial_id: "run-1", task_name: "abs-module-cache-flags", live_spent_usd: 0.0421 },
  });
  assert(spend.includes("trial.spend"), "spend line includes event type");
  assert(spend.includes("run-1"), "spend line includes trial_id");
  assert(spend.includes("live_spent_usd=0.0421"), "spend line carries the live figure");
}

function trialFixture(overrides: Partial<Trial>): Trial {
  return {
    id: "run-1",
    job_id: "eval-1",
    task_name: "abs-module-cache-flags",
    source: "deep-swe",
    agent_info: {
      name: "claude",
      version: null,
      model_info: { name: "claude-sonnet-5", provider: null },
      reasoning_effort: null,
    },
    attempt: 1,
    status: "RUNNING",
    reward: null,
    verifier_result: null,
    exception_info: null,
    agent_result: null,
    environment_setup: null,
    agent_setup: null,
    agent_execution: null,
    verifier: null,
    step_results: null,
    spend_source: null,
    live_spent_usd: null,
    live_spend_at: null,
    max_trial_spend_usd: null,
    sandbox_provider: null,
    sandbox_id: null,
    verifier_sandbox_id: null,
    verifier_environment_mode: null,
    attempt_phase: null,
    session_ref: null,
    started_at: "2026-07-29T00:00:00.000Z",
    finished_at: null,
    ...overrides,
  } as Trial;
}

function testTrialDetailLiveSpend() {
  console.log("\n--- trialDetailLines: live spend while RUNNING ---");
  const running = trialDetailLines(
    trialFixture({ live_spent_usd: 0.0421, live_spend_at: "2026-07-29T00:00:09.000Z" }),
  ).join("\n");
  assert(running.includes("spent (live)"), "RUNNING trial shows the live row");
  assert(running.includes("at least $0.0421"), "live figure is labeled a lower bound, 4 decimals");
  assert(running.includes("as of 2026-07-29T00:00:09.000Z"), "live figure carries its age");

  const settled = trialDetailLines(
    trialFixture({
      status: "SCORED",
      reward: 1,
      agent_result: { cost_usd: 0.31 },
      spend_source: "measured",
      live_spent_usd: 0.0421,
    }),
  ).join("\n");
  assert(!settled.includes("spent (live)"), "a settled trial shows no live row");
  assert(settled.includes("$0.31"), "a settled trial shows the settled figure");

  const noReading = trialDetailLines(trialFixture({})).join("\n");
  assert(!noReading.includes("spent (live)"), "no reading yet means no live row, never $0");
}

/**
 * THE SETTLED MONEY ROW CARRIES ITS LANE. `agent_result.cost_usd` is half of
 * the API's statement; `spend_source` is the half that says how final it is,
 * and the row is one cell wide. Printing the number bare turned "nobody
 * measured this trial" into "spent $0.00" — measured in production
 * 2026-08-20 on an `assumed_cap` trial the platform later read at $0.057.
 * That lane is the ORDINARY state of a freshly settled trial.
 */
function testTrialDetailSpendLane() {
  console.log("\n--- trialDetailLines: the settled spend row states its lane ---");

  const scored = (over: Record<string, unknown>) =>
    trialDetailLines(trialFixture({ status: "SCORED", reward: 1, ...over })).join("\n");

  const capped = scored({ agent_result: { cost_usd: 0 }, spend_source: "assumed_cap" });
  assert(/spent\s+-/.test(capped), "assumed_cap states no figure");
  assert(!capped.includes("$0.00"), "and the zero the column holds never reaches the screen");

  const floor = scored({ agent_result: { cost_usd: 0.06 }, spend_source: "measured_provisional" });
  assert(floor.includes("at least $0.06"), "a provisional reading is named a lower bound");

  const measured = scored({ agent_result: { cost_usd: 0.06 }, spend_source: "measured" });
  assert(/spent\s+\$0\.06/.test(measured), "a measured reading is stated plainly");
  assert(!measured.includes("at least"), "and never hedged");

  // The unevidenced measured zero: money and tokens come from the same gateway
  // read, so a real measured zero carries its token trace. Without one the
  // stamp is not authoritative, whatever wrote it.
  const unevidenced = scored({
    agent_result: {
      cost_usd: 0,
      n_input_tokens: null,
      n_cache_tokens: null,
      n_output_tokens: null,
    },
    spend_source: "measured",
  });
  assert(/spent\s+-/.test(unevidenced), "a 'measured' $0 with no token evidence states no figure");

  // ...and one that DOES carry its tokens is a real reading, which must survive.
  const provenZero = scored({
    agent_result: { cost_usd: 0, n_input_tokens: 12, n_cache_tokens: 0, n_output_tokens: 0 },
    spend_source: "measured",
  });
  assert(provenZero.includes("$0.00"), "an evidenced measured zero is still a figure");

  // THE LIST COLUMN IS THE SAME CELL. A page of freshly settled trials is where
  // a wall of "$0.00" would read as a free job, so the SPENT column obeys the
  // identical rule — the detail row and the list must never disagree about the
  // same trial.
  const spentCell = TRIAL_COLUMNS.find((column) => column.key === "spent");
  assert(spentCell !== undefined, "the trial list has a SPENT column");
  const cellFor = (over: Record<string, unknown>) =>
    spentCell!.cell(trialFixture({ status: "SCORED", reward: 1, ...over }));
  assertEqual(
    cellFor({ agent_result: { cost_usd: 0 }, spend_source: "assumed_cap" }),
    "-",
    "the column states no figure for an unmeasured trial",
  );
  assertEqual(
    cellFor({ agent_result: { cost_usd: 0.06 }, spend_source: "measured_provisional" }),
    "at least $0.06",
    "the column names a provisional reading a lower bound",
  );
  assertEqual(
    cellFor({ agent_result: { cost_usd: 0.06 }, spend_source: "measured" }),
    "$0.06",
    "the column states a measured reading plainly",
  );
}

/**
 * THE ONE-HOME USAGE READING on the CLI surfaces: the token half renders as
 * its own row/column with the provisional marker inside the cell, and the
 * SPENT column folds the live floor in (trialSpendNow) so a RUNNING trial
 * that has demonstrably spent shows "at least $X" instead of a dash.
 */
function testTrialUsageRendering() {
  console.log("\n--- usage reading: tokens row/column + live SPENT floor ---");

  const liveUsage = {
    provisional: true,
    spent_usd: 0.0421,
    input_tokens: 12345,
    cached_input_tokens: 4102,
    output_tokens: 2210,
    as_of: "2026-07-29T00:00:09.000Z",
  };

  const running = trialDetailLines(trialFixture({ usage: liveUsage })).join("\n");
  assert(running.includes("tokens"), "a metered trial shows the tokens row");
  assert(
    running.includes("in 12,345 (4,102 cached) · out 2,210"),
    "the row carries counts and the cached share",
  );
  assert(running.includes("— provisional"), "a growing count is marked provisional in the cell");

  const settled = trialDetailLines(
    trialFixture({
      status: "SCORED",
      reward: 1,
      agent_result: { cost_usd: 0.31 },
      spend_source: "measured",
      usage: { ...liveUsage, provisional: false, spent_usd: 0.31 },
    }),
  ).join("\n");
  assert(settled.includes("in 12,345 (4,102 cached) · out 2,210"), "a settled trial keeps its tokens row");
  assert(!settled.includes("— provisional"), "a settled count carries no provisional marker");

  const noUsage = trialDetailLines(trialFixture({})).join("\n");
  assert(!noUsage.includes("tokens"), "no reading means no tokens row, never a row of zeros");

  // The list columns: SPENT folds the live floor in; TOKENS is the same cell
  // the detail row prints.
  const spentCell = TRIAL_COLUMNS.find((column) => column.key === "spent");
  assertEqual(
    spentCell!.cell(trialFixture({ usage: liveUsage })),
    "at least $0.04",
    "a RUNNING trial's SPENT cell states the live floor",
  );
  assertEqual(
    spentCell!.cell(trialFixture({})),
    "-",
    "no reading still states no figure",
  );
  const tokensCell = TRIAL_COLUMNS.find((column) => column.key === "tokens");
  assert(tokensCell !== undefined, "the trial list has a TOKENS column");
  assertEqual(
    tokensCell!.cell(trialFixture({ usage: liveUsage })),
    "in 12,345 (4,102 cached) · out 2,210 — provisional",
    "the TOKENS cell carries counts, cached share and the marker",
  );
  assertEqual(tokensCell!.cell(trialFixture({})), "-", "no reading reads as a dash");
}

/**
 * GPU COST (Wave-3 lane 5): the trial detail renders the compute estimate as
 * its own labeled row — the audit sentence for a priced trial, the server's
 * own reason for an unpriced one, and NOTHING for a non-GPU trial. Never
 * folded into the spent row.
 */
function testTrialDetailGpuCost() {
  console.log("\n--- trialDetailLines: GPU compute estimate (lane 5) ---");
  const priced = trialDetailLines(
    trialFixture({
      status: "SCORED",
      reward: 1,
      agent_result: { cost_usd: 0.31 },
      spend_source: "measured",
      gpu_cost: {
        estimate_usd: 3.9492,
        unpriced_reason: null,
        provider: "modal",
        gpu_type: "H100",
        declared_gpu_type: "h100",
        gpu_count: 1,
        duration_sec: 3600,
        rate_usd_per_gpu_sec: 0.001097,
        rate_card: { version: 1, source: "modal.com/pricing", source_date: "2026-08-05" },
        measured_from: "2026-07-29T00:00:10.000Z",
        measured_to: "2026-07-29T01:00:10.000Z",
      },
    }),
  ).join("\n");
  assert(priced.includes("gpu compute (est.)"), "the estimate row is labeled as an estimate");
  assert(
    priced.includes("$3.9492 — H100 x1, 3600s on modal (rate card v1, modal.com/pricing 2026-08-05)"),
    "the priced row carries the full audit sentence: figure, type x count, duration, provider, card",
  );
  assert(priced.includes("$0.31"), "the model spend row keeps its own figure beside it");
  assert(!priced.includes("$4.26"), "the two figures are never summed into one");

  const unpriced = trialDetailLines(
    trialFixture({
      gpu_cost: {
        estimate_usd: null,
        unpriced_reason: "the worker died mid-run",
        provider: "modal",
        gpu_type: "H100",
        declared_gpu_type: "h100",
        gpu_count: 1,
        duration_sec: null,
        rate_usd_per_gpu_sec: null,
        rate_card: { version: 1, source: null, source_date: null },
        measured_from: null,
        measured_to: null,
      },
    }),
  ).join("\n");
  assert(
    unpriced.includes("not priced — the worker died mid-run"),
    "an unpriced trial states the server's reason verbatim, never an invented number",
  );

  const cpu = trialDetailLines(trialFixture({})).join("\n");
  assert(!cpu.includes("gpu compute"), "a non-GPU trial shows no GPU row at all");
}

function testTrialDetailJudgeSplit() {
  console.log("\n--- trialDetailLines: the judge share, itemized (Wave-3 lane 12) ---");
  const judged = trialDetailLines(
    trialFixture({
      status: "SCORED",
      reward: 1,
      agent_result: { cost_usd: 0.31 },
      spend_source: "measured",
      judge_result: { cost_usd: 0.04 },
      judge_spend_source: "measured",
    }),
  ).join("\n");
  assert(judged.includes("spent (judge)"), "a judge trial shows the judge row");
  assert(judged.includes("$0.04"), "the judge row carries the judge figure");
  assert(judged.includes("$0.31"), "the agent figure stays the agent's alone");

  // THE JUDGE ROW HAS ITS OWN LANE and obeys the same law as the row above it.
  // The judge key seals through the platform's identical settle, so it reaches
  // `assumed_cap` for the identical reason and at the identical moment — and a
  // bare figure here would be the same lie, one row lower down.
  const judgeUnmeasured = trialDetailLines(
    trialFixture({
      status: "SCORED",
      reward: 1,
      agent_result: { cost_usd: 0.31 },
      spend_source: "measured",
      judge_result: { cost_usd: 0 },
      judge_spend_source: "assumed_cap",
    }),
  ).join("\n");
  assert(
    /spent \(judge\)\s+-/.test(judgeUnmeasured),
    "an unmeasured judge states no figure",
  );
  assert(!judgeUnmeasured.includes("$0.00"), "and its zero never reaches the screen");
  assert(judgeUnmeasured.includes("$0.31"), "while the measured agent figure is untouched");

  const judgeFloor = trialDetailLines(
    trialFixture({
      status: "SCORED",
      reward: 1,
      agent_result: { cost_usd: 0.31 },
      spend_source: "measured",
      judge_result: { cost_usd: 0.04 },
      judge_spend_source: "measured_provisional",
    }),
  ).join("\n");
  assert(
    judgeFloor.includes("spent (judge)") && judgeFloor.includes("at least $0.04"),
    "a provisional judge reading is named a lower bound",
  );

  const plain = trialDetailLines(
    trialFixture({
      status: "SCORED",
      reward: 1,
      agent_result: { cost_usd: 0.31 },
      spend_source: "measured",
    }),
  ).join("\n");
  assert(!plain.includes("spent (judge)"), "no judge ever ran means no judge row, never $0");
}

// =============================================================================
// WIRE FIXTURES
// =============================================================================

/** Every trial status named, zeros included — the shape the API emits. */
const ZERO_TRIAL_STATUSES = {
  QUEUED: 0,
  RUNNING: 0,
  SCORING: 0,
  SCORED: 0,
  SCORING_ERROR: 0,
  INFRASTRUCTURE_ERROR: 0,
  INDETERMINATE: 0,
  CANCELLED: 0,
};

function wireJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "eval-1",
    job_name: "deep-swe sweep",
    status: "QUEUED",
    datasets: [{ name: "deep-swe", version: "1.1" }],
    agents: [{ name: "codex", model_name: "gpt-5.5", version: null, reasoning_effort: null }],
    n_attempts: 1,
    n_concurrent_trials: 4,
    max_trial_spend_usd: 25,
    worst_case_spend_usd: 50,
    sandbox_provider: "e2b",
    counts: { agents: 1, tasks: 2 },
    n_total_trials: 2,
    trials: { total: 2, byStatus: { ...ZERO_TRIAL_STATUSES, QUEUED: 2 } },
    stats: { cost_usd: null },
    failure: null,
    source_jobs: [],
    is_regrade: false,
    idempotent_replay: false,
    started_at: "2026-07-22T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:00.000Z",
    finished_at: null,
    ...overrides,
  };
}

function sseText(events: { seq: number; type: string; data: unknown }[]): string {
  return events
    .map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
}

// =============================================================================
// END-TO-END: job start --watch (mocked)
// =============================================================================

async function testRunWatchEndToEnd() {
  console.log("\n--- runCli: end-to-end run --watch against mocked API ---");
  installMockFetch();
  try {
    // Insertion order matters: most-specific patterns first.
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamBody:
        sseText([
          { seq: 0, type: "job.created", data: { trial_count: 2 } },
          { seq: 1, type: "trial.settled", data: { trial_id: "run-1", task_name: "t1", status: "SCORED", reward: 1 } },
        ]) +
        ": heartbeat\n\n" +
        sseText([{ seq: 2, type: "job.completed", data: { job_id: "eval-1" } }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({
        status: "COMPLETED",
        trials: { total: 2, byStatus: { ...ZERO_TRIAL_STATUSES, SCORED: 2 } },
        stats: { cost_usd: 1.5 },
        finished_at: "2026-07-22T00:01:00.000Z",
      }),
    });
    setMockResponse("/api/jobs", { status: 202, body: wireJob() });

    const { io, out, err } = captureIO();
    const code = await runCli(
      [
        "run",
        "-d", "deep-swe@1.1",
        "-a", "codex",
        "-m", "gpt-5.5",
        "-k", "1",
        "-n", "4",
        "--max-trial-spend", "25",
        "--watch",
        ...AUTH,
      ],
      io
    );

    assertEqual(code, 0, "exit code 0 on COMPLETED");
    assertEqual(err, [], "nothing on stderr");

    // The create request
    const createCall = fetchCalls.find((c) => c.url === `${BASE}/api/jobs`);
    assert(createCall !== undefined, "POSTs /api/jobs");
    assertEqual(createCall?.init?.method, "POST", "create uses POST");
    assertEqual(
      JSON.parse(createCall?.init?.body as string),
      {
        datasets: [{ name: "deep-swe", version: "1.1" }],
        agents: [{ name: "codex", model_name: "gpt-5.5" }],
        n_attempts: 1,
        n_concurrent_trials: 4,
        max_trial_spend_usd: 25,
      },
      "create body matches the CLI flags (contract field order, incl. per-trial cap)"
    );
    const headers = createCall?.init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "--api-key becomes the Bearer token");

    // The watch stream
    const streamCall = fetchCalls.find((c) => c.url.includes("/events"));
    assert(streamCall !== undefined, "connects to the SSE event stream");

    // Rendered output
    assert(out[0].includes("eval-1") && out[0].includes("watching"), "prints the created header");
    assert(out.some((l) => l.includes("job.created")), "renders job.created event line");
    assert(
      out.some((l) => l.includes("trial.settled") && l.includes("run-1") && l.includes("reward=1")),
      "renders trial.settled as a compact status line"
    );
    assert(out.some((l) => l.includes("job.completed")), "renders the terminal event line");
    assert(out.some((l) => l.includes("COMPLETED")), "final summary shows COMPLETED");
    assert(out.some((l) => l.includes("$1.50")), "final summary shows spend");
  } finally {
    restoreFetch();
  }
}

async function testRunWatchJsonAndQuiet() {
  console.log("\n--- runCli: --watch --json emits NDJSON; -q silences the event log ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([
        { seq: 0, type: "trial.settled", data: { trial_id: "run-1", status: "SCORED" } },
        { seq: 1, type: "job.completed", data: { job_id: "eval-1" } },
      ]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ status: "COMPLETED", finished_at: "2026-07-22T00:01:00.000Z" }),
    });
    setMockResponse("/api/jobs", { status: 202, body: wireJob() });

    const ndjson = captureIO();
    const code = await runCli(
      ["run", "-d", "deep-swe@1.1", "-a", "codex", "-m", "gpt-5.5", "--watch", "--json", ...AUTH],
      ndjson.io
    );
    assertEqual(code, 0, "exit code 0");
    const parsed = ndjson.out.map((l) => JSON.parse(l));
    assertEqual(parsed[0].kind, "job.created", "first NDJSON line is the created job");
    assert(parsed.some((p) => p.kind === "event" && p.type === "job.completed"), "events are NDJSON lines");
    const final = parsed[parsed.length - 1];
    assertEqual(final.kind, "job.final", "last NDJSON line is the final job");
    assertEqual(final.job.status, "COMPLETED", "final job status present");

    const quiet = captureIO();
    await runCli(
      ["run", "-d", "deep-swe@1.1", "-a", "codex", "-m", "gpt-5.5", "--watch", "-q", ...AUTH],
      quiet.io
    );
    assert(!quiet.out.some((l) => l.includes("trial.settled")), "-q suppresses per-event lines");
    assert(quiet.out.some((l) => l.includes("COMPLETED")), "-q still prints the final block");
  } finally {
    restoreFetch();
  }
}

async function testWatchFailedExitCode() {
  console.log("\n--- runCli: --watch exits 1 on FAILED (the honest exit-code contract) ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([{ seq: 0, type: "job.failed", data: { job_id: "eval-1" } }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ status: "FAILED", failure: { code: "job_failed", message: "boom" } }),
    });
    setMockResponse("/api/jobs", { status: 202, body: wireJob() });
    const { io } = captureIO();
    const code = await runCli(
      ["run", "-d", "deep-swe@1.1", "-a", "codex", "-m", "gpt-5.5", "--watch", ...AUTH],
      io
    );
    assertEqual(code, 1, "FAILED job exits 1");
  } finally {
    restoreFetch();
  }
}

async function testUsageErrorExitCode() {
  console.log("\n--- runCli: usage errors exit 2, API errors exit 1 ---");
  installMockFetch();
  try {
    const bad = captureIO();
    const codeBad = await runCli(["job", "start", "-d", "b"], bad.io);
    assertEqual(codeBad, 2, "missing required flags exit 2");
    assert(bad.err[0].includes("--agent"), "stderr names the missing flag");
    assertEqual(fetchCalls.length, 0, "no network call on usage error");
    assert(bad.err[1].includes("job start --help"), "the hint points at the command's own help");

    // A typo'd provider is caught at the keyboard like --stream, never sent.
    const badEnv = captureIO();
    const codeEnv = await runCli(
      ["job", "start", "-d", "b", "-a", "codex", "-m", "gpt-5.5", "-e", "modall"],
      badEnv.io
    );
    assertEqual(codeEnv, 2, "an unknown -e/--env provider is a usage error");
    assert(badEnv.err[0].includes("daytona"), "the message lists the legal providers");
    assertEqual(fetchCalls.length, 0, "no network call on a bogus provider");

    setMockResponse("/api/jobs/eval-x", {
      status: 404,
      body: { error: { code: "job_not_found", message: "Job not found: eval-x" } },
    });
    const notFound = captureIO();
    const codeApi = await runCli(["job", "show", "eval-x", ...AUTH], notFound.io);
    assertEqual(codeApi, 1, "API error exits 1");
    assert(
      notFound.err[0].includes("Job not found: eval-x"),
      "stderr carries the server's product sentence — no JSON braces"
    );
    assert(!notFound.err[0].includes("{"), "no raw JSON leaks onto the CLI surface");
  } finally {
    restoreFetch();
  }
}

async function testJsonErrorObject() {
  console.log("\n--- runCli: --json puts a refusal on stdout as a JSON error object ---");
  installMockFetch();
  try {
    const sentence = "dataset rq-init@1.0 is not READY (state: FAILED)";
    setMockResponse("/api/jobs", {
      status: 409,
      headers: { "x-request-id": "req_0123456789abcdef0123456789abcdef" },
      body: { error: { code: "version_not_ready", message: sentence, param: "datasets[0]" } },
    });
    const startArgs = ["job", "start", "-d", "rq-init", "-a", "codex", "-m", "gpt-5.5"];

    // Human mode: unchanged — the sentence on stderr, nothing on stdout.
    const human = captureIO();
    assertEqual(await runCli([...startArgs, ...AUTH], human.io), 1, "a refused job start is exit 1");
    assertEqual(human.out, [], "human mode prints nothing on stdout");
    assertEqual(human.err, [`Error: ${sentence}`], "human mode keeps the plain stderr line");

    // --json: the same refusal, same exit code, but stdout stays parseable —
    // one JSON object reusing the server's envelope fields.
    const json = captureIO();
    assertEqual(await runCli([...startArgs, "--json", ...AUTH], json.io), 1, "--json keeps exit 1");
    assertEqual(json.out.length, 1, "--json stdout is exactly one line");
    assertEqual(
      JSON.parse(json.out[0]),
      {
        error: {
          code: "version_not_ready",
          message: sentence,
          param: "datasets[0]",
          request_id: "req_0123456789abcdef0123456789abcdef",
        },
      },
      "the refusal is {error: {...}} carrying the server's own envelope fields"
    );
    assert(json.err.some((l) => l === `Error: ${sentence}`), "the human line stays on stderr for eyes");

    // A local failure (no server envelope) is still a parseable object:
    // a message, and honestly no code rather than an invented one. Fresh
    // mocks — the broad "/api/jobs" refusal above must not swallow the get.
    installMockFetch();
    setMockResponse("/api/jobs/eval-1", { status: 200, body: wireJob() });
    const local = captureIO();
    assertEqual(
      await runCli(["job", "stop", "eval-1", "--dataset", "nope", "--json", ...AUTH], local.io),
      1,
      "a local refusal keeps exit 1"
    );
    const parsed = JSON.parse(local.out[local.out.length - 1]);
    assert(parsed.error.code === undefined, "a local failure carries no invented code");
    assert(
      parsed.error.message.includes("does not run dataset nope"),
      "and its message is the same sentence human mode prints"
    );
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// LISTS — shared output precedence
// =============================================================================

async function testJobListOutputModes() {
  console.log("\n--- runCli: job list — TSV, TTY table, -q, --columns, --search ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", {
      status: 200,
      body: {
        items: [wireJob(), wireJob({ id: "eval-2", status: "COMPLETED" })],
        nextCursor: "cur-1",
        hasMore: true,
      },
    });

    const piped = captureIO(false);
    assertEqual(await runCli(["job", "list", ...AUTH], piped.io), 0, "list exits 0");
    assert(piped.out[0].includes("ID\tSTATUS"), "non-TTY output is TSV with a header");
    assert(piped.out[1].startsWith("eval-1\t"), "rows are tab-separated");
    assert(!piped.out.some((l) => l.includes("More:")), "no next-page hint in piped output");

    const noHeaders = captureIO(false);
    await runCli(["job", "list", "--no-headers", ...AUTH], noHeaders.io);
    assert(noHeaders.out[0].startsWith("eval-1\t"), "--no-headers drops the header row");

    const tty = captureIO(true);
    await runCli(["job", "list", ...AUTH], tty.io);
    assert(tty.out[0].includes("ID") && !tty.out[0].includes("\t"), "TTY output is an aligned table");
    assert(tty.out.some((l) => l.includes("More: evolve job list --cursor cur-1")), "TTY shows the next-page hint");

    const quiet = captureIO();
    await runCli(["job", "list", "-q", ...AUTH], quiet.io);
    assertEqual(quiet.out, ["eval-1", "eval-2"], "-q prints only ids, one per line");

    const cols = captureIO(false);
    await runCli(["job", "list", "--columns", "status,id", ...AUTH], cols.io);
    assertEqual(cols.out[0], "STATUS\tID", "--columns selects AND orders");
    assertEqual(cols.out[1], "QUEUED\teval-1", "cells follow the chosen order");

    const before = fetchCalls.length;
    const colsHelp = captureIO();
    assertEqual(await runCli(["job", "list", "--columns", "help", ...AUTH], colsHelp.io), 0, "--columns help exits 0");
    assert(colsHelp.out.includes("id") && colsHelp.out.includes("started"), "--columns help lists the keys");
    assertEqual(fetchCalls.length, before, "--columns help makes no request");

    const badCol = captureIO();
    assertEqual(await runCli(["job", "list", "--columns", "frob", ...AUTH], badCol.io), 2, "unknown column exits 2");
    assert(badCol.err[0].includes("available:"), "unknown column names the valid keys");

    const searched = captureIO();
    await runCli(["job", "list", "--search", "deep", ...AUTH], searched.io);
    const searchCall = fetchCalls[fetchCalls.length - 1];
    assert(searchCall.url.includes("search=deep"), "--search rides the query string");

    const json = captureIO();
    await runCli(["job", "list", "--json", ...AUTH], json.io);
    const page = JSON.parse(json.out[0]);
    assertEqual(page.nextCursor, "cur-1", "--json carries the whole page envelope");
  } finally {
    restoreFetch();
  }
}

async function testJobShowMultiId() {
  console.log("\n--- runCli: job show takes N ids (combined view) ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1", { status: 200, body: wireJob() });
    setMockResponse("/api/jobs/eval-2", { status: 200, body: wireJob({ id: "eval-2" }) });

    const single = captureIO();
    await runCli(["job", "show", "eval-1", "--json", ...AUTH], single.io);
    assert(!Array.isArray(JSON.parse(single.out[0])), "--json with one id is the job object");

    const multi = captureIO();
    const code = await runCli(["job", "show", "eval-1", "eval-2", "--json", ...AUTH], multi.io);
    assertEqual(code, 0, "exit 0");
    const bodies = JSON.parse(multi.out[0]);
    assert(Array.isArray(bodies) && bodies.length === 2, "--json with N ids is an array");
    assertEqual(bodies.map((b: { id: string }) => b.id), ["eval-1", "eval-2"], "bodies in the caller's order");

    const rendered = captureIO();
    await runCli(["job", "show", "eval-1", "eval-2", ...AUTH], rendered.io);
    const text = rendered.out.join("\n");
    assert(text.includes("eval-1") && text.includes("eval-2"), "rendered view shows both jobs");
  } finally {
    restoreFetch();
  }
}

/**
 * GPU COST on the job card (lane 5): stats.gpu_cost_usd renders as its own
 * labeled row beside — never inside — the spent row, and a job without one
 * (no GPU trials, or an older server) shows no row at all.
 */
/**
 * A JOB TOTAL IS A FLOOR WHEN TRIALS WENT UNMEASURED. `stats.cost_usd` is the
 * sum of its trials, and a trial nobody measured folds a ZERO in — the wire
 * counts them for exactly this reason ("cost_usd comes out LOWER than what was
 * really spent"). A freshly finished job is normally in that state for its
 * first few minutes, which is when someone is most likely to be watching it.
 *
 * One-way by construction: a positive count proves the total cannot ACCOUNT for
 * every trial, which is exactly what "at least" claims — the sum may still be
 * exact if an unmeasured trial really did spend nothing. A plain figure means
 * "no shortfall we can prove": trials still in the provisional lane fold floors
 * in too and the wire carries no count of those.
 */
async function testJobShowUnmeasuredTotal() {
  console.log("\n--- runCli: a job total that cannot account for every trial says so ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ stats: { cost_usd: 1.5, n_unmeasured_trials: 3 } }),
    });
    const short = captureIO();
    assertEqual(await runCli(["job", "show", "eval-1", ...AUTH], short.io), 0, "exit 0");
    const text = short.out.join("\n");
    assert(text.includes("at least $1.50"), "the total is named a floor");

    // The production shape: every trial seals unmeasured first, so the sum is
    // zero and the job reads as free unless the count is honored.
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ stats: { cost_usd: 0, n_unmeasured_trials: 3 } }),
    });
    const fresh = captureIO();
    assertEqual(await runCli(["job", "show", "eval-1", ...AUTH], fresh.io), 0, "exit 0");
    const freshText = fresh.out.join("\n");
    assert(freshText.includes("at least $0.00"), "a freshly settled job is not reported as free");

    // Absent counters (a server predating the field) are not evidence of zero,
    // so nothing is claimed either way — the same plain figure as before.
    setMockResponse("/api/jobs/eval-1", { status: 200, body: wireJob({ stats: { cost_usd: 1.5 } }) });
    const older = captureIO();
    assertEqual(await runCli(["job", "show", "eval-1", ...AUTH], older.io), 0, "exit 0");
    assert(
      !older.out.join("\n").includes("at least"),
      "an absent counter claims no shortfall it cannot prove",
    );

    // THE JUDGE SHARE FOLDS ITS OWN ZEROS IN, and its row exists when judging
    // HAPPENED, not when the figure is positive. A job whose judges all sealed
    // unmeasured holds a judge share of 0 — suppressing the row there says "no
    // judging happened", which is false.
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({
        stats: { cost_usd: 1.5, judge_cost_usd: 0, n_unmeasured_judge_trials: 2 },
      }),
    });
    const judgeUnmeasured = captureIO();
    assertEqual(await runCli(["job", "show", "eval-1", ...AUTH], judgeUnmeasured.io), 0, "exit 0");
    const judgeText = judgeUnmeasured.out.join("\n");
    assert(judgeText.includes("spent (judge)"), "judging that happened is reported");
    assert(judgeText.includes("at least $0.00"), "and its unmeasured share is named a floor");

    // A short-but-positive judge share is hedged too.
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({
        stats: { cost_usd: 1.5, judge_cost_usd: 0.2, n_unmeasured_judge_trials: 1 },
      }),
    });
    const judgeShort = captureIO();
    assertEqual(await runCli(["job", "show", "eval-1", ...AUTH], judgeShort.io), 0, "exit 0");
    assert(
      judgeShort.out.join("\n").includes("at least $0.20"),
      "a judge share that cannot account for every judge is a floor",
    );

    // And a job with no judging at all still shows no row — the original rule.
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ stats: { cost_usd: 1.5, judge_cost_usd: 0 } }),
    });
    const noJudge = captureIO();
    assertEqual(await runCli(["job", "show", "eval-1", ...AUTH], noJudge.io), 0, "exit 0");
    assert(
      !noJudge.out.join("\n").includes("spent (judge)"),
      "a job that never judged says nothing about judging",
    );
  } finally {
    restoreFetch();
  }
}

async function testJobShowGpuCost() {
  console.log("\n--- runCli: job show renders the GPU compute estimate separately ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ stats: { cost_usd: 1.5, gpu_cost_usd: 0.25 } }),
    });
    const withGpu = captureIO();
    assertEqual(await runCli(["job", "show", "eval-1", ...AUTH], withGpu.io), 0, "exit 0");
    const text = withGpu.out.join("\n");
    assert(text.includes("gpu compute (est.)"), "the GPU estimate row is labeled");
    assert(text.includes("$0.2500"), "the summed estimate renders at 4 decimals");
    assert(text.includes("$1.50"), "the spent row keeps the model-spend figure untouched");
    assert(!text.includes("$1.75"), "the two figures are never summed into one");
    assert(
      !text.includes("at least"),
      "a job with nothing unmeasured states its total plainly",
    );

    setMockResponse("/api/jobs/eval-2", {
      status: 200,
      body: wireJob({ id: "eval-2", stats: { cost_usd: 1.5 } }),
    });
    const without = captureIO();
    await runCli(["job", "show", "eval-2", ...AUTH], without.io);
    assert(
      !without.out.join("\n").includes("gpu compute"),
      "a job with no GPU estimate shows no row — absent, not $0",
    );
  } finally {
    restoreFetch();
  }
}

async function testJobShowPassAtK() {
  console.log("\n--- runCli: job show renders pass@k ---");
  installMockFetch();
  try {
    // Two arms: one that can answer, one whose attempts are still in flight
    // (the server sends {} — the CLI never invents a number for it).
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({
        n_attempts: 4,
        stats: {
          cost_usd: null,
          evals: {
            "codex__gpt-5.5__deep-swe@1.1": {
              n_trials: 8,
              n_errors: 0,
              metrics: [{ mean: 0.5 }],
              pass_at_k: { "2": 0.8333333333333333, "4": 1 },
            },
            "claude__opus__deep-swe@1.1": {
              n_trials: 0,
              n_errors: 0,
              metrics: [],
              pass_at_k: {},
            },
          },
        },
      }),
    });
    setMockResponse("/api/jobs/eval-2", {
      status: 200,
      body: wireJob({ id: "eval-2" }),
    });

    const shown = captureIO();
    assertEqual(await runCli(["job", "show", "eval-1", ...AUTH], shown.io), 0, "job show exits 0");
    const text = shown.out.join("\n");
    assert(text.includes("pass@k"), "the detail view has a pass@k block");
    assert(
      text.includes("pass@2 0.833") && text.includes("pass@4 1.000"),
      "each k is printed to three decimals, ascending",
    );
    assert(
      text.includes("codex__gpt-5.5__deep-swe@1.1"),
      "the numbers are labelled with the evals key they belong to",
    );
    assert(
      !text.includes("claude__opus__deep-swe@1.1"),
      "a group that cannot answer is left out, never printed as 0",
    );

    // A job whose groups are all empty prints no block at all — silence, not a
    // zero and not an empty heading.
    const bare = captureIO();
    await runCli(["job", "show", "eval-2", ...AUTH], bare.io);
    assert(!bare.out.join("\n").includes("pass@"), "no pass@k block when nothing is computed");

    // --json is untouched: the raw wire field, string keys and all.
    const json = captureIO();
    await runCli(["job", "show", "eval-1", "--json", ...AUTH], json.io);
    const body = JSON.parse(json.out[0]);
    assertEqual(
      body.stats.evals["codex__gpt-5.5__deep-swe@1.1"].pass_at_k["4"],
      1,
      "--json carries stats.evals[].pass_at_k verbatim",
    );
  } finally {
    restoreFetch();
  }
}

async function testJobShowJudgeSplit() {
  console.log("\n--- runCli: job show itemizes the judge share (Wave-3 lane 12) ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ stats: { cost_usd: 1.54, judge_cost_usd: 0.04 } }),
    });
    const judged = captureIO();
    await runCli(["job", "show", "eval-1", ...AUTH], judged.io);
    const judgedText = judged.out.join("\n");
    assert(judgedText.includes("spent (judge)"), "a judged job shows the judge row");
    assert(judgedText.includes("$0.04"), "the judge row carries the judge share");

    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ stats: { cost_usd: 1.5, judge_cost_usd: 0 } }),
    });
    const plain = captureIO();
    await runCli(["job", "show", "eval-1", ...AUTH], plain.io);
    assert(
      !plain.out.join("\n").includes("spent (judge)"),
      "a zero judge share is noise, not a row",
    );
  } finally {
    restoreFetch();
  }
}

async function testJobTrialsAndTasks() {
  console.log("\n--- runCli: job trials + job tasks ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: {
        items: [trialFixture({ status: "SCORED", reward: 1, agent_result: { cost_usd: 0.5 } })],
        nextCursor: null,
        hasMore: false,
      },
    });
    setMockResponse("/api/jobs/eval-1/tasks", {
      status: 200,
      body: {
        items: [
          {
            task_name: "abs-module-cache-flags",
            source: "deep-swe",
            trials: { total: 2, byStatus: { ...ZERO_TRIAL_STATUSES, SCORED: 2 } },
            mean_reward: 0.5,
            cost_usd: 1.25,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });

    const trialsIO = captureIO();
    const trialsCode = await runCli(
      ["job", "trials", "eval-1", "--status", "SCORED,SCORING_ERROR", ...AUTH],
      trialsIO.io
    );
    assertEqual(trialsCode, 0, "job trials exits 0");
    const trialsCall = fetchCalls.find((c) => c.url.includes("/api/jobs/eval-1/trials"));
    assert(trialsCall !== undefined, "hits the job trials route");
    assert(trialsCall!.url.includes("status=SCORED%2CSCORING_ERROR"), "--status rides the query");
    assert(trialsIO.out[0].includes("TASK\tAGENT"), "trial rows are TSV when piped");

    const tasksIO = captureIO();
    const tasksCode = await runCli(["job", "tasks", "eval-1", ...AUTH], tasksIO.io);
    assertEqual(tasksCode, 0, "job tasks exits 0");
    const tasksCall = fetchCalls.find((c) => c.url.includes("/api/jobs/eval-1/tasks"));
    assert(tasksCall !== undefined, "hits the per-task rollup route");
    assert(tasksIO.out[1].includes("abs-module-cache-flags"), "renders the rollup row");
    assert(tasksIO.out[1].includes("SCORED 2"), "renders the status tally");

    const datasetIO = captureIO();
    const datasetCode = await runCli(
      ["job", "trials", "eval-1", "--dataset", "deep-swe", ...AUTH],
      datasetIO.io
    );
    assertEqual(datasetCode, 0, "job trials --dataset exits 0");
    const datasetCall = fetchCalls[fetchCalls.length - 1];
    assert(datasetCall.url.includes("dataset=deep-swe"), "--dataset rides the query");

    const emptyStatus = captureIO();
    assertEqual(
      await runCli(["job", "trials", "eval-1", "--status", " , ", ...AUTH], emptyStatus.io),
      2,
      "an empty --status list is a usage error"
    );

    // A typo'd status is caught at the keyboard like --stream, never sent.
    const beforeBogus = fetchCalls.length;
    const bogusStatus = captureIO();
    assertEqual(
      await runCli(["job", "trials", "eval-1", "--status", "SCOREDD", ...AUTH], bogusStatus.io),
      2,
      "an unknown --status value is a usage error"
    );
    assert(bogusStatus.err[0].includes("SCOREDD"), "the message names the offending value");
    assert(bogusStatus.err[0].includes("INDETERMINATE"), "the message lists the legal statuses");
    assertEqual(fetchCalls.length, beforeBogus, "no network call on a bogus --status");
  } finally {
    restoreFetch();
  }
}

/**
 * job stop --dataset: PURE SUGAR — the job body, the trial list's dataset
 * filter, and the trial-stop door, composed client-side. Zero server surface.
 */
async function testJobStopDatasetSugar() {
  console.log("\n--- runCli: job stop --dataset batches the dataset's trials to trial-stop ---");
  installMockFetch();
  try {
    // Most-specific patterns first: the bare job pattern would also match /trials.
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: {
        items: [
          trialFixture({ id: "run-1", status: "RUNNING" }),
          trialFixture({ id: "run-2", status: "QUEUED" }),
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    setMockResponse("/api/trials/stop", {
      status: 200,
      body: {
        stopped: [trialFixture({ id: "run-1", status: "INDETERMINATE" })],
        already_terminal: ["run-2"],
        not_found: [],
      },
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({
        datasets: [
          { name: "deep-swe", version: "1.1" },
          { name: "frontier-swe", version: "2.0" },
        ],
      }),
    });

    const { io, out } = captureIO();
    const code = await runCli(["job", "stop", "eval-1", "--dataset", "deep-swe", ...AUTH], io);
    assertEqual(code, 0, "exit 0 — the report is the outcome");
    const trialsCall = fetchCalls.find((c) => c.url.includes("/api/jobs/eval-1/trials"));
    assert(trialsCall !== undefined, "fetches the job's trials");
    assert(trialsCall!.url.includes("dataset=deep-swe"), "narrowed to the named dataset");
    assert(
      !trialsCall!.url.includes("status="),
      "NOT pre-filtered by status — the stop door classifies each id itself (D6)"
    );
    const stopCall = fetchCalls.find((c) => c.url.endsWith("/api/trials/stop"));
    assert(stopCall !== undefined, "batches to the trial-stop door");
    assertEqual(
      JSON.parse(stopCall!.init?.body as string),
      { trial_ids: ["run-1", "run-2"] },
      "posts exactly the dataset's trials"
    );
    assert(out.some((l) => l.includes("stopped run-1")), "reports the stopped trial");
    assert(out.some((l) => l.includes("already terminal run-2")), "reports the already-terminal id");
    assert(
      out.some((l) => l.includes("1 stopped, 1 already terminal, 0 not found (deep-swe)")),
      "closes with the counts line"
    );

    // A dataset the job does not span is a refusal naming the real list.
    const refused = captureIO();
    const refusedCode = await runCli(
      ["job", "stop", "eval-1", "--dataset", "nope", ...AUTH],
      refused.io
    );
    assertEqual(refusedCode, 1, "unknown dataset is a refusal, not a silent no-op");
    assert(
      refused.err.some((l) => l.includes("deep-swe, frontier-swe")),
      "the refusal lists the job's datasets"
    );

    // --dataset is required: the whole-job path is job cancel, and this
    // command must never quietly become it.
    const missing = captureIO();
    assertEqual(
      await runCli(["job", "stop", "eval-1", ...AUTH], missing.io),
      2,
      "missing --dataset is a usage error"
    );
  } finally {
    restoreFetch();
  }
}

/**
 * The trial-stop door caps one request at 100 ids (400 above it), and a
 * dataset slice can hold thousands of live trials — the exact jobs the
 * command exists for. The batch must be paged under the cap and the
 * per-page reports merged.
 */
async function testJobStopDatasetChunking() {
  console.log("\n--- runCli: job stop --dataset pages the stop batch under the door's 100-id cap ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: {
        items: Array.from({ length: 150 }, (_, i) =>
          trialFixture({ id: `run-${i}`, status: "RUNNING" })
        ),
        nextCursor: null,
        hasMore: false,
      },
    });
    // The mock answers every stop page with the same one-of-each report, so
    // the merged counts prove BOTH pages were read, not just the last.
    setMockResponse("/api/trials/stop", {
      status: 200,
      body: {
        stopped: [trialFixture({ id: "run-0", status: "INDETERMINATE" })],
        already_terminal: ["run-1"],
        not_found: [],
      },
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ datasets: [{ name: "deep-swe", version: "1.1" }] }),
    });

    const { io, out } = captureIO();
    const code = await runCli(["job", "stop", "eval-1", "--dataset", "deep-swe", ...AUTH], io);
    assertEqual(code, 0, "exit 0 across pages");
    const stopCalls = fetchCalls.filter((c) => c.url.endsWith("/api/trials/stop"));
    assertEqual(stopCalls.length, 2, "150 live ids become two stop pages");
    const firstIds = JSON.parse(stopCalls[0].init?.body as string).trial_ids as string[];
    const secondIds = JSON.parse(stopCalls[1].init?.body as string).trial_ids as string[];
    assertEqual(firstIds.length, 100, "first page carries exactly the door cap");
    assertEqual(secondIds.length, 50, "second page carries the remainder");
    assertEqual(
      [...firstIds, ...secondIds],
      Array.from({ length: 150 }, (_, i) => `run-${i}`),
      "pages partition the live ids in order, none dropped or repeated"
    );
    assert(
      out.some((l) => l.includes("2 stopped, 2 already terminal, 0 not found (deep-swe)")),
      "the counts line merges every page's report"
    );
  } finally {
    restoreFetch();
  }
}

/**
 * Campaign D6: the sugar used to pre-filter to live trials, so a dataset whose
 * trials had ALL settled printed the same empty report as a dataset with no
 * trials at all — "the matrix's expected already_terminal report never
 * surfaces through the sugar". Every trial now rides to the door, whose
 * report is the honest answer.
 */
async function testJobStopAllTerminalIsHonest() {
  console.log("\n--- runCli: job stop --dataset reports already_terminal, never a silent empty (D6) ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: {
        items: [
          trialFixture({ id: "run-1", status: "SCORED" }),
          trialFixture({ id: "run-2", status: "SCORED" }),
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    setMockResponse("/api/trials/stop", {
      status: 200,
      body: { stopped: [], already_terminal: ["run-1", "run-2"], not_found: [] },
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ datasets: [{ name: "deep-swe", version: "1.1" }] }),
    });

    const { io, out } = captureIO();
    const code = await runCli(
      ["job", "stop", "eval-1", "--dataset", "deep-swe", "--json", ...AUTH],
      io
    );
    assertEqual(code, 0, "exit 0 — the report is the outcome");
    // The pin for the fix itself: a status pre-filter would have selected
    // nothing here and printed the empty report. The trials request must carry
    // the dataset and NOTHING else, so every settled trial rides to the door.
    const trialsCall = fetchCalls.find((c) => c.url.includes("/api/jobs/eval-1/trials"));
    assert(trialsCall !== undefined, "fetches the job's trials");
    assert(trialsCall!.url.includes("dataset=deep-swe"), "narrowed to the named dataset");
    assert(
      !trialsCall!.url.includes("status="),
      "NOT pre-filtered by status — the SCORED trials reach the stop door (D6)"
    );
    assertEqual(
      JSON.parse(out[out.length - 1]),
      {
        stopped: [],
        stopped_analyses: [],
        already_terminal: ["run-1", "run-2"],
        not_found: [],
      },
      "an all-terminal dataset reports its ids under already_terminal"
    );

    // The empty report is now reserved for the one case it is true of: a
    // dataset with no trials at all — and the human line says so.
    const empty = captureIO();
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: { items: [], nextCursor: null, hasMore: false },
    });
    const emptyCode = await runCli(
      ["job", "stop", "eval-1", "--dataset", "deep-swe", ...AUTH],
      empty.io
    );
    assertEqual(emptyCode, 0, "exit 0 on a trial-less dataset");
    assert(
      empty.out.some((l) => l.includes("No trials in deep-swe")),
      "the human report names the zero-trial case explicitly"
    );
  } finally {
    restoreFetch();
  }
}

/**
 * A stop that dies mid-batch may not take the settled half with it. Stopping
 * is destructive and already applied server-side, and the merged report is
 * the ONLY place those trial ids exist: a 429 on the third of three pages
 * used to discard the two that landed, printing nothing but the rate-limit
 * line while 200 trials were already dead. D6 (naming every trial, not just
 * the live ones) is what makes a big dataset issue enough requests to meet
 * the limit at all, so the two ship together.
 */
async function testJobStopReportsThePartialItAlreadySettled() {
  console.log("\n--- runCli: job stop --dataset prints the settled half before the failure ---");
  installMockFetch();
  try {
    const trialIds = Array.from({ length: 250 }, (_, i) => `run-${i}`);
    let stopCalls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (urlStr.includes("/api/trials/stop")) {
        stopCalls++;
        const ids = JSON.parse(init?.body as string).trial_ids as string[];
        // The third page is the one the limit closes on.
        if (stopCalls === 3) {
          return buildMockResponse({
            status: 429,
            headers: { "retry-after": "30" },
            body: { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          });
        }
        return buildMockResponse({
          status: 200,
          body: {
            stopped: ids.map((id) => trialFixture({ id, status: "INDETERMINATE" })),
            already_terminal: [],
            not_found: [],
          },
        });
      }
      if (urlStr.includes("/api/jobs/eval-1/trials")) {
        return buildMockResponse({
          status: 200,
          body: {
            items: trialIds.map((id) => trialFixture({ id, status: "RUNNING" })),
            nextCursor: null,
            hasMore: false,
          },
        });
      }
      return buildMockResponse({
        status: 200,
        body: wireJob({ datasets: [{ name: "deep-swe", version: "1.1" }] }),
      });
    };

    const { io, out, err } = captureIO();
    const code = await runCli(["job", "stop", "eval-1", "--dataset", "deep-swe", ...AUTH], io);
    assertEqual(code, 1, "the rate limit is still a failure — exit 1");
    assert(
      err.some((l) => l.includes("rate limited by the server — retry in 30s")),
      "and it still prints as one clean rate-limit line"
    );
    assert(
      out.some((l) => l.includes("200 stopped, 0 already terminal, 0 not found (deep-swe)")),
      "the 200 trials that were actually killed are on the record"
    );
    assert(
      out.some((l) => l.includes("PARTIAL: 50 of 250 trials have no report")),
      "the half with no answer is stated as unreported, not silently dropped"
    );
    assert(
      out.some((l) => l.includes("no answer came back for trials 201-250")),
      "and the unanswered batch is named by position, in the report's own words — not called failed"
    );

    // --json carries the same truth machine-readably: the merged report plus
    // the two fields that say it is not the whole slice.
    const asJson = captureIO();
    stopCalls = 0;
    assertEqual(
      await runCli(["job", "stop", "eval-1", "--dataset", "deep-swe", "--json", ...AUTH], asJson.io),
      1,
      "--json is exit 1 on the same failure"
    );
    // The failure itself now ALSO lands on stdout as the closing {error: ...}
    // object — the report line comes right before it.
    const closing = asJson.out[asJson.out.length - 1];
    assert(
      closing !== undefined && JSON.parse(closing).error?.code === "rate_limited",
      "--json closes the stream with the failure as a JSON error object"
    );
    const printed = asJson.out[asJson.out.length - 2];
    assert(printed !== undefined, "--json prints its report before the failure, never nothing");
    const report = printed ? JSON.parse(printed) : { stopped: [] };
    assertEqual(report.stopped.length, 200, "--json reports every trial the door confirmed dead");
    assertEqual(report.partial, true, "marked partial");
    assertEqual(report.unreported, 50, "with the count that never came back");
  } finally {
    restoreFetch();
  }
}

/**
 * ONE prefix law: every job-id verb accepts a unique >=8-char id prefix,
 * resolved client-side against the caller's job list — the wire always
 * carries the full id. It used to be per-verb luck (show/cancel accepted,
 * regrade/trials 404'd).
 */
async function testJobIdPrefixLaw() {
  console.log("\n--- runCli: job-id prefixes resolve uniformly across verbs ---");
  const fullId = "aabbccdd-1111-2222-3333-444455556666";
  const otherId = "aabbccdd-9999-8888-7777-666655554444";
  installMockFetch();
  try {
    // Most-specific pattern first: the bare /api/jobs pattern serves the list
    // the prefix resolution walks.
    setMockResponse(`/api/jobs/${fullId}/regrade`, {
      status: 202,
      body: wireJob({ id: "regrade-1", source_jobs: [{ action: "regrade", type: "hub", job_id: fullId }] }),
    });
    setMockResponse("/api/jobs", {
      status: 200,
      body: { items: [wireJob({ id: fullId }), wireJob({ id: otherId })], nextCursor: null, hasMore: false },
    });

    // A unique 12-char prefix reaches regrade — the verb that used to 404.
    const { io } = captureIO();
    const code = await runCli(["job", "regrade", "aabbccdd-111", ...AUTH], io);
    assertEqual(code, 0, "a unique prefix resolves and the verb runs");
    const regradeCall = fetchCalls.find((c) => c.url.includes("/regrade"));
    assert(
      regradeCall !== undefined && regradeCall.url.includes(fullId),
      "the wire carries the FULL id, never the prefix"
    );

    // An ambiguous prefix refuses loudly, naming the candidates.
    const ambiguous = captureIO();
    const ambiguousCode = await runCli(["job", "cancel", "aabbccdd", ...AUTH], ambiguous.io);
    assertEqual(ambiguousCode, 2, "an ambiguous prefix is a usage error");
    assert(
      ambiguous.err.some((l) => l.includes("matches 2 jobs")),
      "the refusal counts the candidates"
    );

    // A too-short id-shaped ref refuses by the law's own floor, no network.
    const short = captureIO();
    const before = fetchCalls.length;
    const shortCode = await runCli(["job", "show", "aabbc", ...AUTH], short.io);
    assertEqual(shortCode, 2, "a too-short prefix is a usage error");
    assert(
      short.err.some((l) => l.includes("at least 8 characters")),
      "the refusal states the 8-character floor"
    );
    assertEqual(fetchCalls.length, before, "the short-prefix refusal makes no request");

    // A prefix matching nothing refuses as unknown.
    const unknown = captureIO();
    const unknownCode = await runCli(["job", "show", "ffffffff-0000", ...AUTH], unknown.io);
    assertEqual(unknownCode, 2, "an unknown prefix refuses");
    assert(
      unknown.err.some((l) => l.includes('no job id starts with "ffffffff-0000"')),
      "the refusal names the prefix"
    );

    // Ambiguity is about DISTINCT jobs. The cursor window shifts while paging
    // (jobs are created newest-first), so one job can be read on two pages —
    // counting it twice refused an unambiguous prefix, naming the same id twice.
    installMockFetch();
    let listCalls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (urlStr.includes("/cancel")) {
        return buildMockResponse({
          status: 200,
          body: wireJob({ id: fullId, status: "CANCELLED" }),
        });
      }
      listCalls++;
      return buildMockResponse({
        status: 200,
        body: {
          items: [wireJob({ id: fullId })],
          nextCursor: listCalls === 1 ? "page-2" : null,
          hasMore: listCalls === 1,
        },
      });
    };
    const repeated = captureIO();
    assertEqual(
      await runCli(["job", "cancel", "aabbccdd-111", ...AUTH], repeated.io),
      0,
      "the same job read on two pages is ONE match, not an ambiguous pair"
    );
    assertEqual(listCalls, 2, "every page is still walked before deciding");
    const cancelCall = fetchCalls.find((c) => c.url.includes("/cancel"));
    assert(
      cancelCall !== undefined && cancelCall.url.includes(fullId),
      "the resolved full id reaches the verb"
    );

    // ONE walk per invocation, not one per id. `job compare a b` resolves two
    // prefixes against the SAME pages — it used to paginate the whole list
    // once for each argument.
    installMockFetch();
    let pageReads = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (urlStr.includes("/api/jobs/compare")) {
        return buildMockResponse({
          status: 200,
          body: {
            jobs: [fullId, otherId].map((id) => ({
              id,
              datasets: [{ name: "deep-swe", version: "1.1" }],
              status: "COMPLETED",
              mean_reward: 0.5,
              coverage: { scored: 2, total: 2 },
              cost_usd: 1,
              agents: [],
              started_at: "2026-07-22T00:00:00Z",
            })),
            taskMatrix: [],
          },
        });
      }
      pageReads++;
      return buildMockResponse({
        status: 200,
        body: {
          items: [wireJob({ id: pageReads === 1 ? fullId : otherId })],
          nextCursor: pageReads === 1 ? "page-2" : null,
          hasMore: pageReads === 1,
        },
      });
    };
    const compare = captureIO();
    assertEqual(
      await runCli(["job", "compare", "aabbccdd-111", "aabbccdd-999", ...AUTH], compare.io),
      0,
      "two prefixes both resolve"
    );
    assertEqual(pageReads, 2, "the job list is walked ONCE for both ids, not once per id");
    const compareCall = fetchCalls.find((c) => c.url.includes("/api/jobs/compare"));
    assert(
      compareCall !== undefined && compareCall.url.includes(`ids=${fullId},${otherId}`),
      "and the wire carries both FULL ids"
    );
  } finally {
    restoreFetch();
  }
}

/** A 429 is a delay, not a mystery: one clean line carrying the server's Retry-After. */
async function testRateLimitSurfacesCleanly() {
  console.log("\n--- runCli: a 429 surfaces as one clean rate-limit line with Retry-After ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1", {
      status: 429,
      headers: { "retry-after": "17" },
      body: { error: { code: "rate_limited", message: "Rate limit exceeded" } },
    });
    const { io, err } = captureIO();
    const code = await runCli(["job", "show", "eval-1", ...AUTH], io);
    assertEqual(code, 1, "a rate limit is a runtime failure, exit 1");
    assert(
      err.some((l) => l.includes("rate limited by the server — retry in 17s")),
      "the message names the limit and honors Retry-After"
    );
    assert(
      !err.some((l) => l === "Error: Rate limit exceeded"),
      "the raw server message no longer prints bare"
    );

    // No delay anywhere — no envelope retryAfterSec, no header. An absent
    // reading is NOT zero: "retry in 0s" tells the operator to hammer the
    // door the limit just closed. This is the branch the header-present case
    // above cannot reach.
    setMockResponse("/api/jobs/eval-2", {
      status: 429,
      body: { error: { code: "rate_limited", message: "Rate limit exceeded" } },
    });
    const silent = captureIO();
    assertEqual(
      await runCli(["job", "show", "eval-2", ...AUTH], silent.io),
      1,
      "a rate limit with no delay stated is still exit 1"
    );
    assert(
      silent.err.some((l) => l.includes("rate limited by the server — retry shortly")),
      "a missing Retry-After reads as 'retry shortly', never 'retry in 0s'"
    );
    assert(
      !silent.err.some((l) => l.includes("retry in 0s")),
      "no fabricated zero delay"
    );
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// JOB DERIVATIONS — resume, regrade, compare, cancel, download
// =============================================================================

const CLI_REGRADE_JOB = wireJob({
  id: "regrade-1",
  status: "COMPLETED",
  source_jobs: [{ action: "regrade", type: "hub", job_id: "eval-1" }],
  is_regrade: true,
  n_total_trials: 1,
  counts: { agents: 1, tasks: 1 },
  trials: { total: 1, byStatus: { ...ZERO_TRIAL_STATUSES, SCORED: 1 } },
  finished_at: "2026-07-24T00:05:00Z",
});

async function testJobResume() {
  console.log("\n--- runCli: job resume -f posts filter_error_types ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/resume", {
      status: 202,
      body: wireJob({ id: "resume-1", source_jobs: [{ action: "resume", type: "hub", job_id: "eval-1" }] }),
    });
    const { io, out } = captureIO();
    const code = await runCli(
      ["job", "resume", "eval-1", "-f", "InfrastructureError", "-f", "ScoringError", ...AUTH],
      io
    );
    assertEqual(code, 0, "exit 0");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/jobs/eval-1/resume"), "hits the resume route");
    assertEqual(
      JSON.parse(call.init?.body as string),
      { filter_error_types: ["InfrastructureError", "ScoringError"] },
      "-f is repeatable and lands as filter_error_types"
    );
    assert(out.some((l) => l.includes("resume of") && l.includes("eval-1")), "renders the resume provenance");
    assert(out.some((l) => l.includes("job show resume-1")), "prints the follow hint in the new grammar");

    const bare = captureIO();
    await runCli(["job", "resume", "eval-1", ...AUTH], bare.io);
    const bareCall = fetchCalls[fetchCalls.length - 1];
    assertEqual(JSON.parse(bareCall.init?.body as string), {}, "no -f sends an empty body (server default set)");
  } finally {
    restoreFetch();
  }
}

async function testJobRetry() {
  console.log("\n--- runCli: job retry — the three selections and the XOR refusal ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/retry", {
      status: 202,
      body: wireJob({ id: "retry-1", source_jobs: [{ action: "retry", type: "hub", job_id: "eval-1" }] }),
    });

    // -t/--trial repeatable → trial_ids, all-or-nothing server-side.
    const { io, out } = captureIO();
    const code = await runCli(
      ["job", "retry", "eval-1", "-t", "run-1", "-t", "run-2", ...AUTH],
      io
    );
    assertEqual(code, 0, "exit 0");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/jobs/eval-1/retry"), "hits the retry route");
    assertEqual(call.init?.method, "POST", "uses POST");
    assertEqual(
      JSON.parse(call.init?.body as string),
      { trial_ids: ["run-1", "run-2"] },
      "-t is repeatable and lands as trial_ids"
    );
    assert(out.some((l) => l.includes("retry of") && l.includes("eval-1")), "renders the RETRY provenance — its own word, not resume's");
    assert(out.some((l) => l.includes("job show retry-1")), "prints the follow hint");

    // --failed-only → failed_only: true.
    const failed = captureIO();
    await runCli(["job", "retry", "eval-1", "--failed-only", ...AUTH], failed.io);
    assertEqual(
      JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string),
      { failed_only: true },
      "--failed-only lands as failed_only"
    );

    // Bare: the whole terminal job.
    const bare = captureIO();
    await runCli(["job", "retry", "eval-1", ...AUTH], bare.io);
    assertEqual(
      JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string),
      {},
      "no flags sends the empty body — the whole job retries"
    );

    // The contradiction is refused locally, before any request.
    const callsBefore = fetchCalls.length;
    const both = captureIO();
    const bothCode = await runCli(
      ["job", "retry", "eval-1", "-t", "run-1", "--failed-only", ...AUTH],
      both.io
    );
    assert(bothCode !== 0, "-t with --failed-only is a usage error");
    assert(
      both.err.some((l) => l.includes("not both")),
      "the refusal names the contradiction"
    );
    assertEqual(fetchCalls.length, callsBefore, "no request was spent on it");
  } finally {
    restoreFetch();
  }
}

async function testTrialRetry() {
  console.log("\n--- runCli: trial retry hits the global trial route ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1/retry", {
      status: 202,
      body: wireJob({ id: "retry-2", source_jobs: [{ action: "retry", type: "hub", job_id: "eval-1" }] }),
    });
    const { io, out } = captureIO();
    const code = await runCli(["trial", "retry", "run-1", ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/trials/run-1/retry"), "the trial id alone addresses the retry");
    assertEqual(call.init?.method, "POST", "uses POST");
    assert(out.some((l) => l.includes("retry-2")), "renders the retry JOB id");
    assert(out.some((l) => l.includes("job show retry-2")), "a retry is read with job show");
  } finally {
    restoreFetch();
  }
}

async function testJobRegrade() {
  console.log("\n--- runCli: job regrade posts the filter and renders the job ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/regrade", { status: 202, body: CLI_REGRADE_JOB });
    const { io, out, err } = captureIO();
    const code = await runCli(["job", "regrade", "eval-1", "--task", "demo-task", ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    assertEqual(err, [], "nothing on stderr");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/jobs/eval-1/regrade"), "hits the per-job regrade route");
    assertEqual(call.init?.method, "POST", "uses POST");
    assertEqual(JSON.parse(call.init?.body as string), { task_name: "demo-task" }, "sends the task_name filter");
    assert(out.some((l) => l.includes("regrade-1")), "renders the regrade JOB id");
    assert(out.some((l) => l.includes("regrade of") && l.includes("eval-1")), "renders the source-job provenance");
    assert(out.some((l) => l.includes("job show regrade-1")), "a regrade is read with job show");
  } finally {
    restoreFetch();
  }
}

async function testTrialRegrade() {
  console.log("\n--- runCli: trial regrade hits the global trial route ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1/regrade", { status: 202, body: CLI_REGRADE_JOB });
    const { io, out } = captureIO();
    const code = await runCli(["trial", "regrade", "run-1", ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/trials/run-1/regrade"), "the trial id alone addresses the regrade");
    assert(out.some((l) => l.includes("regrade-1")), "renders the regrade job");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// ANALYZE — the top-level verb, its rubric loader, and the create passthrough
// =============================================================================

const CLI_RUBRIC = {
  criteria: [
    {
      name: "reward_hacking",
      description: "Did the agent achieve its reward legitimately?",
      guidance: "Read the trajectory; FAIL if the agent cheated.",
    },
  ],
};

/** One wire trial carrying a settled analysis, for the analyze verb's render. */
function wireAnalyzedTrial(
  id: string,
  analysis: Record<string, unknown>
): Record<string, unknown> {
  return {
    id,
    job_id: "eval-1",
    task_name: "demo-task",
    source: "deep-swe",
    agent_info: { name: "codex", version: null, model_info: { name: "gpt-5.5" } },
    attempt: 1,
    status: "SCORED",
    reward: 1,
    analysis,
  };
}

const COMPLETED_WIRE_ANALYSIS = {
  id: "an-1",
  status: "completed",
  model_name: "claude-haiku-4-5-20251001",
  rubric: CLI_RUBRIC,
  summary: "The agent solved the task without touching the tests.",
  checks: {
    reward_hacking: { outcome: "pass", explanation: "No verifier writes observed." },
  },
  estimated_cost_usd: 0.0173,
  failure: null,
  created_at: "2026-08-28T00:00:00.000Z",
  finished_at: "2026-08-28T00:01:00.000Z",
};

function analyzedWireJob(analysis: Record<string, unknown>): Record<string, unknown> {
  return wireJob({ status: "COMPLETED", stats: { cost_usd: 1.5, analysis } });
}

function testLoadRubricFile() {
  console.log("\n--- loadRubricFile: Harbor's loader law, unknown fields refused by name ---");
  const TOML_TEXT =
    '[[criteria]]\nname = "reward_hacking"\ndescription = "d"\nguidance = "g"\n';
  assertEqual(
    loadRubricFile("rubric.toml", () => TOML_TEXT),
    { criteria: [{ name: "reward_hacking", description: "d", guidance: "g" }] },
    "TOML [[criteria]] entries parse to the spec's Rubric shape"
  );
  assertEqual(
    loadRubricFile("rubric.json", () =>
      JSON.stringify({ criteria: [{ name: "a", description: "d", guidance: "g" }] })
    ).criteria[0].name,
    "a",
    "a JSON rubric parses"
  );
  assertEqual(
    loadRubricFile("rubric.yaml", () => "criteria:\n  - name: b\n    description: d\n    guidance: g\n")
      .criteria[0].name,
    "b",
    "a YAML rubric parses (Harbor accepts .yaml/.yml too)"
  );
  assertThrowsUsage(
    () => loadRubricFile("rubric.toml", () => TOML_TEXT + "weight = 2\n"),
    '"weight"',
    "an unknown criterion key is refused naming it"
  );
  assertThrowsUsage(
    () =>
      loadRubricFile("rubric.json", () =>
        JSON.stringify({ criteria: [{ name: "a", description: "d", guidance: "g" }], prompt: "x" })
      ),
    '"prompt"',
    "an unknown top-level key is refused naming it"
  );
  assertThrowsUsage(
    () => loadRubricFile("rubric.json", () => JSON.stringify({ criteria: [] })),
    "non-empty criteria",
    "an empty criteria list is refused"
  );
  assertThrowsUsage(
    () => loadRubricFile("rubric.json", () => JSON.stringify({ criteria: [{ name: "a", description: "d" }] })),
    '"guidance"',
    "a criterion missing a field is refused naming the field"
  );
  assertThrowsUsage(
    () => loadRubricFile("rubric.ini", () => ""),
    "unsupported rubric format",
    "an unsupported extension is refused by name (Harbor's own law)"
  );
}

function testBuildJobInputAnalyze() {
  console.log("\n--- buildJobInput: --analyze arms the embedded trigger (presence is the switch) ---");
  const bare = buildJobInput(
    parseArgs(["job", "start", "-d", "deep-swe", "-a", "codex", "-m", "m", "--analyze"])
  );
  assertEqual(bare.analyze, {}, "bare --analyze sends the empty object (all defaults)");

  const withFields = buildJobInput(
    parseArgs([
      "job", "start",
      "-d", "deep-swe",
      "-a", "codex",
      "-m", "m",
      "--analyze-model", "claude-haiku-4-5-20251001",
      "--analyze-rubric", "rubric.json",
      "--analyze-provider", "modal",
    ]),
    () => JSON.stringify(CLI_RUBRIC)
  );
  assertEqual(
    withFields.analyze,
    { model_name: "claude-haiku-4-5-20251001", rubric: CLI_RUBRIC, sandbox_provider: "modal" },
    "--analyze-model/--analyze-rubric/--analyze-provider imply --analyze and fill their fields"
  );

  // The provider VALUE is the server's to rule (the lineup lives on GET
  // /api/meta, one home): the CLI passes it verbatim, no client-side roster.
  const providerOnly = buildJobInput(
    parseArgs([
      "job", "start",
      "-d", "deep-swe",
      "-a", "codex",
      "-m", "m",
      "--analyze-provider", "not-a-provider",
    ])
  );
  assertEqual(
    providerOnly.analyze,
    { sandbox_provider: "not-a-provider" },
    "--analyze-provider alone arms --analyze and rides verbatim — the server owns the lineup refusal"
  );

  const minimal = buildJobInput(
    parseArgs(["job", "start", "-d", "deep-swe", "-a", "codex", "-m", "m"])
  );
  assert(!("analyze" in minimal), "no analyze key when nothing armed it");

  // Config-file base merges FIELD BY FIELD under the flags, like retry.
  if (!SPEC_AVAILABLE) {
    console.log(`  - ${SPEC_SKIP_REASON}`);
    return;
  }
  // The file's analyze.sandbox_provider passes the spec-derived -c validation
  // (the key is in the spec's own AnalyzeConfigInput vocabulary — zero CLI
  // edits), and each flag still overrides exactly its own field.
  const merged = buildJobInput(
    parseArgs([
      "job", "start",
      "--config", "job.json",
      "--analyze-model", "claude-haiku-4-5-20251001",
      "--analyze-provider", "modal",
    ]),
    (path) =>
      path === "job.json"
        ? JSON.stringify({
            datasets: [{ name: "deep-swe" }],
            agents: [{ name: "codex", model_name: "m" }],
            analyze: { model_name: "other-model", rubric: CLI_RUBRIC, sandbox_provider: "e2b" },
          })
        : ""
  );
  assertEqual(
    merged.analyze,
    { model_name: "claude-haiku-4-5-20251001", rubric: CLI_RUBRIC, sandbox_provider: "modal" },
    "each flag overrides its field; the file's rubric survives; the file's provider is spec-legal"
  );
}

async function testAnalyzeVerbEndToEnd() {
  console.log("\n--- runCli: analyze POSTs, follows the wave, renders the settled table ---");
  installMockFetch();
  const baseFetch = globalThis.fetch;
  // The wave settles between the first and second job read, so the follow is
  // proven to POLL rather than to read once.
  let jobReads = 0;
  const pendingJob = analyzedWireJob({
    n_completed: 0,
    n_failed: 0,
    n_pending: 1,
    cost_usd: null,
    checks: {},
  });
  const settledJob = analyzedWireJob({
    n_completed: 1,
    n_failed: 0,
    n_pending: 0,
    cost_usd: 0.0173,
    checks: { reward_hacking: { n_pass: 1, n_fail: 0, n_not_applicable: 0 } },
  });
  (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    if (urlStr === `${BASE}/api/jobs/eval-1`) {
      jobReads++;
      return buildMockResponse({ status: 200, body: jobReads === 1 ? pendingJob : settledJob });
    }
    return baseFetch(url as any, init);
  };
  try {
    setMockResponse("/api/jobs/eval-1/analyze", { status: 202, body: pendingJob });
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: {
        items: [wireAnalyzedTrial("run-1", COMPLETED_WIRE_ANALYSIS)],
        nextCursor: null,
        hasMore: false,
      },
    });
    const { io, out } = captureIO();
    const code = await runCli(
      ["analyze", "eval-1", "-m", "claude-haiku-4-5-20251001", "-e", "daytona", ...AUTH],
      io
    );
    assertEqual(code, 0, "exit 0 when every analysis completed");
    const post = fetchCalls.find((c) => c.url.endsWith("/api/jobs/eval-1/analyze"));
    assert(post !== undefined, "POSTs the per-job analyze route");
    assertEqual(
      JSON.parse(post?.init?.body as string),
      { model_name: "claude-haiku-4-5-20251001", sandbox_provider: "daytona" },
      "-m/-e ride the body as model_name/sandbox_provider; no rubric key when none given"
    );
    assert(jobReads >= 2, "follows the wave by polling the job");
    assert(
      out.some((l) => l.includes("1 completed") && l.includes("0 pending")),
      "prints the settled tally"
    );
    assert(
      out.some((l) => l.includes("reward_hacking pass")),
      "the table carries the criterion outcomes"
    );
    assert(out.some((l) => l.includes("$0.0173")), "the table carries the analyzer's own cost");
    assert(
      out.some((l) => l.includes("The agent solved the task")),
      "the table carries the summary excerpt"
    );
  } finally {
    restoreFetch();
  }
}

async function testAnalyzeVerbJsonAndFailure() {
  console.log("\n--- runCli: analyze --json envelopes; a failed analysis is exit 1, shown typed ---");
  installMockFetch();
  try {
    // Settled on the FIRST read: no polling delay in this half.
    const failedTally = {
      n_completed: 0,
      n_failed: 1,
      n_pending: 0,
      cost_usd: null,
      checks: {},
    };
    const failedAnalysis = {
      ...COMPLETED_WIRE_ANALYSIS,
      status: "failed",
      summary: null,
      checks: null,
      estimated_cost_usd: null,
      failure: { phase: "invalid_result", message: "checks missing criterion: reward_hacking" },
      finished_at: "2026-08-28T00:01:00.000Z",
    };
    setMockResponse("/api/jobs/eval-1/analyze", { status: 202, body: analyzedWireJob(failedTally) });
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: {
        items: [wireAnalyzedTrial("run-1", failedAnalysis)],
        nextCursor: null,
        hasMore: false,
      },
    });
    setMockResponse("/api/jobs/eval-1", { status: 200, body: analyzedWireJob(failedTally) });
    const { io, out } = captureIO();
    const code = await runCli(["analyze", "eval-1", "--json", ...AUTH], io);
    assertEqual(code, 1, "a wave with failed analyses exits 1 (Harbor's own law)");
    const kinds = out.map((line) => (JSON.parse(line) as { kind?: string }).kind);
    assert(kinds.includes("analysis.accepted"), "--json emits the accepted envelope");
    assert(kinds.includes("analysis.stats"), "--json emits the tally envelopes");
    assert(kinds.includes("analysis.final"), "--json emits the final envelope");
    const final = JSON.parse(out[out.length - 1]) as {
      kind: string;
      trials: { analysis: { failure: { phase: string } } }[];
    };
    assertEqual(final.kind, "analysis.final", "the final envelope is last");
    assertEqual(
      final.trials[0].analysis.failure.phase,
      "invalid_result",
      "the typed failure rides the final envelope"
    );

    // The human render shows the same failure typed, never a silent absence.
    const human = captureIO();
    const humanCode = await runCli(["analyze", "eval-1", ...AUTH], human.io);
    assertEqual(humanCode, 1, "human mode exits 1 the same");
    assert(
      human.out.some((l) => l.includes("invalid_result") && l.includes("checks missing criterion")),
      "the typed failure is rendered with its phase and message"
    );
  } finally {
    restoreFetch();
  }
}

async function testAnalyzeRefusalSurfacesVerbatim() {
  console.log("\n--- runCli: analyze surfaces the typed 409 as-is ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/analyze", {
      status: 409,
      body: {
        error: {
          code: "analysis_already_running",
          message: "An analysis wave is already running for this job; retry once it settles.",
        },
      },
    });
    const { io, err } = captureIO();
    const code = await runCli(["analyze", "eval-1", ...AUTH], io);
    assertEqual(code, 1, "exit 1 on the typed refusal");
    assert(
      err.some((l) => l.includes("already running")),
      "the server's own sentence is printed, not a rewrite"
    );
  } finally {
    restoreFetch();
  }
}

async function testJobShowAnalysisRows() {
  console.log("\n--- runCli: job show renders the analyze policy and the analysis tally ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({
        analyze: { model_name: "claude-haiku-4-5-20251001", rubric: CLI_RUBRIC },
        stats: {
          cost_usd: 1.5,
          analysis: {
            n_completed: 2,
            n_failed: 1,
            n_pending: 0,
            cost_usd: 0.0421,
            checks: { reward_hacking: { n_pass: 1, n_fail: 1, n_not_applicable: 0 } },
          },
        },
      }),
    });
    const { io, out } = captureIO();
    const code = await runCli(["job", "show", "eval-1", ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    assert(
      out.some((l) => l.startsWith("analyze") && l.includes("claude-haiku-4-5-20251001") && l.includes("1 criterion")),
      "the embedded policy row states the resolved pair"
    );
    assert(
      out.some((l) => l.startsWith("analysis") && l.includes("2 completed") && l.includes("$0.0421")),
      "the analysis row carries the tally and the analyzer's own spend"
    );
    assert(
      out.some((l) => l.includes("reward_hacking") && l.includes("1 pass") && l.includes("1 fail")),
      "each criterion gets its tally row"
    );

    // A job never analyzed prints neither row — absence stated as absence.
    installMockFetch();
    setMockResponse("/api/jobs/eval-1", { status: 200, body: wireJob() });
    const bare = captureIO();
    await runCli(["job", "show", "eval-1", ...AUTH], bare.io);
    assert(!bare.out.some((l) => l.startsWith("analyze")), "no analyze row without a policy");
    assert(!bare.out.some((l) => l.startsWith("analysis")), "no analysis row without an aggregate");
  } finally {
    restoreFetch();
  }
}

function testTrialDetailAnalysisRows() {
  console.log("\n--- trialDetailLines: the trial's LATEST analysis, verdicts and typed failure ---");
  const analyzed = trialDetailLines(
    trialFixture({
      status: "SCORED",
      reward: 1,
      analysis: {
        id: "an-1",
        status: "completed",
        model_name: "claude-haiku-4-5-20251001",
        rubric: CLI_RUBRIC,
        summary: "Legitimate solve.",
        checks: {
          reward_hacking: { outcome: "pass", explanation: "No verifier writes observed." },
        },
        estimated_cost_usd: 0.0173,
        failure: null,
        created_at: "2026-08-28T00:00:00.000Z",
        finished_at: "2026-08-28T00:01:00.000Z",
      },
    })
  ).join("\n");
  assert(analyzed.includes("completed · claude-haiku-4-5-20251001"), "status and model on the analysis row");
  assert(
    analyzed.includes("claude-haiku-4-5-20251001 · an-1"),
    "the analysis id renders — the handle the analysis verbs take"
  );
  assert(analyzed.includes("pass — No verifier writes observed."), "each criterion renders outcome and explanation");
  assert(analyzed.includes("Legitimate solve."), "the summary renders");
  assert(analyzed.includes("$0.0173"), "the analyzer's own spend renders, never folded into the trial's bill");

  const failed = trialDetailLines(
    trialFixture({
      analysis: {
        id: "an-2",
        status: "failed",
        model_name: "claude-haiku-4-5-20251001",
        rubric: CLI_RUBRIC,
        summary: null,
        checks: null,
        estimated_cost_usd: null,
        failure: { phase: "boot", message: "sandbox never came up" },
        created_at: "2026-08-28T00:00:00.000Z",
        finished_at: "2026-08-28T00:01:00.000Z",
      },
    })
  ).join("\n");
  assert(failed.includes("boot: sandbox never came up"), "a failed analysis shows its typed failure");

  const never = trialDetailLines(trialFixture({ analysis: null })).join("\n");
  assert(!never.includes("analysis"), "a never-analyzed trial prints no analysis rows");
}

/**
 * Build a .tar.gz fixture the way the server's archive builder does — real
 * tar entries through tar-stream — including deliberately hostile shapes
 * (`..` climbs, entries outside the root, symlinks) the extractor must
 * refuse.
 */
async function gzipTarArchive(
  entries: { name: string; content?: string; type?: "file" | "directory" | "symlink"; linkname?: string }[]
): Promise<Buffer> {
  const tar = pack();
  for (const e of entries) {
    if (e.type === "directory") {
      tar.entry({ name: e.name, type: "directory" });
    } else if (e.type === "symlink") {
      tar.entry({ name: e.name, type: "symlink", linkname: e.linkname ?? "/etc/passwd" });
    } else {
      tar.entry({ name: e.name, type: "file" }, e.content ?? "");
    }
  }
  tar.finalize();
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  const drained = (async () => {
    for await (const chunk of gzip) chunks.push(Buffer.from(chunk));
  })();
  await Promise.all([pipeline(tar, gzip), drained]);
  return Buffer.concat(chunks);
}

async function testCompareCancelDownload() {
  console.log("\n--- runCli: job compare / cancel / download ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `cli-job-dl-${Date.now()}`);
  try {
    setMockResponse("/api/jobs/eval-1/cancel", { status: 202, body: wireJob({ status: "CANCELLING" }) });
    // A REAL archive in the server's shape: everything rooted at job-<id>/,
    // ATIF at Harbor's own agent/trajectory.json path.
    const archive = await gzipTarArchive([
      { name: "job-eval-1/config.json", content: '{"job_name":"job-eval-1"}' },
      { name: "job-eval-1/result.json", content: '{"stats":{}}' },
      { name: "job-eval-1/t0__task", type: "directory" },
      { name: "job-eval-1/t0__task/result.json", content: '{"x_evolve":{"trialId":"run-1"}}' },
      { name: "job-eval-1/t0__task/agent/trajectory.json", content: '{"schema_version":"ATIF-v1.7"}' },
      { name: "job-eval-1/t0__task/verifier/reward.json", content: '{"reward":1}' },
    ]);
    setMockResponse("/api/jobs/eval-1/download", {
      status: 200,
      body: null,
      bodyBytes: archive,
      headers: { "Content-Disposition": 'attachment; filename="job-eval-1.tar.gz"' },
    });
    // The evolve.json enrichment reads the job body + trial rows after the
    // extract. Registered AFTER the /download and /cancel patterns — the
    // mock matches by substring in insertion order.
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: {
        items: [
          {
            id: "run-1",
            job_id: "eval-1",
            task_name: "task",
            source: "deep-swe",
            agent_info: { name: "codex", version: null, model_info: { name: "gpt-5.5", provider: null }, reasoning_effort: null },
            status: "SCORED",
            reward: 1,
            spend_source: "measured",
            sandbox_provider: "e2b",
            agent_result: { n_input_tokens: 1, n_cache_tokens: 0, n_output_tokens: 1, cost_usd: 0.25, rollout_details: null, metadata: null },
            n_retries: 0,
            retries: [],
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    setMockResponse("/api/jobs/eval-1", { status: 200, body: wireJob({ status: "COMPLETED" }) });
    setMockResponse("/api/jobs/compare", {
      status: 200,
      body: {
        jobs: [
          { id: "eval-1", datasets: [{ name: "deep-swe", version: "1.1" }], status: "COMPLETED", mean_reward: 0.5, coverage: { scored: 2, total: 2 }, cost_usd: 1, agents: [], started_at: "2026-07-22T00:00:00Z" },
          { id: "eval-2", datasets: [{ name: "deep-swe", version: "1.1" }], status: "COMPLETED", mean_reward: 1, coverage: { scored: 2, total: 2 }, cost_usd: 2, agents: [], started_at: "2026-07-22T00:00:00Z" },
        ],
        taskMatrix: [],
      },
    });

    const compare = captureIO();
    assertEqual(await runCli(["job", "compare", "eval-1", "eval-2", ...AUTH], compare.io), 0, "compare exits 0");
    assert(fetchCalls[fetchCalls.length - 1].url.includes("/api/jobs/compare?ids=eval-1,eval-2"), "compare rides ?ids=");
    assert(compare.out.join("\n").includes("MEAN REWARD"), "renders the aggregate table");

    const cancel = captureIO();
    assertEqual(await runCli(["job", "cancel", "eval-1", ...AUTH], cancel.io), 0, "cancel exits 0");
    assertEqual(fetchCalls[fetchCalls.length - 1].init?.method, "POST", "cancel uses POST");

    const download = captureIO();
    assertEqual(await runCli(["job", "download", "eval-1", "-o", tmpDir, ...AUTH], download.io), 0, "download exits 0");
    assert(
      fetchCalls.some((c) => c.url.endsWith("/api/jobs/eval-1/download")),
      "hits the download route"
    );
    const treeDir = join(tmpDir, "job-eval-1");
    assertEqual(
      (await readFile(join(treeDir, "config.json"))).toString(),
      '{"job_name":"job-eval-1"}',
      "-o unpacks the tree: config.json on disk"
    );
    assertEqual(
      (await readFile(join(treeDir, "t0__task", "agent", "trajectory.json"))).toString(),
      '{"schema_version":"ATIF-v1.7"}',
      "ATIF lands at Harbor's own agent/trajectory.json path"
    );
    assertEqual(
      (await readFile(join(treeDir, "t0__task", "verifier", "reward.json"))).toString(),
      '{"reward":1}',
      "verifier rewards land under verifier/"
    );
    const leftovers = (await readdir(tmpDir)).filter((name) => name.endsWith(".tar.gz"));
    assertEqual(leftovers, [], "no .tar.gz survives — the tree IS the result");
    // The evolve.json records ride the tree: one at the job root, one per
    // trial directory (matched by result.json's x_evolve.trialId).
    const jobEvolve = JSON.parse(await readFile(join(treeDir, "evolve.json"), "utf-8"));
    assertEqual(jobEvolve.job_id, "eval-1", "the job root carries evolve.json");
    assertEqual(jobEvolve.provider, "e2b", "the job evolve.json names the provider");
    const trialEvolve = JSON.parse(await readFile(join(treeDir, "t0__task", "evolve.json"), "utf-8"));
    assertEqual(trialEvolve.trial_id, "run-1", "each trial dir gets its own evolve.json");
    assertEqual(trialEvolve.gateway.cost_usd, 0.25, "the trial evolve.json carries the gateway meter");
    assert(
      download.out.some((l) => l.includes(treeDir) && l.includes("7 files")),
      "prints the tree path and the file count (evolve.json records included)"
    );

    // --json reports the tree, not an archive path.
    const jsonDownload = captureIO();
    assertEqual(
      await runCli(["job", "download", "eval-1", "-o", tmpDir, "--overwrite", "--json", ...AUTH], jsonDownload.io),
      0,
      "--overwrite --json re-download exits 0"
    );
    assertEqual(JSON.parse(jsonDownload.out[0]), { path: treeDir, files: 7 }, "--json = { path, files }");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testJobDelete() {
  console.log("\n--- runCli: job delete — Harbor's confirm posture, the receipt counts ---");

  // Grammar: exactly one id.
  assertThrowsUsage(() => parseArgs(["job", "delete"]), "requires", "delete needs an id");
  assertThrowsUsage(() => parseArgs(["job", "delete", "a", "b"]), "unexpected argument", "one id only");

  installMockFetch();
  try {
    const receipt = { job_id: "eval-1", trials_deleted: 12, analyses_deleted: 3 };

    // Non-interactive without --yes: refused BEFORE any request — Harbor's
    // own posture ("Re-run with --yes to confirm", their hub delete on a
    // non-TTY stdin). io without a confirm hook IS the non-interactive case.
    const bare = captureIO();
    const before = fetchCalls.length;
    const bareCode = await runCli(["job", "delete", "eval-1", ...AUTH], bare.io);
    assertEqual(bareCode, 1, "a bare non-interactive delete refuses with exit 1");
    assert(
      bare.err.some((l) => l.includes("--yes")),
      "the refusal names the --yes flag"
    );
    assertEqual(fetchCalls.length, before, "nothing was requested — the refusal is local");

    // --yes goes straight to DELETE and renders the receipt counts.
    setMockResponse("/api/jobs/eval-1", { status: 200, body: receipt });
    const yes = captureIO();
    const yesCode = await runCli(["job", "delete", "eval-1", "--yes", ...AUTH], yes.io);
    assertEqual(yesCode, 0, "--yes deletes without a prompt");
    const deleteCall = fetchCalls.find((c) => c.init?.method === "DELETE");
    assert(
      deleteCall !== undefined && deleteCall.url.endsWith("/api/jobs/eval-1"),
      "DELETE hits the job route itself"
    );
    assert(
      yes.out.some((l) => l.includes("12") && l.includes("3")),
      "the human receipt states the destruction counts"
    );

    // --json emits the receipt verbatim — the machine envelope.
    const json = captureIO();
    assertEqual(
      await runCli(["job", "delete", "eval-1", "-y", "--json", ...AUTH], json.io),
      0,
      "-y is --yes (Harbor's short flag)"
    );
    assertEqual(JSON.parse(json.out.join("\n")), receipt, "--json prints the JobDeleteResult verbatim");

    // Interactive declined: the job is fetched and NAMED before the question
    // (Harbor prints id + name, then asks), no DELETE fires, exit 1.
    installMockFetch();
    let deleted = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (init?.method === "DELETE") {
        deleted++;
        return buildMockResponse({ status: 200, body: receipt });
      }
      return buildMockResponse({ status: 200, body: wireJob({ id: "eval-1", job_name: "nightly" }) });
    };
    const asked: string[] = [];
    const declined = captureIO(true);
    declined.io.confirm = async (q: string) => {
      asked.push(q);
      return false;
    };
    const declinedCode = await runCli(["job", "delete", "eval-1", ...AUTH], declined.io);
    assertEqual(declinedCode, 1, "a declined confirmation exits 1");
    assertEqual(deleted, 0, "nothing was deleted");
    assert(asked.length === 1 && asked[0].includes("Permanently delete"), "the question states permanence");
    assert(
      declined.err.some((l) => l.includes("eval-1") && l.includes("nightly")),
      "what would die is named — id and job name — before the question"
    );
    assert(declined.err.some((l) => l.includes("cancelled")), "the outcome is stated");

    // Interactive accepted: DELETE fires and the receipt renders.
    const accepted = captureIO(true);
    accepted.io.confirm = async () => true;
    const acceptedCode = await runCli(["job", "delete", "eval-1", ...AUTH], accepted.io);
    assertEqual(acceptedCode, 0, "an accepted confirmation deletes");
    assertEqual(deleted, 1, "exactly one DELETE fired");
    assert(
      accepted.out.some((l) => l.includes("12") && l.includes("3")),
      "the receipt counts render after an accepted prompt"
    );

    // A typed refusal surfaces verbatim through the standard error path.
    installMockFetch();
    setMockResponse("/api/jobs/eval-1", {
      status: 409,
      body: { error: { code: "job_not_terminal", message: "Cancel the job first" } },
    });
    const refused = captureIO();
    assertEqual(
      await runCli(["job", "delete", "eval-1", "--yes", ...AUTH], refused.io),
      1,
      "a server refusal exits 1"
    );
    assert(
      refused.err.some((l) => l.includes("Cancel the job first")),
      "the server's sentence reaches stderr unrewritten"
    );
  } finally {
    restoreFetch();
  }
}

async function testJobDownloadUnpackGuards() {
  console.log("\n--- runCli: job download unpack guards ---");
  installMockFetch();
  const tmpDir = await mkdtemp(join(tmpdir(), "cli-job-dl-guards-"));
  try {
    // An existing tree is never silently replaced.
    setMockResponse(
      "/api/jobs/eval-1/download",
      { status: 200, body: null, bodyBytes: await gzipTarArchive([{ name: "job-eval-1/config.json", content: "{}" }]) }
    );
    // The evolve.json enrichment's reads, for the one download that extracts.
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: { items: [], nextCursor: null, hasMore: false },
    });
    setMockResponse("/api/jobs/eval-1", { status: 200, body: wireJob({ status: "COMPLETED" }) });
    await mkdir(join(tmpDir, "job-eval-1"), { recursive: true });
    await writeFile(join(tmpDir, "job-eval-1", "stale.txt"), "old");
    const refused = captureIO();
    assertEqual(await runCli(["job", "download", "eval-1", "-o", tmpDir, ...AUTH], refused.io), 1, "existing job-<id>/ refused");
    assert(refused.err.some((l) => l.includes("--overwrite")), "refusal names --overwrite as the remedy");
    assertEqual((await readFile(join(tmpDir, "job-eval-1", "stale.txt"))).toString(), "old", "the existing tree is untouched");

    // --overwrite replaces the tree.
    const replaced = captureIO();
    assertEqual(await runCli(["job", "download", "eval-1", "-o", tmpDir, "--overwrite", ...AUTH], replaced.io), 0, "--overwrite exits 0");
    assert(!existsSync(join(tmpDir, "job-eval-1", "stale.txt")), "--overwrite replaces the old tree, not merges into it");
    assert(existsSync(join(tmpDir, "job-eval-1", "config.json")), "the fresh tree is on disk");

    // A `..` climb aborts the extraction and the partial tree never survives.
    setMockResponse("/api/jobs/eval-2/download", {
      status: 200,
      body: null,
      bodyBytes: await gzipTarArchive([
        { name: "job-eval-2/config.json", content: "{}" },
        { name: "job-eval-2/../../evil.txt", content: "boom" },
      ]),
    });
    const climb = captureIO();
    assertEqual(await runCli(["job", "download", "eval-2", "-o", tmpDir, ...AUTH], climb.io), 1, "a .. climb fails the command");
    assert(climb.err.some((l) => l.includes("refusing to extract")), "the refusal names the entry");
    assert(!existsSync(join(dirname(tmpDir), "evil.txt")), "nothing lands outside the output dir");
    assert(!existsSync(join(tmpDir, "job-eval-2")), "the partial tree is removed on failure");

    // An entry outside job-<id>/ is refused even without a climb.
    setMockResponse("/api/jobs/eval-3/download", {
      status: 200,
      body: null,
      bodyBytes: await gzipTarArchive([{ name: "other-place/config.json", content: "{}" }]),
    });
    const outside = captureIO();
    assertEqual(await runCli(["job", "download", "eval-3", "-o", tmpDir, ...AUTH], outside.io), 1, "an entry outside job-<id>/ fails");
    assert(outside.err.some((l) => l.includes("outside job-eval-3/")), "the refusal names the expected root");
    assert(!existsSync(join(tmpDir, "other-place")), "the stray entry is never written");

    // A backslash name is refused: an ordinary character on posix, a path
    // separator on Windows — refusing beats extracting something ambiguous.
    setMockResponse("/api/jobs/eval-5/download", {
      status: 200,
      body: null,
      bodyBytes: await gzipTarArchive([{ name: "job-eval-5/..\\..\\evil.txt", content: "boom" }]),
    });
    const backslash = captureIO();
    assertEqual(await runCli(["job", "download", "eval-5", "-o", tmpDir, ...AUTH], backslash.io), 1, "a backslash name fails the command");
    assert(backslash.err.some((l) => l.includes("refusing to extract")), "the backslash refusal names the entry");
    assert(!existsSync(join(tmpDir, "job-eval-5")), "the backslash archive leaves no tree behind");

    // A symlink in the stream is an error, never a created foothold.
    setMockResponse("/api/jobs/eval-4/download", {
      status: 200,
      body: null,
      bodyBytes: await gzipTarArchive([
        { name: "job-eval-4/config.json", content: "{}" },
        { name: "job-eval-4/link", type: "symlink", linkname: "/etc/passwd" },
      ]),
    });
    const link = captureIO();
    assertEqual(await runCli(["job", "download", "eval-4", "-o", tmpDir, ...AUTH], link.io), 1, "a symlink entry fails the command");
    assert(link.err.some((l) => l.includes("unsupported entry type")), "the refusal names the entry type");
    assert(!existsSync(join(tmpDir, "job-eval-4")), "the symlink archive leaves no tree behind");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

// =============================================================================
// TRIAL — show, download (--stream + save), stop
// =============================================================================

async function testTrialShow() {
  console.log("\n--- runCli: trial show is globally addressable ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1", {
      status: 200,
      body: trialFixture({ status: "SCORED", reward: 1, agent_result: { cost_usd: 0.31 } }),
    });
    const { io, out } = captureIO();
    const code = await runCli(["trial", "show", "run-1", ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    assert(fetchCalls[fetchCalls.length - 1].url.endsWith("/api/trials/run-1"), "one positional, the trial id");
    assert(out.join("\n").includes("abs-module-cache-flags"), "renders the detail");
  } finally {
    restoreFetch();
  }
}

async function testTrialShowUploaded() {
  console.log("\n--- runCli: trial show renders an uploaded trial's REPORTED record beside empty meters ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-up1", {
      status: 200,
      body: trialFixture({
        id: "run-up1",
        status: "SCORED",
        reward: 1,
        // The platform-metered facts stay empty for an upload: the meter
        // never saw the run.
        agent_result: null,
        usage: null,
        sandbox_provider: null,
        upload: {
          original_trial_id: "orig-t1",
          original_trial_name: "trial-1",
          original_task_name: "laude/hello-world",
          reported_agent_result: {
            n_input_tokens: 1200,
            n_cache_tokens: 300,
            n_output_tokens: 800,
            cost_usd: 1.25,
          },
        },
      }),
    });
    const { io, out } = captureIO();
    assertEqual(await runCli(["trial", "show", "run-up1", ...AUTH], io), 0, "exit 0");
    const text = out.join("\n");
    // Metered spend is honestly absent, and the archive's claim sits beside
    // it clearly labeled REPORTED — never folded into the platform's rows.
    assert(out.some((l) => l.includes("spent") && l.trim().endsWith("-")), "metered spend renders '-'");
    assert(
      text.includes("reported cost") && text.includes("$1.2500") && text.includes("not platform-metered"),
      "reported cost row carries the figure and the label"
    );
    assert(
      out.some((l) => l.includes("reported tokens") && l.includes("in 1200") && l.includes("out 800")),
      "reported tokens row carries the archive's counts"
    );
    assert(
      out.some((l) => l.includes("uploaded from") && l.includes("trial-1") && l.includes("laude/hello-world")),
      "the provenance identity row names the original trial and full task name"
    );
    assert(
      out.some((l) => l.includes("provider") && l.includes("ported")),
      "the provider cell renders ported"
    );
  } finally {
    restoreFetch();
  }
}

async function testGpuSurfaces() {
  console.log("\n--- runCli: GPU tasks — requirement column, degrade verdicts, trial degrade row ---");
  installMockFetch();
  try {
    // Dataset with one GPU task: the GPU column appears (it stays absent for
    // CPU-only datasets — testDatasetListAndShow pins that), e2b renders the
    // degrade arrow, and the limitation line says where the task actually runs.
    setMockResponse("/api/datasets/gpu-bench", {
      status: 200,
      body: {
        name: "gpu-bench",
        title: "GPU bench",
        description: null,
        active_version: { version: "1.0", state: "READY", created_at: "2026-08-01T00:00:00Z", task_count: 1 },
        versions: [{ version: "1.0", state: "READY", created_at: "2026-08-01T00:00:00Z", task_count: 1 }],
        selected_version: { version: "1.0", state: "READY", created_at: "2026-08-01T00:00:00Z", task_count: 1 },
        tasks: {
          items: [
            {
              task_name: "train-lora",
              agent_timeout_sec: 600,
              verifier_timeout_sec: 120,
              gpus: 2,
              gpu_types: ["H100"],
              providers: {
                e2b: { ok: true, degrades_to: "modal", reason: "e2b offers no GPU allocation" },
                daytona: { ok: true, degrades_to: "modal", reason: "this Daytona account cannot provision GPU sandboxes" },
                modal: { ok: true },
              },
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
        upstream: null,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
    });
    const show = captureIO();
    assertEqual(await runCli(["dataset", "show", "gpu-bench", ...AUTH], show.io), 0, "show exits 0");
    const text = show.out.join("\n");
    assert(text.includes("GPU"), "the GPU column appears when a task declares GPUs");
    assert(text.includes("2x H100"), "the requirement renders count and types");
    assert(text.includes("e2b →modal"), "a degrade verdict renders as an arrow, not a refusal");
    assert(
      text.includes("e2b: runs on modal — e2b offers no GPU allocation"),
      "the limitation line names where the task actually runs and why"
    );

    // Trial detail: the degrade is a labeled row with from/to and the reason.
    setMockResponse("/api/trials/run-9", {
      status: 200,
      body: trialFixture({
        status: "SCORED",
        reward: 1,
        sandbox_provider: "modal",
        sandbox_provider_degrade: {
          from: "e2b",
          to: "modal",
          reason: "e2b offers no GPU allocation",
        },
      }),
    });
    const trial = captureIO();
    assertEqual(await runCli(["trial", "show", "run-9", ...AUTH], trial.io), 0, "trial show exits 0");
    const trialText = trial.out.join("\n");
    assert(trialText.includes("provider degrade"), "the degrade row is labeled");
    assert(
      trialText.includes("e2b → modal: e2b offers no GPU allocation"),
      "the row states from, to, and the refusing provider's reason"
    );
  } finally {
    restoreFetch();
  }
}

async function testTrialDownloadStream() {
  console.log("\n--- runCli: trial download --stream — the seven-name artifact vocabulary ---");
  installMockFetch();
  try {
    setMockResponse("/trace?stream=trace-stdout", { status: 200, body: { log: "raw harness stdout" } });
    setMockResponse("/trace?stream=trace-atif", { status: 200, body: { log: '{"steps":[]}' } });
    setMockResponse("/trace?limit=100&cursor=5", {
      status: 200,
      body: { items: [{ seq: 6, type: "agent.message", data: {} }], nextCursor: null, hasMore: false },
    });

    const stdout = captureIO();
    const code = await runCli(["trial", "download", "run-1", "--stream", "trace-stdout", ...AUTH], stdout.io);
    assertEqual(code, 0, "exit 0");
    assert(
      fetchCalls[fetchCalls.length - 1].url.includes("/api/trials/run-1/trace?stream=trace-stdout"),
      "hits the global ?stream= route"
    );
    assertEqual(stdout.out, ["raw harness stdout"], "prints the raw log verbatim");

    // The normalized ATIF document rides the same {log} envelope as the raw
    // logs — the CLI passes the served JSON text through verbatim.
    const atif = captureIO();
    assertEqual(
      await runCli(["trial", "download", "run-1", "--stream", "trace-atif", ...AUTH], atif.io),
      0,
      "--stream trace-atif is a valid selector"
    );
    assertEqual(atif.out, ['{"steps":[]}'], "prints the ATIF document verbatim");

    const parsed = captureIO();
    assertEqual(
      await runCli(
        ["trial", "download", "run-1", "--stream", "trace-parsed", "--cursor", "5", "--limit", "100", ...AUTH],
        parsed.io
      ),
      0,
      "--stream trace-parsed pages the parsed events"
    );
    const parsedCall = fetchCalls[fetchCalls.length - 1];
    assert(parsedCall.url.includes("limit=100") && parsedCall.url.includes("cursor=5"), "cursor/limit ride the query");
    assert(parsed.out[0].includes("agent.message"), "renders the event line");
  } finally {
    restoreFetch();
  }
}

async function testTrialDownloadTrajectoryRefused() {
  console.log("\n--- runCli: --stream trajectory surfaces the server's refusal honestly ---");
  installMockFetch();
  try {
    // `trajectory` is the reserved harness-native session-file slot: the
    // server answers not-found for it until its wave lands. The CLI's whole
    // job is a clean relay: the server's own sentence, one line, nothing
    // invented and nothing on stdout.
    const sentence =
      'the "trajectory" artifact (the harness\'s own native session file) is not yet served';
    setMockResponse("/trace?stream=trajectory", {
      status: 404,
      body: { error: { code: "trial_not_found", message: sentence } },
    });
    const { io, out, err } = captureIO();
    const code = await runCli(["trial", "download", "run-1", "--stream", "trajectory", ...AUTH], io);
    assertEqual(code, 1, "a server refusal is exit 1, not a silent success");
    assertEqual(err, [`Error: ${sentence}`], "the server's sentence reaches stderr verbatim, one line");
    assertEqual(out, [], "a refusal prints nothing on stdout");
  } finally {
    restoreFetch();
  }
}

async function testTrialDownloadSave() {
  console.log("\n--- runCli: trial download saves Harbor's trial tree + evolve.json; --overwrite gates ---");
  installMockFetch();
  const tmpDir = await mkdtemp(join(tmpdir(), "evolve-trial-dl-"));
  try {
    // Stream selectors first: the mock matches by substring, and a plain
    // "/trace" pattern would swallow "/trace?stream=…" if it were checked first.
    setMockResponse("/trace?stream=trace-atif", { status: 200, body: { log: '{"schema_version":"ATIF-v1.7"}' } });
    setMockResponse("/trace?stream=verifier", { status: 200, body: { log: "verifier says 1.0" } });
    setMockResponse("/trace?stream=trace-stdout", { status: 200, body: { log: null } });
    setMockResponse("/trace?stream=trace-stderr", { status: 200, body: { log: null } });
    setMockResponse("/trace?stream=agent-home", {
      status: 200,
      body: { files: { "/root/.claude/history.jsonl": "{}" } },
    });
    setMockResponse("/trace", {
      status: 200,
      body: { items: [{ seq: 0, type: "agent.message", data: {} }], nextCursor: null, hasMore: false },
    });
    // The trial body the tree's config/result/evolve records derive from.
    // Registered AFTER every "/trace" pattern — substring matching. The job
    // and auth-status lookups stay unmocked on purpose: both are
    // best-effort (lineage reads as an original run's, user_id as null).
    setMockResponse("/api/trials/run-1", {
      status: 200,
      body: {
        id: "run-1",
        job_id: "job-1",
        task_name: "fix-bug",
        source: "swe-bench",
        agent_info: {
          name: "codex",
          version: "1.0.0",
          model_info: { name: "gpt-test", provider: null },
          reasoning_effort: null,
        },
        attempt: 1,
        status: "SCORED",
        reward: 1,
        verifier_result: { rewards: { reward: 1 } },
        exception_info: null,
        agent_result: {
          n_input_tokens: 10,
          n_cache_tokens: 0,
          n_output_tokens: 5,
          cost_usd: 0.5,
          rollout_details: null,
          metadata: null,
        },
        spend_source: "measured",
        sandbox_provider: "modal",
        max_trial_spend_usd: 200,
        n_retries: 0,
        retries: [],
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:10:00.000Z",
      },
    });
    const { io, out, err } = captureIO();
    const code = await runCli(["trial", "download", "run-1", "-o", tmpDir, ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    assertEqual(err, [], "nothing on stderr");
    const target = join(tmpDir, "run-1");
    // HARBOR'S TRIAL TREE, file for file — the same names the job archive
    // extracts to — plus evolve.json, the platform's own record.
    const config = JSON.parse(await readFile(join(target, "config.json"), "utf-8"));
    assertEqual(config.task.name, "fix-bug", "config.json carries the task identity");
    assertEqual(config.agent.name, "codex", "config.json carries the agent identity");
    const result = JSON.parse(await readFile(join(target, "result.json"), "utf-8"));
    assertEqual(result.status, "SCORED", "result.json carries the outcome");
    const savedAtif = await readFile(join(target, "agent", "trajectory.json"), "utf-8");
    assertEqual(savedAtif, '{"schema_version":"ATIF-v1.7"}', "the ATIF document is agent/trajectory.json");
    const parsed = await readFile(join(target, "agent", "trace-parsed.jsonl"), "utf-8");
    assert(parsed.includes('"seq":0'), "parsed events land in agent/trace-parsed.jsonl");
    const verifier = await readFile(join(target, "verifier", "test-stdout.txt"), "utf-8");
    assertEqual(verifier, "verifier says 1.0", "the verifier log is verifier/test-stdout.txt");
    const reward = JSON.parse(await readFile(join(target, "verifier", "reward.json"), "utf-8"));
    assertEqual(reward.reward, 1, "the rewards map is verifier/reward.json");
    const home = await readFile(join(target, "agent", "sessions", "claude", "history.jsonl"), "utf-8");
    assertEqual(home, "{}", "agent/sessions/ wears the home tree's visible names");
    const evolve = JSON.parse(await readFile(join(target, "evolve.json"), "utf-8"));
    assertEqual(evolve.provider, "modal", "evolve.json names the provider");
    assertEqual(evolve.gateway.cost_usd, 0.5, "evolve.json carries the gateway meter");
    assertEqual(evolve.gateway.spend_source, "measured", "evolve.json names the spend lane");
    assertEqual(evolve.user_id, null, "an unreachable auth status reads as user_id null");
    assertEqual(evolve.regrade_lineage.is_regrade, false, "an unreachable job reads as original lineage");
    // Null logs were never stored — absence is a normal answer, no empty files.
    let missingThrew = false;
    try {
      await readFile(join(target, "agent", "stdout.log"), "utf-8");
    } catch {
      missingThrew = true;
    }
    assert(missingThrew, "an unstored artifact writes no file");
    assert(out.some((l) => l.includes("config.json")), "reports the written files");

    // The directory now exists: a second save without --overwrite must refuse
    // instead of silently mixing two downloads.
    const refused = captureIO();
    const refusedCode = await runCli(["trial", "download", "run-1", "-o", tmpDir, ...AUTH], refused.io);
    assertEqual(refusedCode, 1, "an existing target refuses without --overwrite");
    assert(refused.err[0].includes("--overwrite"), "the refusal names the flag that unlocks it");

    const overwrite = captureIO();
    assertEqual(
      await runCli(["trial", "download", "run-1", "-o", tmpDir, "--overwrite", ...AUTH], overwrite.io),
      0,
      "--overwrite replaces the existing download"
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testTrialDownloadUsageErrors() {
  console.log("\n--- runCli: trial download flag misuse is a usage error (exit 2, not 1) ---");
  {
    const { io, err } = captureIO();
    const code = await runCli(["trial", "download", "run-1", "--stream", "bogus", ...AUTH], io);
    assertEqual(code, 2, "invalid --stream value exits 2 like every other usage error");
    assert(
      err.some((l) => l.includes("trace-parsed") && l.includes("trace-atif") && l.includes("trajectory")),
      "names all seven selectors"
    );
  }
  {
    const { io, err } = captureIO();
    const code = await runCli(
      ["trial", "download", "run-1", "--stream", "verifier", "-o", "/tmp/x", ...AUTH],
      io
    );
    assertEqual(code, 2, "--stream + -o refused, exit 2");
    assert(err.some((l) => l.includes("EITHER --stream OR -o")), "explains the exclusive modes");
  }
  {
    const { io, err } = captureIO();
    const code = await runCli(
      ["trial", "download", "run-1", "--stream", "verifier", "--cursor", "5", ...AUTH],
      io
    );
    assertEqual(code, 2, "--cursor outside trace-parsed refused, exit 2");
    assert(err.some((l) => l.includes("trace-parsed")), "explains cursor/limit scope");
  }
  {
    const { io } = captureIO();
    const code = await runCli(["trial", "download", "run-1", "--limit", "10", ...AUTH], io);
    assertEqual(code, 2, "--limit in save mode refused, exit 2");
  }
}

async function testTrialStop() {
  console.log("\n--- runCli: trial stop posts the id list and reports each outcome ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/stop", {
      status: 200,
      body: {
        stopped: [trialFixture({ status: "INDETERMINATE" })],
        stopped_analyses: [{ id: "an-9", status: "failed" }],
        already_terminal: ["run-2"],
        not_found: ["run-3"],
      },
    });
    const { io, out } = captureIO();
    const code = await runCli(["trial", "stop", "run-1", "run-2", "an-9", "run-3", ...AUTH], io);
    assertEqual(code, 0, "exit 0 — the report is the outcome");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/trials/stop"), "hits the stop route");
    assertEqual(
      JSON.parse(call.init?.body as string),
      { trial_ids: ["run-1", "run-2", "an-9", "run-3"] },
      "posts every requested id"
    );
    assert(out.some((l) => l.includes("stopped run-1")), "reports the stopped trial");
    assert(
      out.some((l) => l.includes("stopped analysis an-9 failed")),
      "a stopped trace analysis gets its own report row, never silently absent"
    );
    assert(out.some((l) => l.includes("already terminal run-2")), "reports the already-terminal id");
    assert(out.some((l) => l.includes("not found run-3")), "reports the unknown id (existence never leaked)");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// ANALYSIS — show, trace, download (the traces-feed verbs)
// =============================================================================

/** The wire verdict the feed's ?what=analysis door serves. */
function analysisVerdictFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "an-1",
    status: "failed",
    model_name: "glm-5.3-flash",
    rubric: CLI_RUBRIC,
    summary: null,
    checks: null,
    estimated_cost_usd: 0.0366,
    usage: {
      provisional: true,
      spent_usd: 0.0366,
      input_tokens: 960596,
      cached_input_tokens: 912640,
      output_tokens: 77018,
      as_of: "2026-08-30T22:24:22.619Z",
    },
    failure: { phase: "artifact_read", message: "MISSING /app/analysis.json" },
    created_at: "2026-08-30T21:50:09.010Z",
    finished_at: "2026-08-30T22:24:22.619Z",
    ...overrides,
  };
}

/** The feed's transcript envelope for an analysis id. */
function analysisEventsFixture(events: unknown[], total = events.length): Record<string, unknown> {
  return {
    session: {
      id: "an-1",
      tag: "roy-polymorph-cn",
      provider: "daytona",
      sandboxId: "box-1",
      agent: "claude",
      model: "glm-5.3-flash",
      isEnded: true,
      type: "trial",
      kind: "analysis",
      analyzedTrialId: "run-1",
      status: "FAILED",
      jobId: "job-1",
    },
    events,
    total,
    traceSource: "db",
  };
}

async function testAnalysisShow() {
  console.log("\n--- runCli: analysis show renders the verdict document; --json is the wire object ---");
  installMockFetch();
  try {
    setMockResponse("/api/traces/trials/an-1/artifacts?what=analysis", {
      status: 200,
      body: { analysis: analysisVerdictFixture() },
    });
    const { io, out } = captureIO();
    const code = await runCli(["analysis", "show", "an-1", ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    assert(
      fetchCalls[fetchCalls.length - 1].url.endsWith("/api/traces/trials/an-1/artifacts?what=analysis"),
      "one GET on the feed's verdict door"
    );
    const text = out.join("\n");
    assert(text.includes("an-1"), "renders the analysis id");
    assert(text.includes("failed"), "renders the status");
    assert(text.includes("glm-5.3-flash"), "renders the model");
    assert(
      text.includes("artifact_read: MISSING /app/analysis.json"),
      "a failed analysis shows its typed failure"
    );
    assert(text.includes("$0.0366"), "the analyzer's own spend renders at four decimals");
    assert(out.some((l) => l.includes("tokens") && l.includes("provisional")), "the usage row renders");

    // The plural noun answers as the hidden alias, like every other group.
    const alias = captureIO();
    assertEqual(await runCli(["analyses", "show", "an-1", ...AUTH], alias.io), 0, "analyses aliases analysis");

    const json = captureIO();
    assertEqual(await runCli(["analysis", "show", "an-1", "--json", ...AUTH], json.io), 0, "--json exits 0");
    const body = JSON.parse(json.out.join("")) as Record<string, unknown>;
    assertEqual(body.id, "an-1", "--json is the wire verdict object");
    assertEqual(body.status, "failed", "--json keeps the wire's lowercase status");

    // A completed analysis renders its verdicts and summary, no failure row.
    setMockResponse("/api/traces/trials/an-2/artifacts?what=analysis", {
      status: 200,
      body: {
        analysis: analysisVerdictFixture({
          id: "an-2",
          status: "completed",
          summary: "Legitimate solve.",
          checks: { reward_hacking: { outcome: "pass", explanation: "No verifier writes observed." } },
          failure: null,
        }),
      },
    });
    const completed = captureIO();
    assertEqual(await runCli(["analysis", "show", "an-2", ...AUTH], completed.io), 0, "completed exits 0");
    const completedText = completed.out.join("\n");
    assert(
      completedText.includes("pass — No verifier writes observed."),
      "each criterion renders outcome and explanation"
    );
    assert(completedText.includes("Legitimate solve."), "the summary renders");
    assert(!completedText.includes("failure"), "no failure row on a completed analysis");

    // A TRIAL id at the verdict door refuses server-side in the feed's own
    // grammar ({error: "<sentence>"}, no code). The CLI passes the sentence
    // through clean — human and --json alike — never the JSON blob.
    setMockResponse("/api/traces/trials/run-1/artifacts?what=analysis", {
      status: 400,
      body: { error: "analysis.json belongs to an analysis row" },
    });
    const wrong = captureIO();
    assertEqual(await runCli(["analysis", "show", "run-1", ...AUTH], wrong.io), 1, "a feed refusal exits 1");
    assertEqual(wrong.err, ["Error: analysis.json belongs to an analysis row"], "the server's sentence, clean");
    const wrongJson = captureIO();
    assertEqual(await runCli(["analysis", "show", "run-1", "--json", ...AUTH], wrongJson.io), 1, "--json exits 1");
    assertEqual(
      JSON.parse(wrongJson.out[0]),
      { error: { code: "unknown_error", message: "analysis.json belongs to an analysis row" } },
      "--json carries the sentence under the honest unknown_error code"
    );
  } finally {
    restoreFetch();
  }
}

async function testAnalysisTrace() {
  console.log("\n--- runCli: analysis trace prints the analyzer's transcript; --since resumes ---");
  installMockFetch();
  try {
    setMockResponse("/api/traces/trials/an-1/events?since=2", {
      status: 200,
      body: analysisEventsFixture([{ update: { sessionUpdate: "tool_call" } }], 3),
    });
    setMockResponse("/api/traces/trials/an-1/events", {
      status: 200,
      body: analysisEventsFixture([
        { _prompt: { text: "You are analyzing an agent trial run." } },
        { update: { sessionUpdate: "agent_message_chunk", content: { text: "Reading" } } },
      ]),
    });
    const { io, out } = captureIO();
    const code = await runCli(["analysis", "trace", "an-1", ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    assert(
      fetchCalls[fetchCalls.length - 1].url.endsWith("/api/traces/trials/an-1/events"),
      "hits the feed's events door"
    );
    assert(out[0].includes("#   0") && out[0].includes("unknown"), "the raw prompt row renders as unknown");
    assert(out[1].includes("agent_message_chunk"), "the viewer's own type extraction names ACP events");

    const since = captureIO();
    assertEqual(await runCli(["analysis", "trace", "an-1", "--since", "2", ...AUTH], since.io), 0, "--since exits 0");
    assert(
      fetchCalls[fetchCalls.length - 1].url.endsWith("/api/traces/trials/an-1/events?since=2"),
      "--since rides the wire as the feed's own parameter"
    );
    assert(since.out[0].includes("#   2"), "resumed seqs continue from since");

    const json = captureIO();
    assertEqual(await runCli(["analysis", "trace", "an-1", "--json", ...AUTH], json.io), 0, "--json exits 0");
    const first = JSON.parse(json.out[0]) as Record<string, unknown>;
    assertEqual(first.seq, 0, "--json is one TraceEvent per line");

    // A trial id resolves at the same door — the wrong species refuses (exit
    // 1) instead of printing the trial's transcript as the analyzer's.
    setMockResponse("/api/traces/trials/run-1/events", {
      status: 200,
      body: { session: { id: "run-1", type: "trial" }, events: [{}], total: 1, traceSource: "db" },
    });
    const wrong = captureIO();
    assertEqual(await runCli(["analysis", "trace", "run-1", ...AUTH], wrong.io), 1, "wrong species exits 1");
    assert(wrong.err[0].includes("not an analysis run"), "the refusal names the reason");
    assertEqual(wrong.out, [], "a refusal prints nothing on stdout");
  } finally {
    restoreFetch();
  }
}

async function testAnalysisDownloadStream() {
  console.log("\n--- runCli: analysis download --stream — the five-name artifact vocabulary ---");
  installMockFetch();
  try {
    setMockResponse("/artifacts?what=trace-stdout", { status: 200, body: { log: "analyzer stdout" } });
    setMockResponse("/artifacts?what=trace-stderr", { status: 200, body: { log: null } });
    setMockResponse("/artifacts?what=analysis", {
      status: 200,
      body: { analysis: analysisVerdictFixture() },
    });

    const stdout = captureIO();
    const code = await runCli(["analysis", "download", "an-1", "--stream", "trace-stdout", ...AUTH], stdout.io);
    assertEqual(code, 0, "exit 0");
    assert(
      fetchCalls[fetchCalls.length - 1].url.includes("/api/traces/trials/an-1/artifacts?what=trace-stdout"),
      "hits the feed's artifacts door"
    );
    assertEqual(stdout.out, ["analyzer stdout"], "prints the raw log verbatim");

    const absent = captureIO();
    assertEqual(
      await runCli(["analysis", "download", "an-1", "--stream", "trace-stderr", ...AUTH], absent.io),
      0,
      "an unstored log is a normal answer"
    );
    assert(absent.out[0].includes("No trace-stderr log"), "absence is stated, never an empty print");

    // --stream analysis: the verdict document itself, the bytes the feed's
    // &format=log form downloads as Harbor's analysis.json.
    const verdict = captureIO();
    assertEqual(
      await runCli(["analysis", "download", "an-1", "--stream", "analysis", ...AUTH], verdict.io),
      0,
      "--stream analysis is a valid selector"
    );
    const doc = JSON.parse(verdict.out.join("\n")) as Record<string, unknown>;
    assertEqual(doc.id, "an-1", "prints the verdict document");
  } finally {
    restoreFetch();
  }
}

async function testAnalysisDownloadStreamRefusesOtherSpecies() {
  console.log("\n--- runCli: analysis download --stream refuses an id of another species ---");
  installMockFetch();
  try {
    // A trial id typed at a stream selector: the artifacts door itself would
    // serve THAT trial's bytes (its resolution order puts trials first), so
    // the SDK resolves the ?what=analysis door first — the server refuses a
    // trial there — and the verb inherits the refusal: exit 1, and the
    // trial's bytes never reach stdout.
    setMockResponse("/api/traces/trials/run-1/artifacts?what=analysis", {
      status: 400,
      body: { error: "analysis.json belongs to an analysis run — open the analysis row and download it there" },
    });
    setMockResponse("/api/traces/trials/run-1/artifacts?what=trace-stdout", {
      status: 200,
      body: { log: "the TRIAL's stdout" },
    });
    const wrong = captureIO();
    assertEqual(
      await runCli(["analysis", "download", "run-1", "--stream", "trace-stdout", ...AUTH], wrong.io),
      1,
      "wrong species exits 1"
    );
    assert(wrong.err[0].includes("not an analysis run"), "the refusal names the reason");
    assertEqual(wrong.out, [], "the trial's bytes never reach stdout");
  } finally {
    restoreFetch();
  }
}

async function testAnalysisDownloadSave() {
  console.log("\n--- runCli: analysis download saves the analysis tree + evolve.json; --overwrite gates ---");
  installMockFetch();
  const tmpDir = await mkdtemp(join(tmpdir(), "evolve-analysis-dl-"));
  try {
    // Substring matching: selector patterns first, the bare events door last.
    setMockResponse("/artifacts?what=analysis", {
      status: 200,
      body: {
        analysis: analysisVerdictFixture({
          id: "an-1",
          status: "completed",
          summary: "Legitimate solve.",
          checks: { reward_hacking: { outcome: "pass", explanation: "ok" } },
          failure: null,
        }),
      },
    });
    setMockResponse("/artifacts?what=trace-stdout", { status: 200, body: { log: "analyzer out" } });
    setMockResponse("/artifacts?what=trace-stderr", { status: 200, body: { log: null } });
    setMockResponse("/artifacts?what=agent-home", {
      status: 200,
      body: { files: { "/root/.claude/history.jsonl": "{}" } },
    });
    setMockResponse("/api/traces/trials/an-1/events", {
      status: 200,
      body: analysisEventsFixture([{ update: { sessionUpdate: "tool_call" } }]),
    });
    const { io, out, err } = captureIO();
    const code = await runCli(["analysis", "download", "an-1", "-o", tmpDir, ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    assertEqual(err, [], "nothing on stderr");
    const target = join(tmpDir, "an-1");
    const verdict = JSON.parse(await readFile(join(target, "analysis.json"), "utf-8"));
    assertEqual(verdict.id, "an-1", "analysis.json is the verdict document at the run's root");
    assertEqual(
      await readFile(join(target, "agent", "stdout.log"), "utf-8"),
      "analyzer out",
      "the analyzer's raw stdout is agent/stdout.log"
    );
    const parsed = await readFile(join(target, "agent", "trace-parsed.jsonl"), "utf-8");
    assert(parsed.includes('"type":"tool_call"'), "the parsed transcript lands in agent/trace-parsed.jsonl");
    assertEqual(
      await readFile(join(target, "agent", "sessions", "claude", "history.jsonl"), "utf-8"),
      "{}",
      "agent/sessions/ wears the home tree's visible names"
    );
    const evolve = JSON.parse(await readFile(join(target, "evolve.json"), "utf-8"));
    assertEqual(evolve.analysis_id, "an-1", "evolve.json names the analysis");
    assertEqual(evolve.analyzed_trial_id, "run-1", "evolve.json names the analyzed trial");
    assertEqual(evolve.provider, "daytona", "evolve.json names the ANALYZER's provider");
    let missingThrew = false;
    try {
      await readFile(join(target, "agent", "stderr.log"), "utf-8");
    } catch {
      missingThrew = true;
    }
    assert(missingThrew, "an unstored artifact writes no file");

    const refused = captureIO();
    assertEqual(
      await runCli(["analysis", "download", "an-1", "-o", tmpDir, ...AUTH], refused.io),
      1,
      "an existing target refuses without --overwrite"
    );
    assert(refused.err[0].includes("--overwrite"), "the refusal names the flag that unlocks it");
    const overwrite = captureIO();
    assertEqual(
      await runCli(["analysis", "download", "an-1", "-o", tmpDir, "--overwrite", ...AUTH], overwrite.io),
      0,
      "--overwrite replaces the existing download"
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testAnalysisDownloadUsageErrors() {
  console.log("\n--- runCli: analysis download flag misuse is a usage error (exit 2, not 1) ---");
  {
    const { io, err } = captureIO();
    const code = await runCli(["analysis", "download", "an-1", "--stream", "verifier", ...AUTH], io);
    assertEqual(code, 2, "a selector the species does not own exits 2 at the keyboard");
    assert(
      err.some((l) => l.includes("analysis") && l.includes("trace-parsed") && l.includes("agent-home")),
      "names all five selectors"
    );
  }
  {
    const { io, err } = captureIO();
    const code = await runCli(
      ["analysis", "download", "an-1", "--stream", "analysis", "-o", "/tmp/x", ...AUTH],
      io
    );
    assertEqual(code, 2, "--stream + -o refused, exit 2");
    assert(err.some((l) => l.includes("EITHER --stream OR -o")), "explains the exclusive modes");
  }
  {
    const { io, err } = captureIO();
    const code = await runCli(
      ["analysis", "download", "an-1", "--stream", "trace-stdout", "--since", "5", ...AUTH],
      io
    );
    assertEqual(code, 2, "--since outside trace-parsed refused, exit 2");
    assert(err.some((l) => l.includes("trace-parsed")), "explains the since scope");
  }
  {
    const { io } = captureIO();
    const code = await runCli(["analysis", "download", "an-1", "--since", "5", ...AUTH], io);
    assertEqual(code, 2, "--since in save mode refused, exit 2");
  }
}

// =============================================================================
// DATASET — list, show, publish, download, activate
// =============================================================================

async function testDatasetListAndShow() {
  console.log("\n--- runCli: dataset list + show ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/deep-swe", {
      status: 200,
      body: {
        name: "deep-swe",
        title: "Deep SWE",
        description: null,
        active_version: { version: "1.1", state: "READY", created_at: "2026-07-01T00:00:00Z", task_count: 12 },
        versions: [{ version: "1.1", state: "READY", created_at: "2026-07-01T00:00:00Z", task_count: 12 }],
        selected_version: { version: "1.1", state: "READY", created_at: "2026-07-01T00:00:00Z", task_count: 12 },
        tasks: {
          items: [
            { task_name: "t1", agent_timeout_sec: 600, verifier_timeout_sec: 120, providers: { e2b: { ok: true }, modal: { ok: false, reason: "needs docker" } } },
          ],
          nextCursor: "task-cur",
          hasMore: true,
        },
        upstream: null,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    });
    setMockResponse("/api/datasets", {
      status: 200,
      body: {
        items: [
          {
            name: "deep-swe",
            title: "Deep SWE",
            description: null,
            active_version: { version: "1.1", state: "READY", created_at: "2026-07-01T00:00:00Z", task_count: 12 },
            upstream: { ref: "main", current_commit: "aaa", latest_commit: "bbb", moved: true, behind_by: 2, checked_at: null, error: null, auto_import: false },
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });

    const list = captureIO();
    assertEqual(await runCli(["dataset", "list", ...AUTH], list.io), 0, "list exits 0");
    assert(list.out[0].includes("NAME\tACTIVE"), "TSV header when piped");
    assert(list.out[1].startsWith("deep-swe\t1.1"), "lists the dataset row");
    assert(
      list.out.some((l) => l.includes("upstream main moved") && l.includes("dataset publish")),
      "the upstream notice names the publish command in the new grammar"
    );

    const quiet = captureIO();
    await runCli(["dataset", "list", "-q", ...AUTH], quiet.io);
    assertEqual(quiet.out, ["deep-swe"], "-q prints names only — the notice stays out of piped output");

    const show = captureIO();
    assertEqual(await runCli(["dataset", "show", "deep-swe@1.1", ...AUTH], show.io), 0, "show exits 0");
    const showCall = fetchCalls[fetchCalls.length - 1];
    assert(showCall.url.includes("/api/datasets/deep-swe") && showCall.url.includes("version=1.1"), "ref version becomes ?version=");
    const text = show.out.join("\n");
    assert(text.includes("VERSION") && text.includes("READY"), "renders the version table");
    assert(text.includes("dataset show deep-swe --cursor task-cur"), "the task paging hint speaks the new grammar");
    assert(text.includes("modal: needs docker"), "provider limitations are named once");
  } finally {
    restoreFetch();
  }
}

async function testDatasetProvenanceAndPinNotice() {
  console.log("\n--- runCli: dataset show provenance + pinned upstream notice ---");
  installMockFetch();
  try {
    const SHA = "e".repeat(40);
    setMockResponse("/api/datasets/pinned-swe", {
      status: 200,
      body: {
        name: "pinned-swe",
        title: null,
        description: null,
        active_version: { version: "1.0", state: "READY", created_at: "2026-07-01T00:00:00Z", task_count: 3 },
        versions: [{ version: "1.0", state: "READY", created_at: "2026-07-01T00:00:00Z", task_count: 3 }],
        selected_version: null,
        tasks: { items: [], nextCursor: null, hasMore: false },
        // A commit-pinned import: provenance present, watch at rest.
        upstream: {
          git_url: "https://github.com/acme/bench",
          ref: SHA,
          current_commit: SHA,
          path: "datasets/my-swe",
          latest_commit: null,
          acked_commit: null,
          moved: false,
          behind_by: null,
          checked_at: null,
          error: null,
          auto_import: false,
        },
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    });

    const show = captureIO();
    assertEqual(await runCli(["dataset", "show", "pinned-swe", ...AUTH], show.io), 0, "show exits 0");
    const text = show.out.join("\n");
    assert(
      text.includes(`source: https://github.com/acme/bench (commit ${SHA.slice(0, 12)})`),
      "show renders where the version came from — url + resolved commit, no duplicate ref when the ref IS the commit"
    );
    assert(text.includes("subfolder: datasets/my-swe"), "a narrowed import names its subfolder");
    assert(!text.includes("upstream") || !text.includes("moved"), "a pin never prints a moved notice");

    // A TAG import renders the requested ref beside the resolved commit.
    setMockResponse("/api/datasets/pinned-swe", {
      status: 200,
      body: {
        name: "pinned-swe",
        title: null,
        description: null,
        active_version: { version: "1.0", state: "READY", created_at: "2026-07-01T00:00:00Z", task_count: 3 },
        upstream: {
          git_url: "https://github.com/acme/bench",
          ref: "v1.0",
          current_commit: SHA,
          path: null,
          latest_commit: null,
          acked_commit: null,
          moved: false,
          behind_by: null,
          checked_at: null,
          error: null,
          auto_import: false,
        },
      },
    });
    const tagShow = captureIO();
    await runCli(["dataset", "show", "pinned-swe", ...AUTH], tagShow.io);
    assert(
      tagShow.out.some((l) => l.includes("source: https://github.com/acme/bench @ v1.0") && l.includes(SHA.slice(0, 12))),
      "a tag import renders requested-ref @ resolved-commit"
    );

    // The moved notice suggests a PIN the server will accept — the observed
    // commit and the real url — never the branch name the server now refuses.
    setMockResponse("/api/datasets", {
      status: 200,
      body: {
        items: [
          {
            name: "legacy-swe",
            title: null,
            description: null,
            active_version: { version: "1.1", state: "READY", created_at: "2026-07-01T00:00:00Z", task_count: 2 },
            upstream: {
              git_url: "https://github.com/acme/legacy",
              ref: "main",
              current_commit: "a".repeat(40),
              path: "corpus",
              latest_commit: "b".repeat(40),
              acked_commit: null,
              moved: true,
              behind_by: null,
              checked_at: "2026-07-01T00:00:00Z",
              error: null,
              auto_import: false,
            },
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    const list = captureIO();
    await runCli(["dataset", "list", ...AUTH], list.io);
    const notice = list.out.find((l) => l.includes("upstream main moved"));
    assert(notice !== undefined, "the moved notice still appears for a legacy branch watch");
    assert(notice!.includes(`--ref ${"b".repeat(40)}`), "the suggested command pins the observed commit, not the refused branch name");
    assert(notice!.includes("--git https://github.com/acme/legacy"), "the suggested command carries the real url");
    assert(notice!.includes("--path corpus"), "the suggested command keeps the subfolder");
  } finally {
    restoreFetch();
  }
}

async function testDatasetShowVersionSource() {
  console.log("\n--- runCli: dataset show serves a FAILED version's git provenance ---");
  installMockFetch();
  try {
    // The Q5 shape: annotated-tag import COMPLETED, build FAILED, NO active
    // version — so `upstream` is null, and only the per-version `source` can
    // say which bytes were imported. The human page must show the PEELED
    // commit both on the source line (selected version) and in the versions
    // table's COMMIT column.
    const PEELED = "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc";
    const version = {
      version: "1.0",
      state: "FAILED",
      created_at: "2026-08-05T00:00:00Z",
      task_count: 2,
      source: {
        git_url: "https://github.com/laude-institute/harbor",
        ref: "v0.20.0",
        commit: PEELED,
        path: "examples/tasks/network-policy-matrix/extra-allowed-hosts",
      },
    };
    setMockResponse("/api/datasets/q5-tagpeel", {
      status: 200,
      body: {
        name: "q5-tagpeel",
        title: null,
        description: null,
        active_version: null,
        versions: [version],
        selected_version: version,
        tasks: { items: [], nextCursor: null, hasMore: false },
        upstream: null,
        created_at: "2026-08-05T00:00:00Z",
        updated_at: "2026-08-05T00:00:00Z",
      },
    });

    const show = captureIO();
    assertEqual(await runCli(["dataset", "show", "q5-tagpeel@1.0", ...AUTH], show.io), 0, "show exits 0");
    const text = show.out.join("\n");
    assert(
      text.includes(`source: https://github.com/laude-institute/harbor @ v0.20.0 (commit ${PEELED.slice(0, 12)})`),
      "the source line renders the FAILED version's own provenance — requested tag @ PEELED commit — with no active version at all"
    );
    assert(
      text.includes("subfolder: examples/tasks/network-policy-matrix/extra-allowed-hosts"),
      "the narrowed import names its subfolder"
    );
    assert(text.includes("COMMIT"), "the versions table grows a COMMIT column when a version carries git provenance");
    assert(
      show.out.some((l) => l.includes("1.0") && l.includes("FAILED") && l.includes(PEELED.slice(0, 12))),
      "the FAILED version's row carries its resolved commit"
    );
  } finally {
    restoreFetch();
  }
}



/**
 * A wire dataset-detail body holding exactly one version, for publish
 * --watch's settle phase: the watch follows the version here until it
 * settles at READY or FAILED.
 */
function publishDetailBody(opts: {
  name: string;
  version: string;
  state: string;
  active?: boolean;
}): Record<string, unknown> {
  const versionBody = {
    version: opts.version,
    state: opts.state,
    created_at: "2026-08-20T00:00:00Z",
    task_count: 12,
    manifest: null,
    source: null,
  };
  return {
    name: opts.name,
    title: null,
    description: null,
    visibility: "private",
    active_version: opts.active ? versionBody : null,
    versions: [versionBody],
    selected_version: versionBody,
    tasks: { items: [], next_cursor: null, has_more: false },
    upstream: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
  };
}

async function testDatasetPublishWatch() {
  console.log("\n--- runCli: dataset publish --watch, git source ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/imports/imp-1", {
      status: 200,
      body: { id: "imp-1", status: "COMPLETED", name: "my-bench", version: "1.0", task_count: 12, failure: null, warnings: [] },
    });
    setMockResponse("/api/datasets/publish", {
      status: 202,
      body: { id: "imp-1", status: "QUEUED", name: "my-bench", version: "1.0", failure: null, warnings: [] },
    });
    // COMPLETED means the version is READY under build-then-READY; the settle
    // phase is one confirming read. Served READY + active accordingly.
    setMockResponse("/api/datasets/my-bench?", {
      status: 200,
      body: publishDetailBody({
        name: "my-bench",
        version: "1.0",
        state: "READY",
        active: true,
      }),
    });

    const { io, out, err } = captureIO();
    const code = await runCli(
      [
        "dataset", "publish",
        "--git", "https://github.com/acme/my-bench.git",
        "--ref", "main",
        "--name", "my-bench",
        "--version", "1.0",
        "--watch",
        ...AUTH,
      ],
      io
    );
    assertEqual(code, 0, "exit code 0 once the version is READY — not at bare COMPLETED");
    assertEqual(err, [], "nothing on stderr");

    const createCall = fetchCalls.find((c) => c.url === `${BASE}/api/datasets/publish`);
    assert(createCall !== undefined, "POSTs /api/datasets/publish");
    const form = createCall?.init?.body as FormData;
    assert(form instanceof FormData, "create body is multipart/form-data");
    assertEqual(form.get("git_url"), "https://github.com/acme/my-bench.git", "git_url part");
    assertEqual(form.get("git_ref"), "main", "git_ref part");
    assertEqual(form.get("name"), "my-bench", "name part");
    assertEqual(form.get("version"), "1.0", "version part");
    assert(out.some((l) => l.includes("COMPLETED") && l.includes("tasks=12")), "renders the COMPLETED status line");
    assert(
      fetchCalls.some((c) => c.url.includes("/api/datasets/my-bench?") && c.url.includes("version=1.0")),
      "polls the dataset detail for THIS version after import COMPLETED"
    );
    assert(
      out.some((l) => l.includes("state") && l.includes("READY")),
      "the watch stream shows the version settling"
    );
    assert(
      out.some((l) => l.includes("active") && l.includes("1.0 (this publish)")),
      "the final block says the ACTIVE version is now this publish"
    );
  } finally {
    restoreFetch();
  }
}


/**
 * `dataset watch` — the re-attach verb (lane/watch-register-first). One
 * rendering home: everything after the opening line must be the SAME stream
 * `dataset publish --watch` renders (followImport), so these tests assert
 * the exact renderer lines the publish tests assert.
 */
async function testDatasetWatchVerb() {
  console.log("\n--- runCli: dataset watch <import-id> — re-attach renders the publish stream ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/imports/imp-7", {
      status: 200,
      body: {
        id: "imp-7", status: "COMPLETED", receiving: false, name: "my-bench",
        version: "1.0", task_count: 12, failure: null, warnings: [], progress: null,
      },
    });
    setMockResponse("/api/datasets/my-bench?", {
      status: 200,
      body: publishDetailBody({ name: "my-bench", version: "1.0", state: "READY", active: true }),
    });
    const { io, out, err } = captureIO();
    const code = await runCli(["dataset", "watch", "imp-7", ...AUTH], io);
    assertEqual(code, 0, "a COMPLETED import settles and exits 0");
    assertEqual(err, [], "nothing on stderr");
    assert(
      out.some((l) => l.includes("Import imp-7 (my-bench@1.0) COMPLETED — watching…")),
      "the attach opening names import, dataset@version and status"
    );
    assert(
      out.some((l) => l.includes("status COMPLETED") && l.includes("tasks=12")),
      "the SAME status line the publish renderer prints"
    );
    assert(
      out.some((l) => l.includes("state") && l.includes("READY")),
      "the settle stream shows the version landing — the publish renderer's line"
    );
    assert(
      out.some((l) => l.includes("active") && l.includes("1.0 (this publish)")),
      "the final block names the active version — the publish renderer's line"
    );
  } finally {
    restoreFetch();
  }

  console.log("\n--- runCli: dataset watch <name> — resolves the newest LIVE import; renders receiving ---");
  installMockFetch();
  try {
    // The argument is tried as an import id FIRST; a 404 falls through to
    // the name resolution.
    setMockResponse("/api/datasets/imports/deep-swe", {
      status: 404,
      body: { error: { code: "import_not_found", message: "Import not found: deep-swe" } },
    });
    setMockResponse("/api/datasets/imports/imp-9", {
      status: 200,
      body: {
        id: "imp-9", status: "COMPLETED", receiving: false, name: "deep-swe",
        version: "2.0", task_count: 3, failure: null, warnings: [], progress: null,
      },
    });
    setMockResponse("/api/datasets/imports?", {
      status: 200,
      body: {
        items: [
          // Newest first: a register-first upload still receiving its corpus.
          { id: "imp-9", status: "QUEUED", receiving: true, name: "deep-swe", version: "2.0", failure: null, warnings: [], progress: null },
          { id: "imp-1", status: "COMPLETED", receiving: false, name: "deep-swe", version: "1.0", failure: null, warnings: [], progress: null },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    setMockResponse("/api/datasets/deep-swe?", {
      status: 200,
      body: publishDetailBody({ name: "deep-swe", version: "2.0", state: "READY", active: true }),
    });
    const { io, out } = captureIO();
    const code = await runCli(["dataset", "watch", "deep-swe", ...AUTH], io);
    assertEqual(code, 0, "the resolved live import is followed to its settled end");
    assert(
      fetchCalls.some((c) => c.url.includes("/api/datasets/imports?") && c.url.includes("dataset=deep-swe")),
      "resolves the name through the imports list, filtered to the dataset"
    );
    assert(
      out.some((l) => l.includes("Import imp-9 (deep-swe@2.0) QUEUED (receiving) — watching…")),
      "the attach line carries the register-first receiving marker"
    );
  } finally {
    restoreFetch();
  }

  console.log("\n--- runCli: dataset watch — a name with no live import refuses, naming the newest ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/imports/deep-swe", {
      status: 404,
      body: { error: { code: "import_not_found", message: "Import not found: deep-swe" } },
    });
    setMockResponse("/api/datasets/imports?", {
      status: 200,
      body: {
        items: [
          { id: "imp-1", status: "COMPLETED", receiving: false, name: "deep-swe", version: "1.0", failure: null, warnings: [], progress: null },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    const { io, err } = captureIO();
    const code = await runCli(["dataset", "watch", "deep-swe", ...AUTH], io);
    assertEqual(code, 1, "nothing live to watch exits 1");
    assert(
      err.some((l) => l.includes("Nothing to watch") && l.includes("imp-1") && l.includes("COMPLETED")),
      "the refusal names the newest settled import and its status"
    );

    // And a name that resolves to no imports at all says so.
    setMockResponse("/api/datasets/imports?", {
      status: 200,
      body: { items: [], nextCursor: null, hasMore: false },
    });
    const empty = captureIO();
    assertEqual(
      await runCli(["dataset", "watch", "deep-swe", ...AUTH], empty.io),
      1,
      "an unknown ref exits 1"
    );
    assert(
      empty.err.some((l) => l.includes("no import id and no dataset of yours carries that name")),
      "the refusal says neither address resolved"
    );
  } finally {
    restoreFetch();
  }

  console.log("\n--- runCli: dataset watch --json is the publish --watch NDJSON, opened with import.attached ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/imports/imp-7", {
      status: 200,
      body: {
        id: "imp-7", status: "COMPLETED", receiving: false, name: "my-bench",
        version: "1.0", task_count: 12, failure: null, warnings: [], progress: null,
      },
    });
    setMockResponse("/api/datasets/my-bench?", {
      status: 200,
      body: publishDetailBody({ name: "my-bench", version: "1.0", state: "READY", active: true }),
    });
    const { io, out } = captureIO();
    const code = await runCli(["dataset", "watch", "imp-7", "--json", ...AUTH], io);
    assertEqual(code, 0, "NDJSON watch exits by the settled outcome");
    const kinds = out.map((l) => (JSON.parse(l) as { kind: string }).kind);
    assertEqual(kinds[0], "import.attached", "the stream opens with import.attached (not created — nothing was)");
    assertEqual(kinds[kinds.length - 1], "import.final", "the stream closes with import.final");
    assert(kinds.includes("import.status"), "status events ride the same NDJSON kinds as publish --watch");
    assert(kinds.includes("import.version"), "version events ride the same NDJSON kinds as publish --watch");
  } finally {
    restoreFetch();
  }

  console.log("\n--- runCli: dataset watch — a pre-arrival import deleted mid-watch ends typed, exit 1 ---");
  installMockFetch();
  try {
    // First read (the attach) answers a receiving QUEUED import; every read
    // after it 404s — the reaper deleted the abandoned upload's row.
    let importReads = 0;
    const mocked = globalThis.fetch;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/api/datasets/imports/imp-gone")) {
        importReads += 1;
        if (importReads > 1) {
          return buildMockResponse({
            status: 404,
            body: { error: { code: "import_not_found", message: "Import not found: imp-gone" } },
          });
        }
        return buildMockResponse({
          status: 200,
          body: {
            id: "imp-gone", status: "QUEUED", receiving: true, name: "my-bench",
            version: "3.0", failure: null, warnings: [], progress: null,
          },
        });
      }
      return mocked(url as never, init);
    };
    const { io, err } = captureIO();
    const code = await runCli(["dataset", "watch", "imp-gone", ...AUTH], io);
    assertEqual(code, 1, "a vanished import is an outcome, exit 1 — never a crash");
    assert(
      err.some((l) => l.includes("no longer exists") && l.includes("abandoned or")),
      "the message says what a deleted pre-arrival import means"
    );
  } finally {
    restoreFetch();
  }

  console.log("\n--- renderers: the register-first receiving marker on the shared lines ---");
  {
    const receiving = {
      id: "i", status: "QUEUED", receiving: true, name: "d", version: "1",
      failure: null, warnings: [], progress: null,
    } as never;
    const accepted = {
      id: "i", status: "QUEUED", receiving: false, name: "d", version: "1",
      failure: null, warnings: [], progress: null,
    } as never;
    assert(
      importStatusLine(receiving).includes("QUEUED (receiving)"),
      "a receiving import's status line says so beside the status word"
    );
    assert(
      !importStatusLine(accepted).includes("receiving"),
      "an accepted import carries no marker"
    );
  }
}

/** A pre-flight answer body, with the verdicts the test wants. */
function preflightBody(tasks: Record<string, unknown>[]): Record<string, unknown> {
  const refused = tasks.filter((t) => t.ok !== true).length;
  return {
    importer_version: "harbor-import/14",
    checks: ["toml_syntax", "task_shape"],
    deferred: [{ name: "environment_layout", reads: "environment/Dockerfile" }],
    manifest: null,
    tasks,
    tasks_total: tasks.length,
    tasks_ok: tasks.length - refused,
    tasks_refused: refused,
  };
}

async function testDatasetCheck() {
  console.log("\n--- runCli: dataset check — the standalone pre-flight verb ---");
  const dir = await mkdtemp(join(tmpdir(), "evolve-cli-check-"));
  await mkdir(join(dir, "tasks", "bad-task"), { recursive: true });
  await writeFile(join(dir, "tasks", "bad-task", "task.toml"), '[environment]\ndocker_image = "python:latest"\n');
  installMockFetch();
  try {
    setMockResponse("/api/datasets/preflight", {
      status: 200,
      body: preflightBody([
        { name: "bad-task", ok: false, task_key: "bad-task", reason: 'docker_image "python:latest" is a mutable :latest tag' },
      ]),
    });
    const { io, out } = captureIO();
    const code = await runCli(["dataset", "check", dir, ...AUTH], io);
    assertEqual(code, 1, "a check that finds refusals exits 1 (the linter convention)");
    const call = fetchCalls.find((c) => c.url.includes("/api/datasets/preflight"));
    assert(call !== undefined, "POSTs /api/datasets/preflight");
    const sent = JSON.parse(String(call?.init?.body)) as { tasks: { name: string }[] };
    assertEqual(sent.tasks.map((t) => t.name), ["bad-task"], "sends one entry per task directory");
    assert(out.some((l) => l.includes("bad-task REFUSED") && l.includes("mutable :latest tag")), "prints the importer's refusal sentence");
    assert(out.some((l) => l.includes("the import also checks")), "prints the honesty line naming the deferred checks");

    // All-ok corpus exits 0; --json prints the raw answer.
    setMockResponse("/api/datasets/preflight", {
      status: 200,
      body: preflightBody([{ name: "bad-task", ok: true, task_key: "bad-task", schema_version: "1.4", providers: { e2b: { ok: true } } }]),
    });
    const okIO = captureIO();
    assertEqual(await runCli(["dataset", "check", dir, ...AUTH], okIO.io), 0, "an all-ok check exits 0");
    const jsonIO = captureIO();
    await runCli(["dataset", "check", dir, "--json", ...AUTH], jsonIO.io);
    const parsed = JSON.parse(jsonIO.out.join("")) as { tasks_ok: number };
    assertEqual(parsed.tasks_ok, 1, "--json prints the raw dry-run answer");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testDatasetPublishRunsPreflightFirst() {
  console.log("\n--- runCli: dataset publish --dir pre-flights BEFORE uploading; --skip-preflight skips ---");
  const dir = await mkdtemp(join(tmpdir(), "evolve-cli-pfp-"));
  await mkdir(join(dir, "tasks", "bad-task"), { recursive: true });
  await writeFile(join(dir, "tasks", "bad-task", "task.toml"), '[environment]\ndocker_image = "python:latest"\n');
  installMockFetch();
  try {
    setMockResponse("/api/datasets/preflight", {
      status: 200,
      body: preflightBody([
        { name: "bad-task", ok: false, task_key: "bad-task", reason: 'docker_image "python:latest" is a mutable :latest tag' },
      ]),
    });
    const { io, out } = captureIO();
    const code = await runCli(
      ["dataset", "publish", "--dir", dir, "--name", "b", "--version", "1", ...AUTH],
      io
    );
    assertEqual(code, 1, "a refused pre-flight stops the publish with exit 1");
    assert(out.some((l) => l.includes("Nothing was uploaded")), "says nothing was uploaded");
    assert(out.some((l) => l.includes("--skip-preflight")), "names the escape hatch");
    assert(
      !fetchCalls.some((c) => c.url.includes("/api/datasets/publish")),
      "the publish door was never called — refusals precede any upload"
    );
  } finally {
    restoreFetch();
  }

  // --skip-preflight: the pre-flight door is never called; the publish itself
  // proceeds (served here by a real local server, since the archive upload
  // rides node:http and bypasses fetch).
  const { createServer } = await import("node:http");
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "imp-9", status: "QUEUED", name: "b", version: "1", failure: null, warnings: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const { io } = captureIO();
    const code = await runCli(
      [
        "dataset", "publish", "--dir", dir, "--name", "b", "--version", "1",
        "--skip-preflight", "--api-key", "test-key", "--base-url", `http://127.0.0.1:${port}`,
      ],
      io
    );
    assertEqual(code, 0, "--skip-preflight publishes without the check");
    assertEqual(seen, ["/api/datasets/publish"], "ONLY the publish door was called — no pre-flight request");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Non-watch --json is ONE parseable JSON document — the CLI's own header
 * law (NDJSON is reserved for --watch event streams). A passing pre-flight
 * must not prepend a second document: scripts do JSON.parse(stdout).
 */
async function testDatasetPublishJsonIsOneDocument() {
  console.log("\n--- runCli: dataset publish --json (non-watch) prints exactly ONE JSON document ---");
  const dir = await mkdtemp(join(tmpdir(), "evolve-cli-json1-"));
  await mkdir(join(dir, "tasks", "ok-task"), { recursive: true });
  await writeFile(join(dir, "tasks", "ok-task", "task.toml"), 'schema_version = "1.4"\n');
  // A REAL server for BOTH doors: the pre-flight rides fetch, the archive
  // upload rides node:http — one origin serves them both.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/datasets/preflight") {
        res.statusCode = 200;
        res.end(JSON.stringify(preflightBody([
          { name: "ok-task", ok: true, task_key: "ok-task", schema_version: "1.4", providers: { e2b: { ok: true } } },
        ])));
        return;
      }
      res.statusCode = 202;
      res.end(JSON.stringify({ id: "imp-9", status: "QUEUED", name: "b", version: "1", failure: null, warnings: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const { io, out } = captureIO();
    const code = await runCli(
      [
        "dataset", "publish", "--dir", dir, "--name", "b", "--version", "1",
        "--json", "--api-key", "test-key", "--base-url", `http://127.0.0.1:${port}`,
      ],
      io
    );
    assertEqual(code, 0, "the publish succeeds");
    assertEqual(out.length, 1, "stdout is exactly one line — no preflight.ok document before it");
    const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    assertEqual(parsed.id, "imp-9", "the one document is the bare import — parseable by JSON.parse(stdout)");
    assert(!("kind" in parsed), "no NDJSON kind wrapper outside --watch");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Solutions archiving disabled is a warning about the missing
 * reference-solution record, never a settling dead end — the same publish
 * settles READY like any other and exits 0.
 */
async function testDatasetPublishWatchArchivingDisabled() {
  console.log("\n--- runCli: dataset publish --watch settles normally when solutions archiving was disabled ---");
  installMockFetch();
  try {
    const job = {
      id: "imp-8",
      name: "my-bench",
      version: "3.0",
      failure: null,
      warnings: [{ code: "solutions_archiving_disabled", message: "solutions archiving is disabled" }],
    };
    setMockResponse("/api/datasets/publish", { status: 202, body: { ...job, status: "QUEUED" } });
    setMockResponse("/api/datasets/imports/imp-8", {
      status: 200,
      body: { ...job, status: "COMPLETED", task_count: 12 },
    });
    setMockResponse("/api/datasets/my-bench?", {
      status: 200,
      body: publishDetailBody({ name: "my-bench", version: "3.0", state: "READY", active: true }),
    });

    const { io, out, err } = captureIO();
    const code = await runCli(
      ["dataset", "publish", "--git", "g", "--ref", "main", "--name", "my-bench", "--version", "3.0", "--watch", ...AUTH],
      io
    );
    assertEqual(code, 0, "exit code 0 — the warning gates nothing");
    assertEqual(err, [], "nothing on stderr");
    assert(
      out.some((l) => l.includes("active") && l.includes("3.0 (this publish)")),
      "the final block says the ACTIVE version is now this publish"
    );
  } finally {
    restoreFetch();
  }
}

async function testDatasetPublishFailedAndErrors() {
  console.log("\n--- runCli: dataset publish FAILED exits 1; flag misuse exits 2 ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/imports/imp-2", {
      status: 200,
      body: { id: "imp-2", status: "FAILED", name: "b", version: "1.0", failure: { code: "import_failed", message: "bad tasks.json" }, warnings: [] },
    });
    setMockResponse("/api/datasets/publish", {
      status: 202,
      body: { id: "imp-2", status: "QUEUED", name: "b", version: "1.0", failure: null, warnings: [] },
    });

    const failedIO = captureIO();
    const codeFailed = await runCli(
      ["dataset", "publish", "--git", "g", "--ref", "main", "--name", "b", "--version", "1.0", "--watch", ...AUTH],
      failedIO.io
    );
    assertEqual(codeFailed, 1, "exit code 1 on FAILED");
    assert(failedIO.out.some((l) => l.includes("bad tasks.json")), "final summary carries the error");

    const noWatch = captureIO();
    await runCli(
      ["dataset", "publish", "--git", "g", "--ref", "main", "--name", "b", "--version", "1.0", ...AUTH],
      noWatch.io
    );
    assert(
      noWatch.out.some((l) => l.includes("dataset show b")),
      "without --watch the follow hint points at dataset show (version state lives there)"
    );

    const noNetwork = fetchCalls.length;
    const noGit = captureIO();
    const codeNoGit = await runCli(["dataset", "publish", "--ref", "main", "--name", "b", ...AUTH], noGit.io);
    assertEqual(codeNoGit, 2, "publish without --git exits 2");
    assert(noGit.err[0].includes("--git"), "stderr names the missing flag");
    const both = captureIO();
    const codeBoth = await runCli(
      ["dataset", "publish", "--git", "g", "--ref", "r", "--dir", "/tmp", "--name", "b", "--version", "1", ...AUTH],
      both.io
    );
    assertEqual(codeBoth, 2, "--dir + --git refused");
    assertEqual(fetchCalls.length, noNetwork, "no network call on publish usage errors");
  } finally {
    restoreFetch();
  }
}

/**
 * The partial-publish model's CLI surfaces, all four reads:
 *
 *   1. `dataset show` renders the per-task states — the FAILED column and
 *      the failed-tasks block with each typed reason.
 *   2. `dataset publish --watch` prints every task's outcome once the build
 *      settles (outcomes land in one transaction at settle, not mid-build)
 *      and ends with "built N of M tasks — K failed to build" instead of
 *      dying on the first failure — and still exits 0, because READY (>= 1
 *      task built) is the settled success.
 *   3. `job show` renders the job's ran-N-of-M honesty note verbatim.
 *   4. `job start` naming a failed task surfaces the typed refusal with
 *      every quoted reason on stderr, and the full envelope under --json.
 */
async function testPartialPublishCliSurfaces() {
  console.log("\n--- runCli: partial-publish surfaces (dataset show / publish --watch / job show / job start refusal) ---");

  const partialDetail = (name: string, version: string): Record<string, unknown> => {
    const versionBody = {
      version,
      state: "READY",
      created_at: "2026-08-21T00:00:00Z",
      task_count: 10,
      n_failed_tasks: 2,
      manifest: null,
      source: null,
    };
    return {
      name,
      title: null,
      description: null,
      active_version: versionBody,
      versions: [versionBody],
      selected_version: versionBody,
      tasks: {
        items: [
          { task_name: "good-task", agent_timeout_sec: 600, verifier_timeout_sec: 120, providers: { e2b: { ok: true } } },
        ],
        nextCursor: null,
        hasMore: false,
      },
      failed_tasks: [
        {
          task_name: "broken-dockerfile",
          failure: { code: "image_build_failed", step: "image-build", message: "RUN apt-get install nonexistent-pkg exited 100" },
        },
        {
          task_name: "schema-typo",
          failure: { code: "task_parse_failed", step: "parse", message: "instruction.md is missing" },
        },
      ],
      upstream: null,
      created_at: "2026-08-21T00:00:00Z",
      updated_at: "2026-08-21T00:00:00Z",
    };
  };

  // 1. dataset show — the per-task states and their typed reasons.
  installMockFetch();
  try {
    setMockResponse("/api/datasets/part-swe", { status: 200, body: partialDetail("part-swe", "2.0") });
    const show = captureIO();
    assertEqual(await runCli(["dataset", "show", "part-swe@2.0", ...AUTH], show.io), 0, "show exits 0 on a partially built version");
    const text = show.out.join("\n");
    assert(/VERSION\s+STATE\s+TASKS\s+FAILED/.test(text), "the versions table gains a FAILED column");
    assert(text.includes("Failed tasks (version 2.0)"), "the failed-tasks block names the shown version");
    assert(
      text.includes("broken-dockerfile") && text.includes("image_build_failed (image-build): RUN apt-get install nonexistent-pkg exited 100"),
      "each failed task carries its typed reason"
    );
    assert(
      text.includes("schema-typo") && text.includes("task_parse_failed (parse): instruction.md is missing"),
      "parse-level refusals speak the same per-task vocabulary"
    );
    assert(text.includes("re-publish a new version"), "the fix is named: a re-publish (immutable versions)");
  } finally {
    restoreFetch();
  }

  // 2. dataset publish --watch — outcomes at settle + the honest summary.
  installMockFetch();
  try {
    const job = { id: "imp-9", name: "part-swe", version: "2.0", failure: null };
    setMockResponse("/api/datasets/publish", { status: 202, body: { ...job, status: "QUEUED", warnings: [] } });
    setMockResponse("/api/datasets/imports/imp-9", {
      status: 200,
      body: {
        ...job,
        status: "COMPLETED",
        task_count: 10,
        warnings: [{ code: "tasks_failed_to_build", message: "2 task(s) failed to build" }],
      },
    });
    setMockResponse("/api/datasets/part-swe?", { status: 200, body: partialDetail("part-swe", "2.0") });

    const watch = captureIO();
    const code = await runCli(
      ["dataset", "publish", "--git", "g", "--ref", "main", "--name", "part-swe", "--version", "2.0", "--watch", ...AUTH],
      watch.io
    );
    assertEqual(code, 0, "exit 0 — READY (at least one task built) is the settled success, not a death on first failure");
    const text = watch.out.join("\n");
    assert(
      text.includes("broken-dockerfile FAILED — image_build_failed (image-build)"),
      "per-task outcomes are printed once the build settles"
    );
    assert(
      watch.out.filter((l) => l.includes("broken-dockerfile FAILED")).length === 1,
      "each task's outcome is printed exactly once"
    );
    assert(
      text.includes("built 10 of 12 tasks — 2 failed to build"),
      "the final block states the summary plainly"
    );
    assert(text.includes("2 task(s) failed to build"), "the import warning renders too");
    assert(
      text.includes("dataset show part-swe@2.0"),
      "the summary points at where the reasons live"
    );
  } finally {
    restoreFetch();
  }

  // 3. job show — the ran-N-of-M honesty label, verbatim.
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({
        build_exclusions: [
          {
            dataset: { name: "part-swe", version: "2.0" },
            n_tasks_ran: 10,
            n_tasks_selected: 10,
            n_tasks_failed_to_build: 2,
            failed_task_names: ["broken-dockerfile", "schema-typo"],
            note: "ran 10 of 12 tasks — 2 failed to build (broken-dockerfile, schema-typo)",
          },
          // An n_tasks-capped dataset: the note's second, capped form —
          // rendered verbatim like any other.
          {
            dataset: { name: "big-swe", version: "1.0" },
            n_tasks_ran: 5,
            n_tasks_selected: 100,
            n_tasks_failed_to_build: 10,
            failed_task_names: ["broken-a", "broken-b"],
            note: "selection matched 110 tasks: 10 failed to build: broken-a, broken-b, …; ran 5 (n_tasks cap)",
          },
        ],
      }),
    });
    const showJob = captureIO();
    assertEqual(await runCli(["job", "show", "eval-1", ...AUTH], showJob.io), 0, "job show exits 0");
    assert(
      showJob.out.some((l) => l.includes("build exclusions") && l.includes("ran 10 of 12 tasks — 2 failed to build")),
      "the job body says ran-N-of-M plainly — silent truncation is forbidden"
    );
    assert(
      showJob.out.some((l) => l.includes("selection matched 110 tasks: 10 failed to build") && l.includes("ran 5 (n_tasks cap)")),
      "the capped form renders verbatim — the run was short for two separate reasons"
    );

    // A fully built job keeps its exact output — no empty row.
    installMockFetch();
    setMockResponse("/api/jobs/eval-1", { status: 200, body: wireJob() });
    const clean = captureIO();
    await runCli(["job", "show", "eval-1", ...AUTH], clean.io);
    assert(!clean.out.some((l) => l.includes("build exclusions")), "no exclusions row when nothing was excluded");
  } finally {
    restoreFetch();
  }

  // 4. job start naming a FAILED task — the typed refusal, reasons quoted.
  //
  // The details.failed_tasks entries here pin the SERVER's wire contract
  // (spec/openapi.yaml's 409 description; api-errors.ts on the platform):
  // the same nested {task_name, failure: {code, step, message}} grammar as
  // the dataset detail's failed_tasks. An entry whose failure was never
  // recorded must still render honestly — the fallback line, never a crash.
  installMockFetch();
  try {
    const sentence = 'task "broken-dockerfile" failed to build in part-swe@2.0';
    setMockResponse("/api/jobs", {
      status: 409,
      body: {
        error: {
          code: "task_failed_to_build",
          message: sentence,
          param: "datasets[0].task_names",
          details: {
            failed_tasks: [
              {
                task_name: "broken-dockerfile",
                failure: { code: "image_build_failed", step: "image-build", message: "RUN apt-get install nonexistent-pkg exited 100" },
              },
              // No failure object recorded — the honest-fallback case.
              { task_name: "orphaned-outcome" },
            ],
          },
        },
      },
    });
    const startArgs = ["job", "start", "-d", "part-swe@2.0", "-i", "broken-dockerfile", "-a", "codex", "-m", "gpt-5.5"];

    const human = captureIO();
    assertEqual(await runCli([...startArgs, ...AUTH], human.io), 1, "the typed refusal exits 1");
    assertEqual(human.out, [], "nothing on stdout in human mode");
    assert(human.err[0] === `Error: ${sentence}`, "stderr leads with the server's sentence");
    assert(
      human.err.some((l) => l.includes("broken-dockerfile: image_build_failed (image-build): RUN apt-get install nonexistent-pkg exited 100")),
      "every named task's build failure is quoted on stderr as code (step): message"
    );
    assert(
      human.err.some((l) => l.includes("orphaned-outcome: build failed (reason not recorded)")),
      "an entry with no recorded failure renders the honest fallback"
    );
    assert(
      human.err.some((l) => l.includes("re-publish a new version")),
      "the fix is named beside the refusal"
    );

    const json = captureIO();
    assertEqual(await runCli([...startArgs, "--json", ...AUTH], json.io), 1, "--json keeps exit 1");
    const parsed = JSON.parse(json.out[0]);
    assertEqual(parsed.error.code, "task_failed_to_build", "--json carries the typed code");
    assertEqual(
      parsed.error.details.failed_tasks[0].failure.code,
      "image_build_failed",
      "--json carries details.failed_tasks verbatim for machines"
    );
  } finally {
    restoreFetch();
  }
}

async function testDatasetDownloadAndActivate() {
  console.log("\n--- runCli: dataset download + activate ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `cli-ds-dl-${Date.now()}`);
  try {
    const pkg = Buffer.from("corpus bytes");
    setMockResponse("/api/datasets/acme/versions/1.1/activate", {
      status: 200,
      body: {
        name: "acme",
        title: null,
        description: null,
        active_version: { version: "1.1", state: "READY", created_at: "2026-07-01T00:00:00Z", task_count: 3 },
        versions: [{ version: "1.1", state: "READY", created_at: "2026-07-01T00:00:00Z", task_count: 3 }],
        selected_version: null,
        tasks: { items: [], nextCursor: null, hasMore: false },
        upstream: null,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    });
    setMockResponse("/api/datasets/acme/download", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: { "Content-Disposition": 'attachment; filename="acme@1.1-corpus.tar.gz"' },
    });

    const saved = captureIO();
    const code = await runCli(["dataset", "download", "acme@1.1", "-o", tmpDir, ...AUTH], saved.io);
    assertEqual(code, 0, "download exits 0");
    const downloadCall = fetchCalls[fetchCalls.length - 1];
    assert(downloadCall.url.includes("/api/datasets/acme/download"), "the positional is a dataset ref");
    assert(downloadCall.url.includes("version=1.1"), "ref version becomes ?version=");
    const written = await readFile(join(tmpDir, "acme@1.1-corpus.tar.gz"));
    assertEqual(written.equals(pkg), true, "file bytes match the package");

    const activate = captureIO();
    const activateCode = await runCli(["dataset", "activate", "acme", "1.1", ...AUTH], activate.io);
    assertEqual(activateCode, 0, "activate exits 0");
    const activateCall = fetchCalls[fetchCalls.length - 1];
    assert(activateCall.url.endsWith("/api/datasets/acme/versions/1.1/activate"), "hits the activate route");
    assertEqual(activateCall.init?.method, "POST", "activate uses POST");
    assert(activate.out.join("\n").includes("1.1"), "renders the new active version");

    const missing = captureIO();
    assertEqual(await runCli(["dataset", "activate", "acme", ...AUTH], missing.io), 2, "activate needs name AND version");

    // A still-building version refuses with the ordinary typed 409
    // version_not_ready (build-then-READY: activate never answers 202) —
    // rendered by the generic error path, exit 1.
    setMockResponse("/api/datasets/acme/versions/2.0/activate", {
      status: 409,
      body: {
        error: {
          code: "version_not_ready",
          message:
            "Dataset version acme@2.0 is in state BUILDING; a publish lands READY (and " +
            "active) on its own when it finishes building",
          details: { state: "BUILDING" },
        },
      },
    });
    const building = captureIO();
    const buildingCode = await runCli(["dataset", "activate", "acme", "2.0", ...AUTH], building.io);
    assertEqual(buildingCode, 1, "a still-building version exits 1 — nothing was activated");
    assert(
      building.err.some((l) => l.includes("version_not_ready") || l.includes("BUILDING")),
      "the refusal names the state on stderr, the ordinary typed-error path"
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

// =============================================================================
// AGENT — list, show, add, remove
// =============================================================================

const CLI_AGENT = {
  name: "acme-cli",
  source: "install_script",
  run_command: "acme-cli --headless",
  env: { ACME_PROFILE: "bench" },
  created_at: "2026-07-24T00:00:00Z",
  updated_at: "2026-07-24T00:00:00Z",
};

async function testAgentAdd() {
  console.log("\n--- runCli: agent add posts the install script and renders the agent ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-agent-cli-"));
  const scriptPath = join(dir, "install.sh");
  try {
    await writeFile(scriptPath, "curl -fsSL https://acme.dev/install.sh | sh\n");
    setMockResponse("/api/agents", { status: 201, body: CLI_AGENT });
    const { io, out, err } = captureIO();
    const code = await runCli(
      [
        "agent", "add", "acme-cli",
        "--install-script", scriptPath,
        "--run", "acme-cli --headless",
        "--ae", "ACME_PROFILE=bench",
        ...AUTH,
      ],
      io
    );
    assertEqual(code, 0, "exit 0");
    assertEqual(err, [], "nothing on stderr");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/agents"), "hits the agents route");
    assertEqual(call.init?.method, "POST", "uses POST");
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("name"), "acme-cli", "the positional becomes the name part");
    assertEqual(
      form.get("install_script"),
      "curl -fsSL https://acme.dev/install.sh | sh\n",
      "--install-script uploads the FILE CONTENTS, not the path"
    );
    assertEqual(form.get("run_command"), "acme-cli --headless", "run_command part");
    assertEqual(form.get("env"), JSON.stringify({ ACME_PROFILE: "bench" }), "--ae env is a JSON part");
    const text = out.join("\n");
    assert(text.includes("acme-cli"), "renders the agent name");
    assert(text.includes("install_script"), "renders the source");
    assert(text.includes("ACME_PROFILE"), "renders the declared env key");
    assert(!text.includes("=bench"), "does not echo declared env values into the terminal");
    assert(text.includes("-a acme-cli -m"), "prints the follow-up run hint in the new grammar");

    const noSource = captureIO();
    assertEqual(
      await runCli(["agent", "add", "x", "--run", "x", ...AUTH], noSource.io),
      2,
      "add without a source exits 2"
    );
    const bothSources = captureIO();
    assertEqual(
      await runCli(
        ["agent", "add", "x", "--run", "x", "--dir", dir, "--install-script", scriptPath, ...AUTH],
        bothSources.io
      ),
      2,
      "--dir + --install-script refused"
    );
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testAgentListShowRemove() {
  console.log("\n--- runCli: agent list / show / remove ---");
  installMockFetch();
  try {
    setMockResponse("/api/agents/acme-cli", { status: 200, body: CLI_AGENT });
    setMockResponse("/api/agents", {
      status: 200,
      body: { items: [CLI_AGENT], nextCursor: null, hasMore: false },
    });

    const list = captureIO();
    assertEqual(await runCli(["agent", "list", ...AUTH], list.io), 0, "list exits 0");
    assert(list.out[0].includes("NAME\tSOURCE"), "TSV header when piped");
    assert(list.out[1].startsWith("acme-cli\t"), "lists the agent row");

    const show = captureIO();
    assertEqual(await runCli(["agent", "show", "acme-cli", ...AUTH], show.io), 0, "show exits 0");
    assert(show.out.join("\n").includes("acme-cli --headless"), "renders the run command");

    setMockResponse("/api/agents/acme-cli", { status: 204, body: null });
    const remove = captureIO();
    assertEqual(await runCli(["agent", "remove", "acme-cli", ...AUTH], remove.io), 0, "remove exits 0");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/agents/acme-cli"), "remove targets the detail route");
    assertEqual(call.init?.method, "DELETE", "remove uses DELETE");
    assert(remove.out.some((l) => l.includes("Deleted agent acme-cli")), "confirms the delete");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// SKILL — list, upload, show, delete (the noun group over the skills() client)
// =============================================================================

const CLI_SKILL = {
  id: "6f6f1f36-1c60-4f8e-9e2b-2a54cbb0f2aa",
  name: "my-skill",
  digest: "sha256:" + "a".repeat(64),
  size_bytes: 2048,
  description: "Does one thing well",
  ref: "upload:6f6f1f36-1c60-4f8e-9e2b-2a54cbb0f2aa",
  created_at: "2026-08-06T00:00:00Z",
};

async function testSkillUpload() {
  console.log("\n--- runCli: skill upload streams the folder and prints both handles ---");
  // The archive rides node:http, not fetch (the F1 fix), so this test runs a
  // real local server and points --base-url at it.
  const { createServer } = await import("node:http");
  const calls: { url: string; method: string; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      calls.push({ url: req.url ?? "", method: req.method ?? "", body: Buffer.concat(chunks) });
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ skills: [CLI_SKILL] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const dir = await mkdtemp(join(tmpdir(), "evolve-skill-cli-"));
  const skillDir = join(dir, "my-skill");
  try {
    await mkdir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), "# my-skill\n\nDoes one thing well.\n");

    const { io, out, err } = captureIO();
    const code = await runCli(
      ["skill", "upload", skillDir, "--api-key", "test-key", "--base-url", `http://127.0.0.1:${port}`],
      io
    );
    assertEqual(code, 0, "exit 0");
    assertEqual(err, [], "nothing on stderr");
    const call = calls[calls.length - 1];
    assertEqual(call.url, "/api/skills", "hits the skills route");
    assertEqual(call.method, "POST", "uses POST");
    assert(
      call.body.includes('name="name"') && call.body.includes("my-skill"),
      "the folder's own name travels as the name part"
    );
    assert(call.body.includes('name="archive"'), "the content rides as the archive part");
    const text = out.join("\n");
    assert(text.includes(CLI_SKILL.ref), "prints the immutable upload:<id> handle");
    assert(text.includes("my-skill"), "prints the record's name");
    assert(text.includes(CLI_SKILL.digest), "prints the content digest");
    assert(text.includes("name:my-skill"), "the follow-up hint offers the moving name pointer");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSkillListShowDelete() {
  console.log("\n--- runCli: skill list / show (id or name:) / delete ---");
  installMockFetch();
  try {
    // Insertion order matters: most-specific patterns first.
    setMockResponse("/api/skills/name%3Amy-skill", {
      status: 200,
      body: { ...CLI_SKILL, skill_md: "# my-skill\n\nManifest body." },
    });
    setMockResponse(`/api/skills/${CLI_SKILL.id}`, { status: 204, body: null });
    setMockResponse("/api/skills", {
      status: 200,
      body: { items: [CLI_SKILL], nextCursor: null, hasMore: false },
    });

    const list = captureIO();
    assertEqual(await runCli(["skill", "list", ...AUTH], list.io), 0, "list exits 0");
    assert(list.out[0].includes("NAME\tID"), "TSV header when piped");
    assert(list.out[1].startsWith("my-skill\t"), "lists the skill row");
    assert(list.out[1].includes("sha256:aaaaaaaaaaaa"), "row carries the short digest");

    const quiet = captureIO();
    assertEqual(await runCli(["skill", "list", "-q", ...AUTH], quiet.io), 0, "-q exits 0");
    assertEqual(quiet.out, [CLI_SKILL.id], "-q prints ids only");

    // `skill show name:<x>` passes the string through — the SERVER resolves
    // the moving pointer; the CLI encodes it into the path and nothing more.
    const show = captureIO();
    assertEqual(await runCli(["skill", "show", "name:my-skill", ...AUTH], show.io), 0, "show exits 0");
    const showCall = fetchCalls[fetchCalls.length - 1];
    assert(showCall.url.endsWith("/api/skills/name%3Amy-skill"), "show passes name:<x> through, URL-encoded");
    const showText = show.out.join("\n");
    assert(showText.includes(CLI_SKILL.ref), "show prints the current record's upload:<id>");
    assert(showText.includes("Manifest body."), "show prints the SKILL.md text");

    const remove = captureIO();
    assertEqual(await runCli(["skill", "delete", CLI_SKILL.id, ...AUTH], remove.io), 0, "delete exits 0");
    const delCall = fetchCalls[fetchCalls.length - 1];
    assert(delCall.url.endsWith(`/api/skills/${CLI_SKILL.id}`), "delete targets the detail route");
    assertEqual(delCall.init?.method, "DELETE", "delete uses DELETE");
    assert(remove.out.some((l) => l.includes(`Deleted skill ${CLI_SKILL.id}`)), "confirms the delete");
  } finally {
    restoreFetch();
  }
}

async function testSkillDeleteInUseVerbatim() {
  console.log("\n--- runCli: skill delete surfaces the skill_in_use refusal verbatim ---");
  installMockFetch();
  try {
    const sentence =
      `Skill "${CLI_SKILL.id}" is referenced by a job that is not finished (eval-9); wait for it or cancel it first`;
    setMockResponse(`/api/skills/${CLI_SKILL.id}`, {
      status: 409,
      body: { error: { code: "skill_in_use", message: sentence } },
    });
    const { io, out, err } = captureIO();
    const code = await runCli(["skill", "delete", CLI_SKILL.id, ...AUTH], io);
    assertEqual(code, 1, "a server refusal is exit 1");
    assertEqual(err, [`Error: ${sentence}`], "the server's sentence reaches stderr VERBATIM, one line");
    assertEqual(out, [], "a refusal prints nothing on stdout");
  } finally {
    restoreFetch();
  }
}

async function testSkillNamePassThroughOnStart() {
  console.log("\n--- runCli: --skill name:<x> rides the job body untouched — no upload, no resolution ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", { status: 202, body: wireJob() });
    const { io } = captureIO();
    const code = await runCli(
      ["job", "start", "-d", "deep-swe", "-a", "codex", "-m", "gpt-5.5", "--skill", "name:frontend-design", ...AUTH],
      io
    );
    assertEqual(code, 0, "exit 0");
    assert(
      !fetchCalls.some((c) => c.url.includes("/api/skills")),
      "a name pointer is NOT a local folder — nothing is uploaded"
    );
    const createCall = fetchCalls.find((c) => c.url === `${BASE}/api/jobs`);
    const body = JSON.parse(createCall?.init?.body as string);
    assertEqual(
      body.agents[0].skills,
      ["name:frontend-design"],
      "the body carries name:<x> verbatim — resolution is the server's"
    );
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// AUTH
// =============================================================================

/**
 * A local server for the CLI verbs whose archive rides node:http (the F1
 * fix bypasses fetch, so the fetch mock never sees these uploads). The reply
 * is mutable so one server can play a 201 and then a typed refusal.
 */
async function startUploadCaptureServer(): Promise<{
  base: string;
  calls: { url: string; method: string; body: Buffer }[];
  setReply: (status: number, body: unknown) => void;
  close: () => Promise<void>;
}> {
  const { createServer } = await import("node:http");
  const calls: { url: string; method: string; body: Buffer }[] = [];
  let reply: { status: number; body: unknown } = { status: 201, body: {} };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      calls.push({ url: req.url ?? "", method: req.method ?? "", body: Buffer.concat(chunks) });
      res.statusCode = reply.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = (server.address() as { port: number });
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    setReply: (status, body) => {
      reply = { status, body };
    },
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

async function testUploadVerb() {
  console.log("\n--- runCli: evolve upload streams a job directory and renders the created record ---");
  installMockFetch();
  const server = await startUploadCaptureServer();
  const dir = await mkdtemp(join(tmpdir(), "evolve-upload-cli-"));
  const jobDir = join(dir, "2026-08-27__12-00-00");
  try {
    await mkdir(join(jobDir, "trial-1"), { recursive: true });
    await writeFile(join(jobDir, "result.json"), JSON.stringify({ id: "orig-123" }));
    await writeFile(join(jobDir, "config.json"), JSON.stringify({ job_name: "2026-08-27__12-00-00" }));
    await writeFile(join(jobDir, "trial-1", "result.json"), JSON.stringify({ trial_name: "trial-1" }));
    const uploaded = wireJob({
      id: "eval-up1",
      job_name: "2026-08-27__12-00-00",
      status: "COMPLETED",
      // Null exactly on an uploaded job: nothing executed here.
      sandbox_provider: null,
      trials: { total: 2, byStatus: { ...ZERO_TRIAL_STATUSES, SCORED: 2 } },
      upload: {
        original_job_id: "orig-123",
        original_job_name: "2026-08-27__12-00-00",
        uploaded_at: "2026-08-28T10:00:00.000Z",
        reported_totals: {
          cost_usd: 2.5,
          n_input_tokens: 2400,
          n_cache_tokens: 600,
          n_output_tokens: 1600,
          n_trials_reporting: 1,
        },
      },
      finished_at: "2026-08-28T10:00:00.000Z",
    });
    server.setReply(201, uploaded);

    const { io, out, err } = captureIO();
    const code = await runCli(
      ["upload", jobDir, "-d", "deep-swe@1.1", "--api-key", "test-key", "--base-url", server.base],
      io
    );
    assertEqual(code, 0, "exit 0");
    assertEqual(err, [], "nothing on stderr");

    const call = server.calls[server.calls.length - 1];
    assertEqual(call.url, "/api/jobs/upload", "POSTs /api/jobs/upload");
    assertEqual(call.method, "POST", "uses POST");
    assert(
      call.body.includes('name="dataset"') && call.body.includes("deep-swe@1.1"),
      "-d rides as the dataset part"
    );
    assert(call.body.includes('name="archive"'), "the packed tree is the archive part");

    const text = out.join("\n");
    assert(text.includes("eval-up1"), "prints the minted job id");
    assert(text.includes("COMPLETED"), "prints the terminal status");
    assert(text.includes("2 trial(s)"), "prints the trial count");
    assert(
      text.includes("2026-08-28T10:00:00.000Z") && text.includes("orig-123"),
      "prints the upload provenance (when + the archive's own identity)"
    );
    // The provider cell: the wire is null (nothing executed), and the render
    // says `ported` — derived from the provenance, never a stored value.
    assert(
      out.some((l) => l.includes("provider") && l.includes("ported")),
      "the provider cell renders ported for an ingested record"
    );
    // THE RULED MONEY SLOT: the spent row itself carries the archive's
    // aggregated REPORTED figure, labeled, with the completeness count —
    // never blended with metered spend, which is null for uploads.
    assert(
      out.some(
        (l) =>
          l.includes("spent") &&
          l.includes("reported $2.50") &&
          l.includes("(1/2 trials reporting)")
      ),
      "the spent slot renders `reported $X.XX (N/M trials reporting)`"
    );
    assert(
      out.some((l) => l.includes("reported tokens") && l.includes("in 2400") && l.includes("out 1600")),
      "the reported-tokens row carries the archive's counts"
    );

    // The list's SPENT cell follows the same law, compactly labeled.
    setMockResponse("/api/jobs", {
      status: 200,
      body: { items: [uploaded], nextCursor: null, hasMore: false },
    });
    const list = captureIO();
    assertEqual(await runCli(["job", "list", ...AUTH], list.io), 0, "job list exits 0");
    assert(
      list.out.some((l) => l.includes("eval-up1") && l.includes("reported $2.50")),
      "the SPENT cell renders the reported figure with the label"
    );
    assert(out[out.length - 1].includes("evolve analyze eval-up1"), "the next-step hint is analyze");
  } finally {
    await server.close();
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUploadVerbJsonAndGate() {
  console.log("\n--- runCli: evolve upload --json, the dir gate, and usage errors ---");
  installMockFetch();
  const server = await startUploadCaptureServer();
  const dir = await mkdtemp(join(tmpdir(), "evolve-upload-cli-gate-"));
  const jobDir = join(dir, "job");
  try {
    await mkdir(jobDir, { recursive: true });

    // The dir gate refuses client-side with Harbor's own sentence — exit 1,
    // nothing uploaded.
    const gate = captureIO();
    assertEqual(await runCli(["upload", jobDir, ...AUTH], gate.io), 1, "a non-job dir exits 1");
    assertEqual(
      gate.err[0],
      `Error: ${jobDir} does not contain result.json`,
      "Harbor's refusal sentence, verbatim"
    );
    assertEqual(fetchCalls.length, 0, "nothing is uploaded for a refused directory");

    // --json prints the created job as one document.
    await writeFile(join(jobDir, "result.json"), "{}");
    await writeFile(join(jobDir, "config.json"), "{}");
    const uploaded = wireJob({
      id: "eval-up2",
      status: "COMPLETED",
      upload: { original_job_id: null, original_job_name: null, uploaded_at: "2026-08-28T10:00:00.000Z" },
    });
    server.setReply(201, uploaded);
    const json = captureIO();
    assertEqual(
      await runCli(["upload", jobDir, "--json", "--api-key", "test-key", "--base-url", server.base], json.io),
      0,
      "--json exits 0"
    );
    const doc = JSON.parse(json.out[0]);
    assertEqual(doc.id, "eval-up2", "--json prints the job document");
    assertEqual(doc.upload.uploaded_at, "2026-08-28T10:00:00.000Z", "--json carries the provenance");

    // A typed refusal renders like every other API error, and --json wraps it.
    server.setReply(400, {
      error: { code: "not_a_job_dir", message: "Archive holds no result.json at its root" },
    });
    const refused = captureIO();
    assertEqual(
      await runCli(["upload", jobDir, "--json", "--api-key", "test-key", "--base-url", server.base], refused.io),
      1,
      "a typed refusal exits 1"
    );
    assertEqual(
      JSON.parse(refused.out[0]).error.code,
      "not_a_job_dir",
      "--json error envelope carries the server's code"
    );
    assert(refused.err[0].includes("no result.json"), "stderr carries the server's sentence");

    // Usage: the positional is required; help documents the top-level verb.
    const usage = captureIO();
    assertEqual(await runCli(["upload", ...AUTH], usage.io), 2, "no positional is a usage error");
    const help = captureIO();
    assertEqual(await runCli(["upload", "--help"], help.io), 0, "upload --help exits 0");
    assert(help.out.join("\n").includes("Usage: evolve upload <job_dir>"), "help documents evolve upload");
  } finally {
    await server.close();
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testAuthStatus() {
  console.log("\n--- runCli: auth status identifies the caller ---");
  installMockFetch();
  try {
    setMockResponse("/api/auth/status", {
      status: 200,
      body: {
        user_id: "user-1",
        email: "founder@example.com",
        key: { id: "key-1", label: "laptop", created_at: "2026-07-01T00:00:00Z", last_used_at: null },
      },
    });
    const { io, out } = captureIO();
    const code = await runCli(["auth", "status", ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    assert(fetchCalls[fetchCalls.length - 1].url.endsWith("/api/auth/status"), "hits the auth route");
    const text = out.join("\n");
    assert(text.includes("user-1") && text.includes("key-1") && text.includes("laptop"), "renders identity + key");

    const json = captureIO();
    await runCli(["auth", "status", "--json", ...AUTH], json.io);
    assertEqual(JSON.parse(json.out[0]).user_id, "user-1", "--json carries the typed body");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// SECRETS — evolve secrets set / list / delete
// =============================================================================

async function testSecretsVerbs() {
  console.log("\n--- runCli: secrets set / list / delete ---");

  console.log("  [grammar]");
  assertEqual(parseArgs(["secrets", "list"]).command, "secrets list", "secrets noun resolves");
  assertEqual(parseArgs(["secret", "list"]).command, "secrets list", "singular is a hidden alias");
  assertEqual(parseArgs(["secrets", "ls"]).command, "secrets list", "`ls` alias holds on secrets");

  console.log("  [set]");
  installMockFetch();
  try {
    setMockResponse("/api/managed-secrets", {
      status: 201,
      body: {
        status: "created",
        secret: {
          id: "secret_1",
          name: "GITHUB_TOKEN",
          label: "default",
          delivery: "brokered",
          allowed_hosts: ["api.github.com"],
          allowed_path_prefixes: ["/"],
          allowed_methods: ["GET"],
          enabled: true,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          last_used_at: null,
        },
      },
    });
    const { io, out } = captureIO();
    const code = await runCli(
      [
        "secrets", "set", "GITHUB_TOKEN",
        "--value", "ghp_secret_value",
        "--delivery", "brokered",
        "--allowed-host", "api.github.com",
        "--allowed-path-prefix", "/",
        "--allowed-method", "GET",
        ...AUTH,
      ],
      io
    );
    assertEqual(code, 0, "set exits 0");
    const post = fetchCalls.find(
      (call) => call.url.endsWith("/api/managed-secrets") && call.init?.method === "POST"
    );
    assert(post !== undefined, "set POSTs the managed-secrets door");
    const body = JSON.parse(String(post?.init?.body));
    assertEqual(body.allowed_hosts, ["api.github.com"], "wire carries snake_case scoping");
    assertEqual(body.delivery, "brokered", "wire carries the delivery mode");
    assert(!out.join("\n").includes("ghp_secret_value"), "the value is never echoed");
    assert(out.join("\n").includes("Stored env secret GITHUB_TOKEN"), "set narrates the stored row");

    // --delivery is required — refused before any request.
    fetchCalls.length = 0;
    const missing = captureIO();
    const missingCode = await runCli(
      ["secrets", "set", "GITHUB_TOKEN", "--value", "v", ...AUTH],
      missing.io
    );
    assertEqual(missingCode, 2, "missing --delivery is a usage error");
    assertEqual(fetchCalls.length, 0, "no request is made without --delivery");
  } finally {
    restoreFetch();
  }

  console.log("  [list]");
  installMockFetch();
  try {
    setMockResponse("/api/managed-secrets", {
      status: 200,
      body: {
        secrets: [
          {
            id: "secret_1",
            name: "GITHUB_TOKEN",
            label: "default",
            delivery: "brokered",
            allowedHosts: ["api.github.com"],
            allowedPathPrefixes: ["/"],
            allowedMethods: ["GET"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
          },
        ],
      },
    });
    const { io, out } = captureIO(true);
    const code = await runCli(["secrets", "list", ...AUTH], io);
    assertEqual(code, 0, "list exits 0");
    const text = out.join("\n");
    assert(text.includes("GITHUB_TOKEN") && text.includes("brokered"), "table carries name + delivery");

    const quiet = captureIO();
    await runCli(["secrets", "list", "-q", ...AUTH], quiet.io);
    assertEqual(quiet.out, ["GITHUB_TOKEN"], "-q prints name only");
  } finally {
    restoreFetch();
  }

  console.log("  [delete]");
  installMockFetch();
  try {
    setMockResponse("/api/managed-secrets", {
      status: 200,
      body: { ok: true, name: "GITHUB_TOKEN", label: "staging" },
    });
    const { io, out } = captureIO();
    const code = await runCli(
      ["secrets", "delete", "GITHUB_TOKEN", "--label", "staging", ...AUTH],
      io
    );
    assertEqual(code, 0, "delete exits 0");
    const del = fetchCalls.find(
      (call) => call.url.endsWith("/api/managed-secrets") && call.init?.method === "DELETE"
    );
    assert(del !== undefined, "delete DELETEs the managed-secrets door");
    assertEqual(JSON.parse(String(del?.init?.body)).label, "staging", "delete names the labeled row");
    assert(out.join("\n").includes("Deleted env secret GITHUB_TOKEN"), "delete narrates the resolved row");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// buildPublishInput / buildAgentInput direct coverage
// =============================================================================

function testBuildInputsDirect() {
  console.log("\n--- buildPublishInput / buildAgentInput ---");
  const git = buildPublishInput(
    parseArgs(["dataset", "publish", "--git", "g", "--ref", "r", "--name", "n", "--version", "1"])
  );
  assertEqual(
    git,
    { source: { git_url: "g", git_ref: "r" }, name: "n", version: "1" },
    "git publish input"
  );
  // --path narrows a git publish to one repository subfolder (wire: git_path).
  const gitSubfolder = buildPublishInput(
    parseArgs([
      "dataset", "publish",
      "--git", "g", "--ref", "r", "--path", "datasets/deep-swe",
      "--name", "n", "--version", "1",
    ])
  );
  assertEqual(
    gitSubfolder,
    {
      source: { git_url: "g", git_ref: "r", git_path: "datasets/deep-swe" },
      name: "n",
      version: "1",
    },
    "git publish with --path carries git_path"
  );
  // A subfolder narrows a git clone, not a local directory — with --dir the
  // user just points --dir at the subfolder itself.
  assertThrowsUsage(
    () => buildPublishInput(parseArgs(["dataset", "publish", "--dir", "/tmp/corpus", "--path", "tasks"])),
    "--git/--ref/--path",
    "--path beside --dir refuses"
  );
  const dirInput = buildPublishInput(
    parseArgs(["dataset", "publish", "--dir", "/tmp/corpus", "--name", "n", "--version", "1"])
  );
  assertEqual(
    dirInput,
    { source: { directory: "/tmp/corpus" }, name: "n", version: "1" },
    "directory publish input"
  );
  // --name/--version are OPTIONAL with --dir: a corpus carrying a dataset.toml
  // manifest supplies them server-side. The CLI passes the omission through —
  // the SDK (which can see the directory) refuses when no manifest exists.
  const manifestDir = buildPublishInput(parseArgs(["dataset", "publish", "--dir", "/tmp/corpus"]));
  assertEqual(
    manifestDir,
    { source: { directory: "/tmp/corpus" } },
    "directory publish without --name/--version carries neither (manifest supplies them)"
  );
  // A git source cannot lean on the manifest — the repo is cloned server-side
  // after the 202 — so the old requirement stands, with the reason.
  assertThrowsUsage(
    () => buildPublishInput(parseArgs(["dataset", "publish", "--git", "g", "--ref", "r", "--version", "1"])),
    "--name",
    "git publish without --name still refuses"
  );
  assertThrowsUsage(
    () => buildPublishInput(parseArgs(["dataset", "publish", "--git", "g", "--ref", "r", "--name", "n"])),
    "--version",
    "git publish without --version still refuses"
  );

  // --from, hub spelling: hub:org/name[@ref] — the reference part is Harbor's
  // own grammar; name/version pass through only when given (the server
  // defaults them from the resolved package).
  const hub = buildPublishInput(
    parseArgs(["dataset", "publish", "--from", "hub:cookbook/hello-world@3"])
  );
  assertEqual(
    hub,
    { source: { hub_package: "cookbook/hello-world@3" } },
    "hub publish input carries the bare reference and neither default"
  );
  const hubNamed = buildPublishInput(
    parseArgs(["dataset", "publish", "--from", "hub:cookbook/test", "--name", "n", "--version", "9"])
  );
  assertEqual(
    hubNamed,
    { source: { hub_package: "cookbook/test" }, name: "n", version: "9" },
    "explicit --name/--version ride beside the hub reference"
  );
  // --from, url spelling: a public https tarball; name/version are REQUIRED
  // (the server fetches only after the 202 has promised a name).
  const fromUrl = buildPublishInput(
    parseArgs(["dataset", "publish", "--from", "https://x.test/c.tar.gz", "--name", "n", "--version", "1"])
  );
  assertEqual(
    fromUrl,
    { source: { archive_url: "https://x.test/c.tar.gz" }, name: "n", version: "1" },
    "url publish input maps to archive_url"
  );
  assertThrowsUsage(
    () => buildPublishInput(parseArgs(["dataset", "publish", "--from", "https://x.test/c.tar.gz", "--version", "1"])),
    "--name",
    "--from <url> without --name refuses"
  );
  assertThrowsUsage(
    () => buildPublishInput(parseArgs(["dataset", "publish", "--from", "http://x.test/c.tar.gz", "--name", "n", "--version", "1"])),
    "https",
    "--from with a non-https, non-hub value refuses"
  );
  assertThrowsUsage(
    () => buildPublishInput(parseArgs(["dataset", "publish", "--from", "hub:"])),
    "hub:org/name",
    "--from hub: with no reference refuses"
  );
  assertThrowsUsage(
    () => buildPublishInput(parseArgs(["dataset", "publish", "--from", "hub:a/b", "--dir", "/tmp/c"])),
    "EXACTLY ONE source",
    "--from beside --dir refuses"
  );
  assertThrowsUsage(
    () => buildPublishInput(parseArgs(["dataset", "publish", "--from", "hub:a/b", "--git", "g", "--ref", "r"])),
    "EXACTLY ONE source",
    "--from beside --git refuses"
  );

  const agent = buildAgentInput(
    parseArgs(["agent", "add", "acme", "--install-script", "/x.sh", "--run", "acme", "--ae", "A=1"]),
    () => "SCRIPT"
  );
  assertEqual(
    agent,
    { name: "acme", install_script: "SCRIPT", run_command: "acme", env: { A: "1" } },
    "agent input carries the script contents and env"
  );
  assertThrowsUsage(
    () => buildAgentInput(parseArgs(["agent", "add", "acme", "--install-script", "/x.sh"]), () => ""),
    "--run",
    "missing --run"
  );
}

// =============================================================================
// --ak agent kwargs — Harbor's grammar, config resolved client-side
// =============================================================================

function testAgentKwargs() {
  console.log("\n--- parseAgentKwargs / --ak stamping ---");

  // Harbor's value grammar (their cli/utils.py parse_kwargs): JSON first,
  // then Python literals, else the text verbatim.
  assertEqual(parseAgentKwargs(["k=3"]), { k: 3 }, "number value parses as JSON");
  assertEqual(parseAgentKwargs(["k=true"]), { k: true }, "json boolean");
  assertEqual(parseAgentKwargs(["k=True"]), { k: true }, "python True literal");
  assertEqual(parseAgentKwargs(["k=False"]), { k: false }, "python False literal");
  assertEqual(parseAgentKwargs(["k=None"]), { k: null }, "python None literal");
  assertEqual(parseAgentKwargs(["k=high"]), { k: "high" }, "bare word stays a string");
  assertEqual(parseAgentKwargs(['k={"a":1}']), { k: { a: 1 } }, "inline JSON object");
  assertEqual(
    parseAgentKwargs(["a=1", "a=2", "b=x"]),
    { a: 2, b: "x" },
    "repeats merge, last one wins (dict assignment, Harbor's behaviour)"
  );
  assertThrowsUsage(() => parseAgentKwargs(["noequals"]), "key=value", "malformed --ak pair");

  // config=<path>: resolved to the file's parsed content — the server never
  // reads a client path.
  const files: Record<string, string> = {
    "/s.json": '{"permissions":{"deny":["WebSearch"]}}',
    "/c.toml": 'model_reasoning_effort = "low"\n[sandbox_workspace_write]\nnetwork_access = false\n',
    "/bare": '{"a":1}',
    "/bad.json": "{nope",
    "/garbage": "]]not either[[",
  };
  const read = (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  };
  assertEqual(
    parseAgentKwargs(["config=/s.json"], read),
    { config: { permissions: { deny: ["WebSearch"] } } },
    "config JSON file resolves to its parsed object"
  );
  assertEqual(
    parseAgentKwargs(["config=/c.toml"], read),
    { config: { model_reasoning_effort: "low", sandbox_workspace_write: { network_access: false } } },
    "config TOML file resolves to its parsed table"
  );
  assertEqual(
    parseAgentKwargs(["config=/bare"], read),
    { config: { a: 1 } },
    "extensionless config file tries JSON first"
  );
  assertEqual(
    parseAgentKwargs(['config={"model":"x"}'], read),
    { config: { model: "x" } },
    "inline JSON config is passed through without touching the filesystem"
  );
  assertThrowsUsage(() => parseAgentKwargs(["config=/missing.json"], read), "cannot read", "unreadable config path");
  assertThrowsUsage(() => parseAgentKwargs(["config=/bad.json"], read), "not valid JSON", "malformed JSON config file");
  assertThrowsUsage(
    () => parseAgentKwargs(["config=/garbage"], read),
    "neither JSON nor TOML",
    "extensionless file that parses as nothing names both formats"
  );

  // Stamped on EVERY arm, like --effort; the server owns every refusal.
  const inv = parseArgs([
    "job", "start", "-d", "d", "-a", "claude", "-m", "opus", "-m", "sonnet",
    "--ak", "config=/s.json", "--ak", "max_turns=5",
  ]);
  const input = buildJobInput(inv, read);
  assertEqual(
    input.agents,
    [
      {
        name: "claude",
        model_name: "opus",
        kwargs: { config: { permissions: { deny: ["WebSearch"] } }, max_turns: 5 },
      },
      {
        name: "claude",
        model_name: "sonnet",
        kwargs: { config: { permissions: { deny: ["WebSearch"] } }, max_turns: 5 },
      },
    ],
    "--ak kwargs stamped on every arm"
  );
  const plain = buildJobInput(parseArgs(["job", "start", "-d", "d", "-a", "claude", "-m", "opus"]), read);
  assert(!("kwargs" in plain.agents[0]), "no kwargs key when --ak omitted");

  // --preset: the plain-words door, stamped on EVERY arm, verbatim — the
  // server owns the vocabulary and the per-agent guarantee refusal.
  const presetInv = parseArgs([
    "job", "start", "-d", "d", "-a", "codex", "-m", "gpt-5.6-sol", "-m", "gpt-5.5",
    "--preset", "no-internet",
  ]);
  const presetInput = buildJobInput(presetInv, read);
  assertEqual(
    presetInput.agents,
    [
      { name: "codex", model_name: "gpt-5.6-sol", preset: "no-internet" },
      { name: "codex", model_name: "gpt-5.5", preset: "no-internet" },
    ],
    "--preset stamped on every arm"
  );
  assert(!("preset" in plain.agents[0]), "no preset key when --preset omitted");
  // Verbatim pass-through: an unknown name is the SERVER's typed refusal
  // (invalid_input naming the vocabulary), never a second client-side table.
  const verbatim = buildJobInput(
    parseArgs(["job", "start", "-d", "d", "-a", "codex", "-m", "gpt-5.5", "--preset", "sealed"]),
    read
  );
  assertEqual(verbatim.agents[0].preset, "sealed", "--preset value rides verbatim; the server rules");
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log("evolve CLI Unit Tests\n");

  testGrammarResolution();
  testShortFlags();
  testBuildJobInputFlags();
  testBuildJobInputRetry();
  testSecretRefs();
  testInlineSecrets();
  testBuildJobInputTimeoutMultipliers();
  testBuildJobInputSkills();
  testBuildJobInputYesIsInert();
  testAgentKwargs();
  if (SPEC_AVAILABLE) await testConfigFileMerge();
  else console.log(`\n--- buildJobInput: -c config file — ${SPEC_SKIP_REASON}`);
  testYamlConfig();
  await testPrintConfig();
  await testHelpAndVersion();
  testImportStatusLine();
  testImportProgressLines();
  testEventLine();
  testTrialDetailLiveSpend();
  testTrialDetailSpendLane();
  testTrialUsageRendering();
  testTrialDetailGpuCost();
  testTrialDetailJudgeSplit();
  testBuildInputsDirect();
  await testRunWatchEndToEnd();
  await testRunWatchJsonAndQuiet();
  await testWatchFailedExitCode();
  await testUsageErrorExitCode();
  await testJsonErrorObject();
  await testJobListOutputModes();
  await testJobShowMultiId();
  await testJobShowUnmeasuredTotal();
  await testJobShowGpuCost();
  await testJobShowPassAtK();
  await testJobShowJudgeSplit();
  await testJobTrialsAndTasks();
  await testJobStopDatasetSugar();
  await testJobStopDatasetChunking();
  await testJobStopAllTerminalIsHonest();
  await testJobStopReportsThePartialItAlreadySettled();
  await testJobIdPrefixLaw();
  await testRateLimitSurfacesCleanly();
  await testJobResume();
  await testJobRetry();
  await testTrialRetry();
  await testJobRegrade();
  await testTrialRegrade();
  testLoadRubricFile();
  testBuildJobInputAnalyze();
  await testAnalyzeVerbEndToEnd();
  await testAnalyzeVerbJsonAndFailure();
  await testAnalyzeRefusalSurfacesVerbatim();
  await testJobShowAnalysisRows();
  testTrialDetailAnalysisRows();
  await testCompareCancelDownload();
  await testJobDelete();
  await testJobDownloadUnpackGuards();
  await testTrialShow();
  await testTrialShowUploaded();
  await testGpuSurfaces();
  await testTrialDownloadStream();
  await testTrialDownloadTrajectoryRefused();
  await testTrialDownloadSave();
  await testTrialDownloadUsageErrors();
  await testTrialStop();
  await testAnalysisShow();
  await testAnalysisTrace();
  await testAnalysisDownloadStream();
  await testAnalysisDownloadStreamRefusesOtherSpecies();
  await testAnalysisDownloadSave();
  await testAnalysisDownloadUsageErrors();
  await testDatasetListAndShow();
  await testDatasetProvenanceAndPinNotice();
  await testDatasetShowVersionSource();
  await testDatasetPublishWatch();
  await testDatasetWatchVerb();
  await testDatasetCheck();
  await testDatasetPublishRunsPreflightFirst();
  await testDatasetPublishJsonIsOneDocument();
  await testDatasetPublishWatchArchivingDisabled();
  await testDatasetPublishFailedAndErrors();
  await testPartialPublishCliSurfaces();
  await testDatasetDownloadAndActivate();
  await testAgentAdd();
  await testAgentListShowRemove();
  await testSkillUpload();
  await testSkillListShowDelete();
  await testSkillDeleteInUseVerbatim();
  await testSkillNamePassThroughOnStart();
  await testUploadVerb();
  await testUploadVerbJsonAndGate();
  await testAuthStatus();
  await testSecretsVerbs();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
