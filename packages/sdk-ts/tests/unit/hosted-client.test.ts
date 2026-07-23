#!/usr/bin/env tsx
/**
 * Unit Test: Hosted Evals Client (benchmarks + evaluations)
 *
 * Tests the benchmarks() and evaluations() factories against the hosted
 * evals API shapes: catalog mapping, the run contract (incl. the per-task-run
 * spend cap) with Idempotency-Key, cursor pagination, cancel/rerun-failed,
 * gzip export (buffer / file / stream), SSE watch with Last-Event-ID resume +
 * reconnect backoff, the git import trio (import/getImport/watchImport),
 * compare aggregates + task matrix, taskRun detail + seq-paged trace with the
 * async iterator, internal-field leak sentinels, and NotImplemented stubs for
 * the still-reserved import sources (archive, Harbor Hub).
 *
 * Uses mock fetch to test without real network calls.
 *
 * Usage:
 *   npx tsx tests/unit/hosted-client.test.ts
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
  /** If set, arrayBuffer() resolves with these bytes */
  bodyBytes?: Buffer;
}

let mockResponses: Map<string, MockResponse> = new Map();

function setMockResponse(urlPattern: string, response: MockResponse) {
  mockResponses.set(urlPattern, response);
}

function buildMockResponse(resp: MockResponse): Response {
  let body: ReadableStream | null = null;
  const streamSource = resp.streamBody != null
    ? Buffer.from(resp.streamBody, "utf-8")
    : resp.bodyBytes;
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
    arrayBuffer: async () => {
      const bytes = resp.bodyBytes ?? Buffer.from(JSON.stringify(resp.body));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
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

import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import {
  benchmarks,
  evaluations,
  NoActiveVersionError,
  NotImplementedError,
} from "../../src/hosted/index.ts";
import type { EvaluationEvent } from "../../src/hosted/index.ts";

const BASE = "http://localhost:3000";

// =============================================================================
// BENCHMARKS TESTS
// =============================================================================

async function testFactoriesRequireApiKey() {
  console.log("\n--- benchmarks()/evaluations() require API key ---");
  const origKey = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;
  try {
    let threwB = false;
    try {
      benchmarks();
    } catch (e: any) {
      threwB = true;
      assert(e.message.includes("API key"), "benchmarks error mentions API key");
    }
    assert(threwB, "benchmarks() throws without API key");

    let threwE = false;
    try {
      evaluations();
    } catch (e: any) {
      threwE = true;
      assert(e.message.includes("API key"), "evaluations error mentions API key");
    }
    assert(threwE, "evaluations() throws without API key");
  } finally {
    if (origKey) process.env.EVOLVE_API_KEY = origKey;
  }
}

async function testBenchmarksList() {
  console.log("\n--- benchmarks().list() maps the catalog ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks", {
      status: 200,
      body: {
        benchmarks: [
          {
            name: "deep-swe",
            displayTitle: "DeepSWE",
            description: "SWE-bench style tasks",
            activeVersion: { version: "1.1", state: "READY", taskCount: 113 },
          },
          {
            name: "empty-bench",
            displayTitle: null,
            description: null,
            activeVersion: null,
          },
        ],
      },
    });

    const b = benchmarks({ apiKey: "test-key", dashboardUrl: BASE });
    const catalog = await b.list();

    assertEqual(catalog.length, 2, "returns 2 benchmarks");
    assertEqual(catalog[0].name, "deep-swe", "maps name");
    assertEqual(catalog[0].displayTitle, "DeepSWE", "maps displayTitle");
    assertEqual(
      catalog[0].activeVersion,
      { version: "1.1", state: "READY", taskCount: 113 },
      "maps activeVersion object"
    );
    assertEqual(catalog[1].activeVersion, null, "null activeVersion preserved");

    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");
  } finally {
    restoreFetch();
  }
}

async function testBenchmarksGet() {
  console.log("\n--- benchmarks().get() resolves name@version and maps detail ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/deep-swe", {
      status: 200,
      body: {
        name: "deep-swe",
        displayTitle: "DeepSWE",
        description: "SWE-bench style tasks",
        activeVersion: "1.1",
        versions: [
          { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
          { version: "1.0", state: "ARCHIVED", createdAt: "2026-07-01T00:00:00.000Z", taskCount: 100 },
        ],
        tasksVersion: "1.1",
        tasks: [
          { taskKey: "abs-module-cache-flags", agentTimeoutSec: 5400, verifierTimeoutSec: 1800 },
        ],
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    });

    const b = benchmarks({ apiKey: "test-key", dashboardUrl: BASE });
    const detail = await b.get("deep-swe@1.1");

    let url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("/api/benchmarks/deep-swe"), "targets the benchmark route");
    assert(url.includes("version=1.1"), "ref version becomes ?version=");

    assertEqual(detail.name, "deep-swe", "maps name");
    assertEqual(detail.activeVersion?.version, "1.1", "activeVersion resolved to full object");
    assertEqual(detail.activeVersion?.state, "READY", "activeVersion carries state");
    assertEqual(detail.versions?.length, 2, "maps versions");
    assertEqual(detail.tasksVersion, "1.1", "maps tasksVersion");
    assertEqual(
      detail.tasks?.[0],
      { taskKey: "abs-module-cache-flags", agentTimeoutSec: 5400, verifierTimeoutSec: 1800 },
      "maps public task fields"
    );

    // Bare name: no version param
    await b.get("deep-swe");
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(!url.includes("version="), "bare name omits version param");

    // Options version
    await b.get("deep-swe", { version: "1.0" });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("version=1.0"), "options.version becomes ?version=");

    // Conflict throws
    let threw = false;
    try {
      await b.get("deep-swe@1.1", { version: "1.0" });
    } catch (e: any) {
      threw = true;
      assert(e.message.includes("Conflicting versions"), "conflict error is clear");
    }
    assert(threw, "throws on ref/options version conflict");
  } finally {
    restoreFetch();
  }
}

