#!/usr/bin/env tsx
/**
 * Unit Test: evolve-evals CLI (src/hosted/cli.ts)
 *
 * Tests command parsing (flags, repeatable --system, csv --tasks, numbers,
 * required flags, usage errors) and one mocked end-to-end `run --watch`:
 * POST /api/evaluations -> SSE event stream -> terminal status, asserting the
 * request bodies, the rendered status lines, and the exit code. Also covers
 * `import` / `import status`: POST /api/benchmarks/import, the getImport poll
 * loop of --watch, and READY/FAILED exit codes.
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

import { Readable } from "node:stream";

import {
  buildEvaluationInput,
  buildImportInput,
  CliUsageError,
  eventLine,
  importStatusLine,
  parseAgentSystem,
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
  console.log("\n--- parseArgs + buildEvaluationInput: full run command ---");
  const inv = parseArgs([
    "run",
    "--benchmark", "deep-swe@1.1",
    "--system", "codex:gpt-5.5",
    "--system", "claude:sonnet:2.1.0",
    "--tasks", "task-a, task-b",
    "--runs", "2",
    "--concurrency", "4",
    "--max-spend", "25",
    "--max-spend-per-run", "5",
    "--provider", "daytona",
    "--watch",
    "--json",
  ]);
  assertEqual(inv.command, "run", "command is run");
  assertEqual(inv.flags.watch, true, "--watch parsed as boolean");
  assertEqual(inv.flags.json, true, "--json parsed as boolean");
  assertEqual(inv.flags.system, ["codex:gpt-5.5", "claude:sonnet:2.1.0"], "--system is repeatable");

  const input = buildEvaluationInput(inv);
  assertEqual(
    input,
    {
      benchmark: "deep-swe@1.1",
      tasks: ["task-a", "task-b"],
      agentSystems: [
        { harness: "codex", model: "gpt-5.5" },
        { harness: "claude", model: "sonnet", harnessVersion: "2.1.0" },
      ],
      runsPerTask: 2,
      concurrency: 4,
      maxModelSpendUsd: 25,
      maxModelSpendUsdPerTaskRun: 5,
      sandboxProvider: "daytona",
    },
    "builds the evaluation input (csv tasks trimmed, per-run cap + provider mapped)"
  );
  assertEqual(
    Object.keys(input),
    [
      "benchmark",
      "tasks",
      "agentSystems",
      "runsPerTask",
      "concurrency",
      "maxModelSpendUsd",
      "maxModelSpendUsdPerTaskRun",
      "sandboxProvider",
    ],
    "body keys follow the contract field order"
  );
}

function testParseRunMinimal() {
  console.log("\n--- buildEvaluationInput: minimal run omits optional fields ---");
  const inv = parseArgs([
    "run",
    "--benchmark=deep-swe@1.1",
    "--system=codex:gpt-5.5",
    "--max-spend=25",
  ]);
  const input = buildEvaluationInput(inv);
  assertEqual(
    input,
    {
      benchmark: "deep-swe@1.1",
      agentSystems: [{ harness: "codex", model: "gpt-5.5" }],
      maxModelSpendUsd: 25,
    },
    "--flag=value syntax works; optional fields absent"
  );
  assert(!("tasks" in input), "no tasks key when --tasks omitted");
  assert(!("maxModelSpendUsdPerTaskRun" in input), "no per-run cap key when omitted");
  assert(!("sandboxProvider" in input), "no provider key when --provider omitted");
}

function testParseAgentSystem() {
  console.log("\n--- parseAgentSystem: harness:model[:version] ---");
  assertEqual(
    parseAgentSystem("codex:gpt-5.5"),
    { harness: "codex", model: "gpt-5.5" },
    "two-part spec"
  );
  assertEqual(
    parseAgentSystem("claude:sonnet:2.1.0"),
    { harness: "claude", model: "sonnet", harnessVersion: "2.1.0" },
    "three-part spec carries harnessVersion"
  );
  assertEqual(
    parseAgentSystem("claude:sonnet:2.1.0:beta"),
    { harness: "claude", model: "sonnet", harnessVersion: "2.1.0:beta" },
    "extra colons stay in the version"
  );
  assertThrowsUsage(() => parseAgentSystem("codex"), "harness:model", "bare harness rejected");
  assertThrowsUsage(() => parseAgentSystem("codex:"), "harness:model", "empty model rejected");
  assertThrowsUsage(() => parseAgentSystem(":gpt-5.5"), "harness:model", "empty harness rejected");
}

function testParseErrors() {
  console.log("\n--- parseArgs: usage errors ---");
  assertThrowsUsage(() => parseArgs([]), "No command", "empty argv");
  assertThrowsUsage(() => parseArgs(["frobnicate"]), "Unknown command", "unknown command");
  assertThrowsUsage(
    () => parseArgs(["run", "--benchmark", "b", "--system", "c:m"]),
    "--max-spend",
    "run without --max-spend"
  );
  assertThrowsUsage(
    () => parseArgs(["run", "--benchmark", "b", "--max-spend", "25"]),
    "--system",
    "run without --system"
  );
  assertThrowsUsage(
    () => parseArgs(["run", "--system", "c:m", "--max-spend", "25"]),
    "--benchmark",
    "run without --benchmark"
  );
  assertThrowsUsage(
    () => parseArgs(["run", "--benchmark", "b", "--system", "c:m", "--max-spend", "lots"]),
    "expects a number",
    "non-numeric --max-spend"
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
    parseArgs(["task-runs", "eval-1", "--limit", "10", "--cursor", "run-5"]),
    { command: "task-runs", positionals: ["eval-1"], flags: { limit: 10, cursor: "run-5" } },
    "task-runs with pagination"
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

  const minimal = parseArgs(["import", "--git=g", "--ref=main", "--name=b"]);
  assert(!("version" in buildImportInput(minimal)), "no version key when --version omitted");

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
}

function testImportStatusLine() {
  console.log("\n--- importStatusLine: compact status lines ---");
  const ready = importStatusLine({ id: "imp-1", status: "READY", taskCount: 12 });
  assert(ready.includes("READY"), "includes the status");
  assert(ready.includes("tasks=12"), "includes the task count");
  const failed = importStatusLine({ id: "imp-1", status: "FAILED", error: { message: "bad tasks.json", failures: [{ taskKey: "t1", error: "boom" }] } });
  assert(failed.includes("FAILED") && failed.includes("bad tasks.json") && failed.includes("1 task failure"), "FAILED line carries message + failure count");
}

function testEventLine() {
  console.log("\n--- eventLine: compact status lines ---");
  const line = eventLine({
    seq: 2,
    type: "task_run.settled",
    data: { taskRunId: "run-1", taskKey: "abs-module-cache-flags", status: "SCORED", score: 1 },
  });
  assert(line.includes("#   2"), "includes padded seq");
  assert(line.includes("task_run.settled"), "includes event type");
  assert(line.includes("run-1"), "includes taskRunId");
  assert(line.includes("SCORED"), "includes status");
  assert(line.includes("score=1"), "includes score");
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
    setMockResponse("/api/evaluations/eval-1/events", {
      status: 200,
      body: null,
      streamBody:
        sseText([
          { seq: 0, type: "evaluation.created", data: { taskRunCount: 2 } },
          { seq: 1, type: "task_run.settled", data: { taskRunId: "run-1", status: "SCORED", score: 1 } },
        ]) +
        ": heartbeat\n\n" +
        sseText([{ seq: 2, type: "evaluation.completed", data: { scored: 2 } }]),
    });
    setMockResponse("/api/evaluations/eval-1", {
      status: 200,
      body: {
        id: "eval-1",
        status: "COMPLETED",
        benchmark: "deep-swe@1.1",
        runsPerTask: 1,
        concurrency: 4,
        maxModelSpendUsd: 25,
        maxModelSpendUsdPerTaskRun: 5,
        spentUsd: 1.5,
        counts: { agentSystems: 1, tasks: 2, taskRuns: 2 },
        taskRunCounts: { SCORED: 2 },
        createdAt: "2026-07-22T00:00:00.000Z",
      },
    });
    setMockResponse("/api/evaluations", {
      status: 202,
      body: {
        id: "eval-1",
        status: "QUEUED",
        benchmark: "deep-swe@1.1",
        runsPerTask: 1,
        concurrency: 4,
        maxModelSpendUsd: 25,
        spentUsd: 0,
        counts: { agentSystems: 1, tasks: 2, taskRuns: 2 },
        createdAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const { io, out, err } = captureIO();
    const code = await runCli(
      [
        "run",
        "--benchmark", "deep-swe@1.1",
        "--system", "codex:gpt-5.5",
        "--runs", "1",
        "--concurrency", "4",
        "--max-spend", "25",
        "--max-spend-per-run", "5",
        "--watch",
        "--api-key", "test-key",
        "--base-url", BASE,
      ],
      io
    );

    assertEqual(code, 0, "exit code 0 on COMPLETED");
    assertEqual(err, [], "nothing on stderr");

    // The create request
    const createCall = fetchCalls.find((c) => c.url === `${BASE}/api/evaluations`);
    assert(createCall !== undefined, "POSTs /api/evaluations");
    assertEqual(createCall?.init?.method, "POST", "create uses POST");
    assertEqual(
      JSON.parse(createCall?.init?.body as string),
      {
        benchmark: "deep-swe@1.1",
        agentSystems: [{ harness: "codex", model: "gpt-5.5" }],
        runsPerTask: 1,
        concurrency: 4,
        maxModelSpendUsd: 25,
        maxModelSpendUsdPerTaskRun: 5,
      },
      "create body matches the CLI flags (contract field order, incl. per-run cap)"
    );
    const headers = createCall?.init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "--api-key becomes the Bearer token");

    // The watch stream
    const streamCall = fetchCalls.find((c) => c.url.includes("/events"));
    assert(streamCall !== undefined, "connects to the SSE event stream");

    // Rendered output
    assert(out[0].includes("eval-1") && out[0].includes("watching"), "prints the created header");
    assert(out.some((l) => l.includes("evaluation.created")), "renders evaluation.created event line");
    assert(
      out.some((l) => l.includes("task_run.settled") && l.includes("run-1") && l.includes("score=1")),
      "renders task_run.settled as a compact status line"
    );
    assert(out.some((l) => l.includes("evaluation.completed")), "renders the terminal event line");
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
    setMockResponse("/api/evaluations/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([{ seq: 0, type: "evaluation.completed", data: {} }]),
    });
    setMockResponse("/api/evaluations/eval-1", {
      status: 200,
      body: {
        id: "eval-1",
        status: "COMPLETED",
        benchmark: "deep-swe@1.1",
        runsPerTask: 1,
        concurrency: 1,
        maxModelSpendUsd: 25,
        spentUsd: 0,
        createdAt: "2026-07-22T00:00:00.000Z",
      },
    });
    setMockResponse("/api/evaluations", {
      status: 202,
      body: {
        id: "eval-1",
        status: "QUEUED",
        benchmark: "deep-swe@1.1",
        runsPerTask: 1,
        concurrency: 1,
        maxModelSpendUsd: 25,
        spentUsd: 0,
        createdAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const { io, out } = captureIO();
    const code = await runCli(
      ["run", "--benchmark", "deep-swe@1.1", "--system", "codex:gpt-5.5", "--max-spend", "25",
       "--watch", "--json", "--api-key", "test-key", "--base-url", BASE],
      io
    );

    assertEqual(code, 0, "exit code 0");
    const parsed = out.map((l) => JSON.parse(l));
    assertEqual(parsed[0].kind, "evaluation.created", "first NDJSON line is the created evaluation");
    assert(parsed.some((p) => p.kind === "event" && p.type === "evaluation.completed"), "events are NDJSON lines");
    const final = parsed[parsed.length - 1];
    assertEqual(final.kind, "evaluation.final", "last NDJSON line is the final evaluation");
    assertEqual(final.evaluation.status, "COMPLETED", "final evaluation status present");
  } finally {
    restoreFetch();
  }
}

async function testImportWatchEndToEnd() {
  console.log("\n--- runCli: end-to-end import --watch against mocked API ---");
  installMockFetch();
  try {
    // Insertion order matters: most-specific patterns first.
    setMockResponse("/api/benchmarks/import/imp-1", {
      status: 200,
      body: { id: "imp-1", status: "READY", taskCount: 12 },
    });
    setMockResponse("/api/benchmarks/import", {
      status: 202,
      body: { id: "imp-1", benchmarkName: "my-bench", status: "IMPORTING" },
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

    assertEqual(code, 0, "exit code 0 on READY");
    assertEqual(err, [], "nothing on stderr");

    // The create request
    const createCall = fetchCalls.find((c) => c.url === `${BASE}/api/benchmarks/import`);
    assert(createCall !== undefined, "POSTs /api/benchmarks/import");
    assertEqual(createCall?.init?.method, "POST", "create uses POST");
    assertEqual(
      JSON.parse(createCall?.init?.body as string),
      {
        source: { type: "git", url: "https://github.com/acme/my-bench.git", ref: "main" },
        benchmarkName: "my-bench",
        version: "1.0",
      },
      "create body matches the CLI flags (git source + version)"
    );

    // The watch poll
    const pollCall = fetchCalls.find((c) => c.url === `${BASE}/api/benchmarks/import/imp-1`);
    assert(pollCall !== undefined, "polls GET /api/benchmarks/import/<id>");

    // Rendered output
    assert(out[0].includes("imp-1") && out[0].includes("my-bench") && out[0].includes("watching"), "prints the created header");
    assert(out.some((l) => l.includes("READY") && l.includes("tasks=12")), "renders the READY status line");
  } finally {
    restoreFetch();
  }
}

async function testImportWatchFailedAndStatus() {
  console.log("\n--- runCli: import --watch FAILED exits 1; import status --json ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/import/imp-2", {
      status: 200,
      body: { id: "imp-2", status: "FAILED", error: { message: "bad tasks.json" } },
    });
    setMockResponse("/api/benchmarks/import", {
      status: 202,
      body: { id: "imp-2", benchmarkName: "b", status: "IMPORTING" },
    });

    const failed = captureIO();
    const codeFailed = await runCli(
      ["import", "--git", "g", "--ref", "main", "--name", "b", "--watch",
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
      { id: "imp-2", status: "FAILED", error: { message: "bad tasks.json" } },
      "import status --json emits the job"
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
    assert(bad.err[0].includes("--system"), "stderr names the missing flag");
    assertEqual(fetchCalls.length, 0, "no network call on usage error");

    setMockResponse("/api/evaluations/eval-x", {
      status: 404,
      body: { error: "Evaluation not found" },
    });
    const notFound = captureIO();
    const codeApi = await runCli(
      ["get", "eval-x", "--api-key", "test-key", "--base-url", BASE],
      notFound.io
    );
    assertEqual(codeApi, 1, "API error exits 1");
    assert(notFound.err[0].includes("404"), "stderr carries the API status");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// RUN
// =============================================================================

async function main() {
  console.log("evolve-evals CLI Unit Tests\n");

  testParseRunFull();
  testParseRunMinimal();
  testParseAgentSystem();
  testParseErrors();
  testParseOtherCommands();
  testParseImport();
  testImportStatusLine();
  testEventLine();
  await testRunWatchEndToEnd();
  await testRunWatchJsonNdjson();
  await testImportWatchEndToEnd();
  await testImportWatchFailedAndStatus();
  await testUsageErrorExitCode();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
