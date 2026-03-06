#!/usr/bin/env tsx
/**
 * Unit Test: Sessions Client
 *
 * Tests the sessions() factory function, mapSessionInfo mapping,
 * list query parameter construction, and error handling.
 *
 * Uses mock fetch to test without real network calls.
 *
 * Usage:
 *   npx tsx tests/unit/sessions-client.test.ts
 */

// =============================================================================
// TEST HELPERS
// =============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message}`);
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
}

let mockResponses: Map<string, MockResponse> = new Map();

function setMockResponse(urlPattern: string, response: MockResponse) {
  mockResponses.set(urlPattern, response);
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
        let body: ReadableStream | null = null;
        if (resp.streamBody != null) {
          const nodeStream = Readable.from(Buffer.from(resp.streamBody, "utf-8"));
          body = Readable.toWeb(nodeStream) as ReadableStream;
        }
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          statusText: resp.status === 200 ? "OK" : "Error",
          headers: new Headers(resp.headers || {}),
          json: async () => resp.body,
          text: async () => resp.streamBody ?? JSON.stringify(resp.body),
          body,
        } as unknown as Response;
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

// We import the source directly to test mapSessionInfo behavior
import { sessions } from "../../src/sessions/index.ts";

// =============================================================================
// TESTS
// =============================================================================

async function testRequiresApiKey() {
  console.log("\n--- sessions() requires API key ---");
  const origKey = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;
  try {
    let threw = false;
    try {
      sessions();
    } catch (e: any) {
      threw = true;
      assert(e.message.includes("API key"), "error mentions API key");
    }
    assert(threw, "throws without API key");
  } finally {
    if (origKey) process.env.EVOLVE_API_KEY = origKey;
  }
}

async function testAcceptsConfigApiKey() {
  console.log("\n--- sessions() accepts config.apiKey ---");
  installMockFetch();
  try {
    const s = sessions({ apiKey: "test-key", dashboardUrl: "http://localhost:3000" });
    assert(typeof s.list === "function", "has list method");
    assert(typeof s.get === "function", "has get method");
    assert(typeof s.events === "function", "has events method");
    assert(typeof s.download === "function", "has download method");
  } finally {
    restoreFetch();
  }
}

async function testMapSessionInfo() {
  console.log("\n--- mapSessionInfo maps fields correctly ---");
  installMockFetch();
  try {
    const rawSession = {
      id: "sess-123",
      tag: "my-session",
      agent: "claude",
      model: "haiku",
      provider: "e2b",
      sandboxId: "sb-456",
      isEnded: true,
      runtimeStatus: "dead",
      cost: 0.0523,
      createdAt: "2026-03-01T00:00:00.000Z",
      endedAt: "2026-03-01T00:05:00.000Z",
      stepCount: 10,
      toolStats: { "Read": 3, "Write": 2 },
      // Internal fields that should NOT leak through SDK mapping
      userId: "user-abc",
      filePath: "s3://bucket/sessions/user-abc/my-session.jsonl",
      costSyncedAt: "2026-03-01T00:06:00.000Z",
      timestamp: "2026-03-01T00:00:00.000Z",
    };

    setMockResponse("/api/sessions/sess-123", { status: 200, body: rawSession });

    const s = sessions({ apiKey: "test-key", dashboardUrl: "http://localhost:3000" });
    const result = await s.get("sess-123");

    assertEqual(result.id, "sess-123", "maps id");
    assertEqual(result.tag, "my-session", "maps tag");
    assertEqual(result.agent, "claude", "maps agent");
    assertEqual(result.model, "haiku", "maps model");
    assertEqual(result.provider, "e2b", "maps provider");
    assertEqual(result.sandboxId, "sb-456", "maps sandboxId");
    assertEqual(result.state, "ended", "computes state from isEnded=true");
    assertEqual(result.runtimeStatus, "dead", "maps runtimeStatus");
    assertEqual(result.cost, 0.0523, "maps cost");
    assertEqual(result.createdAt, "2026-03-01T00:00:00.000Z", "maps createdAt");
    assertEqual(result.endedAt, "2026-03-01T00:05:00.000Z", "maps endedAt");
    assertEqual(result.stepCount, 10, "maps stepCount");
    assertEqual(result.toolStats, { "Read": 3, "Write": 2 }, "maps toolStats");

    // Verify internal fields are NOT exposed
    assert(!("userId" in result), "userId not exposed");
    assert(!("filePath" in result), "filePath not exposed");
    assert(!("costSyncedAt" in result), "costSyncedAt not exposed");
  } finally {
    restoreFetch();
  }
}

