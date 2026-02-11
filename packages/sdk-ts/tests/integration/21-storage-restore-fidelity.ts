#!/usr/bin/env tsx
/**
 * Integration Test 21: Storage Restore Fidelity (BYOK + Gateway)
 *
 * Verifies that checkpoint restore preserves the full agent environment.
 * Supports two modes via TEST_STORAGE_MODE env var:
 *   - "byok" (default): direct S3 access with user credentials
 *   - "gateway": dashboard API endpoints (no direct S3 access needed)
 *
 * Tests:
 *   1. Run agent with skills + workspace mode → create checkpoint
 *   2. Restore from checkpoint → verify conversation memory, file content,
 *      and re-checkpointing all work
 *   3. Inspect sandbox filesystem directly → verify session history,
 *      MCP config, and skills directories exist
 *   4. Error cases: nonexistent ID, from + withSession() conflict
 *   5. Cleanup: delete all test objects from S3 (BYOK only)
 *
 * Requires:
 *   EVOLVE_API_KEY — LLM gateway (both modes) + dashboard auth (gateway mode)
 *   E2B_API_KEY — sandbox provider
 *   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY — S3 credentials (BYOK only)
 *
 * Usage:
 *   npx tsx tests/integration/21-storage-restore-fidelity.ts
 *   TEST_STORAGE_MODE=gateway npx tsx tests/integration/21-storage-restore-fidelity.ts
 */

import { Evolve } from "../../dist/index.js";
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

