#!/usr/bin/env tsx
/**
 * Unit Test: Daytona sandbox list — cursor walk + completeness honesty
 *
 * Daytona retired page-numbered pagination (deadline 2026-06-25); since SDK
 * 0.203.0 `Daytona.list()` returns an async iterator that follows nextCursor
 * internally. The LAW under test is unchanged by the mechanics: a fleet sweep
 * reads a sandbox's ABSENCE from the list as evidence it is gone, so a
 * truncated enumeration must never be reported as a whole one — and the
 * completeness verdict must be EVIDENCE, never a default.
 *
 * What is asserted here is the walk itself, with no network in it:
 *   1. the stream is drained to exhaustion, not sampled
 *   2. the client-side state filter runs BEFORE the limit is counted, so
 *      "ten running" means ten running
 *   3. a limit that provably hides rows reports INCOMPLETE; a limit landing
 *      exactly on the end of the fleet reports COMPLETE
 *   4. a stream failure mid-walk reports INCOMPLETE, keeping what it saw —
 *      including the honesty red case: a stream that DIES after a plausible
 *      prefix must never come back `complete: true`
 *   5. the scan ceiling is a refusal, never a short "complete" answer
 *
 * Usage:
 *   npx tsx tests/unit/daytona-list-pagination.test.ts
 */

import {
  DAYTONA_MAX_LIST_SCAN,
  DAYTONA_LIST_PAGE_SIZE,
  _testCollectSandboxStream,
} from "../../src/index.ts";

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

/** A sandbox shaped enough for toSandboxInfo and the state filter. */
function box(id: string, state = "started") {
  return {
    id,
    state,
    snapshot: "snap",
    labels: {},
    createdAt: "2026-07-28T12:00:00.000Z",
  };
}

type Row = ReturnType<typeof box>;

/**
 * A cursor-stream double: yields rows one by one the way the SDK's iterator
 * does, records how many were PULLED (each pull is the walk asking for more —
 * the observable unit under cursors, where page boundaries are the vendor's
 * private business), and can die mid-stream like a fetch failing on a cursor.
 */
function streamOf(
  rows: Row[],
  options?: { throwAfter?: number; error?: string },
): { stream: AsyncIterable<Row>; pulled: () => number } {
  let pulled = 0;
  async function* generate() {
    for (const row of rows) {
      if (options?.throwAfter !== undefined && pulled >= options.throwAfter) {
        throw new Error(options.error ?? "stream failed");
      }
      pulled += 1;
      yield row;
    }
    if (options?.throwAfter !== undefined && pulled >= options.throwAfter) {
      throw new Error(options.error ?? "stream failed");
    }
  }
  return { stream: generate(), pulled: () => pulled };
}

const rows = (n: number, prefix: string, state = "started") =>
  Array.from({ length: n }, (_, i) => box(`${prefix}-${i}`, state));

// =============================================================================
// TESTS
// =============================================================================

async function testDrainsWholeStream(): Promise<void> {
  console.log("\n[1] The stream is drained to exhaustion");

  const { stream, pulled } = streamOf([...rows(100, "a"), ...rows(100, "b"), ...rows(5, "c")]);
  const page = await _testCollectSandboxStream(stream);

  assert(page.sandboxes.length === 205, "returns every sandbox in the stream, not a sample");
  assert(page.complete === true, "an exhausted walk is COMPLETE");
  assert(page.pagesFetched === 205, "reports the rows it consumed");
  assert(pulled() === 205, "and consumed exactly the fleet, nothing invented");
}

