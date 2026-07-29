#!/usr/bin/env tsx
/**
 * Unit Test: the error-code vocabulary has not drifted from the server's.
 *
 * The failure this exists to kill is silent by construction. A code the server
 * can send and this SDK has never heard of does not throw anywhere — the typed
 * union simply stops covering it, `isHostedErrorCode` answers false, and a
 * caller's `switch` falls through to a default it wrote for genuinely unknown
 * codes. It drifted exactly that way once (`upstream_not_watchable` shipped
 * server-side and reached neither SDK).
 *
 * The referee is hosted-error-codes.json at the package root: a checked-in copy
 * of the server's HOSTED_API_ERROR_CODES that the dashboard's own test
 * regenerates and diffs. So the chain is server -> json (proven in the
 * dashboard repo) -> this SDK (proven here) -> Python (proven in its own test
 * against the same file). No link is a copy nobody checks.
 *
 * Read from src, not dist: a drift detector that can pass against a stale build
 * is not a detector.
 *
 * Usage:
 *   npm run test:unit:error-codes
 *   npx tsx tests/unit/hosted-error-codes.test.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { HOSTED_ERROR_CODES, isHostedErrorCode } from "../../src/hosted/types";

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

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REFEREE_PATH = join(PACKAGE_ROOT, "hosted-error-codes.json");

console.log("\n=== Hosted error-code parity (vs hosted-error-codes.json) ===\n");

const referee = JSON.parse(readFileSync(REFEREE_PATH, "utf8")) as {
  codes: string[];
};

// A referee that failed to parse into a list would make every assertion below
// vacuously true, which is the one way this file could rot into a no-op.
assert(
  Array.isArray(referee.codes) && referee.codes.length > 10,
  `hosted-error-codes.json carries a vocabulary (${referee.codes?.length} codes)`,
);

const missing = referee.codes.filter(
  (code) => !(HOSTED_ERROR_CODES as readonly string[]).includes(code),
);
const extra = (HOSTED_ERROR_CODES as readonly string[]).filter(
  (code) => !referee.codes.includes(code),
);

assert(
  missing.length === 0,
  missing.length === 0
    ? "every server code is in HOSTED_ERROR_CODES"
    : `HOSTED_ERROR_CODES is missing server codes: ${missing.join(", ")} ` +
        "(add them to src/hosted/types.ts)",
);
assert(
  extra.length === 0,
  extra.length === 0
    ? "HOSTED_ERROR_CODES invents no code the server cannot send"
    : `HOSTED_ERROR_CODES carries codes the server does not: ${extra.join(", ")}`,
);

// ORDER too, not just membership. The referee is regenerated from the server
// array, so a matching order keeps the diff of a real change to one line.
assert(
  JSON.stringify([...HOSTED_ERROR_CODES]) === JSON.stringify(referee.codes),
  "HOSTED_ERROR_CODES is the server's list in the server's order",
);

// The runtime guard reads the same list the type is derived from.
assert(
  referee.codes.every((code) => isHostedErrorCode(code)),
  "isHostedErrorCode accepts every code in the vocabulary",
);
assert(
  !isHostedErrorCode("insufficient_creidts"),
  "isHostedErrorCode rejects a typo",
);

console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
