#!/usr/bin/env tsx
/**
 * Unit Test: a managed sandbox create survives the door's 429/503
 *
 * The door can refuse a create with a 429/503 and Retry-After before any box
 * exists; the create waits the server's delay and tries again, bounded, then
 * throws the refusal it still gets. A 401 is never retried. The pacing is the
 * hosted client's one law; the vendor error shapes the reader depends on are
 * pinned here against @daytonaio/sdk 0.203 and e2b 2.39.
 *
 * Usage:
 *   npx tsx tests/unit/managed-create-retry.test.ts
 */

import {
  MANAGED_CREATE_RETRY,
  readManagedCreateRefusal,
  resolveManagedSandbox,
  withTransientCreateRetry,
} from "../../src/utils/sandbox";
import { ManagedModalDoorError, ManagedModalProvider } from "../../src/utils/managed-modal";
import { retryAfterSecFromHeader, retryTransient } from "../../src/hosted/retry-after";
import type { SandboxCreateOptions, SandboxInstance, SandboxProvider } from "../../src/types";

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

/** The Modal transport over the scripted door, paced fast. */
function fastModal(): SandboxProvider {
  return withTransientCreateRetry(
    new ManagedModalProvider({ apiKey: "sk-evolve-key", baseUrl: "https://dashboard.test/api/managed/modal" }),
    FAST,
  );
}

/** A provider whose create throws the scripted errors in order, then resolves. */
function scriptedProvider(errors: unknown[]): { provider: SandboxProvider; calls: () => number } {
  let calls = 0;
  const provider = {
    providerType: "daytona",
    name: "scripted",
    async create(_options: SandboxCreateOptions): Promise<SandboxInstance> {
      const err = errors[calls++];
      if (err !== undefined) throw err;
      return { sandboxId: "box-1" } as unknown as SandboxInstance;
    },
  } as unknown as SandboxProvider;
  return { provider, calls: () => calls };
}

/** Daytona 0.203's translated server error: `statusCode` and the response `headers` ride on it. */
function daytonaShaped(statusCode: number, headers?: Record<string, string>): Error {
  return Object.assign(new Error(SERVER_TEXT), { name: "DaytonaServiceUnavailableError", statusCode, headers });
}

/** e2b 2.39's `handleApiError`: a 429 is a RateLimitError, every other status a SandboxError "<status>: <message>". */
function e2bShaped(status: number): Error {
  if (status === 429) return Object.assign(new Error(`Rate limit exceeded, please try again later - ${SERVER_TEXT}`), { name: "RateLimitError" });
  if (status === 401) return Object.assign(new Error(`Unauthorized, please check your credentials. - ${SERVER_TEXT}`), { name: "AuthenticationError" });
  return Object.assign(new Error(`${status}: ${SERVER_TEXT}`), { name: "SandboxError" });
}

// =============================================================================
// [1] The law — retryTransient paces by Retry-After, floored, capped, bounded
// =============================================================================

async function testLawHonorsRetryAfter(): Promise<void> {
  console.log("\n[1a] retryTransient - waits the server's Retry-After when it exceeds the backoff");
  let tries = 0;
  const startedAt = Date.now();
  const result = await retryTransient(
    async () => {
      tries++;
      if (tries === 1) throw new Error("refused");
      return "ok";
    },
    () => ({ retryAfterSec: 0.08 }),
    { attempts: 2, baseDelayMs: 1, maxDelayMs: 1_000 },
  );
  const elapsedMs = Date.now() - startedAt;
  assertEqual(result, "ok", "resolves with the second try's value");
  assertEqual(tries, 2, "one refusal, one retry");
  assert(elapsedMs >= 80, `slept the 80ms Retry-After, not the 1ms backoff (waited ${elapsedMs}ms)`);
}

async function testLawFloorsAtBackoff(): Promise<void> {
  console.log("\n[1b] retryTransient - no Retry-After: the backoff paces, doubling");
  let tries = 0;
  const startedAt = Date.now();
  await retryTransient(
    async () => {
      tries++;
      if (tries < 3) throw new Error("refused");
      return "ok";
    },
    () => ({}),
    { attempts: 3, baseDelayMs: 20, maxDelayMs: 1_000 },
  );
  const elapsedMs = Date.now() - startedAt;
  assertEqual(tries, 3, "two refusals, two retries");
  assert(elapsedMs >= 60, `slept 20ms then 40ms (waited ${elapsedMs}ms)`);
}

