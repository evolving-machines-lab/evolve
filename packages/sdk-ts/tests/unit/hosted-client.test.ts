#!/usr/bin/env tsx
/**
 * Unit Test: Hosted Evals Client (benchmarks + customHarnesses + jobs)
 *
 * Tests the benchmarks(), customHarnesses() and jobs() factories against
 * the hosted evals API shapes: catalog mapping, the run contract (incl. the
 * per-trial spend cap and the harnessVersion pin) with Idempotency-Key, the
 * custom-harness registration lanes (install-script JSON body vs uploaded
 * tarball with metadata on the query string) plus list/get/delete, cursor
 * pagination, cancel/rerun-failed,
 * gzip export (buffer / file / stream), SSE watch with Last-Event-ID resume +
 * reconnect backoff, the git import trio (import/getImport/watchImport),
 * compare aggregates + task matrix, trial detail + seq-paged trace with the
 * async iterator, internal-field leak sentinels, per-task provider verdicts,
 * and the typed EvolveApiError mapping of { error: { code, message } } bodies.
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

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  benchmarks,
  customHarnesses,
  jobs,
  EvolveApiError,
  EvolveDigestMismatchError,
  EvolveIncompleteDownloadError,
  isHostedErrorCode,
  NoActiveVersionError,
} from "../../src/hosted/index.ts";
import type { JobEvent } from "../../src/hosted/index.ts";
// Root-surface check: these documented types must be importable from the
// package root, not just from hosted/ (compile-time guard for the export block)
import type { EvalSandboxProvider as RootEvalSandboxProvider } from "../../src/index.ts";

const BASE = "http://localhost:3000";

// =============================================================================
// BENCHMARKS TESTS
// =============================================================================

async function testFactoriesRequireApiKey() {
  console.log("\n--- benchmarks()/jobs() require API key ---");
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
      jobs();
    } catch (e: any) {
      threwE = true;
      assert(e.message.includes("API key"), "jobs error mentions API key");
    }
    assert(threwE, "jobs() throws without API key");
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
        items: [
          {
            name: "deep-swe",
            title: "DeepSWE",
            description: "SWE-bench style tasks",
            activeVersion: { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
          },
          {
            name: "empty-bench",
            title: null,
            description: null,
            activeVersion: null,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const catalog = await b.list();

    // The one page envelope, the same on every collection this surface returns.
    assertEqual(catalog.items.length, 2, "returns 2 benchmarks");
    assertEqual(catalog.nextCursor, null, "nextCursor null = no next page");
    assertEqual(catalog.hasMore, false, "hasMore says the same as a boolean");
    assertEqual(catalog.items[0].name, "deep-swe", "maps name");
    assertEqual(catalog.items[0].title, "DeepSWE", "maps title");
    assertEqual(
      catalog.items[0].activeVersion,
      { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
      "maps activeVersion object (one shape: version/state/createdAt/taskCount)"
    );
    assertEqual(catalog.items[1].activeVersion, null, "null activeVersion preserved");

    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");
  } finally {
    restoreFetch();
  }
}

async function testBenchmarksGet() {
  console.log("\n--- benchmarks().get() resolves name[@version] and maps detail ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/deep-swe", {
      status: 200,
      body: {
        name: "deep-swe",
        title: "DeepSWE",
        description: "SWE-bench style tasks",
        activeVersion: { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
        versions: [
          { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
          { version: "1.0", state: "ARCHIVED", createdAt: "2026-07-01T00:00:00.000Z", taskCount: 100 },
        ],
        selectedVersion: { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
        tasks: {
          items: [
            {
              taskKey: "abs-module-cache-flags",
              agentTimeoutSec: 5400,
              verifierTimeoutSec: 1800,
              providers: { e2b: { ok: true }, daytona: { ok: true }, modal: { ok: false, reason: "multi-container tasks are not supported on modal" } },
            },
          ],
          nextCursor: "task-1",
          hasMore: true,
        },
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const detail = await b.get("deep-swe@1.1");

    let url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("/api/benchmarks/deep-swe"), "targets the benchmark route");
    assert(url.includes("version=1.1"), "ref version becomes ?version=");

    assertEqual(detail.name, "deep-swe", "maps name");
    assertEqual(detail.title, "DeepSWE", "maps title");
    assertEqual(detail.activeVersion?.version, "1.1", "activeVersion is the full version object");
    assertEqual(detail.activeVersion?.state, "READY", "activeVersion carries state");
    assertEqual(detail.versions?.length, 2, "maps versions");
    assertEqual(
      detail.selectedVersion,
      { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
      "selectedVersion is a full version object (never a bare label)"
    );
    // A nested collection is the same envelope as a top-level one.
    assertEqual(detail.tasks?.hasMore, true, "tasks are paged like every collection");
    assertEqual(detail.tasks?.nextCursor, "task-1", "tasks carry a cursor");
    assertEqual(detail.tasks?.items[0].taskKey, "abs-module-cache-flags", "maps public task fields");
    assertEqual(
      detail.tasks?.items[0].providers,
      { e2b: { ok: true }, daytona: { ok: true }, modal: { ok: false, reason: "multi-container tasks are not supported on modal" } },
      "per-task provider verdicts mapped — capability visible before money is spent"
    );

    // Bare name: no version param
    await b.get("deep-swe");
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(!url.includes("version="), "bare name omits version param");
  } finally {
    restoreFetch();
  }
}

async function testImportGitSource() {
  console.log("\n--- benchmarks().import() POSTs the git-source contract ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/imports", {
      status: 202,
      body: { id: "imp-1", benchmarkName: "deep-swe", version: "1.2", status: "QUEUED" },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const imported = await b.import({
      source: { gitUrl: "https://github.com/x/bench.git", ref: "main" },
      benchmarkName: "deep-swe",
      version: "1.2",
    });

    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/benchmarks/imports"), "targets the imports collection route");
    assertEqual(call.init?.method, "POST", "uses POST");
    // ONE body grammar for both sources: multipart/form-data with named parts.
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("benchmarkName"), "deep-swe", "benchmarkName is a named part");
    assertEqual(form.get("version"), "1.2", "version is a named part");
    assertEqual(form.get("gitUrl"), "https://github.com/x/bench.git", "gitUrl is a named part");
    assertEqual(form.get("ref"), "main", "ref is a named part");
    assertEqual(form.get("file"), null, "no file part for a git source");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");

    assertEqual(
      imported,
      { id: "imp-1", status: "QUEUED", benchmarkName: "deep-swe", version: "1.2", failure: null },
      "202 response mapped (id, status, benchmarkName, version, failure)"
    );
  } finally {
    restoreFetch();
  }
}

async function testImportRequiresGitSource() {
  console.log("\n--- benchmarks().import() requires a complete git source ---");
  installMockFetch();
  try {
    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await b.import({
        source: { gitUrl: "", ref: "main" },
        benchmarkName: "deep-swe",
        version: "1.2",
      });
    } catch (e: any) {
      threw = true;
      assert(e.message.includes("git source"), "message names the git source requirement");
    }
    assert(threw, "empty gitUrl throws");
    assertEqual(fetchCalls.length, 0, "invalid input never hits the network");
  } finally {
    restoreFetch();
  }
}

async function testImportDirectorySource() {
  console.log("\n--- benchmarks().import() tars + gzips a local directory and uploads it ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-import-dir-"));
  try {
    await mkdir(join(dir, "tasks", "abc"), { recursive: true });
    await writeFile(join(dir, "tasks", "abc", "task.toml"), 'schema_version = "1.1"\n');
    setMockResponse("/api/benchmarks/imports", {
      status: 202,
      body: { id: "imp-2", benchmarkName: "my-bench", version: "0.1", status: "QUEUED" },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const imported = await b.import({
      source: { directory: dir },
      benchmarkName: "my-bench",
      version: "0.1",
    });

    const call = fetchCalls[fetchCalls.length - 1];
    // Metadata is named PARTS; the corpus is the `file` part. The URL is bare.
    assert(call.url.endsWith("/api/benchmarks/imports"), "the URL carries nothing");
    assertEqual(call.init?.method, "POST", "uses POST");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("benchmarkName"), "my-bench", "benchmarkName is a named part");
    assertEqual(form.get("version"), "0.1", "version is a named part");
    // The metadata parts come FIRST so the server can refuse a name it will
    // never accept before receiving a half-gigabyte upload.
    assertEqual([...form.keys()], ["benchmarkName", "version", "file"], "metadata precedes the file part");

    const file = form.get("file") as File;
    assert(file instanceof Blob, "the corpus is the file part");
    const body = new Uint8Array(await file.arrayBuffer());
    assert(body.length > 0, "file part is non-empty bytes");
    assert(body[0] === 0x1f && body[1] === 0x8b, "file part is a gzip stream (magic 1f 8b)");
    // The gzipped tar carries the corpus file path + content (USTAR stores both as plain bytes).
    const tarText = gunzipSync(Buffer.from(body)).toString("latin1");
    assert(tarText.includes("tasks/abc/task.toml"), "the tar carries the corpus file path");
    assert(tarText.includes('schema_version = "1.1"'), "the tar carries the file content");

    assertEqual(
      imported,
      { id: "imp-2", status: "QUEUED", benchmarkName: "my-bench", version: "0.1", failure: null },
      "202 response mapped (id, status, benchmarkName, version, failure)"
    );
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testGetImport() {
  console.log("\n--- benchmarks().getImport() maps status/error/taskCount ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/imports/imp-1", {
      status: 200,
      body: { id: "imp-1", status: "COMPLETED", benchmarkName: "deep-swe", version: "1.2", taskCount: 113, failure: null },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const imported = await b.getImport("imp-1");

    assert(
      fetchCalls[0].url.includes("/api/benchmarks/imports/imp-1"),
      "targets the import detail route"
    );
    assertEqual(
      imported,
      { id: "imp-1", status: "COMPLETED", benchmarkName: "deep-swe", version: "1.2", failure: null, taskCount: 113 },
      "self-describing job: id/status/benchmarkName/version/failure/taskCount"
    );
  } finally {
    restoreFetch();
  }
}

async function testWatchImportPollsToTerminal() {
  console.log("\n--- benchmarks().watchImport() polls getImport() to a terminal status ---");
  installMockFetch();
  try {
    const job = { id: "imp-1", benchmarkName: "deep-swe", version: "1.2" };
    const statuses = [
      { ...job, status: "QUEUED", failure: null, taskCount: 0 },
      { ...job, status: "RUNNING", failure: null, taskCount: 0 },
      { ...job, status: "COMPLETED", failure: null, taskCount: 113 },
    ];
    let calls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: url.toString(), init });
      const body = statuses[Math.min(calls, statuses.length - 1)];
      calls++;
      return buildMockResponse({ status: 200, body });
    };

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const seen: string[] = [];
    const final = await b.watchImport("imp-1", {
      onStatus: (i) => seen.push(i.status),
      pollIntervalMs: 1,
    });

    assertEqual(calls, 3, "polled until the terminal status");
    assertEqual(seen, ["QUEUED", "RUNNING", "COMPLETED"], "onStatus fires on every status change");
    assertEqual(final.status, "COMPLETED", "resolves with the terminal import");
    assertEqual(final.taskCount, 113, "terminal import carries taskCount");

    // FAILED is terminal too, with the structured error surfaced
    installMockFetch();
    setMockResponse("/api/benchmarks/imports/imp-2", {
      status: 200,
      body: { ...job, id: "imp-2", status: "FAILED", failure: { code: "import_failed", message: "task.yaml missing for task abc" }, taskCount: 0 },
    });
    const failed = await b.watchImport("imp-2", { pollIntervalMs: 1 });
    assertEqual(failed.status, "FAILED", "FAILED ends the watch");
    assertEqual(
      failed.failure,
      { code: "import_failed", message: "task.yaml missing for task abc" },
      "failure detail surfaced on `failure`, never `error` — `error` means the REQUEST failed"
    );
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// CUSTOM HARNESSES TESTS
// =============================================================================

const CUSTOM_HARNESS = {
  name: "acme-cli",
  source: "install_script",
  runCommand: "acme-cli --headless",
  env: { ACME_PROFILE: "bench" },
  createdAt: "2026-07-24T00:00:00Z",
  updatedAt: "2026-07-24T00:00:00Z",
};

async function testCustomHarnessCreateInstallScript() {
  console.log("\n--- customHarnesses().create() posts the install-script JSON body ---");
  installMockFetch();
  try {
    setMockResponse("/api/custom-harnesses", { status: 201, body: CUSTOM_HARNESS });
    const h = customHarnesses({ apiKey: "test-key", baseUrl: BASE });
    const created = await h.create({
      name: "acme-cli",
      installScript: "curl -fsSL https://acme.dev/install.sh | sh",
      runCommand: "acme-cli --headless",
      env: { ACME_PROFILE: "bench" },
    });
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/custom-harnesses"), "hits the custom-harnesses route");
    assertEqual(call.init?.method, "POST", "uses POST");
    // ONE body grammar for both sources: multipart/form-data, so the endpoint
    // no longer switches grammars on Content-Type.
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("name"), "acme-cli", "name is a named part");
    assertEqual(
      form.get("installScript"),
      "curl -fsSL https://acme.dev/install.sh | sh",
      "installScript is a named part"
    );
    assertEqual(form.get("runCommand"), "acme-cli --headless", "runCommand is a named part");
    assertEqual(form.get("env"), JSON.stringify({ ACME_PROFILE: "bench" }), "env is a JSON part");
    assertEqual(form.get("file"), null, "no file part for the install-script source");
    assertEqual(created, CUSTOM_HARNESS, "201 response mapped (name, source, runCommand, env, timestamps)");
  } finally {
    restoreFetch();
  }
}

async function testCustomHarnessCreateTarball() {
  console.log("\n--- customHarnesses().create() tars a directory into a multipart file part ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-harness-dir-"));
  try {
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "acme-cli"), "#!/bin/sh\nexec acme \"$@\"\n");
    setMockResponse("/api/custom-harnesses", {
      status: 201,
      body: { ...CUSTOM_HARNESS, source: "tarball" },
    });

    const h = customHarnesses({ apiKey: "test-key", baseUrl: BASE });
    const created = await h.create({
      name: "acme-cli",
      directory: dir,
      runCommand: "acme-cli --headless",
      env: { ACME_PROFILE: "bench", ACME_REGION: "us" },
    });

    const call = fetchCalls[fetchCalls.length - 1];
    // THE LEAK A6 CLOSES: the run command and the declared env used to ride the
    // query string, which put a shell command and a set of environment values
    // into every access log and proxy buffer on the way to the server.
    assert(call.url.endsWith("/api/custom-harnesses"), "the URL carries nothing");
    assertEqual(call.init?.method, "POST", "uses POST");
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("name"), "acme-cli", "name is a named part");
    assertEqual(form.get("runCommand"), "acme-cli --headless", "runCommand is a named part");
    assertEqual(
      form.get("env"),
      JSON.stringify({ ACME_PROFILE: "bench", ACME_REGION: "us" }),
      "env is one JSON part, not repeated query pairs"
    );
    const file = form.get("file") as File;
    assert(file instanceof Blob, "the archive is the file part");
    const body = new Uint8Array(await file.arrayBuffer());
    assert(body.length > 0, "file part is non-empty bytes");
    assert(body[0] === 0x1f && body[1] === 0x8b, "file part is a gzip stream (magic 1f 8b)");
    const tarText = gunzipSync(Buffer.from(body)).toString("latin1");
    assert(tarText.includes("bin/acme-cli"), "the tar carries the harness executable path");
    assertEqual(created.source, "tarball", "server echoes the tarball source");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testCustomHarnessCreateRequiresOneSource() {
  console.log("\n--- customHarnesses().create() requires exactly one source ---");
  const h = customHarnesses({ apiKey: "test-key", baseUrl: BASE });
  let threwNone = false;
  try {
    await h.create({ name: "acme-cli", runCommand: "acme-cli --headless" });
  } catch (err: any) {
    threwNone = true;
    assert(err.message.includes("installScript"), "no-source error names installScript");
    assert(err.message.includes("directory"), "no-source error names directory");
  }
  assert(threwNone, "throws when neither source is given");

  let threwBoth = false;
  try {
    await h.create({
      name: "acme-cli",
      installScript: "true",
      directory: "/tmp/acme",
      runCommand: "acme-cli --headless",
    });
  } catch (err: any) {
    threwBoth = true;
    assert(err.message.includes("not both"), "both-sources error says not both");
  }
  assert(threwBoth, "throws when both sources are given");
}

async function testCustomHarnessListGetDelete() {
  console.log("\n--- customHarnesses() list/get/delete ---");
  installMockFetch();
  try {
    setMockResponse("/api/custom-harnesses/acme-cli", { status: 200, body: CUSTOM_HARNESS });
    setMockResponse("/api/custom-harnesses", {
      status: 200,
      body: { items: [CUSTOM_HARNESS], nextCursor: null, hasMore: false },
    });
    const h = customHarnesses({ apiKey: "test-key", baseUrl: BASE });

    const listed = await h.list();
    assertEqual(listed.items.length, 1, "list() returns the one page envelope");
    assertEqual(listed.nextCursor, null, "nextCursor null = no next page");
    assertEqual(listed.items[0].name, "acme-cli", "maps the harness name");
    assertEqual(listed.items[0].source, "install_script", "maps the source");

    const one = await h.get("acme-cli");
    assert(
      fetchCalls[fetchCalls.length - 1].url.endsWith("/api/custom-harnesses/acme-cli"),
      "get() targets the detail route"
    );
    assertEqual(one.runCommand, "acme-cli --headless", "maps the run command");

    setMockResponse("/api/custom-harnesses/acme-cli", { status: 204, body: null });
    const deleted = await h.delete("acme-cli");
    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "DELETE", "delete() uses DELETE");
    assertEqual(deleted, undefined, "delete() resolves with nothing (204)");
  } finally {
    restoreFetch();
  }
}

async function testCustomHarnessNotFoundIsTypedError() {
  console.log("\n--- customHarnesses().get() surfaces 404 custom_harness_not_found ---");
  installMockFetch();
  try {
    setMockResponse("/api/custom-harnesses/someone-elses", {
      status: 404,
      body: {
        error: {
          code: "custom_harness_not_found",
          message: 'No custom harness named "someone-elses".',
        },
      },
    });
    const h = customHarnesses({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await h.get("someone-elses");
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 404, "carries the HTTP status");
      assertEqual(err.code, "custom_harness_not_found", "another owner's name is not-found, never a leak");
    }
    assert(threw, "throws on 404");
  } finally {
    restoreFetch();
  }
}

async function testCustomHarnessNameTakenIsTypedError() {
  console.log("\n--- customHarnesses().create() surfaces 409 custom_harness_name_taken ---");
  installMockFetch();
  try {
    setMockResponse("/api/custom-harnesses", {
      status: 409,
      body: {
        error: {
          code: "custom_harness_name_taken",
          message: 'You already registered a custom harness named "acme-cli".',
        },
      },
    });
    const h = customHarnesses({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await h.create({ name: "acme-cli", installScript: "true", runCommand: "acme-cli" });
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 409, "carries the HTTP status");
      assertEqual(err.code, "custom_harness_name_taken", "carries the stable error code");
    }
    assert(threw, "throws on 409");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// JOBS TESTS
// =============================================================================

/** A trial histogram with EVERY status named — zeros included, as the API emits. */
function zeroTrialStatuses(counts: Record<string, number> = {}): Record<string, number> {
  return {
    QUEUED: 0,
    RUNNING: 0,
    SCORING: 0,
    SCORED: 0,
    SCORING_ERROR: 0,
    INFRASTRUCTURE_ERROR: 0,
    INDETERMINATE: 0,
    CANCELLED: 0,
    ...counts,
  };
}

