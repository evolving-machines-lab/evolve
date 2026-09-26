#!/usr/bin/env tsx
/**
 * Unit Test: the managed create request seam, driven by the REAL Daytona client over a local door
 *
 * Pins @daytonaio/sdk 0.203's translated server errors (statusCode and the response headers ride on
 * the error) and the one place the SDK's retry may wrap: sandboxApi.createSandbox alone. A refusal on
 * any later call (a start poll, the toolbox) surfaces loudly and never makes a second box.
 *
 * Usage:
 *   npx tsx tests/unit/daytona-create-request-retry.test.ts
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDaytonaProvider, type CreateRequestRetry } from "../../src/index.ts";

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
  // The client also tries a websocket upgrade; refusing it keeps the door a plain HTTP server.
  server.on("upgrade", (_req, socket) => socket.destroy());
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
  id: "dtn-1",
  state: "started",
  toolboxProxyUrl: "https://runner.test",
  labels: {},
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
};

const isCreate = (r: DoorRequest) => r.method === "POST" && r.url.endsWith("/sandbox");

function managedProvider(doorUrl: string, retryCreateRequest?: CreateRequestRetry) {
  return createDaytonaProvider({
    apiKey: "sk-evolve-key",
    apiUrl: `${doorUrl}/api`,
    managedToolboxUrl: `${doorUrl}/toolbox`,
    retryCreateRequest,
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
}

type VendorError = Error & { statusCode?: unknown; headers?: { get?: (n: string) => unknown; [k: string]: unknown } };

function retryAfterOf(err: VendorError): unknown {
  const headers = err.headers;
  return typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
}

/**
 * The test's stand-in for the SDK's retry: one more try after a 429/503, counting how often the seam
 * was entered and how often it sent. The SDK's own pacing is not under test here.
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
      const status = (err as VendorError).statusCode;
      if (status === 429 || status === 503) return attempt();
      throw err;
    }
  };
  return { retry, entered: () => entered, sent: () => sent };
}

// =============================================================================
// [1] The pinned vendor shapes — what the real client throws for a door refusal
// =============================================================================

async function testRefusalShapes(): Promise<void> {
  console.log("\n[1] the client's translated errors keep statusCode, headers and the door's sentence");
  for (const [status, name] of [
    [503, "DaytonaServiceUnavailableError"],
    [429, "DaytonaRateLimitError"],
    [401, "DaytonaAuthenticationError"],
  ] as const) {
    const door = await localDoor(() => REFUSAL(status));
    try {
      const err = (await rejection(managedProvider(door.url).create({ image: "evolve-all" }))) as VendorError;
      assertEqual(err?.name, name, `${status} is a ${name}`);
      assertEqual(err?.statusCode, status, `statusCode ${status} rides on the error`);
      assertEqual(retryAfterOf(err), "5", "the Retry-After header rides on the error");
      assert((err?.message ?? "").includes(SERVER_TEXT), "the door's sentence is the message");
      assertEqual(door.requests.filter(isCreate).length, 1, "one create request without a retry seam");
    } finally {
      await door.close();
    }
  }
}

// =============================================================================
// [2] The seam — createSandbox alone rides retryCreateRequest
// =============================================================================

async function testCreateRequestRidesTheSeam(): Promise<void> {
  console.log("\n[2a] a refused create request is sent again through the seam; the box is made once");
  let creates = 0;
  const door = await localDoor((req) => {
    if (!isCreate(req)) return { status: 200, body: {} };
    return ++creates === 1 ? REFUSAL(503) : { status: 200, body: BOX };
  });
  const seam = retryOnce();
  try {
    const sandbox = await managedProvider(door.url, seam.retry).create({ image: "evolve-all" });
    assertEqual(sandbox.sandboxId, "dtn-1", "the create resolves with the box the retry got");
    assertEqual(door.requests.filter(isCreate).length, 2, "two create requests: the refusal and the answer");
    assertEqual([seam.entered(), seam.sent()], [1, 2], "the seam was entered once and sent twice");
  } finally {
    await door.close();
  }
}

async function testRefusalAfterTheBoxNeverRecreates(): Promise<void> {
  console.log("\n[2b] a 503 on the toolbox call after the box exists never re-enters the seam");
  const door = await localDoor((req) => (isCreate(req) ? { status: 200, body: BOX } : REFUSAL(503)));
  const seam = retryOnce();
  try {
    const err = (await rejection(
      managedProvider(door.url, seam.retry).create({ image: "evolve-all", workingDirectory: "/work" }),
    )) as VendorError;
    assertEqual(err?.statusCode, 503, "the toolbox refusal surfaces, loud");
    assertEqual(door.requests.filter(isCreate).length, 1, "exactly ONE create request");
    assertEqual([seam.entered(), seam.sent()], [1, 1], "the seam saw the create request alone");
  } finally {
    await door.close();
  }
}

function testSeamWithoutTheDoorIsRefused(): void {
  console.log("\n[2c] retryCreateRequest without managedToolboxUrl is refused, never silently ignored");
  let message = "";
  try {
    createDaytonaProvider({ apiKey: "dtn-key", retryCreateRequest: async (send) => send() });
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes("managedToolboxUrl"), `the refusal names the missing door (got "${message}")`);
}

// =============================================================================
// RUN
// =============================================================================

const tests = [
  testRefusalShapes,
  testCreateRequestRidesTheSeam,
  testRefusalAfterTheBoxNeverRecreates,
  testSeamWithoutTheDoorIsRefused,
];

(async () => {
  console.log("=== Daytona Create Request Retry Tests ===");
  try {
    for (const test of tests) {
      await test();
    }
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    // Explicit exit: the client keeps a socket.io reconnect alive after the door closes.
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Unexpected error:", err);
    process.exit(1);
  }
})();
