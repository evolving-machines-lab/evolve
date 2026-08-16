#!/usr/bin/env tsx
/**
 * Unit Test: the E2B half of the automated image refresh
 * (assets/e2b/build.ts, driven by .github/workflows/image-refresh.yml).
 *
 * WHY THIS SUITE EXISTS. assets/e2b/build.ts used to end in
 * `main().catch(console.error)` — which PRINTS the failure and then exits 0. A
 * failed template build reported success to every caller, CI included, and the
 * pipeline would happily carry on to repoint Daytona and open a release PR on
 * the strength of a build that never happened. The fix has two halves, and this
 * pins the half that has logic in it:
 *
 *   1. the script now exits 1 (nothing to test — it is the absence of a bug)
 *   2. the script no longer believes its own exit code. It asks E2B what the
 *      `evolve-all` alias actually resolves to, and only accepts a NEW build id
 *      whose status is `ready`.
 *
 * The second half is the subtle one. "Ready" alone is not proof: E2B's
 * `buildID` is documented as the last SUCCESSFUL build, so a failed rebuild
 * leaves the PREVIOUS build sitting there, ready, looking exactly like success.
 * That is [3] below.
 *
 * Usage:
 *   npx tsx tests/unit/e2b-template-refresh.test.ts
 */

import { verifyBuildRow } from "../../../../assets/e2b/build.ts";

let passed = 0;
let failed = 0;

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

const PREVIOUS = "b6aaad75-be69-4f6b-abfe-541e2e462020";
const FRESH = "c7bbbe86-cf7a-5a7b-bcaf-652f3f573131";

const row = (buildID: string | undefined, buildStatus: string) => ({
  templateID: "jrzk5sxh903y9tmwld1k",
  aliases: ["evolve-all"],
  buildID,
  buildStatus,
});

function testNewReadyBuildIsAccepted(): void {
  console.log("\n[1] A new build that reached 'ready' is the success case");

  assertEqual(verifyBuildRow(row(FRESH, "ready"), PREVIOUS).outcome, "ready", "new build id + ready → ready");
  assertEqual(
    verifyBuildRow(row(FRESH, "ready"), undefined).outcome,
    "ready",
    "first ever build (no previous id) + ready → ready"
  );
}

function testFailedBuildIsAVerdict(): void {
  console.log("\n[2] A failed build stops the wait instead of burning the timeout");

  const verdict = verifyBuildRow(row(FRESH, "error"), PREVIOUS);
  assertEqual(verdict.outcome, "failed", "status 'error' → failed");
  assertEqual(
    verdict.outcome === "failed" && verdict.detail.includes(FRESH),
    true,
    "the verdict names the build that failed"
  );
}

function testStaleReadyBuildIsNotSuccess(): void {
  console.log("\n[3] REGRESSION: the PREVIOUS build sitting 'ready' is not a successful refresh");

  // The exact shape of the old exit-0 bug, one level up: the build failed, so
  // E2B still serves the last good build — ready, healthy, and completely
  // unchanged. Accepting "ready" alone would green-light a refresh that shipped
  // nothing, and the release PR would claim E2B users had moved.
  const verdict = verifyBuildRow(row(PREVIOUS, "ready"), PREVIOUS);
  assertEqual(verdict.outcome, "pending", "unchanged build id + ready → NOT accepted");
  assertEqual(
    verdict.outcome === "pending" && verdict.detail.includes("previous"),
    true,
    "and it says so: still serving the previous build"
  );
}

function testInFlightAndMissingKeepWaiting(): void {
  console.log("\n[4] In-flight and not-yet-listed states keep waiting");

  for (const status of ["building", "waiting"]) {
    assertEqual(verifyBuildRow(row(PREVIOUS, status), PREVIOUS).outcome, "pending", `status '${status}' → pending`);
  }
  assertEqual(
    verifyBuildRow(undefined, PREVIOUS).outcome,
    "pending",
    "template not listed yet → pending (first build races the listing)"
  );
  assertEqual(
    verifyBuildRow(row(undefined, "ready"), PREVIOUS).outcome,
    "pending",
    "ready with no build id at all → pending, never accepted"
  );
}

const tests = [
  testNewReadyBuildIsAccepted,
  testFailedBuildIsAVerdict,
  testStaleReadyBuildIsNotSuccess,
  testInFlightAndMissingKeepWaiting,
];

(async () => {
  console.log("=== E2B Template Refresh Verification Tests ===");
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