const RUN_SUMMARY = {
  id: "eval-1",
  status: "QUEUED",
  benchmark: "deep-swe@1.1",
  runsPerTask: 1,
  concurrency: 4,
  maxTrialSpendUsd: 25,
  worstCaseSpendUsd: 250,
  sandboxProvider: "daytona",
  spentUsd: 0,
  counts: { agents: 2, tasks: 5 },
  trials: { total: 10, byStatus: zeroTrialStatuses({ QUEUED: 10 }) },
  meanReward: null,
  failure: null,
  sourceJobId: null,
  idempotentReplay: false,
  agents: [{ harness: "codex", model: "gpt-5.5", harnessVersion: null }],
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
};

async function testRunPostsInputContract() {
  console.log("\n--- jobs().run() POSTs the job input contract ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", { status: 202, body: RUN_SUMMARY });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const input = {
      benchmark: "deep-swe@1.1",
      tasks: ["abs-module-cache-flags"],
      agents: [
        { harness: "codex", model: "gpt-5.5" },
        { harness: "claude", model: "sonnet", harnessVersion: "2.1.0" },
      ],
      runsPerTask: 1,
      concurrency: 4,
      maxTrialSpendUsd: 25,
      sandboxProvider: "daytona" as const,
    };
    const job = await e.run(input, { idempotencyKey: "idem-abc" });

    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "POST", "uses POST");
    assertEqual(JSON.parse(call.init?.body as string), input, "body is the job input contract");
    assertEqual(
      JSON.parse(call.init?.body as string).maxTrialSpendUsd,
      25,
      "maxTrialSpendUsd forwarded"
    );
    assertEqual(
      JSON.parse(call.init?.body as string).sandboxProvider,
      "daytona",
      "sandboxProvider forwarded"
    );
    assertEqual(job.sandboxProvider, "daytona", "maps sandboxProvider from summary");
    assertEqual(
      JSON.parse(call.init?.body as string).agents[1].harnessVersion,
      "2.1.0",
      "harnessVersion pin forwarded on the agent"
    );
    assert(
      !("harnessVersion" in JSON.parse(call.init?.body as string).agents[0]),
      "an unpinned agent sends no harnessVersion (resolve-latest)"
    );
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.["Idempotency-Key"], "idem-abc", "Idempotency-Key header sent");
    assertEqual(headers?.["Content-Type"], "application/json", "JSON content type");
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");

    assertEqual(job.id, "eval-1", "maps id");
    assertEqual(job.status, "QUEUED", "maps status");
    assertEqual(job.benchmark, "deep-swe@1.1", "maps benchmark ref");
    // ONE "how many" structure: counts is entity cardinality, trials is the
    // total plus the status histogram.
    assertEqual(job.counts, { agents: 2, tasks: 5 }, "maps counts (entity cardinality only)");
    assertEqual(job.trials.total, 10, "maps the trial total");
    assertEqual(job.trials.byStatus.QUEUED, 10, "maps the status histogram");
    assertEqual(job.idempotentReplay, false, "idempotentReplay is always present, false on a fresh create");

    // Without idempotency key, header is absent
    await e.run(input);
    const headers2 = fetchCalls[fetchCalls.length - 1].init?.headers as Record<string, string>;
    assert(!("Idempotency-Key" in (headers2 || {})), "no Idempotency-Key header by default");

    // Bare benchmark name: forwarded as-is; the server resolves the active
    // READY version and the response echoes "name@version".
    const bare = await e.run({
      benchmark: "deep-swe",
      agents: [{ harness: "codex", model: "gpt-5.5" }],
      maxTrialSpendUsd: 25,
    });
    assertEqual(
      JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string).benchmark,
      "deep-swe",
      "bare benchmark name forwarded unchanged"
    );
    assertEqual(bare.benchmark, "deep-swe@1.1", "response echoes the resolved name@version");
  } finally {
    restoreFetch();
  }
}