async function testStateFilterBeforeLimit(): Promise<void> {
  console.log("\n[2] The client-side state filter runs BEFORE the limit is counted");

  // The first stretch is all archived; the running boxes come later. Asking
  // for two running sandboxes has to keep walking rather than returning
  // nothing.
  const { stream } = streamOf([...rows(3, "old", "archived"), ...rows(3, "live", "started")]);
  const page = await _testCollectSandboxStream(stream, { state: ["running"], limit: 2 });

  assert(page.sandboxes.length === 2, "returns two RUNNING sandboxes, not two rows minus misses");
  assert(
    page.sandboxes.every((s) => s.sandboxId.startsWith("live-")),
    "and none of the archived ones",
  );
  // A third running sandbox sits behind the limit, so this is a truncated
  // answer — the state filter changes WHICH sandboxes count toward the bound,
  // not whether stopping at it hides any.
  assert(page.complete === false, "and reports INCOMPLETE, because a third running box exists");
}

async function testStateFilterExcludesArchived(): Promise<void> {
  console.log("\n[3] Archived boxes are excluded from a running-only list");

  // The measured case this filter exists for: a live Daytona account answered
  // an unfiltered list with 19 months-old archived boxes and a running-only
  // list with zero.
  const { stream } = streamOf(rows(19, "archived", "archived"));
  const page = await _testCollectSandboxStream(stream, { state: ["running"] });

  assert(page.sandboxes.length === 0, "none of the 19 archived boxes are returned");
  assert(page.complete === true, "and the answer is COMPLETE — genuinely zero running");
}

async function testNativePausedStateCounts(): Promise<void> {
  console.log("\n[3b] Daytona's native 'paused' state matches our 'paused' filter");

  const { stream } = streamOf([box("p-1", "paused"), box("s-1", "stopped"), box("r-1", "started")]);
  const page = await _testCollectSandboxStream(stream, { state: ["paused"] });

  assert(
    page.sandboxes.map((s) => s.sandboxId).join(",") === "p-1,s-1",
    "paused and stopped both count as paused; the running box does not",
  );
}

async function testLimitStopsEarly(): Promise<void> {
  console.log("\n[4] An explicit limit bounds ITEMS — and a limit that hides sandboxes is INCOMPLETE");

  const { stream, pulled } = streamOf(rows(300, "a"));
  const page = await _testCollectSandboxStream(stream, { limit: 150 });

  assert(page.sandboxes.length === 150, "returns exactly the limit");
  assert(pulled() === 151, "stops one row past the limit — that row IS the truncation evidence");
  // THE ORIGINAL FINDING: this used to report complete:true, so the sweep —
  // which always passed a limit — could never learn it had been truncated.
  assert(page.complete === false, "INCOMPLETE, because a 151st sandbox provably exists");
  assert((page.error ?? "").includes("limit"), "and the reason names the limit");
}

async function testLimitExactlyAtFleetEnd(): Promise<void> {
  console.log("\n[4b] A limit that lands exactly on the end of the fleet IS complete");

  const { stream } = streamOf(rows(5, "a"));
  const page = await _testCollectSandboxStream(stream, { limit: 5 });

  assert(page.sandboxes.length === 5, "returns all five");
  assert(page.complete === true, "complete — nothing was hidden");
}

async function testLimitZero(): Promise<void> {
  console.log("\n[4c] limit: 0 returns nothing, not one");

  const { stream } = streamOf(rows(3, "a"));
  const page = await _testCollectSandboxStream(stream, { limit: 0 });

  assert(page.sandboxes.length === 0, "returns zero sandboxes");
  assert(page.complete === false, "and says so — three were hidden by the bound");
}

async function testDedupesRepeatedIds(): Promise<void> {
  console.log("\n[4d] A repeated id is dropped, whatever the vendor promised");

  // No-duplicates-under-mutation is cursor pagination's own selling point, but
  // it is the VENDOR's promise: an enumeration that reported the same sandbox
  // twice would make every count downstream wrong, so the walk keeps its own
  // guard.
  const { stream } = streamOf([box("a"), box("b"), box("b"), box("c")]);
  const result = await _testCollectSandboxStream(stream);

  assert(result.sandboxes.length === 3, "three distinct sandboxes, not four");
  assert(
    result.sandboxes.map((s) => s.sandboxId).join(",") === "a,b,c",
    "and the duplicate is dropped, keeping first-seen order",
  );
}

