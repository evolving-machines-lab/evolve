#!/usr/bin/env tsx
/**
 * Unit Test: Daytona sandbox list pagination
 *
 * `list()` used to request page 1 and stop, discarding the server's own
 * totalPages — an organization with more than one page of sandboxes was
 * silently truncated, and nothing in the return value said so. The caller that
 * cares is a fleet sweep, which reads a sandbox's ABSENCE from the list as
 * evidence it is gone, so a truncated page read as a whole fleet is a
 * correctness bug and not a slow query.
 *
 * What is asserted here is the walk itself, with no network in it:
 *   1. every page is drained, not just page 1
 *   2. the client-side state filter runs BEFORE the limit is counted, so
 *      "ten running" means ten running
 *   3. an explicit limit stops early and reports COMPLETE
 *   4. a failure mid-walk reports INCOMPLETE, keeping what it saw
 *   5. neither a missing totalPages nor a wrong one can spin the loop
 *   6. the page ceiling is a refusal, never a short "complete" answer
 *
 * Usage:
 *   npx tsx tests/unit/daytona-list-pagination.test.ts
 */

import {
  DAYTONA_MAX_LIST_PAGES,
  DAYTONA_LIST_PAGE_SIZE,
  _testCollectSandboxPages,
  type DaytonaSandboxPage,
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

type FakePage = { ids: string[]; state?: string; totalPages?: number; throws?: string };

/** A page fetcher double. Records which pages were asked for. */
function pagesOf(pages: FakePage[]): {
  fetch: (page: number) => Promise<DaytonaSandboxPage>;
  requested: number[];
} {
  const requested: number[] = [];
  return {
    requested,
    fetch: async (page: number) => {
      requested.push(page);
      const spec = pages[page - 1];
      if (!spec) return { items: [], totalPages: pages.length } as DaytonaSandboxPage;
      if (spec.throws) throw new Error(spec.throws);
      return {
        items: spec.ids.map((id) => box(id, spec.state)),
        totalPages: spec.totalPages ?? pages.length,
      } as unknown as DaytonaSandboxPage;
    },
  };
}

const ids = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

// =============================================================================
// TESTS
// =============================================================================

async function testDrainsEveryPage(): Promise<void> {
  console.log("\n[1] Multi-page accumulation");

  const { fetch, requested } = pagesOf([
    { ids: ids(100, "a") },
    { ids: ids(100, "b") },
    { ids: ids(5, "c") },
  ]);
  const page = await _testCollectSandboxPages(fetch);

  assert(page.sandboxes.length === 205, "returns every sandbox across three pages, not just page 1");
  assert(page.complete === true, "an exhausted walk is COMPLETE");
  assert(page.pagesFetched === 3, "reports the three requests it made");
  assert(requested.join(",") === "1,2,3", "asks for pages in order, starting at 1");
}

async function testStateFilterBeforeLimit(): Promise<void> {
  console.log("\n[2] The client-side state filter runs BEFORE the limit is counted");

  // Page 1 is all archived; the running boxes are on page 2. Asking for two
  // running sandboxes has to keep paging rather than returning nothing.
  const fetch = async (page: number): Promise<DaytonaSandboxPage> =>
    ({
      items:
        page === 1
          ? ids(3, "old").map((id) => box(id, "archived"))
          : ids(3, "live").map((id) => box(id, "started")),
      totalPages: 2,
    }) as unknown as DaytonaSandboxPage;

  const page = await _testCollectSandboxPages(fetch, { state: ["running"], limit: 2 });

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
  const { fetch } = pagesOf([{ ids: ids(19, "archived"), state: "archived" }]);
  const page = await _testCollectSandboxPages(fetch, { state: ["running"] });

  assert(page.sandboxes.length === 0, "none of the 19 archived boxes are returned");
  assert(page.complete === true, "and the answer is COMPLETE — genuinely zero running");
}

async function testLimitStopsEarly(): Promise<void> {
  console.log("\n[4] An explicit limit bounds ITEMS — and a limit that hides sandboxes is INCOMPLETE");

  const { fetch, requested } = pagesOf([
    { ids: ids(100, "a") },
    { ids: ids(100, "b") },
    { ids: ids(100, "c") },
  ]);
  const page = await _testCollectSandboxPages(fetch, { limit: 150 });

  assert(page.sandboxes.length === 150, "returns exactly the limit");
  assert(requested.length === 2, "and stops requesting pages once it has them");
  // THE FINDING: reported complete:true, so the sweep — which always passed a
  // limit — could never learn it had been truncated.
  assert(page.complete === false, "INCOMPLETE, because a third page provably exists");
  assert((page.error ?? "").includes("limit"), "and the reason names the limit");
}

async function testLimitExactlyAtFleetEnd(): Promise<void> {
  console.log("\n[4b] A limit that lands exactly on the end of the fleet IS complete");

  const { fetch } = pagesOf([{ ids: ids(5, "a") }]);
  const page = await _testCollectSandboxPages(fetch, { limit: 5 });

  assert(page.sandboxes.length === 5, "returns all five");
  assert(page.complete === true, "complete — nothing was hidden");
}

async function testLimitZero(): Promise<void> {
  console.log("\n[4c] limit: 0 returns nothing, not one");

  const { fetch } = pagesOf([{ ids: ids(3, "a") }]);
  const page = await _testCollectSandboxPages(fetch, { limit: 0 });

  assert(page.sandboxes.length === 0, "returns zero sandboxes");
  assert(page.complete === false, "and says so — three were hidden by the bound");
}

async function testDedupesAcrossPages(): Promise<void> {
  console.log("\n[4d] Offset paging over a MUTATING fleet must not repeat a sandbox");

  // A sandbox deleted mid-walk shifts everything after it back one page, so the
  // next page re-serves a row the walk already has. Measured, not theorised.
  const fetch = async (page: number): Promise<DaytonaSandboxPage> =>
    ({
      items: page === 1 ? [box("a"), box("b")] : [box("b"), box("c")],
      totalPages: 2,
    }) as unknown as DaytonaSandboxPage;

  const result = await _testCollectSandboxPages(fetch);

  assert(result.sandboxes.length === 3, "three distinct sandboxes, not four");
  assert(
    result.sandboxes.map((s) => s.sandboxId).join(",") === "a,b,c",
    "and the duplicate is dropped, keeping first-seen order",
  );
}

async function testFailureMidWalk(): Promise<void> {
  console.log("\n[5] A failure mid-walk is INCOMPLETE, never a short complete list");

  const { fetch } = pagesOf([
    { ids: ids(100, "a"), totalPages: 3 },
    { ids: [], throws: "503 service unavailable" },
    { ids: ids(3, "c") },
  ]);
  const page = await _testCollectSandboxPages(fetch);

  assert(page.complete === false, "the walk admits it did not finish");
  assert(page.sandboxes.length === 100, "and keeps what it did see");
  assert(page.pagesFetched === 1, "counting only the pages that landed");
  assert((page.error ?? "").includes("503"), "carrying the provider's own reason");
}

async function testFirstPageFailure(): Promise<void> {
  console.log("\n[6] A failure on the FIRST page is not an empty fleet");

  const { fetch } = pagesOf([{ ids: [], throws: "connection reset" }]);
  const page = await _testCollectSandboxPages(fetch);

  assert(page.sandboxes.length === 0, "no sandboxes are reported");
  assert(
    page.complete === false,
    "but complete is FALSE — this is the case that would mass-kill a live fleet if it read as empty",
  );
}

async function testEmptyPageEndsWalk(): Promise<void> {
  console.log("\n[7] An empty page ends the walk even when totalPages lies");

  // A server that reports totalPages: 999 but runs out of items must not be
  // able to keep us asking for 999 pages.
  let calls = 0;
  const fetch = async (page: number): Promise<DaytonaSandboxPage> => {
    calls += 1;
    return {
      items: page === 1 ? [box("only-1")] : [],
      totalPages: 999,
    } as unknown as DaytonaSandboxPage;
  };

  const result = await _testCollectSandboxPages(fetch);

  assert(calls === 2, "stops after the first empty page");
  assert(result.sandboxes.length === 1, "keeping the one real sandbox");
  assert(result.complete === true, "and the answer is complete — the fleet really did run out");
}

async function testMissingTotalPages(): Promise<void> {
  console.log("\n[8] A missing totalPages still terminates");

  let calls = 0;
  const fetch = async (page: number): Promise<DaytonaSandboxPage> => {
    calls += 1;
    return { items: page <= 2 ? [box(`sb-${page}`)] : [] } as unknown as DaytonaSandboxPage;
  };

  const result = await _testCollectSandboxPages(fetch);

  assert(calls === 3, "walks until a page comes back empty");
  assert(result.sandboxes.length === 2, "collecting both real sandboxes");
  assert(result.complete === true, "and reports complete");
}

async function testPageCeiling(): Promise<void> {
  console.log("\n[9] The page ceiling is a refusal, not a short answer");

  // A server that always has one more item and claims more pages forever.
  const fetch = async (page: number): Promise<DaytonaSandboxPage> =>
    ({ items: [box(`sb-${page}`)], totalPages: 1_000_000 }) as unknown as DaytonaSandboxPage;

  const result = await _testCollectSandboxPages(fetch);

  assert(
    result.pagesFetched === DAYTONA_MAX_LIST_PAGES,
    `stops at ${DAYTONA_MAX_LIST_PAGES} pages`,
  );
  assert(result.complete === false, "and says so, rather than returning a plausible-looking list");
  assert((result.error ?? "").includes("exceeded"), "with a reason a log can be read for");
}

async function testEmptyFleet(): Promise<void> {
  console.log("\n[10] A genuinely empty organization is COMPLETE and empty");

  const { fetch } = pagesOf([{ ids: [] }]);
  const result = await _testCollectSandboxPages(fetch);

  assert(result.sandboxes.length === 0, "no sandboxes");
  assert(result.complete === true, "and complete — the answer a sweep may act on");
}

function testPageSizeConstant(): void {
  console.log("\n[11] Page size stays inside what every provider in the lineup accepts");

  assert(DAYTONA_LIST_PAGE_SIZE <= 100, "never above 100");
}

// =============================================================================
// RUNNER
// =============================================================================

const tests = [
  testDrainsEveryPage,
  testStateFilterBeforeLimit,
  testStateFilterExcludesArchived,
  testLimitStopsEarly,
  testLimitExactlyAtFleetEnd,
  testLimitZero,
  testDedupesAcrossPages,
  testFailureMidWalk,
  testFirstPageFailure,
  testEmptyPageEndsWalk,
  testMissingTotalPages,
  testPageCeiling,
  testEmptyFleet,
  testPageSizeConstant,
];

(async () => {
  console.log("=== Daytona Provider: list pagination + completeness Tests ===");
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
