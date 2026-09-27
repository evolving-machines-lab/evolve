#!/usr/bin/env tsx
/**
 * Unit Test: a managed sandbox create survives the door's 429/503 on the ONE request that creates the box
 *
 * The door can refuse that request with a 429/503 and Retry-After before any box exists; the request
 * is sent again after the server's delay, bounded, then the refusal it still gets is thrown. A 401 is
 * never retried, and a refusal on any call after the box exists never makes a second box. The pacing
 * is the hosted client's one law; the reader's vendor shapes are pinned by the real clients in the
 * e2b and daytona packages, and driven end to end here over a local door.
 *
 * Usage:
 *   npx tsx tests/unit/managed-create-retry.test.ts
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  MANAGED_CREATE_RETRY,
  readManagedCreateRefusal,
  resolveManagedSandbox,
} from "../../src/utils/sandbox";
import { ManagedModalDoorError, ManagedModalProvider } from "../../src/utils/managed-modal";
import { retryAfterSecFromHeader, retryTransient } from "../../src/hosted/retry-after";

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

/** Timers may land a hair early against a wall clock; two milliseconds of grace keep the law provable. */
const CLOCK_GRACE_MS = 2;

interface RecordedRequest {
  url: string;
  method: string;
  body?: BodyInit | null;
}

/** Route fetch to a scripted door, one Response per call, recording every request. */
function withMockDoor(
  responses: Array<() => Response>,
): { requests: RecordedRequest[]; restore: () => void } {
  const requests: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
    const next = responses[Math.min(requests.length - 1, responses.length - 1)];
    return next();
  }) as typeof fetch;
  return { requests, restore: () => (globalThis.fetch = original) };
}

const SERVER_TEXT = "credential check unavailable; try again";

function refusal(status: number, retryAfterSec?: number): Response {
  return new Response(JSON.stringify({ error: SERVER_TEXT }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(retryAfterSec !== undefined ? { "retry-after": String(retryAfterSec) } : {}),
    },
  });
}

