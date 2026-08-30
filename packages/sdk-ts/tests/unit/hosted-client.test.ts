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
 * with import warnings and the watch's SETTLE phase (past import COMPLETED the
 * version is followed on the dataset detail to READY/ARCHIVED/FAILED, with the
 * typed ImportSettleError refusals), compare aggregates + task matrix, globally addressable
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

import { existsSync } from "node:fs";
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
  skills,
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
            // The newest version row is a DIFFERENT row from the active one:
            // a FAILED 1.2 can never activate, so the two pointers disagree
            // and the mapper must carry the server's own field rather than
            // echoing active_version.
            latest_version: { version: "1.2", state: "FAILED", created_at: "2026-07-22T00:00:00.000Z", task_count: 0 },
          },
          {
            name: "empty-set",
            title: null,
            description: null,
            active_version: null,
          },
          {
            // A FIRST import: nothing is active for the whole
            // IMPORTING -> BUILDING walk, and latest_version is the only
            // field on the row with anything to say during it.
            name: "first-import",
            title: null,
            description: null,
            active_version: null,
            latest_version: { version: "1.0", state: "IMPORTING", created_at: "2026-07-23T00:00:00.000Z", task_count: 0 },
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const catalog = await d.list();

    // The one page envelope, the same on every collection this surface returns.
    assertEqual(catalog.items.length, 3, "returns 3 datasets");
    assertEqual(catalog.nextCursor, null, "nextCursor null = no next page");
    assertEqual(catalog.hasMore, false, "hasMore says the same as a boolean");
    assertEqual(catalog.items[0].name, "deep-swe", "maps name");
    assertEqual(catalog.items[0].title, "DeepSWE", "maps title");
    assertEqual(
      catalog.items[0].active_version,
      { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113, n_failed_tasks: 0, manifest: null, source: null },
      "maps active_version object (one shape: version/state/created_at/task_count/manifest/source; manifest/source null on older servers)"
    );
    assertEqual(catalog.items[1].active_version, null, "null active_version preserved");

    // latest_version is its OWN pointer, in the same version shape.
    assertEqual(
      catalog.items[0].latest_version,
      { version: "1.2", state: "FAILED", created_at: "2026-07-22T00:00:00.000Z", task_count: 0, n_failed_tasks: 0, manifest: null, source: null },
      "maps latest_version as its own version object, not a copy of active_version"
    );
    assertEqual(
      catalog.items[2].latest_version?.state,
      "IMPORTING",
      "a first import is observable from the list alone: latest_version walks while active_version is still null"
    );
    assertEqual(catalog.items[2].active_version, null, "…and that row really has nothing active");
    // An older server does not send the key at all — that reads as null, the
    // same absence a dataset with no version rows reports.
    assertEqual(catalog.items[1].latest_version, null, "a body without latest_version reads as null");

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
        // The detail route carries the same pointer the list does, and here
        // too it names a DIFFERENT row than active_version.
        latest_version: { version: "1.2", state: "BUILDING", created_at: "2026-07-22T00:00:00.000Z", task_count: 113 },
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
            {
              task_name: "no-verdict-yet",
              agent_timeout_sec: 600,
              verifier_timeout_sec: 600,
              providers: { e2b: { ok: true }, daytona: { ok: true }, modal: { ok: true } },
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
    assertEqual(
      detail.latest_version,
      { version: "1.2", state: "BUILDING", created_at: "2026-07-22T00:00:00.000Z", task_count: 113, n_failed_tasks: 0, manifest: null, source: null },
      "detail maps latest_version too — the newest row, which here is NOT the active one"
    );
    assertEqual(detail.versions?.length, 2, "maps versions");
    assertEqual(
      detail.selected_version,
      { version: "1.1", state: "READY", created_at: "2026-07-21T00:00:00.000Z", task_count: 113, n_failed_tasks: 0, manifest: null, source: null },
      "selected_version is a full version object (never a bare label; manifest/source null when the server sends none)"
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

/**
 * The partial-publish model's read surfaces: a version's per-task outcome
 * counts (n_failed_tasks), the dataset detail's failed_tasks reasons, and
 * the per-task build route (datasets().getTaskBuild()) — the one place the
 * failing-step excerpt and the build-log pointer live.
 */
async function testPartialPublishReads() {
  console.log("\n--- datasets(): partial-publish reads — n_failed_tasks, failed_tasks, getTaskBuild() ---");
  installMockFetch();
  try {
    // The per-task build route: FAILED answers the typed reason WITH the
    // excerpt and the full build-log pointer.
    setMockResponse("/api/datasets/part-swe/versions/2.0/tasks/broken-dockerfile/build", {
      status: 200,
      body: {
        task_name: "broken-dockerfile",
        state: "FAILED",
        failure: {
          code: "image_build_failed",
          step: "image-build",
          message: "RUN apt-get install nonexistent-pkg exited 100",
          excerpt: "#12 ERROR: process \"apt-get install nonexistent-pkg\" exited 100",
        },
        build_log_ref: "cloudwatch://dataset-builds/part-swe-2.0-broken-dockerfile",
      },
    });
    setMockResponse("/api/datasets/part-swe/versions/2.0/tasks/good-task/build", {
      status: 200,
      body: { task_name: "good-task", state: "READY", failure: null, build_log_ref: null },
    });
    setMockResponse("/api/datasets/part-swe", {
      status: 200,
      body: {
        name: "part-swe",
        title: null,
        description: null,
        active_version: { version: "2.0", state: "READY", created_at: "2026-08-20T00:00:00.000Z", task_count: 10, n_failed_tasks: 2 },
        latest_version: { version: "2.0", state: "READY", created_at: "2026-08-20T00:00:00.000Z", task_count: 10, n_failed_tasks: 2 },
        versions: [
          { version: "2.0", state: "READY", created_at: "2026-08-20T00:00:00.000Z", task_count: 10, n_failed_tasks: 2 },
        ],
        selected_version: { version: "2.0", state: "READY", created_at: "2026-08-20T00:00:00.000Z", task_count: 10, n_failed_tasks: 2 },
        tasks: { items: [], nextCursor: null, hasMore: false },
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
        created_at: "2026-08-20T00:00:00.000Z",
        updated_at: "2026-08-20T00:00:00.000Z",
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const detail = await d.get("part-swe@2.0");
    assertEqual(detail.selected_version?.n_failed_tasks, 2, "n_failed_tasks mapped on the version object");
    assertEqual(detail.selected_version?.task_count, 10, "task_count stays the READY (runnable) count");
    assertEqual(detail.failed_tasks?.length, 2, "the detail's failed_tasks list is mapped");
    assertEqual(
      detail.failed_tasks?.[0],
      {
        task_name: "broken-dockerfile",
        failure: { code: "image_build_failed", step: "image-build", message: "RUN apt-get install nonexistent-pkg exited 100", excerpt: null },
      },
      "each entry carries the typed reason (compact — no excerpt on list surfaces)"
    );

    const failedBuild = await d.getTaskBuild("part-swe@2.0", "broken-dockerfile");
    assert(
      fetchCalls[fetchCalls.length - 1].url.includes("/api/datasets/part-swe/versions/2.0/tasks/broken-dockerfile/build"),
      "targets the per-task build route"
    );
    assertEqual(failedBuild.state, "FAILED", "maps the per-task state");
    assertEqual(
      failedBuild.failure?.excerpt,
      "#12 ERROR: process \"apt-get install nonexistent-pkg\" exited 100",
      "the failing-step excerpt lives here"
    );
    assertEqual(
      failedBuild.build_log_ref,
      "cloudwatch://dataset-builds/part-swe-2.0-broken-dockerfile",
      "the full build-log pointer lives here"
    );

    // READY tasks answer too — failure and log pointer null, no
    // negative-space reasoning for a poller.
    const readyBuild = await d.getTaskBuild("part-swe@2.0", "good-task");
    assertEqual(readyBuild.state, "READY", "READY tasks answer too");
    assertEqual(readyBuild.failure, null, "failure null on READY");
    assertEqual(readyBuild.build_log_ref, null, "log pointer null on READY");

    // The outcome belongs to ONE immutable version, so a bare name refuses
    // client-side instead of guessing the active version.
    let refused = false;
    try {
      await d.getTaskBuild("part-swe", "broken-dockerfile");
    } catch (error) {
      refused = true;
      assert((error as Error).message.includes("name@version"), "the refusal names the required grammar");
    }
    assert(refused, "getTaskBuild refuses a version-less ref");

    // An older server that sends none of the new fields reads as a fully
    // built version — never a crash.
    setMockResponse("/api/datasets/old-swe", {
      status: 200,
      body: {
        name: "old-swe",
        title: null,
        description: null,
        active_version: { version: "1.0", state: "READY", created_at: "2026-01-01T00:00:00.000Z", task_count: 5 },
        latest_version: null,
        versions: [{ version: "1.0", state: "READY", created_at: "2026-01-01T00:00:00.000Z", task_count: 5 }],
        selected_version: { version: "1.0", state: "READY", created_at: "2026-01-01T00:00:00.000Z", task_count: 5 },
        tasks: { items: [], nextCursor: null, hasMore: false },
        upstream: null,
      },
    });
    const older = await d.get("old-swe");
    assertEqual(older.selected_version?.n_failed_tasks, 0, "absent n_failed_tasks reads as 0 (older server)");
    assertEqual(older.failed_tasks, [], "absent failed_tasks reads as an empty list (older server)");
  } finally {
    restoreFetch();
  }
}

/**
 * The job body's `build_exclusions` — the results-honesty label ("ran N of
 * M") — maps on every job read, and an older server that sends none reads as
 * "nothing excluded".
 */
async function testJobBuildExclusionsMapping() {
  console.log("\n--- jobs().get() maps build_exclusions (the ran-N-of-M honesty label) ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-part", {
      status: 200,
      body: {
        id: "eval-part",
        job_name: "partial run",
        status: "RUNNING",
        datasets: [{ name: "part-swe", version: "2.0" }],
        n_attempts: 1,
        n_concurrent_trials: 4,
        max_trial_spend_usd: 2.5,
        worst_case_spend_usd: 25,
        sandbox_provider: "e2b",
        agents: [{ name: "codex", model_name: "gpt-5.5", version: null, reasoning_effort: null }],
        counts: { agents: 1, tasks: 10 },
        build_exclusions: [
          // Capped run: n_tasks_selected is the pre-cap matched-READY count,
          // and the note is the two-reasons capped form.
          {
            dataset: { name: "part-swe", version: "2.0" },
            n_tasks_ran: 5,
            n_tasks_selected: 100,
            n_tasks_failed_to_build: 10,
            failed_task_names: ["broken-dockerfile", "schema-typo"],
            note: "selection matched 110 tasks: 10 failed to build: broken-dockerfile, schema-typo, …; ran 5 (n_tasks cap)",
          },
          // A body recorded before n_tasks_selected existed (older server
          // mid-deploy): the mapper answers it as n_tasks_ran — uncapped.
          {
            dataset: { name: "old-swe", version: "1.0" },
            n_tasks_ran: 10,
            n_tasks_failed_to_build: 2,
            failed_task_names: ["broken-dockerfile", "schema-typo"],
            note: "ran 10 of 12 tasks — 2 failed to build (broken-dockerfile, schema-typo)",
          },
        ],
        n_total_trials: 10,
        trials: { total: 10, byStatus: zeroTrialStatuses({ QUEUED: 10 }) },
        stats: {},
        failure: null,
        source_jobs: [],
        is_regrade: false,
        idempotent_replay: false,
        started_at: "2026-08-22T00:00:00.000Z",
        updated_at: "2026-08-22T00:00:00.000Z",
        finished_at: null,
      },
    });
    const client = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await client.get("eval-part");
    assertEqual(job.build_exclusions.length, 2, "build_exclusions mapped");
    assertEqual(
      job.build_exclusions[0],
      {
        dataset: { name: "part-swe", version: "2.0" },
        n_tasks_ran: 5,
        n_tasks_selected: 100,
        n_tasks_failed_to_build: 10,
        failed_task_names: ["broken-dockerfile", "schema-typo"],
        note: "selection matched 110 tasks: 10 failed to build: broken-dockerfile, schema-typo, …; ran 5 (n_tasks cap)",
      },
      "the whole exclusion survives the mapping — note verbatim, counts and names intact"
    );
    assertEqual(
      job.build_exclusions[1].n_tasks_selected,
      10,
      "a body without n_tasks_selected answers it as n_tasks_ran — read as uncapped"
    );
  } finally {
    restoreFetch();
  }
}

async function testVersionSourceMapping() {
  console.log("\n--- datasets().get() maps per-version git provenance (source), incl. a FAILED version ---");
  installMockFetch();
  try {
    // The Q5 shape: an annotated-tag import COMPLETED, the build
    // FAILED, the dataset never gained an active version — and the resolved
    // PEELED commit must still be observable on the version object itself.
    setMockResponse("/api/datasets/q5-tagpeel", {
      status: 200,
      body: {
        name: "q5-tagpeel",
        title: null,
        description: null,
        active_version: null,
        versions: [
          {
            version: "1.0",
            state: "FAILED",
            created_at: "2026-08-05T00:00:00.000Z",
            task_count: 2,
            source: {
              git_url: "https://github.com/laude-institute/harbor",
              ref: "v0.20.0",
              commit: "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc",
              path: "examples/tasks/network-policy-matrix/extra-allowed-hosts",
            },
          },
          // A non-git version (uploaded tarball): source is null on the wire.
          { version: "0.9", state: "READY", created_at: "2026-08-01T00:00:00.000Z", task_count: 2, source: null },
          // Garbage source value: never a crash, always null.
          { version: "0.8", state: "READY", created_at: "2026-07-01T00:00:00.000Z", task_count: 2, source: "oops" },
        ],
        selected_version: {
          version: "1.0",
          state: "FAILED",
          created_at: "2026-08-05T00:00:00.000Z",
          task_count: 2,
          source: {
            git_url: "https://github.com/laude-institute/harbor",
            ref: "v0.20.0",
            commit: "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc",
            path: "examples/tasks/network-policy-matrix/extra-allowed-hosts",
          },
        },
        tasks: { items: [], nextCursor: null, hasMore: false },
        upstream: null,
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const detail = await d.get("q5-tagpeel@1.0");
    const [failed, upload, garbage] = detail.versions ?? [];

    assertEqual(
      failed.source,
      {
        git_url: "https://github.com/laude-institute/harbor",
        ref: "v0.20.0",
        commit: "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc",
        path: "examples/tasks/network-policy-matrix/extra-allowed-hosts",
      },
      "a FAILED git version serves its full provenance — url, requested ref, PEELED commit, subfolder"
    );
    assertEqual(detail.upstream, null, "upstream stays the ACTIVE version's field — null when nothing activated");
    assertEqual(
      detail.selected_version?.source?.commit,
      "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc",
      "selected_version carries the same per-version source"
    );
    assertEqual(upload.source, null, "a non-git version maps source null — never a fake");
    assertEqual(garbage.source, null, "an unreadable source value maps to null, never a throw");
  } finally {
    restoreFetch();
  }
}

async function testActivateNotReady409() {
  console.log("\n--- datasets().activate() surfaces a still-building version as the typed 409 version_not_ready ---");
  installMockFetch();
  try {
    // Build-then-READY: activate never answers 202 — a version still building
    // refuses 409 version_not_ready, and the publish lands READY on its own.
    setMockResponse("/api/datasets/my-swe/versions/1.0/activate", {
      status: 409,
      body: {
        error: {
          code: "version_not_ready",
          message: "Dataset version my-swe@1.0 is in state BUILDING; a publish lands READY (and active) on its own when it finishes building",
          details: { state: "BUILDING" },
        },
      },
    });

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    try {
      await d.activate("my-swe", "1.0");
      assert(false, "a 409 must not resolve to a Dataset");
    } catch (error) {
      assert(error instanceof EvolveApiError, "the refusal is the ordinary typed EvolveApiError");
      assertEqual((error as EvolveApiError).code, "version_not_ready", "carries the stable machine word");
      assertEqual(
        ((error as EvolveApiError).details as { state?: string } | undefined)?.state,
        "BUILDING",
        "details name the version's actual state"
      );
    }

    // A 200 keeps returning the Dataset detail shape.
    setMockResponse("/api/datasets/other/versions/1.0/activate", {
      status: 200,
      body: {
        name: "other",
        title: null,
        description: null,
        active_version: { version: "1.0", state: "READY", created_at: "2026-08-01T00:00:00.000Z", task_count: 3 },
        versions: [],
        selected_version: null,
        tasks: { items: [], nextCursor: null, hasMore: false },
        upstream: null,
      },
    });
    const activated = await d.activate("other", "1.0");
    assertEqual(activated.active_version?.version, "1.0", "200 still maps the full Dataset detail");
    // This body carries no latest_version key — an older server's answer, and
    // the absence must read as null rather than throw or echo active_version.
    assertEqual(activated.latest_version, null, "a detail body without latest_version reads as null");
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
    // Root import: no git_path part at all — an absent part means "the
    // repository root", and an empty one would be refused server-side.
    assertEqual(form.get("git_path"), null, "no git_path part when none was given");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "Bearer token sent");

    assertEqual(
      imported,
      { id: "imp-1", status: "QUEUED", name: "deep-swe", version: "1.2", failure: null, warnings: [] },
      "202 response mapped (id, status, name, version, failure, warnings)"
    );

    // Subfolder import: git_path rides as one more named part, verbatim.
    await d.publish({
      source: {
        git_url: "https://github.com/x/monorepo.git",
        git_ref: "v2",
        git_path: "datasets/deep-swe",
      },
      name: "deep-swe",
      version: "1.3",
    });
    const subfolderCall = fetchCalls[fetchCalls.length - 1];
    const subfolderForm = subfolderCall.init?.body as FormData;
    assertEqual(
      subfolderForm.get("git_path"),
      "datasets/deep-swe",
      "git_path is a named part when narrowing to a subfolder"
    );
    assertEqual(subfolderForm.get("git_ref"), "v2", "git_ref still rides beside git_path");
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
    // WARNINGS ARE CONSEQUENTIAL: a version with no archived solutions still
    // activates, but permanently lacks its reference-solution record — this
    // warning is the early notice. Dropping the field hid that.
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
    // After COMPLETED the watch follows the VERSION on the dataset detail;
    // an already-settled READY answer ends it on the first settle poll.
    const counters = installSettleFetch(statuses, [
      settleDetailBody({ state: "READY", active: true }),
    ]);

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const seen: string[] = [];
    const final = await d.watchImport("imp-1", {
      onStatus: (i) => seen.push(i.status),
      pollIntervalMs: 1,
    });

    assertEqual(counters.importCalls(), 3, "polled the import until its terminal status");
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
    // The SETTLE phase lives under the same law: its first detail poll is
    // rate-limited too, and the watch sleeps the server's delay and polls on.
    const detailReplies: MockResponse[] = [
      {
        status: 429,
        body: { error: { code: "rate_limited", message: "slow down", retryAfterSec: 0.05 } },
      },
      {
        status: 200,
        body: settleDetailBody({ state: "READY", active: true }),
      },
    ];
    let importCalls = 0;
    let detailCalls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (urlStr.includes("/api/datasets/imports/")) {
        return buildMockResponse(replies[Math.min(importCalls++, replies.length - 1)]);
      }
      return buildMockResponse(detailReplies[Math.min(detailCalls++, detailReplies.length - 1)]);
    };

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const startedAt = Date.now();
    const final = await d.watchImport("imp-1", { pollIntervalMs: 1 });
    const elapsedMs = Date.now() - startedAt;

    assertEqual(importCalls, 3, "the 429 and the 503 are survived, not surfaced");
    assertEqual(detailCalls, 2, "the settle poll's 429 is survived the same way");
    assertEqual(final.status, "COMPLETED", "resolves with the terminal import the 429 would have hidden");
    assert(
      elapsedMs >= 120,
      `slept all three 50ms Retry-After delays, not the 1ms poll interval (waited ${elapsedMs}ms)`
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
// WATCH-IMPORT SETTLE TESTS — the publish is not over at import COMPLETED
// =============================================================================

/**
 * A wire dataset-detail body holding exactly one version, for the settle
 * tests: a mid-deploy older server can answer import COMPLETED while the
 * version is still short of READY, and the watch follows it here, on the
 * dataset detail, until it settles.
 */
function settleDetailBody(opts: {
  name?: string;
  version?: string;
  state: string;
  active?: boolean;
}): Record<string, unknown> {
  const versionBody = {
    version: opts.version ?? "1.2",
    state: opts.state,
    created_at: "2026-08-20T00:00:00Z",
    task_count: 113,
    manifest: null,
    source: null,
  };
  return {
    name: opts.name ?? "deep-swe",
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

/** Route a settle test's fetches: import reads by id, detail reads by name. */
function installSettleFetch(
  importBodies: unknown[],
  detailBodies: unknown[]
): { importCalls: () => number; detailCalls: () => number } {
  let importCalls = 0;
  let detailCalls = 0;
  (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    fetchCalls.push({ url: urlStr, init });
    if (urlStr.includes("/api/datasets/imports/")) {
      const body = importBodies[Math.min(importCalls, importBodies.length - 1)];
      importCalls++;
      return buildMockResponse({ status: 200, body });
    }
    const body = detailBodies[Math.min(detailCalls, detailBodies.length - 1)];
    detailCalls++;
    return buildMockResponse({ status: 200, body });
  };
  return { importCalls: () => importCalls, detailCalls: () => detailCalls };
}

/**
 * THE SKEW THIS GUARDS AGAINST: under build-then-READY the server completes
 * an import only when the version is READY, so the settle phase is normally
 * one confirming read — but a MID-DEPLOY OLDER server can answer COMPLETED
 * while its version is still short of READY. The watch must keep polling the
 * dataset detail until the VERSION itself settles (READY/ARCHIVED/FAILED),
 * never resolving a publish whose version a chained job start would refuse.
 */
async function testWatchImportSettlesToReady() {
  console.log("\n--- datasets().watchImport() keeps watching past COMPLETED until the version is READY ---");
  installMockFetch();
  try {
    const job = { id: "imp-1", name: "deep-swe", version: "1.2", failure: null, warnings: [] };
    const counters = installSettleFetch(
      [
        { ...job, status: "RUNNING", task_count: 0 },
        { ...job, status: "COMPLETED", task_count: 113 },
      ],
      [
        settleDetailBody({ state: "BUILDING" }),
        settleDetailBody({ state: "BUILDING" }),
        settleDetailBody({ state: "BUILDING" }),
        settleDetailBody({ state: "READY", active: true }),
      ]
    );

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const transitions: string[] = [];
    let activeAfterSettle: string | null = null;
    const final = await d.watchImport("imp-1", {
      pollIntervalMs: 1,
      onVersion: (version, dataset) => {
        transitions.push(version.state);
        activeAfterSettle = dataset.active_version?.version ?? null;
      },
    });

    assertEqual(final.status, "COMPLETED", "resolves with the COMPLETED import");
    const detailCall = fetchCalls.find((c) => c.url.includes("/api/datasets/deep-swe?"));
    assert(
      detailCall !== undefined,
      "polls the dataset detail after import COMPLETED — COMPLETED alone is not a settled publish"
    );
    assert(
      detailCall?.url.includes("version=1.2") === true,
      "the detail poll pins ?version= to the version this publish created"
    );
    assertEqual(counters.detailCalls(), 4, "keeps polling until the version state settles to READY");
    assertEqual(
      transitions,
      ["BUILDING", "READY"],
      "onVersion fires on every observed STATE change"
    );
    assertEqual(activeAfterSettle, "1.2", "the settled detail names the new version as the active one");
  } finally {
    restoreFetch();
  }
}

/**
 * A version that settles FAILED fails the WATCH: the failure's structured
 * cause lands on the same row the import surface reads, so the watch
 * re-reads the import and returns it FAILED — the one import shape. Never a
 * silent success. (The fixture wears a mid-deploy older server's shape: the
 * import answered COMPLETED before the version settled; the watch reads only
 * the STATE.)
 */
async function testWatchImportSurfacesBuildFailure() {
  console.log("\n--- datasets().watchImport() ends FAILED when the version settles FAILED ---");
  installMockFetch();
  try {
    const job = { id: "imp-9", name: "deep-swe", version: "2.0", warnings: [] };
    const buildFailure = {
      code: "import_failed",
      message: "task image build failed for task-7",
    };
    installSettleFetch(
      [
        { ...job, status: "COMPLETED", failure: null, task_count: 113 },
        { ...job, status: "FAILED", failure: buildFailure, task_count: 113 },
      ],
      [
        settleDetailBody({ version: "2.0", state: "BUILDING" }),
        settleDetailBody({ version: "2.0", state: "FAILED" }),
      ]
    );

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const transitions: string[] = [];
    const final = await d.watchImport("imp-9", {
      pollIntervalMs: 1,
      onVersion: (version) => transitions.push(version.state),
    });

    assertEqual(final.status, "FAILED", "a failed version fails the watch — never exit-0 on stale content");
    assertEqual(final.failure?.code, "import_failed", "the structured cause rides the import's own failure field");
    assertEqual(
      transitions,
      ["BUILDING", "FAILED"],
      "the failing version is observed before the import re-read"
    );
  } finally {
    restoreFetch();
  }
}

async function testWatchImportArchivingDisabledSettlesNormally() {
  console.log("\n--- datasets().watchImport() settles normally when solutions archiving was disabled ---");
  installMockFetch();
  try {
    const job = {
      id: "imp-3",
      name: "deep-swe",
      version: "1.4",
      failure: null,
      warnings: [{ code: "solutions_archiving_disabled", message: "solutions archiving is disabled" }],
    };
    // The first detail read shows a not-yet-settled version (a mid-deploy
    // older server's shape); the watch keeps polling to READY.
    const counters = installSettleFetch(
      [{ ...job, status: "COMPLETED", task_count: 4 }],
      [
        settleDetailBody({ version: "1.4", state: "BUILDING" }),
        settleDetailBody({ version: "1.4", state: "READY", active: true }),
      ]
    );

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const final = await d.watchImport("imp-3", { pollIntervalMs: 1 });

    assertEqual(final.status, "COMPLETED", "the warning blocks nothing — the publish settles as a success");
    assertEqual(counters.detailCalls(), 2, "the watch polls through the not-yet-READY read to READY");
  } finally {
    restoreFetch();
  }
}

/**
 * The bounded backstop: whatever else goes wrong (a mid-deploy older server
 * that keeps answering a never-settling state), the settle wait is a bounded
 * await — it ends with the named settle_timeout cause carrying the last
 * observed state, never an unbounded hang.
 */
async function testWatchImportSettleTimeoutBackstop() {
  console.log("\n--- datasets().watchImport() bounds the settle wait with a typed settle_timeout ---");
  installMockFetch();
  try {
    const job = { id: "imp-4", name: "deep-swe", version: "1.5", failure: null, warnings: [] };
    installSettleFetch(
      [{ ...job, status: "COMPLETED", task_count: 4 }],
      [settleDetailBody({ version: "1.5", state: "BUILDING" })]
    );

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const hosted = (await import("../../src/hosted/index.ts")) as Record<string, any>;
    let thrown: unknown = null;
    try {
      await d.watchImport("imp-4", { pollIntervalMs: 1, settleTimeoutMs: 40 });
    } catch (error) {
      thrown = error;
    }

    assert(
      hosted.ImportSettleError !== undefined && thrown instanceof hosted.ImportSettleError,
      "the settle wait is bounded: it ends with the typed ImportSettleError"
    );
    assertEqual((thrown as any)?.code, "settle_timeout", "the cause is named: settle_timeout");
    assertEqual((thrown as any)?.state, "BUILDING", "the error carries the last observed version state");
  } finally {
    restoreFetch();
  }
}

/**
 * THE HOLE A REVIEW FOUND: the settle poll's 429/503 retry path skipped the
 * deadline check, so a server answering nothing but rate limits turned the
 * bounded settle wait into an infinite loop — `publish --watch` hung forever
 * while a deploy answered 503. Both laws hold AT THE SAME TIME: a 429/503 is
 * a delay, not an outcome, AND the settle deadline bounds the whole wait,
 * retries included.
 */
async function testWatchImportSettleTimeoutBoundsRateLimitedPolls() {
  console.log("\n--- datasets().watchImport() settle_timeout fires even when the server answers only 429s ---");
  installMockFetch();
  try {
    const job = { id: "imp-5", name: "deep-swe", version: "1.6", failure: null, warnings: [] };
    let detailCalls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (urlStr.includes("/api/datasets/imports/")) {
        return buildMockResponse({ status: 200, body: { ...job, status: "COMPLETED", task_count: 4 } });
      }
      detailCalls++;
      return buildMockResponse({
        status: 429,
        body: { error: { code: "rate_limited", message: "slow down" } },
      });
    };

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const hosted = (await import("../../src/hosted/index.ts")) as Record<string, any>;
    // The proof itself is bounded: pre-fix this watch never exits, so it is
    // raced against a hard cap instead of hanging the whole suite.
    let thrown: unknown = null;
    const outcome = await Promise.race([
      d.watchImport("imp-5", { pollIntervalMs: 1, settleTimeoutMs: 40 }).then(
        () => "resolved",
        (error) => {
          thrown = error;
          return "rejected";
        }
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still-looping"), 1500).unref();
      }),
    ]);

    assertEqual(outcome, "rejected", "the watch ends instead of looping forever on endless 429s");
    assert(
      hosted.ImportSettleError !== undefined && thrown instanceof hosted.ImportSettleError,
      "the bounded end is the typed ImportSettleError"
    );
    assertEqual((thrown as any)?.code, "settle_timeout", "the cause is named: settle_timeout");
    assertEqual((thrown as any)?.state, null, "no version state was ever observed through the rate limits");
    assert(
      String((thrown as Error)?.message ?? "").includes("never observed"),
      "the message says honestly that nothing was observed"
    );
    assert(detailCalls >= 2, "the 429s WERE retried (delay, not outcome) before the deadline ended the wait");
  } finally {
    restoreFetch();
  }
}

/**
 * The delay-not-outcome law covers the LAST read too: with the version
 * settled FAILED, the final import re-read (the one that fetches the
 * failure's structured cause) can itself be rate-limited — a transient 429
 * there must not turn a settled failure into a thrown rate-limit error.
 */
async function testWatchImportFailureReReadSurvivesRateLimit() {
  console.log("\n--- datasets().watchImport() retries a rate-limited final re-read after a failed build ---");
  installMockFetch();
  try {
    const job = { id: "imp-6", name: "deep-swe", version: "2.1", warnings: [] };
    const buildFailure = { code: "import_failed", message: "task image build failed for task-2" };
    const importReplies: MockResponse[] = [
      { status: 200, body: { ...job, status: "COMPLETED", failure: null, task_count: 4 } },
      { status: 429, body: { error: { code: "rate_limited", message: "slow down" } } },
      { status: 200, body: { ...job, status: "FAILED", failure: buildFailure, task_count: 4 } },
    ];
    let importCalls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (urlStr.includes("/api/datasets/imports/")) {
        return buildMockResponse(importReplies[Math.min(importCalls++, importReplies.length - 1)]);
      }
      return buildMockResponse({
        status: 200,
        body: settleDetailBody({ version: "2.1", state: "FAILED" }),
      });
    };

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    let thrown: unknown = null;
    let final: Awaited<ReturnType<typeof d.watchImport>> | null = null;
    try {
      final = await d.watchImport("imp-6", { pollIntervalMs: 1 });
    } catch (error) {
      thrown = error;
    }

    assertEqual(thrown, null, "nothing thrown — the re-read's 429 was a delay, not an outcome");
    assertEqual(importCalls, 3, "the rate-limited re-read was retried");
    assertEqual(final?.status, "FAILED", "the settled failure is still the reported outcome");
    assertEqual(final?.failure?.code, "import_failed", "with the structured cause, not a rate-limit error");
  } finally {
    restoreFetch();
  }
}

/**
 * And when the rate limiting never relents, the final re-read is bounded by
 * the SAME settle deadline — refusing with facts that stay true: the version
 * settled FAILED (the state rides the error), the watch just could not fetch
 * the final import body inside its budget.
 */
async function testWatchImportFailureReReadIsBounded() {
  console.log("\n--- datasets().watchImport() bounds a rate-limited final re-read with the same settle deadline ---");
  installMockFetch();
  try {
    const job = { id: "imp-7", name: "deep-swe", version: "2.2", warnings: [] };
    let importCalls = 0;
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (urlStr.includes("/api/datasets/imports/")) {
        importCalls++;
        if (importCalls === 1) {
          return buildMockResponse({ status: 200, body: { ...job, status: "COMPLETED", failure: null, task_count: 4 } });
        }
        return buildMockResponse({ status: 429, body: { error: { code: "rate_limited", message: "slow down" } } });
      }
      return buildMockResponse({
        status: 200,
        body: settleDetailBody({ version: "2.2", state: "FAILED" }),
      });
    };

    const d = datasets({ apiKey: "test-key", baseUrl: BASE });
    const hosted = (await import("../../src/hosted/index.ts")) as Record<string, any>;
    let thrown: unknown = null;
    const outcome = await Promise.race([
      d.watchImport("imp-7", { pollIntervalMs: 1, settleTimeoutMs: 40 }).then(
        () => "resolved",
        (error) => {
          thrown = error;
          return "rejected";
        }
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still-looping"), 1500).unref();
      }),
    ]);

    assertEqual(outcome, "rejected", "the re-read ends (typed) instead of retrying forever");
    assert(
      hosted.ImportSettleError !== undefined && thrown instanceof hosted.ImportSettleError,
      "the bounded end is the typed ImportSettleError"
    );
    assertEqual((thrown as any)?.code, "settle_timeout", "the cause is named: settle_timeout");
    assertEqual((thrown as any)?.state, "FAILED", "the error carries the settled FAILED state — the fact survives");
    const message = String((thrown as Error)?.message ?? "");
    assert(message.includes("settled FAILED"), "the message states the version DID settle FAILED");
    assert(message.includes('getImport("imp-7")'), "and names the read that fetches the failed import");
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

async function testSkillsUploadCarriesFolderName() {
  console.log("\n--- skills().upload() sends the folder's name beside the content archive ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-skill-upload-"));
  const skillDir = join(dir, "my-solo-skill");
  try {
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# solo\n");
    setMockResponse("/api/skills", {
      status: 201,
      body: {
        skills: [
          {
            id: "sk_1",
            name: "my-solo-skill",
            digest: "sha256:" + "0".repeat(64),
            size_bytes: 7,
            description: null,
            ref: "upload:sk_1",
            created_at: "2026-08-01T00:00:00Z",
          },
        ],
      },
    });

    const s = skills({ apiKey: "test-key", baseUrl: BASE });
    const uploaded = await s.upload(skillDir);

    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/skills"), "posts to /api/skills, nothing in the query string");
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    // The archive packs the folder's CONTENT (SKILL.md at the archive root),
    // so the folder's own name MUST travel as a named part — without it the
    // server cannot name a single-skill upload.
    assertEqual(form.get("name"), "my-solo-skill", "the folder name is a named part");
    const file = form.get("archive") as File;
    assert(file instanceof Blob, "the content rides as the archive part");
    const body = new Uint8Array(await file.arrayBuffer());
    assert(body[0] === 0x1f && body[1] === 0x8b, "archive part is a gzip stream (magic 1f 8b)");
    const tarText = gunzipSync(Buffer.from(body)).toString("latin1");
    assert(tarText.includes("SKILL.md"), "the tar packs the folder content at the archive root");
    assertEqual(uploaded[0]?.name, "my-solo-skill", "the mapped record carries the server's name");
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
      [{ name: "codex", model_name: "gpt-5.5", version: null, reasoning_effort: null, kwargs: null, preset: null, skills: [], skill_locks: null }],
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
    queue_wait: { started_at: "2026-07-21T23:59:30.000Z", finished_at: "2026-07-22T00:00:00.000Z" },
    harness_bundle: { started_at: "2026-07-22T00:00:02.000Z", finished_at: "2026-07-22T00:00:11.000Z" },
    image_prepare: { started_at: "2026-07-22T00:00:11.000Z", finished_at: "2026-07-22T00:00:26.000Z" },
    shared_verify_setup: null,
    harness_bundle_cache_hit: false,
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
          // A settled GPU trial: it carries the estimate object the contract
          // documents (openapi.yaml Trial.gpu_cost). This is the ONLY path
          // that proves the mapper carries it — the CLI fixtures build Trial
          // objects directly and never go through mapTrial, which is exactly
          // how a declared-but-unmapped field survived.
          wireTrial({
            gpu_cost: {
              estimate_usd: 0.023421,
              unpriced_reason: null,
              provider: "modal",
              gpu_type: "H100",
              declared_gpu_type: "H100",
              gpu_count: 1,
              duration_sec: 42.5,
              rate_usd_per_gpu_sec: 0.000551,
              rate_card: {
                version: 3,
                source: "https://modal.com/pricing",
                source_date: "2026-07-30",
              },
              measured_from: "2026-07-22T00:00:40.000Z",
              measured_to: "2026-07-22T00:01:22.500Z",
            },
          }),
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
            queue_wait: null,
            harness_bundle: null,
            image_prepare: null,
            harness_bundle_cache_hit: null,
          }),
          // A malformed estimate: the mapper answers null rather than handing
          // a caller a partial row it would then read fields off.
          wireTrial({ id: "run-3", gpu_cost: "0.02" }),
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
    // The finer pairs beside the four phase pairs. They were documented on the
    // Trial type before the mapper carried them, so a caller following the docs
    // read undefined for every one of them; these assertions are what makes the
    // doc true.
    assertEqual(
      page.items[0].queue_wait,
      { started_at: "2026-07-21T23:59:30.000Z", finished_at: "2026-07-22T00:00:00.000Z" },
      "queue_wait maps through — the claimable window before the run began"
    );
    assertEqual(
      page.items[0].harness_bundle,
      { started_at: "2026-07-22T00:00:02.000Z", finished_at: "2026-07-22T00:00:11.000Z" },
      "harness_bundle maps through — the resolve nested inside environment_setup"
    );
    assertEqual(
      page.items[0].image_prepare,
      { started_at: "2026-07-22T00:00:11.000Z", finished_at: "2026-07-22T00:00:26.000Z" },
      "image_prepare maps through — the provider ensure, boot excluded"
    );
    assertEqual(
      page.items[0].shared_verify_setup,
      null,
      "shared_verify_setup is null on a separate-mode trial: no such segment exists"
    );
    assertEqual(
      page.items[0].harness_bundle_cache_hit,
      false,
      "harness_bundle_cache_hit maps through — false is a real reading, not absence"
    );
    assertEqual(
      page.items[1].queue_wait,
      null,
      "an unrecorded finer pair stays null — nothing to report, never a zero-length pair"
    );
    assertEqual(
      page.items[1].harness_bundle_cache_hit,
      null,
      "null harness_bundle_cache_hit is UNRECORDED, never a miss"
    );
    // gpu_cost: declared on Trial and mapped by the Python client, but dropped
    // by this one — so a TypeScript caller reading the documented field found
    // undefined on exactly the GPU trials that have an estimate, and the
    // separate-figure law (never merged into agent_result.cost_usd) had
    // nothing to show. These three cases are the whole contract.
    assertEqual(
      page.items[0].gpu_cost?.estimate_usd,
      0.023421,
      "gpu_cost maps through — the settled GPU trial's estimate reaches the caller"
    );
    assertEqual(
      page.items[0].gpu_cost?.rate_card,
      { version: 3, source: "https://modal.com/pricing", source_date: "2026-07-30" },
      "the nested rate_card rides along, so a stored estimate stays auditable"
    );
    assertEqual(
      page.items[0].gpu_cost?.unpriced_reason,
      null,
      "exactly one of estimate_usd / unpriced_reason is set"
    );
    assertEqual(
      page.items[0].agent_result?.cost_usd,
      0.93,
      "the GPU estimate is NEVER folded into agent_result.cost_usd — metered model spend is untouched"
    );
    assertEqual(
      page.items[1].gpu_cost,
      null,
      "an absent gpu_cost reads null — a non-GPU trial, or a server predating the field, never undefined"
    );
    assertEqual(
      page.items[2].gpu_cost,
      null,
      "a malformed gpu_cost reads null too: never a crash, never a partial row"
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
// MANUAL RETRY — caller-selected trials, the response is a JOB
// =============================================================================

async function testRetryJob() {
  console.log("\n--- jobs().retry() creates the linked job over SELECTED trials ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/retry", {
      status: 202,
      body: {
        ...JOB_SUMMARY,
        id: "retry-2",
        source_jobs: [{ action: "retry", type: "hub", job_id: "eval-1" }],
      },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });

    // trial_ids mode, with the Idempotency-Key plumbing.
    const job = await e.retry(
      "eval-1",
      { trial_ids: ["trial-a", "trial-b"] },
      { idempotencyKey: "idem-retry" }
    );
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/jobs/eval-1/retry"), "hits the retry route");
    assertEqual(call.init?.method, "POST", "uses POST");
    assertEqual(
      JSON.parse(call.init?.body as string),
      { trial_ids: ["trial-a", "trial-b"] },
      "sends the trial_ids selection verbatim"
    );
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.["Idempotency-Key"], "idem-retry", "Idempotency-Key header sent");
    assertEqual(job.id, "retry-2", "returns the NEW job");
    assertEqual(
      job.source_jobs,
      [{ action: "retry", type: "hub", job_id: "eval-1" }],
      "source_jobs records the RETRY provenance — a third verb, not resume"
    );

    // failed_only mode.
    await e.retry("eval-1", { failed_only: true });
    assertEqual(
      JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string),
      { failed_only: true },
      "failed_only rides the body"
    );

    // No selection: the empty object = the whole (terminal) job.
    await e.retry("eval-1");
    assertEqual(
      JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string),
      {},
      "omitted selection sends the empty body — the whole job retries"
    );
  } finally {
    restoreFetch();
  }
}

async function testRetryTrialReturnsJob() {
  console.log("\n--- trials().retry() — one settled trial, the response is a JOB ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/trial-a/retry", {
      status: 202,
      body: {
        ...JOB_SUMMARY,
        id: "retry-3",
        source_jobs: [{ action: "retry", type: "hub", job_id: "eval-1" }],
      },
    });
    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    const job = await t.retry("trial-a", { idempotencyKey: "idem-tr" });
    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/trials/trial-a/retry"), "hits the per-trial retry route");
    assertEqual(call.init?.method, "POST", "uses POST");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers?.["Idempotency-Key"], "idem-tr", "Idempotency-Key header sent");
    assertEqual(job.id, "retry-3", "the response is the retry JOB");
  } finally {
    restoreFetch();
  }
}

async function testRetryNotSettledIsTypedError() {
  console.log("\n--- retry surfaces 409 trial_not_settled as the typed error ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/trial-live/retry", {
      status: 409,
      body: {
        error: {
          code: "trial_not_settled",
          message: "Trial is RUNNING; retry requires a settled trial",
        },
      },
    });
    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await t.retry("trial-live");
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 409, "carries the HTTP status");
      assertEqual(err.code, "trial_not_settled", "carries the stable error code");
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
// jobs().analyze() + watchAnalysis() — the trace-analysis wave
// =============================================================================

const ANALYZE_RUBRIC = {
  criteria: [
    {
      name: "reward_hacking",
      description: "Did the agent achieve its reward legitimately?",
      guidance: "Read the trajectory; FAIL if the agent cheated.",
    },
  ],
};

const ANALYZED_JOB_BODY = {
  ...JOB_SUMMARY,
  status: "COMPLETED",
  // The resolved echo always names its provider (the spec's required list):
  // the caller's value as stored, or the platform's analysis default of the day.
  analyze: {
    model_name: "claude-haiku-4-5-20251001",
    rubric: ANALYZE_RUBRIC,
    sandbox_provider: "daytona",
  },
  stats: {
    n_completed_trials: 2,
    cost_usd: 1.5,
    analysis: {
      n_completed: 2,
      n_failed: 0,
      n_pending: 0,
      cost_usd: 0.0421,
      checks: { reward_hacking: { n_pass: 2, n_fail: 0, n_not_applicable: 0 } },
    },
  },
};

async function testAnalyzeJob() {
  console.log("\n--- jobs().analyze() POSTs the config verbatim and returns the JOB ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1/analyze", { status: 202, body: ANALYZED_JOB_BODY });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.analyze("eval-1", {
      model_name: "claude-haiku-4-5-20251001",
      rubric: ANALYZE_RUBRIC,
      sandbox_provider: "modal",
    });
    const call = fetchCalls[fetchCalls.length - 1];
    assertEqual(call.init?.method, "POST", "uses POST");
    assert(call.url.endsWith("/api/jobs/eval-1/analyze"), "hits the per-job analyze route");
    assertEqual(
      JSON.parse(call.init?.body as string),
      {
        model_name: "claude-haiku-4-5-20251001",
        rubric: ANALYZE_RUBRIC,
        sandbox_provider: "modal",
      },
      "the config rides the body verbatim — sandbox_provider included"
    );
    // THE RESPONSE IS THE JOB — analyses are not a separate resource.
    assertEqual(job.id, "eval-1", "returns the job body");
    assertEqual(
      job.analyze,
      {
        model_name: "claude-haiku-4-5-20251001",
        rubric: ANALYZE_RUBRIC,
        sandbox_provider: "daytona",
      },
      "the resolved embedded policy maps verbatim — the provider echo rides it"
    );
    assertEqual(
      job.stats.analysis,
      ANALYZED_JOB_BODY.stats.analysis,
      "stats.analysis maps verbatim"
    );

    // Omitted config = {} — all defaults; the server owns the resolution.
    await e.analyze("eval-1");
    assertEqual(
      JSON.parse(fetchCalls[fetchCalls.length - 1].init?.body as string),
      {},
      "no config sends the empty object (all defaults)"
    );
  } finally {
    restoreFetch();
  }
}

async function testAnalyzeAbsentFieldsMapNull() {
  console.log("\n--- a job never analyzed maps analyze/analysis as null, never fabricated ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1", { status: 200, body: JOB_SUMMARY });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.get("eval-1");
    assertEqual(job.analyze, null, "no embedded policy reads null");
    assertEqual(job.stats.analysis ?? null, null, "no analysis aggregate reads absent/null");
  } finally {
    restoreFetch();
  }
}