async function testImportGitSource() {
  console.log("\n--- benchmarks().import() POSTs the git-source contract ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/import", {
      status: 202,
      body: { importId: "imp-1", state: "IMPORTING" },
    });

    const b = benchmarks({ apiKey: "test-key", dashboardUrl: BASE });
    const imported = await b.import({
      source: { gitUrl: "https://github.com/x/bench.git", ref: "main" },
      benchmarkName: "deep-swe",
      version: "1.2",
    });

    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.includes("/api/benchmarks/import"), "targets the import route");
    assertEqual(call.init?.method, "POST", "uses POST");
    assertEqual(
      JSON.parse(call.init?.body as string),
      {
        source: { type: "git", url: "https://github.com/x/bench.git", ref: "main" },
        benchmarkName: "deep-swe",
        version: "1.2",
      },
      "body is the wire contract (type: 'git', url, ref + benchmarkName, version)"
    );
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.["Content-Type"], "application/json", "JSON content type");
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");

    assertEqual(imported, { id: "imp-1", state: "IMPORTING" }, "202 response mapped (importId -> id)");

    // version omitted: no version key in the body
    await b.import({
      source: { gitUrl: "https://github.com/x/bench.git", ref: "v2" },
      benchmarkName: "deep-swe",
    });
    const body2 = JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string);
    assert(!("version" in body2), "omitted version stays out of the body");
  } finally {
    restoreFetch();
  }
}

async function testImportReservedSources() {
  console.log("\n--- benchmarks().import() archive/hub sources stay reserved ---");
  installMockFetch();
  try {
    const b = benchmarks({ apiKey: "test-key", dashboardUrl: BASE });
    for (const [name, source] of [
      ["archivePath", { archivePath: "/tmp/bench.tar.gz" }],
      ["harborHubRef", { harborHubRef: "hub://deep-swe@1.1" }],
    ] as const) {
      let threw = false;
      try {
        await b.import({ source, benchmarkName: "deep-swe" });
      } catch (e: any) {
        threw = true;
        assert(e instanceof NotImplementedError, `${name} source throws NotImplementedError`);
        assert(e.message.includes("reserved"), `${name} message explains the reservation`);
      }
      assert(threw, `${name} source throws`);
    }
    assertEqual(fetchCalls.length, 0, "reserved sources never hit the network");
  } finally {
    restoreFetch();
  }
}

async function testGetImport() {
  console.log("\n--- benchmarks().getImport() maps state/error/taskCount ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/import/imp-1", {
      status: 200,
      body: { state: "VALIDATING", error: null, taskCount: 113 },
    });

    const b = benchmarks({ apiKey: "test-key", dashboardUrl: BASE });
    const imported = await b.getImport("imp-1");

    assert(
      fetchCalls[0].url.includes("/api/benchmarks/import/imp-1"),
      "targets the import detail route"
    );
    assertEqual(
      imported,
      { id: "imp-1", state: "VALIDATING", error: null, taskCount: 113 },
      "maps state/error/taskCount and backfills id from the argument"
    );
  } finally {
    restoreFetch();
  }
}

async function testWatchImportPollsToTerminal() {
  console.log("\n--- benchmarks().watchImport() polls getImport() to a terminal state ---");
  installMockFetch();
  try {
    const states = [
      { state: "IMPORTING", error: null, taskCount: 0 },
      { state: "VALIDATING", error: null, taskCount: 113 },
      { state: "VALIDATING", error: null, taskCount: 113 },
      { state: "READY", error: null, taskCount: 113 },
    ];
    let calls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: url.toString(), init });
      const body = states[Math.min(calls, states.length - 1)];
      calls++;
      return buildMockResponse({ status: 200, body });
    };

    const b = benchmarks({ apiKey: "test-key", dashboardUrl: BASE });
    const seen: string[] = [];
    const final = await b.watchImport("imp-1", {
      onState: (i) => seen.push(i.state),
      pollIntervalMs: 1,
    });

    assertEqual(calls, 4, "polled until the terminal state");
    assertEqual(seen, ["IMPORTING", "VALIDATING", "READY"], "onState fires only on state changes");
    assertEqual(final.state, "READY", "resolves with the terminal import");
    assertEqual(final.taskCount, 113, "terminal import carries taskCount");

    // FAILED is terminal too, with the error surfaced
    installMockFetch();
    setMockResponse("/api/benchmarks/import/imp-2", {
      status: 200,
      body: { state: "FAILED", error: "task.yaml missing for task abc", taskCount: 0 },
    });
    const failed = await b.watchImport("imp-2", { pollIntervalMs: 1 });
    assertEqual(failed.state, "FAILED", "FAILED ends the watch");
    assertEqual(failed.error, "task.yaml missing for task abc", "failure detail surfaced");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// EVALUATIONS TESTS
// =============================================================================

const RUN_SUMMARY = {
  id: "eval-1",
  status: "QUEUED",
  benchmark: "deep-swe@1.1",
  runsPerTask: 1,
  concurrency: 4,
  maxModelSpendUsd: 25,
  spentUsd: 0,
  counts: { agentSystems: 2, tasks: 5, taskRuns: 10 },
  createdAt: "2026-07-22T00:00:00.000Z",
};

async function testRunPostsSixInputs() {
  console.log("\n--- evaluations().run() POSTs the six-input contract ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations", { status: 202, body: RUN_SUMMARY });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const input = {
      benchmark: "deep-swe@1.1",
      agentSystems: [
        { harness: "codex", model: "gpt-5.5" },
        { harness: "claude", model: "sonnet", harnessVersion: "2.1.0" },
      ],
      tasks: ["abs-module-cache-flags"],
      runsPerTask: 1,
      concurrency: 4,
      maxModelSpendUsd: 25,
      maxModelSpendUsdPerTaskRun: 2.5,
    };
    const evaluation = await e.run(input, { idempotencyKey: "idem-abc" });

    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "POST", "uses POST");
    assertEqual(JSON.parse(call.init?.body as string), input, "body is the six-input contract");
    assertEqual(
      JSON.parse(call.init?.body as string).maxModelSpendUsdPerTaskRun,
      2.5,
      "maxModelSpendUsdPerTaskRun forwarded"
    );
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.["Idempotency-Key"], "idem-abc", "Idempotency-Key header sent");
    assertEqual(headers?.["Content-Type"], "application/json", "JSON content type");
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");

    assertEqual(evaluation.id, "eval-1", "maps id");
    assertEqual(evaluation.status, "QUEUED", "maps status");
    assertEqual(evaluation.benchmark, "deep-swe@1.1", "maps benchmark ref");
    assertEqual(evaluation.counts, { agentSystems: 2, tasks: 5, taskRuns: 10 }, "maps counts");
    assert(evaluation.idempotentReplay === undefined, "no idempotentReplay on fresh create");

    // Without idempotency key, header is absent
    await e.run(input);
    const headers2 = fetchCalls[fetchCalls.length - 1].init?.headers as Record<string, string>;
    assert(!("Idempotency-Key" in (headers2 || {})), "no Idempotency-Key header by default");
  } finally {
    restoreFetch();
  }
}

