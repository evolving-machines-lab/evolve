#!/usr/bin/env tsx
/**
 * Integration Test 23: Storage Edge Cases — Multi-Session Cross-Tag (BYOK + Gateway)
 *
 * End-to-end test for cross-session checkpoint scenarios:
 *   1. Multi-session limit+tag — two sessions create checkpoints with different tags,
 *      then listCheckpoints(limit, tag) returns exactly the right count from the right tag
 *   2. from: "latest" global scope — restores from globally newest checkpoint regardless
 *      of which session created it
 *   3. Cross-session listCheckpoints ordering — newest-first across mixed tags
 *   4. Limit without tag — limits correctly across mixed tags
 *
 * Requires:
 *   EVOLVE_API_KEY — LLM gateway (both modes) + dashboard auth (gateway mode)
 *   E2B_API_KEY — sandbox provider (or DAYTONA_API_KEY / MODAL_TOKEN_ID+SECRET)
 *   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY — S3 credentials (BYOK only)
 *
 * Usage:
 *   npx tsx tests/integration/23-storage-edge-cases.ts
 *   TEST_STORAGE_MODE=gateway npx tsx tests/integration/23-storage-edge-cases.ts
 *   TEST_SANDBOX_PROVIDER=daytona npx tsx tests/integration/23-storage-edge-cases.ts
 */

import { Evolve, storage } from "../../dist/index.js";
import type { CheckpointInfo } from "../../dist/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { getAgentConfig, getSandboxProvider, getSandboxProviderByName, type ProviderName } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

// =============================================================================
// CONFIG
// =============================================================================

const PROVIDER_NAME = (process.env.TEST_SANDBOX_PROVIDER || process.argv[2] || "") as ProviderName | "";
const PROVIDER_LABEL = PROVIDER_NAME || "default";
const LOGS_DIR = resolve(__dirname, `../test-logs/23-storage-edge-cases-${PROVIDER_LABEL}`);
const STORAGE_URL = `s3://swarmkit-test-checkpoints-905418019965/integration-test-edge-${PROVIDER_LABEL}/`;
const STORAGE_REGION = "us-west-2";
const STORAGE_MODE = (process.env.TEST_STORAGE_MODE || "byok") as "byok" | "gateway";
const IS_GATEWAY = STORAGE_MODE === "gateway";
const TIMEOUT = 180000; // 3 min per run

function getStorageConfig() {
  if (IS_GATEWAY) return {};
  return { url: STORAGE_URL, region: STORAGE_REGION };
}

// =============================================================================
// HELPERS
// =============================================================================

function log(msg: string) {
  console.log(`[23] ${msg}`);
}

function save(name: string, content: string) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

function assertDefined<T>(value: T | undefined | null, label: string): asserts value is T {
  if (value == null) {
    throw new Error(`${label}: expected defined, got ${value}`);
  }
  log(`  \u2713 ${label}`);
}

function assertEq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  log(`  \u2713 ${label}`);
}

function assertTrue(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(`${label}: expected true, got false`);
  }
  log(`  \u2713 ${label}`);
}

// =============================================================================
// S3 CLEANUP
// =============================================================================

async function cleanupS3Prefix() {
  log("\n\u2500\u2500 Cleanup: S3 test objects");
  if (IS_GATEWAY) {
    log("  \u25CB Skipping S3 cleanup (gateway mode)");
    return;
  }
  try {
    const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: STORAGE_REGION });
    const bucket = "swarmkit-test-checkpoints-905418019965";
    const prefix = `integration-test-edge-${PROVIDER_LABEL}/`;

    let continuationToken: string | undefined;
    let totalDeleted = 0;

    do {
      const listResult = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      const objects = listResult.Contents;
      if (objects && objects.length > 0) {
        await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: objects.map(o => ({ Key: o.Key })),
            Quiet: true,
          },
        }));
        totalDeleted += objects.length;
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

    log(`  \u2713 Deleted ${totalDeleted} objects from s3://${bucket}/${prefix}`);
  } catch (e) {
    log(`  WARNING: S3 cleanup failed: ${(e as Error).message}`);
  }
}

// =============================================================================
// MAIN TEST
// =============================================================================

