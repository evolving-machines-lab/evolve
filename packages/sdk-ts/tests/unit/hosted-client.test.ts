#!/usr/bin/env tsx
/**
 * Unit Test: Hosted Evals Client (datasets + agents + jobs + trials)
 *
 * Tests the datasets(), agents(), jobs() and trials() factories against
 * the hosted evals API contract (spec/openapi.yaml): catalog mapping, the
 * start contract (datasets list + per-arm model/version/effort) with
 * Idempotency-Key, the agent registration lanes (install-script vs uploaded
 * tarball) plus list/get/delete, cursor pagination, cancel/resume,
 * regrade-returns-a-Job, the download surfaces (buffer / file / stream, with
 * truncation + digest verification on BOTH), SSE watch with Last-Event-ID
 * resume + reconnect backoff, the publish trio (publish/getImport/watchImport)
 * with import warnings, compare aggregates + task matrix, globally addressable
 * trials (get / trace / artifact / regrade / stop), internal-field leak
 * sentinels, per-task provider verdicts, and the typed EvolveApiError mapping
 * of { error: { code, message } } bodies.
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
  /** If set, response.body streams these chunks one read at a time (wins over streamBody) */
  streamChunks?: string[];
  /** If set, arrayBuffer() resolves with these bytes */
  bodyBytes?: Buffer;
}

let mockResponses: Map<string, MockResponse> = new Map();

function setMockResponse(urlPattern: string, response: MockResponse) {
  mockResponses.set(urlPattern, response);
}