async function testMapSessionInfoLiveState() {
  console.log("\n--- mapSessionInfo computes state=live for isEnded=false ---");
  installMockFetch();
  try {
    setMockResponse("/api/sessions/sess-live", {
      status: 200,
      body: {
        id: "sess-live",
        tag: "live-session",
        agent: "codex",
        provider: "e2b",
        isEnded: false,
        runtimeStatus: "alive",
        createdAt: "2026-03-01T00:00:00.000Z",
      },
    });

    const s = sessions({ apiKey: "test-key", dashboardUrl: "http://localhost:3000" });
    const result = await s.get("sess-live");

    assertEqual(result.state, "live", "state is live when isEnded=false");
    assertEqual(result.runtimeStatus, "alive", "runtimeStatus preserved");
    assertEqual(result.model, null, "model defaults to null");
    assertEqual(result.sandboxId, null, "sandboxId defaults to null");
    assertEqual(result.cost, null, "cost defaults to null when missing");
    assertEqual(result.endedAt, null, "endedAt defaults to null");
    assertEqual(result.stepCount, 0, "stepCount defaults to 0");
    assertEqual(result.toolStats, null, "toolStats defaults to null");
  } finally {
    restoreFetch();
  }
}

async function testListQueryParams() {
  console.log("\n--- list() builds correct query params ---");
  installMockFetch();
  try {
    setMockResponse("/api/sessions", {
      status: 200,
      body: { items: [], nextCursor: null, hasMore: false },
    });

    const s = sessions({ apiKey: "test-key", dashboardUrl: "http://localhost:3000" });

    // Default params
    await s.list();
    let url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("paginationMode=cursor"), "uses cursor pagination");
    assert(url.includes("pageSize=20"), "default pageSize=20");
    assert(url.includes("paginated=true"), "paginated=true");

    // Custom params
    await s.list({ limit: 50, state: "ended", agent: "claude", tagPrefix: "test-", sort: "cost" });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("pageSize=50"), "custom pageSize");
    assert(url.includes("state=ended"), "state filter");
    assert(url.includes("agent=claude"), "agent filter");
    assert(url.includes("tagPrefix=test-"), "tagPrefix filter");
    assert(url.includes("sortField=cost"), "sort by cost field");
    assert(url.includes("sortDirection=desc"), "cost sort direction");

    // Sort by oldest
    await s.list({ sort: "oldest" });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("sortField=timestamp"), "oldest sorts by timestamp");
    assert(url.includes("sortDirection=asc"), "oldest sorts asc");

    // state=all should not set state param
    await s.list({ state: "all" });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(!url.includes("state="), "state=all omits state param");

    // Limit capped at 200
    await s.list({ limit: 500 });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("pageSize=200"), "limit capped at 200");

    // Cursor forwarding
    await s.list({ cursor: "abc-123" });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("cursor=abc-123"), "cursor forwarded");
  } finally {
    restoreFetch();
  }
}

async function testListPagination() {
  console.log("\n--- list() returns pagination info ---");
  installMockFetch();
  try {
    setMockResponse("/api/sessions", {
      status: 200,
      body: {
        items: [
          { id: "s1", tag: "a", agent: "claude", provider: "e2b", isEnded: true, createdAt: "2026-01-01" },
          { id: "s2", tag: "b", agent: "codex", provider: "e2b", isEnded: false, createdAt: "2026-01-02" },
        ],
        nextCursor: "cursor-xyz",
        hasMore: true,
      },
    });

    const s = sessions({ apiKey: "test-key", dashboardUrl: "http://localhost:3000" });
    const page = await s.list();

    assertEqual(page.items.length, 2, "returns 2 items");
    assertEqual(page.items[0].id, "s1", "first item id");
    assertEqual(page.items[0].state, "ended", "first item state");
    assertEqual(page.items[1].state, "live", "second item state");
    assertEqual(page.nextCursor, "cursor-xyz", "nextCursor");
    assertEqual(page.hasMore, true, "hasMore");
  } finally {
    restoreFetch();
  }
}

async function testAuthHeader() {
  console.log("\n--- requests include Bearer auth header ---");
  installMockFetch();
  try {
    setMockResponse("/api/sessions", {
      status: 200,
      body: { items: [], nextCursor: null, hasMore: false },
    });

    const s = sessions({ apiKey: "my-secret-key", dashboardUrl: "http://localhost:3000" });
    await s.list();

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const headers = lastCall.init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer my-secret-key", "Bearer token sent");
  } finally {
    restoreFetch();
  }
}