async function testRunOmitsAbsentSpendCap() {
  console.log("\n--- jobs().run() omits maxTrialSpendUsd when it is not given ---");
  installMockFetch();
  try {
    // The server's own default ($200 per trial, operator-tunable) applies, and
    // the response echoes the RESOLVED cap plus the worst case it implies.
    setMockResponse("/api/jobs", {
      status: 202,
      body: { ...RUN_SUMMARY, maxTrialSpendUsd: 200, worstCaseSpendUsd: 400 },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.run({
      benchmark: "deep-swe@1.1",
      agents: [{ harness: "codex", model: "gpt-5.5" }],
    });

    const body = JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string);
    // ABSENT, never null: an explicit null would defeat the server-side default
    // the omission is asking for.
    assert(!("maxTrialSpendUsd" in body), "no cap key on the wire when omitted");
    assertEqual(
      body,
      { benchmark: "deep-swe@1.1", agents: [{ harness: "codex", model: "gpt-5.5" }] },
      "body carries only what was given"
    );
    assertEqual(job.maxTrialSpendUsd, 200, "response echoes the RESOLVED per-trial cap");
    assertEqual(
      job.worstCaseSpendUsd,
      400,
      "response states the worst case the cap implies for this job"
    );

    // A stated cap is still forwarded unchanged.
    await e.run({
      benchmark: "deep-swe@1.1",
      agents: [{ harness: "codex", model: "gpt-5.5" }],
      maxTrialSpendUsd: 25,
    });
    assertEqual(
      JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string).maxTrialSpendUsd,
      25,
      "a stated maxTrialSpendUsd is forwarded"
    );
  } finally {
    restoreFetch();
  }
}

async function testRunIdempotentReplay() {
  console.log("\n--- jobs().run() surfaces idempotentReplay ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", {
      status: 200,
      body: { ...RUN_SUMMARY, idempotentReplay: true },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.run(
      { benchmark: "deep-swe@1.1", agents: [{ harness: "codex", model: "gpt-5.5" }], maxTrialSpendUsd: 25 },
      { idempotencyKey: "idem-abc" }
    );
    assertEqual(job.idempotentReplay, true, "idempotentReplay passed through");
  } finally {
    restoreFetch();
  }
}

async function testRunUnknownHarnessVersionIsTypedError() {
  console.log("\n--- jobs().run() surfaces 404 harness_version_not_found ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", {
      status: 404,
      body: {
        error: {
          code: "harness_version_not_found",
          message: 'Harness "codex" has no version "9.9.9".',
        },
      },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.run({
        benchmark: "deep-swe",
        agents: [{ harness: "codex", model: "gpt-5.5", harnessVersion: "9.9.9" }],
        maxTrialSpendUsd: 25,
      });
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 404, "carries the HTTP status");
      assertEqual(err.code, "harness_version_not_found", "carries the stable error code");
    }
    assert(threw, "an unknown harness version is rejected at creation");
  } finally {
    restoreFetch();
  }
}

async function testRunInsufficientCreditsIsTypedError() {
  console.log("\n--- jobs().run() surfaces 402 insufficient_credits ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", {
      status: 402,
      body: {
        error: {
          code: "insufficient_credits",
          message: "Your account is out of credits; add credits before starting a job",
        },
      },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.run({
        benchmark: "deep-swe",
        agents: [{ harness: "codex", model: "gpt-5.5" }],
      });
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 402, "carries the 402 status");
      assertEqual(err.code, "insufficient_credits", "carries the stable error code");
    }
    assert(threw, "an account with no credits is refused at creation");
  } finally {
    restoreFetch();
  }
}

