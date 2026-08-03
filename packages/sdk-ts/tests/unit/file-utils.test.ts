#!/usr/bin/env tsx
/**
 * Unit Test: saveLocalDir() — hostile-name confinement
 *
 * The names in a FileMap come from sandbox output, so a hostile `../` or
 * absolute entry must be refused, never written outside the directory the
 * caller chose.
 *
 * Usage:
 *   npx tsx tests/unit/file-utils.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveLocalDir } from "../../dist/index.js";

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

// =============================================================================
// TESTS
// =============================================================================

console.log("\n=== saveLocalDir confinement ===\n");

const root = mkdtempSync(join(tmpdir(), "evolve-file-utils-"));
try {
  const target = join(root, "out");

  saveLocalDir(target, { "file.txt": "top", "sub/nested.txt": "deep" });
  assert(readFileSync(join(target, "file.txt"), "utf-8") === "top", "writes top-level entries");
  assert(readFileSync(join(target, "sub", "nested.txt"), "utf-8") === "deep", "writes nested entries");

  let threw = false;
  try {
    saveLocalDir(target, { "../escape.txt": "nope" });
  } catch {
    threw = true;
  }
  assert(threw, "refuses ../ traversal");
  assert(!existsSync(join(root, "escape.txt")), "traversal entry was not written");

  threw = false;
  const outside = join(root, "outside.txt");
  try {
    saveLocalDir(target, { [outside]: "nope" });
  } catch {
    threw = true;
  }
  assert(threw, "refuses absolute entry");
  assert(!existsSync(outside), "absolute entry was not written");

  saveLocalDir(target, { "sub/../ok.txt": "fine" });
  assert(readFileSync(join(target, "ok.txt"), "utf-8") === "fine", "allows .. that stays inside");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