async function testLawCapsTheWait(): Promise<void> {
  console.log("\n[1c] retryTransient - a Retry-After past the cap waits only the cap");
  let tries = 0;
  const startedAt = Date.now();
  await retryTransient(
    async () => {
      tries++;
      if (tries === 1) throw new Error("refused");
      return "ok";
    },
    () => ({ retryAfterSec: 5 }),
    { attempts: 2, baseDelayMs: 1, maxDelayMs: 30 },
  );
  const elapsedMs = Date.now() - startedAt;
  assert(elapsedMs >= 30 && elapsedMs < 1_000, `waited the 30ms cap, not the 5s asked (waited ${elapsedMs}ms)`);
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
// [3] The wiring — resolveManagedSandbox("modal") over a scripted door
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
    const startedAt = Date.now();
    const sandbox = await provider.create({ image: "evolve-all" });
    const elapsedMs = Date.now() - startedAt;

    assertEqual(sandbox.sandboxId, "modal-sb-1", "the create resolves with the box the retry got");
    assertEqual(requests.length, 2, "the refused create was sent again, once");
    assert(
      requests.every((r) => r.method === "POST" && r.url.endsWith("/sandboxes")),
      "both attempts are the same create request"
    );
    assertEqual(requests[0].body, requests[1].body, "the retry re-sends the same body, defaults folded in");
    assert(
      elapsedMs >= 1_000,
      `the wait is at least the create's base delay of 1 s (waited ${elapsedMs}ms)`
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
  console.log("\n[3e] the retry wraps create alone: a 503 on connect surfaces at once");
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
// [4] The other two doors — vendor-shaped refusals through the same wrapper
// =============================================================================

async function testDaytonaShapedRefusalIsRetriedWithItsDelay(): Promise<void> {
  console.log("\n[4a] a Daytona-shaped 503 with Retry-After is retried after that delay");
  const { provider, calls } = scriptedProvider([daytonaShaped(503, { "retry-after": "0.05" })]);
  const startedAt = Date.now();
  const sandbox = await withTransientCreateRetry(provider, { ...FAST, baseDelayMs: 1 }).create({});
  const elapsedMs = Date.now() - startedAt;
  assertEqual(sandbox.sandboxId, "box-1", "the create resolves");
  assertEqual(calls(), 2, "one refusal, one retry");
  assert(elapsedMs >= 50, `slept the 50ms Retry-After off the headers (waited ${elapsedMs}ms)`);
}

async function testDaytonaShapedUnauthorizedIsFinal(): Promise<void> {
  console.log("\n[4b] a Daytona-shaped 401 is thrown at once");
  const refused = daytonaShaped(401);
  const { provider, calls } = scriptedProvider([refused, refused, refused]);
  const err = await rejection(withTransientCreateRetry(provider, FAST).create({}));
  assertEqual(calls(), 1, "one try");
  assert(err === refused, "the same instance surfaces");
}

async function testE2BShapedRefusalsAreRetried(): Promise<void> {
  console.log("\n[4c] e2b-shaped refusals: RateLimitError and \"503: …\" are retried, then the last one surfaces");
  const okAfterOne = scriptedProvider([e2bShaped(429)]);
  await withTransientCreateRetry(okAfterOne.provider, FAST).create({});
  assertEqual(okAfterOne.calls(), 2, "a RateLimitError is retried");

  const last = e2bShaped(503);
  const spent = scriptedProvider([e2bShaped(503), e2bShaped(503), last]);
  const err = await rejection(withTransientCreateRetry(spent.provider, FAST).create({}));
  assertEqual(spent.calls(), 3, "three 503s spend the tries");
  assert(err === last, "the third SandboxError surfaces, server text in its message");
  assert((err as Error).message === `503: ${SERVER_TEXT}`, "e2b's own message shape is untouched");
}

async function testE2BShapedUnauthorizedIsFinal(): Promise<void> {
  console.log("\n[4d] an e2b-shaped AuthenticationError is thrown at once");
  const refused = e2bShaped(401);
  const { provider, calls } = scriptedProvider([refused]);
  const err = await rejection(withTransientCreateRetry(provider, FAST).create({}));
  assertEqual(calls(), 1, "one try");
  assert(err === refused, "the same instance surfaces");
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
  testDaytonaShapedRefusalIsRetriedWithItsDelay,
  testDaytonaShapedUnauthorizedIsFinal,
  testE2BShapedRefusalsAreRetried,
  testE2BShapedUnauthorizedIsFinal,
];

(async () => {
  console.log("=== Managed Create Retry Tests ===");
  try {
    for (const test of tests) {
      await test();
    }
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error("Unexpected error:", err);
    process.exit(1);
  }
})();
