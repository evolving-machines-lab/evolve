#!/usr/bin/env tsx
/**
 * Unit Test: evolve-evals CLI (src/hosted/cli.ts)
 *
 * The noun-verb grammar: group resolution (singular canonical, plural and
 * `ls` hidden aliases, `run` = `job start`), short flags, repeatables,
 * the -c config loader (JSON + the YAML subset) with flag-over-file merging,
 * --print-config, per-command help with a worked example, --version, the
 * shared list output precedence (--json / -q / TSV / TTY table, --columns,
 * --no-trunc, --no-headers), and one mocked end-to-end pass over every verb:
 * job start/--watch/list/show/trials/tasks/compare/cancel/resume/regrade/
 * download, trial show/download/regrade/stop, dataset
 * list/show/publish/download/activate, agent list/show/add/remove, auth
 * status. Exit codes: 0/1/2 pinned throughout.
 *
 * Uses mock fetch to test without real network calls.
 *
 * Usage:
 *   npx tsx tests/unit/hosted-cli.test.ts
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

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import {
  buildAgentInput,
  buildJobInput,
  buildPublishInput,
  CliUsageError,
  eventLine,
  importStatusLine,
  parseArgs,
  parseEnvPairs,
  parseYamlSubset,
  runCli,
  trialDetailLines,
} from "../../src/hosted/cli.ts";
import type { CliIO } from "../../src/hosted/cli.ts";
import type { Trial } from "../../src/hosted/types.ts";

const BASE = "http://localhost:3000";

function captureIO(tty = false): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l), tty }, out, err };
}

const AUTH = ["--api-key", "test-key", "--base-url", BASE];

// =============================================================================
// PARSING — grammar resolution
// =============================================================================

function testGrammarResolution() {
  console.log("\n--- parseArgs: noun-verb resolution and aliases ---");
  assertEqual(parseArgs(["job", "list"]).command, "job list", "noun verb resolves");
  assertEqual(parseArgs(["jobs", "list"]).command, "job list", "plural noun is a hidden alias");
  assertEqual(parseArgs(["job", "ls"]).command, "job list", "`ls` is a hidden alias of list");
  assertEqual(parseArgs(["run"]).command, "job start", "`run` is the top-level alias of job start");
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function testYamlSubset() {
  console.log("\n--- parseYamlSubset: the deliberate subset ---");
  assertEqual(
    parseYamlSubset(
      ["a: 1", "b: true", "c: null", "d: 'single''quoted'", 'e: "double"', "f: bare string", "g: [1, 2]"].join("\n"),
      "t.yaml"
    ),
    { a: 1, b: true, c: null, d: "single'quoted", e: "double", f: "bare string", g: [1, 2] },
    "scalars, quotes, and JSON flow lists"
  );
  assertEqual(
    parseYamlSubset(["list:", "  - one", '  - "two"', "  - 3"].join("\n"), "t.yaml"),
    { list: ["one", "two", 3] },
    "block sequences of scalars"
  );
  assertEqual(
    parseYamlSubset(["outer:", "  inner:", "    k: v"].join("\n"), "t.yaml"),
    { outer: { inner: { k: "v" } } },
    "nested block maps"
  );
  assertEqual(parseYamlSubset("# only comments\n\n", "t.yaml"), {}, "an empty document is an empty object");
  assertThrowsUsage(() => parseYamlSubset("a: &anchor 1", "t.yaml"), "anchors", "anchors refused loudly");
  assertThrowsUsage(() => parseYamlSubset("a: |", "t.yaml"), "multi-line", "block scalars refused loudly");
  assertThrowsUsage(() => parseYamlSubset("---\na: 1", "t.yaml"), "multi-document", "documents refused loudly");
  assertThrowsUsage(() => parseYamlSubset("\ta: 1", "t.yaml"), "tabs", "tab indentation refused");
  assertThrowsUsage(() => parseYamlSubset("a: [1, 2", "t.yaml"), "t.yaml:1", "broken flow list refused with its line number");

  // Campaign A1: the three parser defects, pinned. The law: a comment never
  // lands inside a value, and malformed input refuses with a line number.
  console.log("\n--- parseYamlSubset: trailing comments never land in values (A1) ---");
  assertEqual(
    parseYamlSubset('version: "1.3"          # pinned', "t.yaml"),
    { version: "1.3" },
    "a trailing comment after a double-quoted scalar is dropped, not an error"
  );
  assertEqual(
    parseYamlSubset("name: e2e-prod-check    # bare name -> active version resolution", "t.yaml"),
    { name: "e2e-prod-check" },
    "a trailing comment after a BARE scalar is dropped — never folded into the value"
  );
  assertEqual(
    parseYamlSubset(["datasets:", "  - name: claude            # alias-only probe"].join("\n"), "t.yaml"),
    { datasets: [{ name: "claude" }] },
    "the same law holds inside block sequences"
  );
  assertEqual(
    parseYamlSubset("url: http://x#frag", "t.yaml"),
    { url: "http://x#frag" },
    "a # without whitespace before it is content, not a comment (YAML's own rule)"
  );
  assertEqual(
    parseYamlSubset('note: "a # b"   # real comment', "t.yaml"),
    { note: "a # b" },
    "a # inside quotes is content; the one outside still strips"
  );

  console.log("\n--- parseYamlSubset: YAML flow collections, unquoted scalars included (A1) ---");
  assertEqual(
    parseYamlSubset("agent_env:    { CAMPAIGN_MARKER: prod-aug01 }", "t.yaml"),
    { agent_env: { CAMPAIGN_MARKER: "prod-aug01" } },
    "a flow mapping with unquoted key and value parses (was refused as non-JSON)"
  );
  assertEqual(
    parseYamlSubset("mix: { n: 3, flag: true, name: 'x', list: [a, 1] }", "t.yaml"),
    { mix: { n: 3, flag: true, name: "x", list: ["a", 1] } },
    "typed scalars, quotes, and nesting inside flow"
  );
  assertEqual(
    parseYamlSubset("tag: { MARKER: prod:tag }", "t.yaml"),
    { tag: { MARKER: "prod:tag" } },
    "a colon inside a flow value stays in the value"
  );
  assertEqual(
    parseYamlSubset('json: {"a": [1, 2], "b": {"c": null}}', "t.yaml"),
    { json: { a: [1, 2], b: { c: null } } },
    "strict JSON still parses unchanged"
  );
  assertThrowsUsage(() => parseYamlSubset("a: 1\nenv: { A: 1", "t.yaml"), "t.yaml:2", "an unclosed flow mapping refuses with its line number");
  assertThrowsUsage(() => parseYamlSubset("env: { A 1 }", "t.yaml"), '":"', "a flow mapping without a colon refuses loudly");
  assertThrowsUsage(() => parseYamlSubset("env: { A: 1 } trailing", "t.yaml"), "after flow", "content after a closed flow collection refuses loudly");
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
  assert(rootText.includes("Usage: evolve-evals"), "root help prints usage");
  assert(rootText.includes("job") && rootText.includes("dataset"), "root help names the groups");

  const group = captureIO();
  assertEqual(await runCli(["job"], group.io), 0, "bare group exits 0");
  assert(group.out.join("\n").includes("start"), "group help lists its verbs");

  const cmd = captureIO();
  assertEqual(await runCli(["job", "start", "--help"], cmd.io), 0, "command --help exits 0");
  const cmdText = cmd.out.join("\n");
  assert(cmdText.includes("-d, --dataset"), "command help shows the short + long flags");
  assert(cmdText.includes("Example:"), "command help carries a worked example");
  assert(cmdText.includes("evolve-evals job start -d "), "the example is a runnable line");

  const trialCmd = captureIO();
  await runCli(["help", "trial", "download"], trialCmd.io);
  const trialCmdText = trialCmd.out.join("\n");
  assert(trialCmdText.includes("--stream"), "help <group> <verb> resolves the command help");
  assert(
    trialCmdText.includes("trajectory (not served yet)"),
    "--stream help admits trajectory is ahead of its server wave"
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
  const job = { id: "imp-1", name: "my-bench", version: "1.0", warnings: [] };
  const imported = importStatusLine({ ...job, status: "COMPLETED", failure: null, task_count: 12 });
  assert(imported.includes("COMPLETED"), "includes the status");
  assert(imported.includes("tasks=12"), "includes the task count");
  const failedLine = importStatusLine({ ...job, status: "FAILED", failure: { code: "import_failed", message: "bad tasks.json", failures: [{ task_name: "t1", error: "boom" }] } });
  assert(failedLine.includes("FAILED") && failedLine.includes("bad tasks.json") && failedLine.includes("1 task failure"), "FAILED line carries message + failure count");
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
    assert(tty.out.some((l) => l.includes("More: evolve-evals job list --cursor cur-1")), "TTY shows the next-page hint");

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
    assertEqual(
      JSON.parse(out[out.length - 1]),
      { stopped: [], already_terminal: ["run-1", "run-2"], not_found: [] },
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

async function testCompareCancelDownload() {
  console.log("\n--- runCli: job compare / cancel / download ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `cli-job-dl-${Date.now()}`);
  try {
    setMockResponse("/api/jobs/eval-1/cancel", { status: 202, body: wireJob({ status: "CANCELLING" }) });
    setMockResponse("/api/jobs/eval-1/download", {
      status: 200,
      body: null,
      bodyBytes: Buffer.from("results bytes"),
      headers: { "Content-Disposition": 'attachment; filename="job-eval-1-results.tar.gz"' },
    });
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
    assert(fetchCalls[fetchCalls.length - 1].url.endsWith("/api/jobs/eval-1/download"), "hits the download route");
    const written = await readFile(join(tmpDir, "job-eval-1-results.tar.gz"));
    assertEqual(written.toString(), "results bytes", "-o saves the archive bytes");
    assert(download.out.some((l) => l.includes("job-eval-1-results.tar.gz")), "prints the saved path");
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

async function testTrialDownloadStream() {
  console.log("\n--- runCli: trial download --stream — the six-name artifact vocabulary ---");
  installMockFetch();
  try {
    setMockResponse("/trace?stream=trace-stdout", { status: 200, body: { log: "raw harness stdout" } });
    setMockResponse("/trace?stream=trajectory", { status: 200, body: { log: '{"steps":[]}' } });
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

    // The trajectory NAME is accepted now; the server may still refuse it
    // until its wave — here the mock serves it and the CLI passes it through.
    const trajectory = captureIO();
    assertEqual(
      await runCli(["trial", "download", "run-1", "--stream", "trajectory", ...AUTH], trajectory.io),
      0,
      "--stream trajectory is a valid selector"
    );
    assertEqual(trajectory.out, ['{"steps":[]}'], "prints the trajectory verbatim");

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
    // The graceful not-yet answer the spec promises until trajectory's wave
    // lands. The CLI's whole job is a clean relay: the server's own sentence,
    // one line, nothing invented and nothing on stdout.
    const sentence = "trajectory is not served yet; it arrives with a later wave";
    setMockResponse("/trace?stream=trajectory", {
      status: 404,
      body: { error: { code: "not_found", message: sentence } },
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
  console.log("\n--- runCli: trial download saves under <dir>/<trial-id>/; --overwrite gates ---");
  installMockFetch();
  const tmpDir = await mkdtemp(join(tmpdir(), "evolve-evals-trial-dl-"));
  try {
    // Stream selectors first: the mock matches by substring, and a plain
    // "/trace" pattern would swallow "/trace?stream=…" if it were checked first.
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
    const { io, out, err } = captureIO();
    const code = await runCli(["trial", "download", "run-1", "-o", tmpDir, ...AUTH], io);
    assertEqual(code, 0, "exit 0");
    assertEqual(err, [], "nothing on stderr");
    const target = join(tmpDir, "run-1");
    const parsed = await readFile(join(target, "trace-parsed.jsonl"), "utf-8");
    assert(parsed.includes('"seq":0'), "parsed events land in trace-parsed.jsonl");
    const verifier = await readFile(join(target, "verifier.log"), "utf-8");
    assertEqual(verifier, "verifier says 1.0", "each stored raw log lands under its own name");
    const home = await readFile(join(target, "agent-home", "root", ".claude", "history.jsonl"), "utf-8");
    assertEqual(home, "{}", "agent-home/ preserves the sandbox folder tree");
    // Null logs were never stored — absence is a normal answer, no empty files.
    let missingThrew = false;
    try {
      await readFile(join(target, "trace-stdout.log"), "utf-8");
    } catch {
      missingThrew = true;
    }
    assert(missingThrew, "an unstored artifact writes no file");
    assert(out.some((l) => l.includes("trace-parsed.jsonl")), "reports the parsed trace file");

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
    assert(err.some((l) => l.includes("trace-parsed") && l.includes("trajectory")), "names all six selectors");
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
        already_terminal: ["run-2"],
        not_found: ["run-3"],
      },
    });
    const { io, out } = captureIO();
    const code = await runCli(["trial", "stop", "run-1", "run-2", "run-3", ...AUTH], io);
    assertEqual(code, 0, "exit 0 — the report is the outcome");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/trials/stop"), "hits the stop route");
    assertEqual(
      JSON.parse(call.init?.body as string),
      { trial_ids: ["run-1", "run-2", "run-3"] },
      "posts every requested id"
    );
    assert(out.some((l) => l.includes("stopped run-1")), "reports the stopped trial");
    assert(out.some((l) => l.includes("already terminal run-2")), "reports the already-terminal id");
    assert(out.some((l) => l.includes("not found run-3")), "reports the unknown id (existence never leaked)");
  } finally {
    restoreFetch();
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
    assertEqual(code, 0, "exit code 0 on COMPLETED");
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
// AUTH
// =============================================================================

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
  const dirInput = buildPublishInput(
    parseArgs(["dataset", "publish", "--dir", "/tmp/corpus", "--name", "n", "--version", "1"])
  );
  assertEqual(
    dirInput,
    { source: { directory: "/tmp/corpus" }, name: "n", version: "1" },
    "directory publish input"
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
// MAIN
// =============================================================================

async function main() {
  console.log("evolve-evals CLI Unit Tests\n");

  testGrammarResolution();
  testShortFlags();
  testBuildJobInputFlags();
  testBuildJobInputYesIsInert();
  await testConfigFileMerge();
  testYamlSubset();
  await testPrintConfig();
  await testHelpAndVersion();
  testImportStatusLine();
  testEventLine();
  testTrialDetailLiveSpend();
  testBuildInputsDirect();
  await testRunWatchEndToEnd();
  await testRunWatchJsonAndQuiet();
  await testWatchFailedExitCode();
  await testUsageErrorExitCode();
  await testJobListOutputModes();
  await testJobShowMultiId();
  await testJobTrialsAndTasks();
  await testJobStopDatasetSugar();
  await testJobStopDatasetChunking();
  await testJobStopAllTerminalIsHonest();
  await testJobIdPrefixLaw();
  await testRateLimitSurfacesCleanly();
  await testJobResume();
  await testJobRegrade();
  await testTrialRegrade();
  await testCompareCancelDownload();
  await testTrialShow();
  await testTrialDownloadStream();
  await testTrialDownloadTrajectoryRefused();
  await testTrialDownloadSave();
  await testTrialDownloadUsageErrors();
  await testTrialStop();
  await testDatasetListAndShow();
  await testDatasetPublishWatch();
  await testDatasetPublishFailedAndErrors();
  await testDatasetDownloadAndActivate();
  await testAgentAdd();
  await testAgentListShowRemove();
  await testAuthStatus();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