async function testEventsWithSince() {
  console.log("\n--- events() supports since parameter ---");
  installMockFetch();
  try {
    setMockResponse("/api/sessions/s1/events", {
      status: 200,
      body: { events: [{ update: "chunk1" }, { update: "chunk2" }] },
    });

    const s = sessions({ apiKey: "test-key", dashboardUrl: "http://localhost:3000" });

    // Without since
    await s.events("s1");
    let url = fetchCalls[fetchCalls.length - 1].url;
    assert(!url.includes("since"), "no since param by default");

    // With since
    await s.events("s1", { since: 10 });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("since=10"), "since param forwarded");

    // since=0 (falsy but valid)
    await s.events("s1", { since: 0 });
    url = fetchCalls[fetchCalls.length - 1].url;
    assert(url.includes("since=0"), "since=0 (falsy but valid) included in params");
  } finally {
    restoreFetch();
  }
}

async function testApiErrorHandling() {
  console.log("\n--- API errors throw with status and body ---");
  installMockFetch();
  try {
    setMockResponse("/api/sessions", {
      status: 401,
      body: { error: "Unauthorized" },
    });

    const s = sessions({ apiKey: "bad-key", dashboardUrl: "http://localhost:3000" });
    let threw = false;
    try {
      await s.list();
    } catch (e: any) {
      threw = true;
      assert(e.message.includes("401"), "error includes status code");
    }
    assert(threw, "throws on 401");
  } finally {
    restoreFetch();
  }
}

async function testDownloadStreaming() {
  console.log("\n--- download() streams to file via Readable.fromWeb ---");
  installMockFetch();
  const tmpDir = join(tmpdir(), `sessions-test-${Date.now()}`);
  try {
    const jsonlContent = [
      '{"_meta":{"tag":"test-dl","agent":"claude"}}',
      '{"_prompt":{"text":"hello"}}',
      '{"_sessionEnd":{"timestamp":"2026-03-01T00:05:00Z"}}',
    ].join("\n") + "\n";

    // Mock GET /sessions/sess-dl/download → streaming JSONL body (register FIRST so it matches before metadata)
    setMockResponse("/sess-dl/download", {
      status: 200,
      body: null,
      streamBody: jsonlContent,
    });

    // Mock GET /sessions/sess-dl → session metadata
    setMockResponse("/api/sessions/sess-dl", {
      status: 200,
      body: { id: "sess-dl", tag: "test-dl", agent: "claude", provider: "e2b", isEnded: true },
    });

    const s = sessions({ apiKey: "test-key", dashboardUrl: "http://localhost:3000" });
    const filePath = await s.download("sess-dl", { to: tmpDir });

    assert(filePath.endsWith("test-dl.jsonl"), "filename uses session tag");
    const written = await readFile(filePath, "utf-8");
    assertEqual(written, jsonlContent, "file content matches streamed JSONL");

    // Verify the download request used correct auth
    const dlCall = fetchCalls.find(c => c.url.includes("/download"));
    assert(!!dlCall, "download endpoint was called");
    const headers = dlCall!.init?.headers as Record<string, string>;
    assertEqual(headers?.Authorization, "Bearer test-key", "download uses Bearer auth");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    restoreFetch();
  }
}

async function testDownloadNoBody() {
  console.log("\n--- download() throws when response has no body ---");
  installMockFetch();
  try {
    // Register download mock FIRST (more specific path)
    setMockResponse("/sess-nobody/download", { status: 200, body: null });
    setMockResponse("/api/sessions/sess-nobody", {
      status: 200,
      body: { id: "sess-nobody", tag: "no-body", agent: "claude", provider: "e2b" },
    });

    const s = sessions({ apiKey: "test-key", dashboardUrl: "http://localhost:3000" });
    let threw = false;
    try {
      await s.download("sess-nobody", { to: join(tmpdir(), "no-body-test") });
    } catch (e: any) {
      threw = true;
      assert(e.message.includes("no body"), "error mentions missing body");
    }
    assert(threw, "throws when response body is null");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// RUN
// =============================================================================

async function main() {
  console.log("Sessions Client Unit Tests\n");

  await testRequiresApiKey();
  await testAcceptsConfigApiKey();
  await testMapSessionInfo();
  await testMapSessionInfoLiveState();
  await testListQueryParams();
  await testListPagination();
  await testAuthHeader();
  await testEventsWithSince();
  await testApiErrorHandling();
  await testDownloadStreaming();
  await testDownloadNoBody();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
