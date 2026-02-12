#!/usr/bin/env tsx
/**
 * Integration Test 22: Storage DX v3.3 Features (BYOK + Gateway)
 *
 * End-to-end test for all v3.3 checkpoint DX improvements.
 * Supports two modes via TEST_STORAGE_MODE env var:
 *   - "byok" (default): direct S3 access with user credentials
 *   - "gateway": dashboard API endpoints (no direct S3 access needed)
 *
 * Tests:
 *   1. listCheckpoints() — returns checkpoints sorted by newest first
 *   2. from: "latest" — resolves and restores the most recent checkpoint
 *   3. kit.checkpoint({ comment }) — explicit checkpoint with label
 *   4. checkpointComment — passthrough via run()
 *   5. parentId lineage — chained across runs
 *   6. Evolve.listCheckpoints() — instance method
 *   7. Limit parameter — restricts number of results
 *
 * Requires:
 *   EVOLVE_API_KEY — LLM gateway (both modes) + dashboard auth (gateway mode)
 *   E2B_API_KEY — sandbox provider
 *   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY — S3 credentials (BYOK only)
 *
 * Usage:
 *   npx tsx tests/integration/22-storage-dx.ts
 *   TEST_STORAGE_MODE=gateway npx tsx tests/integration/22-storage-dx.ts
 */

import { Evolve, listCheckpoints } from "../../dist/index.js";
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
const LOGS_DIR = resolve(__dirname, `../test-logs/22-storage-dx-${PROVIDER_LABEL}`);
const STORAGE_URL = `s3://swarmkit-test-checkpoints-905418019965/integration-test-dx-${PROVIDER_LABEL}/`;
const STORAGE_REGION = "us-west-2";
const STORAGE_MODE = (process.env.TEST_STORAGE_MODE || "byok") as "byok" | "gateway";
const IS_GATEWAY = STORAGE_MODE === "gateway";
const TIMEOUT = 180000; // 3 min per run

function getStorageConfig() {
  if (IS_GATEWAY) return {}; // SDK reads EVOLVE_API_KEY from env → gateway mode
  return { url: STORAGE_URL, region: STORAGE_REGION };
}

// =============================================================================
// HELPERS
// =============================================================================