async function testRunIdempotentReplay() {
  console.log("\n--- evaluations().run() surfaces idempotentReplay ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations", {
      status: 200,
      body: { ...RUN_SUMMARY, idempotentReplay: true },
    });
    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const evaluation = await e.run(
      { benchmark: "deep-swe@1.1", agentSystems: [{ harness: "codex", model: "gpt-5.5" }], maxModelSpendUsd: 25 },
      { idempotencyKey: "idem-abc" }
    );
    assertEqual(evaluation.idempotentReplay, true, "idempotentReplay passed through");
  } finally {
    restoreFetch();
  }
}

async function testGetEvaluationDetail() {
  console.log("\n--- evaluations().get() maps detail and drops internal fields ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1", {
      status: 200,
      body: {
        id: "eval-1",
        status: "RUNNING",
        benchmark: "deep-swe@1.1",
        benchmarkVersionState: "READY",
        runsPerTask: 1,
        concurrency: 4,
        maxModelSpendUsd: 25,
        maxModelSpendUsdPerTaskRun: 2.5,
        spentUsd: 3.5,
        agentSystems: [
          {
            id: "as-internal-1",
            harness: "codex",
            model: "gpt-5.5",
            harnessVersion: null,
            systemDigest: "abcd1234",
          },
        ],
        taskRunCounts: { SCORED: 4, RUNNING: 2, QUEUED: 4 },
        taskRunTotal: 10,
        error: null,
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:05:00.000Z",
      },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const evaluation = await e.get("eval-1");

    assertEqual(evaluation.status, "RUNNING", "maps status");
    assertEqual(evaluation.benchmarkVersionState, "READY", "maps benchmarkVersionState");
    assertEqual(evaluation.maxModelSpendUsdPerTaskRun, 2.5, "maps maxModelSpendUsdPerTaskRun");
    assertEqual(evaluation.spentUsd, 3.5, "maps spentUsd");
    assertEqual(
      evaluation.taskRunCounts,
      { SCORED: 4, RUNNING: 2, QUEUED: 4 },
      "maps taskRunCounts histogram"
    );
    assertEqual(evaluation.taskRunTotal, 10, "maps taskRunTotal");
    assertEqual(
      evaluation.agentSystems,
      [{ harness: "codex", model: "gpt-5.5", harnessVersion: null }],
      "agentSystems reduced to the public triple"
    );
    const system = evaluation.agentSystems?.[0] as Record<string, unknown>;
    assert(!("id" in system), "internal agent system id not exposed");
    assert(!("systemDigest" in system), "systemDigest not exposed");
    assertEqual(evaluation.error, null, "maps error");
  } finally {
    restoreFetch();
  }
}

async function testListEvaluations() {
  console.log("\n--- evaluations().list() builds cursor params and maps the page ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations", {
      status: 200,
      body: {
        evaluations: [
          { ...RUN_SUMMARY, taskRunCounts: { SCORED: 10 } },
          { ...RUN_SUMMARY, id: "eval-0", status: "COMPLETED", taskRunCounts: {} },
        ],
        nextCursor: "eval-0",
      },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });

    const page = await e.list();
    let url = fetchCalls[fetchCalls.length - 1].url;
    assert(!url.includes("limit="), "no limit param by default");
    assert(!url.includes("cursor="), "no cursor param by default");
    assertEqual(page.evaluations.length, 2, "returns 2 evaluations");
    assertEqual(page.evaluations[0].taskRunCounts, { SCORED: 10 }, "maps taskRunCounts");
    assertEqual(page.nextCursor, "eval-0", "maps nextCursor");

    await e.list({ limit: 100, cursor: "eval-5" });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("limit=100"), "limit forwarded");
    assert(url.includes("cursor=eval-5"), "cursor forwarded");
  } finally {
    restoreFetch();
  }
}

async function testTaskRuns() {
  console.log("\n--- evaluations().taskRuns() maps runs (cursor-paged) ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1/task-runs", {
      status: 200,
      body: {
        taskRuns: [
          {
            id: "run-1",
            taskKey: "abs-module-cache-flags",
            agentSystem: { harness: "codex", model: "gpt-5.5", harnessVersion: null },
            runNumber: 1,
            status: "SCORED",
            score: 1,
            metrics: { f2p: 1, p2p: 1 },
            failurePhase: null,
            failureDetail: null,
            phaseTimingsMs: { agentMs: 203000, verifyMs: 31000 },
            modelUsage: { spendUsd: 0.93, spendSource: "key_info", harnessVersion: "codex-cli 0.145.0" },
            sessionRef: "sess-9",
            createdAt: "2026-07-22T00:00:00.000Z",
            updatedAt: "2026-07-22T00:04:00.000Z",
          },
          {
            id: "run-2",
            taskKey: "abs-module-cache-flags",
            agentSystem: { harness: "codex", model: "gpt-5.5", harnessVersion: null },
            runNumber: 2,
            status: "INFRASTRUCTURE_ERROR",
            score: null,
            metrics: null,
            failurePhase: "verifier_boot",
            failureDetail: "sandbox failed to boot",
            phaseTimingsMs: { agentMs: 100 },
            modelUsage: { spendUsd: 0.5, spendSource: "assumed_cap" },
            sessionRef: null,
            createdAt: "2026-07-22T00:00:00.000Z",
            updatedAt: "2026-07-22T00:04:00.000Z",
          },
        ],
        totalCount: 12,
        nextCursor: "run-2",
      },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const page = await e.taskRuns("eval-1", { limit: 2, cursor: "run-0" });

    const url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("/api/evaluations/eval-1/task-runs"), "targets task-runs route");
    assert(url.includes("limit=2"), "limit forwarded");
    assert(url.includes("cursor=run-0"), "cursor forwarded");

    assertEqual(page.totalCount, 12, "maps totalCount");
    assertEqual(page.nextCursor, "run-2", "maps nextCursor");
    assertEqual(page.taskRuns[0].score, 1, "maps score");
    assertEqual(page.taskRuns[0].metrics, { f2p: 1, p2p: 1 }, "maps named metrics map");
    assertEqual(page.taskRuns[0].modelUsage?.spendUsd, 0.93, "maps modelUsage.spendUsd");
    assertEqual(page.taskRuns[0].sessionRef, "sess-9", "maps sessionRef");
    assertEqual(page.taskRuns[1].status, "INFRASTRUCTURE_ERROR", "maps failure status");
    assertEqual(page.taskRuns[1].failurePhase, "verifier_boot", "maps failurePhase");
    assertEqual(page.taskRuns[1].score, null, "unscored run keeps null score (never a fake zero)");
  } finally {
    restoreFetch();
  }
}