function buildMockResponse(resp: MockResponse): Response {
  let body: ReadableStream | null = null;
  const streamSource = resp.streamChunks != null
    ? resp.streamChunks.map((chunk) => Buffer.from(chunk, "utf-8"))
    : resp.streamBody != null
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
  agents,
  datasets,
  jobs,
  trials,
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
// DATASETS TESTS
// =============================================================================

async function testFactoriesRequireApiKey() {
  console.log("\n--- datasets()/jobs()/trials() require API key ---");
  const origKey = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;
  try {
    for (const [name, factory] of [
      ["datasets", datasets],
      ["jobs", jobs],
      ["trials", trials],
      ["agents", agents],
    ] as const) {
      let threw = false;
      try {
        factory();
      } catch (e: any) {
        threw = true;
        assert(e.message.includes("API key"), `${name} error mentions API key`);
      }
      assert(threw, `${name}() throws without API key`);
    }
  } finally {
    if (origKey) process.env.EVOLVE_API_KEY = origKey;
  }
}

async function testDatasetsList() {
  console.log("\n--- datasets().list() maps the catalog ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets", {
      status: 200,
      body: {
        items: [
          {
            name: "deep-swe",
            title: "DeepSWE",
            description: "SWE-bench style tasks",
            active_version: { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113 },
          },
          {
            name: "empty-set",
            title: null,
            description: null,
            active_version: null,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const catalog = await d.list();

    // The one page envelope, the same on every collection this surface returns.
    assertEqual(catalog.items.length, 2, "returns 2 datasets");
    assertEqual(catalog.nextCursor, null, "nextCursor null = no next page");
    assertEqual(catalog.hasMore, false, "hasMore says the same as a boolean");
    assertEqual(catalog.items[0].name, "deep-swe", "maps name");
    assertEqual(catalog.items[0].title, "DeepSWE", "maps title");
    assertEqual(
      catalog.items[0].active_version,
      { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113, manifest: null, gate: null },
      "maps active_version object (one shape: version/state/created_at/task_count/manifest/gate; manifest null on older servers)"
    );
    assertEqual(catalog.items[1].active_version, null, "null active_version preserved");

    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");
  } finally {
    restoreFetch();
  }
}

async function testDatasetsGet() {
  console.log("\n--- datasets().get() resolves name[@version] and maps detail ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/deep-swe", {
      status: 200,
      body: {
        name: "deep-swe",
        title: "DeepSWE",
        description: "SWE-bench style tasks",
        active_version: { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113 },
        versions: [
          { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113 },
          { version: "1.0", state: "ARCHIVED", created_at: "2026-07-01T00:00:00.000Z", task_count: 100 },
        ],
        selected_version: { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113 },
        tasks: {
          items: [
            {
              task_name: "abs-module-cache-flags",
              agent_timeout_sec: 5400,
              verifier_timeout_sec: 1800,
              providers: { e2b: { ok: true }, daytona: { ok: true }, modal: { ok: false, reason: "multi-container tasks are not supported on modal" } },
            },
          ],
          nextCursor: "task-1",
          hasMore: true,
        },
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-21T00:00:00.000Z",
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const detail = await d.get("deep-swe@1.1");

    let url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("/api/datasets/deep-swe"), "targets the dataset route");
    assert(url.includes("version=1.1"), "ref version becomes ?version=");

    assertEqual(detail.name, "deep-swe", "maps name");
    assertEqual(detail.title, "DeepSWE", "maps title");
    assertEqual(detail.active_version?.version, "1.1", "active_version is the full version object");
    assertEqual(detail.active_version?.state, "READY", "active_version carries state");
    assertEqual(detail.versions?.length, 2, "maps versions");
    assertEqual(
      detail.selected_version,
      { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113, manifest: null, gate: null },
      "selected_version is a full version object (never a bare label; manifest/gate null when the server sends none)"
    );
    // A nested collection is the same envelope as a top-level one.
    assertEqual(detail.tasks?.hasMore, true, "tasks are paged like every collection");
    assertEqual(detail.tasks?.nextCursor, "task-1", "tasks carry a cursor");
    assertEqual(detail.tasks?.items[0].task_name, "abs-module-cache-flags", "maps public task fields");
    assertEqual(
      detail.tasks?.items[0].providers,
      { e2b: { ok: true }, daytona: { ok: true }, modal: { ok: false, reason: "multi-container tasks are not supported on modal" } },
      "per-task provider verdicts mapped — capability visible before money is spent"
    );

    // Bare name: no version param
    await d.get("deep-swe");
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(!url.includes("version="), "bare name omits version param");
  } finally {
    restoreFetch();
  }
}

async function testDatasetGateMapping() {
  console.log("\n--- datasets().get() maps the activation gate (both wire forms, older servers) ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/r1-init", {
      status: 200,
      body: {
        name: "r1-init",
        title: null,
        description: null,
        active_version: null,
        versions: [
          // The server's nested form: failure carries code + message.
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
                message: "1 of 1 task(s) failed the activation gate (1 not eligible, 0 unverified)",
                failed_tasks: [
                  { task_name: "starter-task", outcome: "ERROR", reasons: ["gold run produced no usable score", 7, "last status: INDETERMINATE"] },
                  { outcome: "FAIL" }, // no task name — dropped, never a crash
                  "junk", // not even an object — dropped
                  { task_name: "bare-task" }, // name only — outcome null, reasons empty
                ],
              },
            },
          },
          // The flat form: code + message directly on the gate.
          {
            version: "0.9",
            state: "VALIDATING",
            created_at: "2026-08-01T00:00:00.000Z",
            task_count: 1,
            gate: { status: "RUNNING", attempts: 1, code: null, message: null },
          },
          // No gate scheduled (or an older server): field absent.
          { version: "0.8", state: "READY", created_at: "2026-07-01T00:00:00.000Z", task_count: 1 },
          // Garbage gate value: never a crash, always null.
          { version: "0.7", state: "READY", created_at: "2026-06-01T00:00:00.000Z", task_count: 1, gate: "oops" },
        ],
        selected_version: null,
        tasks: { items: [], nextCursor: null, hasMore: false },
        upstream: null,
        created_at: "2026-08-03T19:15:55.921Z",
        updated_at: "2026-08-03T19:15:55.921Z",
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const detail = await d.get("r1-init");
    const [failed, running, none, garbage] = detail.versions ?? [];

    assertEqual(failed.state, "FAILED", "terminal gate failure surfaces as version state FAILED");
    assertEqual(
      failed.gate,
      {
        status: "FAILED",
        attempts: 1,
        code: "gate_failed",
        message: "1 of 1 task(s) failed the activation gate (1 not eligible, 0 unverified)",
        failed_tasks: [
          {
            task_name: "starter-task",
            outcome: "ERROR",
            reasons: ["gold run produced no usable score", "last status: INDETERMINATE"],
          },
          { task_name: "bare-task", outcome: null, reasons: [] },
        ],
      },
      "nested failure form maps to {status, attempts, code, message, failed_tasks}; nameless/garbage entries dropped, non-string reasons filtered"
    );
    assertEqual(
      running.gate,
      { status: "RUNNING", attempts: 1, code: null, message: null, failed_tasks: [] },
      "flat form maps unchanged; healthy gate carries null code/message and no failed tasks"
    );
    assertEqual(none.gate, null, "a version without a gate field maps to gate null (older server: no crash)");
    assertEqual(garbage.gate, null, "an unreadable gate value maps to null, never a throw");
  } finally {
    restoreFetch();
  }
}

async function testDatasetUpdate() {
  console.log("\n--- datasets().update() PATCHes the one settable field ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/deep-swe", {
      status: 200,
      body: {
        name: "deep-swe",
        title: "DeepSWE",
        description: "SWE-bench style tasks",
        active_version: { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113 },
        upstream: {
          ref: "refs/heads/main",
          current_commit: "abc123",
          latest_commit: "def456",
          moved: true,
          behind_by: null,
          checked_at: "2026-07-29T00:00:00.000Z",
          error: null,
          auto_import: true,
        },
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const updated = await d.update("deep-swe", { upstream_auto_import: true });

    const call = fetchCalls[0];
    assertEqual(call.init?.method, "PATCH", "update() uses PATCH");
    assertEqual(
      JSON.parse(call.init?.body as string),
      { upstream_auto_import: true },
      "body carries the one settable field, nothing else"
    );
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.["Content-Type"], "application/json", "JSON body declares itself");
    assertEqual(updated.name, "deep-swe", "echoes the dataset");
    assertEqual(updated.upstream?.auto_import, true, "the new setting reads back from upstream");
  } finally {
    restoreFetch();
  }
}

async function testPublishGitSource() {
  console.log("\n--- datasets().publish() POSTs the git-source contract ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/publish", {
      status: 202,
      body: { id: "imp-1", name: "deep-swe", version: "1.2", status: "QUEUED", warnings: [] },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const imported = await d.publish({
      source: { git_url: "https://github.com/x/bench.git", git_ref: "main" },
      name: "deep-swe",
      version: "1.2",
    });

    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/datasets/publish"), "targets the publish route");
    assertEqual(call.init?.method, "POST", "uses POST");
    // ONE body grammar for both sources: multipart/form-data with named parts.
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("name"), "deep-swe", "name is a named part");
    assertEqual(form.get("version"), "1.2", "version is a named part");
    assertEqual(form.get("git_url"), "https://github.com/x/bench.git", "git_url is a named part");
    assertEqual(form.get("git_ref"), "main", "git_ref is a named part");
    assertEqual(form.get("archive"), null, "no archive part for a git source");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");

    assertEqual(
      imported,
      { id: "imp-1", status: "QUEUED", name: "deep-swe", version: "1.2", failure: null, warnings: [] },
      "202 response mapped (id, status, name, version, failure, warnings)"
    );
  } finally {
    restoreFetch();
  }
}

async function testPublishRequiresGitSource() {
  console.log("\n--- datasets().publish() requires a complete git source ---");
  installMockFetch();
  try {
    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await d.publish({
        source: { git_url: "", git_ref: "main" },
        name: "deep-swe",
        version: "1.2",
      });
    } catch (e: any) {
      threw = true;
      assert(e.message.includes("git source"), "message names the git source requirement");
    }
    assert(threw, "empty git_url throws");
    assertEqual(fetchCalls.length, 0, "invalid input never hits the network");
  } finally {
    restoreFetch();
  }
}

async function testPublishDirectorySource() {
  console.log("\n--- datasets().publish() tars + gzips a local directory and uploads it ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-import-dir-"));
  try {
    await mkdir(join(dir, "tasks", "abc"), { recursive: true });
    await writeFile(join(dir, "tasks", "abc", "task.toml"), 'schema_version = "1.1"\n');
    setMockResponse("/api/datasets/publish", {
      status: 202,
      body: { id: "imp-2", name: "my-set", version: "0.1", status: "QUEUED", warnings: [] },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const imported = await d.publish({
      source: { directory: dir },
      name: "my-set",
      version: "0.1",
    });

    const call = fetchCalls[fetchCalls.length - 1];
    // Metadata is named PARTS; the corpus is the `archive` part. The URL is bare.
    assert(call.url.endsWith("/api/datasets/publish"), "the URL carries nothing");
    assertEqual(call.init?.method, "POST", "uses POST");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("name"), "my-set", "name is a named part");
    assertEqual(form.get("version"), "0.1", "version is a named part");
    // The metadata parts come FIRST so the server can refuse a name it will
    // never accept before receiving a half-gigabyte upload.
    assertEqual([...form.keys()], ["name", "version", "archive"], "metadata precedes the archive part");

    const file = form.get("archive") as File;
    assert(file instanceof Blob, "the corpus is the archive part");
    const body = new Uint8Array(await file.arrayBuffer());
    assert(body.length > 0, "archive part is non-empty bytes");
    assert(body[0] === 0x1f && body[1] === 0x8b, "archive part is a gzip stream (magic 1f 8b)");
    // The gzipped tar carries the corpus file path + content (USTAR stores both as plain bytes).
    const tarText = gunzipSync(Buffer.from(body)).toString("latin1");
    assert(tarText.includes("tasks/abc/task.toml"), "the tar carries the corpus file path");
    assert(tarText.includes('schema_version = "1.1"'), "the tar carries the file content");

    assertEqual(
      imported,
      { id: "imp-2", status: "QUEUED", name: "my-set", version: "0.1", failure: null, warnings: [] },
      "202 response mapped (id, status, name, version, failure, warnings)"
    );
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testPublishManifestDerivedIdentity() {
  console.log("\n--- datasets().publish() lets dataset.toml supply name/version for a directory source ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-import-manifest-"));
  try {
    await mkdir(join(dir, "tasks", "abc"), { recursive: true });
    await writeFile(join(dir, "tasks", "abc", "task.toml"), 'schema_version = "1.1"\n');
    await writeFile(
      join(dir, "dataset.toml"),
      '[dataset]\nname = "acme/my-set"\nversion = "0.1"\n\n[[tasks]]\nname = "acme/abc"\ndigest = "sha256:' +
        "0".repeat(64) +
        '"\n'
    );
    setMockResponse("/api/datasets/publish", {
      status: 202,
      body: { id: "imp-3", name: "my-set", version: "0.1", status: "QUEUED", warnings: [] },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    // No name, no version: the SERVER derives both from the manifest.
    const imported = await d.publish({ source: { directory: dir } });

    const call = fetchCalls[fetchCalls.length - 1];
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("name"), null, "no name part — the manifest supplies it server-side");
    assertEqual(form.get("version"), null, "no version part — the manifest supplies it server-side");
    assert(form.get("archive") instanceof Blob, "the corpus still rides the archive part");
    assertEqual(imported.name, "my-set", "202 echoes the server-derived name");
    assertEqual(imported.version, "0.1", "202 echoes the server-derived version");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testPublishDirectoryWithoutManifestNeedsIdentity() {
  console.log("\n--- datasets().publish() refuses a nameless directory publish when no dataset.toml exists ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-import-nomanifest-"));
  try {
    await mkdir(join(dir, "tasks", "abc"), { recursive: true });
    await writeFile(join(dir, "tasks", "abc", "task.toml"), 'schema_version = "1.1"\n');
    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await d.publish({ source: { directory: dir } });
    } catch (e: any) {
      threw = true;
      assert(e.message.includes("dataset.toml"), "message points at the manifest alternative");
    }
    assert(threw, "no name, no version, no manifest throws");
    assertEqual(fetchCalls.length, 0, "the corpus is never tarred or uploaded for a doomed publish");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testPublishGitSourceRequiresIdentity() {
  console.log("\n--- datasets().publish() still requires name/version for a git source ---");
  installMockFetch();
  try {
    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await d.publish({
        source: { git_url: "https://github.com/x/bench.git", git_ref: "main" },
      });
    } catch (e: any) {
      threw = true;
      assert(e.message.includes("cloned server-side"), "message explains WHY the manifest cannot supply them");
    }
    assert(threw, "git source without name/version throws");
    assertEqual(fetchCalls.length, 0, "refused before the network");
  } finally {
    restoreFetch();
  }
}

async function testVersionManifestMapping() {
  console.log("\n--- dataset versions carry the manifest metadata the server reports ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/deep-swe", {
      status: 200,
      body: {
        name: "deep-swe",
        title: null,
        description: null,
        active_version: {
          version: "1.1",
          state: "READY",
          created_at: "2026-07-21T00:00:00.000Z",
          task_count: 113,
          manifest: {
            name: "acme/deep-swe",
            version: "1.1",
            description: "SWE tasks",
            authors: [{ name: "Acme", email: "eng@acme.dev" }, { name: "NoMail" }],
            keywords: ["swe", "agentic"],
            task_count: 113,
          },
        },
        versions: [],
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-21T00:00:00.000Z",
      },
    });
    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const detail = await d.get("deep-swe");
    assertEqual(
      detail.active_version?.manifest,
      {
        name: "acme/deep-swe",
        version: "1.1",
        description: "SWE tasks",
        authors: [
          { name: "Acme", email: "eng@acme.dev" },
          { name: "NoMail", email: null },
        ],
        keywords: ["swe", "agentic"],
        task_count: 113,
      },
      "manifest maps identity + metadata; a missing author email normalizes to null"
    );
  } finally {
    restoreFetch();
  }
}

async function testGetImport() {
  console.log("\n--- datasets().getImport() maps status/failure/warnings/task_count ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/imports/imp-1", {
      status: 200,
      body: {
        id: "imp-1",
        status: "COMPLETED",
        name: "deep-swe",
        version: "1.2",
        task_count: 113,
        failure: null,
        warnings: [{ code: "no_solutions_archived", message: "no reference solutions were archived" }],
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const imported = await d.getImport("imp-1");

    assert(
      fetchCalls[0].url.includes("/api/datasets/imports/imp-1"),
      "targets the import detail route"
    );
    assertEqual(
      imported,
      {
        id: "imp-1",
        status: "COMPLETED",
        name: "deep-swe",
        version: "1.2",
        failure: null,
        warnings: [{ code: "no_solutions_archived", message: "no reference solutions were archived" }],
        task_count: 113,
      },
      "self-describing job: id/status/name/version/failure/warnings/task_count"
    );
    // WARNINGS ARE CONSEQUENTIAL: a version with no archived solutions can
    // never be activated — dropping the field made it look runnable.
    assertEqual(imported.warnings[0].code, "no_solutions_archived", "warnings surface, never dropped");
  } finally {
    restoreFetch();
  }
}

async function testWatchImportPollsToTerminal() {
  console.log("\n--- datasets().watchImport() polls getImport() to a terminal status ---");
  installMockFetch();
  try {
    const job = { id: "imp-1", name: "deep-swe", version: "1.2", warnings: [] };
    const statuses = [
      { ...job, status: "QUEUED", failure: null, task_count: 0 },
      { ...job, status: "RUNNING", failure: null, task_count: 0 },
      { ...job, status: "COMPLETED", failure: null, task_count: 113 },
    ];
    let calls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: url.toString(), init });
      const body = statuses[Math.min(calls, statuses.length - 1)];
      calls++;
      return buildMockResponse({ status: 200, body });
    };

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const seen: string[] = [];
    const final = await d.watchImport("imp-1", {
      onStatus: (i) => seen.push(i.status),
      pollIntervalMs: 1,
    });

    assertEqual(calls, 3, "polled until the terminal status");
    assertEqual(seen, ["QUEUED", "RUNNING", "COMPLETED"], "onStatus fires on every status change");
    assertEqual(final.status, "COMPLETED", "resolves with the terminal import");
    assertEqual(final.task_count, 113, "terminal import carries task_count");

    // FAILED is terminal too, with the structured error surfaced
    installMockFetch();
    setMockResponse("/api/datasets/imports/imp-2", {
      status: 200,
      body: { ...job, id: "imp-2", status: "FAILED", failure: { code: "import_failed", message: "task.yaml missing for task abc" }, task_count: 0 },
    });
    const failed = await d.watchImport("imp-2", { pollIntervalMs: 1 });
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

/**
 * A rate limit mid-watch is a DELAY, not an outcome: the import keeps running
 * server-side, so dying at the 429 lost a watch over a wait. The loop sleeps
 * the server's own delay — from the envelope on the 429, from the header on
 * the 503 — and polls on. Anything else still ends the watch.
 */
async function testWatchImportSurvivesRateLimit() {
  console.log("\n--- datasets().watchImport() sleeps a 429/503 and keeps watching ---");
  installMockFetch();
  try {
    const job = { id: "imp-1", name: "deep-swe", version: "1.2", warnings: [] };
    const replies: MockResponse[] = [
      {
        status: 429,
        body: { error: { code: "rate_limited", message: "slow down", retryAfterSec: 0.05 } },
      },
      {
        status: 503,
        body: { error: { code: "unavailable", message: "restarting" } },
        headers: { "retry-after": "0.05" },
      },
      { status: 200, body: { ...job, status: "COMPLETED", failure: null, task_count: 113 } },
    ];
    let calls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: url.toString(), init });
      return buildMockResponse(replies[Math.min(calls++, replies.length - 1)]);
    };

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const startedAt = Date.now();
    const final = await d.watchImport("imp-1", { pollIntervalMs: 1 });
    const elapsedMs = Date.now() - startedAt;

    assertEqual(calls, 3, "the 429 and the 503 are survived, not surfaced");
    assertEqual(final.status, "COMPLETED", "resolves with the terminal import the 429 would have hidden");
    assert(
      elapsedMs >= 80,
      `slept both 50ms Retry-After delays, not the 1ms poll interval (waited ${elapsedMs}ms)`
    );

    // Every other failure still ends the watch — the survival is scoped to the
    // two statuses that MEAN "wait", never to a refusal.
    installMockFetch();
    setMockResponse("/api/datasets/imports/imp-2", {
      status: 404,
      body: { error: { code: "dataset_not_found", message: "no such import" } },
    });
    let threw = false;
    try {
      await d.watchImport("imp-2", { pollIntervalMs: 1 });
    } catch (error) {
      threw = error instanceof EvolveApiError && error.status === 404;
    }
    assert(threw, "a 404 still ends the watch with the typed error");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// REGISTERED AGENTS TESTS
// =============================================================================

const REGISTERED_AGENT = {
  name: "acme-cli",
  source: "install_script",
  run_command: "acme-cli --headless",
  env: { ACME_PROFILE: "bench" },
  created_at: "2026-07-24T00:00:00Z",
  updated_at: "2026-07-24T00:00:00Z",
};

async function testAgentCreateInstallScript() {
  console.log("\n--- agents().create() posts the install-script multipart body ---");
  installMockFetch();
  try {
    setMockResponse("/api/agents", { status: 201, body: REGISTERED_AGENT });
    const a = agents({ apiKey: "test-key", baseUrl: BASE });
    const created = await a.create({
      name: "acme-cli",
      install_script: "curl -fsSL https://acme.dev/install.sh | sh",
      run_command: "acme-cli --headless",
      env: { ACME_PROFILE: "bench" },
    });
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/agents"), "hits the agents route");
    assertEqual(call.init?.method, "POST", "uses POST");
    // ONE body grammar for both sources: multipart/form-data, so the endpoint
    // never switches grammars on Content-Type.
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("name"), "acme-cli", "name is a named part");
    assertEqual(
      form.get("install_script"),
      "curl -fsSL https://acme.dev/install.sh | sh",
      "install_script is a named part"
    );
    assertEqual(form.get("run_command"), "acme-cli --headless", "run_command is a named part");
    assertEqual(form.get("env"), JSON.stringify({ ACME_PROFILE: "bench" }), "env is a JSON part");
    assertEqual(form.get("archive"), null, "no archive part for the install-script source");
    assertEqual(created, REGISTERED_AGENT, "201 response mapped (name, source, run_command, env, timestamps)");
  } finally {
    restoreFetch();
  }
}

async function testAgentCreateTarball() {
  console.log("\n--- agents().create() tars a directory into a multipart archive part ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-agent-dir-"));
  try {
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "acme-cli"), "#!/bin/sh\nexec acme \"$@\"\n");
    setMockResponse("/api/agents", {
      status: 201,
      body: { ...REGISTERED_AGENT, source: "tarball" },
    });

    const a = agents({ apiKey: "test-key", baseUrl: BASE });
    const created = await a.create({
      name: "acme-cli",
      directory: dir,
      run_command: "acme-cli --headless",
      env: { ACME_PROFILE: "bench", ACME_REGION: "us" },
    });

    const call = fetchCalls[fetchCalls.length - 1];
    // The run command and the declared env are named PARTS, never the query
    // string — a shell command and env values in a URL land in every access
    // log and proxy buffer on the way to the server.
    assert(call.url.endsWith("/api/agents"), "the URL carries nothing");
    assertEqual(call.init?.method, "POST", "uses POST");
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual(form.get("name"), "acme-cli", "name is a named part");
    assertEqual(form.get("run_command"), "acme-cli --headless", "run_command is a named part");
    assertEqual(
      form.get("env"),
      JSON.stringify({ ACME_PROFILE: "bench", ACME_REGION: "us" }),
      "env is one JSON part, not repeated query pairs"
    );
    const file = form.get("archive") as File;
    assert(file instanceof Blob, "the archive is the archive part");
    const body = new Uint8Array(await file.arrayBuffer());
    assert(body.length > 0, "archive part is non-empty bytes");
    assert(body[0] === 0x1f && body[1] === 0x8b, "archive part is a gzip stream (magic 1f 8b)");
    const tarText = gunzipSync(Buffer.from(body)).toString("latin1");
    assert(tarText.includes("bin/acme-cli"), "the tar carries the agent executable path");
    assertEqual(created.source, "tarball", "server echoes the tarball source");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testAgentCreateRequiresOneSource() {
  console.log("\n--- agents().create() requires exactly one source ---");
  const a = agents({ apiKey: "test-key", baseUrl: BASE });
  let threwNone = false;
  try {
    await a.create({ name: "acme-cli", run_command: "acme-cli --headless" } as any);
  } catch (err: any) {
    threwNone = true;
    assert(err.message.includes("install_script"), "no-source error names install_script");
    assert(err.message.includes("directory"), "no-source error names directory");
  }
  assert(threwNone, "throws when neither source is given");

  let threwBoth = false;
  try {
    await a.create({
      name: "acme-cli",
      install_script: "true",
      directory: "/tmp/acme",
      run_command: "acme-cli --headless",
    } as any);
  } catch (err: any) {
    threwBoth = true;
    assert(err.message.includes("not both"), "both-sources error says not both");
  }
  assert(threwBoth, "throws when both sources are given");
}

async function testAgentListGetDelete() {
  console.log("\n--- agents() list/get/delete ---");
  installMockFetch();
  try {
    setMockResponse("/api/agents/acme-cli", { status: 200, body: REGISTERED_AGENT });
    setMockResponse("/api/agents", {
      status: 200,
      body: { items: [REGISTERED_AGENT], nextCursor: null, hasMore: false },
    });
    const a = agents({ apiKey: "test-key", baseUrl: BASE });

    const listed = await a.list();
    assertEqual(listed.items.length, 1, "list() returns the one page envelope");
    assertEqual(listed.nextCursor, null, "nextCursor null = no next page");
    assertEqual(listed.items[0].name, "acme-cli", "maps the agent name");
    assertEqual(listed.items[0].source, "install_script", "maps the source");

    const one = await a.get("acme-cli");
    assert(
      fetchCalls[fetchCalls.length - 1].url.endsWith("/api/agents/acme-cli"),
      "get() targets the detail route"
    );
    assertEqual(one.run_command, "acme-cli --headless", "maps the run command");

    setMockResponse("/api/agents/acme-cli", { status: 204, body: null });
    const deleted = await a.delete("acme-cli");
    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "DELETE", "delete() uses DELETE");
    assertEqual(deleted, undefined, "delete() resolves with nothing (204)");
  } finally {
    restoreFetch();
  }
}

async function testAgentNotFoundIsTypedError() {
  console.log("\n--- agents().get() surfaces 404 agent_not_found ---");
  installMockFetch();
  try {
    setMockResponse("/api/agents/someone-elses", {
      status: 404,
      body: {
        error: {
          code: "agent_not_found",
          message: 'No registered agent named "someone-elses".',
        },
      },
    });
    const a = agents({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await a.get("someone-elses");
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 404, "carries the HTTP status");
      assertEqual(err.code, "agent_not_found", "another owner's name is not-found, never a leak");
    }
    assert(threw, "throws on 404");
  } finally {
    restoreFetch();
  }
}

async function testAgentNameTakenIsTypedError() {
  console.log("\n--- agents().create() surfaces 409 agent_name_taken ---");
  installMockFetch();
  try {
    setMockResponse("/api/agents", {
      status: 409,
      body: {
        error: {
          code: "agent_name_taken",
          message: 'You already registered an agent named "acme-cli".',
        },
      },
    });
    const a = agents({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await a.create({ name: "acme-cli", install_script: "true", run_command: "acme-cli" });
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 409, "carries the HTTP status");
      assertEqual(err.code, "agent_name_taken", "carries the stable error code");
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

const JOB_SUMMARY = {
  id: "eval-1",
  job_name: "deep-swe sweep",
  status: "QUEUED",
  datasets: [{ name: "deep-swe", version: "1.1" }],
  agents: [{ name: "codex", model_name: "gpt-5.5", version: null, reasoning_effort: null }],
  n_attempts: 1,
  n_concurrent_trials: 4,
  max_trial_spend_usd: 25,
  worst_case_spend_usd: 250,
  sandbox_provider: "daytona",
  counts: { agents: 2, tasks: 5 },
  n_total_trials: 10,
  trials: { total: 10, byStatus: zeroTrialStatuses({ QUEUED: 10 }) },
  stats: { n_completed_trials: 0, n_errored_trials: 0, cost_usd: null },
  failure: null,
  source_jobs: [],
  is_regrade: false,
  idempotent_replay: false,
  started_at: "2026-07-22T00:00:00.000Z",
  updated_at: "2026-07-22T00:00:00.000Z",
  finished_at: null,
};

async function testStartPostsInputContract() {
  console.log("\n--- jobs().start() POSTs the job-creation contract ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", { status: 202, body: JOB_SUMMARY });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const input = {
      datasets: [
        { name: "deep-swe", version: "1.1", task_names: ["abs-module-cache-flags"] },
      ],
      agents: [
        { name: "codex", model_name: "gpt-5.5" },
        { name: "claude", model_name: "sonnet", version: "2.1.0" },
      ],
      n_attempts: 1,
      n_concurrent_trials: 4,
      max_trial_spend_usd: 25,
      sandbox_provider: "daytona" as const,
    };
    const job = await e.start(input, { idempotencyKey: "idem-abc" });

    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "POST", "uses POST");
    assertEqual(JSON.parse(call.init?.body as string), input, "body is the job-creation contract");
    assertEqual(
      JSON.parse(call.init?.body as string).max_trial_spend_usd,
      25,
      "max_trial_spend_usd forwarded"
    );
    assertEqual(
      JSON.parse(call.init?.body as string).sandbox_provider,
      "daytona",
      "sandbox_provider forwarded"
    );
    assertEqual(job.sandbox_provider, "daytona", "maps sandbox_provider from the body");
    assertEqual(
      JSON.parse(call.init?.body as string).datasets[0].task_names,
      ["abs-module-cache-flags"],
      "per-dataset task_names filter rides inside the selector"
    );
    assertEqual(
      JSON.parse(call.init?.body as string).agents[1].version,
      "2.1.0",
      "version pin forwarded on the agent arm"
    );
    assert(
      !("version" in JSON.parse(call.init?.body as string).agents[0]),
      "an unpinned arm sends no version (resolve-latest)"
    );
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.["Idempotency-Key"], "idem-abc", "Idempotency-Key header sent");
    assertEqual(headers?.["Content-Type"], "application/json", "JSON content type");
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");

    assertEqual(job.id, "eval-1", "maps id");
    assertEqual(job.status, "QUEUED", "maps status");
    assertEqual(job.datasets, [{ name: "deep-swe", version: "1.1" }], "maps the resolved dataset refs");
    // ONE "how many" structure: counts is entity cardinality, trials is the
    // total plus the status histogram.
    assertEqual(job.counts, { agents: 2, tasks: 5 }, "maps counts (entity cardinality only)");
    assertEqual(job.n_total_trials, 10, "maps n_total_trials");
    assertEqual(job.trials.total, 10, "maps the trial total");
    assertEqual(job.trials.byStatus.QUEUED, 10, "maps the status histogram (frozen byStatus key)");
    assertEqual(job.idempotent_replay, false, "idempotent_replay is always present, false on a fresh create");
    assertEqual(job.source_jobs, [], "source_jobs is empty for an original job");
    assertEqual(job.is_regrade, false, "is_regrade false for an original job");
    assertEqual(job.finished_at, null, "finished_at null while the job is live");

    // Without idempotency key, header is absent
    await e.start(input);
    const headers2 = fetchCalls[fetchCalls.length - 1].init?.headers as Record<string, string>;
    assert(!("Idempotency-Key" in (headers2 || {})), "no Idempotency-Key header by default");

    // Bare dataset name: forwarded as-is; the server resolves the active
    // version and the response echoes the resolved ref.
    const bare = await e.start({
      datasets: [{ name: "deep-swe" }],
      agents: [{ name: "codex", model_name: "gpt-5.5" }],
      max_trial_spend_usd: 25,
    });
    assertEqual(
      JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string).datasets,
      [{ name: "deep-swe" }],
      "bare dataset name forwarded unchanged"
    );
    assertEqual(bare.datasets[0].version, "1.1", "response echoes the resolved version");
  } finally {
    restoreFetch();
  }
}

async function testStartOmitsAbsentSpendCap() {
  console.log("\n--- jobs().start() omits max_trial_spend_usd when it is not given ---");
  installMockFetch();
  try {
    // The server's own default ($200 per trial, operator-tunable) applies, and
    // the response echoes the RESOLVED cap plus the worst case it implies.
    setMockResponse("/api/jobs", {
      status: 202,
      body: { ...JOB_SUMMARY, max_trial_spend_usd: 200, worst_case_spend_usd: 400 },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.start({
      datasets: [{ name: "deep-swe", version: "1.1" }],
      agents: [{ name: "codex", model_name: "gpt-5.5" }],
    });

    const body = JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string);
    // ABSENT, never null: an explicit null would defeat the server-side default
    // the omission is asking for.
    assert(!("max_trial_spend_usd" in body), "no cap key on the wire when omitted");
    assertEqual(
      body,
      { datasets: [{ name: "deep-swe", version: "1.1" }], agents: [{ name: "codex", model_name: "gpt-5.5" }] },
      "body carries only what was given"
    );
    assertEqual(job.max_trial_spend_usd, 200, "response echoes the RESOLVED per-trial cap");
    assertEqual(
      job.worst_case_spend_usd,
      400,
      "response states the worst case the cap implies for this job"
    );

    // A stated cap is still forwarded unchanged.
    await e.start({
      datasets: [{ name: "deep-swe", version: "1.1" }],
      agents: [{ name: "codex", model_name: "gpt-5.5" }],
      max_trial_spend_usd: 25,
    });
    assertEqual(
      JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string).max_trial_spend_usd,
      25,
      "a stated max_trial_spend_usd is forwarded"
    );
  } finally {
    restoreFetch();
  }
}

async function testStartIdempotentReplay() {
  console.log("\n--- jobs().start() surfaces idempotent_replay ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", {
      status: 200,
      body: { ...JOB_SUMMARY, idempotent_replay: true },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.start(
      { datasets: [{ name: "deep-swe" }], agents: [{ name: "codex", model_name: "gpt-5.5" }], max_trial_spend_usd: 25 },
      { idempotencyKey: "idem-abc" }
    );
    assertEqual(job.idempotent_replay, true, "idempotent_replay passed through");
  } finally {
    restoreFetch();
  }
}

async function testStartUnknownAgentVersionIsTypedError() {
  console.log("\n--- jobs().start() surfaces 404 agent_version_not_found ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", {
      status: 404,
      body: {
        error: {
          code: "agent_version_not_found",
          message: 'Agent "codex" has no version "9.9.9".',
        },
      },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.start({
        datasets: [{ name: "deep-swe" }],
        agents: [{ name: "codex", model_name: "gpt-5.5", version: "9.9.9" }],
        max_trial_spend_usd: 25,
      });
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 404, "carries the HTTP status");
      assertEqual(err.code, "agent_version_not_found", "carries the stable error code");
    }
    assert(threw, "an unknown agent version is rejected at creation");
  } finally {
    restoreFetch();
  }
}

async function testStartInsufficientCreditsIsTypedError() {
  console.log("\n--- jobs().start() surfaces 402 insufficient_credits ---");
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
      await e.start({
        datasets: [{ name: "deep-swe" }],
        agents: [{ name: "codex", model_name: "gpt-5.5" }],
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

async function testStartNonExactVersionIsTypedError() {
  console.log("\n--- jobs().start() surfaces 400 invalid_input for a non-exact pin ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs", {
      status: 400,
      body: {
        error: {
          code: "invalid_input",
          message: 'version "^0.29.0" must be an exact version.',
        },
      },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.start({
        datasets: [{ name: "deep-swe" }],
        // A range cannot hold a comparison still, so it is refused, not resolved.
        agents: [{ name: "codex", model_name: "gpt-5.5", version: "^0.29.0" }],
        max_trial_spend_usd: 25,
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
        job_name: "deep-swe sweep",
        status: "RUNNING",
        datasets: [{ name: "deep-swe", version: "1.1" }],
        n_attempts: 1,
        n_concurrent_trials: 4,
        max_trial_spend_usd: 2.5,
        worst_case_spend_usd: 25,
        sandbox_provider: "modal",
        agents: [
          { name: "codex", model_name: "gpt-5.5", version: null, reasoning_effort: null },
        ],
        counts: { agents: 1, tasks: 10 },
        n_total_trials: 10,
        trials: { total: 10, byStatus: zeroTrialStatuses({ SCORED: 4, RUNNING: 2, QUEUED: 4 }) },
        stats: {
          n_completed_trials: 4,
          n_errored_trials: 0,
          n_running_trials: 2,
          n_pending_trials: 4,
          n_cancelled_trials: 0,
          n_retries: 0,
          evals: {
            "codex__gpt-5.5__deep-swe": { n_trials: 10, n_errors: 0, metrics: [{ name: "mean", value: 0.75 }] },
          },
          n_input_tokens: 120000,
          n_cache_tokens: 40000,
          n_output_tokens: 9000,
          cost_usd: 3.5,
        },
        failure: null,
        source_jobs: [],
        is_regrade: false,
        idempotent_replay: false,
        started_at: "2026-07-22T00:00:00.000Z",
        updated_at: "2026-07-22T00:05:00.000Z",
        finished_at: null,
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.get("eval-1");

    assertEqual(job.status, "RUNNING", "maps status");
    assertEqual(job.job_name, "deep-swe sweep", "maps job_name");
    assert(
      !("datasetVersionState" in (job as unknown as Record<string, unknown>)),
      "no dataset-lifecycle internals on the job"
    );
    assertEqual(job.max_trial_spend_usd, 2.5, "maps max_trial_spend_usd");
    assertEqual(job.worst_case_spend_usd, 25, "maps worst_case_spend_usd (trials x the cap)");
    assertEqual(job.sandbox_provider, "modal", "maps sandbox_provider");
    assertEqual(job.stats.cost_usd, 3.5, "maps stats.cost_usd — measured spend, never a gate");
    assertEqual(job.stats.n_input_tokens, 120000, "maps token totals");
    assertEqual(
      job.stats.evals?.["codex__gpt-5.5__deep-swe"]?.n_trials,
      10,
      "maps per-arm evals keyed agent__model__dataset"
    );
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
      [{ name: "codex", model_name: "gpt-5.5", version: null, reasoning_effort: null }],
      "agents is the public arm shape (wire sends nothing internal)"
    );
    const system = job.agents?.[0] as Record<string, unknown>;
    assert(!("id" in system), "internal agent id not exposed");
    assert(!("systemDigest" in system), "systemDigest not exposed");
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
          { ...JOB_SUMMARY, trials: { total: 10, byStatus: zeroTrialStatuses({ SCORED: 10 }) } },
          {
            ...JOB_SUMMARY,
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

/** One trial in the contract's wire shape. */
function wireTrial(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    job_id: "eval-1",
    task_name: "abs-module-cache-flags",
    source: "deep-swe",
    agent_info: {
      name: "codex",
      version: "codex-cli 0.145.0",
      model_info: { name: "gpt-5.5", provider: "openai" },
      reasoning_effort: null,
    },
    attempt: 1,
    status: "SCORED",
    reward: 1,
    verifier_result: { rewards: { reward: 1, f2p: 1, p2p: 1 } },
    exception_info: null,
    agent_result: {
      n_input_tokens: 1000,
      n_cache_tokens: 200,
      n_output_tokens: 300,
      cost_usd: 0.93,
      rollout_details: null,
      metadata: null,
    },
    environment_setup: { started_at: "2026-07-22T00:00:00.000Z", finished_at: "2026-07-22T00:00:30.000Z" },
    agent_setup: { started_at: "2026-07-22T00:00:30.000Z", finished_at: "2026-07-22T00:00:40.000Z" },
    agent_execution: { started_at: "2026-07-22T00:00:40.000Z", finished_at: "2026-07-22T00:04:03.000Z" },
    verifier: { started_at: "2026-07-22T00:04:03.000Z", finished_at: "2026-07-22T00:04:34.000Z" },
    step_results: null,
    spend_source: "measured",
    live_spent_usd: null,
    live_spend_at: null,
    max_trial_spend_usd: 2.5,
    sandbox_provider: "daytona",
    sandbox_id: "im8f0wgqwehvng70evvro",
    verifier_sandbox_id: "iv2k1xbqwehvng70evvrp",
    verifier_environment_mode: "separate",
    attempt_phase: null,
    session_ref: "sess-9",
    started_at: "2026-07-22T00:00:00.000Z",
    finished_at: "2026-07-22T00:04:34.000Z",
    ...overrides,
  };
}

async function testTrials() {
  console.log("\n--- jobs().trials() maps trials (cursor-paged) ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/trials", {
      status: 200,
      body: {
        items: [
          wireTrial(),
          wireTrial({
            id: "run-2",
            attempt: 2,
            status: "INFRASTRUCTURE_ERROR",
            reward: null,
            verifier_result: null,
            exception_info: {
              exception_type: "InfrastructureError",
              exception_message: "sandbox failed to boot",
              exception_traceback: "",
              occurred_at: "2026-07-22T00:01:00.000Z",
            },
            agent_result: null,
            spend_source: "assumed_cap",
            sandbox_id: null,
            verifier_sandbox_id: null,
            verifier_environment_mode: null,
            attempt_phase: "boot",
            session_ref: null,
          }),
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
    assertEqual(page.items[0].reward, 1, "maps the primary reward");
    assertEqual(
      page.items[0].verifier_result?.rewards,
      { reward: 1, f2p: 1, p2p: 1 },
      "maps the verifier rewards map"
    );
    assertEqual(page.items[0].agent_result?.cost_usd, 0.93, "maps agent_result.cost_usd");
    assertEqual(page.items[0].sandbox_provider, "daytona", "first-class sandbox_provider on list rows");
    assertEqual(page.items[0].verifier_environment_mode, "separate", "first-class verifier_environment_mode");
    assertEqual(page.items[0].agent_info.version, "codex-cli 0.145.0", "agent_info.version is the RESOLVED version");
    assertEqual(page.items[0].sandbox_id, "im8f0wgqwehvng70evvro", "maps sandbox_id — the box the agent ran in");
    assertEqual(
      page.items[0].verifier_sandbox_id,
      "iv2k1xbqwehvng70evvrp",
      "maps verifier_sandbox_id — the box the verifier ran in"
    );
    assertEqual(page.items[0].session_ref, "sess-9", "maps session_ref");
    assertEqual(
      page.items[0].agent_execution,
      { started_at: "2026-07-22T00:00:40.000Z", finished_at: "2026-07-22T00:04:03.000Z" },
      "phase timings are start/stop pairs, never durations"
    );
    assertEqual(page.items[1].status, "INFRASTRUCTURE_ERROR", "maps failure status");
    assertEqual(
      page.items[1].exception_info?.exception_type,
      "InfrastructureError",
      "maps exception_info.exception_type"
    );
    assertEqual(page.items[1].reward, null, "unscored trial keeps null reward (never a fake zero)");
    assertEqual(page.items[1].attempt_phase, "boot", "attempt_phase says WHICH step the trial died in");
    assertEqual(page.items[0].attempt_phase, null, "attempt_phase null when not mid-phase");
    assertEqual(page.items[1].sandbox_id, null, "a trial that never booted a box has null sandbox_id");
    // The three lanes the platform actually stamps — a trial that never ran
    // carries assumed_cap, whose figure is $0 and never the cap.
    assertEqual(page.items[1].spend_source, "assumed_cap", "the assumed_cap lane maps");

    // Status filter: comma-joined ?status= for the failures behind a resume decision
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
  console.log("\n--- jobs().cancel() POSTs and returns the job body ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/cancel", {
      status: 200,
      body: { ...JOB_SUMMARY, status: "CANCELLING" },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.cancel("eval-1");
    assertEqual(fetchCalls[0].init?.method, "POST", "uses POST");
    assertEqual(job.status, "CANCELLING", "maps cancelling status");
  } finally {
    restoreFetch();
  }
}

async function testResume() {
  console.log("\n--- jobs().resume() creates the linked job over failed trials ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/resume", {
      status: 202,
      body: {
        ...JOB_SUMMARY,
        id: "eval-2",
        source_jobs: [{ action: "resume", type: "hub", job_id: "eval-1" }],
      },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.resume(
      "eval-1",
      { filter_error_types: ["InfrastructureError"] },
      { idempotencyKey: "idem-rr" }
    );

    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/jobs/eval-1/resume"), "hits the resume route");
    assertEqual(call.init?.method, "POST", "uses POST");
    assertEqual(
      JSON.parse(call.init?.body as string),
      { filter_error_types: ["InfrastructureError"] },
      "sends the filter_error_types body"
    );
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.["Idempotency-Key"], "idem-rr", "Idempotency-Key header sent");
    assertEqual(job.id, "eval-2", "returns the NEW job");
    assertEqual(
      job.source_jobs,
      [{ action: "resume", type: "hub", job_id: "eval-1" }],
      "source_jobs records the resume provenance"
    );

    // No request body given: an empty object rides the wire (never undefined).
    await e.resume("eval-1");
    assertEqual(
      JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string),
      {},
      "omitted filter sends the empty body — the server default set applies"
    );
  } finally {
    restoreFetch();
  }
}

async function testResumeConflictError() {
  console.log("\n--- resume() surfaces 409 for non-terminal jobs ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/resume", {
      status: 409,
      body: { error: { code: "job_not_terminal", message: "Job is RUNNING; resume requires a terminal job" } },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.resume("eval-1");
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

// =============================================================================
// REGRADE — the response is a JOB
// =============================================================================

const REGRADE_JOB_BODY = {
  ...JOB_SUMMARY,
  id: "regrade-1",
  source_jobs: [{ action: "regrade", type: "hub", job_id: "eval-1" }],
  is_regrade: true,
};

async function testRegradeJob() {
  console.log("\n--- jobs().regrade() returns a JOB with regrade provenance ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/regrade", {
      status: 202,
      body: REGRADE_JOB_BODY,
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.regrade("eval-1", { statuses: ["SCORED"], task_name: "demo-task" });
    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "POST", "uses POST");
    const sentBody = JSON.parse(call.init?.body as string);
    assertEqual(sentBody, { statuses: ["SCORED"], task_name: "demo-task" }, "sends the statuses+task_name filter body");
    // A regrade IS a job: no separate resource, no separate reader.
    assertEqual(job.id, "regrade-1", "returns the regrade JOB");
    assertEqual(job.is_regrade, true, "is_regrade is true");
    assertEqual(
      job.source_jobs,
      [{ action: "regrade", type: "hub", job_id: "eval-1" }],
      "source_jobs records the regrade provenance"
    );
  } finally {
    restoreFetch();
  }
}

async function testRegradeTrialReturnsJob() {
  console.log("\n--- trials().regrade() re-runs one trial's verifier and returns a JOB ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1/regrade", {
      status: 202,
      body: { ...REGRADE_JOB_BODY, n_total_trials: 1 },
    });
    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    const job = await t.regrade("run-1");
    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "POST", "uses POST");
    assert(call.url.endsWith("/api/trials/run-1/regrade"), "trial id is globally addressable — no job id in the path");
    assertEqual(job.id, "regrade-1", "returns the regrade job");
    assertEqual(job.n_total_trials, 1, "one trial for a per-trial regrade");
    assertEqual(job.is_regrade, true, "is_regrade is true");
  } finally {
    restoreFetch();
  }
}

async function testRegradeIneligibleError() {
  console.log("\n--- trials().regrade() surfaces 409 regrade_source_ineligible ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1/regrade", {
      status: 409,
      body: {
        error: {
          code: "regrade_source_ineligible",
          message: "Trial used a shared-mode verifier; there is nothing faithful to re-run.",
        },
      },
    });
    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await t.regrade("run-1");
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

// =============================================================================
// jobs().download() — the results archive, with full integrity checks
// =============================================================================

async function testDownloadJobBuffer() {
  console.log("\n--- download() returns the gzip archive as a Buffer ---");
  installMockFetch();
  try {
    const archive = gzipSync(Buffer.from(JSON.stringify({ job: { id: "eval-1" } })));
    setMockResponse("/api/jobs/eval-1/download", {
      status: 200,
      body: null,
      bodyBytes: archive,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="job-eval-1-results.tar.gz"',
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const buf = await e.download("eval-1");

    assert(Buffer.isBuffer(buf), "returns a Buffer");
    assertEqual(buf.equals(archive), true, "buffer bytes match the archive");
    assert(
      fetchCalls[fetchCalls.length - 1].url.endsWith("/api/jobs/eval-1/download"),
      "hits the download route with no format param — the standard layout is the only layout"
    );
  } finally {
    restoreFetch();
  }
}

async function testDownloadJobToFile() {
  console.log("\n--- download({ to }) streams to a file named by Content-Disposition ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-download-${Date.now()}`);
  try {
    const archive = gzipSync(Buffer.from(JSON.stringify({ job: { id: "eval-1" } })));
    setMockResponse("/api/jobs/eval-1/download", {
      status: 200,
      body: null,
      bodyBytes: archive,
      headers: {
        "Content-Disposition": 'attachment; filename="job-eval-1-results.tar.gz"',
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const filePath = await e.download("eval-1", { to: tmpDir });

    assert(filePath.endsWith("job-eval-1-results.tar.gz"), "filename from Content-Disposition");
    const written = await readFile(filePath);
    assertEqual(written.equals(archive), true, "file bytes match the archive");
    const leftovers = (await readdir(tmpDir)).filter((name) => name.includes(".part"));
    assertEqual(leftovers.length, 0, "no .part scratch files are left behind");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testDownloadJobStream() {
  console.log("\n--- download({ stream: true }) returns the raw stream ---");
  installMockFetch();
  try {
    const archive = gzipSync(Buffer.from("stream-me"));
    setMockResponse("/api/jobs/eval-1/download", {
      status: 200,
      body: null,
      bodyBytes: archive,
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const stream = await e.download("eval-1", { stream: true });

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

async function testDownloadJobIntegrityChecks() {
  console.log("\n--- download() REFUSES truncated or digest-mismatched archives ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-download-bad-${Date.now()}`);
  try {
    const archive = gzipSync(Buffer.from("archive bytes"));
    // Truncated: the server promised more than it sent. This shape used to do
    // a bare pipeline with NO check while the package path had the full dance.
    setMockResponse("/api/jobs/eval-short/download", {
      status: 200,
      body: null,
      bodyBytes: archive,
      headers: {
        "Content-Disposition": 'attachment; filename="job-eval-short-results.tar.gz"',
        "Content-Length": String(archive.length + 1000),
      },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });

    let bufferThrew = false;
    try {
      await e.download("eval-short");
    } catch (error) {
      bufferThrew = error instanceof EvolveIncompleteDownloadError;
    }
    assert(bufferThrew, "the in-memory shape throws EvolveIncompleteDownloadError");

    let fileThrew = false;
    try {
      await e.download("eval-short", { to: tmpDir });
    } catch (error) {
      fileThrew = error instanceof EvolveIncompleteDownloadError;
    }
    assert(fileThrew, "the to-disk shape throws too");
    const left = await readdir(tmpDir).catch(() => [] as string[]);
    assertEqual(left, [], "no file and no partial left behind");

    // Digest mismatch, when the server states a digest.
    setMockResponse("/api/jobs/eval-bad/download", {
      status: 200,
      body: null,
      bodyBytes: archive,
      headers: {
        "Content-Disposition": 'attachment; filename="job-eval-bad-results.tar.gz"',
        "Content-Length": String(archive.length),
        "x-package-sha256": "f".repeat(64), // not the bytes above
      },
    });

    let digestThrewBuffer = false;
    try {
      await e.download("eval-bad");
    } catch (error) {
      digestThrewBuffer = error instanceof EvolveDigestMismatchError;
    }
    assert(digestThrewBuffer, "the in-memory shape verifies a stated digest");

    let digestThrewFile = false;
    try {
      await e.download("eval-bad", { to: tmpDir });
    } catch (error) {
      digestThrewFile = error instanceof EvolveDigestMismatchError;
    }
    assert(digestThrewFile, "the to-disk shape verifies it too");
    const badLeft = await readFile(join(tmpDir, "job-eval-bad-results.tar.gz")).catch(() => null);
    assertEqual(badLeft, null, "the mismatched file is removed, not left on disk");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testDownloadJobTerminalRequired() {
  console.log("\n--- download() surfaces 409 for non-terminal jobs ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/download", {
      status: 409,
      body: { error: { code: "job_not_terminal", message: "Job is RUNNING; download requires a terminal job" } },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.download("eval-1");
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
          { seq: 0, type: "job.created", data: { trial_count: 2 } },
          { seq: 1, type: "trial.settled", data: { trial_id: "run-1", task_name: "t1", status: "SCORED", reward: 1 } },
        ]) +
        ": heartbeat\n\n" +
        sseText([{ seq: 2, type: "job.completed", data: { job_id: "eval-1" } }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { ...JOB_SUMMARY, status: "COMPLETED" },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const events: JobEvent[] = [];
    const finalJob = await e.watch("eval-1", { onEvent: (ev) => events.push(ev) });

    assertEqual(events.length, 3, "3 events delivered (heartbeat comment skipped)");
    assertEqual(events[0], { seq: 0, type: "job.created", data: { trial_count: 2 } }, "maps first event");
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

async function testWatchHandlesEveryLineTerminator() {
  console.log("\n--- watch() parses CR and CRLF line terminators, split across chunks ---");
  installMockFetch();
  try {
    // The SSE grammar ends a line on CRLF, LF, or a LONE CR. This stream uses
    // all three, and splits one CRLF pair across two chunks — held-back CR
    // handling must read it as ONE terminator, not mint an extra frame.
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamChunks: [
        'id: 0\revent: job.created\rdata: {"trial_count": 1}\r\r',
        'id: 1\r\nevent: trial.settled\r',
        '\ndata: {"trial_id": "run-1"}\r\n\r\n',
        'id: 2\nevent: job.completed\ndata: {"job_id": "eval-1"}\n\n',
      ],
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { ...JOB_SUMMARY, status: "COMPLETED" },
    });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const events: JobEvent[] = [];
    const finalJob = await e.watch("eval-1", { onEvent: (ev) => events.push(ev) });

    assertEqual(events.length, 3, "3 events, no frame lost and none invented");
    assertEqual(events[0], { seq: 0, type: "job.created", data: { trial_count: 1 } }, "CR-terminated frame parsed");
    assertEqual(events[1], { seq: 1, type: "trial.settled", data: { trial_id: "run-1" } }, "chunk-split CRLF is one terminator");
    assertEqual(events[2].type, "job.completed", "LF frames still parse");
    assertEqual(finalJob.status, "COMPLETED", "resolves with the final job");
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
                  { seq: 1, type: "trial.running", data: { trial_id: "run-1", task_name: "t1" } },
                ])
              : sseText([{ seq: 2, type: "job.completed", data: { job_id: "eval-1" } }]),
        });
      }
      return buildMockResponse({
        status: 200,
        body: {
          ...JOB_SUMMARY,
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
      body: { ...JOB_SUMMARY, status: "CANCELLED" },
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
          streamBody: sseText([{ seq: 0, type: "job.completed", data: { job_id: "eval-1" } }]),
        });
      }
      return buildMockResponse({ status: 200, body: { ...JOB_SUMMARY, status: "COMPLETED" } });
    };

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const finalJob = await e.watch("eval-1", { reconnectDelayMs: 1 });

    assertEqual(eventsCalls, 2, "retried after the 503");
    assertEqual(finalJob.status, "COMPLETED", "resolves after the retry");
  } finally {
    restoreFetch();
  }
}

/**
 * The follow's retry delay is the SERVER's when the server states one, read by
 * the one law: envelope first (a cross-origin browser fetch cannot always see
 * the header), header second. The local backoff is only the guess used when
 * neither carries a number.
 */
async function testWatchHonorsRetryAfterOnReconnect() {
  console.log("\n--- watch() sleeps the server's Retry-After before reconnecting ---");
  try {
    let connects = 0;
    const follow = async (rateLimited: MockResponse) => {
      installMockFetch();
      connects = 0;
      (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
        const urlStr = url.toString();
        fetchCalls.push({ url: urlStr, init });
        if (urlStr.includes("/events")) {
          connects++;
          if (connects === 1) return buildMockResponse(rateLimited);
          return buildMockResponse({
            status: 200,
            body: null,
            streamBody: sseText([{ seq: 0, type: "job.completed", data: { job_id: "eval-1" } }]),
          });
        }
        return buildMockResponse({ status: 200, body: { ...JOB_SUMMARY, status: "COMPLETED" } });
      };
      const e = jobs({ apiKey: "test-key", baseUrl: BASE });
      const startedAt = Date.now();
      const finalJob = await e.watch("eval-1", { reconnectDelayMs: 1 });
      return { connects, elapsedMs: Date.now() - startedAt, status: finalJob.status };
    };

    const fromBody = await follow({
      status: 429,
      body: { error: { code: "rate_limited", message: "slow down", retryAfterSec: 0.08 } },
    });
    assertEqual(fromBody.connects, 2, "reconnected after the 429");
    assertEqual(fromBody.status, "COMPLETED", "resolves once the follow reconnects");
    assert(
      fromBody.elapsedMs >= 60,
      `waited the envelope's 80ms, not the 1ms local backoff (waited ${fromBody.elapsedMs}ms)`
    );

    const fromHeader = await follow({
      status: 503,
      body: { error: { code: "unavailable", message: "restarting" } },
      headers: { "retry-after": "0.08" },
    });
    assertEqual(fromHeader.connects, 2, "reconnected after the 503");
    assert(
      fromHeader.elapsedMs >= 60,
      `waited the header's 80ms when the envelope carried none (waited ${fromHeader.elapsedMs}ms)`
    );
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
      body: { ...JOB_SUMMARY, status: "RUNNING" },
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

async function testWatchAsIterator() {
  console.log("\n--- watch() is usable as an async iterator (for await) ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/events", {
      status: 200,
      body: null,
      streamBody:
        sseText([
          { seq: 0, type: "job.created", data: { trial_count: 2 } },
          { seq: 1, type: "trial.settled", data: { trial_id: "run-1", task_name: "t1", status: "SCORED" } },
        ]) +
        sseText([{ seq: 2, type: "job.completed", data: { job_id: "eval-1" } }]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { ...JOB_SUMMARY, status: "COMPLETED" },
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
        { seq: 0, type: "trial.settled", data: { trial_id: "run-1", task_name: "t1", status: "SCORED" } },
        { seq: 1, type: "trial.settled", data: { trial_id: "run-2", task_name: "t2", status: "SCORED" } },
        { seq: 2, type: "job.completed", data: { job_id: "eval-1" } },
      ]),
    });
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { ...JOB_SUMMARY, status: "COMPLETED" },
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
      body: { ...JOB_SUMMARY, status: "RUNNING" },
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

// =============================================================================
// TRIALS CLIENT — globally addressable
// =============================================================================

async function testTrialGet() {
  console.log("\n--- trials().get() maps the full trial by its global id ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1", {
      status: 200,
      body: wireTrial({
        exception_info: {
          exception_type: "ScoringError",
          exception_message: "x".repeat(5000), // detail route: untruncated
          exception_traceback: "trace",
          occurred_at: "2026-07-22T00:04:00.000Z",
        },
        status: "SCORING_ERROR",
        reward: null,
        verifier_result: null,
        verifier_environment_mode: "shared",
        verifier_sandbox_id: null,
      }),
    });
    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    const run = await t.get("run-1");

    assert(
      fetchCalls[0].url.endsWith("/api/trials/run-1"),
      "the trial id is globally addressable — no job id in the path"
    );
    assertEqual(run.id, "run-1", "maps id");
    assertEqual(run.job_id, "eval-1", "job_id is the reverse pointer on the body");
    assertEqual(run.agent_info.version, "codex-cli 0.145.0", "maps the resolved agent version");
    assertEqual(run.sandbox_provider, "daytona", "maps sandbox_provider");
    assertEqual(run.verifier_environment_mode, "shared", "maps verifier_environment_mode");
    assertEqual(run.verifier_sandbox_id, null, "shared-mode trial has no second box: null");
    assertEqual(run.max_trial_spend_usd, 2.5, "the cap THIS trial's key carried");
    assertEqual(run.session_ref, "sess-9", "maps session_ref");
    assertEqual(run.exception_info?.exception_message.length, 5000, "exception_message untruncated on the detail route");
    assertEqual(
      run.agent_info,
      {
        name: "codex",
        version: "codex-cli 0.145.0",
        model_info: { name: "gpt-5.5", provider: "openai" },
        reasoning_effort: null,
      },
      "agent_info reduced to the public shape"
    );
  } finally {
    restoreFetch();
  }
}

async function testTrialLiveSpend() {
  console.log("\n--- live_spent_usd maps beside the settled pair (and is null once settled) ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-live", {
      status: 200,
      body: wireTrial({
        id: "run-live",
        status: "RUNNING",
        reward: null,
        verifier_result: null,
        agent_result: null,
        spend_source: null,
        live_spent_usd: 0.0421,
        live_spend_at: "2026-07-22T00:02:00.000Z",
        finished_at: null,
      }),
    });
    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    const live = await t.get("run-live");
    assertEqual(live.live_spent_usd, 0.0421, "mid-run lower bound maps");
    assertEqual(live.live_spend_at, "2026-07-22T00:02:00.000Z", "its timestamp maps beside it");
    assertEqual(live.agent_result, null, "no settled agent_result while running");

    // Settled: the live pair is CLEARED by the server; the SDK passes the
    // nulls through rather than resurrecting a stale sample.
    setMockResponse("/api/trials/run-done", {
      status: 200,
      body: wireTrial({ id: "run-done", live_spent_usd: null, live_spend_at: null }),
    });
    const done = await t.get("run-done");
    assertEqual(done.live_spent_usd, null, "cleared on settle — the settled truth is agent_result.cost_usd");
    assertEqual(done.agent_result?.cost_usd, 0.93, "settled spend lives on agent_result.cost_usd");
    assertEqual(done.spend_source, "measured", "spend_source says the figure was measured");
  } finally {
    restoreFetch();
  }
}

async function testTrialTracePage() {
  console.log("\n--- trials().trace() forwards cursor/limit and maps the page ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1/trace", {
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

    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    const page = await t.trace("run-1", { cursor: "2", limit: 2 });

    const url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("/api/trials/run-1/trace"), "targets the global trace route");
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
    await t.trace("run-1");
    const bare = fetchCalls[fetchCalls.length - 1].url;
    assert(!bare.includes("cursor=") && !bare.includes("limit="), "no params by default");
  } finally {
    restoreFetch();
  }
}

async function testTraceEventsIterator() {
  console.log("\n--- trials().traceEvents() drains the trace page by page ---");
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

    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    const seqs: number[] = [];
    for await (const event of t.traceEvents("run-1")) {
      seqs.push(event.seq);
    }

    assertEqual(seqs, [1, 2, 3], "yields every event exactly once, in seq order");
    assertEqual(traceCalls, [null, "2"], "pages resume from nextCursor");

    // An explicit page limit changes nothing about when the drain ends: the
    // null cursor is the signal, not a short page.
    fetchCalls.length = 0;
    traceCalls.length = 0;
    const seqsLimited: number[] = [];
    for await (const event of t.traceEvents("run-1", { limit: 2 })) {
      seqsLimited.push(event.seq);
    }
    assertEqual(seqsLimited, [1, 2, 3], "limited drain still yields every event");
    assertEqual(traceCalls, [null, "2"], "the null cursor ends the drain");
  } finally {
    restoreFetch();
  }
}

async function testTrialArtifact() {
  console.log("\n--- trials().artifact() selects raw streams; null = never stored ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1/trace?stream=verifier", {
      status: 200,
      body: { log: "PASS: all 3 checks" },
    });
    setMockResponse("/api/trials/run-1/trace?stream=agent-home", {
      status: 200,
      body: { files: { "/home/user/.codex/session.jsonl": "{}" } },
    });
    setMockResponse("/api/trials/run-2/trace?stream=trace-stdout", {
      status: 200,
      body: { log: null },
    });

    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    const log = await t.artifact("run-1", "verifier");
    assertEqual(log, "PASS: all 3 checks", "log selectors answer the text");
    const home = await t.artifact("run-1", "agent-home");
    assertEqual(
      home,
      { "/home/user/.codex/session.jsonl": "{}" },
      "agent-home answers the sandbox-path → text map"
    );
    const none = await t.artifact("run-2", "trace-stdout");
    assertEqual(none, null, "null = never stored — a normal answer, not an error");
  } finally {
    restoreFetch();
  }
}

async function testStopTrials() {
  console.log("\n--- trials().stop() kills selected trials and reports every id once ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/stop", {
      status: 200,
      body: {
        stopped: [wireTrial({ id: "run-1", status: "CANCELLED" })],
        already_terminal: ["run-2"],
        not_found: ["run-x"],
      },
    });

    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    const outcome = await t.stop(["run-1", "run-2", "run-x"]);

    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/trials/stop"), "hits the stop route");
    assertEqual(call.init?.method, "POST", "uses POST");
    assertEqual(
      JSON.parse(call.init?.body as string),
      { trial_ids: ["run-1", "run-2", "run-x"] },
      "sends trial_ids"
    );
    assertEqual(outcome.stopped.length, 1, "stopped carries the settled rows");
    assertEqual(outcome.stopped[0].status, "CANCELLED", "the stopped trial is settled");
    assertEqual(outcome.already_terminal, ["run-2"], "already-terminal ids reported, untouched");
    // Someone else's trial reads not_found — existence is never leaked.
    assertEqual(outcome.not_found, ["run-x"], "unknown/foreign ids reported as not_found");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// COMPARE
// =============================================================================

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
            datasets: [{ name: "deep-swe", version: "1.1" }],
            status: "COMPLETED",
            mean_reward: 0.5,
            coverage: { scored: 4, total: 5 },
            cost_usd: 12.5,
            agents: [
              { name: "codex", model_name: "gpt-5.5", version: null, reasoning_effort: null },
            ],
            started_at: "2026-07-22T00:00:00.000Z",
          },
          {
            id: "eval-2",
            datasets: [{ name: "deep-swe", version: "1.1" }],
            status: "COMPLETED",
            mean_reward: 0, // zero is a reward, not a missing value
            coverage: { scored: 5, total: 5 },
            cost_usd: 9.1,
            agents: [
              { name: "claude", model_name: "sonnet", version: "2.1.0", reasoning_effort: null },
            ],
            started_at: "2026-07-22T01:00:00.000Z",
          },
        ],
        taskMatrix: [
          {
            task_name: "abs-module-cache-flags",
            disagreement: true,
            cells: [
              { job_id: "eval-1", status: "SCORED", mean_reward: 1, coverage: { scored: 1, total: 1 } },
              { job_id: "eval-2", status: "MISSING", mean_reward: null, coverage: { scored: 0, total: 0 } },
            ],
          },
          {
            task_name: "zlib-stream-reset",
            disagreement: false,
            cells: [
              { job_id: "eval-1", status: "SCORED", mean_reward: 0, coverage: { scored: 1, total: 1 } },
              { job_id: "eval-2", status: "SCORED", mean_reward: 0, coverage: { scored: 1, total: 1 } },
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
    assertEqual(comparison.jobs[0].mean_reward, 0.5, "maps mean_reward");
    assertEqual(comparison.jobs[0].coverage, { scored: 4, total: 5 }, "maps coverage");
    assertEqual(comparison.jobs[0].cost_usd, 12.5, "maps cost_usd");
    assertEqual(comparison.jobs[1].mean_reward, 0, "zero mean_reward preserved (never nulled)");
    assertEqual(
      comparison.jobs[0].agents,
      [{ name: "codex", model_name: "gpt-5.5", version: null, reasoning_effort: null }],
      "agents is the public arm shape (wire sends nothing internal)"
    );
    const system = comparison.jobs[0].agents[0] as Record<string, unknown>;
    assert(!("id" in system), "internal agent id not exposed");

    assertEqual(comparison.taskMatrix.length, 2, "maps matrix rows (frozen taskMatrix key)");
    assertEqual(comparison.taskMatrix[0].disagreement, true, "maps disagreement flag");
    assertEqual(
      comparison.taskMatrix[0].cells[1],
      { job_id: "eval-2", status: "MISSING", mean_reward: null, coverage: { scored: 0, total: 0 } },
      "MISSING cell preserved"
    );
    assertEqual(comparison.taskMatrix[1].cells[0].mean_reward, 0, "zero cell mean_reward preserved");
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
      body: { error: { code: "invalid_ids", message: "ids must list between 2 and 10 distinct job ids (comma-separated)" } },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.compare(["eval-1"]);
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.code, "invalid_ids", "carries the stable error code");
      assert(err.message.includes("between 2 and 10"), "message is the server's product sentence");
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
    setMockResponse("/api/datasets", {
      status: 401,
      body: { error: { code: "invalid_api_key", message: "Invalid API key" } },
    });
    const d = datasets({ apiKey: "bad-key", baseUrl: BASE });
    let threw = false;
    try {
      await d.list();
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
    setMockResponse("/api/datasets", { status: 502, body: null, streamBody: "Bad Gateway" });
    let threwRaw = false;
    try {
      await d.list();
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
// ERGONOMICS: getActive, auto-pagination, root exports
// =============================================================================

async function testGetActive() {
  console.log("\n--- datasets().getActive() resolves the active version to a runnable shape ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/deep-swe", {
      status: 200,
      body: {
        name: "deep-swe",
        title: "DeepSWE",
        description: "SWE tasks",
        active_version: { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113 },
        versions: [
          { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113 },
          { version: "1.0", state: "ARCHIVED", created_at: "2026-07-01T00:00:00.000Z", task_count: 100 },
        ],
        selected_version: { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113 },
        tasks: {
          items: [
            {
              task_name: "abs-module-cache-flags",
              agent_timeout_sec: 5400,
              verifier_timeout_sec: 1800,
              providers: { e2b: { ok: true }, daytona: { ok: true }, modal: { ok: true } },
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-21T00:00:00.000Z",
      },
    });

    const catalog = datasets({ apiKey: "test-key", baseUrl: BASE });
    const active = await catalog.getActive("deep-swe");

    const url = fetchCalls[fetchCalls.length - 1].url;
    assert(!url.includes("version="), "getActive resolves the bare name (active version's tasks)");

    assertEqual(active.version, "1.1", "version is the active version string (non-optional)");
    assertEqual(active.active_version.state, "READY", "active_version carries the full version object");
    assertEqual(active.tasks.items.length, 1, "tasks is populated (non-optional)");
    assertEqual(active.tasks.items[0].task_name, "abs-module-cache-flags", "maps public task fields");
    assertEqual(active.versions.length, 2, "carries all versions");
    assertEqual(active.tasks.items[0].providers, { e2b: { ok: true }, daytona: { ok: true }, modal: { ok: true } }, "tasks carry provider verdicts");
    assert(!("selected_version" in active), "ActiveDataset has no selected_version (it IS the active one)");
  } finally {
    restoreFetch();
  }
}

async function testGetActiveNoActiveVersion() {
  console.log("\n--- datasets().getActive() throws NoActiveVersionError when none is active ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/draft-set", {
      status: 200,
      body: {
        name: "draft-set",
        title: null,
        description: null,
        active_version: null,
        versions: [
          { version: "0.1", state: "DRAFT", created_at: "2026-07-21T00:00:00.000Z", task_count: 0 },
        ],
        selected_version: null,
        tasks: [],
        created_at: "2026-07-21T00:00:00.000Z",
        updated_at: "2026-07-21T00:00:00.000Z",
      },
    });

    const catalog = datasets({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await catalog.getActive("draft-set");
    } catch (err: any) {
      threw = true;
      assert(err instanceof NoActiveVersionError, "throws NoActiveVersionError");
      assert(err.message.includes("no active version"), "message explains there is no active version");
      assertEqual(err.dataset, "draft-set", "error carries the dataset name");
    }
    assert(threw, "getActive throws when no version is active");
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
            { ...JOB_SUMMARY, id: "eval-2" },
            { ...JOB_SUMMARY, id: "eval-1" },
          ],
          nextCursor: "eval-1",
        },
        "eval-1": {
          items: [{ ...JOB_SUMMARY, id: "eval-0" }],
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
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      const cursor = new URL(urlStr).searchParams.get("cursor");
      const pages: Record<string, unknown> = {
        "": {
          items: [wireTrial({ id: "run-1", attempt: 1 }), wireTrial({ id: "run-2", attempt: 2 })],
          nextCursor: "run-2",
          hasMore: true,
        },
        "run-2": { items: [wireTrial({ id: "run-3", attempt: 3 })], nextCursor: null, hasMore: false },
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

async function testRootExportsHostedTypes() {
  console.log("\n--- package root re-exports the documented hosted types ---");

  // Compile-time: the type import at the top of this file fails if the root
  // export block drops EvalSandboxProvider. Runtime sanity on its shape:
  const provider: RootEvalSandboxProvider = "modal";
  assertEqual(provider, "modal", "EvalSandboxProvider importable from package root");

  // Source: the hosted export block in src/index.ts names the documented types
  const rootSrc = await readFile(new URL("../../src/index.ts", import.meta.url), "utf-8");
  for (const t of ["EvalSandboxProvider", "DatasetImportFailure", "JobCreate", "JobStatus", "DatasetSelector", "AgentInput", "TrialsClient"]) {
    assert(new RegExp(`type ${t},`).test(rootSrc), `src/index.ts exports type ${t}`);
  }

  // Built dist: the declaration file users consume must carry the type
  const distDts = await readFile(new URL("../../dist/index.d.ts", import.meta.url), "utf-8");
  assert(distDts.includes("EvalSandboxProvider"), "dist/index.d.ts declares EvalSandboxProvider");
}

async function testSpecShipsInPackage() {
  console.log("\n--- the API contract ships inside the npm package ---");
  // The spec is what downstream drift gates diff the SDK against; a package
  // without it cannot be checked. files[] is what `npm pack` reads.
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf-8")
  ) as { files: string[] };
  assert(pkg.files.includes("spec"), 'package.json files[] carries "spec"');
  const spec = await readFile(new URL("../../spec/openapi.yaml", import.meta.url), "utf-8");
  assert(spec.includes("openapi: 3.1.0"), "spec/openapi.yaml is present in the package tree after build");
  assert(spec.includes("/api/datasets/publish"), "the shipped spec is the renamed contract");
}

// =============================================================================
// datasets().download() — the OWNER-ONLY corpus retrieval
// =============================================================================

async function testDownloadPackageBuffer() {
  console.log("\n--- datasets().download() returns the corpus tarball as a Buffer ---");
  installMockFetch();
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/datasets/acme/download", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="acme@1.1-corpus.tar.gz"',
        "x-package-sha256": createHash("sha256").update(pkg).digest("hex"),
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const buf = await d.download("acme@1.1");

    assert(Buffer.isBuffer(buf), "returns a Buffer");
    assertEqual(buf.equals(pkg), true, "buffer bytes match the stored package");
    const url = fetchCalls[0].url;
    assert(url.includes("/api/datasets/acme/download"), "hits the download route on the dataset name");
    assert(url.includes("version=1.1"), "ref version becomes ?version=");

    // Bare name: the active version's package, no version param.
    await d.download("acme");
    assert(!fetchCalls[fetchCalls.length - 1].url.includes("version="), "bare name omits version param");
  } finally {
    restoreFetch();
  }
}

async function testDownloadPackageToFile() {
  console.log("\n--- download({ to }) saves under the server-chosen filename ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-package-${Date.now()}`);
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/datasets/acme/download", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: {
        "Content-Disposition": 'attachment; filename="acme@1.1-corpus.tar.gz"',
        "x-package-sha256": createHash("sha256").update(pkg).digest("hex"),
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const filePath = await d.download("acme@1.1", { to: tmpDir });

    assert(filePath.endsWith("acme@1.1-corpus.tar.gz"), "filename from Content-Disposition");
    const written = await readFile(filePath);
    assertEqual(written.equals(pkg), true, "file bytes match the stored package");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testDownloadPackageStream() {
  console.log("\n--- download({ stream: true }) returns the raw stream ---");
  installMockFetch();
  try {
    const pkg = gzipSync(Buffer.from("stream-the-corpus"));
    setMockResponse("/api/datasets/acme/download", {
      status: 200,
      body: null,
      bodyBytes: pkg,
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const stream = await d.download("acme", { stream: true });

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
  console.log("\n--- download() REFUSES bytes that fail the stated digest ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-package-bad-${Date.now()}`);
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/datasets/acme-bad/download", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: {
        "Content-Disposition": 'attachment; filename="acme@1.1-corpus.tar.gz"',
        "x-package-sha256": "f".repeat(64), // not the bytes above
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });

    let bufferThrew = false;
    try {
      await d.download("acme-bad");
    } catch (error) {
      bufferThrew = error instanceof EvolveDigestMismatchError;
    }
    assert(bufferThrew, "the in-memory shape throws EvolveDigestMismatchError");

    let fileThrew = false;
    try {
      await d.download("acme-bad", { to: tmpDir });
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
  console.log("\n--- download() REFUSES a body shorter than Content-Length ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-package-short-${Date.now()}`);
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/datasets/acme-short/download", {
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

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });

    let bufferThrew = false;
    try {
      await d.download("acme-short");
    } catch (error) {
      bufferThrew = error instanceof EvolveIncompleteDownloadError;
    }
    assert(bufferThrew, "the in-memory shape throws EvolveIncompleteDownloadError");

    let fileThrew = false;
    try {
      await d.download("acme-short", { to: tmpDir });
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
  console.log("\n--- download({ to }) refuses a traversing Content-Disposition ---");
  installMockFetch();
  const parent = join(tmpdir(), `hosted-package-esc-${Date.now()}`);
  const tmpDir = join(parent, "inner");
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/datasets/acme-esc/download", {
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

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const filePath = await d.download("acme-esc", { to: tmpDir });

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

async function testDownloadPackageBackslashFilename() {
  console.log("\n--- download({ to }) refuses a backslash filename rather than repairing it ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-package-bs-${Date.now()}`);
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes"));
    setMockResponse("/api/datasets/acme-bs/download", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: {
        "Content-Disposition": 'attachment; filename="a\\b.tar.gz"',
        "Content-Length": String(pkg.length),
        "x-package-sha256": createHash("sha256").update(pkg).digest("hex"),
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const filePath = await d.download("acme-bs", { to: tmpDir });

    // PARITY: Python used to translate the backslash to a separator and save
    // "b.tar.gz" while this SDK fell back — one response, two files. Refusing
    // is the half that was kept: on POSIX "a\b.tar.gz" is ONE legal filename,
    // so treating the backslash as a separator renames the user's file on a
    // guess about which platform wrote the header.
    assert(
      filePath.endsWith("acme-bs-corpus.tar.gz"),
      "falls back to the SDK's own name",
    );
    assert(!filePath.endsWith("b.tar.gz"), "does not silently rewrite it to b.tar.gz");
    const written = await readFile(filePath);
    assertEqual(written.equals(pkg), true, "the package still lands intact");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testDownloadPackageConcurrent() {
  console.log("\n--- two concurrent downloads into one directory BOTH succeed ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `hosted-package-race-${Date.now()}`);
  try {
    const pkg = gzipSync(Buffer.from("corpus bytes for the race"));
    setMockResponse("/api/datasets/acme-race/download", {
      status: 200,
      body: null,
      bodyBytes: pkg,
      headers: {
        "Content-Disposition": 'attachment; filename="acme@1.1-corpus.tar.gz"',
        "Content-Length": String(pkg.length),
        "x-package-sha256": createHash("sha256").update(pkg).digest("hex"),
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    // Both calls resolve the SAME final path. When the scratch file was
    // `<file>.part` verbatim they wrote into one file and the loser died on a
    // bare ENOENT from rename — and the digest each had checked described a
    // stream, not the bytes that landed.
    const results = await Promise.allSettled([
      d.download("acme-race", { to: tmpDir }),
      d.download("acme-race", { to: tmpDir }),
    ]);

    const rejected = results.filter(r => r.status === "rejected");
    assertEqual(
      rejected.length,
      0,
      `neither call fails${rejected.length ? `: ${String((rejected[0] as PromiseRejectedResult).reason)}` : ""}`,
    );
    const paths = results.map(r => (r as PromiseFulfilledResult<string>).value);
    assertEqual(paths[0], paths[1], "both report the same promoted path");
    const written = await readFile(paths[0]);
    assertEqual(written.equals(pkg), true, "the promoted file is the whole package");
    // No scratch file survives either call.
    const leftovers = (await readdir(tmpDir)).filter(name => name.includes(".part"));
    assertEqual(leftovers.length, 0, "no .part scratch files are left behind");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testDownloadPackageNotRetained() {
  console.log("\n--- download() surfaces package_not_retained as a typed code ---");
  installMockFetch();
  try {
    setMockResponse("/api/datasets/old-set/download", {
      status: 409,
      body: {
        error: {
          code: "package_not_retained",
          message: "No original package is stored for dataset old-set.",
        },
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    let code: string | undefined;
    try {
      await d.download("old-set");
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    // Distinct from not-found so a client can say WHY rather than guess.
    assertEqual(code, "package_not_retained", "typed code reaches the caller");
    assert(isHostedErrorCode("package_not_retained"), "code is in the closed vocabulary");
  } finally {
    restoreFetch();
  }
}

async function main() {
  console.log("Hosted Evals Client Unit Tests\n");

  await testRootExportsHostedTypes();
  await testSpecShipsInPackage();
  await testFactoriesRequireApiKey();
  await testDatasetsList();
  await testDatasetsGet();
  await testDatasetGateMapping();
  await testGetActive();
  await testGetActiveNoActiveVersion();
  await testDatasetUpdate();
  await testPublishGitSource();
  await testPublishRequiresGitSource();
  await testPublishDirectorySource();
  await testPublishManifestDerivedIdentity();
  await testPublishDirectoryWithoutManifestNeedsIdentity();
  await testPublishGitSourceRequiresIdentity();
  await testVersionManifestMapping();
  await testGetImport();
  await testWatchImportPollsToTerminal();
  await testWatchImportSurvivesRateLimit();
  await testAgentCreateInstallScript();
  await testAgentCreateTarball();
  await testAgentCreateRequiresOneSource();
  await testAgentListGetDelete();
  await testAgentNotFoundIsTypedError();
  await testAgentNameTakenIsTypedError();
  await testStartPostsInputContract();
  await testStartOmitsAbsentSpendCap();
  await testStartIdempotentReplay();
  await testStartUnknownAgentVersionIsTypedError();
  await testStartInsufficientCreditsIsTypedError();
  await testStartNonExactVersionIsTypedError();
  await testGetJobDetail();
  await testListJobs();
  await testListAutoPagination();
  await testTrials();
  await testTrialsAutoPagination();
  await testCancel();
  await testResume();
  await testResumeConflictError();
  await testRegradeJob();
  await testRegradeTrialReturnsJob();
  await testRegradeIneligibleError();
  await testDownloadJobBuffer();
  await testDownloadJobToFile();
  await testDownloadJobStream();
  await testDownloadJobIntegrityChecks();
  await testDownloadJobTerminalRequired();
  await testDownloadPackageBuffer();
  await testDownloadPackageToFile();
  await testDownloadPackageStream();
  await testDownloadPackageDigestMismatch();
  await testDownloadPackageTruncated();
  await testDownloadPackageFilenameTraversal();
  await testDownloadPackageBackslashFilename();
  await testDownloadPackageConcurrent();
  await testDownloadPackageNotRetained();
  await testWatchStreamsToTerminal();
  await testWatchHandlesEveryLineTerminator();
  await testWatchAsIterator();
  await testWatchIteratorEarlyBreak();
  await testWatchIteratorAbort();
  await testWatchResumesWithLastEventId();
  await testWatchFallsBackToStatusOnQuietClose();
  await testWatchRetriesOn5xx();
  await testWatchHonorsRetryAfterOnReconnect();
  await testWatchThrowsOnNonRetryableError();
  await testWatchAbort();
  await testTrialGet();
  await testTrialLiveSpend();
  await testTrialTracePage();
  await testTraceEventsIterator();
  await testTrialArtifact();
  await testStopTrials();
  await testCompare();
  await testCompareBadIdsError();
  await testApiErrorHandling();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`${"=".repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