async function testRunNonExactHarnessVersionIsTypedError() {
  console.log("\n--- jobs().run() surfaces 400 invalid_input for a non-exact pin ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", {
      status: 400,
      body: {
        error: {
          code: "invalid_input",
          message: 'harnessVersion "^0.29.0" must be an exact version.',
        },
      },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.run({
        benchmark: "deep-swe",
        // A range cannot hold a comparison still, so it is refused, not resolved.
        agents: [{ harness: "codex", model: "gpt-5.5", harnessVersion: "^0.29.0" }],
        maxTrialSpendUsd: 25,
      });
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 400, "carries the HTTP status");
      assertEqual(err.code, "invalid_input", "a non-exact pin is invalid_input, not not-found");
      assert(err.message.includes("exact version"), "the message names the exact-version rule");
    }
    assert(threw, "a range/tag pin is rejected at creation");
  } finally {
    restoreFetch();
  }
}

async function testGetJobDetail() {
  console.log("\n--- jobs().get() maps the detail shape (public fields only) ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: {
        id: "eval-1",
        status: "RUNNING",
        benchmark: "deep-swe@1.1",
        runsPerTask: 1,
        concurrency: 4,
        maxTrialSpendUsd: 2.5,
        worstCaseSpendUsd: 25,
        sandboxProvider: "modal",
        spentUsd: 3.5,
        agents: [
          { harness: "codex", model: "gpt-5.5", harnessVersion: null },
        ],
        counts: { agents: 1, tasks: 10 },
        trials: { total: 10, byStatus: zeroTrialStatuses({ SCORED: 4, RUNNING: 2, QUEUED: 4 }) },
        meanReward: 0.75,
        failure: null,
        sourceJobId: null,
        idempotentReplay: false,
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:05:00.000Z",
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.get("eval-1");

    assertEqual(job.status, "RUNNING", "maps status");
    assert(
      !("benchmarkVersionState" in (job as unknown as Record<string, unknown>)),
      "no benchmark-lifecycle internals on the job"
    );
    assertEqual(job.meanReward, 0.75, "maps meanReward (SCORED-only mean)");
    assertEqual(job.maxTrialSpendUsd, 2.5, "maps maxTrialSpendUsd");
    assertEqual(job.worstCaseSpendUsd, 25, "maps worstCaseSpendUsd (trials x the cap)");
    assertEqual(job.sandboxProvider, "modal", "maps sandboxProvider");
    assertEqual(job.spentUsd, 3.5, "maps spentUsd");
    assertEqual(job.trials.total, 10, "maps the trial total");
    assertEqual(job.trials.byStatus.SCORED, 4, "maps the status histogram");
    // Every status is named, zeros included, so a UI never hardcodes the enum.
    assertEqual(job.trials.byStatus.CANCELLED, 0, "a status with no trials is 0, not absent");
    assertEqual(Object.keys(job.trials.byStatus).length, 8, "all 8 statuses present");
    assertEqual(
      job.counts,
      { agents: 1, tasks: 10 },
      "detail carries entity cardinality only"
    );
    assertEqual(
      job.agents,
      [{ harness: "codex", model: "gpt-5.5", harnessVersion: null, reasoningEffort: null }],
      "agents is the public agent shape (wire sends nothing internal)"
    );
    const system = job.agents?.[0] as Record<string, unknown>;
    assert(!("id" in system), "internal agent id not exposed");
    assert(!("systemDigest" in system), "systemDigest not exposed");
    assert(!("trialTotal" in (job as unknown as Record<string, unknown>)), "trialTotal is gone");
    // `error` is the FAILURE envelope's key and never appears on a 200 body:
    // `if (body.error) throw` has to stay correct on a healthy read.
    assert(!("error" in (job as unknown as Record<string, unknown>)), "no `error` key on a 200 job");
    assertEqual(job.failure, null, "maps failure (null when the job did not fail)");
  } finally {
    restoreFetch();
  }
}

async function testListJobs() {
  console.log("\n--- jobs().list() builds cursor params and maps the page ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", {
      status: 200,
      body: {
        items: [
          { ...RUN_SUMMARY, trials: { total: 10, byStatus: zeroTrialStatuses({ SCORED: 10 }) } },
          {
            ...RUN_SUMMARY,
            id: "eval-0",
            status: "FAILED",
            failure: { code: "job_execution_failed", message: "dispatch exploded" },
          },
        ],
        nextCursor: "eval-0",
        hasMore: true,
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });

    const page = await e.list();
    let url = fetchCalls[fetchCalls.length - 1].url;
    assert(!url.includes("limit="), "no limit param by default");
    assert(!url.includes("cursor="), "no cursor param by default");
    assertEqual(page.items.length, 2, "returns 2 jobs");
    assertEqual(page.items[0].trials.byStatus.SCORED, 10, "maps the status histogram");
    assertEqual(page.nextCursor, "eval-0", "maps nextCursor");
    assertEqual(page.hasMore, true, "maps hasMore");
    // A list row is the SAME shape as a get(): a dashboard shows WHY a job
    // failed without an N+1 detail call per row.
    assertEqual(
      page.items[1].failure,
      { code: "job_execution_failed", message: "dispatch exploded" },
      "the failure reason rides on the list row"
    );
    assertEqual(page.items[0].agents.length, 1, "agents ride on the list row");

    await e.list({ limit: 100, cursor: "eval-5" });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("limit=100"), "limit forwarded");
    assert(url.includes("cursor=eval-5"), "cursor forwarded");
  } finally {
    restoreFetch();
  }
}

async function testTrials() {
  console.log("\n--- jobs().trials() maps runs (cursor-paged) ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: {
        items: [
          {
            id: "run-1",
            taskKey: "abs-module-cache-flags",
            agent: { harness: "codex", model: "gpt-5.5", harnessVersion: null },
            runNumber: 1,
            status: "SCORED",
            reward: 1,
            metrics: { f2p: 1, p2p: 1 },
            failurePhase: null,
            failureDetail: null,
            phaseTimingsMs: { agentMs: 203000, verifyMs: 31000 },
            modelUsage: { spentUsd: 0.93, spendSource: "measured" },
            sandboxProvider: "daytona",
            verifierMode: "separate",
            resolvedHarnessVersion: "codex-cli 0.145.0",
            sessionRef: "sess-9",
            createdAt: "2026-07-22T00:00:00.000Z",
            updatedAt: "2026-07-22T00:04:00.000Z",
          },
          {
            id: "run-2",
            taskKey: "abs-module-cache-flags",
            agent: { harness: "codex", model: "gpt-5.5", harnessVersion: null },
            runNumber: 2,
            status: "INFRASTRUCTURE_ERROR",
            reward: null,
            metrics: null,
            failurePhase: "verifier_boot",
            failureDetail: "sandbox failed to boot",
            phaseTimingsMs: { agentMs: 100 },
            modelUsage: { spentUsd: 0.5, spendSource: "assumed_cap" },
            sandboxProvider: "daytona",
            verifierMode: null,
            resolvedHarnessVersion: null,
            sessionRef: null,
            createdAt: "2026-07-22T00:00:00.000Z",
            updatedAt: "2026-07-22T00:04:00.000Z",
          },
        ],
        nextCursor: "run-2",
        hasMore: true,
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const page = await e.trials("eval-1", { limit: 2, cursor: "run-0" });

    let url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("/api/jobs/eval-1/trials"), "targets trials route");
    assert(url.includes("limit=2"), "limit forwarded");
    assert(url.includes("cursor=run-0"), "cursor forwarded");

    assertEqual(page.nextCursor, "run-2", "maps nextCursor");
    assertEqual(page.items[0].reward, 1, "maps reward");
    assertEqual(page.items[0].metrics, { f2p: 1, p2p: 1 }, "maps named metrics map");
    assertEqual(page.items[0].modelUsage?.spentUsd, 0.93, "maps modelUsage.spentUsd");
    assertEqual(page.items[0].sandboxProvider, "daytona", "first-class sandboxProvider on list rows");
    assertEqual(page.items[0].verifierMode, "separate", "first-class verifierMode on list rows");
    assertEqual(page.items[0].resolvedHarnessVersion, "codex-cli 0.145.0", "first-class resolvedHarnessVersion on list rows");
    assertEqual(page.items[0].sessionRef, "sess-9", "maps sessionRef");
    assertEqual(page.items[1].status, "INFRASTRUCTURE_ERROR", "maps failure status");
    assertEqual(page.items[1].failurePhase, "verifier_boot", "maps failurePhase");
    assertEqual(page.items[1].reward, null, "unscored trial keeps null reward (never a fake zero)");

    // Status filter: comma-joined ?status= for the failures behind a rerun decision
    await e.trials("eval-1", { status: ["INFRASTRUCTURE_ERROR", "SCORING_ERROR"] });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(
      decodeURIComponent(url).includes("status=INFRASTRUCTURE_ERROR,SCORING_ERROR"),
      "status filter forwarded comma-joined"
    );
  } finally {
    restoreFetch();
  }
}

