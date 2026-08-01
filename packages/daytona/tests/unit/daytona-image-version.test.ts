#!/usr/bin/env tsx
/**
 * Unit Test: Versioned image pipeline — Daytona side, plus the cross-file
 * version coherence law.
 *
 * Modal caches images by reference and Daytona caches snapshots by name, so a
 * re-pushed mutable :latest never reaches either. The fix is one version per
 * release, restated in three files because the published packages ship
 * standalone. This suite is what holds the copies together: it fails whenever
 * the three EVOLVE_IMAGE_VERSION constants disagree.
 *
 * Usage:
 *   npx tsx tests/unit/daytona-image-version.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVOLVE_IMAGE_VERSION,
  _testImageMap,
  createDaytonaProvider,
} from "../../src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");

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

function versionConstantIn(relativePath: string): string | undefined {
  const source = readFileSync(resolve(REPO_ROOT, relativePath), "utf-8");
  return /EVOLVE_IMAGE_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(source)?.[1];
}

/** A provider whose client records which snapshot name create() asks for. */
function providerAskingFor(): { provider: ReturnType<typeof createDaytonaProvider>; asked: string[] } {
  const asked: string[] = [];
  const provider = createDaytonaProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = {
    snapshot: {
      get: async (name: string) => {
        asked.push(name);
        return { state: "active" };
      },
    },
    create: async () => ({ id: "sb-1" }),
  };
  return { provider, asked };
}

async function silenceLogs<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

async function testDefaultSnapshotNameIsVersioned(): Promise<void> {
  console.log("\n[1] Default snapshot name carries the release version");

  const { provider, asked } = providerAskingFor();
  await silenceLogs(() => provider.create({}));
  assertEqual(
    asked[0],
    `evolve-all-${EVOLVE_IMAGE_VERSION}`,
    "a create with no image asks for the versioned default snapshot"
  );
}

async function testExplicitNamesPassThroughUntouched(): Promise<void> {
  console.log("\n[2] Explicit names pass through untouched (backward care)");

  const viaImage = providerAskingFor();
  await silenceLogs(() => viaImage.provider.create({ image: "evolve-all" }));
  assertEqual(viaImage.asked[0], "evolve-all", "a caller pinning image 'evolve-all' keeps exactly that name");

  const viaConfig = createDaytonaProvider({ apiKey: "test-key", snapshotName: "evolve-all" });
  const asked: string[] = [];
  (viaConfig as unknown as { client: unknown }).client = {
    snapshot: {
      get: async (name: string) => {
        asked.push(name);
        return { state: "active" };
      },
    },
    create: async () => ({ id: "sb-1" }),
  };
  await silenceLogs(() => viaConfig.create({}));
  assertEqual(asked[0], "evolve-all", "an explicit snapshotName config keeps exactly that name");
}

async function testImageMapCarriesBothNames(): Promise<void> {
  console.log("\n[3] IMAGE_MAP: versioned default plus untouched legacy name");

  assertEqual(
    _testImageMap[`evolve-all-${EVOLVE_IMAGE_VERSION}`],
    `evolvingmachines/evolve-all:${EVOLVE_IMAGE_VERSION}`,
    "the versioned snapshot name builds from the immutable versioned tag"
  );
  assertEqual(
    _testImageMap["evolve-all"],
    "evolvingmachines/evolve-all",
    "the legacy 'evolve-all' name still resolves to what it always did"
  );
}

async function testVersionCoherenceAcrossTheThreeFiles(): Promise<void> {
  console.log("\n[4] LAW: one version, three copies, moved together");

  assert(/^v\d+$/.test(EVOLVE_IMAGE_VERSION), `version "${EVOLVE_IMAGE_VERSION}" is a vN tag`);
  assertEqual(
    versionConstantIn("assets/docker/image-version.ts"),
    EVOLVE_IMAGE_VERSION,
    "assets/docker/image-version.ts (canonical) matches packages/daytona"
  );
  assertEqual(
    versionConstantIn("packages/modal/src/index.ts"),
    EVOLVE_IMAGE_VERSION,
    "packages/modal/src/index.ts matches packages/daytona"
  );
}

const tests = [
  testDefaultSnapshotNameIsVersioned,
  testExplicitNamesPassThroughUntouched,
  testImageMapCarriesBothNames,
  testVersionCoherenceAcrossTheThreeFiles,
];

(async () => {
  console.log("=== Daytona Versioned Image Pipeline Tests ===");
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
