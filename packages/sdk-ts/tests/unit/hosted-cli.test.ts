#!/usr/bin/env tsx
/**
 * Unit Test: evolve-evals CLI (src/hosted/cli.ts)
 *
 * Tests command parsing (flags, repeatable --agent, csv --tasks, numbers,
 * required flags, usage errors) and one mocked end-to-end `run --watch`:
 * POST /api/jobs -> SSE event stream -> terminal status, asserting the
 * request bodies, the rendered status lines, and the exit code. Also covers
 * `import` / `import status`: POST /api/benchmarks/imports, the getImport poll
 * loop of --watch, IMPORTED/FAILED exit codes, and the new trial / trace /
 * compare commands plus the trials --status filter. Also covers
 * `custom-harnesses` (add / list / remove): the --install-script file read, the
 * repeatable --env pairs, and the rendered harness.
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
}

let mockResponses: Map<string, MockResponse> = new Map();

function setMockResponse(urlPattern: string, response: MockResponse) {
  mockResponses.set(urlPattern, response);
}

function buildMockResponse(resp: MockResponse): Response {
  let body: ReadableStream | null = null;
  if (resp.streamBody != null) {
    const nodeStream = Readable.from(Buffer.from(resp.streamBody, "utf-8"));
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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
} from "../../src/hosted/cli.ts";
import type { CliIO } from "../../src/hosted/cli.ts";

const BASE = "http://localhost:3000";

function captureIO(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

// =============================================================================
// PARSING TESTS
// =============================================================================

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
      benchmark: "deep-swe@1.1",
      tasks: ["task-a", "task-b"],
      agents: [
        { harness: "codex", model: "gpt-5.5" },
        { harness: "claude", model: "sonnet", harnessVersion: "2.1.0" },
      ],
      runsPerTask: 2,
      concurrency: 4,
      maxTrialSpendUsd: 25,
      sandboxProvider: "daytona",
    },
    "builds the job input (csv tasks trimmed, per-trial cap + provider mapped)"
  );
  assertEqual(
    Object.keys(input),
    [
      "benchmark",
      "tasks",
      "agents",
      "runsPerTask",
      "concurrency",
      "maxTrialSpendUsd",
      "sandboxProvider",
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
      benchmark: "deep-swe@1.1",
      agents: [{ harness: "codex", model: "gpt-5.5" }],
      maxTrialSpendUsd: 25,
    },
    "--flag=value syntax works; optional fields absent"
  );
  assert(!("tasks" in input), "no tasks key when --tasks omitted");
  assert(!("sandboxProvider" in input), "no provider key when --provider omitted");
}

function testParseRunNoSpendCap() {
  console.log("\n--- parseArgs + buildJobInput: --max-trial-spend is optional ---");
  // Not in the run command's required list: the server applies its own default
  // ($200 per trial, operator-tunable) and echoes the resolved cap back.
  const inv = parseArgs(["run", "--benchmark", "deep-swe@1.1", "--agent", "codex:gpt-5.5"]);
  const input = buildJobInput(inv);
  assertEqual(
    input,
    {
      benchmark: "deep-swe@1.1",
      agents: [{ harness: "codex", model: "gpt-5.5" }],
    },
    "run parses without --max-trial-spend"
  );
  // ABSENT, never a null/undefined key: an explicit null would defeat the
  // server-side default the omission is asking for.
  assert(
    !("maxTrialSpendUsd" in input),
    "no cap key on the body when --max-trial-spend is omitted"
  );
}

function testParseJobAgent() {
  console.log("\n--- parseJobAgent: harness:model[:version] ---");
  assertEqual(
    parseJobAgent("codex:gpt-5.5"),
    { harness: "codex", model: "gpt-5.5" },
    "two-part spec"
  );
  assertEqual(
    parseJobAgent("claude:sonnet:2.1.0"),
    { harness: "claude", model: "sonnet", harnessVersion: "2.1.0" },
    "three-part spec carries harnessVersion"
  );
  assertEqual(
    parseJobAgent("claude:sonnet:2.1.0:beta"),
    { harness: "claude", model: "sonnet", harnessVersion: "2.1.0:beta" },
    "extra colons stay in the version"
  );
  assertThrowsUsage(() => parseJobAgent("codex"), "harness:model", "bare harness rejected");
  assertThrowsUsage(() => parseJobAgent("codex:"), "harness:model", "empty model rejected");
  assertThrowsUsage(() => parseJobAgent(":gpt-5.5"), "harness:model", "empty harness rejected");
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
    parseArgs(["export", "eval-1", "--to", "/tmp/x", "--format", "harbor"]),
    { command: "export", positionals: ["eval-1"], flags: { to: "/tmp/x", format: "harbor" } },
    "export with --to and --format"
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
  assertEqual(
    parseArgs(["trial", "eval-1", "run-9"]),
    { command: "trial", positionals: ["eval-1", "run-9"], flags: {} },
    "trial detail command"
  );
  assertEqual(
    parseArgs(["trace", "eval-1", "run-9", "--cursor", "5", "--limit", "100"]),
    { command: "trace", positionals: ["eval-1", "run-9"], flags: { cursor: "5", limit: 100 } },
    "trace command with cursor/limit — one pagination vocabulary everywhere"
  );
  assertEqual(
    parseArgs(["compare", "eval-1", "eval-2", "eval-3"]),
    { command: "compare", positionals: ["eval-1", "eval-2", "eval-3"], flags: {} },
    "compare with 3 ids"
  );
  assertThrowsUsage(() => parseArgs(["compare", "eval-1"]), "<id> <id>", "compare needs at least 2 ids");
  assertThrowsUsage(() => parseArgs(["trace", "eval-1"]), "<id> <trial-id>", "trace needs both ids");
  assertEqual(
    parseArgs(["regrade", "eval-1"]),
    { command: "regrade", positionals: ["eval-1"], flags: {} },
    "regrade whole job"
  );
  assertEqual(
    parseArgs(["regrade", "eval-1", "run-9"]),
    { command: "regrade", positionals: ["eval-1", "run-9"], flags: {} },
    "regrade one run (optional run-id positional)"
  );
  assertEqual(
    parseArgs(["regrade", "eval-1", "--status", "SCORED,SCORING_ERROR", "--task", "abc"]),
    { command: "regrade", positionals: ["eval-1"], flags: { status: "SCORED,SCORING_ERROR", task: "abc" } },
    "regrade with --status + --task filter"
  );
  assertEqual(
    parseArgs(["regrade-job", "job-1"]),
    { command: "regrade-job", positionals: ["job-1"], flags: {} },
    "regrade-job read"
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
      source: { gitUrl: "https://github.com/acme/my-bench.git", ref: "main" },
      benchmarkName: "my-bench",
      version: "1.0",
    },
    "builds the git import input"
  );

  assertEqual(
    buildImportInput(
      parseArgs(["import", "--dir", "/path/to/corpus", "--name", "my-bench", "--version", "2.0"])
    ),
    {
      source: { directory: "/path/to/corpus" },
      benchmarkName: "my-bench",
      version: "2.0",
    },
    "builds the directory import input"
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
      installScript: "# from ./install.sh\ncurl -fsSL https://acme.dev/install.sh | sh\n",
      runCommand: "acme-cli --headless",
      env: { ACME_PROFILE: "bench", ACME_REGION: "us" },
    },
    "builds the install-script harness input (script contents, repeatable --env)"
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
      runCommand: "acme-cli --headless",
    },
    "builds the directory harness input (no env key when --env omitted)"
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
  const job = { id: "imp-1", benchmarkName: "my-bench", version: "1.0" };
  const imported = importStatusLine({ ...job, status: "IMPORTED", taskCount: 12 });
  assert(imported.includes("IMPORTED"), "includes the status");
  assert(imported.includes("tasks=12"), "includes the task count");
  const failed = importStatusLine({ ...job, status: "FAILED", error: { message: "bad tasks.json", failures: [{ taskKey: "t1", error: "boom" }] } });
  assert(failed.includes("FAILED") && failed.includes("bad tasks.json") && failed.includes("1 task failure"), "FAILED line carries message + failure count");
}

function testEventLine() {
  console.log("\n--- eventLine: compact status lines ---");
  const line = eventLine({
    seq: 2,
    type: "trial.settled",
    data: { trialId: "run-1", taskKey: "abs-module-cache-flags", status: "SCORED", reward: 1 },
  });
  assert(line.includes("#   2"), "includes padded seq");
  assert(line.includes("trial.settled"), "includes event type");
  assert(line.includes("run-1"), "includes trialId");
  assert(line.includes("SCORED"), "includes status");
  assert(line.includes("reward=1"), "includes reward");
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
          { seq: 0, type: "job.created", data: { trialCount: 2 } },
          { seq: 1, type: "trial.settled", data: { trialId: "run-1", status: "SCORED", reward: 1 } },
        ]) +
        ": heartbeat\n\n" +
        sseText([{ seq: 2, type: "job.completed", data: { scored: 2 } }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: {
        id: "eval-1",
        status: "COMPLETED",
        benchmark: "deep-swe@1.1",
        runsPerTask: 1,
        concurrency: 4,
        maxTrialSpendUsd: 25,
        sandboxProvider: "e2b",
        spentUsd: 1.5,
        counts: { agents: 1, tasks: 2 },
        trials: { total: 2, byStatus: { ...ZERO_TRIAL_STATUSES, SCORED: 2 } },
        agents: [{ harness: "codex", model: "gpt-5.5", harnessVersion: null }],
        meanReward: 1,
        failure: null,
        sourceJobId: null,
        idempotentReplay: false,
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:01:00.000Z",
      },
    });
    setMockResponse("/api/jobs", {
      status: 202,
      body: {
        id: "eval-1",
        status: "QUEUED",
        benchmark: "deep-swe@1.1",
        runsPerTask: 1,
        concurrency: 4,
        maxTrialSpendUsd: 25,
        sandboxProvider: "e2b",
        spentUsd: 0,
        counts: { agents: 1, tasks: 2 },
        trials: { total: 2, byStatus: { ...ZERO_TRIAL_STATUSES, QUEUED: 2 } },
        agents: [{ harness: "codex", model: "gpt-5.5", harnessVersion: null }],
        meanReward: null,
        failure: null,
        sourceJobId: null,
        idempotentReplay: false,
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
    });

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
        benchmark: "deep-swe@1.1",
        agents: [{ harness: "codex", model: "gpt-5.5" }],
        runsPerTask: 1,
        concurrency: 4,
        maxTrialSpendUsd: 25,
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
      streamBody: sseText([{ seq: 0, type: "job.completed", data: {} }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: {
        id: "eval-1",
        status: "COMPLETED",
        benchmark: "deep-swe@1.1",
        runsPerTask: 1,
        concurrency: 1,
        maxTrialSpendUsd: 25,
        sandboxProvider: "e2b",
        spentUsd: 0,
        createdAt: "2026-07-22T00:00:00.000Z",
      },
    });
    setMockResponse("/api/jobs", {
      status: 202,
      body: {
        id: "eval-1",
        status: "QUEUED",
        benchmark: "deep-swe@1.1",
        runsPerTask: 1,
        concurrency: 1,
        maxTrialSpendUsd: 25,
        sandboxProvider: "e2b",
        spentUsd: 0,
        createdAt: "2026-07-22T00:00:00.000Z",
      },
    });

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
    setMockResponse("/api/benchmarks/imports/imp-1", {
      status: 200,
      body: { id: "imp-1", status: "IMPORTED", benchmarkName: "my-bench", version: "1.0", taskCount: 12, error: null },
    });
    setMockResponse("/api/benchmarks/imports", {
      status: 202,
      body: { id: "imp-1", status: "IMPORTING", benchmarkName: "my-bench", version: "1.0" },
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

    assertEqual(code, 0, "exit code 0 on IMPORTED");
    assertEqual(err, [], "nothing on stderr");

    // The create request
    const createCall = fetchCalls.find((c) => c.url === `${BASE}/api/benchmarks/imports`);
    assert(createCall !== undefined, "POSTs /api/benchmarks/imports");
    assertEqual(createCall?.init?.method, "POST", "create uses POST");
    // ONE body grammar: multipart/form-data with named parts, so nothing rides
    // the query string on either upload route.
    const form = createCall?.init?.body as FormData;
    assert(form instanceof FormData, "create body is multipart/form-data");
    assertEqual(form.get("gitUrl"), "https://github.com/acme/my-bench.git", "gitUrl part");
    assertEqual(form.get("ref"), "main", "ref part");
    assertEqual(form.get("benchmarkName"), "my-bench", "benchmarkName part");
    assertEqual(form.get("version"), "1.0", "version part");

    // The watch poll
    const pollCall = fetchCalls.find((c) => c.url === `${BASE}/api/benchmarks/imports/imp-1`);
    assert(pollCall !== undefined, "polls GET /api/benchmarks/imports/<id>");

    // Rendered output
    assert(out[0].includes("imp-1") && out[0].includes("my-bench") && out[0].includes("watching"), "prints the created header");
    assert(out.some((l) => l.includes("IMPORTED") && l.includes("tasks=12")), "renders the IMPORTED status line");
  } finally {
    restoreFetch();
  }
}

async function testImportWatchFailedAndStatus() {
  console.log("\n--- runCli: import --watch FAILED exits 1; import status --json ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/imports/imp-2", {
      status: 200,
      body: { id: "imp-2", status: "FAILED", benchmarkName: "b", version: "1.0", error: { message: "bad tasks.json" } },
    });
    setMockResponse("/api/benchmarks/imports", {
      status: 202,
      body: { id: "imp-2", status: "IMPORTING", benchmarkName: "b", version: "1.0" },
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
      { id: "imp-2", status: "FAILED", benchmarkName: "b", version: "1.0", error: { message: "bad tasks.json" } },
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

const CLI_REGRADE_JOB = {
  id: "job-1",
  sourceJobId: "eval-1",
  status: "COMPLETED",
  sandboxProvider: "e2b",
  filter: { taskKey: "demo-task" },
  results: {
    total: 1,
    byStatus: {
      QUEUED: 0,
      RUNNING: 0,
      SCORED: 1,
      SCORING_ERROR: 0,
      INFRASTRUCTURE_ERROR: 0,
      INDETERMINATE: 0,
    },
    nextCursor: null,
    hasMore: false,
    items: [
      {
        id: "rr-1",
        sourceTrialId: "run-1",
        taskKey: "demo-task",
        status: "SCORED",
        reward: 1,
        metrics: null,
        sourceReward: 1,
        sourceStatus: "SCORED",
        rewardDelta: 0,
        verifierMode: "separate",
        verifierDigest: "abcd",
        verifierSandboxId: "sbx-1",
        failurePhase: null,
        failureDetail: null,
        phaseTimingsMs: { verifyMs: 1200 },
        createdAt: "2026-07-24T00:00:00Z",
        settledAt: "2026-07-24T00:05:00Z",
      },
    ],
  },
  createdAt: "2026-07-24T00:00:00Z",
  updatedAt: "2026-07-24T00:05:00Z",
};

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
    assertEqual(JSON.parse(call.init?.body as string), { taskKey: "demo-task" }, "sends the task filter");
    assert(out.some((l) => l.includes("job-1")), "renders the job id");
    assert(out.some((l) => l.includes("regrade-job job-1")), "prints the follow-up read hint");
  } finally {
    restoreFetch();
  }
}

async function testRegradeCliRead() {
  console.log("\n--- runCli: regrade-job <id> renders the results table (WAS/NOW/Δ) ---");
  installMockFetch();
  try {
    setMockResponse("/api/regrades/job-1", { status: 200, body: CLI_REGRADE_JOB });
    const { io, out } = captureIO();
    const code = await runCli(["regrade-job", "job-1", "--api-key", "test-key", "--base-url", BASE], io);
    assertEqual(code, 0, "exit 0");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/regrades/job-1"), "hits the regrade-job read route");
    const text = out.join("\n");
    assert(text.includes("demo-task"), "renders the source task key");
    assert(text.includes("WAS") && text.includes("NOW"), "renders the was/now delta columns");
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

const CLI_CUSTOM_HARNESS = {
  name: "acme-cli",
  source: "install_script",
  runCommand: "acme-cli --headless",
  env: { ACME_PROFILE: "bench" },
  createdAt: "2026-07-24T00:00:00Z",
  updatedAt: "2026-07-24T00:00:00Z",
};

async function testCustomHarnessesCliAdd() {
  console.log("\n--- runCli: custom-harnesses add posts the install script and renders the harness ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-harness-cli-"));
  const scriptPath = join(dir, "install.sh");
  try {
    await writeFile(scriptPath, "curl -fsSL https://acme.dev/install.sh | sh\n");
    setMockResponse("/api/custom-harnesses", { status: 201, body: CLI_CUSTOM_HARNESS });
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
    assert(call.url.endsWith("/api/custom-harnesses"), "hits the custom-harnesses route");
    assertEqual(call.init?.method, "POST", "uses POST");
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("name"), "acme-cli", "name part");
    assertEqual(
      form.get("installScript"),
      "curl -fsSL https://acme.dev/install.sh | sh\n",
      "--install-script uploads the FILE CONTENTS, not the path"
    );
    assertEqual(form.get("runCommand"), "acme-cli --headless", "runCommand part");
    assertEqual(form.get("env"), JSON.stringify({ ACME_PROFILE: "bench" }), "env is a JSON part");
    const text = out.join("\n");
    assert(text.includes("acme-cli"), "renders the harness name");
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
    setMockResponse("/api/custom-harnesses/acme-cli", { status: 204, body: null });
    setMockResponse("/api/custom-harnesses", {
      status: 200,
      body: { items: [CLI_CUSTOM_HARNESS], nextCursor: null, hasMore: false },
    });

    const listIO = captureIO();
    const listCode = await runCli(
      ["custom-harnesses", "--api-key", "test-key", "--base-url", BASE],
      listIO.io
    );
    assertEqual(listCode, 0, "list exits 0");
    const listText = listIO.out.join("\n");
    assert(listText.includes("NAME") && listText.includes("SOURCE"), "renders the list header");
    assert(listText.includes("acme-cli"), "lists the harness");

    const removeIO = captureIO();
    const removeCode = await runCli(
      ["custom-harnesses", "remove", "acme-cli", "--api-key", "test-key", "--base-url", BASE],
      removeIO.io
    );
    assertEqual(removeCode, 0, "remove exits 0");
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/custom-harnesses/acme-cli"), "remove targets the detail route");
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
// RUN
// =============================================================================

async function main() {
  console.log("evolve-evals CLI Unit Tests\n");

  testParseRunFull();
  testParseRunMinimal();
  testParseRunNoSpendCap();
  testParseJobAgent();
  testParseErrors();
  testParseOtherCommands();
  testParseImport();
  testParseCustomHarnesses();
  testImportStatusLine();
  testEventLine();
  await testRunWatchEndToEnd();
  await testRunWatchJsonNdjson();
  await testImportWatchEndToEnd();
  await testImportWatchFailedAndStatus();
  await testUsageErrorExitCode();
  await testRegradeCliCreate();
  await testRegradeCliRead();
  await testRegradeCliPerRunRejectsFilter();
  await testCustomHarnessesCliAdd();
  await testCustomHarnessesCliListAndRemove();
  await testCustomHarnessesCliUnknownSubcommand();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