async function testFailureMidWalk(): Promise<void> {
  console.log("\n[5] A failure mid-walk is INCOMPLETE, never a short complete list");

  // THE HONESTY RED CASE. A cursor stream that dies after 100 rows has
  // produced a perfectly plausible-looking fleet — nothing about those rows
  // says "there were more". If the walk's completeness verdict were a default
  // rather than evidence (complete unless someone remembered to flip it), this
  // is exactly the case that would ship a truncated list as a whole one and
  // let a sweep kill every sandbox the enumeration never reached. So this
  // test is the tripwire: it goes RED the moment completeness stops being
  // earned by the stream actually ENDING.
  const { stream } = streamOf(rows(200, "a"), {
    throwAfter: 100,
    error: "503 service unavailable",
  });
  const page = await _testCollectSandboxStream(stream);

  assert(page.complete === false, "the walk admits it did not finish — NEVER complete on a died stream");
  assert(page.sandboxes.length === 100, "and keeps what it did see");
  assert(page.pagesFetched === 100, "counting only the rows that landed");
  assert((page.error ?? "").includes("503"), "carrying the provider's own reason");
}

async function testImmediateFailure(): Promise<void> {
  console.log("\n[6] A failure before the first row is not an empty fleet");

  const { stream } = streamOf(rows(50, "a"), { throwAfter: 0, error: "connection reset" });
  const page = await _testCollectSandboxStream(stream);

  assert(page.sandboxes.length === 0, "no sandboxes are reported");
  assert(
    page.complete === false,
    "but complete is FALSE — this is the case that would mass-kill a live fleet if it read as empty",
  );
  assert((page.error ?? "").includes("connection reset"), "with the transport's own reason");
}

async function testScanCeiling(): Promise<void> {
  console.log("\n[7] The scan ceiling is a refusal, not a short answer");

  // A stream that always has one more row — a runaway server, or a cursor
  // loop upstream — must be refused, not returned as a plausible fleet.
  let served = 0;
  async function* endless() {
    for (;;) {
      served += 1;
      yield box(`sb-${served}`);
    }
  }
  const result = await _testCollectSandboxStream(endless());

  assert(
    result.pagesFetched === DAYTONA_MAX_LIST_SCAN,
    `stops at ${DAYTONA_MAX_LIST_SCAN} rows scanned`,
  );
  assert(served <= DAYTONA_MAX_LIST_SCAN + 1, "and stops PULLING, rather than draining forever");
  assert(result.complete === false, "and says so, rather than returning a plausible-looking list");
  assert((result.error ?? "").includes("exceeded"), "with a reason a log can be read for");
}

async function testEmptyFleet(): Promise<void> {
  console.log("\n[8] A genuinely empty organization is COMPLETE and empty");

  const { stream } = streamOf([]);
  const result = await _testCollectSandboxStream(stream);

  assert(result.sandboxes.length === 0, "no sandboxes");
  assert(result.complete === true, "and complete — the answer a sweep may act on");
}

function testPageSizeConstant(): void {
  console.log("\n[9] Per-fetch size stays inside what every provider in the lineup accepts");

  assert(DAYTONA_LIST_PAGE_SIZE <= 100, "never above 100");
  assert(
    DAYTONA_MAX_LIST_SCAN === 10_000,
    "and the scan ceiling still covers the same 10,000-sandbox fleet the page ceiling did",
  );
}

// =============================================================================
// RUNNER
// =============================================================================

const tests = [
  testDrainsWholeStream,
  testStateFilterBeforeLimit,
  testStateFilterExcludesArchived,
  testNativePausedStateCounts,
  testLimitStopsEarly,
  testLimitExactlyAtFleetEnd,
  testLimitZero,
  testDedupesRepeatedIds,
  testFailureMidWalk,
  testImmediateFailure,
  testScanCeiling,
  testEmptyFleet,
  testPageSizeConstant,
];

(async () => {
  console.log("=== Daytona Provider: cursor list + completeness Tests ===");
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