async function testCancel() {
  console.log("\n--- evaluations().cancel() POSTs and returns the summary ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1/cancel", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "CANCELLING" },
    });
    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const evaluation = await e.cancel("eval-1");
    assertEqual(fetchCalls[0].init?.method, "POST", "uses POST");
    assertEqual(evaluation.status, "CANCELLING", "maps cancelling status");
  } finally {
    restoreFetch();
  }
}

async function testRerunFailed() {
  console.log("\n--- evaluations().rerunFailed() creates the linked evaluation ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1/rerun-failed", {
      status: 202,
      body: { ...RUN_SUMMARY, id: "eval-2", sourceEvaluationId: "eval-1" },
    });
    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const evaluation = await e.rerunFailed("eval-1", { idempotencyKey: "idem-rr" });

    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "POST", "uses POST");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.["Idempotency-Key"], "idem-rr", "Idempotency-Key header sent");
    assertEqual(evaluation.id, "eval-2", "returns the NEW evaluation");
    assertEqual(evaluation.sourceEvaluationId, "eval-1", "links the source evaluation");
  } finally {
    restoreFetch();
  }
}

async function testRerunFailedConflictError() {
  console.log("\n--- rerunFailed() surfaces 409 for non-terminal evaluations ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1/rerun-failed", {
      status: 409,
      body: { error: "Evaluation is RUNNING; rerun-failed requires a terminal evaluation" },
    });
    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    let threw = false;
    try {
      await e.rerunFailed("eval-1");
    } catch (err: any) {
      threw = true;
      assert(err.message.includes("409"), "error includes status code");
      assert(err.message.includes("terminal"), "error includes server detail");
    }
    assert(threw, "throws on 409");
  } finally {
    restoreFetch();
  }
}

