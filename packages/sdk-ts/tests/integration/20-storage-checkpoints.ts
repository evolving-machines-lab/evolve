#!/usr/bin/env tsx
/**
 * Integration Test 20: Storage Checkpoints (BYOK)
 *
 * End-to-end test for checkpoint create, restore, dedup, and error cases
 * against a real S3 bucket. Tests the full lifecycle:
 *   1. Run agent → auto-checkpoint → verify checkpoint in response
 *   2. Kill sandbox → restore from checkpoint → verify agent resumes
 *   3. Dedup: compare hashes between checkpoints
 *   4. Error cases: nonexistent ID, from + withSession() conflict
 *   5. Cleanup: delete all test objects from S3
 *
 * Requires:
 *   EVOLVE_API_KEY — LLM gateway
 *   E2B_API_KEY — sandbox provider
 *   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY — S3 credentials (via default chain)
 *
 * Usage:
 *   npm run test:20
 *   npx tsx tests/integration/20-storage-checkpoints.ts
 */

import { Evolve } from "../../dist/index.js";
import type { CheckpointInfo } from "../../dist/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { getAgentConfig, getSandboxProvider } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

// =============================================================================
// CONFIG
// =============================================================================

const LOGS_DIR = resolve(__dirname, "../test-logs/20-storage-checkpoints");
const STORAGE_URL = "s3://swarmkit-test-checkpoints-905418019965/integration-test/";
const STORAGE_REGION = "us-west-2";
const TIMEOUT = 180000; // 3 min per run

// =============================================================================
// HELPERS
// =============================================================================

function log(msg: string) {
  console.log(`[20] ${msg}`);
}

function save(name: string, content: string) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

function assertDefined<T>(value: T | undefined | null, label: string): asserts value is T {
  if (value == null) {
    throw new Error(`${label}: expected defined, got ${value}`);
  }
  log(`  ✓ ${label}`);
}

function assertEq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  log(`  ✓ ${label}`);
}