async function main() {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  log(`Starting storage edge cases integration test (${STORAGE_MODE} mode)...\n`);
  const start = Date.now();

  const agentConfig = getAgentConfig("claude");
  const provider = PROVIDER_NAME
    ? getSandboxProviderByName(PROVIDER_NAME)
    : getSandboxProvider();
  log(`Using provider: ${PROVIDER_LABEL}, storage: ${STORAGE_MODE}`);

  const storageConfig = getStorageConfig();

  // Collect all checkpoints for verification
  let sessionACheckpoints: CheckpointInfo[] = [];
  let sessionBCheckpoints: CheckpointInfo[] = [];
  let tagA = "";
  let tagB = "";

  try {
    // =========================================================================
    // Phase 1: Session A — create 2 checkpoints
    // =========================================================================
    log("\u2500\u2500 Phase 1: Session A \u2014 create 2 checkpoints");

    const evolveA = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage(storageConfig);

    // Run 1A
    const run1A = await evolveA.run({
      prompt: "Create a file called session-a.txt with content 'Session A checkpoint 1'",
      timeoutMs: TIMEOUT,
      checkpointComment: "session-A run 1",
    });
    save("phase1-run1A-stdout.txt", run1A.stdout);
    assertEq(run1A.exitCode, 0, "run1A exits 0");
    assertDefined(run1A.checkpoint, "run1A.checkpoint is defined");
    sessionACheckpoints.push(run1A.checkpoint);
    tagA = run1A.checkpoint.tag;
    log(`  Session A tag: ${tagA}`);

    // Run 2A (same session, builds lineage)
    const run2A = await evolveA.run({
      prompt: "Append ' - updated' to session-a.txt",
      timeoutMs: TIMEOUT,
      checkpointComment: "session-A run 2",
    });
    save("phase1-run2A-stdout.txt", run2A.stdout);
    assertEq(run2A.exitCode, 0, "run2A exits 0");
    assertDefined(run2A.checkpoint, "run2A.checkpoint is defined");
    sessionACheckpoints.push(run2A.checkpoint);

    // Verify lineage within session A
    assertEq(
      run2A.checkpoint.parentId,
      run1A.checkpoint.id,
      "session A: run2A parentId = run1A checkpoint ID"
    );

    log("  Killing session A sandbox...");
    await evolveA.kill();
    log(`  \u2713 Phase 1 complete (session A: ${sessionACheckpoints.length} checkpoints)\n`);

    // =========================================================================
    // Phase 2: Session B — create 2 checkpoints (different tag)
    // =========================================================================
    log("\u2500\u2500 Phase 2: Session B \u2014 create 2 checkpoints (different tag)");

    const evolveB = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage(storageConfig);

    // Run 1B
    const run1B = await evolveB.run({
      prompt: "Create a file called session-b.txt with content 'Session B checkpoint 1'",
      timeoutMs: TIMEOUT,
      checkpointComment: "session-B run 1",
    });
    save("phase2-run1B-stdout.txt", run1B.stdout);
    assertEq(run1B.exitCode, 0, "run1B exits 0");
    assertDefined(run1B.checkpoint, "run1B.checkpoint is defined");
    sessionBCheckpoints.push(run1B.checkpoint);
    tagB = run1B.checkpoint.tag;
    log(`  Session B tag: ${tagB}`);

    // Verify tags are different (separate sessions get unique tags)
    assertTrue(tagA !== tagB, "Session A and B have different tags");

    // Run 2B
    const run2B = await evolveB.run({
      prompt: "Append ' - updated' to session-b.txt",
      timeoutMs: TIMEOUT,
      checkpointComment: "session-B run 2",
    });
    save("phase2-run2B-stdout.txt", run2B.stdout);
    assertEq(run2B.exitCode, 0, "run2B exits 0");
    assertDefined(run2B.checkpoint, "run2B.checkpoint is defined");
    sessionBCheckpoints.push(run2B.checkpoint);

    log("  Killing session B sandbox...");
    await evolveB.kill();
    log(`  \u2713 Phase 2 complete (session B: ${sessionBCheckpoints.length} checkpoints)\n`);

    // Brief delay for S3 read-after-write consistency on listing
    log("  Waiting 3s for S3 consistency...");
    await new Promise(r => setTimeout(r, 3000));

    // =========================================================================
    // Phase 3: listCheckpoints(limit, tag) — multi-session cross-tag
    // =========================================================================
    log("\u2500\u2500 Phase 3: listCheckpoints(limit, tag) \u2014 cross-tag filtering");

    // 3a: tag=A, limit=1 — should get only session A's newest
    const listA1 = await storage(storageConfig).listCheckpoints({ limit: 1, tag: tagA });
    assertEq(listA1.length, 1, "limit=1, tag=A returns exactly 1");
    assertEq(listA1[0].id, sessionACheckpoints[1].id, "tag=A limit=1 returns A's newest checkpoint");
    assertEq(listA1[0].tag, tagA, "Result tag matches tagA");

    // 3b: tag=A, limit=10 — should get all 2 from session A
    const listA2 = await storage(storageConfig).listCheckpoints({ limit: 10, tag: tagA });
    assertEq(listA2.length, 2, "limit=10, tag=A returns all 2 session A checkpoints");
    assertTrue(
      listA2.every(cp => cp.tag === tagA),
      "All results have tag=A (no session B leakage)"
    );
    assertEq(listA2[0].id, sessionACheckpoints[1].id, "Newest A first");
    assertEq(listA2[1].id, sessionACheckpoints[0].id, "Oldest A second");

    // 3c: tag=B, limit=1 — should get only session B's newest
    const listB1 = await storage(storageConfig).listCheckpoints({ limit: 1, tag: tagB });
    assertEq(listB1.length, 1, "limit=1, tag=B returns exactly 1");
    assertEq(listB1[0].id, sessionBCheckpoints[1].id, "tag=B limit=1 returns B's newest checkpoint");
    assertEq(listB1[0].tag, tagB, "Result tag matches tagB");

    log(`  \u2713 Phase 3 complete\n`);

    // =========================================================================
    // Phase 4: Cross-session ordering (no tag filter)
    // =========================================================================
    log("\u2500\u2500 Phase 4: Cross-session ordering (no tag filter)");

    const allCheckpoints = await storage(storageConfig).listCheckpoints();

    // Should have at least 4 checkpoints total
    assertTrue(allCheckpoints.length >= 4, `listCheckpoints() returned >= 4 (got ${allCheckpoints.length})`);

    // Verify newest-first ordering: timestamps should be descending
    for (let i = 1; i < allCheckpoints.length; i++) {
      const prev = new Date(allCheckpoints[i - 1].timestamp).getTime();
      const curr = new Date(allCheckpoints[i].timestamp).getTime();
      assertTrue(prev >= curr, `Checkpoint ${i - 1} (${allCheckpoints[i - 1].timestamp}) >= checkpoint ${i} (${allCheckpoints[i].timestamp})`);
    }
    log("  \u2713 All checkpoints sorted newest-first");

    // Session B was created after session A, so B's checkpoints should appear first
    // (unless there's very tight timing, in which case we just verify overall ordering)
    const firstCpTag = allCheckpoints[0].tag;
    log(`  First checkpoint tag: ${firstCpTag} (expected ${tagB} if B ran after A)`);

    log(`  \u2713 Phase 4 complete\n`);

    // =========================================================================
    // Phase 5: Limit without tag — mixed tags
    // =========================================================================
    log("\u2500\u2500 Phase 5: Limit without tag \u2014 mixed tags");

    const limited2 = await storage(storageConfig).listCheckpoints({ limit: 2 });
    assertEq(limited2.length, 2, "limit=2 returns exactly 2 entries");

    // Should be the 2 newest regardless of tag
    assertEq(limited2[0].id, allCheckpoints[0].id, "limit=2 first matches overall newest");
    assertEq(limited2[1].id, allCheckpoints[1].id, "limit=2 second matches overall second");

    const limited3 = await storage(storageConfig).listCheckpoints({ limit: 3 });
    assertEq(limited3.length, 3, "limit=3 returns exactly 3 entries");

    log(`  \u2713 Phase 5 complete\n`);

    // =========================================================================
    // Phase 6: from: "latest" global scope — restores from globally newest
    // =========================================================================
    log("\u2500\u2500 Phase 6: from: 'latest' \u2014 global scope");

    // The globally newest checkpoint should be session B's last checkpoint
    const globalNewest = allCheckpoints[0];
    log(`  Global newest: id=${globalNewest.id}, tag=${globalNewest.tag}`);

    const evolveC = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage(storageConfig);

    const runC = await evolveC.run({
      prompt: "List all .txt files in the workspace and tell me their names.",
      from: "latest",
      timeoutMs: TIMEOUT,
    });
    save("phase6-runC-stdout.txt", runC.stdout);
    save("phase6-runC-stderr.txt", runC.stderr);

    assertEq(runC.exitCode, 0, "runC exits 0");
    assertDefined(runC.checkpoint, "runC.checkpoint is defined");

    // The parent should be the global newest (the checkpoint we restored from)
    assertEq(
      runC.checkpoint.parentId,
      globalNewest.id,
      `runC parentId = global newest (${globalNewest.id})`
    );

    log("  Killing session C sandbox...");
    await evolveC.kill();
    log(`  \u2713 Phase 6 complete\n`);

    // =========================================================================
    // Results
    // =========================================================================
    await cleanupS3Prefix();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log("=".repeat(60));
    log(`PASS - All storage edge case tests passed (${duration}s)`);
    log("=".repeat(60) + "\n");
    process.exit(0);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save("error.txt", err instanceof Error ? err.stack || msg : msg);

    await cleanupS3Prefix();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log("\n" + "=".repeat(60));
    log(`FAIL - ${msg} (${duration}s)`);
    log("=".repeat(60) + "\n");
    process.exit(1);
  }
}

main();
