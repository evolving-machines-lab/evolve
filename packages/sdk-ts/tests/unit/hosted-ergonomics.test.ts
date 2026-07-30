#!/usr/bin/env tsx
/**
 * Unit Test: Hosted SDK ergonomics
 *
 * Covers the four things the hosted surface was missing at the call site:
 *
 *   1. Real promise methods on the dual-use handles. They were PromiseLike, so
 *      `await client.list()` compiled and `client.list().catch(...)` did not —
 *      a 90%-promise whose missing 10% is only discovered at the call site that
 *      needed it.
 *   2. Errors a UI can act on: param, details, requestId, retryAfterSec, and a
 *      closed error-code union so a typo cannot compile.
 *   3. The registration verbs: listImports, datasets.delete, agents.upsert.
 *   4. One front door — hosted() — so configuration is passed once, with meta()
 *      reachable without an API key.
 *
 * Usage:
 *   npx tsx tests/unit/hosted-ergonomics.test.ts
 */

import {
  agents,
  datasets,
  hosted,
  meta,
  EvolveApiError,
  HOSTED_ERROR_CODES,
  isHostedErrorCode,
} from "../../src/hosted/index.ts";

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

type MockResponse = { status: number; body: unknown; headers?: Record<string, string> };

const fetchCalls: { url: string; init?: RequestInit }[] = [];
let mockResponses: Map<string, MockResponse> = new Map();
const originalFetch = globalThis.fetch;

function installMockFetch() {
  fetchCalls.length = 0;
  mockResponses = new Map();
  (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    fetchCalls.push({ url: urlStr, init });
    for (const [pattern, resp] of mockResponses) {
      if (urlStr.includes(pattern)) {
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          statusText: resp.status < 300 ? "OK" : "Error",
          headers: new Headers(resp.headers || {}),
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        } as unknown as Response;
      }
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
      json: async () => ({}),
      text: async () => "not found",
    } as unknown as Response;
  };
}

const emptyPage = { items: [], nextCursor: null, hasMore: false };