function created(): Response {
  return new Response(JSON.stringify({ sandboxId: "modal-sb-1", image: "evolve-all" }), {
    status: 201,
    headers: { "content-type": "application/json" },
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

/** Waits of a few ms so the pacing law is measured, never waited out. */
const FAST = { attempts: 3, baseDelayMs: 10, maxDelayMs: 1_000 };

/** The Modal transport with the real reader and law on its create request, paced fast. */
function fastModal(): ManagedModalProvider {
  return new ManagedModalProvider({
    apiKey: "sk-evolve-key",
    baseUrl: "https://dashboard.test/api/managed/modal",
    retryCreateRequest: (send) => retryTransient(send, readManagedCreateRefusal, FAST),
  });
}

/** Daytona 0.203's translated server error: `statusCode` and the response `headers` ride on it. */
function daytonaShaped(statusCode: number, headers?: Record<string, string>): Error {
  return Object.assign(new Error(SERVER_TEXT), { name: "DaytonaServiceUnavailableError", statusCode, headers });
}

/** e2b 2.39's API error: a 429 is a RateLimitError, a 401 an AuthenticationError, the rest a SandboxError "<status>: …". */
function e2bShaped(status: number): Error {
  if (status === 429) return Object.assign(new Error("Rate limit exceeded, please try again later - [object Object]"), { name: "RateLimitError" });
  if (status === 401) return Object.assign(new Error("Unauthorized, please check your credentials. - [object Object]"), { name: "AuthenticationError" });
  return Object.assign(new Error(`${status}: [object Object]`), { name: "SandboxError" });
}

// =============================================================================
// [1] The law — retryTransient paces by Retry-After, floored, capped, bounded
// =============================================================================

async function testLawHonorsRetryAfter(): Promise<void> {
  console.log("\n[1a] retryTransient - waits the server's Retry-After when it exceeds the backoff");
  let tries = 0;
  const startedAt = performance.now();
  const result = await retryTransient(
    async () => {
      tries++;
      if (tries === 1) throw new Error("refused");
      return "ok";
    },
    () => ({ retryAfterSec: 0.08 }),
    { attempts: 2, baseDelayMs: 1, maxDelayMs: 1_000 },
  );
  const elapsedMs = performance.now() - startedAt;
  assertEqual(result, "ok", "resolves with the second try's value");
  assertEqual(tries, 2, "one refusal, one retry");
  assert(elapsedMs >= 80 - CLOCK_GRACE_MS, `slept the 80ms Retry-After, not the 1ms backoff (waited ${elapsedMs.toFixed(1)}ms)`);
}

async function testLawFloorsAtBackoff(): Promise<void> {
  console.log("\n[1b] retryTransient - no Retry-After: the backoff paces, doubling");
  let tries = 0;
  const startedAt = performance.now();
  await retryTransient(
    async () => {
      tries++;
      if (tries < 3) throw new Error("refused");
      return "ok";
    },
    () => ({}),
    { attempts: 3, baseDelayMs: 20, maxDelayMs: 1_000 },
  );
  const elapsedMs = performance.now() - startedAt;
  assertEqual(tries, 3, "two refusals, two retries");
  assert(elapsedMs >= 60 - CLOCK_GRACE_MS, `slept 20ms then 40ms (waited ${elapsedMs.toFixed(1)}ms)`);
}

async function testLawCapsTheWait(): Promise<void> {
  console.log("\n[1c] retryTransient - a Retry-After past the cap waits only the cap");
  let tries = 0;
  const startedAt = performance.now();
  await retryTransient(
    async () => {
      tries++;
      if (tries === 1) throw new Error("refused");
      return "ok";
    },
    () => ({ retryAfterSec: 5 }),
    { attempts: 2, baseDelayMs: 1, maxDelayMs: 30 },
  );
  const elapsedMs = performance.now() - startedAt;
  assert(
    elapsedMs >= 30 - CLOCK_GRACE_MS && elapsedMs < 1_000,
    `waited the 30ms cap, not the 5s asked (waited ${elapsedMs.toFixed(1)}ms)`
  );
}

async function testLawIsBounded(): Promise<void> {
  console.log("\n[1d] retryTransient - the tries are spent: the LAST refusal is thrown as is");
  const errors: Error[] = [];
  const thrown = await rejection(
    retryTransient(
      async () => {
        const err = new Error(`refused #${errors.length + 1}`);
        errors.push(err);
        throw err;
      },
      () => ({}),
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
    ),
  );
  assertEqual(errors.length, 3, "exactly three tries");
  assert(thrown === errors[2], "the third refusal is the one thrown, the same instance");
}

async function testLawThrowsUnrecognizedAtOnce(): Promise<void> {
  console.log("\n[1e] retryTransient - an error the reader does not recognize is thrown at once");
  let tries = 0;
  const refused = new Error("not transient");
  const thrown = await rejection(
    retryTransient(
      async () => {
        tries++;
        throw refused;
      },
      () => undefined,
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
    ),
  );
  assertEqual(tries, 1, "one try, no wait");
  assert(thrown === refused, "the same instance surfaces");
}

function testHeaderReading(): void {
  console.log("\n[1f] retryAfterSecFromHeader - the header half of the one reading");
  assertEqual(retryAfterSecFromHeader("2"), 2, "seconds parse");
  assertEqual(retryAfterSecFromHeader("0.5"), 0.5, "fractional seconds parse");
  assertEqual(retryAfterSecFromHeader(undefined), undefined, "absent is no reading, never zero");
  assertEqual(retryAfterSecFromHeader(""), undefined, "empty is absent");
  assertEqual(retryAfterSecFromHeader("Wed, 21 Oct 2026 07:28:00 GMT"), undefined, "the HTTP-date form is unreadable");
  assertEqual(retryAfterSecFromHeader(3), undefined, "a non-string is not a header value");
}

// =============================================================================
// [2] The reader — which client errors are a door's 429/503
// =============================================================================

function testReaderModalDoor(): void {
  console.log("\n[2a] readManagedCreateRefusal - the Modal door's typed refusal");
  assertEqual(
    readManagedCreateRefusal(new ManagedModalDoorError("create", 503, SERVER_TEXT, 7)),
    { retryAfterSec: 7 },
    "a 503 with its delay"
  );
  assertEqual(
    readManagedCreateRefusal(new ManagedModalDoorError("create", 429, SERVER_TEXT)),
    {},
    "a 429 without a delay is still a refusal to retry"
  );
  assertEqual(readManagedCreateRefusal(new ManagedModalDoorError("create", 401, "bad key")), undefined, "401 is final");
  assertEqual(readManagedCreateRefusal(new ManagedModalDoorError("create", 500, "boom")), undefined, "500 is final");
}

function testReaderDaytona(): void {
  console.log("\n[2b] readManagedCreateRefusal - Daytona's statusCode and response headers");
  assertEqual(
    readManagedCreateRefusal(daytonaShaped(503, { "retry-after": "2" })),
    { retryAfterSec: 2 },
    "a 503 reads Retry-After off the plain headers record"
  );
  const axiosHeaders = { get: (name: string) => (name === "retry-after" ? "3" : undefined) };
  assertEqual(
    readManagedCreateRefusal(Object.assign(new Error(SERVER_TEXT), { statusCode: 429, headers: axiosHeaders })),
    { retryAfterSec: 3 },
    "a 429 reads Retry-After through an AxiosHeaders-style get()"
  );
  assertEqual(readManagedCreateRefusal(daytonaShaped(503)), {}, "a 503 without headers is a refusal with no delay");
  assertEqual(readManagedCreateRefusal(daytonaShaped(401)), undefined, "401 is final");
  assertEqual(readManagedCreateRefusal(daytonaShaped(500)), undefined, "500 is final");
}

function testReaderE2B(): void {
  console.log("\n[2c] readManagedCreateRefusal - e2b's class name and message prefix");
  assertEqual(readManagedCreateRefusal(e2bShaped(429)), {}, "RateLimitError is a 429");
  assertEqual(readManagedCreateRefusal(e2bShaped(503)), {}, 'SandboxError "503: …" is a 503');
  assertEqual(readManagedCreateRefusal(e2bShaped(502)), undefined, 'SandboxError "502: …" is final');
  assertEqual(readManagedCreateRefusal(e2bShaped(401)), undefined, "AuthenticationError is final");
}

function testReaderRejectsTheRest(): void {
  console.log("\n[2d] readManagedCreateRefusal - anything else is final");
  assertEqual(readManagedCreateRefusal(new TypeError("fetch failed")), undefined, "a network failure is not a refusal");
  assertEqual(readManagedCreateRefusal("503"), undefined, "a thrown string is not a refusal");
  assertEqual(readManagedCreateRefusal(undefined), undefined, "nothing is not a refusal");
}

// =============================================================================
// [3] The Modal door — the wiring through resolveManagedSandbox, and the seam
// =============================================================================

function testDefaultPolicyPins(): void {
  console.log("\n[3a] MANAGED_CREATE_RETRY - three tries paced 1 s doubling, capped at 30 s");
  assertEqual(MANAGED_CREATE_RETRY, { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 }, "the pinned policy");
}

async function testManagedCreateSurvivesOneRefusal(): Promise<void> {
  console.log("\n[3b] a 503 with Retry-After once, then 201: the create resolves");
  const { requests, restore } = withMockDoor([() => refusal(503, 0.05), created]);
  try {
    const provider = await resolveManagedSandbox("sk-evolve-key", "modal", { timeoutMs: 60_000 });
    const startedAt = performance.now();
    const sandbox = await provider.create({ image: "evolve-all" });
    const elapsedMs = performance.now() - startedAt;

    assertEqual(sandbox.sandboxId, "modal-sb-1", "the create resolves with the box the retry got");
    assertEqual(requests.length, 2, "the refused create request was sent again, once");
    assert(
      requests.every((r) => r.method === "POST" && r.url.endsWith("/sandboxes")),
      "both attempts are the same create request"
    );
    assertEqual(requests[0].body, requests[1].body, "the retry re-sends the same body, defaults folded in");
    assert(
      elapsedMs >= 1_000 - CLOCK_GRACE_MS,
      `the wait is at least the create's base delay of 1 s (waited ${elapsedMs.toFixed(1)}ms)`
    );
  } finally {
    restore();
  }
}

async function testManagedCreateGivesUpAfterThree(): Promise<void> {
  console.log("\n[3c] three 503s: the typed refusal surfaces with the server's text");
  const { requests, restore } = withMockDoor([() => refusal(503, 0.01)]);
  try {
    const err = await rejection(fastModal().create({ image: "evolve-all" }));

    assertEqual(requests.length, 3, "three tries, no more");
    assert(err instanceof ManagedModalDoorError, "the door's typed error is what surfaces");
    assertEqual((err as ManagedModalDoorError).status, 503, "with the door's status");
    assertEqual((err as ManagedModalDoorError).retryAfterSec, 0.01, "and the delay it asked for");
    assert((err as Error).message.includes(SERVER_TEXT), "and the server's sentence");
  } finally {
    restore();
  }
}

async function testManagedCreateNeverRetriesUnauthorized(): Promise<void> {
  console.log("\n[3d] a 401 is thrown at once, never retried");
  const { requests, restore } = withMockDoor([() => refusal(401)]);
  try {
    const provider = await resolveManagedSandbox("sk-evolve-key", "modal");
    const err = (await rejection(provider.create({ image: "evolve-all" }))) as Error | undefined;

    assert(err instanceof ManagedModalDoorError, "the create rejects with the door's typed error");
    assertEqual(requests.length, 1, "exactly one request: a refused key is not a wait");
    assert(
      (err?.message ?? "").includes("(401)") && (err?.message ?? "").includes(SERVER_TEXT),
      "the door's status and sentence survive into the error"
    );
  } finally {
    restore();
  }
}

async function testManagedCreateRetriesOnlyCreate(): Promise<void> {
  console.log("\n[3e] the seam wraps the create request alone: a 503 on connect surfaces at once");
  const { requests, restore } = withMockDoor([() => refusal(503, 0.01)]);
  try {
    const err = await rejection(fastModal().connect("modal-sb-1"));
    assertEqual(requests.length, 1, "one request: connect is not a create");
    assert(err instanceof ManagedModalDoorError && err.status === 503, "the refusal surfaces unchanged");
  } finally {
    restore();
  }
}

// =============================================================================
// [4] The other two doors — the REAL vendor clients over a local door, end to end
// =============================================================================

interface DoorRequest {
  method: string;
  url: string;
}

interface DoorAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A local HTTP door the real vendor clients talk to; every request is recorded, `answer` scripts each reply. */
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
  // The Daytona client also tries a websocket upgrade; refusing it keeps the door a plain HTTP server.
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

const DAYTONA_BOX = {
  id: "dtn-1",
  state: "started",
  toolboxProxyUrl: "https://runner.test",
  labels: {},
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
};

const E2B_BOX = {
  sandboxID: "sbx-1",
  templateID: "evolve-all",
  envdVersion: "0.2.0",
  envdAccessToken: "envd-token",
  clientID: "c1",
  startedAt: "2026-09-26T00:00:00.000Z",
  endAt: "2026-09-26T01:00:00.000Z",
};

const isDaytonaCreate = (r: DoorRequest) => r.method === "POST" && r.url.endsWith("/sandbox");
const isE2BCreate = (r: DoorRequest) => r.method === "POST" && r.url.endsWith("/sandboxes");

async function testDaytonaCreateRequestIsRetried(): Promise<void> {
  console.log("\n[4a] Daytona: the create request refused once with Retry-After, then answered — one box");
  let creates = 0;
  const door = await localDoor((req) => {
    if (!isDaytonaCreate(req)) return { status: 200, body: {} };
    return ++creates === 1
      ? { status: 503, body: { error: SERVER_TEXT }, headers: { "retry-after": "0.05" } }
      : { status: 200, body: DAYTONA_BOX };
  });
  try {
    const sandbox = await withEnv({ EVOLVE_DASHBOARD_URL: door.url }, async () => {
      const provider = await resolveManagedSandbox("sk-evolve-key", "daytona");
      return provider.create({ image: "evolve-all" });
    });
    assertEqual(sandbox.sandboxId, "dtn-1", "the create resolves with the box the retry got");
    assertEqual(door.requests.filter(isDaytonaCreate).length, 2, "the refused create request was sent again, once");
  } finally {
    await door.close();
  }
}

async function testDaytonaRefusalAfterTheBoxNeverRecreates(): Promise<void> {
  console.log("\n[4b] Daytona: a 503 after the box exists (the toolbox call) never issues a second create");
  const door = await localDoor((req) =>
    isDaytonaCreate(req)
      ? { status: 200, body: DAYTONA_BOX }
      : { status: 503, body: { error: SERVER_TEXT }, headers: { "retry-after": "0.05" } },
  );
  try {
    const err = await withEnv({ EVOLVE_DASHBOARD_URL: door.url }, async () => {
      const provider = await resolveManagedSandbox("sk-evolve-key", "daytona");
      return rejection(provider.create({ image: "evolve-all", workingDirectory: "/work" }));
    });
    assert(err instanceof Error, "the create rejects");
    assertEqual((err as { statusCode?: unknown })?.statusCode, 503, "with the refusal the toolbox call got");
    assertEqual(door.requests.filter(isDaytonaCreate).length, 1, "exactly ONE create request: the box is never made twice");
  } finally {
    await door.close();
  }
}

async function testE2BCreateRequestIsRetried(): Promise<void> {
  console.log("\n[4c] e2b: the create request refused once, then answered — one box");
  let creates = 0;
  const door = await localDoor((req) => {
    if (!isE2BCreate(req)) return { status: 200, body: {} };
    return ++creates === 1
      ? { status: 503, body: { error: SERVER_TEXT }, headers: { "retry-after": "0.05" } }
      : { status: 201, body: E2B_BOX };
  });
  try {
    const sandbox = await withEnv({ EVOLVE_DASHBOARD_URL: door.url, E2B_SANDBOX_URL: door.url }, async () => {
      const provider = await resolveManagedSandbox("sk-evolve-key", "e2b");
      return provider.create({ image: "evolve-all" });
    });
    assertEqual(sandbox.sandboxId, "sbx-1", "the create resolves with the box the retry got");
    assertEqual(door.requests.filter(isE2BCreate).length, 2, "the refused create request was sent again, once");
  } finally {
    await door.close();
  }
}

async function testE2BRefusalAfterTheBoxNeverRecreates(): Promise<void> {
  console.log("\n[4d] e2b: a 503 after the box exists (the envd makeDir) never issues a second create");
  const door = await localDoor((req) =>
    isE2BCreate(req)
      ? { status: 201, body: E2B_BOX }
      : { status: 503, body: { error: SERVER_TEXT }, headers: { "retry-after": "0.05" } },
  );
  try {
    const err = await withEnv({ EVOLVE_DASHBOARD_URL: door.url, E2B_SANDBOX_URL: door.url }, async () => {
      const provider = await resolveManagedSandbox("sk-evolve-key", "e2b");
      return rejection(provider.create({ image: "evolve-all", workingDirectory: "/work" }));
    });
    assert(err instanceof Error, `the create rejects (${(err as Error)?.name})`);
    assertEqual(door.requests.filter(isE2BCreate).length, 1, "exactly ONE create request: the box is never made twice");
  } finally {
    await door.close();
  }
}

// =============================================================================
// RUN
// =============================================================================

const tests = [
  testLawHonorsRetryAfter,
  testLawFloorsAtBackoff,
  testLawCapsTheWait,
  testLawIsBounded,
  testLawThrowsUnrecognizedAtOnce,
  testHeaderReading,
  testReaderModalDoor,
  testReaderDaytona,
  testReaderE2B,
  testReaderRejectsTheRest,
  testDefaultPolicyPins,
  testManagedCreateSurvivesOneRefusal,
  testManagedCreateGivesUpAfterThree,
  testManagedCreateNeverRetriesUnauthorized,
  testManagedCreateRetriesOnlyCreate,
  testDaytonaCreateRequestIsRetried,
  testDaytonaRefusalAfterTheBoxNeverRecreates,
  testE2BCreateRequestIsRetried,
  testE2BRefusalAfterTheBoxNeverRecreates,
];

(async () => {
  console.log("=== Managed Create Retry Tests ===");
  try {
    for (const test of tests) {
      await test();
    }
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    // Explicit exit: the real Daytona client keeps a socket.io reconnect alive after the door closes.
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Unexpected error:", err);
    process.exit(1);
  }
})();
