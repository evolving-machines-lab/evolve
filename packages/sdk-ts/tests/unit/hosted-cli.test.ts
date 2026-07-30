#!/usr/bin/env tsx
/**
 * Unit Test: evolve-evals CLI (src/hosted/cli.ts)
 *
 * The CLI is in its SDK-RENAME SHIM state: the old command grammar bridged
 * onto the renamed SDK surface (datasets/agents/jobs/trials) and the renamed
 * wire. This suite pins that bridge: command parsing (flags, repeatable
 * --agent, csv --tasks, numbers, required flags, usage errors), the
 * --benchmark → datasets-selector translation, one mocked end-to-end
 * `run --watch` (POST /api/jobs -> SSE -> terminal status, request bodies,
 * rendered lines, exit code), `import` / `import status` against the publish
 * routes, regrade-returns-a-Job, the globally addressable trial/trace
 * commands, and `custom-harnesses` against the agents routes.
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  buildCustomHarnessInput,
  buildJobInput,
  buildImportInput,
  CliUsageError,
  eventLine,
  importStatusLine,
  parseJobAgent,
  parseArgs,
  runCli,
  trialDetailLines,
} from "../../src/hosted/cli.ts";
import type { CliIO } from "../../src/hosted/cli.ts";
import type { Trial } from "../../src/hosted/types.ts";

const BASE = "http://localhost:3000";

function captureIO(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

// =============================================================================
// PARSING TESTS
// =============================================================================

function testEffortFlag() {
  console.log("\n--- buildJobInput: --effort stamps EVERY agent, verbatim ---");
  const inv = parseArgs([
    "run",
    "--benchmark", "deep-swe@1.1",
    "--agent", "codex:gpt-5.5",
    "--agent", "gemini:gemini-3.5-flash-lite",
    "--effort", "low",
  ]);
  const input = buildJobInput(inv);
  assertEqual(
    input.agents,
    [
      { name: "codex", model_name: "gpt-5.5", reasoning_effort: "low" },
      // gemini gets the value TOO: the server's per-agent refusal is the
      // single source of truth, and the CLI silently unstamping some agents
      // would submit a sweep the flag no longer describes.
      { name: "gemini", model_name: "gemini-3.5-flash-lite", reasoning_effort: "low" },
    ],
    "--effort applied to every agent, refusal left to the server"
  );

  const bare = buildJobInput(parseArgs(["run", "--benchmark", "b@1", "--agent", "codex:m"]));
  assertEqual(bare.agents, [{ name: "codex", model_name: "m" }], "no --effort, no field — the server resolves its default");
}

function testParseRunFull() {
  console.log("\n--- parseArgs + buildJobInput: full run command ---");
  const inv = parseArgs([
    "run",
    "--benchmark", "deep-swe@1.1",
    "--agent", "codex:gpt-5.5",
    "--agent", "claude:sonnet:2.1.0",
    "--tasks", "task-a, task-b",
    "--runs", "2",
    "--concurrency", "4",
    "--max-trial-spend", "25",
    "--provider", "daytona",
    "--watch",
    "--json",
  ]);
  assertEqual(inv.command, "run", "command is run");
  assertEqual(inv.flags.watch, true, "--watch parsed as boolean");
  assertEqual(inv.flags.json, true, "--json parsed as boolean");
  assertEqual(inv.flags.agent, ["codex:gpt-5.5", "claude:sonnet:2.1.0"], "--agent is repeatable");

  const input = buildJobInput(inv);
  assertEqual(
    input,
    {
      datasets: [
        { name: "deep-swe", version: "1.1", task_names: ["task-a", "task-b"] },
      ],
      agents: [
        { name: "codex", model_name: "gpt-5.5" },
        { name: "claude", model_name: "sonnet", version: "2.1.0" },
      ],
      n_attempts: 2,
      n_concurrent_trials: 4,
      max_trial_spend_usd: 25,
      sandbox_provider: "daytona",
    },
    "builds the job-creation body (--benchmark → one dataset selector, csv tasks → task_names)"
  );
  assertEqual(
    Object.keys(input),
    [
      "datasets",
      "agents",
      "n_attempts",
      "n_concurrent_trials",
      "max_trial_spend_usd",
      "sandbox_provider",
    ],
    "body keys follow the contract field order"
  );
}

function testParseRunMinimal() {
  console.log("\n--- buildJobInput: minimal run omits optional fields ---");
  const inv = parseArgs([
    "run",
    "--benchmark=deep-swe@1.1",
    "--agent=codex:gpt-5.5",
    "--max-trial-spend=25",
  ]);
  const input = buildJobInput(inv);
  assertEqual(
    input,
    {
      datasets: [{ name: "deep-swe", version: "1.1" }],
      agents: [{ name: "codex", model_name: "gpt-5.5" }],
      max_trial_spend_usd: 25,
    },
    "--flag=value syntax works; optional fields absent"
  );
  assert(!("task_names" in input.datasets[0]), "no task_names key when --tasks omitted");
  assert(!("sandbox_provider" in input), "no provider key when --provider omitted");
}

function testParseRunNoSpendCap() {
  console.log("\n--- parseArgs + buildJobInput: --max-trial-spend is optional ---");
  // Not in the run command's required list: the server applies its own default
  // ($200 per trial, operator-tunable) and echoes the resolved cap back.
  const inv = parseArgs(["run", "--benchmark", "deep-swe", "--agent", "codex:gpt-5.5"]);
  const input = buildJobInput(inv);
  assertEqual(
    input,
    {
      datasets: [{ name: "deep-swe" }],
      agents: [{ name: "codex", model_name: "gpt-5.5" }],
    },
    "run parses without --max-trial-spend; a bare name selector carries no version"
  );
  // ABSENT, never a null/undefined key: an explicit null would defeat the
  // server-side default the omission is asking for.
  assert(
    !("max_trial_spend_usd" in input),
    "no cap key on the body when --max-trial-spend is omitted"
  );
}

function testParseJobAgent() {
  console.log("\n--- parseJobAgent: agent:model[:version] ---");
  assertEqual(
    parseJobAgent("codex:gpt-5.5"),
    { name: "codex", model_name: "gpt-5.5" },
    "two-part spec"
  );
  assertEqual(
    parseJobAgent("claude:sonnet:2.1.0"),
    { name: "claude", model_name: "sonnet", version: "2.1.0" },
    "three-part spec carries the version pin"
  );
  assertEqual(
    parseJobAgent("claude:sonnet:2.1.0:beta"),
    { name: "claude", model_name: "sonnet", version: "2.1.0:beta" },
    "extra colons stay in the version"
  );
  assertThrowsUsage(() => parseJobAgent("codex"), "agent:model", "bare agent rejected");
  assertThrowsUsage(() => parseJobAgent("codex:"), "agent:model", "empty model rejected");
  assertThrowsUsage(() => parseJobAgent(":gpt-5.5"), "agent:model", "empty agent rejected");
}

function testParseErrors() {
  console.log("\n--- parseArgs: usage errors ---");
  assertThrowsUsage(() => parseArgs([]), "No command", "empty argv");
  assertThrowsUsage(() => parseArgs(["frobnicate"]), "Unknown command", "unknown command");
  assertThrowsUsage(
    () => parseArgs(["run", "--benchmark", "b", "--max-trial-spend", "25"]),
    "--agent",
    "run without --agent"
  );
  assertThrowsUsage(
    () => parseArgs(["run", "--agent", "c:m", "--max-trial-spend", "25"]),
    "--benchmark",
    "run without --benchmark"
  );
  assertThrowsUsage(
    () => parseArgs(["run", "--benchmark", "b", "--agent", "c:m", "--max-trial-spend", "lots"]),
    "expects a number",
    "non-numeric --max-trial-spend"
  );
  assertThrowsUsage(
    () => parseArgs(["list", "--frob", "x"]),
    "Unknown option",
    "unknown flag"
  );
  assertThrowsUsage(() => parseArgs(["get"]), "<id>", "get without id");
  assertThrowsUsage(() => parseArgs(["get", "a", "b"]), "unexpected argument", "get with extra positional");
  assertThrowsUsage(() => parseArgs(["list", "--cursor"]), "requires a value", "flag missing its value");
}

function testParseOtherCommands() {
  console.log("\n--- parseArgs: other commands ---");
  assertEqual(
    parseArgs(["trials", "eval-1", "--limit", "10", "--cursor", "run-5"]),
    { command: "trials", positionals: ["eval-1"], flags: { limit: 10, cursor: "run-5" } },
    "trials with pagination"
  );
  assertEqual(
    parseArgs(["export", "eval-1", "--to", "/tmp/x"]),
    { command: "export", positionals: ["eval-1"], flags: { to: "/tmp/x" } },
    "export with --to (the standard results layout is the only layout — no --format)"
  );
  assertThrowsUsage(
    () => parseArgs(["export", "eval-1", "--format", "anything"]),
    "Unknown option",
    "the retired --format flag is refused"
  );
  assertEqual(
    parseArgs(["benchmarks", "get", "deep-swe@1.1"]),
    { command: "benchmarks", positionals: ["get", "deep-swe@1.1"], flags: {} },
    "benchmarks get subcommand"
  );
  assertEqual(parseArgs(["--help"]).command, "help", "--help maps to help");
  assertEqual(
    parseArgs(["trials", "eval-1", "--status", "INFRASTRUCTURE_ERROR,SCORING_ERROR"]),
    { command: "trials", positionals: ["eval-1"], flags: { status: "INFRASTRUCTURE_ERROR,SCORING_ERROR" } },
    "trials with a --status filter"
  );
  // A trial id is globally addressable now: one positional, no job id.
  assertEqual(
    parseArgs(["trial", "run-9"]),
    { command: "trial", positionals: ["run-9"], flags: {} },
    "trial detail command takes the trial id alone"
  );
  assertEqual(
    parseArgs(["trace", "run-9", "--cursor", "5", "--limit", "100"]),
    { command: "trace", positionals: ["run-9"], flags: { cursor: "5", limit: 100 } },
    "trace command with cursor/limit — one pagination vocabulary everywhere"
  );
  assertEqual(
    parseArgs(["trace", "run-9", "--stream", "trace-stdout"]),
    { command: "trace", positionals: ["run-9"], flags: { stream: "trace-stdout" } },
    "trace with --stream — the raw-artifact selector reaches the handler"
  );
  assertEqual(
    parseArgs(["trace", "run-9", "--save", "/tmp/out"]),
    { command: "trace", positionals: ["run-9"], flags: { save: "/tmp/out" } },
    "trace with --save — the target directory reaches the handler"
  );
  assertEqual(
    parseArgs(["compare", "eval-1", "eval-2", "eval-3"]),
    { command: "compare", positionals: ["eval-1", "eval-2", "eval-3"], flags: {} },
    "compare with 3 ids"
  );
  assertThrowsUsage(() => parseArgs(["compare", "eval-1"]), "<id> <id>", "compare needs at least 2 ids");
  assertThrowsUsage(() => parseArgs(["trace"]), "<trial-id>", "trace needs the trial id");
  assertEqual(
    parseArgs(["regrade", "eval-1"]),
    { command: "regrade", positionals: ["eval-1"], flags: {} },
    "regrade whole job"
  );
  assertEqual(
    parseArgs(["regrade", "eval-1", "run-9"]),
    { command: "regrade", positionals: ["eval-1", "run-9"], flags: {} },
    "regrade one trial (optional trial-id positional)"
  );
  assertEqual(
    parseArgs(["regrade", "eval-1", "--status", "SCORED,SCORING_ERROR", "--task", "abc"]),
    { command: "regrade", positionals: ["eval-1"], flags: { status: "SCORED,SCORING_ERROR", task: "abc" } },
    "regrade with --status + --task filter"
  );
  assertEqual(
    parseArgs(["regrade-job", "job-1"]),
    { command: "regrade-job", positionals: ["job-1"], flags: {} },
    "regrade-job read (a regrade IS a job)"
  );
  assertThrowsUsage(() => parseArgs(["regrade"]), "<id>", "regrade needs a job id");
  assertThrowsUsage(() => parseArgs(["regrade-job"]), "<job-id>", "regrade-job needs a job id");
}

function testParseImport() {
  console.log("\n--- parseArgs + buildImportInput: import command ---");
  const inv = parseArgs([
    "import",
    "--git", "https://github.com/acme/my-bench.git",
    "--ref", "main",
    "--name", "my-bench",
    "--version", "1.0",
    "--watch",
    "--json",
  ]);
  assertEqual(inv.command, "import", "command is import");
  assertEqual(inv.flags.watch, true, "--watch parsed as boolean");
  assertEqual(
    buildImportInput(inv),
    {
      source: { git_url: "https://github.com/acme/my-bench.git", git_ref: "main" },
      name: "my-bench",
      version: "1.0",
    },
    "builds the git publish input"
  );

  assertEqual(
    buildImportInput(
      parseArgs(["import", "--dir", "/path/to/corpus", "--name", "my-bench", "--version", "2.0"])
    ),
    {
      source: { directory: "/path/to/corpus" },
      name: "my-bench",
      version: "2.0",
    },
    "builds the directory publish input"
  );

  assertThrowsUsage(
    () =>
      buildImportInput(
        parseArgs([
          "import", "--dir", "/c", "--git", "g", "--ref", "main", "--name", "b", "--version", "1",
        ])
      ),
    "EITHER --dir OR",
    "--dir and --git/--ref together are rejected"
  );

  assertEqual(
    parseArgs(["import", "status", "imp-1"]),
    { command: "import", positionals: ["status", "imp-1"], flags: {} },
    "import status subcommand"
  );

  assertThrowsUsage(
    () => buildImportInput(parseArgs(["import", "--ref", "main", "--name", "b"])),
    "--git",
    "import without --git"
  );
  assertThrowsUsage(
    () => buildImportInput(parseArgs(["import", "--git", "g", "--name", "b"])),
    "--ref",
    "import without --ref"
  );
  assertThrowsUsage(
    () => buildImportInput(parseArgs(["import", "--git", "g", "--ref", "main"])),
    "--name",
    "import without --name"
  );
  assertThrowsUsage(
    () => buildImportInput(parseArgs(["import", "--git", "g", "--ref", "main", "--name", "b"])),
    "--version",
    "import without --version"
  );
}

function testParseCustomHarnesses() {
  console.log("\n--- parseArgs + buildCustomHarnessInput: custom-harnesses command ---");
  assertEqual(
    parseArgs(["custom-harnesses"]),
    { command: "custom-harnesses", positionals: [], flags: {} },
    "bare custom-harnesses lists"
  );
  assertEqual(
    parseArgs(["custom-harnesses", "get", "acme-cli"]),
    { command: "custom-harnesses", positionals: ["get", "acme-cli"], flags: {} },
    "custom-harnesses get subcommand"
  );
  assertEqual(
    parseArgs(["custom-harnesses", "remove", "acme-cli"]),
    { command: "custom-harnesses", positionals: ["remove", "acme-cli"], flags: {} },
    "custom-harnesses remove subcommand"
  );

  // --install-script names a FILE; the stub stands in for reading it.
  const readScript = (path: string) => `# from ${path}\ncurl -fsSL https://acme.dev/install.sh | sh\n`;
  assertEqual(
    buildCustomHarnessInput(
      parseArgs([
        "custom-harnesses", "add",
        "--name", "acme-cli",
        "--install-script", "./install.sh",
        "--run", "acme-cli --headless",
        "--env", "ACME_PROFILE=bench",
        "--env", "ACME_REGION=us",
      ]),
      readScript
    ),
    {
      name: "acme-cli",
      install_script: "# from ./install.sh\ncurl -fsSL https://acme.dev/install.sh | sh\n",
      run_command: "acme-cli --headless",
      env: { ACME_PROFILE: "bench", ACME_REGION: "us" },
    },
    "builds the install-script agent input (script contents, repeatable --env)"
  );

  assertEqual(
    buildCustomHarnessInput(
      parseArgs([
        "custom-harnesses", "add",
        "--name", "acme-cli",
        "--dir", "/path/to/harness",
        "--run", "acme-cli --headless",
      ]),
      readScript
    ),
    {
      name: "acme-cli",
      directory: "/path/to/harness",
      run_command: "acme-cli --headless",
    },
    "builds the directory agent input (no env key when --env omitted)"
  );

  assertThrowsUsage(
    () =>
      buildCustomHarnessInput(
        parseArgs([
          "custom-harnesses", "add",
          "--name", "a", "--dir", "/d", "--install-script", "./i.sh", "--run", "r",
        ]),
        readScript
      ),
    "EITHER --dir OR",
    "--dir and --install-script together are rejected"
  );
  assertThrowsUsage(
    () =>
      buildCustomHarnessInput(
        parseArgs(["custom-harnesses", "add", "--name", "a", "--run", "r"]),
        readScript
      ),
    "--install-script",
    "custom-harnesses add without a source"
  );
  assertThrowsUsage(
    () =>
      buildCustomHarnessInput(
        parseArgs(["custom-harnesses", "add", "--dir", "/d", "--run", "r"]),
        readScript
      ),
    "--name",
    "custom-harnesses add without --name"
  );
  assertThrowsUsage(
    () =>
      buildCustomHarnessInput(
        parseArgs(["custom-harnesses", "add", "--name", "a", "--dir", "/d"]),
        readScript
      ),
    "--run",
    "custom-harnesses add without --run"
  );
  assertThrowsUsage(
    () =>
      buildCustomHarnessInput(
        parseArgs([
          "custom-harnesses", "add", "--name", "a", "--dir", "/d", "--run", "r", "--env", "NOPE",
        ]),
        readScript
      ),
    "KEY=VALUE",
    "--env without an = is rejected"
  );
}

function testImportStatusLine() {
  console.log("\n--- importStatusLine: compact status lines ---");
  const job = { id: "imp-1", name: "my-bench", version: "1.0", warnings: [] };
  const imported = importStatusLine({ ...job, status: "COMPLETED", failure: null, task_count: 12 });
  assert(imported.includes("COMPLETED"), "includes the status");
  assert(imported.includes("tasks=12"), "includes the task count");
  const failed = importStatusLine({ ...job, status: "FAILED", failure: { code: "import_failed", message: "bad tasks.json", failures: [{ task_name: "t1", error: "boom" }] } });
  assert(failed.includes("FAILED") && failed.includes("bad tasks.json") && failed.includes("1 task failure"), "FAILED line carries message + failure count");
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

// =============================================================================
// trialDetailLines: live spend shown while RUNNING, gone once settled
// =============================================================================

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

// =============================================================================
// END-TO-END: run --watch (mocked)
// =============================================================================

function sseText(events: { seq: number; type: string; data: unknown }[]): string {
  return events
    .map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
}

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
        "--benchmark", "deep-swe@1.1",
        "--agent", "codex:gpt-5.5",
        "--runs", "1",
        "--concurrency", "4",
        "--max-trial-spend", "25",
        "--watch",
        "--api-key", "test-key",
        "--base-url", BASE,
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

async function testRunWatchJsonNdjson() {
  console.log("\n--- runCli: run --watch --json emits NDJSON ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([{ seq: 0, type: "job.completed", data: { job_id: "eval-1" } }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: wireJob({ status: "COMPLETED", finished_at: "2026-07-22T00:01:00.000Z" }),
    });
    setMockResponse("/api/jobs", { status: 202, body: wireJob() });

    const { io, out } = captureIO();
    const code = await runCli(
      ["run", "--benchmark", "deep-swe@1.1", "--agent", "codex:gpt-5.5", "--max-trial-spend", "25",
       "--watch", "--json", "--api-key", "test-key", "--base-url", BASE],
      io
    );

    assertEqual(code, 0, "exit code 0");
    const parsed = out.map((l) => JSON.parse(l));
    assertEqual(parsed[0].kind, "job.created", "first NDJSON line is the created job");
    assert(parsed.some((p) => p.kind === "event" && p.type === "job.completed"), "events are NDJSON lines");
    const final = parsed[parsed.length - 1];
    assertEqual(final.kind, "job.final", "last NDJSON line is the final job");
    assertEqual(final.job.status, "COMPLETED", "final job status present");
  } finally {
    restoreFetch();
  }
}

async function testImportWatchEndToEnd() {
  console.log("\n--- runCli: end-to-end import --watch against mocked API ---");
  installMockFetch();
  try {
    // Insertion order matters: most-specific patterns first.
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
        "import",
        "--git", "https://github.com/acme/my-bench.git",
        "--ref", "main",
        "--name", "my-bench",
        "--version", "1.0",
        "--watch",
        "--api-key", "test-key",
        "--base-url", BASE,
      ],
      io
    );

    assertEqual(code, 0, "exit code 0 on COMPLETED");
    assertEqual(err, [], "nothing on stderr");

    // The create request
    const createCall = fetchCalls.find((c) => c.url === `${BASE}/api/datasets/publish`);
    assert(createCall !== undefined, "POSTs /api/datasets/publish");
    assertEqual(createCall?.init?.method, "POST", "create uses POST");
    // ONE body grammar: multipart/form-data with named parts, so nothing rides
    // the query string on either upload route.
    const form = createCall?.init?.body as FormData;
    assert(form instanceof FormData, "create body is multipart/form-data");
    assertEqual(form.get("git_url"), "https://github.com/acme/my-bench.git", "git_url part");
    assertEqual(form.get("git_ref"), "main", "git_ref part");
    assertEqual(form.get("name"), "my-bench", "name part");
    assertEqual(form.get("version"), "1.0", "version part");

    // The watch poll
    const pollCall = fetchCalls.find((c) => c.url === `${BASE}/api/datasets/imports/imp-1`);
    assert(pollCall !== undefined, "polls GET /api/datasets/imports/<id>");

    // Rendered output
    assert(out[0].includes("imp-1") && out[0].includes("my-bench") && out[0].includes("watching"), "prints the created header");
    assert(out.some((l) => l.includes("COMPLETED") && l.includes("tasks=12")), "renders the COMPLETED status line");
  } finally {
    restoreFetch();
  }
}

async function testImportWatchFailedAndStatus() {
  console.log("\n--- runCli: import --watch FAILED exits 1; import status --json ---");
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

    const failed = captureIO();
    const codeFailed = await runCli(
      ["import", "--git", "g", "--ref", "main", "--name", "b", "--version", "1.0", "--watch",
       "--api-key", "test-key", "--base-url", BASE],
      failed.io
    );
    assertEqual(codeFailed, 1, "exit code 1 on FAILED");
    assert(failed.out.some((l) => l.includes("bad tasks.json")), "final summary carries the error");

    const status = captureIO();
    const codeStatus = await runCli(
      ["import", "status", "imp-2", "--json", "--api-key", "test-key", "--base-url", BASE],
      status.io
    );
    assertEqual(codeStatus, 0, "import status exits 0");
    assertEqual(
      JSON.parse(status.out[0]),
      {
        id: "imp-2",
        status: "FAILED",
        name: "b",
        version: "1.0",
        failure: { code: "import_failed", message: "bad tasks.json" },
        warnings: [],
      },
      "import status --json emits the self-describing job"
    );

    const noNetwork = fetchCalls.length;
    const badSub = captureIO();
    const codeBadSub = await runCli(["import", "frobnicate", "--api-key", "k", "--base-url", BASE], badSub.io);
    assertEqual(codeBadSub, 2, "unknown import subcommand exits 2");
    const noId = captureIO();
    const codeNoId = await runCli(["import", "status", "--api-key", "k", "--base-url", BASE], noId.io);
    assertEqual(codeNoId, 2, "import status without <id> exits 2");
    const noGit = captureIO();
    const codeNoGit = await runCli(["import", "--ref", "main", "--name", "b", "--api-key", "k", "--base-url", BASE], noGit.io);
    assertEqual(codeNoGit, 2, "import without --git exits 2");
    assert(noGit.err[0].includes("--git"), "stderr names the missing flag");
    assertEqual(fetchCalls.length, noNetwork, "no network call on import usage errors");
  } finally {
    restoreFetch();
  }
}

async function testUsageErrorExitCode() {
  console.log("\n--- runCli: usage errors exit 2, API errors exit 1 ---");
  installMockFetch();
  try {
    const bad = captureIO();
    const codeBad = await runCli(["run", "--benchmark", "b"], bad.io);
    assertEqual(codeBad, 2, "missing required flags exit 2");
    assert(bad.err[0].includes("--agent"), "stderr names the missing flag");
    assertEqual(fetchCalls.length, 0, "no network call on usage error");

    setMockResponse("/api/jobs/eval-x", {
      status: 404,
      body: { error: { code: "job_not_found", message: "Job not found: eval-x" } },
    });
    const notFound = captureIO();
    const codeApi = await runCli(
      ["get", "eval-x", "--api-key", "test-key", "--base-url", BASE],
      notFound.io
    );
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
// REGRADE — the response is a JOB
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

async function testRegradeCliCreate() {
  console.log("\n--- runCli: regrade <id> --task posts the filter and renders the job ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/regrade", { status: 202, body: CLI_REGRADE_JOB });
    const { io, out, err } = captureIO();
    const code = await runCli(
      ["regrade", "eval-1", "--task", "demo-task", "--api-key", "test-key", "--base-url", BASE],
      io
    );
    assertEqual(code, 0, "exit 0");
    assertEqual(err, [], "nothing on stderr");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/jobs/eval-1/regrade"), "hits the per-job regrade route");
    assertEqual(call.init?.method, "POST", "uses POST");
    assertEqual(JSON.parse(call.init?.body as string), { task_name: "demo-task" }, "sends the task_name filter");
    assert(out.some((l) => l.includes("regrade-1")), "renders the regrade JOB id");
    assert(out.some((l) => l.includes("regrade of") && l.includes("eval-1")), "renders the source-job provenance");
    assert(out.some((l) => l.includes("get regrade-1")), "prints the follow-up read hint — a regrade is read with get");
  } finally {
    restoreFetch();
  }
}

async function testRegradeCliPerTrial() {
  console.log("\n--- runCli: regrade <id> <trial-id> hits the global trial route ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1/regrade", { status: 202, body: CLI_REGRADE_JOB });
    const { io, out } = captureIO();
    const code = await runCli(
      ["regrade", "eval-1", "run-1", "--api-key", "test-key", "--base-url", BASE],
      io
    );
    assertEqual(code, 0, "exit 0");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/trials/run-1/regrade"), "the trial id alone addresses the regrade");
    assert(out.some((l) => l.includes("regrade-1")), "renders the regrade job");
  } finally {
    restoreFetch();
  }
}

async function testRegradeCliRead() {
  console.log("\n--- runCli: regrade-job <id> reads the regrade as a plain job ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/regrade-1", { status: 200, body: CLI_REGRADE_JOB });
    const { io, out } = captureIO();
    const code = await runCli(["regrade-job", "regrade-1", "--api-key", "test-key", "--base-url", BASE], io);
    assertEqual(code, 0, "exit 0");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/jobs/regrade-1"), "a regrade IS a job — read from /api/jobs");
    const text = out.join("\n");
    assert(text.includes("regrade of") && text.includes("eval-1"), "renders the provenance row");
    assert(text.includes("SCORED 1"), "renders the trial histogram");
  } finally {
    restoreFetch();
  }
}

async function testRegradeCliPerRunRejectsFilter() {
  console.log("\n--- runCli: regrade <id> <trial-id> --status is a usage error ---");
  const { io, err } = captureIO();
  const code = await runCli(
    ["regrade", "eval-1", "run-1", "--status", "SCORED", "--api-key", "k", "--base-url", BASE],
    io
  );
  assertEqual(code, 2, "usage error exit 2");
  assert(err.some((l) => l.includes("whole-job regrade")), "explains filters are for whole-job regrade");
}

// =============================================================================
// TRACE — globally addressable
// =============================================================================

async function testTraceStreamCli() {
  console.log("\n--- runCli: trace --stream prints one raw artifact ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1/trace?stream=trace-stdout", {
      status: 200,
      body: { log: "raw harness stdout" },
    });
    const { io, out, err } = captureIO();
    const code = await runCli(
      ["trace", "run-1", "--stream", "trace-stdout", "--api-key", "test-key", "--base-url", BASE],
      io
    );
    assertEqual(code, 0, "exit 0");
    assertEqual(err, [], "nothing on stderr");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.includes("/api/trials/run-1/trace?stream=trace-stdout"), "hits the global ?stream= route");
    assertEqual(out, ["raw harness stdout"], "prints the raw log verbatim");
  } finally {
    restoreFetch();
  }
}

async function testTraceSaveCli() {
  console.log("\n--- runCli: trace --save writes trace-parsed.jsonl + raw artifacts ---");
  installMockFetch();
  const tmpDir = await mkdtemp(join(tmpdir(), "evolve-evals-trace-"));
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
    const code = await runCli(
      ["trace", "run-1", "--save", tmpDir, "--api-key", "test-key", "--base-url", BASE],
      io
    );
    assertEqual(code, 0, "exit 0");
    assertEqual(err, [], "nothing on stderr");
    const parsed = await readFile(join(tmpDir, "trace-parsed.jsonl"), "utf-8");
    assert(parsed.includes('"seq":0'), "parsed events land in trace-parsed.jsonl");
    const verifier = await readFile(join(tmpDir, "verifier.log"), "utf-8");
    assertEqual(verifier, "verifier says 1.0", "each stored raw log lands under its own name");
    const home = await readFile(join(tmpDir, "agent-home", "root", ".claude", "history.jsonl"), "utf-8");
    assertEqual(home, "{}", "agent-home/ preserves the sandbox folder tree");
    // Null logs were never stored — absence is a normal answer, no empty files.
    let missingThrew = false;
    try {
      await readFile(join(tmpDir, "trace-stdout.log"), "utf-8");
    } catch {
      missingThrew = true;
    }
    assert(missingThrew, "an unstored artifact writes no file");
    assert(out.some((l) => l.includes("trace-parsed.jsonl")), "reports the parsed trace file");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testTraceUsageErrors() {
  console.log("\n--- runCli: trace flag misuse is a usage error (exit 2, not 1) ---");
  // Every case throws before any request is made, so no mock fetch is needed.
  {
    const { io, err } = captureIO();
    const code = await runCli(
      ["trace", "run-1", "--stream", "bogus", "--api-key", "k", "--base-url", BASE],
      io
    );
    assertEqual(code, 2, "invalid --stream value exits 2 like every other usage error");
    assert(err.some((l) => l.includes('--stream must be "verifier"')), "names the valid selectors");
  }
  {
    const { io, err } = captureIO();
    const code = await runCli(
      ["trace", "run-1", "--stream", "verifier", "--save", "/tmp/x", "--api-key", "k", "--base-url", BASE],
      io
    );
    assertEqual(code, 2, "--stream + --save refused, exit 2");
    assert(err.some((l) => l.includes("EITHER --stream OR --save")), "explains the exclusive modes");
  }
  {
    const { io, err } = captureIO();
    const code = await runCli(
      ["trace", "run-1", "--stream", "verifier", "--cursor", "5", "--api-key", "k", "--base-url", BASE],
      io
    );
    assertEqual(code, 2, "--cursor under --stream refused, exit 2");
    assert(err.some((l) => l.includes("page the parsed events")), "explains cursor/limit scope");
  }
  {
    const { io } = captureIO();
    const code = await runCli(
      ["trace", "run-1", "--save", "/tmp/x", "--limit", "10", "--api-key", "k", "--base-url", BASE],
      io
    );
    assertEqual(code, 2, "--limit under --save refused, exit 2");
  }
}

// =============================================================================
// CUSTOM HARNESSES (bridged onto the agents routes)
// =============================================================================

const CLI_AGENT = {
  name: "acme-cli",
  source: "install_script",
  run_command: "acme-cli --headless",
  env: { ACME_PROFILE: "bench" },
  created_at: "2026-07-24T00:00:00Z",
  updated_at: "2026-07-24T00:00:00Z",
};

async function testCustomHarnessesCliAdd() {
  console.log("\n--- runCli: custom-harnesses add posts the install script and renders the agent ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-harness-cli-"));
  const scriptPath = join(dir, "install.sh");
  try {
    await writeFile(scriptPath, "curl -fsSL https://acme.dev/install.sh | sh\n");
    setMockResponse("/api/agents", { status: 201, body: CLI_AGENT });
    const { io, out, err } = captureIO();
    const code = await runCli(
      [
        "custom-harnesses", "add",
        "--name", "acme-cli",
        "--install-script", scriptPath,
        "--run", "acme-cli --headless",
        "--env", "ACME_PROFILE=bench",
        "--api-key", "test-key", "--base-url", BASE,
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
    assertEqual(form.get("name"), "acme-cli", "name part");
    assertEqual(
      form.get("install_script"),
      "curl -fsSL https://acme.dev/install.sh | sh\n",
      "--install-script uploads the FILE CONTENTS, not the path"
    );
    assertEqual(form.get("run_command"), "acme-cli --headless", "run_command part");
    assertEqual(form.get("env"), JSON.stringify({ ACME_PROFILE: "bench" }), "env is a JSON part");
    const text = out.join("\n");
    assert(text.includes("acme-cli"), "renders the agent name");
    assert(text.includes("install_script"), "renders the source");
    assert(text.includes("ACME_PROFILE"), "renders the declared env key");
    assert(!text.includes("=bench"), "does not echo declared env values into the terminal");
    assert(text.includes("--agent acme-cli:"), "prints the follow-up run hint");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testCustomHarnessesCliListAndRemove() {
  console.log("\n--- runCli: custom-harnesses list + remove ---");
  installMockFetch();
  try {
    setMockResponse("/api/agents/acme-cli", { status: 204, body: null });
    setMockResponse("/api/agents", {
      status: 200,
      body: { items: [CLI_AGENT], nextCursor: null, hasMore: false },
    });

    const listIO = captureIO();
    const listCode = await runCli(
      ["custom-harnesses", "--api-key", "test-key", "--base-url", BASE],
      listIO.io
    );
    assertEqual(listCode, 0, "list exits 0");
    const listText = listIO.out.join("\n");
    assert(listText.includes("NAME") && listText.includes("SOURCE"), "renders the list header");
    assert(listText.includes("acme-cli"), "lists the agent");

    const removeIO = captureIO();
    const removeCode = await runCli(
      ["custom-harnesses", "remove", "acme-cli", "--api-key", "test-key", "--base-url", BASE],
      removeIO.io
    );
    assertEqual(removeCode, 0, "remove exits 0");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/agents/acme-cli"), "remove targets the detail route");
    assertEqual(call.init?.method, "DELETE", "remove uses DELETE");
    assert(removeIO.out.some((l) => l.includes("Deleted custom harness acme-cli")), "confirms the delete");
  } finally {
    restoreFetch();
  }
}

async function testCustomHarnessesCliUnknownSubcommand() {
  console.log("\n--- runCli: custom-harnesses <unknown> is a usage error ---");
  const { io, err } = captureIO();
  const code = await runCli(
    ["custom-harnesses", "frobnicate", "--api-key", "k", "--base-url", BASE],
    io
  );
  assertEqual(code, 2, "usage error exit 2");
  assert(err.some((l) => l.includes("add, get, remove")), "names the supported subcommands");
}

// =============================================================================
// DOWNLOAD — the corpus package, by dataset ref
// =============================================================================

async function testDownloadCli() {
  console.log("\n--- runCli: download saves the corpus package; --json prints the path ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `cli-download-${Date.now()}`);
  try {
    const pkg = Buffer.from("corpus bytes");
    setMockResponse("/api/datasets/acme/download", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: { "Content-Disposition": 'attachment; filename="acme@1.1-corpus.tar.gz"' },
    });

    const saved = captureIO();
    const code = await runCli(
      ["download", "acme@1.1", "--to", tmpDir, "--api-key", "test-key", "--base-url", BASE],
      saved.io
    );
    assertEqual(code, 0, "download exits 0");
    const downloadCall = fetchCalls[fetchCalls.length - 1];
    assert(downloadCall.url.includes("/api/datasets/acme/download"), "the positional is a dataset ref");
    assert(downloadCall.url.includes("version=1.1"), "ref version becomes ?version=");
    assert(
      saved.out.some((l) => l.includes("acme@1.1-corpus.tar.gz")),
      "prints the saved path"
    );
    const written = await readFile(join(tmpDir, "acme@1.1-corpus.tar.gz"));
    assertEqual(written.equals(pkg), true, "file bytes match the package");

    const asJson = captureIO();
    const jsonCode = await runCli(
      ["download", "acme@1.1", "--to", tmpDir, "--json", "--api-key", "test-key", "--base-url", BASE],
      asJson.io
    );
    assertEqual(jsonCode, 0, "download --json exits 0");
    assert(
      typeof JSON.parse(asJson.out[0]).path === "string",
      "--json emits { path }"
    );

    // A dataset nobody owns is not-found, exactly like a bad name — the CLI
    // reports it rather than pretending the file was written.
    setMockResponse("/api/datasets/not-mine/download", {
      status: 404,
      body: { error: { code: "dataset_not_found", message: "Dataset not found: not-mine" } },
    });
    const denied = captureIO();
    const deniedCode = await runCli(
      ["download", "not-mine", "--to", tmpDir, "--api-key", "test-key", "--base-url", BASE],
      denied.io
    );
    assertEqual(deniedCode, 1, "a package the caller does not own exits 1");
    assert(denied.err.some((l) => l.includes("Dataset not found")), "the refusal reaches stderr");

    const noId = captureIO();
    const noIdCode = await runCli(["download", "--api-key", "k", "--base-url", BASE], noId.io);
    assertEqual(noIdCode, 2, "download without a ref is a usage error");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function main() {
  console.log("evolve-evals CLI Unit Tests\n");

  testParseRunFull();

  testEffortFlag();
  testParseRunMinimal();
  testParseRunNoSpendCap();
  testParseJobAgent();
  testParseErrors();
  testParseOtherCommands();
  testParseImport();
  testParseCustomHarnesses();
  testImportStatusLine();
  testEventLine();
  testTrialDetailLiveSpend();
  await testRunWatchEndToEnd();
  await testRunWatchJsonNdjson();
  await testImportWatchEndToEnd();
  await testImportWatchFailedAndStatus();
  await testUsageErrorExitCode();
  await testRegradeCliCreate();
  await testRegradeCliPerTrial();
  await testRegradeCliRead();
  await testRegradeCliPerRunRejectsFilter();
  await testTraceStreamCli();
  await testTraceSaveCli();
  await testTraceUsageErrors();
  await testCustomHarnessesCliAdd();
  await testCustomHarnessesCliListAndRemove();
  await testCustomHarnessesCliUnknownSubcommand();
  await testDownloadCli();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
