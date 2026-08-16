#!/usr/bin/env tsx
/**
 * Unit Test: the automated image refresh pipeline
 * (.github/workflows/image-refresh.yml).
 *
 * Two mechanisms are worth pinning here, because both are load-bearing and
 * both fail SILENTLY when they are wrong.
 *
 * [A] THE FORCE MECHANISM. Content addressing cannot see that `npm install -g
 *     something@latest` now resolves to a newer release, so an unchanged
 *     Dockerfile derives an unchanged tag and the pipeline correctly decides
 *     there is nothing to release. assets/docker/refresh-stamp is the coded way
 *     out: an ordinary build input, COPY'd into the image, whose only job is to
 *     move the hash when a maintainer says the inputs really did change. If the
 *     stamp ever stopped feeding the digest, `force_refresh` would run green
 *     and ship nothing.
 *
 * [B] THE SWAP PLANNER. Daytona has no rename and no in-place update, so the
 *     stable managed name `evolve-all` can only be moved by delete-then-create
 *     — a destructive motion with a real downtime gap. Which runs take that
 *     path is decided by one pure function, and it has two ways to be wrong
 *     that are opposites: never swapping (users stuck on an old image) or
 *     swapping every single run (a needless outage every week). The second is
 *     the easy bug, because Daytona records the backing image in a different
 *     field depending on how the snapshot was created — see [B3].
 *
 * Usage:
 *   npx tsx tests/unit/daytona-image-refresh.test.ts
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveImageVersion } from "../../../../assets/docker/image-digest.ts";
import {
  readRefreshStamp,
  refreshStampSource,
} from "../../../../assets/docker/write-refresh-stamp.ts";
import {
  backingImageRef,
  normalizeImageRef,
  planPlatformSnapshot,
  type SnapshotFacts,
} from "../../../../assets/daytona/refresh-platform-snapshot.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const DOCKER_DIR = resolve(REPO_ROOT, "assets/docker");

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

/** A copy of the build context, so tampering never touches the real one. */
function withTamperedDockerDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "evolve-refresh-inputs-"));
  try {
    cpSync(DOCKER_DIR, dir, { recursive: true });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// [A] The refresh stamp — the force mechanism
// ===========================================================================

function testStampRoundTrips(): void {
  console.log("\n[A1] The stamp file round-trips through its own writer/reader");

  const stamp = "2026-08-16T02:07:55Z — workflow run 42 attempt 1";
  assertEqual(readRefreshStamp(refreshStampSource(stamp)), stamp, "a written stamp reads back unchanged");
  assertEqual(
    readRefreshStamp("# only comments here\n"),
    undefined,
    "a file with no stamp line reports undefined rather than a wrong value"
  );

  const committed = readFileSync(join(DOCKER_DIR, "refresh-stamp"), "utf-8");
  assert(
    readRefreshStamp(committed) !== undefined,
    "the committed assets/docker/refresh-stamp carries a readable stamp"
  );
}

function testStampIsARealBuildInput(): void {
  console.log("\n[A2] LAW: rewriting the stamp moves the derived tag");

  const before = deriveImageVersion(DOCKER_DIR);
  withTamperedDockerDir((dir) => {
    writeFileSync(join(dir, "refresh-stamp"), refreshStampSource("2099-01-01T00:00:00Z — test"));
    assert(
      deriveImageVersion(dir) !== before,
      "a bumped stamp derives a DIFFERENT tag — force_refresh actually forces a release"
    );
  });
}

function testTheStampWriterIsNotABuildInput(): void {
  console.log("\n[A3] ...but the WRITER is derivation machinery and must NOT move the tag");

  const before = deriveImageVersion(DOCKER_DIR);
  withTamperedDockerDir((dir) => {
    writeFileSync(join(dir, "write-refresh-stamp.ts"), "// edited tooling\n");
    assertEqual(
      deriveImageVersion(dir),
      before,
      "editing write-refresh-stamp.ts leaves the tag alone (it never reaches the image)"
    );
  });
}

function testStampIsRealImageContent(): void {
  console.log("\n[A4] The stamp is image CONTENT, not a hash decoration");

  const dockerfile = readFileSync(join(DOCKER_DIR, "Dockerfile"), "utf-8");
  assert(
    /^\s*COPY\s+refresh-stamp\s+\/etc\/evolve-image-refresh\s*$/m.test(dockerfile),
    "the Dockerfile COPYs refresh-stamp into the image, so the new tag describes a genuinely different image"
  );
}

// ===========================================================================
// [B] The platform snapshot planner — which runs take the destructive path
// ===========================================================================

const TARGET = "evolvingmachines/evolve-all:c-972a01421d04";

/** A snapshot as Daytona records it when created from an `Image` (Image.base):
 *  imageName comes back EMPTY and the ref lives in the FROM line. */
function builtFromImage(ref: string, state = "active"): SnapshotFacts {
  return {
    name: "evolve-all",
    state,
    imageName: "",
    entrypoint: ["sleep", "infinity"],
    cpu: 4,
    mem: 4,
    disk: 10,
    buildInfo: { dockerfileContent: `FROM ${ref}\n` },
  };
}

function testAbsentSnapshotIsCreated(): void {
  console.log("\n[B1] A missing platform snapshot is created, never 'replaced'");

  const plan = planPlatformSnapshot(undefined, TARGET);
  assertEqual(plan.action, "create", "absent → create");
}

function testMatchingSnapshotIsLeftAlone(): void {
  console.log("\n[B2] An up-to-date snapshot is left alone");

  assertEqual(
    planPlatformSnapshot(builtFromImage(TARGET), TARGET).action,
    "noop",
    "same image + active → noop"
  );
  assertEqual(
    planPlatformSnapshot(builtFromImage(TARGET, "inactive"), TARGET).action,
    "activate",
    "same image + inactive → activate (Daytona sleeps snapshots after 2 idle weeks)"
  );
}

function testEmptyImageNameDoesNotForceASwap(): void {
  console.log("\n[B3] REGRESSION: an empty imageName must not look like a mismatch");

  // The live platform snapshot really does report imageName: "" — it was built
  // from an Image, so the ref is only in buildInfo. Reading imageName alone
  // would compare "" against the target, never match, and delete-and-rebuild
  // the fleet's snapshot on EVERY run of the weekly cron.
  const live = builtFromImage(TARGET);
  assertEqual(live.imageName, "", "precondition: Daytona reports an empty imageName for this shape");
  assertEqual(backingImageRef(live), TARGET, "the backing ref is recovered from buildInfo.dockerfileContent");
  assertEqual(
    planPlatformSnapshot(live, TARGET).action,
    "noop",
    "an already-correct snapshot is NOT swapped just because imageName is empty"
  );
}

function testPlainRegistryCreateIsAlsoUnderstood(): void {
  console.log("\n[B4] The other creation shape (plain registry string) is read too");

  const fromString: SnapshotFacts = { name: "evolve-all", state: "active", imageName: TARGET };
  assertEqual(backingImageRef(fromString), TARGET, "the backing ref is recovered from imageName");
  assertEqual(planPlatformSnapshot(fromString, TARGET).action, "noop", "same image → noop");
}

function testStaleSnapshotIsReplacedAndCarriesRollback(): void {
  console.log("\n[B5] A stale snapshot is replaced, and names its rollback image");

  // The real production case: the platform snapshot was built from the bare
  // (untagged, i.e. :latest) name, while the target is an immutable tag.
  const stale = builtFromImage("evolvingmachines/evolve-all");
  const plan = planPlatformSnapshot(stale, TARGET);
  assertEqual(plan.action, "replace", "untagged current vs tagged target → replace");
  assertEqual(
    plan.action === "replace" ? plan.from : undefined,
    "evolvingmachines/evolve-all",
    "the plan carries the previous ref, which is what makes rollback possible"
  );
}

function testInFlightBuildsAreNotInterrupted(): void {
  console.log("\n[B6] A build already in flight is waited out, not torn down");

  for (const state of ["pending", "building", "pulling", "snapshotting", "removing"]) {
    assertEqual(
      planPlatformSnapshot(builtFromImage("evolvingmachines/evolve-all", state), TARGET).action,
      "wait",
      `state "${state}" → wait (deleting would race the in-flight build for the name)`
    );
  }
}

function testDeadBuildOnTheRightImageIsRebuilt(): void {
  console.log("\n[B7] The right image in a failed state still has to be rebuilt");

  for (const state of ["error", "build_failed"]) {
    assertEqual(
      planPlatformSnapshot(builtFromImage(TARGET, state), TARGET).action,
      "replace",
      `state "${state}" → replace (activation cannot heal a failed build)`
    );
  }
}

function testRefNormalization(): void {
  console.log("\n[B8] Registry-equivalent refs are not treated as different images");

  assertEqual(
    normalizeImageRef("docker.io/evolvingmachines/evolve-all:c-1"),
    "evolvingmachines/evolve-all:c-1",
    "a docker.io/ prefix is stripped"
  );
  assertEqual(normalizeImageRef("  library/ubuntu:22.04 "), "ubuntu:22.04", "library/ and whitespace are stripped");
  assertEqual(
    planPlatformSnapshot(builtFromImage(`docker.io/${TARGET}`), TARGET).action,
    "noop",
    "the same image written two ways does not trigger a swap"
  );
}

function testUnrecordedImageIsReplaced(): void {
  console.log("\n[B9] A snapshot that records no image at all is replaced, with no rollback ref");

  const plan = planPlatformSnapshot({ name: "evolve-all", state: "active" }, TARGET);
  assertEqual(plan.action, "replace", "no recoverable ref → replace");
  assertEqual(
    plan.action === "replace" ? plan.from : "unset",
    undefined,
    "and the plan admits it has nothing to roll back to"
  );
}

const tests = [
  testStampRoundTrips,
  testStampIsARealBuildInput,
  testTheStampWriterIsNotABuildInput,
  testStampIsRealImageContent,
  testAbsentSnapshotIsCreated,
  testMatchingSnapshotIsLeftAlone,
  testEmptyImageNameDoesNotForceASwap,
  testPlainRegistryCreateIsAlsoUnderstood,
  testStaleSnapshotIsReplacedAndCarriesRollback,
  testInFlightBuildsAreNotInterrupted,
  testDeadBuildOnTheRightImageIsRebuilt,
  testRefNormalization,
  testUnrecordedImageIsReplaced,
];

(async () => {
  console.log("=== Image Refresh Pipeline Tests ===");
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
