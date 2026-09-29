#!/usr/bin/env tsx
/**
 * Unit Test: the managed create request seam, driven by the REAL e2b client over a local door
 *
 * Pins e2b 2.39's API error mapping (a 429 is a RateLimitError, a 401 an AuthenticationError, any
 * other status a SandboxError "<status>: <body>", with neither the status nor the Retry-After header
 * kept on the error) and the one place the SDK's retry may wrap: Sandbox.create alone. A refusal on
 * the envd call after it surfaces loudly and never makes a second box.
 *
 * Usage:
 *   npx tsx tests/unit/e2b-create-request-retry.test.ts
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createE2BProvider, type CreateRequestRetry } from "../../src/index.ts";

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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message} (expected ${e}, got ${a})`);
  }
}

interface DoorRequest {
  method: string;
  url: string;
}

interface DoorAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A local HTTP door the real client talks to; every request is recorded, `answer` scripts each reply. */
async function localDoor(
  answer: (req: DoorRequest) => DoorAnswer,
): Promise<{ url: string; requests: DoorRequest[]; close: () => Promise<void> }> {
  const requests: DoorRequest[] = [];
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const record = { method: req.method ?? "GET", url: req.url ?? "/" };
      requests.push(record);
      const reply = answer(record);
      res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const SERVER_TEXT = "credential check unavailable; try again";
const REFUSAL = (status: number): DoorAnswer => ({
  status,
  body: { error: SERVER_TEXT },
  headers: { "retry-after": "5" },
});
const BOX = {
  sandboxID: "sbx-1",
  templateID: "evolve-all",
  envdVersion: "0.2.0",
  envdAccessToken: "envd-token",
  clientID: "c1",
  startedAt: "2026-09-26T00:00:00.000Z",
  endAt: "2026-09-26T01:00:00.000Z",
};

const isCreate = (r: DoorRequest) => r.method === "POST" && r.url.endsWith("/sandboxes");

/** The managed key shape: `e2b_` plus the hex of the Evolve key, which is what the client's key check accepts. */
const MANAGED_KEY = `e2b_${Buffer.from("sk-evolve-key", "utf8").toString("hex")}`;

function managedProvider(doorUrl: string, retryCreateRequest?: CreateRequestRetry) {
  return createE2BProvider({ apiKey: MANAGED_KEY, apiUrl: doorUrl, retryCreateRequest });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
}

async function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

type VendorError = Error & { statusCode?: unknown; status?: unknown; headers?: unknown };

/**
 * The test's stand-in for the SDK's retry: one more try after a RateLimitError or a "503: …"
 * SandboxError, counting how often the seam was entered and how often it sent.
 */
function retryOnce(): { retry: CreateRequestRetry; entered: () => number; sent: () => number } {
  let entered = 0;
  let sent = 0;
  const retry: CreateRequestRetry = async (send) => {
    entered++;
    const attempt = () => {
      sent++;
      return send();
    };
    try {
      return await attempt();
    } catch (err) {
      const e = err as Error;
      if (e.name === "RateLimitError" || (e.name === "SandboxError" && e.message.startsWith("503:"))) {
        return attempt();
      }
      throw err;
    }
  };
  return { retry, entered: () => entered, sent: () => sent };
}

// =============================================================================
// [1] The pinned vendor shapes — what the real client throws for a door refusal
// =============================================================================

async function testRefusalShapes(): Promise<void> {
  console.log("\n[1] the client's API errors: class by status, the door body stringified, no status or header kept");
  const expectations: Array<[number, string, (message: string) => boolean]> = [
    [503, "SandboxError", (m) => m === "503: [object Object]"],
    [429, "RateLimitError", (m) => m.startsWith("Rate limit exceeded")],
    [401, "AuthenticationError", (m) => m.startsWith("Unauthorized")],
  ];
  for (const [status, name, messageIs] of expectations) {
    const door = await localDoor(() => REFUSAL(status));
    try {
      const err = (await rejection(managedProvider(door.url).create({ image: "evolve-all" }))) as VendorError;
      assertEqual(err?.name, name, `${status} is a ${name}`);
      assert(messageIs(err?.message ?? ""), `${status} message shape (got "${err?.message}")`);
      assert(err?.status === undefined && err?.statusCode === undefined, "no status field rides on the error");
      assertEqual(err?.headers, undefined, "no headers ride on the error");
      assertEqual(door.requests.filter(isCreate).length, 1, "one create request without a retry seam");
    } finally {
      await door.close();
    }
  }
}

// =============================================================================
// [2] The seam — Sandbox.create alone rides retryCreateRequest
// =============================================================================

async function testCreateRequestRidesTheSeam(): Promise<void> {
  console.log("\n[2a] a refused create request is sent again through the seam; the box is made once");
  let creates = 0;
  const door = await localDoor((req) => {
    if (!isCreate(req)) return { status: 200, body: {} };
    return ++creates === 1 ? REFUSAL(503) : { status: 201, body: BOX };
  });
  const seam = retryOnce();
  try {
    const sandbox = await managedProvider(door.url, seam.retry).create({ image: "evolve-all" });
    assertEqual(sandbox.sandboxId, "sbx-1", "the create resolves with the box the retry got");
    assertEqual(door.requests.filter(isCreate).length, 2, "two create requests: the refusal and the answer");
    assertEqual([seam.entered(), seam.sent()], [1, 2], "the seam was entered once and sent twice");
  } finally {
    await door.close();
  }
}

async function testRefusalAfterTheBoxNeverRecreates(): Promise<void> {
  console.log("\n[2b] a 503 on the envd call after the box exists never re-enters the seam");
  const door = await localDoor((req) => (isCreate(req) ? { status: 201, body: BOX } : REFUSAL(503)));
  const seam = retryOnce();
  try {
    // E2B_SANDBOX_URL points the client's envd traffic (the makeDir) at the same local door.
    const err = (await withEnv({ E2B_SANDBOX_URL: door.url }, () =>
      rejection(
        managedProvider(door.url, seam.retry).create({ image: "evolve-all", workingDirectory: "/work" }),
      ),
    )) as VendorError;
    assert(err instanceof Error, `the envd refusal surfaces, loud (${err?.name})`);
    assertEqual(door.requests.filter(isCreate).length, 1, "exactly ONE create request");
    assertEqual([seam.entered(), seam.sent()], [1, 1], "the seam saw the create request alone");
  } finally {
    await door.close();
  }
}

// =============================================================================
// RUN
// =============================================================================

const tests = [testRefusalShapes, testCreateRequestRidesTheSeam, testRefusalAfterTheBoxNeverRecreates];

(async () => {
  console.log("=== E2B Create Request Retry Tests ===");
  try {
    for (const test of tests) {
      await test();
    }
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    // Explicit exit: the client's pooled connections outlive the door.
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Unexpected error:", err);
    process.exit(1);
  }
})();