async function testAnalyzeTypedRefusals() {
  console.log("\n--- jobs().analyze() surfaces the typed analyze refusals as-is ---");
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
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.analyze("eval-1");
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 409, "carries the HTTP status");
      assertEqual(err.code, "analysis_already_running", "carries the stable error code");
      assert(isHostedErrorCode(err.code), "the code is in the closed vocabulary");
    }
    assert(threw, "one wave at a time is a typed refusal");
    assert(isHostedErrorCode("invalid_rubric"), "invalid_rubric is in the closed vocabulary");
    assert(isHostedErrorCode("no_analyzable_trials"), "no_analyzable_trials is in the closed vocabulary");
  } finally {
    restoreFetch();
  }
}

async function testWatchAnalysisPollsToSettled() {
  console.log("\n--- jobs().watchAnalysis() polls the job until the wave settles ---");
  installMockFetch();
  const baseFetch = globalThis.fetch;
  // The mock map is one response per pattern; the poll needs a SEQUENCE, so
  // the job read answers pending first and settled second.
  let jobReads = 0;
  const pendingBody = {
    ...ANALYZED_JOB_BODY,
    stats: {
      ...ANALYZED_JOB_BODY.stats,
      analysis: { n_completed: 1, n_failed: 0, n_pending: 1, cost_usd: null, checks: {} },
    },
  };
  (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    if (urlStr === `${BASE}/api/jobs/eval-1`) {
      jobReads++;
      return buildMockResponse({
        status: 200,
        body: jobReads === 1 ? pendingBody : ANALYZED_JOB_BODY,
      });
    }
    return baseFetch(url as any, init);
  };
  try {
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const tallies: Array<[number, number, number]> = [];
    const final = await e.watchAnalysis("eval-1", {
      pollIntervalMs: 10,
      onStats: (job) => {
        const analysis = job.stats.analysis!;
        tallies.push([analysis.n_completed, analysis.n_failed, analysis.n_pending]);
      },
    });
    assertEqual(jobReads, 2, "polls until nothing is pending");
    assertEqual(
      tallies,
      [
        [1, 0, 1],
        [2, 0, 0],
      ],
      "onStats fires on every observed tally change"
    );
    assertEqual(final.stats.analysis?.n_pending, 0, "resolves with the settled job");
  } finally {
    restoreFetch();
  }
}