function log(msg: string) {
  console.log(`[22] ${msg}`);
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
    log("  \u25CB Skipping S3 cleanup (gateway mode \u2014 dashboard manages storage)");
    return;
  }
  try {
    const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: STORAGE_REGION });
    const bucket = "swarmkit-test-checkpoints-905418019965";
    const prefix = `integration-test-dx-${PROVIDER_LABEL}/`;

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

  log(`Starting storage DX v3.3 integration test (${STORAGE_MODE} mode)...\n`);
  const start = Date.now();

  const agentConfig = getAgentConfig("claude");
  const provider = PROVIDER_NAME
    ? getSandboxProviderByName(PROVIDER_NAME)
    : getSandboxProvider();
  log(`Using provider: ${PROVIDER_LABEL}, storage: ${STORAGE_MODE}`);

  const storageConfig = getStorageConfig();

  let checkpoint1: CheckpointInfo | undefined;
  let checkpoint2: CheckpointInfo | undefined;
  let checkpoint3: CheckpointInfo | undefined;

  try {
    // =========================================================================
    // Phase 1: Create first checkpoint with checkpointComment
    // =========================================================================
    log("\u2500\u2500 Phase 1: First run with checkpointComment");

    const evolve1 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage(storageConfig);

    log("  Running prompt...");
    const run1 = await evolve1.run({
      prompt: "Create a file called dx-test.txt with the content 'DX v3.3 checkpoint test'",
      timeoutMs: TIMEOUT,
      checkpointComment: "initial setup",
    });
    save("phase1-stdout.txt", run1.stdout);
    save("phase1-stderr.txt", run1.stderr);

    assertEq(run1.exitCode, 0, "run1 exits 0");
    assertDefined(run1.checkpoint, "run1.checkpoint is defined");

    checkpoint1 = run1.checkpoint;
    assertDefined(checkpoint1.id, "checkpoint1.id is defined");
    assertEq(checkpoint1.comment, "initial setup", "checkpoint1.comment = 'initial setup'");
    assertEq(checkpoint1.parentId, undefined, "checkpoint1.parentId is undefined (first checkpoint)");
    assertEq(checkpoint1.agentType, "claude", "checkpoint1.agentType is claude");

    save("checkpoint1.json", JSON.stringify(checkpoint1, null, 2));
    log(`  Checkpoint 1: id=${checkpoint1.id}, comment=${checkpoint1.comment}`);

    // =========================================================================
    // Phase 2: Second run — verify parentId lineage
    // =========================================================================
    log("\n\u2500\u2500 Phase 2: Second run verifying parentId lineage");

    const run2 = await evolve1.run({
      prompt: "Append ' - verified' to the end of dx-test.txt",
      timeoutMs: TIMEOUT,
      checkpointComment: "verification pass",
    });
    save("phase2-stdout.txt", run2.stdout);
    save("phase2-stderr.txt", run2.stderr);

    assertEq(run2.exitCode, 0, "run2 exits 0");
    assertDefined(run2.checkpoint, "run2.checkpoint is defined");

    checkpoint2 = run2.checkpoint;
    assertEq(checkpoint2.parentId, checkpoint1.id, "checkpoint2.parentId = checkpoint1.id (lineage)");
    assertEq(checkpoint2.comment, "verification pass", "checkpoint2.comment = 'verification pass'");

    save("checkpoint2.json", JSON.stringify(checkpoint2, null, 2));
    log(`  Checkpoint 2: id=${checkpoint2.id}, parentId=${checkpoint2.parentId}`);

    // =========================================================================
    // Phase 3: Explicit checkpoint with kit.checkpoint({ comment })
    // =========================================================================
    log("\n\u2500\u2500 Phase 3: Explicit checkpoint with comment");

    checkpoint3 = await evolve1.checkpoint({ comment: "manual snapshot" });

    assertDefined(checkpoint3.id, "checkpoint3.id is defined");
    assertEq(checkpoint3.comment, "manual snapshot", "checkpoint3.comment = 'manual snapshot'");
    assertEq(checkpoint3.parentId, checkpoint2.id, "checkpoint3.parentId = checkpoint2.id");

    save("checkpoint3.json", JSON.stringify(checkpoint3, null, 2));
    log(`  Checkpoint 3: id=${checkpoint3.id}, parentId=${checkpoint3.parentId}`);

    log("  Killing sandbox...");
    await evolve1.kill();
    log(`  \u2713 Phase 3 complete\n`);

    // =========================================================================
    // Phase 4: listCheckpoints() — standalone (with tag filter for isolation)
    // =========================================================================
    log("\u2500\u2500 Phase 4: listCheckpoints() standalone");

    // Use tag filter to isolate this test's checkpoints from other sessions
    const testTag = checkpoint1.tag;
    log(`  Using tag filter: ${testTag}`);
    const allCheckpoints = await listCheckpoints(storageConfig, { tag: testTag });
    assertTrue(allCheckpoints.length >= 3, `listCheckpoints() returned >= 3 (got ${allCheckpoints.length})`);
    // Newest first — checkpoint3 should be first
    assertEq(allCheckpoints[0].id, checkpoint3.id, "First result is checkpoint3 (newest)");
    assertEq(allCheckpoints[1].id, checkpoint2.id, "Second result is checkpoint2");
    assertEq(allCheckpoints[2].id, checkpoint1.id, "Third result is checkpoint1 (oldest)");

    log(`  \u2713 Phase 4 complete\n`);

    // =========================================================================
    // Phase 5: listCheckpoints() with limit
    // =========================================================================
    log("\u2500\u2500 Phase 5: listCheckpoints() with limit");

    const limited = await listCheckpoints(storageConfig, { limit: 2, tag: testTag });
    assertEq(limited.length, 2, "limit=2 returns 2 entries");
    assertEq(limited[0].id, checkpoint3.id, "Limited: first is newest");

    log(`  \u2713 Phase 5 complete\n`);

    // =========================================================================
    // Phase 6: Evolve.listCheckpoints() — instance method
    // =========================================================================
    log("\u2500\u2500 Phase 6: Evolve.listCheckpoints()");

    const evolve2 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage(storageConfig);

    const instanceList = await evolve2.listCheckpoints({ limit: 1, tag: testTag });
    assertEq(instanceList.length, 1, "Evolve.listCheckpoints({ limit: 1 }) returns 1");
    assertEq(instanceList[0].id, checkpoint3.id, "Instance list returns newest checkpoint");

    log(`  \u2713 Phase 6 complete\n`);

    // =========================================================================
    // Phase 7: from: "latest" — restore most recent checkpoint
    // =========================================================================
    log("\u2500\u2500 Phase 7: from: 'latest' restores most recent");

    const evolve3 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage(storageConfig);

    log(`  Restoring from 'latest' (should resolve to ${checkpoint3.id})...`);
    const run3 = await evolve3.run({
      prompt: "Read the contents of dx-test.txt and tell me what it says.",
      from: "latest",
      timeoutMs: TIMEOUT,
    });
    save("phase7-stdout.txt", run3.stdout);
    save("phase7-stderr.txt", run3.stderr);

    assertEq(run3.exitCode, 0, "run3 exits 0");
    assertDefined(run3.checkpoint, "run3 creates a new checkpoint after restore");
    // parentId should be checkpoint3.id (the one we restored from)
    assertEq(run3.checkpoint.parentId, checkpoint3.id, "run3 checkpoint parentId = checkpoint3.id (restored from latest)");

    log("  Killing sandbox...");
    await evolve3.kill();
    log(`  \u2713 Phase 7 complete\n`);

    // =========================================================================
    // Results
    // =========================================================================
    await cleanupS3Prefix();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log("=".repeat(60));
    log(`PASS - All storage DX v3.3 tests passed (${duration}s)`);
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