async function testCancel() {
  console.log("\n--- jobs().cancel() POSTs and returns the summary ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/cancel", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "CANCELLING" },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.cancel("eval-1");
    assertEqual(fetchCalls[0].init?.method, "POST", "uses POST");
    assertEqual(job.status, "CANCELLING", "maps cancelling status");
  } finally {
    restoreFetch();
  }
}

async function testRerunFailed() {
  console.log("\n--- jobs().rerunFailed() creates the linked job ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/rerun-failed", {
      status: 202,
      body: { ...RUN_SUMMARY, id: "eval-2", sourceJobId: "eval-1" },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.rerunFailed("eval-1", { idempotencyKey: "idem-rr" });

    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "POST", "uses POST");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.["Idempotency-Key"], "idem-rr", "Idempotency-Key header sent");
    assertEqual(job.id, "eval-2", "returns the NEW job");
    assertEqual(job.sourceJobId, "eval-1", "links the source job");
  } finally {
    restoreFetch();
  }
}

async function testRerunFailedConflictError() {
  console.log("\n--- rerunFailed() surfaces 409 for non-terminal jobs ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/rerun-failed", {
      status: 409,
      body: { error: { code: "job_not_terminal", message: "Job is RUNNING; rerun-failed requires a terminal job" } },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.rerunFailed("eval-1");
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 409, "carries the HTTP status");
      assertEqual(err.code, "job_not_terminal", "carries the stable error code");
      assert(err.message.includes("terminal"), "message is the server's product sentence");
    }
    assert(threw, "throws on 409");
  } finally {
    restoreFetch();
  }
}

const REGRADE_RESULT = {
  id: "rr-1",
  sourceTrialId: "run-1",
  taskKey: "demo-task",
  status: "SCORED",
  reward: 0.5,
  metrics: { f2p: 0.5 },
  sourceReward: 1,
  sourceStatus: "SCORED",
  rewardDelta: -0.5,
  verifierMode: "separate",
  verifierDigest: "abcd",
  verifierSandboxId: "sbx-1",
  failurePhase: null,
  failureDetail: null,
  phaseTimingsMs: { verifyMs: 1200 },
  createdAt: "2026-07-24T00:00:00Z",
  settledAt: "2026-07-24T00:05:00Z",
};

const REGRADE_JOB = {
  id: "job-1",
  sourceJobId: "eval-1",
  status: "COMPLETED",
  sandboxProvider: "e2b",
  filter: null,
  createdAt: "2026-07-24T00:00:00Z",
  updatedAt: "2026-07-24T00:05:00Z",
  // ONE key named for the collection: the whole-job tally plus this page of
  // results, with every regrade status named.
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
    items: [REGRADE_RESULT],
    nextCursor: null,
    hasMore: false,
  },
};

/** The same regrade job with a different whole-job result total. */
function regradeJobWithTotal(total: number) {
  return { ...REGRADE_JOB, results: { ...REGRADE_JOB.results, total } };
}

async function testRegradeTrial() {
  console.log("\n--- jobs().regradeTrial() re-runs one run's verifier ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/trials/run-1/regrade", {
      status: 202,
      body: regradeJobWithTotal(1),
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.regradeTrial("eval-1", "run-1");
    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "POST", "uses POST");
    assert(call.url.endsWith("/trials/run-1/regrade"), "hits the per-trial regrade route");
    assertEqual(job.id, "job-1", "returns the regrade job");
    assertEqual(job.sourceJobId, "eval-1", "links the source job");
    assertEqual(job.results.total, 1, "one result for a per-trial regrade");
    assertEqual(job.results.items.length, 1, "the page carries the result");
    assert(!("counts" in (job as unknown as Record<string, unknown>)), "no separate counts object");
  } finally {
    restoreFetch();
  }
}

async function testRegradeJob() {
  console.log("\n--- jobs().regrade() regrades a whole job with a filter ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/regrade", {
      status: 202,
      body: regradeJobWithTotal(2),
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.regrade("eval-1", { status: ["SCORED"], taskKey: "demo-task" });
    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "POST", "uses POST");
    const sentBody = JSON.parse(call.init?.body as string);
    assertEqual(sentBody, { status: ["SCORED"], taskKey: "demo-task" }, "sends the status+taskKey filter body");
    assertEqual(job.results.total, 2, "one result per eligible trial");
  } finally {
    restoreFetch();
  }
}

async function testRegradeJobRead() {
  console.log("\n--- jobs().getRegrade() reads results with deltas + lineage ---");
  installMockFetch();
  try {
    // The path is unchanged — only the PARAM's meaning ever was wrong — so the
    // rename cannot break a client that already had a regrade id in hand.
    setMockResponse("/api/regrades/regrade-1", { status: 200, body: REGRADE_JOB });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.getRegrade("regrade-1");
    assertEqual(job.status, "COMPLETED", "maps the derived job status");
    assertEqual(job.results.items.length, 1, "carries the per-trial results");
    assertEqual(job.results.nextCursor, null, "a complete page says so rather than echoing a position");
    assertEqual(job.results.byStatus.INDETERMINATE, 0, "every regrade status named, zeros included");
    const result = job.results.items[0];
    assertEqual(result.taskKey, "demo-task", "maps the source task key");
    assertEqual(result.sourceReward, 1, "carries the immutable source reward");
    assertEqual(result.rewardDelta, -0.5, "carries the reward delta");
    assertEqual(result.verifierDigest, "abcd", "carries the verifier version digest");
    assertEqual(result.verifierMode, "separate", "regrade is always separate-mode");
  } finally {
    restoreFetch();
  }
}