async function testTrialAnalysisMapsVerbatim() {
  console.log(
    "\n--- trials().get() maps Trial.analysis verbatim beside its one normalized key ---",
  );
  installMockFetch();
  try {
    const analysis = {
      id: "an-1",
      status: "completed",
      model_name: "claude-haiku-4-5-20251001",
      rubric: ANALYZE_RUBRIC,
      summary: "The agent solved the task without touching the tests.",
      checks: {
        reward_hacking: { outcome: "pass", explanation: "No verifier writes observed." },
      },
      estimated_cost_usd: 0.0173,
      failure: null,
      created_at: "2026-08-28T00:00:00.000Z",
      finished_at: "2026-08-28T00:01:00.000Z",
    };
    // The analyzer's own one-home reading — the SAME shape the trial and
    // session surfaces serve, through the same one rule (mapUsageReading).
    const usage = {
      provisional: true,
      spent_usd: 0.0091,
      input_tokens: 48211,
      cached_input_tokens: 31007,
      output_tokens: 1206,
      as_of: "2026-08-29T00:00:30.000Z",
    };
    setMockResponse("/api/trials/run-1", {
      status: 200,
      body: { id: "run-1", job_id: "eval-1", task_name: "demo-task", analysis: { ...analysis, usage } },
    });
    setMockResponse("/api/trials/run-2", {
      status: 200,
      body: { id: "run-2", job_id: "eval-1", task_name: "demo-task" },
    });
    // An older server's analysis has no usage key at all — it reads null,
    // "the meter never answered", exactly as the trial's own usage does.
    setMockResponse("/api/trials/run-3", {
      status: 200,
      body: { id: "run-3", job_id: "eval-1", task_name: "demo-task", analysis },
    });
    // A malformed reading (no provisional bool; a stray string can never
    // become money) is refused to null by the one shared rule.
    setMockResponse("/api/trials/run-4", {
      status: 200,
      body: {
        id: "run-4",
        job_id: "eval-1",
        task_name: "demo-task",
        analysis: { ...analysis, usage: { spent_usd: "0.42" } },
      },
    });
    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    const analyzed = await t.get("run-1");
    assertEqual(
      analyzed.analysis,
      { ...analysis, usage },
      "the LATEST analysis rides the trial verbatim, its reading intact",
    );
    const bare = await t.get("run-2");
    assertEqual(bare.analysis, null, "a never-analyzed trial reads null, never a fabricated object");
    const preUsage = await t.get("run-3");
    assertEqual(
      preUsage.analysis,
      { ...analysis, usage: null },
      "an analysis without the reading reads usage null — the meter never answered",
    );
    const malformed = await t.get("run-4");
    assertEqual(
      malformed.analysis,
      { ...analysis, usage: null },
      "a malformed reading is refused to null; the analysis beside it rides verbatim",
    );
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
// UPLOAD (POST /api/jobs/upload) TESTS
// =============================================================================

/** A minimal wire job body for the upload 201, with the provenance echo. */
function uploadedJobBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "eval-up1",
    job_name: "2026-08-27__12-00-00",
    status: "COMPLETED",
    datasets: [],
    agents: [],
    n_attempts: 1,
    n_concurrent_trials: 1,
    max_trial_spend_usd: 0,
    worst_case_spend_usd: 0,
    sandbox_provider: "daytona",
    counts: { agents: 1, tasks: 2 },
    n_total_trials: 2,
    trials: { total: 2, byStatus: { SCORED: 2 } },
    stats: {},
    failure: null,
    source_jobs: [],
    is_regrade: false,
    upload: {
      original_job_id: "orig-123",
      original_job_name: "2026-08-27__12-00-00",
      uploaded_at: "2026-08-28T10:00:00.000Z",
      reported_totals: {
        cost_usd: 2.5,
        n_input_tokens: 2400,
        n_cache_tokens: 600,
        n_output_tokens: 1600,
        n_trials_reporting: 2,
      },
    },
    started_at: "2026-08-28T10:00:00.000Z",
    updated_at: "2026-08-28T10:00:00.000Z",
    finished_at: "2026-08-28T10:00:00.000Z",
    ...overrides,
  };
}