async function testExportBuffer() {
  console.log("\n--- export() returns the gzip archive as a Buffer ---");
  installMockFetch();
  try {
    const archive = gzipSync(Buffer.from(JSON.stringify({ evaluation: { id: "eval-1" } })));
    setMockResponse("/api/evaluations/eval-1/export", {
      status: 200,
      body: null,
      bodyBytes: archive,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="evaluation-eval-1-export.json.gz"',
      },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const buf = await e.export("eval-1");

    assert(Buffer.isBuffer(buf), "returns a Buffer");
    assertEqual(buf.equals(archive), true, "buffer bytes match the archive");
  } finally {
    restoreFetch();
  }
}

async function testExportToFile() {
  console.log("\n--- export({ to }) streams to a file named by Content-Disposition ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-export-${Date.now()}`);
  try {
    const archive = gzipSync(Buffer.from(JSON.stringify({ evaluation: { id: "eval-1" } })));
    setMockResponse("/api/evaluations/eval-1/export", {
      status: 200,
      body: null,
      bodyBytes: archive,
      headers: {
        "Content-Disposition": 'attachment; filename="evaluation-eval-1-export.json.gz"',
      },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const filePath = await e.export("eval-1", { to: tmpDir });

    assert(filePath.endsWith("evaluation-eval-1-export.json.gz"), "filename from Content-Disposition");
    const written = await readFile(filePath);
    assertEqual(written.equals(archive), true, "file bytes match the archive");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testExportStream() {
  console.log("\n--- export({ stream: true }) returns the raw stream ---");
  installMockFetch();
  try {
    const archive = gzipSync(Buffer.from("stream-me"));
    setMockResponse("/api/evaluations/eval-1/export", {
      status: 200,
      body: null,
      bodyBytes: archive,
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const stream = await e.export("eval-1", { stream: true });

    assert(typeof (stream as ReadableStream).getReader === "function", "returns a ReadableStream");
    const chunks: Buffer[] = [];
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    assertEqual(Buffer.concat(chunks).equals(archive), true, "stream bytes match the archive");
  } finally {
    restoreFetch();
  }
}

async function testExportHarborFormat() {
  console.log("\n--- export({ format: 'harbor' }) passes ?format=harbor through ---");
  installMockFetch();
  try {
    const bundle = gzipSync(
      Buffer.from(JSON.stringify({ format: "evolve.evaluation.harbor-bundle" }))
    );
    setMockResponse("/api/evaluations/eval-1/export", {
      status: 200,
      body: null,
      bodyBytes: bundle,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="evaluation-eval-1.harbor.json.gz"',
      },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const buf = await e.export("eval-1", { format: "harbor" });

    const harborCall = fetchCalls[fetchCalls.length - 1];
    assert(
      harborCall.url.includes("/api/evaluations/eval-1/export?format=harbor"),
      "request URL carries ?format=harbor"
    );
    assert(Buffer.isBuffer(buf), "still returns a Buffer (delivery shape unchanged)");
    assertEqual(buf.equals(bundle), true, "buffer bytes match the harbor bundle");

    // Omitting format keeps the canonical archive: no format param at all.
    await e.export("eval-1");
    const plainCall = fetchCalls[fetchCalls.length - 1];
    assert(!plainCall.url.includes("format="), "plain export() sends no format param");
  } finally {
    restoreFetch();
  }
}

async function testExportTerminalRequired() {
  console.log("\n--- export() surfaces 409 for non-terminal evaluations ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1/export", {
      status: 409,
      body: { error: "Evaluation is RUNNING; export requires a terminal evaluation" },
    });
    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    let threw = false;
    try {
      await e.export("eval-1");
    } catch (err: any) {
      threw = true;
      assert(err.message.includes("409"), "error includes status code");
    }
    assert(threw, "throws on 409");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// WATCH (SSE) TESTS
// =============================================================================

function sseText(events: { seq: number; type: string; data: unknown }[]): string {
  return events
    .map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
}

async function testWatchStreamsToTerminal() {
  console.log("\n--- watch() replays events and resolves on the terminal event ---");
  installMockFetch();
  try {
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
      body: { ...RUN_SUMMARY, status: "COMPLETED" },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const events: EvaluationEvent[] = [];
    const finalEvaluation = await e.watch("eval-1", { onEvent: (ev) => events.push(ev) });

    assertEqual(events.length, 3, "3 events delivered (heartbeat comment skipped)");
    assertEqual(events[0], { seq: 0, type: "evaluation.created", data: { taskRunCount: 2 } }, "maps first event");
    assertEqual(events[2].type, "evaluation.completed", "terminal event delivered");
    assertEqual(finalEvaluation.status, "COMPLETED", "resolves with the final evaluation");

    const streamCall = fetchCalls.find((c) => c.url.includes("/events"));
    const headers = streamCall?.init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "SSE request authenticated");
    assertEqual(headers?.Accept, "text/event-stream", "asks for an event stream");
    assert(!("Last-Event-ID" in (headers || {})), "first connect has no Last-Event-ID");
  } finally {
    restoreFetch();
  }
}

async function testWatchResumesWithLastEventId() {
  console.log("\n--- watch() reconnects with Last-Event-ID after a dropped stream ---");
  installMockFetch();
  try {
    let eventsCalls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (urlStr.includes("/events")) {
        eventsCalls++;
        return buildMockResponse({
          status: 200,
          body: null,
          streamBody:
            eventsCalls === 1
              ? sseText([
                  { seq: 0, type: "evaluation.created", data: {} },
                  { seq: 1, type: "task_run.running", data: { taskRunId: "run-1" } },
                ])
              : sseText([{ seq: 2, type: "evaluation.completed", data: {} }]),
        });
      }
      return buildMockResponse({
        status: 200,
        body: {
          ...RUN_SUMMARY,
          status: eventsCalls >= 2 ? "COMPLETED" : "RUNNING",
        },
      });
    };

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const events: EvaluationEvent[] = [];
    const finalEvaluation = await e.watch("eval-1", {
      onEvent: (ev) => events.push(ev),
      reconnectDelayMs: 1,
    });

    assertEqual(eventsCalls, 2, "reconnected once");
    const secondConnect = fetchCalls.filter((c) => c.url.includes("/events"))[1];
    const headers = secondConnect.init?.headers as Record<string, string>;
    assertEqual(headers?.["Last-Event-ID"], "1", "resumes from the last seen seq");
    assertEqual(
      events.map((ev) => ev.seq),
      [0, 1, 2],
      "no events lost or duplicated across the reconnect"
    );
    assertEqual(finalEvaluation.status, "COMPLETED", "resolves with the final evaluation");
  } finally {
    restoreFetch();
  }
}

async function testWatchFallsBackToStatusOnQuietClose() {
  console.log("\n--- watch() resolves via get() when the stream closes without a terminal event ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([{ seq: 0, type: "evaluation.created", data: {} }]),
    });
    setMockResponse("/api/evaluations/eval-1", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "CANCELLED" },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const finalEvaluation = await e.watch("eval-1", { reconnectDelayMs: 1 });

    assertEqual(finalEvaluation.status, "CANCELLED", "terminal status ends the watch");
    // Terminal-status fallback drains ONCE more from lastSeq (tail events may
    // land after the status flip), then finishes: exactly 2 stream connects.
    const eventConnects = fetchCalls.filter((c) => c.url.includes("/events"));
    assertEqual(eventConnects.length, 2, "exactly one drain reconnect on terminal fallback");
    const drainHeaders = eventConnects[1].init?.headers as Record<string, string>;
    assertEqual(drainHeaders?.["Last-Event-ID"], "0", "drain resumes from the last seen seq");
  } finally {
    restoreFetch();
  }
}

async function testWatchRetriesOn5xx() {
  console.log("\n--- watch() backs off and retries transient 5xx ---");
  installMockFetch();
  try {
    let eventsCalls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (urlStr.includes("/events")) {
        eventsCalls++;
        if (eventsCalls === 1) {
          return buildMockResponse({ status: 503, body: { error: "unavailable" } });
        }
        return buildMockResponse({
          status: 200,
          body: null,
          streamBody: sseText([{ seq: 0, type: "evaluation.completed", data: {} }]),
        });
      }
      return buildMockResponse({ status: 200, body: { ...RUN_SUMMARY, status: "COMPLETED" } });
    };

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const finalEvaluation = await e.watch("eval-1", { reconnectDelayMs: 1 });

    assertEqual(eventsCalls, 2, "retried after the 503");
    assertEqual(finalEvaluation.status, "COMPLETED", "resolves after the retry");
  } finally {
    restoreFetch();
  }
}

async function testWatchThrowsOnNonRetryableError() {
  console.log("\n--- watch() throws immediately on 404 ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-missing/events", {
      status: 404,
      body: { error: "Evaluation not found" },
    });
    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    let threw = false;
    try {
      await e.watch("eval-missing");
    } catch (err: any) {
      threw = true;
      assert(err.message.includes("404"), "error includes status code");
    }
    assert(threw, "throws instead of retrying a 404");
    assertEqual(
      fetchCalls.filter((c) => c.url.includes("/events")).length,
      1,
      "does not retry non-retryable errors"
    );
  } finally {
    restoreFetch();
  }
}

async function testWatchAbort() {
  console.log("\n--- watch() rejects when the signal aborts ---");
  installMockFetch();
  try {
    // Stream ends without a terminal event; get() keeps reporting RUNNING, so
    // the watch enters its backoff sleep, where the abort lands.
    setMockResponse("/api/evaluations/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([{ seq: 0, type: "evaluation.created", data: {} }]),
    });
    setMockResponse("/api/evaluations/eval-1", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "RUNNING" },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    let threw = false;
    try {
      await e.watch("eval-1", { signal: controller.signal, reconnectDelayMs: 60_000 });
    } catch {
      threw = true;
    }
    assert(threw, "rejects on abort during backoff");

    // Pre-aborted signal rejects before any request
    const aborted = new AbortController();
    aborted.abort();
    const callsBefore = fetchCalls.length;
    let threwPre = false;
    try {
      await e.watch("eval-1", { signal: aborted.signal });
    } catch {
      threwPre = true;
    }
    assert(threwPre, "rejects immediately on pre-aborted signal");
    assertEqual(fetchCalls.length, callsBefore, "no request made for a pre-aborted signal");
  } finally {
    restoreFetch();
  }
}

async function testTaskRunDetail() {
  console.log("\n--- evaluations().taskRun(id, runId) maps the full run detail ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1/task-runs/run-1", {
      status: 200,
      body: {
        id: "run-1",
        evaluationId: "eval-1",
        taskKey: "abs-module-cache-flags",
        agentSystem: { harness: "codex", model: "gpt-5.5", harnessVersion: null },
        runNumber: 1,
        status: "SCORED",
        score: 1,
        metrics: { f2p: 1 },
        failurePhase: null,
        failureDetail: "x".repeat(5000), // detail route: untruncated
        phaseTimingsMs: { agentMs: 203000, verifyMs: 31000 },
        modelUsage: { spendUsd: 0.93, spendSource: "key_info" },
        harnessVersionResolved: "codex-cli 0.145.0",
        sessionRef: "sess-9",
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:04:00.000Z",
      },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const run = await e.taskRun("eval-1", "run-1");

    assert(
      fetchCalls[0].url.includes("/api/evaluations/eval-1/task-runs/run-1"),
      "targets the task-run detail route"
    );
    assertEqual(run.id, "run-1", "maps id");
    assertEqual(run.evaluationId, "eval-1", "maps evaluationId");
    assertEqual(run.harnessVersionResolved, "codex-cli 0.145.0", "maps harnessVersionResolved");
    assertEqual(run.sessionRef, "sess-9", "maps sessionRef");
    assertEqual(run.failureDetail?.length, 5000, "failureDetail untruncated on the detail route");
    assertEqual(run.score, 1, "maps score");
    assertEqual(
      run.agentSystem,
      { harness: "codex", model: "gpt-5.5", harnessVersion: null },
      "agentSystem reduced to the public triple"
    );
  } finally {
    restoreFetch();
  }
}

async function testTaskRunTracePage() {
  console.log("\n--- evaluations().taskRunTrace() forwards after/limit and maps the page ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1/task-runs/run-1/trace", {
      status: 200,
      body: {
        events: [
          { seq: 3, type: "agent.message", data: { text: "patching" } },
          { seq: 4, type: "phase.completed", data: { phase: "agent" } },
        ],
        nextAfter: 4,
      },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const page = await e.taskRunTrace("eval-1", "run-1", { after: 2, limit: 2 });

    const url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("/task-runs/run-1/trace"), "targets the trace route");
    assert(url.includes("after=2"), "after forwarded");
    assert(url.includes("limit=2"), "limit forwarded");

    assertEqual(page.events.length, 2, "maps 2 events");
    assertEqual(
      page.events[0],
      { seq: 3, type: "agent.message", data: { text: "patching" } },
      "maps seq/type/data"
    );
    assertEqual(page.nextAfter, 4, "maps nextAfter");

    // No options: no params at all
    await e.taskRunTrace("eval-1", "run-1");
    const bare = fetchCalls[fetchCalls.length - 1].url;
    assert(!bare.includes("after=") && !bare.includes("limit="), "no params by default");
  } finally {
    restoreFetch();
  }
}

async function testTaskRunTraceEventsIterator() {
  console.log("\n--- taskRunTraceEvents() drains the trace page by page ---");
  installMockFetch();
  try {
    const traceCalls: (string | null)[] = [];
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      const after = new URL(urlStr).searchParams.get("after");
      traceCalls.push(after);
      const pages: Record<string, unknown> = {
        // no after: first page; then resume from nextAfter
        "": { events: [{ seq: 1, type: "a", data: {} }, { seq: 2, type: "b", data: {} }], nextAfter: 2 },
        "2": { events: [{ seq: 3, type: "c", data: {} }], nextAfter: 3 },
        "3": { events: [], nextAfter: 3 },
      };
      return buildMockResponse({ status: 200, body: pages[after ?? ""] });
    };

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const seqs: number[] = [];
    for await (const event of e.taskRunTraceEvents("eval-1", "run-1")) {
      seqs.push(event.seq);
    }

    assertEqual(seqs, [1, 2, 3], "yields every event exactly once, in seq order");
    assertEqual(traceCalls, [null, "2", "3"], "pages resume from nextAfter");

    // With an explicit page limit, a short page ends the drain without an
    // extra empty-page request.
    fetchCalls.length = 0;
    traceCalls.length = 0;
    const seqsLimited: number[] = [];
    for await (const event of e.taskRunTraceEvents("eval-1", "run-1", { limit: 2 })) {
      seqsLimited.push(event.seq);
    }
    assertEqual(seqsLimited, [1, 2, 3], "limited drain still yields every event");
    assertEqual(traceCalls, [null, "2"], "short page (< limit) ends the drain early");
  } finally {
    restoreFetch();
  }
}

async function testCompare() {
  console.log("\n--- evaluations().compare() maps aggregates + task matrix ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/compare", {
      status: 200,
      body: {
        evaluations: [
          {
            id: "eval-1",
            benchmark: "deep-swe@1.1",
            status: "COMPLETED",
            meanScore: 0.5,
            coverage: { scored: 4, total: 5 },
            spentUsd: 12.5,
            agentSystems: [
              { id: "as-internal-1", harness: "codex", model: "gpt-5.5", harnessVersion: null },
            ],
            createdAt: "2026-07-22T00:00:00.000Z",
          },
          {
            id: "eval-2",
            benchmark: "deep-swe@1.1",
            status: "COMPLETED",
            meanScore: 0, // zero is a score, not a missing value
            coverage: { scored: 5, total: 5 },
            spentUsd: 9.1,
            agentSystems: [
              { id: "as-internal-2", harness: "claude", model: "sonnet", harnessVersion: "2.1.0" },
            ],
            createdAt: "2026-07-22T01:00:00.000Z",
          },
        ],
        taskMatrix: [
          {
            taskKey: "abs-module-cache-flags",
            disagreement: true,
            cells: [
              { evaluationId: "eval-1", status: "SCORED", score: 1, coverage: { scored: 1, total: 1 } },
              { evaluationId: "eval-2", status: "MISSING", score: null, coverage: { scored: 0, total: 0 } },
            ],
          },
          {
            taskKey: "zlib-stream-reset",
            disagreement: false,
            cells: [
              { evaluationId: "eval-1", status: "SCORED", score: 0, coverage: { scored: 1, total: 1 } },
              { evaluationId: "eval-2", status: "SCORED", score: 0, coverage: { scored: 1, total: 1 } },
            ],
          },
        ],
      },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const comparison = await e.compare(["eval-1", "eval-2"]);

    const url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("/api/evaluations/compare?ids=eval-1,eval-2"), "ids joined comma-separated");

    assertEqual(comparison.evaluations.length, 2, "2 aggregates, in the caller's order");
    assertEqual(comparison.evaluations[0].id, "eval-1", "maps aggregate id");
    assertEqual(comparison.evaluations[0].meanScore, 0.5, "maps meanScore");
    assertEqual(comparison.evaluations[0].coverage, { scored: 4, total: 5 }, "maps coverage");
    assertEqual(comparison.evaluations[1].meanScore, 0, "zero meanScore preserved (never nulled)");
    assertEqual(
      comparison.evaluations[0].agentSystems,
      [{ harness: "codex", model: "gpt-5.5", harnessVersion: null }],
      "agentSystems reduced to the public triple"
    );
    const system = comparison.evaluations[0].agentSystems[0] as Record<string, unknown>;
    assert(!("id" in system), "internal agent system id not exposed");

    assertEqual(comparison.taskMatrix.length, 2, "maps matrix rows");
    assertEqual(comparison.taskMatrix[0].disagreement, true, "maps disagreement flag");
    assertEqual(
      comparison.taskMatrix[0].cells[1],
      { evaluationId: "eval-2", status: "MISSING", score: null, coverage: { scored: 0, total: 0 } },
      "MISSING cell preserved"
    );
    assertEqual(comparison.taskMatrix[1].cells[0].score, 0, "zero cell score preserved");
  } finally {
    restoreFetch();
  }
}

async function testCompareBadIdsError() {
  console.log("\n--- compare() surfaces the server's 400 for bad id lists ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/compare", {
      status: 400,
      body: { error: "ids must list between 2 and 5 distinct evaluation ids (comma-separated)" },
    });
    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    let threw = false;
    try {
      await e.compare(["eval-1"]);
    } catch (err: any) {
      threw = true;
      assert(err.message.includes("400"), "error includes status code");
      assert(err.message.includes("between 2 and 5"), "error includes server detail");
    }
    assert(threw, "throws on 400");
  } finally {
    restoreFetch();
  }
}

async function testApiErrorHandling() {
  console.log("\n--- API errors throw with status and body ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks", { status: 401, body: { error: "Invalid API key" } });
    const b = benchmarks({ apiKey: "bad-key", dashboardUrl: BASE });
    let threw = false;
    try {
      await b.list();
    } catch (e: any) {
      threw = true;
      assert(e.message.includes("401"), "error includes status code");
      assert(e.message.includes("Invalid API key"), "error includes server detail");
    }
    assert(threw, "throws on 401");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// ERGONOMICS: getActive, iterator watch, auto-pagination
// =============================================================================

async function testGetActive() {
  console.log("\n--- benchmarks().getActive() resolves the active version to a runnable shape ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/deep-swe", {
      status: 200,
      body: {
        name: "deep-swe",
        displayTitle: "DeepSWE",
        description: "SWE tasks",
        activeVersion: "1.1",
        versions: [
          { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
          { version: "1.0", state: "ARCHIVED", createdAt: "2026-07-01T00:00:00.000Z", taskCount: 100 },
        ],
        tasksVersion: "1.1",
        tasks: [
          { taskKey: "abs-module-cache-flags", agentTimeoutSec: 5400, verifierTimeoutSec: 1800 },
        ],
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    });

    const catalog = benchmarks({ apiKey: "test-key", dashboardUrl: BASE });
    const active = await catalog.getActive("deep-swe");

    const url = fetchCalls[fetchCalls.length - 1].url;
    assert(!url.includes("version="), "getActive resolves the bare name (active version's tasks)");

    assertEqual(active.version, "1.1", "version is the active version string (non-optional)");
    assertEqual(active.activeVersion.state, "READY", "activeVersion carries the full version object");
    assertEqual(active.tasks.length, 1, "tasks is populated (non-optional)");
    assertEqual(active.tasks[0].taskKey, "abs-module-cache-flags", "maps public task fields");
    assertEqual(active.versions.length, 2, "carries all versions");
    assertEqual(active.tasksVersion, "1.1", "tasksVersion matches the active version");
  } finally {
    restoreFetch();
  }
}

async function testGetActiveNoActiveVersion() {
  console.log("\n--- benchmarks().getActive() throws NoActiveVersionError when none is active ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/draft-bench", {
      status: 200,
      body: {
        name: "draft-bench",
        displayTitle: null,
        description: null,
        activeVersion: null,
        versions: [
          { version: "0.1", state: "DRAFT", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 0 },
        ],
        tasksVersion: null,
        tasks: [],
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    });

    const catalog = benchmarks({ apiKey: "test-key", dashboardUrl: BASE });
    let threw = false;
    try {
      await catalog.getActive("draft-bench");
    } catch (err: any) {
      threw = true;
      assert(err instanceof NoActiveVersionError, "throws NoActiveVersionError");
      assert(err.message.includes("no active version"), "message explains there is no active version");
      assertEqual(err.benchmark, "draft-bench", "error carries the benchmark name");
    }
    assert(threw, "getActive throws when no version is active");
  } finally {
    restoreFetch();
  }
}

async function testWatchAsIterator() {
  console.log("\n--- watch() is usable as an async iterator (for await) ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1/events", {
      status: 200,
      body: null,
      streamBody:
        sseText([
          { seq: 0, type: "evaluation.created", data: { taskRunCount: 2 } },
          { seq: 1, type: "task_run.settled", data: { taskRunId: "run-1", status: "SCORED" } },
        ]) +
        sseText([{ seq: 2, type: "evaluation.completed", data: { scored: 2 } }]),
    });
    setMockResponse("/api/evaluations/eval-1", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "COMPLETED" },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const events: EvaluationEvent[] = [];
    for await (const event of e.watch("eval-1")) {
      events.push(event);
    }
    assertEqual(events.map((ev) => ev.seq), [0, 1, 2], "iterator yields every event in seq order");
    assertEqual(events[2].type, "evaluation.completed", "iterator ends on the terminal event");
  } finally {
    restoreFetch();
  }
}

async function testWatchIteratorEarlyBreak() {
  console.log("\n--- watch() iterator stops cleanly on an early break ---");
  installMockFetch();
  try {
    setMockResponse("/api/evaluations/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([
        { seq: 0, type: "task_run.settled", data: { taskRunId: "run-1" } },
        { seq: 1, type: "task_run.settled", data: { taskRunId: "run-2" } },
        { seq: 2, type: "evaluation.completed", data: {} },
      ]),
    });
    setMockResponse("/api/evaluations/eval-1", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "COMPLETED" },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const seen: number[] = [];
    for await (const event of e.watch("eval-1")) {
      seen.push(event.seq);
      break; // consume only the first event, then abandon the stream
    }
    assertEqual(seen, [0], "breaking after the first event stops the iterator (no throw)");
  } finally {
    restoreFetch();
  }
}