async function testRegradeIneligibleError() {
  console.log("\n--- regradeTrial() surfaces 409 regrade_source_ineligible ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/trials/run-1/regrade", {
      status: 409,
      body: {
        error: {
          code: "regrade_source_ineligible",
          message: "Run used a shared-mode verifier; there is nothing faithful to re-run.",
        },
      },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.regradeTrial("eval-1", "run-1");
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 409, "carries the HTTP status");
      assertEqual(err.code, "regrade_source_ineligible", "carries the stable error code");
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
    const archive = gzipSync(Buffer.from(JSON.stringify({ job: { id: "eval-1" } })));
    setMockResponse("/api/jobs/eval-1/export", {
      status: 200,
      body: null,
      bodyBytes: archive,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="job-eval-1-export.json.gz"',
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
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
    const archive = gzipSync(Buffer.from(JSON.stringify({ job: { id: "eval-1" } })));
    setMockResponse("/api/jobs/eval-1/export", {
      status: 200,
      body: null,
      bodyBytes: archive,
      headers: {
        "Content-Disposition": 'attachment; filename="job-eval-1-export.json.gz"',
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const filePath = await e.export("eval-1", { to: tmpDir });

    assert(filePath.endsWith("job-eval-1-export.json.gz"), "filename from Content-Disposition");
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
    setMockResponse("/api/jobs/eval-1/export", {
      status: 200,
      body: null,
      bodyBytes: archive,
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
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
      Buffer.from(JSON.stringify({ format: "evolve.job.harbor-bundle" }))
    );
    setMockResponse("/api/jobs/eval-1/export", {
      status: 200,
      body: null,
      bodyBytes: bundle,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="job-eval-1.harbor.json.gz"',
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const buf = await e.export("eval-1", { format: "harbor" });

    const harborCall = fetchCalls[fetchCalls.length - 1];
    assert(
      harborCall.url.includes("/api/jobs/eval-1/export?format=harbor"),
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
  console.log("\n--- export() surfaces 409 for non-terminal jobs ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/export", {
      status: 409,
      body: { error: { code: "job_not_terminal", message: "Job is RUNNING; export requires a terminal job" } },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.export("eval-1");
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 409, "carries the HTTP status");
      assertEqual(err.code, "job_not_terminal", "carries the stable error code");
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
      body: { ...RUN_SUMMARY, status: "COMPLETED" },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const events: JobEvent[] = [];
    const finalJob = await e.watch("eval-1", { onEvent: (ev) => events.push(ev) });

    assertEqual(events.length, 3, "3 events delivered (heartbeat comment skipped)");
    assertEqual(events[0], { seq: 0, type: "job.created", data: { trialCount: 2 } }, "maps first event");
    assertEqual(events[2].type, "job.completed", "terminal event delivered");
    assertEqual(finalJob.status, "COMPLETED", "resolves with the final job");

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
                  { seq: 0, type: "job.created", data: {} },
                  { seq: 1, type: "trial.running", data: { trialId: "run-1" } },
                ])
              : sseText([{ seq: 2, type: "job.completed", data: {} }]),
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

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const events: JobEvent[] = [];
    const finalJob = await e.watch("eval-1", {
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
    assertEqual(finalJob.status, "COMPLETED", "resolves with the final job");
  } finally {
    restoreFetch();
  }
}

async function testWatchFallsBackToStatusOnQuietClose() {
  console.log("\n--- watch() resolves via get() when the stream closes without a terminal event ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([{ seq: 0, type: "job.created", data: {} }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "CANCELLED" },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const finalJob = await e.watch("eval-1", { reconnectDelayMs: 1 });

    assertEqual(finalJob.status, "CANCELLED", "terminal status ends the watch");
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
          streamBody: sseText([{ seq: 0, type: "job.completed", data: {} }]),
        });
      }
      return buildMockResponse({ status: 200, body: { ...RUN_SUMMARY, status: "COMPLETED" } });
    };

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const finalJob = await e.watch("eval-1", { reconnectDelayMs: 1 });

    assertEqual(eventsCalls, 2, "retried after the 503");
    assertEqual(finalJob.status, "COMPLETED", "resolves after the retry");
  } finally {
    restoreFetch();
  }
}

async function testWatchThrowsOnNonRetryableError() {
  console.log("\n--- watch() throws immediately on 404 ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-missing/events", {
      status: 404,
      body: { error: { code: "job_not_found", message: "Job not found: eval-missing" } },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.watch("eval-missing");
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 404, "carries the HTTP status");
      assertEqual(err.code, "job_not_found", "carries the stable error code");
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
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([{ seq: 0, type: "job.created", data: {} }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "RUNNING" },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
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

async function testTrialDetail() {
  console.log("\n--- jobs().trial(id, trialId) maps the full run detail ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/trials/run-1", {
      status: 200,
      body: {
        id: "run-1",
        jobId: "eval-1",
        taskKey: "abs-module-cache-flags",
        agent: { harness: "codex", model: "gpt-5.5", harnessVersion: null },
        runNumber: 1,
        status: "SCORED",
        reward: 1,
        metrics: { f2p: 1 },
        failurePhase: null,
        failureDetail: "x".repeat(5000), // detail route: untruncated
        phaseTimingsMs: { agentMs: 203000, verifyMs: 31000 },
        modelUsage: { spentUsd: 0.93, spendSource: "measured", maxTrialSpendUsd: 2.5 },
        sandboxProvider: "e2b",
        verifierMode: "shared",
        resolvedHarnessVersion: "codex-cli 0.145.0",
        sessionRef: "sess-9",
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:04:00.000Z",
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const run = await e.trial("eval-1", "run-1");

    assert(
      fetchCalls[0].url.includes("/api/jobs/eval-1/trials/run-1"),
      "targets the trial detail route"
    );
    assertEqual(run.id, "run-1", "maps id");
    assertEqual(run.jobId, "eval-1", "maps jobId");
    assertEqual(run.resolvedHarnessVersion, "codex-cli 0.145.0", "maps resolvedHarnessVersion");
    assertEqual(run.sandboxProvider, "e2b", "maps sandboxProvider");
    assertEqual(run.verifierMode, "shared", "maps verifierMode");
    assertEqual(run.modelUsage?.spentUsd, 0.93, "one money vocabulary: actuals are spentUsd");
    assertEqual(
      run.modelUsage?.maxTrialSpendUsd,
      2.5,
      "one money vocabulary: the cap is maxTrialSpendUsd"
    );
    assertEqual(run.sessionRef, "sess-9", "maps sessionRef");
    assertEqual(run.failureDetail?.length, 5000, "failureDetail untruncated on the detail route");
    assertEqual(run.reward, 1, "maps reward");
    assertEqual(
      run.agent,
      { harness: "codex", model: "gpt-5.5", harnessVersion: null, reasoningEffort: null },
      "agent reduced to the public agent shape"
    );
  } finally {
    restoreFetch();
  }
}

async function testTrialTracePage() {
  console.log("\n--- jobs().trialTrace() forwards after/limit and maps the page ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/trials/run-1/trace", {
      status: 200,
      body: {
        items: [
          { seq: 3, type: "agent.message", data: { text: "patching" } },
          { seq: 4, type: "phase.completed", data: { phase: "agent" } },
        ],
        nextCursor: "4",
        hasMore: true,
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const page = await e.trialTrace("eval-1", "run-1", { cursor: "2", limit: 2 });

    const url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("/trials/run-1/trace"), "targets the trace route");
    assert(url.includes("cursor=2"), "cursor forwarded");
    assert(url.includes("limit=2"), "limit forwarded");

    assertEqual(page.items.length, 2, "maps 2 events");
    assertEqual(
      page.items[0],
      { seq: 3, type: "agent.message", data: { text: "patching" } },
      "maps seq/type/data"
    );
    // nextCursor means the same here as everywhere: pass it back for the next
    // page, and null means CAUGHT UP — never an echo of where you already are.
    assertEqual(page.nextCursor, "4", "maps nextCursor");
    assertEqual(page.hasMore, true, "maps hasMore");

    // No options: no params at all
    await e.trialTrace("eval-1", "run-1");
    const bare = fetchCalls[fetchCalls.length - 1].url;
    assert(!bare.includes("cursor=") && !bare.includes("limit="), "no params by default");
  } finally {
    restoreFetch();
  }
}

async function testTrialTraceEventsIterator() {
  console.log("\n--- trialTraceEvents() drains the trace page by page ---");
  installMockFetch();
  try {
    const traceCalls: (string | null)[] = [];
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      const cursor = new URL(urlStr).searchParams.get("cursor");
      traceCalls.push(cursor);
      const pages: Record<string, unknown> = {
        // no cursor: first page; then resume from nextCursor.
        // nextCursor null MEANS CAUGHT UP — never an echo of the position, so
        // the drain needs no extra empty-page request to learn it is done.
        "": {
          items: [{ seq: 1, type: "a", data: {} }, { seq: 2, type: "b", data: {} }],
          nextCursor: "2",
          hasMore: true,
        },
        "2": { items: [{ seq: 3, type: "c", data: {} }], nextCursor: null, hasMore: false },
      };
      return buildMockResponse({ status: 200, body: pages[cursor ?? ""] });
    };

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const seqs: number[] = [];
    for await (const event of e.trialTraceEvents("eval-1", "run-1")) {
      seqs.push(event.seq);
    }

    assertEqual(seqs, [1, 2, 3], "yields every event exactly once, in seq order");
    assertEqual(traceCalls, [null, "2"], "pages resume from nextCursor");

    // An explicit page limit changes nothing about when the drain ends: the
    // null cursor is the signal, not a short page.
    fetchCalls.length = 0;
    traceCalls.length = 0;
    const seqsLimited: number[] = [];
    for await (const event of e.trialTraceEvents("eval-1", "run-1", { limit: 2 })) {
      seqsLimited.push(event.seq);
    }
    assertEqual(seqsLimited, [1, 2, 3], "limited drain still yields every event");
    assertEqual(traceCalls, [null, "2"], "the null cursor ends the drain");
  } finally {
    restoreFetch();
  }
}

async function testCompare() {
  console.log("\n--- jobs().compare() maps aggregates + task matrix ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/compare", {
      status: 200,
      body: {
        jobs: [
          {
            id: "eval-1",
            benchmark: "deep-swe@1.1",
            status: "COMPLETED",
            meanReward: 0.5,
            coverage: { scored: 4, total: 5 },
            spentUsd: 12.5,
            agents: [
              { harness: "codex", model: "gpt-5.5", harnessVersion: null },
            ],
            createdAt: "2026-07-22T00:00:00.000Z",
          },
          {
            id: "eval-2",
            benchmark: "deep-swe@1.1",
            status: "COMPLETED",
            meanReward: 0, // zero is a reward, not a missing value
            coverage: { scored: 5, total: 5 },
            spentUsd: 9.1,
            agents: [
              { harness: "claude", model: "sonnet", harnessVersion: "2.1.0" },
            ],
            createdAt: "2026-07-22T01:00:00.000Z",
          },
        ],
        taskMatrix: [
          {
            taskKey: "abs-module-cache-flags",
            disagreement: true,
            cells: [
              { jobId: "eval-1", status: "SCORED", meanReward: 1, coverage: { scored: 1, total: 1 } },
              { jobId: "eval-2", status: "MISSING", meanReward: null, coverage: { scored: 0, total: 0 } },
            ],
          },
          {
            taskKey: "zlib-stream-reset",
            disagreement: false,
            cells: [
              { jobId: "eval-1", status: "SCORED", meanReward: 0, coverage: { scored: 1, total: 1 } },
              { jobId: "eval-2", status: "SCORED", meanReward: 0, coverage: { scored: 1, total: 1 } },
            ],
          },
        ],
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const comparison = await e.compare(["eval-1", "eval-2"]);

    const url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("/api/jobs/compare?ids=eval-1,eval-2"), "ids joined comma-separated");

    assertEqual(comparison.jobs.length, 2, "2 aggregates, in the caller's order");
    assertEqual(comparison.jobs[0].id, "eval-1", "maps aggregate id");
    assertEqual(comparison.jobs[0].meanReward, 0.5, "maps meanReward");
    assertEqual(comparison.jobs[0].coverage, { scored: 4, total: 5 }, "maps coverage");
    assertEqual(comparison.jobs[1].meanReward, 0, "zero meanReward preserved (never nulled)");
    assertEqual(
      comparison.jobs[0].agents,
      [{ harness: "codex", model: "gpt-5.5", harnessVersion: null, reasoningEffort: null }],
      "agents is the public agent shape (wire sends nothing internal)"
    );
    const system = comparison.jobs[0].agents[0] as Record<string, unknown>;
    assert(!("id" in system), "internal agent id not exposed");

    assertEqual(comparison.taskMatrix.length, 2, "maps matrix rows");
    assertEqual(comparison.taskMatrix[0].disagreement, true, "maps disagreement flag");
    assertEqual(
      comparison.taskMatrix[0].cells[1],
      { jobId: "eval-2", status: "MISSING", meanReward: null, coverage: { scored: 0, total: 0 } },
      "MISSING cell preserved"
    );
    assertEqual(comparison.taskMatrix[1].cells[0].meanReward, 0, "zero cell meanReward preserved");
  } finally {
    restoreFetch();
  }
}

async function testCompareBadIdsError() {
  console.log("\n--- compare() surfaces the server's 400 for bad id lists ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/compare", {
      status: 400,
      body: { error: { code: "invalid_ids", message: "ids must list between 2 and 5 distinct job ids (comma-separated)" } },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.compare(["eval-1"]);
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.code, "invalid_ids", "carries the stable error code");
      assert(err.message.includes("between 2 and 5"), "message is the server's product sentence");
    }
    assert(threw, "throws on 400");
  } finally {
    restoreFetch();
  }
}

async function testApiErrorHandling() {
  console.log("\n--- API errors are typed: EvolveApiError with status/code/message ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks", {
      status: 401,
      body: { error: { code: "invalid_api_key", message: "Invalid API key" } },
    });
    const b = benchmarks({ apiKey: "bad-key", baseUrl: BASE });
    let threw = false;
    try {
      await b.list();
    } catch (e: any) {
      threw = true;
      assert(e instanceof EvolveApiError, "throws EvolveApiError");
      assertEqual(e.status, 401, "carries the HTTP status");
      assertEqual(e.code, "invalid_api_key", "carries the stable error code");
      assertEqual(e.message, "Invalid API key", "message is the clean product sentence — no JSON, no status prefix");
    }
    assert(threw, "throws on 401");

    // Unparseable body: still an EvolveApiError, with the raw text as message.
    installMockFetch();
    setMockResponse("/api/benchmarks", { status: 502, body: null, streamBody: "Bad Gateway" });
    let threwRaw = false;
    try {
      await b.list();
    } catch (e: any) {
      threwRaw = true;
      assert(e instanceof EvolveApiError, "unparseable body still throws EvolveApiError");
      assertEqual(e.code, "unknown_error", "unparseable body maps to unknown_error");
    }
    assert(threwRaw, "throws on unparseable error body");
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
        title: "DeepSWE",
        description: "SWE tasks",
        activeVersion: { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
        versions: [
          { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
          { version: "1.0", state: "ARCHIVED", createdAt: "2026-07-01T00:00:00.000Z", taskCount: 100 },
        ],
        selectedVersion: { version: "1.1", state: "READY", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 113 },
        tasks: {
          items: [
            {
              taskKey: "abs-module-cache-flags",
              agentTimeoutSec: 5400,
              verifierTimeoutSec: 1800,
              providers: { e2b: { ok: true }, daytona: { ok: true }, modal: { ok: true } },
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    });

    const catalog = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const active = await catalog.getActive("deep-swe");

    const url = fetchCalls[fetchCalls.length - 1].url;
    assert(!url.includes("version="), "getActive resolves the bare name (active version's tasks)");

    assertEqual(active.version, "1.1", "version is the active version string (non-optional)");
    assertEqual(active.activeVersion.state, "READY", "activeVersion carries the full version object");
    assertEqual(active.tasks.items.length, 1, "tasks is populated (non-optional)");
    assertEqual(active.tasks.items[0].taskKey, "abs-module-cache-flags", "maps public task fields");
    assertEqual(active.versions.length, 2, "carries all versions");
    assertEqual(active.tasks.items[0].providers, { e2b: { ok: true }, daytona: { ok: true }, modal: { ok: true } }, "tasks carry provider verdicts");
    assert(!("selectedVersion" in active), "ActiveBenchmark has no selectedVersion (it IS the active one)");
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
        title: null,
        description: null,
        activeVersion: null,
        versions: [
          { version: "0.1", state: "DRAFT", createdAt: "2026-07-21T00:00:00.000Z", taskCount: 0 },
        ],
        selectedVersion: null,
        tasks: [],
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    });

    const catalog = benchmarks({ apiKey: "test-key", baseUrl: BASE });
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
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamBody:
        sseText([
          { seq: 0, type: "job.created", data: { trialCount: 2 } },
          { seq: 1, type: "trial.settled", data: { trialId: "run-1", status: "SCORED" } },
        ]) +
        sseText([{ seq: 2, type: "job.completed", data: { scored: 2 } }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "COMPLETED" },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const events: JobEvent[] = [];
    for await (const event of e.watch("eval-1")) {
      events.push(event);
    }
    assertEqual(events.map((ev) => ev.seq), [0, 1, 2], "iterator yields every event in seq order");
    assertEqual(events[2].type, "job.completed", "iterator ends on the terminal event");
  } finally {
    restoreFetch();
  }
}

async function testWatchIteratorEarlyBreak() {
  console.log("\n--- watch() iterator stops cleanly on an early break ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([
        { seq: 0, type: "trial.settled", data: { trialId: "run-1" } },
        { seq: 1, type: "trial.settled", data: { trialId: "run-2" } },
        { seq: 2, type: "job.completed", data: {} },
      ]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "COMPLETED" },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
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
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamBody: sseText([{ seq: 0, type: "job.created", data: {} }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { ...RUN_SUMMARY, status: "RUNNING" },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
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
  console.log("\n--- jobs().list() walks cursor pages when iterated ---");
  installMockFetch();
  try {
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      const cursor = new URL(urlStr).searchParams.get("cursor");
      const pages: Record<string, unknown> = {
        "": {
          items: [
            { ...RUN_SUMMARY, id: "eval-2" },
            { ...RUN_SUMMARY, id: "eval-1" },
          ],
          nextCursor: "eval-1",
        },
        "eval-1": {
          items: [{ ...RUN_SUMMARY, id: "eval-0" }],
          nextCursor: null,
        },
      };
      return buildMockResponse({ status: 200, body: pages[cursor ?? ""] });
    };

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });

    // Iterator form: walks every job across both pages
    const ids: string[] = [];
    for await (const job of e.list()) ids.push(job.id);
    assertEqual(ids, ["eval-2", "eval-1", "eval-0"], "iterates every row across cursor pages");
    const cursors = fetchCalls.map((c) => new URL(c.url).searchParams.get("cursor"));
    assertEqual(cursors, [null, "eval-1"], "second page fetched with the first page's nextCursor");

    // Page form still returns a single page for the given options
    fetchCalls.length = 0;
    const page = await e.list({ limit: 2 });
    assertEqual(page.items.length, 2, "await returns a single page");
    assertEqual(page.nextCursor, "eval-1", "single page carries nextCursor");
    assertEqual(fetchCalls.length, 1, "page form makes exactly one request");
    assert(fetchCalls[0].url.includes("limit=2"), "page form forwards the limit");
  } finally {
    restoreFetch();
  }
}

async function testTrialsAutoPagination() {
  console.log("\n--- jobs().trials() walks cursor pages when iterated ---");
  installMockFetch();
  try {
    const makeRun = (id: string, runNumber: number) => ({
      id,
      taskKey: "abs-module-cache-flags",
      agent: { harness: "codex", model: "gpt-5.5", harnessVersion: null },
      runNumber,
      status: "SCORED",
      reward: 1,
      metrics: null,
      failurePhase: null,
      failureDetail: null,
      phaseTimingsMs: null,
      modelUsage: null,
      sandboxProvider: null,
      verifierMode: null,
      resolvedHarnessVersion: null,
      sessionRef: null,
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      const cursor = new URL(urlStr).searchParams.get("cursor");
      const pages: Record<string, unknown> = {
        "": {
          items: [makeRun("run-1", 1), makeRun("run-2", 2)],
          nextCursor: "run-2",
          hasMore: true,
        },
        "run-2": { items: [makeRun("run-3", 3)], nextCursor: null, hasMore: false },
      };
      return buildMockResponse({ status: 200, body: pages[cursor ?? ""] });
    };

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });

    const runIds: string[] = [];
    for await (const run of e.trials("eval-1")) runIds.push(run.id);
    assertEqual(runIds, ["run-1", "run-2", "run-3"], "iterates every trial across cursor pages");

    // Page form still returns a single page
    fetchCalls.length = 0;
    const page = await e.trials("eval-1", { limit: 2 });
    assertEqual(page.items.length, 2, "await returns a single page");
    assertEqual(page.nextCursor, "run-2", "single page carries nextCursor");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// RUN
// =============================================================================

async function testRootExportsHostedTypes() {
  console.log("\n--- package root re-exports the documented hosted types ---");

  // Compile-time: the type import at the top of this file fails if the root
  // export block drops EvalSandboxProvider. Runtime sanity on its shape:
  const provider: RootEvalSandboxProvider = "modal";
  assertEqual(provider, "modal", "EvalSandboxProvider importable from package root");

  // Source: the hosted export block in src/index.ts names the documented types
  const rootSrc = await readFile(new URL("../../src/index.ts", import.meta.url), "utf-8");
  for (const t of ["EvalSandboxProvider", "BenchmarkImportFailure", "JobInput", "JobStatus", "CustomHarness", "CustomHarnessInput"]) {
    assert(new RegExp(`type ${t},`).test(rootSrc), `src/index.ts exports type ${t}`);
  }

  // Built dist: the declaration file users consume must carry the type
  const distDts = await readFile(new URL("../../dist/index.d.ts", import.meta.url), "utf-8");
  assert(distDts.includes("EvalSandboxProvider"), "dist/index.d.ts declares EvalSandboxProvider");
}


// =============================================================================
// benchmarks().downloadPackage() — the OWNER-ONLY corpus retrieval
// =============================================================================

async function testDownloadPackageBuffer() {
  console.log("\n--- downloadPackage() returns the corpus tarball as a Buffer ---");
  installMockFetch();
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/benchmarks/imports/ver-1/package", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="acme@1.1-corpus.tar.gz"',
        "x-package-sha256": createHash("sha256").update(pkg).digest("hex"),
      },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const buf = await b.downloadPackage("ver-1");

    assert(Buffer.isBuffer(buf), "returns a Buffer");
    assertEqual(buf.equals(pkg), true, "buffer bytes match the stored package");
    assert(
      fetchCalls[0].url.includes("/api/benchmarks/imports/ver-1/package"),
      "hits the package route on the import id",
    );
  } finally {
    restoreFetch();
  }
}

async function testDownloadPackageToFile() {
  console.log("\n--- downloadPackage({ to }) saves under the server-chosen filename ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-package-${Date.now()}`);
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/benchmarks/imports/ver-1/package", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: {
        "Content-Disposition": 'attachment; filename="acme@1.1-corpus.tar.gz"',
        "x-package-sha256": createHash("sha256").update(pkg).digest("hex"),
      },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const filePath = await b.downloadPackage("ver-1", { to: tmpDir });

    assert(filePath.endsWith("acme@1.1-corpus.tar.gz"), "filename from Content-Disposition");
    const written = await readFile(filePath);
    assertEqual(written.equals(pkg), true, "file bytes match the stored package");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testDownloadPackageStream() {
  console.log("\n--- downloadPackage({ stream: true }) returns the raw stream ---");
  installMockFetch();
  try {
    const pkg = gzipSync(Buffer.from("stream-the-corpus"));
    setMockResponse("/api/benchmarks/imports/ver-1/package", {
      status: 200,
      body: null,
      bodyBytes: pkg,
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const stream = await b.downloadPackage("ver-1", { stream: true });

    assert(typeof (stream as ReadableStream).getReader === "function", "returns a ReadableStream");
    const chunks: Buffer[] = [];
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    assertEqual(Buffer.concat(chunks).equals(pkg), true, "stream bytes match the package");
  } finally {
    restoreFetch();
  }
}

async function testDownloadPackageDigestMismatch() {
  console.log("\n--- downloadPackage() REFUSES bytes that fail the stated digest ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-package-bad-${Date.now()}`);
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/benchmarks/imports/ver-bad/package", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: {
        "Content-Disposition": 'attachment; filename="acme@1.1-corpus.tar.gz"',
        "x-package-sha256": "f".repeat(64), // not the bytes above
      },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });

    let bufferThrew = false;
    try {
      await b.downloadPackage("ver-bad");
    } catch (error) {
      bufferThrew = error instanceof EvolveDigestMismatchError;
    }
    assert(bufferThrew, "the in-memory shape throws EvolveDigestMismatchError");

    let fileThrew = false;
    try {
      await b.downloadPackage("ver-bad", { to: tmpDir });
    } catch (error) {
      fileThrew = error instanceof EvolveDigestMismatchError;
    }
    assert(fileThrew, "the to-disk shape throws too");
    // A file that does not match its digest looks like the corpus and is not,
    // so it must not survive the failure.
    const leftBehind = await readFile(join(tmpDir, "acme@1.1-corpus.tar.gz")).catch(() => null);
    assertEqual(leftBehind, null, "the mismatched file is removed, not left on disk");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testDownloadPackageTruncated() {
  console.log("\n--- downloadPackage() REFUSES a body shorter than Content-Length ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-package-short-${Date.now()}`);
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/benchmarks/imports/ver-short/package", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: {
        "Content-Disposition": 'attachment; filename="acme@1.1-corpus.tar.gz"',
        // The server promised more than it sent: a socket cut mid-body is not
        // an error to fetch, so without this check a partial read returned as
        // SUCCESS.
        "Content-Length": String(pkg.length + 1000),
        "x-package-sha256": createHash("sha256").update(pkg).digest("hex"),
      },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });

    let bufferThrew = false;
    try {
      await b.downloadPackage("ver-short");
    } catch (error) {
      bufferThrew = error instanceof EvolveIncompleteDownloadError;
    }
    assert(bufferThrew, "the in-memory shape throws EvolveIncompleteDownloadError");

    let fileThrew = false;
    try {
      await b.downloadPackage("ver-short", { to: tmpDir });
    } catch (error) {
      fileThrew = error instanceof EvolveIncompleteDownloadError;
    }
    assert(fileThrew, "the to-disk shape throws too");

    const left = await readdir(tmpDir).catch(() => [] as string[]);
    // Neither the final path nor the .part temp survives a failed transfer.
    assertEqual(left, [], "no file and no partial left behind");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testDownloadPackageFilenameTraversal() {
  console.log("\n--- downloadPackage({ to }) refuses a traversing Content-Disposition ---");
  installMockFetch();
  const parent = join(tmpdir(), `hosted-package-esc-${Date.now()}`);
  const tmpDir = join(parent, "inner");
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/benchmarks/imports/ver-esc/package", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: {
        // The filename interpolates a user-supplied version label, so this is
        // attacker-influenced, not merely server-supplied.
        "Content-Disposition": 'attachment; filename="../../escaped.tar.gz"',
        "Content-Length": String(pkg.length),
        "x-package-sha256": createHash("sha256").update(pkg).digest("hex"),
      },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    const filePath = await b.downloadPackage("ver-esc", { to: tmpDir });

    assert(filePath.startsWith(tmpDir), "the file stays inside --to");
    assert(!filePath.includes(".."), "no traversal survives into the path");
    // basename() would still yield "escaped.tar.gz"; the fallback fires only
    // for names that are empty or dot-entries. Either way it cannot escape.
    const escaped = await readFile(join(parent, "escaped.tar.gz")).catch(() => null);
    assertEqual(escaped, null, "nothing was written outside the chosen directory");
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testDownloadPackageNotRetained() {
  console.log("\n--- downloadPackage() surfaces package_not_retained as a typed code ---");
  installMockFetch();
  try {
    setMockResponse("/api/benchmarks/imports/old-ver/package", {
      status: 404,
      body: {
        error: {
          code: "package_not_retained",
          message: "No original package is stored for import old-ver.",
        },
      },
    });

    const b = benchmarks({ apiKey: "test-key", baseUrl: BASE });
    let code: string | undefined;
    try {
      await b.downloadPackage("old-ver");
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    // Distinct from import_not_found so a client can say WHY rather than guess.
    assertEqual(code, "package_not_retained", "typed code reaches the caller");
    assert(isHostedErrorCode("package_not_retained"), "code is in the closed vocabulary");
  } finally {
    restoreFetch();
  }
}

async function main() {
  console.log("Hosted Evals Client Unit Tests\n");

  await testRootExportsHostedTypes();
  await testFactoriesRequireApiKey();
  await testBenchmarksList();
  await testBenchmarksGet();
  await testGetActive();
  await testGetActiveNoActiveVersion();
  await testImportGitSource();
  await testImportRequiresGitSource();
  await testImportDirectorySource();
  await testGetImport();
  await testWatchImportPollsToTerminal();
  await testCustomHarnessCreateInstallScript();
  await testCustomHarnessCreateTarball();
  await testCustomHarnessCreateRequiresOneSource();
  await testCustomHarnessListGetDelete();
  await testCustomHarnessNotFoundIsTypedError();
  await testCustomHarnessNameTakenIsTypedError();
  await testRunPostsInputContract();
  await testRunOmitsAbsentSpendCap();
  await testRunIdempotentReplay();
  await testRunUnknownHarnessVersionIsTypedError();
  await testRunInsufficientCreditsIsTypedError();
  await testRunNonExactHarnessVersionIsTypedError();
  await testGetJobDetail();
  await testListJobs();
  await testListAutoPagination();
  await testTrials();
  await testTrialsAutoPagination();
  await testCancel();
  await testRerunFailed();
  await testRerunFailedConflictError();
  await testRegradeTrial();
  await testRegradeJob();
  await testRegradeJobRead();
  await testRegradeIneligibleError();
  await testExportBuffer();
  await testExportToFile();
  await testExportStream();
  await testExportHarborFormat();
  await testDownloadPackageBuffer();
  await testDownloadPackageToFile();
  await testDownloadPackageStream();
  await testDownloadPackageDigestMismatch();
  await testDownloadPackageTruncated();
  await testDownloadPackageFilenameTraversal();
  await testDownloadPackageNotRetained();
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
  await testTrialDetail();
  await testTrialTracePage();
  await testTrialTraceEventsIterator();
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