function assertIncludes(haystack: string, needle: string, label: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: "${needle}" not found in output`);
  }
  log(`  ✓ ${label}`);
}

async function assertThrows(fn: () => Promise<unknown>, substring: string, label: string) {
  try {
    await fn();
    throw new Error(`${label}: did not throw`);
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes(substring)) {
      throw new Error(`${label}: threw "${msg}", expected to contain "${substring}"`);
    }
    log(`  ✓ ${label}`);
  }
}

// =============================================================================
// S3 CLEANUP (dynamic import — uses same optional peer deps as SDK)
// =============================================================================

async function cleanupS3Prefix() {
  log("\n── Phase 5: Cleanup S3 test objects");
  try {
    const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: STORAGE_REGION });
    const bucket = "swarmkit-test-checkpoints-905418019965";
    const prefix = "integration-test/";

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

    log(`  ✓ Deleted ${totalDeleted} objects from s3://${bucket}/${prefix}`);
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

  log("Starting storage checkpoint integration test...\n");
  const start = Date.now();

  const agentConfig = getAgentConfig("claude");
  const provider = getSandboxProvider();

  let checkpoint1: CheckpointInfo | undefined;
  let checkpoint2: CheckpointInfo | undefined;

  try {
    // ── Phase 1: Create checkpoint ─────────────────────────────────────
    log("── Phase 1: Create checkpoint");

    const evolve1 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage({ url: STORAGE_URL, region: STORAGE_REGION });

    log("  Running prompt...");
    const run1 = await evolve1.run({
      prompt: "Create a file called hello.txt with the content 'Hello from checkpoint test'",
      timeoutMs: TIMEOUT,
    });
    save("phase1-stdout.txt", run1.stdout);
    save("phase1-stderr.txt", run1.stderr);

    assertEq(run1.exitCode, 0, "run1 exits 0");
    assertDefined(run1.checkpoint, "run1.checkpoint is defined");

    checkpoint1 = run1.checkpoint;
    assertDefined(checkpoint1.id, "checkpoint1.id is defined");
    assertDefined(checkpoint1.hash, "checkpoint1.hash is defined");
    assertDefined(checkpoint1.tag, "checkpoint1.tag is defined");
    assertDefined(checkpoint1.timestamp, "checkpoint1.timestamp is defined");
    assertEq(checkpoint1.hash.length, 64, "checkpoint1.hash is SHA-256 (64 chars)");
    assertEq(checkpoint1.agentType, "claude", "checkpoint1.agentType is claude");

    save("checkpoint1.json", JSON.stringify(checkpoint1, null, 2));
    log(`  Checkpoint: id=${checkpoint1.id}, hash=${checkpoint1.hash.slice(0, 12)}...`);

    log("  Killing sandbox...");
    await evolve1.kill();
    log(`  ✓ Phase 1 complete\n`);

    // ── Phase 2: Restore from checkpoint ───────────────────────────────
    log("── Phase 2: Restore from checkpoint");

    const evolve2 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage({ url: STORAGE_URL, region: STORAGE_REGION });

    log(`  Restoring from checkpoint ${checkpoint1.id}...`);
    const run2 = await evolve2.run({
      prompt: "Read the contents of hello.txt and tell me what it says. Quote the exact contents.",
      from: checkpoint1.id,
      timeoutMs: TIMEOUT,
    });
    save("phase2-stdout.txt", run2.stdout);
    save("phase2-stderr.txt", run2.stderr);

    assertEq(run2.exitCode, 0, "run2 exits 0");
    assertIncludes(run2.stdout, "Hello from checkpoint test", "stdout contains restored file content");
    assertDefined(run2.checkpoint, "run2.checkpoint is defined (second checkpoint created)");

    checkpoint2 = run2.checkpoint;
    save("checkpoint2.json", JSON.stringify(checkpoint2, null, 2));
    log(`  Checkpoint 2: id=${checkpoint2.id}, hash=${checkpoint2.hash.slice(0, 12)}...`);

    log("  Killing sandbox...");
    await evolve2.kill();
    log(`  ✓ Phase 2 complete\n`);

    // ── Phase 3: Dedup verification ────────────────────────────────────
    log("── Phase 3: Dedup verification");

    if (checkpoint1.hash === checkpoint2.hash) {
      log(`  ✓ Same hash — dedup skipped re-upload (workspace unchanged)`);
    } else {
      log(`  ○ Different hashes (agent modified workspace between runs)`);
      log(`    checkpoint1: ${checkpoint1.hash.slice(0, 16)}...`);
      log(`    checkpoint2: ${checkpoint2.hash.slice(0, 16)}...`);
    }
    log(`  ✓ Phase 3 complete\n`);

    // ── Phase 4: Error cases ───────────────────────────────────────────
    log("── Phase 4: Error cases");

    // 4a. Nonexistent checkpoint ID
    const evolve3 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage({ url: STORAGE_URL, region: STORAGE_REGION });

    await assertThrows(
      () => evolve3.run({ prompt: "test", from: "nonexistent-id-12345", timeoutMs: 30000 }),
      "not found",
      "from with nonexistent ID throws 'not found'"
    );
    await evolve3.kill().catch(() => {});

    // 4b. from + withSession() mutual exclusivity
    await assertThrows(
      () => {
        const e = new Evolve()
          .withAgent(agentConfig)
          .withSandbox(provider)
          .withStorage({ url: STORAGE_URL, region: STORAGE_REGION })
          .withSession("some-sandbox-id");
        return e.run({ prompt: "test", from: checkpoint1.id, timeoutMs: 30000 });
      },
      "withSession",
      "from + withSession() throws mutual exclusivity error"
    );

    log(`  ✓ Phase 4 complete\n`);

    // ── Results ────────────────────────────────────────────────────────
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    await cleanupS3Prefix();

    log("=".repeat(60));
    log(`PASS - All storage checkpoint tests passed (${duration}s)`);
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