async function testWatchIteratorAbort() {
  console.log("\n--- watch() iterator rejects when the signal aborts ---");
  installMockFetch();
  try {
    // Stream ends without a terminal event; get() stays RUNNING, so the watch
    // enters its backoff sleep where the abort lands.
    setMockResponse("/api/evaluations/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([{ seq: 0, type: "evaluation.created", data: {} }]),
    });
    setMockResponse("/api/evaluations/eval-1", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "RUNNING" },
    });

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const seen: number[] = [];
    let threw = false;
    try {
      for await (const event of e.watch("eval-1", {
        signal: controller.signal,
        reconnectDelayMs: 60_000,
      })) {
        seen.push(event.seq);
      }
    } catch {
      threw = true;
    }
    assert(threw, "iterator rejects on abort during backoff");
    assertEqual(seen, [0], "delivered the pre-abort event before rejecting");
  } finally {
    restoreFetch();
  }
}

async function testListAutoPagination() {
  console.log("\n--- evaluations().list() walks cursor pages when iterated ---");
  installMockFetch();
  try {
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      const cursor = new URL(urlStr).searchParams.get("cursor");
      const pages: Record<string, unknown> = {
        "": {
          evaluations: [
            { ...RUN_SUMMARY, id: "eval-2" },
            { ...RUN_SUMMARY, id: "eval-1" },
          ],
          nextCursor: "eval-1",
        },
        "eval-1": {
          evaluations: [{ ...RUN_SUMMARY, id: "eval-0" }],
          nextCursor: null,
        },
      };
      return buildMockResponse({ status: 200, body: pages[cursor ?? ""] });
    };

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });

    // Iterator form: walks every evaluation across both pages
    const ids: string[] = [];
    for await (const evaluation of e.list()) ids.push(evaluation.id);
    assertEqual(ids, ["eval-2", "eval-1", "eval-0"], "iterates every row across cursor pages");
    const cursors = fetchCalls.map((c) => new URL(c.url).searchParams.get("cursor"));
    assertEqual(cursors, [null, "eval-1"], "second page fetched with the first page's nextCursor");

    // Page form still returns a single page for the given options
    fetchCalls.length = 0;
    const page = await e.list({ limit: 2 });
    assertEqual(page.evaluations.length, 2, "await returns a single page");
    assertEqual(page.nextCursor, "eval-1", "single page carries nextCursor");
    assertEqual(fetchCalls.length, 1, "page form makes exactly one request");
    assert(fetchCalls[0].url.includes("limit=2"), "page form forwards the limit");
  } finally {
    restoreFetch();
  }
}

