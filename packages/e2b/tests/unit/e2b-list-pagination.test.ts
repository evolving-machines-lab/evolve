#!/usr/bin/env tsx
/**
 * Unit Test: E2B sandbox list pagination
 *
 * `list()` used to call the paginator's nextItems() exactly ONCE and return
 * whatever the first page held. E2B caps a page at 100, so any project past
 * that was silently truncated — and nothing in the return value said so. The
 * caller that cares is a fleet sweep, which reads a sandbox's ABSENCE from the
 * list as evidence it is gone, so a truncated page read as a whole fleet is a
 * correctness bug and not a slow query.
 *
 * What is asserted here is the walk itself, with no network in it:
 *   1. every page is drained, not just the first
 *   2. an explicit limit stops early and reports COMPLETE (the caller got what
 *      it asked for)
 *   3. a failure mid-walk reports INCOMPLETE, keeping what it saw
 *   4. a repeated pagination token cannot spin the loop
 *   5. the page ceiling is a refusal, never a short "complete" answer
 *
 * Usage:
 *   npx tsx tests/unit/e2b-list-pagination.test.ts
 */

import {
  E2B_MAX_LIST_PAGES,
  E2B_MAX_PAGE_SIZE,
  _testCollectSandboxPages,
  type E2BSandboxPaginator,
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

type Page = { sandboxIds: string[]; token?: string; throws?: string };

/** A paginator double that serves the given pages in order. */
function paginatorOf(pages: Page[], opts?: { endless?: boolean }): E2BSandboxPaginator {
  let index = 0;
  return {
    get hasNext() {
      return opts?.endless ? true : index < pages.length;
    },
    get nextToken() {
      return (opts?.endless ? pages[0] : pages[index])?.token;
    },
    async nextItems() {
      const page = opts?.endless ? pages[0]! : pages[index++]!;
      if (page.throws) throw new Error(page.throws);
      return page.sandboxIds.map((sandboxId) => ({
        sandboxId,
        templateId: "tmpl",
        metadata: {},
        startedAt: new Date("2026-07-28T12:00:00.000Z"),
      }));
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

  const page = await _testCollectSandboxPages(
    paginatorOf([
      { sandboxIds: ids(100, "a"), token: "t1" },
      { sandboxIds: ids(100, "b"), token: "t2" },
      { sandboxIds: ids(7, "c") },
    ]),
  );

  assert(page.sandboxes.length === 207, "returns every sandbox across three pages, not the first 100");
  assert(page.pagesFetched === 3, "reports the three requests it made");
  assert(page.complete === true, "an exhausted paginator is COMPLETE");
  assert(page.error === undefined, "a clean walk carries no error");
  assert(page.sandboxes[0]!.sandboxId === "a-0", "preserves provider order");
  assert(page.sandboxes[206]!.sandboxId === "c-6", "including the last page");
}

async function testMapsFields(): Promise<void> {
  console.log("\n[2] Field mapping is unchanged by the walk");

  const page = await _testCollectSandboxPages(paginatorOf([{ sandboxIds: ["sb-1"] }]));
  const info = page.sandboxes[0]!;

  assert(info.image === "tmpl", "templateId is exposed as image");
  assert(info.startedAt === "2026-07-28T12:00:00.000Z", "startedAt is a real ISO string");
  assert(info.endAt === undefined, "a running sandbox has no endAt (never fabricated)");
}

async function testLimitStopsEarly(): Promise<void> {
  console.log("\n[3] An explicit limit bounds ITEMS — and a limit that hides sandboxes is INCOMPLETE");

  const paginator = paginatorOf([
    { sandboxIds: ids(100, "a"), token: "t1" },
    { sandboxIds: ids(100, "b"), token: "t2" },
    { sandboxIds: ids(100, "c") },
  ]);
  const page = await _testCollectSandboxPages(paginator, 150);

  assert(page.sandboxes.length === 150, "returns exactly the limit");
  assert(page.pagesFetched === 2, "and stops requesting pages once it has them");
  // THE FINDING: this used to report complete:true. The only real consumer is a
  // sweep that ALWAYS passes a limit, so calling a limit-truncated walk
  // "complete" meant truncation could never raise there — the flag existed and
  // could not fire.
  assert(
    page.complete === false,
    "INCOMPLETE, because more sandboxes provably exist behind the limit",
  );
  assert((page.error ?? "").includes("limit"), "and the reason names the limit");
}

async function testLimitExactlyAtFleetEnd(): Promise<void> {
  console.log("\n[3b] A limit that lands exactly on the end of the fleet IS complete");

  // The discriminating case: nothing is hidden, so this is not truncation.
  const page = await _testCollectSandboxPages(paginatorOf([{ sandboxIds: ids(5, "a") }]), 5);

  assert(page.sandboxes.length === 5, "returns all five");
  assert(page.complete === true, "complete — the limit and the fleet ended together");
  assert(page.error === undefined, "and carries no error");
}

async function testLimitZero(): Promise<void> {
  console.log("\n[3c] limit: 0 returns nothing, not one");

  // The bound was checked AFTER the push, so zero returned one sandbox.
  const page = await _testCollectSandboxPages(paginatorOf([{ sandboxIds: ids(3, "a") }]), 0);

  assert(page.sandboxes.length === 0, "returns zero sandboxes");
  assert(page.complete === false, "and says so — three were hidden by the bound");
}

async function testFailureMidWalk(): Promise<void> {
  console.log("\n[4] A failure mid-walk is INCOMPLETE, never a short complete list");

  const page = await _testCollectSandboxPages(
    paginatorOf([
      { sandboxIds: ids(100, "a"), token: "t1" },
      { sandboxIds: [], throws: "502 bad gateway" },
    ]),
  );

  assert(page.complete === false, "the walk admits it did not finish");
  assert(page.sandboxes.length === 100, "and keeps what it did see");
  assert(page.pagesFetched === 1, "counting only the pages that landed");
  assert(
    (page.error ?? "").includes("502 bad gateway"),
    "carrying the provider's own reason",
  );
}

async function testFirstPageFailure(): Promise<void> {
  console.log("\n[5] A failure on the FIRST page is not an empty fleet");

  const page = await _testCollectSandboxPages(
    paginatorOf([{ sandboxIds: [], throws: "connection reset" }]),
  );

  assert(page.sandboxes.length === 0, "no sandboxes are reported");
  assert(
    page.complete === false,
    "but complete is FALSE — this is the case that would mass-kill a live fleet if it read as empty",
  );
}

async function testRepeatedTokenCannotSpin(): Promise<void> {
  console.log("\n[6] A repeated pagination token ends the walk as incomplete");

  // A server that keeps handing back the same token with hasNext true would
  // otherwise loop forever inside a webhook or a poll tick.
  const page = await _testCollectSandboxPages(
    paginatorOf([{ sandboxIds: ids(2, "a"), token: "same" }], { endless: true }),
  );

  assert(page.complete === false, "refuses rather than spinning");
  assert(page.error === "pagination token repeated", "and names the reason");
  assert(page.pagesFetched === 1, "having made exactly one request before noticing");
}

async function testPageCeiling(): Promise<void> {
  console.log("\n[7] The page ceiling is a refusal, not a short answer");

  // Endless pages, each with a DIFFERENT token so the repeat guard cannot fire.
  let n = 0;
  const paginator: E2BSandboxPaginator = {
    hasNext: true,
    get nextToken() {
      return `t${n}`;
    },
    async nextItems() {
      n += 1;
      return [
        {
          sandboxId: `sb-${n}`,
          templateId: "tmpl",
          metadata: {},
          startedAt: new Date("2026-07-28T12:00:00.000Z"),
        },
      ];
    },
  };

  const page = await _testCollectSandboxPages(paginator);

  assert(page.pagesFetched === E2B_MAX_LIST_PAGES, `stops at ${E2B_MAX_LIST_PAGES} pages`);
  assert(page.complete === false, "and says so, rather than returning a plausible-looking list");
  assert((page.error ?? "").includes("exceeded"), "with a reason a log can be read for");
}

async function testEmptyFleet(): Promise<void> {
  console.log("\n[8] A genuinely empty project is COMPLETE and empty");

  const page = await _testCollectSandboxPages(paginatorOf([]));

  assert(page.sandboxes.length === 0, "no sandboxes");
  assert(page.complete === true, "and complete — this is the answer a sweep may act on");
  assert(page.pagesFetched === 0, "costing zero requests");
}

function testPageSizeConstant(): void {
  console.log("\n[9] Page size stays inside what E2B accepts");

  assert(
    E2B_MAX_PAGE_SIZE <= 100,
    "never above 100 — E2B rejects a larger limit with a 400 outright",
  );
}

// =============================================================================
// RUNNER
// =============================================================================

const tests = [
  testDrainsEveryPage,
  testMapsFields,
  testLimitStopsEarly,
  testLimitExactlyAtFleetEnd,
  testLimitZero,
  testFailureMidWalk,
  testFirstPageFailure,
  testRepeatedTokenCannotSpin,
  testPageCeiling,
  testEmptyFleet,
  testPageSizeConstant,
];

(async () => {
  console.log("=== E2B Provider: list pagination + completeness Tests ===");
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