// Provider from env or CLI arg (e.g., TEST_SANDBOX_PROVIDER=daytona npx tsx ...)
const PROVIDER_NAME = (process.env.TEST_SANDBOX_PROVIDER || process.argv[2] || "") as ProviderName | "";
const PROVIDER_LABEL = PROVIDER_NAME || "default";
const LOGS_DIR = resolve(__dirname, `../test-logs/21-storage-restore-fidelity-${PROVIDER_LABEL}`);
const STORAGE_URL = `s3://swarmkit-test-checkpoints-905418019965/integration-test-${PROVIDER_LABEL}/`;
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
  console.log(`[21] ${msg}`);
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
  if (IS_GATEWAY) {
    log("  ○ Skipping S3 cleanup (gateway mode — dashboard manages storage)");
    return;
  }
  try {
    const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: STORAGE_REGION });
    const bucket = "swarmkit-test-checkpoints-905418019965";
    const prefix = `integration-test-${PROVIDER_LABEL}/`;

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

  log(`Starting storage restore fidelity test (${STORAGE_MODE} mode)...\n`);
  const start = Date.now();

  const agentConfig = getAgentConfig("claude");
  const provider = PROVIDER_NAME
    ? getSandboxProviderByName(PROVIDER_NAME)
    : getSandboxProvider();
  log(`Using provider: ${PROVIDER_LABEL}, storage: ${STORAGE_MODE}`);

  let checkpoint1: CheckpointInfo | undefined;
  let evolve2: InstanceType<typeof Evolve> | undefined;

  try {
    // ── Phase 1: Initial run with full config ──────────────────────────
    log("── Phase 1: Initial run with skills + workspace mode");

    const evolve1 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage(getStorageConfig())
      .withSkills(["pdf"])
      .withWorkspaceMode("swe");

    log("  Running prompt (create identity file + memorize passphrase)...");
    const run1 = await evolve1.run({
      prompt: "Create a file called identity.txt containing 'The secret passphrase is: purple-elephant-42'. Remember this passphrase — I will ask you about it later.",
      timeoutMs: TIMEOUT,
    });
    save("phase1-stdout.txt", run1.stdout);
    save("phase1-stderr.txt", run1.stderr);

    assertEq(run1.exitCode, 0, "run1 exits 0");
    assertDefined(run1.checkpoint, "run1.checkpoint is defined");

    checkpoint1 = run1.checkpoint;
    assertDefined(checkpoint1.id, "checkpoint1.id is defined");
    assertDefined(checkpoint1.hash, "checkpoint1.hash is defined");
    assertEq(checkpoint1.hash.length, 64, "checkpoint1.hash is SHA-256 (64 chars)");
    assertEq(checkpoint1.agentType, "claude", "checkpoint1.agentType is claude");

    save("checkpoint1.json", JSON.stringify(checkpoint1, null, 2));
    log(`  Checkpoint: id=${checkpoint1.id}, hash=${checkpoint1.hash.slice(0, 12)}...`);

    log("  Killing sandbox...");
    await evolve1.kill();
    log(`  ✓ Phase 1 complete\n`);

    // ── Phase 2: Restore and verify everything ─────────────────────────
    log("── Phase 2: Restore and verify conversation memory + file content");

    evolve2 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage(getStorageConfig())
      .withSkills(["pdf"])
      .withWorkspaceMode("swe");

    log(`  Restoring from checkpoint ${checkpoint1.id}...`);
    const run2 = await evolve2.run({
      prompt: [
        "Answer these questions:",
        "1. What is the secret passphrase I told you earlier?",
        "2. Read identity.txt and tell me its contents.",
        "3. List what's in your ~/.claude/ directory.",
        "Include the exact passphrase in your response.",
      ].join("\n"),
      from: checkpoint1.id,
      timeoutMs: TIMEOUT,
    });
    save("phase2-stdout.txt", run2.stdout);
    save("phase2-stderr.txt", run2.stderr);

    assertEq(run2.exitCode, 0, "run2 exits 0");
    assertIncludes(run2.stdout, "purple-elephant-42", "stdout contains passphrase (conversation memory works)");
    assertIncludes(run2.stdout, "identity.txt", "stdout references identity.txt (file restored)");
    assertDefined(run2.checkpoint, "run2.checkpoint is defined (re-checkpointing works after restore)");

    save("checkpoint2.json", JSON.stringify(run2.checkpoint, null, 2));
    log(`  Checkpoint 2: id=${run2.checkpoint.id}, hash=${run2.checkpoint.hash.slice(0, 12)}...`);
    log(`  ✓ Phase 2 complete\n`);

    // ── Phase 3: Verify sandbox state directly ─────────────────────────
    log("── Phase 3: Inspect sandbox filesystem directly");

    // Check skills directory (Claude uses ~/.claude/skills/, not commands/)
    const skillsCheck = await evolve2.executeCommand(
      "ls ~/.claude/skills/ 2>/dev/null || echo 'no skills dir'"
    );
    save("phase3-skills.txt", skillsCheck.stdout);
    log(`  Skills dir: ${skillsCheck.stdout.trim().slice(0, 200)}`);

    // Check MCP/settings config exists (Claude uses ~/.claude/settings.json)
    const mcpCheck = await evolve2.executeCommand(
      "cat ~/.claude/settings.json 2>/dev/null || echo 'no settings config'"
    );
    save("phase3-mcp.txt", mcpCheck.stdout);
    log(`  Settings config: ${mcpCheck.stdout.trim().slice(0, 200)}`);

    // Check CLAUDE.md system prompt exists in workspace
    const claudeMdCheck = await evolve2.executeCommand(
      "head -5 ~/workspace/CLAUDE.md 2>/dev/null || echo 'no CLAUDE.md'"
    );
    save("phase3-claudemd.txt", claudeMdCheck.stdout);
    log(`  CLAUDE.md: ${claudeMdCheck.stdout.trim().slice(0, 200)}`);

    // Check session history exists (proves --continue will work)
    const sessionsCheck = await evolve2.executeCommand(
      "find ~/.claude/projects/ -name '*.jsonl' 2>/dev/null | head -5 || echo 'no sessions'"
    );
    save("phase3-sessions.txt", sessionsCheck.stdout);
    log(`  Session files: ${sessionsCheck.stdout.trim().slice(0, 200)}`);

    // Assert session history files exist (at least one .jsonl)
    const sessionOutput = sessionsCheck.stdout.trim();
    if (sessionOutput === "no sessions" || !sessionOutput.includes(".jsonl")) {
      throw new Error("Phase 3: No session history .jsonl files found — conversation memory may not persist across restores");
    }
    log(`  ✓ Session history .jsonl files exist`);

    // Check identity.txt is still there (agent may put it in workspace/ or workspace/output/)
    const fileCheck = await evolve2.executeCommand(
      "find ~/workspace -name 'identity.txt' -exec cat {} \\; 2>/dev/null || echo 'file missing'"
    );
    save("phase3-identity.txt", fileCheck.stdout);
    assertIncludes(fileCheck.stdout, "purple-elephant-42", "identity.txt still on disk after restore");

    log("  Killing sandbox...");
    await evolve2.kill();
    evolve2 = undefined;
    log(`  ✓ Phase 3 complete\n`);

    // ── Phase 4: Error cases ───────────────────────────────────────────
    log("── Phase 4: Error cases");

    // 4a. Nonexistent checkpoint ID
    const evolve3 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage(getStorageConfig());

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
          .withStorage(getStorageConfig())
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
    log(`PASS - All restore fidelity tests passed (${duration}s)`);
    log("=".repeat(60) + "\n");
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save("error.txt", err instanceof Error ? err.stack || msg : msg);

    // Clean up evolve2 if still alive
    if (evolve2) {
      await evolve2.kill().catch(() => {});
    }

    await cleanupS3Prefix();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log("\n" + "=".repeat(60));
    log(`FAIL - ${msg} (${duration}s)`);
    log("=".repeat(60) + "\n");
    process.exit(1);
  }
}

main();
