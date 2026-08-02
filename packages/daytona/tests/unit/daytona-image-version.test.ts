#!/usr/bin/env tsx
/**
 * Unit Test: Versioned image pipeline — Daytona side, plus the derived-version
 * coherence law.
 *
 * Modal caches images by reference and Daytona caches snapshots by name, so a
 * re-pushed mutable :latest never reaches either. The fix is one immutable
 * tag per release — and the tag is DERIVED, never hand-written: c-<12hex>,
 * the sha256 of the image build inputs under assets/docker/, regenerated into
 * three checked-in constants because the published packages ship standalone.
 * This suite is the forcing function that replaced the human bump: it
 * recomputes the digest and fails whenever a checked-in constant is stale
 * (regenerate-and-match), and proves any input change moves the tag
 * (tamper-and-fail).
 *
 * Usage:
 *   npx tsx tests/unit/daytona-image-version.test.ts
 */

import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVOLVE_IMAGE_VERSION,
  _testImageMap,
  createDaytonaProvider,
} from "../../src/index.ts";
import {
  EVOLVE_IMAGE_VERSION_PATTERN,
  deriveImageVersion,
} from "../../../../assets/docker/image-digest.ts";

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

async function testVersionIsDerivedNotHandWritten(): Promise<void> {
  console.log("\n[4] LAW: the version is DERIVED — checked-in constants match the build inputs");

  assert(
    EVOLVE_IMAGE_VERSION_PATTERN.test(EVOLVE_IMAGE_VERSION),
    `version "${EVOLVE_IMAGE_VERSION}" is a c-<12hex> content tag`
  );

  const derived = deriveImageVersion(resolve(REPO_ROOT, "assets/docker"));
  assertEqual(
    EVOLVE_IMAGE_VERSION,
    derived,
    "packages/daytona's checked-in constant equals the freshly derived digest (regenerate-and-match)"
  );
  assertEqual(
    versionConstantIn("assets/docker/image-version.ts"),
    derived,
    "assets/docker/image-version.ts carries the derived digest"
  );
  assertEqual(
    versionConstantIn("packages/modal/src/image-version.ts"),
    derived,
    "packages/modal/src/image-version.ts carries the derived digest"
  );
}

async function testAnyInputChangeMovesTheTag(): Promise<void> {
  console.log("\n[5] LAW: any build-input change moves the tag (tamper-and-fail)");

  const tampered = mkdtempSync(join(tmpdir(), "evolve-image-inputs-"));
  try {
    cpSync(resolve(REPO_ROOT, "assets/docker"), tampered, { recursive: true });

    appendFileSync(join(tampered, "Dockerfile"), "\n# tampered\n");
    const afterDockerfileEdit = deriveImageVersion(tampered);
    assert(
      afterDockerfileEdit !== EVOLVE_IMAGE_VERSION,
      "an edited Dockerfile derives a DIFFERENT tag — un-regenerated constants would fail [4]"
    );

    writeFileSync(join(tampered, "startup.sh"), "#!/bin/sh\n");
    assert(
      deriveImageVersion(tampered) !== afterDockerfileEdit,
      "a new file in the build context moves the tag too (future COPY inputs are covered)"
    );
  } finally {
    rmSync(tampered, { recursive: true, force: true });
  }
}

const tests = [
  testDefaultSnapshotNameIsVersioned,
  testExplicitNamesPassThroughUntouched,
  testImageMapCarriesBothNames,
  testVersionIsDerivedNotHandWritten,
  testAnyInputChangeMovesTheTag,
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