async function testTaskRunsAutoPagination() {
  console.log("\n--- evaluations().taskRuns() walks cursor pages when iterated ---");
  installMockFetch();
  try {
    const makeRun = (id: string, runNumber: number) => ({
      id,
      taskKey: "abs-module-cache-flags",
      agentSystem: { harness: "codex", model: "gpt-5.5", harnessVersion: null },
      runNumber,
      status: "SCORED",
      score: 1,
      metrics: null,
      failurePhase: null,
      failureDetail: null,
      phaseTimingsMs: null,
      modelUsage: null,
      sessionRef: null,
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      const cursor = new URL(urlStr).searchParams.get("cursor");
      const pages: Record<string, unknown> = {
        "": { taskRuns: [makeRun("run-1", 1), makeRun("run-2", 2)], totalCount: 3, nextCursor: "run-2" },
        "run-2": { taskRuns: [makeRun("run-3", 3)], totalCount: 3, nextCursor: null },
      };
      return buildMockResponse({ status: 200, body: pages[cursor ?? ""] });
    };

    const e = evaluations({ apiKey: "test-key", dashboardUrl: BASE });

    const runIds: string[] = [];
    for await (const run of e.taskRuns("eval-1")) runIds.push(run.id);
    assertEqual(runIds, ["run-1", "run-2", "run-3"], "iterates every task run across cursor pages");

    // Page form still returns a single page with totalCount
    fetchCalls.length = 0;
    const page = await e.taskRuns("eval-1", { limit: 2 });
    assertEqual(page.taskRuns.length, 2, "await returns a single page");
    assertEqual(page.totalCount, 3, "single page carries totalCount");
    assertEqual(page.nextCursor, "run-2", "single page carries nextCursor");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// RUN
// =============================================================================

async function main() {
  console.log("Hosted Evals Client Unit Tests\n");

  await testFactoriesRequireApiKey();
  await testBenchmarksList();
  await testBenchmarksGet();
  await testGetActive();
  await testGetActiveNoActiveVersion();
  await testImportGitSource();
  await testImportReservedSources();
  await testGetImport();
  await testWatchImportPollsToTerminal();
  await testRunPostsSixInputs();
  await testRunIdempotentReplay();
  await testGetEvaluationDetail();
  await testListEvaluations();
  await testListAutoPagination();
  await testTaskRuns();
  await testTaskRunsAutoPagination();
  await testCancel();
  await testRerunFailed();
  await testRerunFailedConflictError();
  await testExportBuffer();
  await testExportToFile();
  await testExportStream();
  await testExportHarborFormat();
  await testExportTerminalRequired();
  await testWatchStreamsToTerminal();
  await testWatchAsIterator();
  await testWatchIteratorEarlyBreak();
  await testWatchIteratorAbort();
  await testWatchResumesWithLastEventId();
  await testWatchFallsBackToStatusOnQuietClose();
  await testWatchRetriesOn5xx();
  await testWatchThrowsOnNonRetryableError();
  await testWatchAbort();
  await testTaskRunDetail();
  await testTaskRunTracePage();
  await testTaskRunTraceEventsIterator();
  await testCompare();
  await testCompareBadIdsError();
  await testApiErrorHandling();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