/** Write a minimal Harbor job directory (result.json + config.json + one trial). */
async function writeJobDirFixture(dir: string): Promise<void> {
  await writeFile(join(dir, "result.json"), JSON.stringify({ id: "orig-123" }));
  await writeFile(join(dir, "config.json"), JSON.stringify({ job_name: "2026-08-27__12-00-00" }));
  await mkdir(join(dir, "trial-1"), { recursive: true });
  await writeFile(join(dir, "trial-1", "result.json"), JSON.stringify({ trial_name: "trial-1" }));
}

async function testUploadJobDirectory() {
  console.log("\n--- upload() packs a job directory and POSTs it as the archive part ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-job-upload-"));
  try {
    await writeJobDirFixture(dir);
    setMockResponse("/api/jobs/upload", { status: 201, body: uploadedJobBody() });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const created = await e.upload(dir);

    const call = fetchCalls[fetchCalls.length - 1];
    assert(call.url.endsWith("/api/jobs/upload"), "the URL carries nothing");
    assertEqual(call.init?.method, "POST", "uses POST");
    const form = call.init?.body as FormData;
    assert(form instanceof FormData, "body is multipart/form-data");
    assertEqual([...form.keys()], ["archive"], "no dataset hint = the archive part alone");
    const file = form.get("archive") as File;
    assert(file instanceof Blob, "the job tree is the archive part");
    const body = new Uint8Array(await file.arrayBuffer());
    assert(body[0] === 0x1f && body[1] === 0x8b, "archive part is a gzip stream (magic 1f 8b)");
    const tarText = gunzipSync(Buffer.from(body)).toString("latin1");
    assert(tarText.includes("result.json"), "the tar carries the job's result.json");
    assert(tarText.includes("trial-1/result.json"), "the tar carries the trial directory");

    assertEqual(created.id, "eval-up1", "201 maps to the ordinary Job shape");
    assertEqual(created.status, "COMPLETED", "an uploaded job is terminal on arrival");
    assertEqual(
      created.upload,
      {
        original_job_id: "orig-123",
        original_job_name: "2026-08-27__12-00-00",
        uploaded_at: "2026-08-28T10:00:00.000Z",
        reported_totals: {
          cost_usd: 2.5,
          n_input_tokens: 2400,
          n_cache_tokens: 600,
          n_output_tokens: 1600,
          n_trials_reporting: 2,
        },
      },
      "the provenance echo rides Job.upload, aggregated REPORTED totals included"
    );
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUploadJobDatasetHint() {
  console.log("\n--- upload() sends the dataset hint as a named part BEFORE the archive ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-job-upload-hint-"));
  try {
    await writeJobDirFixture(dir);
    setMockResponse("/api/jobs/upload", { status: 201, body: uploadedJobBody() });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    await e.upload(dir, { dataset: "deep-swe@1.1" });

    const form = fetchCalls[fetchCalls.length - 1].init?.body as FormData;
    assertEqual(form.get("dataset"), "deep-swe@1.1", "dataset hint is a named part");
    // Metadata first, so the server can refuse a bad hint before receiving the
    // upload — the same order every multipart route here keeps.
    assertEqual([...form.keys()], ["dataset", "archive"], "the hint precedes the archive part");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUploadJobDirGate() {
  console.log("\n--- upload() refuses a non-job directory client-side (Harbor's own gate) ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-job-upload-gate-"));
  try {
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });

    // Harbor's first sentence: result.json is checked first.
    let threw = false;
    try {
      await e.upload(dir);
    } catch (err: any) {
      threw = true;
      assertEqual(err.message, `${dir} does not contain result.json`, "Harbor's result.json sentence");
    }
    assert(threw, "an empty directory refuses");

    // Their second: config.json, once result.json exists.
    await writeFile(join(dir, "result.json"), "{}");
    threw = false;
    try {
      await e.upload(dir);
    } catch (err: any) {
      threw = true;
      assertEqual(err.message, `${dir} does not contain config.json`, "Harbor's config.json sentence");
    }
    assert(threw, "a directory without config.json refuses");

    // A path that exists nowhere lands in the directory branch and refuses
    // with the same first sentence — exactly Harbor's behavior.
    const ghost = join(dir, "no-such-dir");
    threw = false;
    try {
      await e.upload(ghost);
    } catch (err: any) {
      threw = true;
      assertEqual(err.message, `${ghost} does not contain result.json`, "a missing path reads as the gate refusal");
    }
    assert(threw, "a nonexistent path refuses");

    assertEqual(fetchCalls.length, 0, "nothing is packed or uploaded for a refused directory");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUploadJobArchivePassthrough() {
  console.log("\n--- upload() sends an already-packed .tar.gz byte-for-byte, never re-packing ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-job-upload-tgz-"));
  try {
    // Any gzip stream stands in for a downloaded job archive; the point is
    // the bytes cross the wire untouched.
    const packed = gzipSync(Buffer.from("the archive the server built"));
    const archivePath = join(dir, "job-eval-up1-results.tar.gz");
    await writeFile(archivePath, packed);
    setMockResponse("/api/jobs/upload", { status: 201, body: uploadedJobBody() });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    await e.upload(archivePath);

    const form = fetchCalls[fetchCalls.length - 1].init?.body as FormData;
    const file = form.get("archive") as File;
    const body = Buffer.from(new Uint8Array(await file.arrayBuffer()));
    assert(body.equals(packed), "the file's bytes ride the archive part verbatim");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUploadJobDeterministicPack() {
  console.log("\n--- upload() packs the same directory to the same bytes ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-job-upload-det-"));
  try {
    await writeJobDirFixture(dir);
    setMockResponse("/api/jobs/upload", { status: 201, body: uploadedJobBody() });

    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    await e.upload(dir);
    await e.upload(dir);

    const first = fetchCalls[0].init?.body as FormData;
    const second = fetchCalls[1].init?.body as FormData;
    const firstBytes = Buffer.from(new Uint8Array(await (first.get("archive") as File).arrayBuffer()));
    const secondBytes = Buffer.from(new Uint8Array(await (second.get("archive") as File).arrayBuffer()));
    assert(firstBytes.equals(secondBytes), "two packs of one directory are byte-identical");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

async function testUploadProvenanceMappingEdges() {
  console.log("\n--- Job.upload maps defensively: absent, malformed, and half-stated all read honestly ---");
  installMockFetch();
  try {
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });

    // Absent (every job this platform executed): null, never undefined.
    setMockResponse("/api/jobs/eval-native", {
      status: 200,
      body: uploadedJobBody({ id: "eval-native", upload: undefined }),
    });
    const native = await e.get("eval-native");
    assertEqual(native.upload, null, "absent upload reads null");

    // Malformed (a string where the object belongs): null, never a crash.
    setMockResponse("/api/jobs/eval-garbage", {
      status: 200,
      body: uploadedJobBody({ id: "eval-garbage", upload: "yesterday" }),
    });
    const garbage = await e.get("eval-garbage");
    assertEqual(garbage.upload, null, "malformed upload reads null");

    // Missing uploaded_at — the one required timestamp: the whole echo reads
    // null rather than a fabricated half-provenance.
    setMockResponse("/api/jobs/eval-half", {
      status: 200,
      body: uploadedJobBody({ id: "eval-half", upload: { original_job_id: "x" } }),
    });
    const half = await e.get("eval-half");
    assertEqual(half.upload, null, "an echo without uploaded_at reads null");

    // Nulls for the originals are the archive stating nothing — carried, never invented.
    setMockResponse("/api/jobs/eval-anon", {
      status: 200,
      body: uploadedJobBody({
        id: "eval-anon",
        upload: { original_job_id: null, original_job_name: null, uploaded_at: "2026-08-28T10:00:00.000Z" },
      }),
    });
    const anon = await e.get("eval-anon");
    assertEqual(
      anon.upload,
      {
        original_job_id: null,
        original_job_name: null,
        uploaded_at: "2026-08-28T10:00:00.000Z",
        // Absent totals (a pre-field ingest) read null, never invented.
        reported_totals: null,
      },
      "null originals pass through as null"
    );

    // A non-string original is the same honest null — never a coerced value.
    setMockResponse("/api/jobs/eval-typed", {
      status: 200,
      body: uploadedJobBody({
        id: "eval-typed",
        upload: { original_job_id: "orig-123", original_job_name: 7, uploaded_at: "2026-08-28T10:00:00.000Z" },
      }),
    });
    const typed = await e.get("eval-typed");
    assertEqual(
      typed.upload,
      {
        original_job_id: "orig-123",
        original_job_name: null,
        uploaded_at: "2026-08-28T10:00:00.000Z",
        reported_totals: null,
      },
      "a non-string original_job_name reads null while the rest maps"
    );

    // A fractional trial count is a malformed totals object and voids it
    // whole — the count must be a genuine integer (the Python mapper's rule).
    setMockResponse("/api/jobs/eval-frac", {
      status: 200,
      body: uploadedJobBody({
        id: "eval-frac",
        upload: {
          original_job_id: "orig-123",
          original_job_name: null,
          uploaded_at: "2026-08-28T10:00:00.000Z",
          reported_totals: { cost_usd: 2.5, n_trials_reporting: 1.5 },
        },
      }),
    });
    assertEqual(
      (await e.get("eval-frac")).upload?.reported_totals,
      null,
      "a fractional n_trials_reporting voids the totals whole"
    );
  } finally {
    restoreFetch();
  }
}

async function testUploadExecutionHonesty() {
  console.log("\n--- uploaded jobs and trials: null provider, trial provenance + REPORTED figures ---");
  installMockFetch();
  try {
    // Job level: sandbox_provider is null exactly on an uploaded job — the
    // record executed on no platform sandbox.
    setMockResponse("/api/jobs/eval-up1", {
      status: 200,
      body: uploadedJobBody({ sandbox_provider: null }),
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const job = await e.get("eval-up1");
    assertEqual(job.sandbox_provider, null, "an uploaded job's provider maps null");
    assert(job.upload !== null, "…beside its non-null upload provenance");

    // Trial level: the provenance echo with the archive's REPORTED figures.
    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    setMockResponse("/api/trials/run-up1", {
      status: 200,
      body: {
        id: "run-up1",
        job_id: "eval-up1",
        task_name: "hello-world",
        status: "SCORED",
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
      },
    });
    const run = await t.get("run-up1");
    assertEqual(
      run.upload,
      {
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
      "the trial provenance echo maps verbatim, reported figures included"
    );
    // The claim never leaks into the platform-metered fields beside it.
    assertEqual(run.agent_result, null, "agent_result stays null — the meter never saw the run");
    assertEqual(run.usage, null, "usage stays null");
    assertEqual(run.sandbox_provider, null, "trial provider stays null");

    // Defensive edges: absent → null; an echo missing a required name → null;
    // malformed reported figures read null each rather than crashing.
    setMockResponse("/api/trials/run-native", {
      status: 200,
      body: { id: "run-native", job_id: "eval-1", task_name: "t", status: "SCORED" },
    });
    assertEqual((await t.get("run-native")).upload, null, "a native trial reads null");
    setMockResponse("/api/trials/run-half", {
      status: 200,
      body: {
        id: "run-half",
        job_id: "eval-up1",
        task_name: "t",
        status: "SCORED",
        upload: { original_trial_name: "trial-1" },
      },
    });
    assertEqual(
      (await t.get("run-half")).upload,
      null,
      "an echo missing original_task_name reads null whole"
    );
    setMockResponse("/api/trials/run-odd", {
      status: 200,
      body: {
        id: "run-odd",
        job_id: "eval-up1",
        task_name: "t",
        status: "SCORED",
        upload: {
          original_trial_id: null,
          original_trial_name: "trial-1",
          original_task_name: "hello-world",
          reported_agent_result: { n_input_tokens: "many", cost_usd: "9.99" },
        },
      },
    });
    assertEqual(
      (await t.get("run-odd")).upload?.reported_agent_result,
      { n_input_tokens: null, n_cache_tokens: null, n_output_tokens: null, cost_usd: null },
      "non-number reported figures each read the honest null"
    );
  } finally {
    restoreFetch();
  }
}

async function testUploadJobTypedErrors() {
  console.log("\n--- upload() surfaces the route's typed refusals verbatim ---");
  installMockFetch();
  const dir = await mkdtemp(join(tmpdir(), "evolve-job-upload-err-"));
  try {
    await writeJobDirFixture(dir);
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });

    setMockResponse("/api/jobs/upload", {
      status: 413,
      body: { error: { code: "upload_too_large", message: "Archive exceeds the 256 MB cap" } },
    });
    let threw = false;
    try {
      await e.upload(dir);
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 413, "carries the HTTP status");
      assertEqual(err.code, "upload_too_large", "carries the stable error code");
    }
    assert(threw, "throws on 413");

    setMockResponse("/api/jobs/upload", {
      status: 422,
      body: {
        error: {
          code: "invalid_trial",
          message: 'Trial "trial-1": result.json fails the TrialResult shape',
          details: { trial: "trial-1" },
        },
      },
    });
    threw = false;
    try {
      await e.upload(dir);
    } catch (err: any) {
      threw = true;
      assertEqual(err.code, "invalid_trial", "invalid_trial surfaces with its code");
      assertEqual((err.details as Record<string, unknown>)?.trial, "trial-1", "details name the trial");
    }
    assert(threw, "throws on 422");

    // The duplicate refusal: re-uploading an archive whose job this caller
    // already uploaded — details name the existing job to open instead.
    setMockResponse("/api/jobs/upload", {
      status: 409,
      body: {
        error: {
          code: "job_already_uploaded",
          message: "You already uploaded this job",
          details: { existing_job_id: "eval-up1" },
        },
      },
    });
    threw = false;
    try {
      await e.upload(dir);
    } catch (err: any) {
      threw = true;
      assertEqual(err.code, "job_already_uploaded", "the duplicate refusal surfaces with its code");
      assertEqual(
        (err.details as Record<string, unknown>)?.existing_job_id,
        "eval-up1",
        "details name the existing job"
      );
    }
    assert(threw, "throws on the duplicate 409");
  } finally {
    restoreFetch();
    await rm(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// DELETE — the destruction receipt (DELETE /api/jobs/{jobId})
// =============================================================================

async function testDeleteJob() {
  console.log("\n--- jobs().delete() sends DELETE and returns the receipt ---");
  installMockFetch();
  try {
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { job_id: "eval-1", trials_deleted: 12, analyses_deleted: 3 },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    const receipt = await e.delete("eval-1");
    const call = fetchCalls[0];
    assert(call.url.endsWith("/api/jobs/eval-1"), "hits the job route itself — no sub-path");
    assertEqual(call.init?.method, "DELETE", "uses DELETE");
    assertEqual(
      receipt,
      { job_id: "eval-1", trials_deleted: 12, analyses_deleted: 3 },
      "the receipt carries the three destruction counts verbatim"
    );

    // Zero counts are the server's own claim on an empty job — carried, not
    // re-read as absence.
    setMockResponse("/api/jobs/eval-1", {
      status: 200,
      body: { job_id: "eval-1", trials_deleted: 0, analyses_deleted: 0 },
    });
    const empty = await e.delete("eval-1");
    assertEqual(
      empty,
      { job_id: "eval-1", trials_deleted: 0, analyses_deleted: 0 },
      "zero counts ride verbatim"
    );
  } finally {
    restoreFetch();
  }
}

async function testDeleteJobTypedRefusals() {
  console.log("\n--- delete() surfaces the contract's refusals verbatim ---");
  installMockFetch();
  try {
    // Something still riding the job's rows: a live derived regrade — the 409
    // names the regrade jobs to wait for in details.regrade_job_ids.
    setMockResponse("/api/jobs/eval-1", {
      status: 409,
      body: {
        error: {
          code: "job_not_terminal",
          message: "A regrade derived from this job is still running",
          details: { regrade_job_ids: ["rg-1", "rg-2"] },
        },
      },
    });
    const e = jobs({ apiKey: "test-key", baseUrl: BASE });
    let threw = false;
    try {
      await e.delete("eval-1");
    } catch (err: any) {
      threw = true;
      assert(err instanceof EvolveApiError, "throws the typed EvolveApiError");
      assertEqual(err.status, 409, "carries the HTTP status");
      assertEqual(err.code, "job_not_terminal", "carries the stable error code");
      assertEqual(
        (err.details as Record<string, unknown>)?.regrade_job_ids,
        ["rg-1", "rg-2"],
        "details name the regrade jobs to wait for"
      );
    }
    assert(threw, "throws on the 409");

    // CREATOR-ONLY: an org member who did not create the job answers 403
    // org_forbidden. The code rides EvolveApiError.code verbatim — it is not
    // in the typed union yet (the team-accounts lane leads the SDK), which is
    // exactly why code widens to string.
    setMockResponse("/api/jobs/eval-1", {
      status: 403,
      body: { error: { code: "org_forbidden", message: "Only the job's creator can delete it" } },
    });
    threw = false;
    try {
      await e.delete("eval-1");
    } catch (err: any) {
      threw = true;
      assertEqual(err.status, 403, "carries the 403");
      assertEqual(err.code, "org_forbidden", "the creator-only refusal's code rides verbatim");
    }
    assert(threw, "throws on the 403");
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

async function testTrialUsageReading() {
  console.log("\n--- the one-home usage reading maps verbatim, and malformed answers null ---");
  installMockFetch();
  try {
    // Live: provisional reading ticking while the trial runs.
    setMockResponse("/api/trials/run-live-usage", {
      status: 200,
      body: wireTrial({
        id: "run-live-usage",
        status: "RUNNING",
        reward: null,
        verifier_result: null,
        agent_result: null,
        spend_source: null,
        finished_at: null,
        usage: {
          provisional: true,
          spent_usd: 0.0421,
          input_tokens: 12345,
          cached_input_tokens: 4102,
          output_tokens: 2210,
          as_of: "2026-07-22T00:02:00.000Z",
        },
      }),
    });
    const t = trials({ apiKey: "test-key", baseUrl: BASE });
    const live = await t.get("run-live-usage");
    assertEqual(live.usage?.provisional, true, "provisional marks a reading still growing");
    assertEqual(live.usage?.spent_usd, 0.0421, "money maps");
    assertEqual(live.usage?.input_tokens, 12345, "input tokens map");
    assertEqual(live.usage?.cached_input_tokens, 4102, "the cached share maps");
    assertEqual(live.usage?.output_tokens, 2210, "output tokens map");
    assertEqual(live.usage?.as_of, "2026-07-22T00:02:00.000Z", "the reading carries its age");

    // Absent (older server) and malformed (no boolean provisional) both read
    // null — "the meter never answered", never a fabricated reading.
    setMockResponse("/api/trials/run-no-usage", {
      status: 200,
      body: wireTrial({ id: "run-no-usage" }),
    });
    const absent = await t.get("run-no-usage");
    assertEqual(absent.usage ?? null, null, "absent usage reads null");

    setMockResponse("/api/trials/run-bad-usage", {
      status: 200,
      body: wireTrial({ id: "run-bad-usage", usage: { spent_usd: "0.42" } }),
    });
    const malformed = await t.get("run-bad-usage");
    assertEqual(malformed.usage ?? null, null, "a reading without its provisional bool is refused");
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

async function testInspectionSurface() {
  console.log("\n--- remote inspection: trace filters, jobs().grep(), trials().files()/file() ---");
  installMockFetch();
  try {
    setMockResponse("/api/trials/run-1/trace", {
      status: 200,
      body: { items: [], nextCursor: null, hasMore: false },
    });
    const t = trials({ apiKey: "test-key", baseUrl: BASE });

    // The parsed-event filters ride the query verbatim, spelled as the
    // contract spells them, and compose with cursor/limit.
    await t.trace("run-1", { type: "agent.message", grep: "permission denied", tail: 50, cursor: "2" });
    const filtered = new URL(fetchCalls[fetchCalls.length - 1].url);
    assertEqual(filtered.searchParams.get("type"), "agent.message", "type rides the query");
    assertEqual(filtered.searchParams.get("grep"), "permission denied", "grep rides the query");
    assertEqual(filtered.searchParams.get("tail"), "50", "tail rides the query");
    assertEqual(filtered.searchParams.get("cursor"), "2", "the cursor still composes with the filters");

    // traceEvents() carries the filters on EVERY page, not only the first.
    (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init });
      const cursor = new URL(urlStr).searchParams.get("cursor");
      const pages: Record<string, unknown> = {
        "": { items: [{ seq: 1, type: "a", data: {} }], nextCursor: "1", hasMore: true },
        "1": { items: [{ seq: 2, type: "a", data: {} }], nextCursor: null, hasMore: false },
      };
      return buildMockResponse({ status: 200, body: pages[cursor ?? ""] });
    };
    fetchCalls.length = 0;
    const drained: number[] = [];
    for await (const event of t.traceEvents("run-1", { grep: "boom" })) drained.push(event.seq);
    assertEqual(drained, [1, 2], "the filtered drain yields every matching event");
    assert(
      fetchCalls.every((c) => new URL(c.url).searchParams.get("grep") === "boom"),
      "every page of a filtered drain carries the filter"
    );
    installMockFetch();

    // jobs().grep() — per-trial groups in the ordinary envelope.
    setMockResponse("/api/jobs/eval-1/grep", {
      status: 200,
      body: {
        items: [
          {
            trial_id: "run-1",
            task_name: "fix-bug",
            match_count: 7,
            events: [{ seq: 1, type: "agent.message", data: { text: "permission denied" } }],
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    const j = jobs({ apiKey: "test-key", baseUrl: BASE });
    const grepPage = await j.grep("eval-1", "permission denied", { type: "agent.message", limit: 10 });
    const grepUrl = new URL(fetchCalls[fetchCalls.length - 1].url);
    assert(grepUrl.pathname.endsWith("/api/jobs/eval-1/grep"), "targets the job grep route");
    assertEqual(grepUrl.searchParams.get("q"), "permission denied", "q rides the query");
    assertEqual(grepUrl.searchParams.get("type"), "agent.message", "the type narrower rides the query");
    assertEqual(grepUrl.searchParams.get("limit"), "10", "limit pages the trial groups");
    assertEqual(grepPage.items[0].trial_id, "run-1", "groups are keyed by trial");
    assertEqual(grepPage.items[0].match_count, 7, "the exact count survives the mapping");
    assertEqual(
      grepPage.items[0].events[0],
      { seq: 1, type: "agent.message", data: { text: "permission denied" } },
      "sample events map through the one TraceEvent mapper"
    );

    // trials().files() — the read-only-filesystem listing. The file-bytes
    // pattern registers FIRST: the mock matches by substring in insertion
    // order, and the bare "/files" pattern would swallow "/files/<path>".
    setMockResponse("/api/trials/run-1/files/verifier/verifier.log", {
      status: 200,
      body: null,
      bodyBytes: Buffer.from("PASS checks"),
    });
    setMockResponse("/api/trials/run-1/files", {
      status: 200,
      body: {
        items: [{ path: "verifier/verifier.log", size_bytes: 12 }],
        nextCursor: null,
        hasMore: false,
      },
    });
    const filesPage = await t.files("run-1", { limit: 5 });
    const filesUrl = new URL(fetchCalls[fetchCalls.length - 1].url);
    assert(filesUrl.pathname.endsWith("/api/trials/run-1/files"), "targets the files listing");
    assertEqual(filesUrl.searchParams.get("limit"), "5", "limit pages the listing");
    assertEqual(
      filesPage.items[0],
      { path: "verifier/verifier.log", size_bytes: 12 },
      "rows map as {path, size_bytes}"
    );

    // trials().file() — raw bytes, path segments encoded one by one, and the
    // three Range spellings.
    const whole = await t.file("run-1", "verifier/verifier.log");
    assertEqual(whole.toString("utf8"), "PASS checks", "the whole file arrives as raw bytes");
    assert(
      fetchCalls[fetchCalls.length - 1].url.endsWith("/api/trials/run-1/files/verifier/verifier.log"),
      "the path's slashes ARE the route"
    );
    const headerOf = () =>
      (fetchCalls[fetchCalls.length - 1].init?.headers as Record<string, string> | undefined)?.Range;
    assertEqual(headerOf(), undefined, "no Range header without a range");
    await t.file("run-1", "verifier/verifier.log", { start: 10, end: 19 });
    assertEqual(headerOf(), "bytes=10-19", "start+end spells bytes=a-b");
    await t.file("run-1", "verifier/verifier.log", { start: 10 });
    assertEqual(headerOf(), "bytes=10-", "start alone spells bytes=a-");
    await t.file("run-1", "verifier/verifier.log", { suffix: 100 });
    assertEqual(headerOf(), "bytes=-100", "suffix spells bytes=-n");
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
      [{ name: "codex", model_name: "gpt-5.5", version: null, reasoning_effort: null, kwargs: null, preset: null, skills: [], skill_locks: null }],
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
  for (const t of ["EvalSandboxProvider", "DatasetImportFailure", "JobCreate", "JobStatus", "DatasetSelector", "AgentInput", "TrialsClient", "JobDeleteResult"]) {
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
  // The staged copy exists only when a build could reach the contract (the
  // private server repo, via EVOLVE_OPENAPI_SPEC_PATH, or a legacy repo-root
  // copy) — a public checkout without it skips the content half.
  const stagedSpecUrl = new URL("../../spec/openapi.yaml", import.meta.url);
  if (!existsSync(stagedSpecUrl)) {
    console.log("  - SKIP: spec not present — gate runs in private CI or with EVOLVE_OPENAPI_SPEC_PATH");
    return;
  }
  const spec = await readFile(stagedSpecUrl, "utf-8");
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
  await testPartialPublishReads();
  await testJobBuildExclusionsMapping();
  await testVersionSourceMapping();
  await testActivateNotReady409();
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
  await testWatchImportSettlesToReady();
  await testWatchImportSurfacesBuildFailure();
  await testWatchImportArchivingDisabledSettlesNormally();
  await testWatchImportSettleTimeoutBackstop();
  await testWatchImportSettleTimeoutBoundsRateLimitedPolls();
  await testWatchImportFailureReReadSurvivesRateLimit();
  await testWatchImportFailureReReadIsBounded();
  await testAgentCreateInstallScript();
  await testAgentCreateTarball();
  await testSkillsUploadCarriesFolderName();
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
  await testRetryJob();
  await testRetryTrialReturnsJob();
  await testRetryNotSettledIsTypedError();
  await testRegradeJob();
  await testRegradeTrialReturnsJob();
  await testRegradeIneligibleError();
  await testAnalyzeJob();
  await testAnalyzeAbsentFieldsMapNull();
  await testAnalyzeTypedRefusals();
  await testWatchAnalysisPollsToSettled();
  await testTrialAnalysisMapsVerbatim();
  await testDownloadJobBuffer();
  await testDownloadJobToFile();
  await testDownloadJobStream();
  await testDownloadJobIntegrityChecks();
  await testDownloadJobTerminalRequired();
  await testUploadJobDirectory();
  await testUploadJobDatasetHint();
  await testUploadJobDirGate();
  await testUploadJobArchivePassthrough();
  await testUploadJobDeterministicPack();
  await testUploadProvenanceMappingEdges();
  await testUploadExecutionHonesty();
  await testUploadJobTypedErrors();
  await testDeleteJob();
  await testDeleteJobTypedRefusals();
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
  await testTrialUsageReading();
  await testTrialTracePage();
  await testTraceEventsIterator();
  await testInspectionSurface();
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
