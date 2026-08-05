#!/usr/bin/env tsx
/**
 * Unit Test: evolve-evals CLI (src/hosted/cli.ts)
 *
 * The noun-verb grammar: group resolution (singular canonical, plural and
 * `ls` hidden aliases, `run` = `job start`), short flags, repeatables,
 * the -c config loader (JSON + real YAML via the yaml package, PyYAML's
 * readings pinned differentially) with flag-over-file merging,
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
  parseYamlConfig,
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
        "over-concurrency",
        "n_concurrent_trials: 64\ndatasets: [{name: deep-swe}]\nagents: [{name: claude, model_name: opus}]",
        ["must be at most 16"],
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

/**
 * GPU COST on the job card (lane 5): stats.gpu_cost_usd renders as its own
 * labeled row beside — never inside — the spent row, and a job without one
 * (no GPU trials, or an older server) shows no row at all.
 */
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
    assert(!text.includes("GATE"), "no GATE column when the server reports no gate (older server)");
  } finally {
    restoreFetch();
  }
}

async function testDatasetShowGate() {
  console.log("\n--- runCli: dataset show surfaces the activation gate ---");
  installMockFetch();
  try {
    const gateMessage = "1 of 1 task(s) failed the activation gate (1 not eligible, 0 unverified)";
    const goldReason =
      "gold run produced no usable score in 3 attempt(s) - last status: INDETERMINATE (the verifier produced neither reward.json nor reward.txt)";
    setMockResponse("/api/datasets/r1-init", {
      status: 200,
      body: {
        name: "r1-init",
        title: null,
        description: null,
        active_version: null,
        versions: [
          {
            version: "1.0",
            state: "FAILED",
            created_at: "2026-08-03T19:15:55.930Z",
            task_count: 1,
            gate: {
              status: "FAILED",
              attempts: 1,
              failure: {
                code: "gate_failed",
                message: gateMessage,
                failed_tasks: [
                  { task_name: "starter-task", outcome: "ERROR", reasons: [goldReason, "second reason"] },
                  { task_name: "quiet-task", outcome: "FAIL", reasons: [] },
                ],
              },
            },
          },
          {
            version: "0.9",
            state: "VALIDATING",
            created_at: "2026-08-01T00:00:00.000Z",
            task_count: 1,
            gate: { status: "RUNNING", attempts: 1 },
          },
        ],
        selected_version: null,
        tasks: { items: [], nextCursor: null, hasMore: false },
        upstream: null,
        created_at: "2026-08-03T19:15:55.921Z",
        updated_at: "2026-08-03T19:15:55.921Z",
      },
    });

    const show = captureIO();
    assertEqual(await runCli(["dataset", "show", "r1-init", ...AUTH], show.io), 0, "show exits 0");
    const text = show.out.join("\n");
    assert(text.includes("FAILED"), "the version state FAILED is visible");
    assert(text.includes("GATE"), "the versions table grows a GATE column when the server reports gate progress");
    assert(text.includes("RUNNING"), "a healthy in-progress gate shows its status");
    assert(
      text.includes(`version 1.0 activation gate FAILED: ${gateMessage}`),
      "a failed gate is unmissable: one line naming the version and the server's reason"
    );
    assert(
      text.includes(`  starter-task: ${goldReason}; second reason`),
      "the cause follows the verdict: one indented line per failed task, every reason joined"
    );
    assert(
      text.includes("  quiet-task: FAIL"),
      "a task the server names without reasons still gets its line — the outcome word stands in"
    );

    const json = captureIO();
    assertEqual(await runCli(["dataset", "show", "r1-init", "--json", ...AUTH], json.io), 0, "show --json exits 0");
    const body = JSON.parse(json.out.join("\n"));
    assertEqual(body.versions[0].state, "FAILED", "--json carries the version state");
    assertEqual(
      body.versions[0].gate,
      {
        status: "FAILED",
        attempts: 1,
        code: "gate_failed",
        message: gateMessage,
        failed_tasks: [
          { task_name: "starter-task", outcome: "ERROR", reasons: [goldReason, "second reason"] },
          { task_name: "quiet-task", outcome: "FAIL", reasons: [] },
        ],
      },
      "--json carries the gate: status, attempts, code, message, and the full failed_tasks array"
    );
    assertEqual(
      body.versions[1].gate,
      { status: "RUNNING", attempts: 1, code: null, message: null, failed_tasks: [] },
      "--json carries a healthy gate with null code/message and no failed tasks"
    );
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
  testYamlConfig();
  await testPrintConfig();
  await testHelpAndVersion();
  testImportStatusLine();
  testEventLine();
  testTrialDetailLiveSpend();
  testTrialDetailGpuCost();
  testBuildInputsDirect();
  await testRunWatchEndToEnd();
  await testRunWatchJsonAndQuiet();
  await testWatchFailedExitCode();
  await testUsageErrorExitCode();
  await testJsonErrorObject();
  await testJobListOutputModes();
  await testJobShowMultiId();
  await testJobShowGpuCost();
  await testJobTrialsAndTasks();
  await testJobStopDatasetSugar();
  await testJobStopDatasetChunking();
  await testJobStopAllTerminalIsHonest();
  await testJobStopReportsThePartialItAlreadySettled();
  await testJobIdPrefixLaw();
  await testRateLimitSurfacesCleanly();
  await testJobResume();
  await testJobRegrade();
  await testTrialRegrade();
  await testCompareCancelDownload();
  await testTrialShow();
  await testGpuSurfaces();
  await testTrialDownloadStream();
  await testTrialDownloadTrajectoryRefused();
  await testTrialDownloadSave();
  await testTrialDownloadUsageErrors();
  await testTrialStop();
  await testDatasetListAndShow();
  await testDatasetShowGate();
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