async function main() {
  process.env.EVOLVE_API_KEY = "test-key";
  process.env.EVOLVE_DASHBOARD_URL = "https://api.test";

  // ===========================================================================
  console.log("\n1. Dual-use handles are real promises\n");
  // ===========================================================================
  {
    installMockFetch();
    mockResponses.set("/api/datasets", { status: 200, body: emptyPage });

    const d = datasets();

    // .catch() used to be a compile error two lines after await worked.
    const caught = await d.list().catch(() => "unreachable");
    assert(typeof caught === "object" && caught !== null, "list().catch() resolves the page when nothing throws");

    let ranFinally = false;
    const page = await d.list().finally(() => {
      ranFinally = true;
    });
    assert(ranFinally, "list().finally() runs");
    assertEqual((page as { items: unknown[] }).items, [], "finally() passes the page through unchanged");

    // A rejection really reaches .catch() rather than escaping as unhandled.
    mockResponses.set("/api/datasets", { status: 500, body: { error: { code: "internal_error", message: "boom" } } });
    const failure = await datasets().list().catch((err: unknown) => err);
    assert(failure instanceof EvolveApiError, "list().catch() receives the typed error");
  }

  {
    // ONE request per handle, however many promise methods touch it: without
    // the memo, then() + a later catch() would each fetch a page.
    installMockFetch();
    mockResponses.set("/api/datasets", { status: 200, body: emptyPage });
    const handle = datasets().list();
    await handle;
    await handle.catch(() => null);
    await handle.finally(() => {});
    assertEqual(fetchCalls.length, 1, "a handle issues exactly one request no matter how it is consumed");
  }

  {
    // The iterable form still walks pages.
    installMockFetch();
    let call = 0;
    (globalThis as any).fetch = async (url: string | URL) => {
      call++;
      const body =
        call === 1
          ? { items: [{ name: "a", title: null, description: null, active_version: null, upstream: null }], nextCursor: "c1", hasMore: true }
          : { items: [{ name: "b", title: null, description: null, active_version: null, upstream: null }], nextCursor: null, hasMore: false };
      fetchCalls.push({ url: url.toString() });
      return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => "" } as unknown as Response;
    };
    const names: string[] = [];
    for await (const row of datasets().list()) names.push(row.name);
    assertEqual(names, ["a", "b"], "for-await still walks every page");
  }

  // ===========================================================================
  console.log("\n2. Errors a UI can act on\n");
  // ===========================================================================
  {
    installMockFetch();
    mockResponses.set("/api/datasets", {
      status: 400,
      body: {
        error: {
          code: "provider_unsupported",
          message: "11 of 40 tasks cannot run on modal: t1; t2; t3; and 8 more",
          param: "sandbox_provider",
          details: {
            provider: "modal",
            refusedTasks: Array.from({ length: 11 }, (_, i) => ({ task_name: `t${i}`, reason: "no dockerd" })),
          },
          retryAfterSec: undefined,
          requestId: "req_abc123",
        },
      },
    });

    const err = (await datasets().list().catch((e: unknown) => e)) as EvolveApiError;
    assert(err instanceof EvolveApiError, "a 400 maps to EvolveApiError");
    assertEqual(err.code, "provider_unsupported", "code survives");
    assertEqual(err.param, "sandbox_provider", "param names the field that was wrong");
    assertEqual(err.requestId, "req_abc123", "requestId is available to quote in a support thread");
    const refused = (err.details as { refusedTasks: unknown[] }).refusedTasks;
    assertEqual(refused.length, 11, "details carries all 11 refusals, not the 3 the sentence named");
    assert(err.isKnownCode(), "isKnownCode() is true for a published code");
  }

  {
    // retryAfterSec falls back to the header, because a cross-origin browser
    // fetch cannot always read it from there.
    installMockFetch();
    mockResponses.set("/api/datasets", {
      status: 429,
      body: { error: { code: "rate_limited", message: "slow down" } },
      headers: { "Retry-After": "12", "X-Request-Id": "req_hdr" },
    });
    const err = (await datasets().list().catch((e: unknown) => e)) as EvolveApiError;
    assertEqual(err.retryAfterSec, 12, "retryAfterSec falls back to the Retry-After header");
    assertEqual(err.requestId, "req_hdr", "requestId falls back to the X-Request-Id header");
  }

  {
    installMockFetch();
    mockResponses.set("/api/datasets", { status: 502, body: "<html>bad gateway</html>" });
    const err = (await datasets().list().catch((e: unknown) => e)) as EvolveApiError;
    assertEqual(err.code, "unknown_error", "an unparseable body still yields a typed error");
    assert(!err.isKnownCode(), "isKnownCode() is false for unknown_error");
  }

  {
    assert(HOSTED_ERROR_CODES.includes("insufficient_credits"), "the code vocabulary is exported");
    assert(!isHostedErrorCode("insufficient_creidts"), "a typo is not a known code");
    assert(new Set(HOSTED_ERROR_CODES).size === HOSTED_ERROR_CODES.length, "no duplicate codes");
  }

  // ===========================================================================
  console.log("\n3. The registration verbs\n");
  // ===========================================================================
  {
    installMockFetch();
    mockResponses.set("/api/datasets/imports", { status: 200, body: emptyPage });
    await datasets().listImports({ status: "FAILED", dataset: "deep-swe", limit: 10 });
    const url = fetchCalls[0].url;
    assert(url.includes("/api/datasets/imports"), "listImports hits the import collection");
    assert(url.includes("status=FAILED"), "listImports passes the status filter");
    assert(url.includes("dataset=deep-swe"), "listImports passes the dataset filter");
    assert(url.includes("limit=10"), "listImports passes the page limit");
  }

  {
    installMockFetch();
    mockResponses.set("/api/datasets/typo", { status: 204, body: null });
    await datasets().delete("typo");
    assertEqual(fetchCalls[0].init?.method, "DELETE", "datasets().delete() sends DELETE");
    assert(fetchCalls[0].url.endsWith("/api/datasets/typo"), "…at the named dataset");
  }

  {
    installMockFetch();
    mockResponses.set("/api/agents/my-agent", {
      status: 200,
      body: { name: "my-agent", source: "install_script", run_command: "x", env: {}, created_at: "", updated_at: "" },
    });
    await agents().upsert("my-agent", {
      run_command: "my-agent --headless",
      install_script: "curl -fsSL https://example.test/install.sh | sh",
    });
    assertEqual(fetchCalls[0].init?.method, "PUT", "upsert() sends PUT — one call, no window where the name is gone");
    assert(fetchCalls[0].url.endsWith("/api/agents/my-agent"), "…under the name in the path");
    assert(fetchCalls[0].init?.body instanceof FormData, "upsert() uses the same multipart grammar as create()");
  }

  {
    // Both source shapes are still mutually exclusive, and the refusal happens
    // client-side before a request is made.
    let threw = false;
    try {
      await agents().upsert("a", { run_command: "x", install_script: "y", directory: "/tmp" } as any);
    } catch {
      threw = true;
    }
    assert(threw, "upsert() refuses two sources before sending anything");

    threw = false;
    try {
      await agents().upsert("a", { run_command: "x" } as any);
    } catch {
      threw = true;
    }
    assert(threw, "upsert() refuses no source at all");
  }

  // ===========================================================================
  console.log("\n4. One front door\n");
  // ===========================================================================
  {
    installMockFetch();
    mockResponses.set("/api/datasets", { status: 200, body: emptyPage });

    const client = hosted({ apiKey: "explicit-key", baseUrl: "https://other.test" });
    await client.datasets.list();
    assert(fetchCalls[0].url.startsWith("https://other.test"), "config passed once reaches the datasets client");
    const auth = (fetchCalls[0].init?.headers as Record<string, string>)?.Authorization;
    assertEqual(auth, "Bearer explicit-key", "…including the API key");

    // Same instance on repeat access — the clients are memoized, not rebuilt.
    assert(client.datasets === client.datasets, "datasets is built once and reused");
    assert(client.jobs === client.jobs, "jobs is built once and reused");
    assert(client.agents === client.agents, "agents is built once and reused");
    assert(client.trials === client.trials, "trials is built once and reused");
  }

  {
    // meta() needs no key, so a signed-out page can populate an agent picker.
    installMockFetch();
    const savedKey = process.env.EVOLVE_API_KEY;
    delete process.env.EVOLVE_API_KEY;
    mockResponses.set("/api/meta", {
      status: 200,
      body: { schema_version: 1, agents: [{ name: "claude" }], error_codes: ["invalid_input"] },
    });

    const document = await hosted().meta();
    assertEqual(document.schema_version, 1, "meta() parses the capability document");
    const sentAuth = (fetchCalls[0].init?.headers as Record<string, string> | undefined)?.Authorization;
    assert(sentAuth === undefined, "meta() sends no Authorization header");

    const standalone = await meta({ baseUrl: "https://api.test" });
    assertEqual(standalone.agents.length, 1, "meta() also works as a standalone function");

    // ...but reaching for something that DOES need a key still fails loudly.
    let threw = false;
    try {
      hosted().jobs;
    } catch {
      threw = true;
    }
    assert(threw, "hosted().jobs still throws without an API key — lazily, not at construction");

    if (savedKey !== undefined) process.env.EVOLVE_API_KEY = savedKey;
  }

  // ===========================================================================
  console.log("\n5. Upstream version awareness\n");
  // ===========================================================================
  {
    installMockFetch();
    mockResponses.set("/api/datasets/deep-swe", {
      status: 200,
      body: {
        name: "deep-swe",
        title: null,
        description: null,
        active_version: null,
        versions: [],
        selected_version: null,
        tasks: emptyPage,
        upstream: {
          ref: "main",
          current_commit: "a".repeat(40),
          latest_commit: "b".repeat(40),
          moved: true,
          behind_by: null,
          checked_at: "2026-07-24T00:00:00.000Z",
          error: null,
          auto_import: true,
        },
        created_at: "",
        updated_at: "",
      },
    });
    const dataset = await datasets().get("deep-swe");
    assertEqual(dataset.upstream?.moved, true, "upstream.moved is what a badge branches on");
    assertEqual(dataset.upstream?.behind_by, null, "behind_by is null — the watcher never fetches a commit graph");
    assertEqual(dataset.upstream?.auto_import, true, "auto_import says whether a moved upstream imports itself");
  }

  {
    // An older server that omits the field must read as "nothing to watch",
    // never as undefined a caller has to distinguish from null.
    installMockFetch();
    mockResponses.set("/api/datasets/old", {
      status: 200,
      body: {
        name: "old", title: null, description: null, active_version: null,
        versions: [], selected_version: null, tasks: emptyPage, created_at: "", updated_at: "",
      },
    });
    const dataset = await datasets().get("old");
    assertEqual(dataset.upstream, null, "a missing upstream field maps to null, not undefined");
  }

  globalThis.fetch = originalFetch;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`${"=".repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
