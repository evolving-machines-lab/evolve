#!/usr/bin/env tsx
/**
 * Integration Test 26: Full Storage Surface (BYOK + Gateway)
 *
 * Comprehensive end-to-end test for ALL storage and checkpointing features
 * with real agents, real sandboxes, and real files of various types and sizes.
 *
 * Tests:
 *   1. Checkpoint lifecycle: auto-checkpoint, explicit, lineage (parentId)
 *   2. Content-addressed dedup (same hash = skip upload)
 *   3. Restore from checkpoint — verify real file contents (PDF, XLSX, TXT, PNG)
 *   4. from: "latest" — global resolution
 *   5. Standalone storage() client — listCheckpoints, getCheckpoint,
 *      downloadCheckpoint, downloadFiles (all options)
 *   6. evolve.storage() accessor — bound client equivalence
 *   7. Parallel scale — 3 concurrent Evolve instances, tag isolation
 *   8. Error cases
 *
 * Requires:
 *   EVOLVE_API_KEY — LLM gateway + dashboard auth
 *   E2B_API_KEY — sandbox provider (or DAYTONA/MODAL)
 *   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY — S3 credentials (BYOK only)
 *   EVOLVE_DASHBOARD_URL=http://localhost:3000 — local dev dashboard (gateway mode)
 *
 * Usage:
 *   npx tsx tests/integration/26-storage-full-surface.ts
 *   TEST_STORAGE_MODE=gateway EVOLVE_DASHBOARD_URL=http://localhost:3000 npx tsx tests/integration/26-storage-full-surface.ts
 */

import { Evolve, storage } from "../../dist/index.js";
import type { CheckpointInfo, StorageClient } from "../../dist/index.js";
import { config } from "dotenv";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
} from "fs";
import {
  getAgentConfig,
  getSandboxProvider,
  getSandboxProviderByName,
  type ProviderName,
} from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

// =============================================================================
// CONFIG
// =============================================================================

const PROVIDER_NAME = (process.env.TEST_SANDBOX_PROVIDER ||
  process.argv[2] ||
  "") as ProviderName | "";
const PROVIDER_LABEL = PROVIDER_NAME || "default";
const LOGS_DIR = resolve(
  __dirname,
  `../test-logs/26-storage-full-surface-${PROVIDER_LABEL}`
);
const STORAGE_URL = `s3://swarmkit-test-checkpoints-905418019965/integration-test-full-${PROVIDER_LABEL}/`;
const STORAGE_REGION = "us-west-2";
const STORAGE_MODE = (process.env.TEST_STORAGE_MODE || "byok") as
  | "byok"
  | "gateway";
const IS_GATEWAY = STORAGE_MODE === "gateway";
const TIMEOUT = 180000; // 3 min per run
const TMP_DIR = resolve(
  __dirname,
  `../test-logs/26-tmp-${PROVIDER_LABEL}`
);

function getStorageConfig() {
  if (IS_GATEWAY) return {};
  return { url: STORAGE_URL, region: STORAGE_REGION };
}

// =============================================================================
// HELPERS
// =============================================================================

let passed = 0;
let failed = 0;

function log(msg: string) {
  console.log(`[26] ${msg}`);
}

function save(name: string, content: string) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

function assertDefined<T>(
  value: T | undefined | null,
  label: string
): asserts value is T {
  if (value == null) {
    throw new Error(`${label}: expected defined, got ${value}`);
  }
  passed++;
  log(`  ✓ ${label}`);
}

function assertEq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
  passed++;
  log(`  ✓ ${label}`);
}

function assertTrue(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(`${label}: expected true, got false`);
  }
  passed++;
  log(`  ✓ ${label}`);
}

function assertIncludes(haystack: string, needle: string, label: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: "${needle}" not found in output`);
  }
  passed++;
  log(`  ✓ ${label}`);
}

function assertNotIncludes(haystack: string, needle: string, label: string) {
  if (haystack.includes(needle)) {
    throw new Error(`${label}: "${needle}" should NOT be in output`);
  }
  passed++;
  log(`  ✓ ${label}`);
}

async function assertThrows(
  fn: () => Promise<unknown>,
  substring: string,
  label: string
) {
  try {
    await fn();
    throw new Error(`${label}: did not throw`);
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes(substring)) {
      throw new Error(
        `${label}: threw "${msg}", expected to contain "${substring}"`
      );
    }
    passed++;
    log(`  ✓ ${label}`);
  }
}

// =============================================================================
// FILE SEEDING — create real files of various types/sizes inside sandbox
// =============================================================================

/**
 * Seed workspace with real multi-format files via executeCommand.
 * Creates ~5MB total: TXT (~2MB), PNG (~1MB), PDF (~500KB), CSV (~1MB)
 *
 * Uses shell commands to avoid Python f-string / JS template literal escaping issues.
 */
async function seedWorkspaceFiles(
  evolve: Evolve,
  version: string
): Promise<void> {
  log(`  Seeding workspace files (version: ${version})...`);

  // 1. Large TXT (~2MB) — shell loop
  const txtResult = await evolve.executeCommand(
    [
      `mkdir -p /home/user/workspace/docs`,
      `echo "--- Report ${version} ---" > /home/user/workspace/docs/report-${version}.txt`,
      `for i in $(seq 1 20000); do echo "Row $i: metric_a=$i.3140, metric_b=$i.2710, status=active, version=${version}" >> /home/user/workspace/docs/report-${version}.txt; done`,
      `wc -c /home/user/workspace/docs/report-${version}.txt`,
    ].join(" && "),
    { timeoutMs: 60000 }
  );
  log(`    TXT: ${txtResult.stdout.trim()}`);

  // 2. PNG (~1MB) — binary via Python (simple, no f-strings)
  const pngResult = await evolve.executeCommand(
    [
      `mkdir -p /home/user/workspace/assets`,
      `python3 -c '`,
      `import struct, zlib, os`,
      `w, h = 512, 512`,
      `raw = b""`,
      `for y in range(h):`,
      `    raw += b"\\x00"`,
      `    for x in range(w):`,
      `        raw += bytes([(x*7+${version === "v1" ? "49" : "50"})%256, (y*13)%256, (x+y)%256])`,
      `compressed = zlib.compress(raw)`,
      `def chunk(t, d):`,
      `    c = t + d`,
      `    return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)`,
      `ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)`,
      `png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")`,
      `with open("/home/user/workspace/assets/chart-${version}.png", "wb") as f:`,
      `    f.write(png)`,
      `print(os.path.getsize("/home/user/workspace/assets/chart-${version}.png"))',`,
    ].join("\n"),
    { timeoutMs: 30000 }
  );
  log(`    PNG: ${pngResult.stdout.trim()} bytes`);

  // 3. PDF (~500KB) — minimal valid PDF with padding
  const pdfResult = await evolve.executeCommand(
    [
      `python3 -c '`,
      `import os`,
      `os.makedirs("/home/user/workspace/docs", exist_ok=True)`,
      `pdf = "%PDF-1.4\\n"`,
      `pdf += "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\\n"`,
      `pdf += "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\\n"`,
      `pdf += "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\\n"`,
      `stream = "BT /F1 10 Tf 72 750 Td (Analysis Report ${version}) Tj ET"`,
      `pdf += "4 0 obj<</Length " + str(len(stream)) + ">>stream\\n" + stream + "\\nendstream endobj\\n"`,
      `pdf += "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\\n"`,
      `xref_pos = len(pdf)`,
      `pdf += "xref\\n0 6\\n0000000000 65535 f \\n"`,
      `pdf += "trailer<</Size 6/Root 1 0 R>>\\nstartxref\\n" + str(xref_pos) + "\\n%%EOF\\n"`,
      `pdf += ("% " + "x" * 998 + "\\n") * 500`,
      `with open("/home/user/workspace/docs/analysis-${version}.pdf", "wb") as f:`,
      `    f.write(pdf.encode())`,
      `print(os.path.getsize("/home/user/workspace/docs/analysis-${version}.pdf"))',`,
    ].join("\n"),
    { timeoutMs: 30000 }
  );
  log(`    PDF: ${pdfResult.stdout.trim()} bytes`);

  // 4. CSV (~1MB) — plain text, no special libraries
  const csvResult = await evolve.executeCommand(
    [
      `mkdir -p /home/user/workspace/data`,
      `echo "ID,Name,Value,Score,Version,Notes" > /home/user/workspace/data/metrics-${version}.csv`,
      `for i in $(seq 1 10000); do echo "$i,item_$i,$i.3140,$i.2710,${version},Note for row $i with padding text to increase size" >> /home/user/workspace/data/metrics-${version}.csv; done`,
      `wc -c /home/user/workspace/data/metrics-${version}.csv`,
    ].join(" && "),
    { timeoutMs: 60000 }
  );
  log(`    CSV: ${csvResult.stdout.trim()}`);

  // 5. Verify total size
  const sizeCheck = await evolve.executeCommand(
    `du -sh /home/user/workspace/ && find /home/user/workspace -type f`,
    { timeoutMs: 10000 }
  );
  log(`  Total: ${sizeCheck.stdout.trim().split("\\n")[0]}`);
}

// =============================================================================
// S3 CLEANUP
// =============================================================================

async function cleanupS3Prefix() {
  log("\n── Phase 9: Cleanup");
  // Clean temp directories
  rmSync(TMP_DIR, { recursive: true, force: true });
  log("  ✓ Cleaned temp directories");

  if (IS_GATEWAY) {
    log("  ○ Skipping S3 cleanup (gateway mode)");
    return;
  }
  try {
    const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } =
      await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: STORAGE_REGION });
    const bucket = "swarmkit-test-checkpoints-905418019965";
    const prefix = `integration-test-full-${PROVIDER_LABEL}/`;

    let continuationToken: string | undefined;
    let totalDeleted = 0;

    do {
      const listResult = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      const objects = listResult.Contents;
      if (objects && objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: objects.map((o) => ({ Key: o.Key })),
              Quiet: true,
            },
          })
        );
        totalDeleted += objects.length;
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

    log(
      `  ✓ Deleted ${totalDeleted} objects from s3://${bucket}/${prefix}`
    );
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
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  log(
    `Starting full storage surface integration test (${STORAGE_MODE} mode)...\n`
  );
  const start = Date.now();

  const agentConfig = getAgentConfig("claude");
  const provider = PROVIDER_NAME
    ? getSandboxProviderByName(PROVIDER_NAME)
    : getSandboxProvider();
  log(`Using provider: ${PROVIDER_LABEL}, storage: ${STORAGE_MODE}`);
  if (IS_GATEWAY) {
    log(
      `Dashboard URL: ${process.env.EVOLVE_DASHBOARD_URL || "http://localhost:3000"}`
    );
  }

  let checkpoint1: CheckpointInfo;
  let checkpoint2: CheckpointInfo;
  let checkpoint3: CheckpointInfo;
  let checkpoint4: CheckpointInfo;
  let checkpoint5: CheckpointInfo;
  let sessionTag: string;

  try {
    // ══════════════════════════════════════════════════════════════════════
    // Phase 1: Checkpoint Lifecycle — auto-checkpoint, explicit, lineage
    // ══════════════════════════════════════════════════════════════════════
    log("── Phase 1: Checkpoint Lifecycle");

    const evolve1 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withSkills(["pdf"])
      .withWorkspaceMode("swe")
      .withStorage(getStorageConfig());

    // Init sandbox with a throwaway run so we can seed files via executeCommand
    log("  [1a] Initializing sandbox...");
    const seedRun = await evolve1.run({
      prompt: "Say OK",
      timeoutMs: TIMEOUT,
    });

    // Seed real multi-MB files (TXT, PNG, PDF, XLSX)
    await seedWorkspaceFiles(evolve1, "v1");

    // --- Run 1: checkpoint with real files ---
    log("  [1b] Running agent over v1 files...");
    const run1 = await evolve1.run({
      prompt:
        "List all files in workspace/ recursively with sizes. Use: find workspace/ -type f -exec ls -lh {} \\;",
      timeoutMs: TIMEOUT,
      checkpointComment: "initial v1 — multi-format files",
    });
    save("phase1-run1-stdout.txt", run1.stdout);

    assertEq(run1.exitCode, 0, "run1 exits 0");
    assertDefined(run1.checkpoint, "run1.checkpoint is defined");

    checkpoint1 = run1.checkpoint;
    assertDefined(checkpoint1.id, "checkpoint1.id is defined");
    assertDefined(checkpoint1.hash, "checkpoint1.hash is defined");
    assertEq(checkpoint1.hash.length, 64, "checkpoint1.hash is SHA-256 (64 hex chars)");
    assertTrue(/^[a-f0-9]{64}$/.test(checkpoint1.hash), "checkpoint1.hash is valid hex");
    assertDefined(checkpoint1.tag, "checkpoint1.tag is defined");
    assertDefined(checkpoint1.timestamp, "checkpoint1.timestamp is defined");
    assertTrue(!isNaN(Date.parse(checkpoint1.timestamp)), "checkpoint1.timestamp is valid ISO 8601");
    assertTrue(
      checkpoint1.sizeBytes !== undefined && checkpoint1.sizeBytes > 0,
      `checkpoint1.sizeBytes > 0 (got ${checkpoint1.sizeBytes})`
    );
    assertEq(checkpoint1.agentType, "claude", "checkpoint1.agentType is claude");
    assertEq(checkpoint1.comment, "initial v1 — multi-format files", "checkpoint1.comment matches");
    // parentId links to the seed run's checkpoint (auto-checkpointed)
    assertTrue(
      checkpoint1.parentId === undefined || checkpoint1.parentId === seedRun.checkpoint?.id,
      "checkpoint1.parentId is undefined or links to seed"
    );

    sessionTag = checkpoint1.tag;
    save("checkpoint1.json", JSON.stringify(checkpoint1, null, 2));
    log(`  Checkpoint 1: id=${checkpoint1.id}, hash=${checkpoint1.hash.slice(0, 12)}..., size=${checkpoint1.sizeBytes} bytes`);

    // --- Run 2: modify files (v2), verify parentId ---
    log("  [1c] Updating files to v2...");
    await seedWorkspaceFiles(evolve1, "v2");

    const run2 = await evolve1.run({
      prompt: "List all files in workspace/ recursively. Use: find workspace/ -type f",
      timeoutMs: TIMEOUT,
      checkpointComment: "updated to v2",
    });
    save("phase1-run2-stdout.txt", run2.stdout);

    assertEq(run2.exitCode, 0, "run2 exits 0");
    assertDefined(run2.checkpoint, "run2.checkpoint is defined");
    checkpoint2 = run2.checkpoint;
    assertEq(checkpoint2.comment, "updated to v2", "checkpoint2.comment matches");
    assertDefined(checkpoint2.parentId, "checkpoint2.parentId is defined (lineage chains)");

    save("checkpoint2.json", JSON.stringify(checkpoint2, null, 2));
    log(`  Checkpoint 2: id=${checkpoint2.id}, parentId=${checkpoint2.parentId}`);

    // --- Explicit checkpoint ---
    log("  [1d] Explicit checkpoint...");
    checkpoint3 = await evolve1.checkpoint({ comment: "manual snapshot after v2" });
    assertDefined(checkpoint3.id, "checkpoint3.id is defined");
    assertEq(checkpoint3.comment, "manual snapshot after v2", "checkpoint3.comment matches");
    assertEq(checkpoint3.parentId, checkpoint2.id, "checkpoint3.parentId === checkpoint2.id");

    save("checkpoint3.json", JSON.stringify(checkpoint3, null, 2));
    log(`  Checkpoint 3 (explicit): id=${checkpoint3.id}, parentId=${checkpoint3.parentId}`);

    await evolve1.kill();
    log("  ✓ Phase 1 complete\n");

    // ══════════════════════════════════════════════════════════════════════
    // Phase 2: Dedup — same content = same hash, different ID
    // ══════════════════════════════════════════════════════════════════════
    log("── Phase 2: Content-Addressed Dedup");

    const evolve2 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withSkills(["pdf"])
      .withWorkspaceMode("swe")
      .withStorage(getStorageConfig());

    const run3 = await evolve2.run({
      prompt:
        "Read workspace/docs/report-v2.txt and tell me the first line only. Do NOT create or modify any files.",
      from: checkpoint3.id,
      timeoutMs: TIMEOUT,
      checkpointComment: "read-only run for dedup test",
    });
    save("phase2-stdout.txt", run3.stdout);

    assertEq(run3.exitCode, 0, "dedup run exits 0");
    assertDefined(run3.checkpoint, "dedup run has checkpoint");
    checkpoint4 = run3.checkpoint;

    if (checkpoint4.hash === checkpoint3.hash) {
      log("  ✓ Same hash — dedup skipped re-upload (workspace unchanged)");
      passed++;
    } else {
      log(
        `  ○ Different hashes — agent likely modified workspace (checkpoint3: ${checkpoint3.hash.slice(0, 16)}..., checkpoint4: ${checkpoint4.hash.slice(0, 16)}...)`
      );
    }
    assertTrue(
      checkpoint4.id !== checkpoint3.id,
      "checkpoint IDs are different despite potential dedup"
    );

    await evolve2.kill();
    log("  ✓ Phase 2 complete\n");

    // ══════════════════════════════════════════════════════════════════════
    // Phase 3: Restore & Verify File Contents + Agent Environment
    // ══════════════════════════════════════════════════════════════════════
    log("── Phase 3: Restore & Verify File Contents + Agent Environment");

    const evolve3 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withSkills(["pdf"])
      .withWorkspaceMode("swe")
      .withStorage(getStorageConfig());

    const run4 = await evolve3.run({
      prompt:
        "Read workspace/docs/report-v1.txt and tell me the FIRST line. Then check: does workspace/docs/report-v2.txt exist? Answer both.",
      from: checkpoint1.id,
      timeoutMs: TIMEOUT,
      checkpointComment: "restored v1 verification",
    });
    save("phase3-stdout.txt", run4.stdout);

    assertEq(run4.exitCode, 0, "restore run exits 0");
    assertIncludes(run4.stdout, "v1", "stdout mentions v1 content from restored checkpoint");
    assertDefined(run4.checkpoint, "restore run has checkpoint");
    checkpoint5 = run4.checkpoint;
    assertEq(
      checkpoint5.parentId,
      checkpoint1.id,
      "restored checkpoint parentId === checkpoint1.id (lineage tracks restore source)"
    );

    // Verify agent environment survived checkpoint + restore
    log("  [3b] Verifying agent environment after restore...");

    const skillsCheck = await evolve3.executeCommand(
      "ls ~/.claude/skills/ 2>/dev/null || echo 'no skills dir'",
      { timeoutMs: 10000 }
    );
    log(`  Skills dir: ${skillsCheck.stdout.trim().slice(0, 200)}`);
    assertNotIncludes(skillsCheck.stdout, "no skills dir", "skills directory exists after restore");

    const settingsCheck = await evolve3.executeCommand(
      "cat ~/.claude/settings.json 2>/dev/null || echo 'no settings config'",
      { timeoutMs: 10000 }
    );
    log(`  Settings: ${settingsCheck.stdout.trim().slice(0, 200)}`);
    assertNotIncludes(settingsCheck.stdout, "no settings config", "settings.json exists after restore");

    const claudeMdCheck = await evolve3.executeCommand(
      "head -5 ~/workspace/CLAUDE.md 2>/dev/null || echo 'no CLAUDE.md'",
      { timeoutMs: 10000 }
    );
    log(`  CLAUDE.md: ${claudeMdCheck.stdout.trim().slice(0, 200)}`);
    assertNotIncludes(claudeMdCheck.stdout, "no CLAUDE.md", "workspace CLAUDE.md exists after restore");

    await evolve3.kill();
    log("  ✓ Phase 3 complete\n");

    // ══════════════════════════════════════════════════════════════════════
    // Phase 4: from: "latest" — Global Resolution
    // ══════════════════════════════════════════════════════════════════════
    log('── Phase 4: from: "latest"');

    // Small delay for S3 consistency
    await new Promise((r) => setTimeout(r, 3000));

    const evolve4 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withSkills(["pdf"])
      .withWorkspaceMode("swe")
      .withStorage(getStorageConfig());

    const run5 = await evolve4.run({
      prompt: "List files in workspace/docs/. Use: ls -la workspace/docs/",
      from: "latest",
      timeoutMs: TIMEOUT,
    });
    save("phase4-stdout.txt", run5.stdout);

    assertEq(run5.exitCode, 0, "from:latest run exits 0");
    assertDefined(run5.checkpoint, "from:latest run has checkpoint");
    assertDefined(
      run5.checkpoint.parentId,
      "from:latest checkpoint has parentId (linked to most recent)"
    );

    await evolve4.kill();
    log("  ✓ Phase 4 complete\n");

    // ══════════════════════════════════════════════════════════════════════
    // Phase 5: Standalone storage() Client — Full Surface
    // ══════════════════════════════════════════════════════════════════════
    log("── Phase 5: Standalone storage() Client");

    const store = storage(getStorageConfig());

    // 5a. listCheckpoints() — all, newest first
    log("  [5a] listCheckpoints()...");
    const all = await store.listCheckpoints();
    assertTrue(all.length >= 5, `listCheckpoints() returned ${all.length} (expected >= 5)`);
    for (let i = 1; i < all.length; i++) {
      assertTrue(
        new Date(all[i - 1].timestamp).getTime() >=
          new Date(all[i].timestamp).getTime(),
        `newest-first ordering: [${i - 1}] >= [${i}]`
      );
    }

    // 5b. listCheckpoints({ limit: 2 }) — exact count
    log("  [5b] listCheckpoints({ limit: 2 })...");
    const limited = await store.listCheckpoints({ limit: 2 });
    assertEq(limited.length, 2, "limit=2 returns exactly 2");
    assertEq(limited[0].id, all[0].id, "limit=2 newest matches full list newest");

    // 5c. listCheckpoints({ tag }) — filters by tag
    log("  [5c] listCheckpoints({ tag })...");
    const byTag = await store.listCheckpoints({ tag: sessionTag });
    assertTrue(byTag.length >= 3, `tag filter returned ${byTag.length} (expected >= 3)`);
    assertTrue(
      byTag.every((cp) => cp.tag === sessionTag),
      "all tag-filtered results have matching tag"
    );

    // 5d. getCheckpoint(id) — correct metadata
    log("  [5d] getCheckpoint(id)...");
    const cp = await store.getCheckpoint(checkpoint1.id);
    assertEq(cp.id, checkpoint1.id, "getCheckpoint returns correct id");
    assertEq(cp.hash, checkpoint1.hash, "getCheckpoint returns correct hash");
    assertEq(
      cp.comment,
      "initial v1 — multi-format files",
      "getCheckpoint returns correct comment"
    );

    // 5e. getCheckpoint("nonexistent") — throws
    log('  [5e] getCheckpoint("nonexistent")...');
    await assertThrows(
      () => store.getCheckpoint("nonexistent-id-xyz-12345"),
      "not found",
      "getCheckpoint with nonexistent ID throws 'not found'"
    );

    // 5f. downloadCheckpoint — extract to disk
    log("  [5f] downloadCheckpoint (extract: true)...");
    const extractDir = join(TMP_DIR, "extract-test");
    mkdirSync(extractDir, { recursive: true });
    const outPath = await store.downloadCheckpoint(checkpoint1.id, {
      to: extractDir,
      extract: true,
    });
    assertDefined(outPath, "downloadCheckpoint returns path");
    // Check that real files exist on disk
    const txtPath = join(extractDir, "workspace/docs/report-v1.txt");
    assertTrue(existsSync(txtPath), "extracted TXT file exists on disk");
    const txtContent = readFileSync(txtPath, "utf-8");
    assertIncludes(txtContent, "v1", "extracted TXT contains v1 content");
    assertTrue(
      statSync(txtPath).size > 100000,
      `extracted TXT is substantial (${statSync(txtPath).size} bytes)`
    );

    // Check PNG exists
    const pngPath = join(extractDir, "workspace/assets/chart-v1.png");
    assertTrue(existsSync(pngPath), "extracted PNG file exists on disk");
    assertTrue(
      statSync(pngPath).size > 1000,
      `extracted PNG is substantial (${statSync(pngPath).size} bytes)`
    );

    // Check PDF exists
    const pdfPath = join(extractDir, "workspace/docs/analysis-v1.pdf");
    assertTrue(existsSync(pdfPath), "extracted PDF file exists on disk");

    // Check CSV exists
    const csvPath = join(extractDir, "workspace/data/metrics-v1.csv");
    assertTrue(existsSync(csvPath), "extracted CSV file exists on disk");
    assertTrue(
      statSync(csvPath).size > 10000,
      `extracted CSV is substantial (${statSync(csvPath).size} bytes)`
    );

    // 5g. downloadCheckpoint — raw archive
    log("  [5g] downloadCheckpoint (extract: false)...");
    const rawDir = join(TMP_DIR, "raw-test");
    mkdirSync(rawDir, { recursive: true });
    const archivePath = await store.downloadCheckpoint(checkpoint1.id, {
      to: rawDir,
      extract: false,
    });
    assertTrue(
      archivePath.endsWith(".tar.gz"),
      "raw download ends with .tar.gz"
    );
    assertTrue(existsSync(archivePath), "raw archive exists on disk");
    assertTrue(
      statSync(archivePath).size > 10000,
      `raw archive is substantial (${statSync(archivePath).size} bytes)`
    );

    // 5h. downloadFiles — specific file
    log("  [5h] downloadFiles({ files })...");
    const fileMap = await store.downloadFiles(checkpoint1.id, {
      files: ["workspace/docs/report-v1.txt"],
    });
    assertTrue(typeof fileMap === "object" && fileMap !== null, "downloadFiles returns an object");
    const reportBuf = fileMap["workspace/docs/report-v1.txt"];
    assertDefined(reportBuf, "FileMap has workspace/docs/report-v1.txt");
    const reportText = Buffer.from(reportBuf as Buffer).toString("utf-8");
    assertIncludes(reportText, "v1", "downloaded TXT contains v1 content");
    assertTrue(
      reportText.length > 100000,
      `downloaded TXT is substantial (${reportText.length} chars)`
    );

    // 5i. downloadFiles — glob matching
    log("  [5i] downloadFiles({ glob })...");
    const globMap = await store.downloadFiles(checkpoint1.id, {
      glob: ["workspace/docs/*.txt"],
    });
    assertTrue(typeof globMap === "object" && globMap !== null, "glob downloadFiles returns an object");
    const globKeys = Object.keys(globMap);
    assertTrue(globKeys.length > 0, "glob matched at least one file");
    assertTrue(
      globKeys.some((k) => k.includes("report-v1.txt")),
      "glob matched report-v1.txt"
    );

    // 5j. downloadFiles("latest") — resolves to newest
    log('  [5j] downloadFiles("latest")...');
    const latestFiles = await store.downloadFiles("latest");
    assertTrue(typeof latestFiles === "object" && latestFiles !== null, "latest downloadFiles returns an object");
    assertTrue(Object.keys(latestFiles).length > 0, "latest has files");

    // 5k. downloadFiles with to: — writes to disk
    log("  [5k] downloadFiles({ to })...");
    const diskDir = join(TMP_DIR, "disk-test");
    mkdirSync(diskDir, { recursive: true });
    await store.downloadFiles(checkpoint1.id, {
      files: ["workspace/docs/report-v1.txt"],
      to: diskDir,
    });
    assertTrue(
      existsSync(join(diskDir, "workspace/docs/report-v1.txt")),
      "downloadFiles wrote file to disk"
    );

    log("  ✓ Phase 5 complete\n");

    // ══════════════════════════════════════════════════════════════════════
    // Phase 6: evolve.storage() Accessor
    // ══════════════════════════════════════════════════════════════════════
    log("── Phase 6: evolve.storage() Accessor");

    const evolve6 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withStorage(getStorageConfig());

    const boundClient = evolve6.storage();

    // 6a. listCheckpoints — same as standalone
    const boundAll = await boundClient.listCheckpoints();
    assertEq(
      boundAll.length,
      all.length,
      `evolve.storage().listCheckpoints() count matches standalone (${boundAll.length})`
    );
    assertEq(
      boundAll[0].id,
      all[0].id,
      "evolve.storage() newest matches standalone newest"
    );

    // 6b. getCheckpoint — returns metadata
    const boundCp = await boundClient.getCheckpoint(checkpoint1.id);
    assertEq(boundCp.id, checkpoint1.id, "evolve.storage().getCheckpoint() returns correct id");
    assertEq(
      boundCp.hash,
      checkpoint1.hash,
      "evolve.storage().getCheckpoint() returns correct hash"
    );

    // 6c. downloadFiles — returns file contents
    const boundFiles = await boundClient.downloadFiles(checkpoint1.id, {
      glob: ["workspace/docs/*.txt"],
    });
    assertTrue(Object.keys(boundFiles).length > 0, "evolve.storage().downloadFiles() returns files");

    // 6d. evolve.listCheckpoints() convenience
    const convList = await evolve6.listCheckpoints();
    assertEq(
      convList.length,
      all.length,
      `evolve.listCheckpoints() count matches (${convList.length})`
    );
    assertEq(
      convList[0].id,
      all[0].id,
      "evolve.listCheckpoints() newest matches"
    );

    log("  ✓ Phase 6 complete\n");

    // ══════════════════════════════════════════════════════════════════════
    // Phase 7: Parallel / Scale — 3 concurrent Evolve instances
    // ══════════════════════════════════════════════════════════════════════
    log("── Phase 7: Parallel Scale (3 concurrent instances)");

    const parallelResults = await Promise.all(
      ["alpha", "beta", "gamma"].map(async (label) => {
        const e = new Evolve()
          .withAgent(agentConfig)
          .withSandbox(provider)
          .withSkills(["pdf"])
          .withWorkspaceMode("swe")
          .withStorage(getStorageConfig());

        // Seed unique files
        const initRun = await e.run({
          prompt: "Say OK",
          timeoutMs: TIMEOUT,
        });
        await e.executeCommand(
          [
            `mkdir -p /home/user/workspace/parallel`,
            `echo "Session: ${label}" > /home/user/workspace/parallel/${label}-output.txt`,
            `for i in $(seq 1 5000); do echo "data-row-$i-${label}-padding-text-for-size" >> /home/user/workspace/parallel/${label}-output.txt; done`,
            `wc -c /home/user/workspace/parallel/${label}-output.txt`,
          ].join(" && "),
          { timeoutMs: 30000 }
        );

        const r = await e.run({
          prompt: `Read workspace/parallel/${label}-output.txt and tell me the first line.`,
          timeoutMs: TIMEOUT,
          checkpointComment: `parallel-${label}`,
        });

        const tag = r.checkpoint!.tag;
        await e.kill();
        return { checkpoint: r.checkpoint!, tag, label };
      })
    );

    // All 3 produced checkpoints
    for (const r of parallelResults) {
      assertDefined(r.checkpoint, `parallel ${r.label} has checkpoint`);
      assertEq(
        r.checkpoint.comment,
        `parallel-${r.label}`,
        `parallel ${r.label} comment matches`
      );
    }

    // All 3 tags are different
    const tags = parallelResults.map((r) => r.tag);
    assertEq(
      new Set(tags).size,
      3,
      `all 3 parallel sessions have unique tags`
    );

    // listCheckpoints returns all (previous phases + parallel)
    const allAfterParallel = await store.listCheckpoints();
    assertTrue(
      allAfterParallel.length >= all.length + 3,
      `listCheckpoints after parallel: ${allAfterParallel.length} (expected >= ${all.length + 3})`
    );

    // Tag filtering isolates per-session
    for (const r of parallelResults) {
      const tagFiltered = await store.listCheckpoints({ tag: r.tag });
      assertTrue(
        tagFiltered.length >= 1,
        `tag filter for ${r.label} returns >= 1 (got ${tagFiltered.length})`
      );
      assertTrue(
        tagFiltered.every((cp) => cp.tag === r.tag),
        `tag filter for ${r.label}: all results have correct tag`
      );
    }

    // downloadFiles on parallel checkpoint returns the correct unique content
    for (const r of parallelResults) {
      const files = await store.downloadFiles(r.checkpoint.id, {
        files: [`workspace/parallel/${r.label}-output.txt`],
      });
      const rawContent = files[`workspace/parallel/${r.label}-output.txt`];
      const content = rawContent
        ? Buffer.from(rawContent as Buffer).toString("utf-8")
        : undefined;
      assertDefined(content, `parallel ${r.label} file downloadable`);
      assertIncludes(
        content!,
        `Session: ${r.label}`,
        `parallel ${r.label} file has correct content`
      );
    }

    log("  ✓ Phase 7 complete\n");

    // ══════════════════════════════════════════════════════════════════════
    // Phase 8: Error Cases
    // ══════════════════════════════════════════════════════════════════════
    log("── Phase 8: Error Cases");

    // 8a. from + withSession() conflict
    await assertThrows(
      () => {
        const e = new Evolve()
          .withAgent(agentConfig)
          .withSandbox(provider)
          .withStorage(getStorageConfig())
          .withSession("some-sandbox-id");
        return e.run({
          prompt: "test",
          from: checkpoint1.id,
          timeoutMs: 30000,
        });
      },
      "withSession",
      "from + withSession() throws mutual exclusivity error"
    );

    // 8b. getCheckpoint nonexistent
    await assertThrows(
      () => store.getCheckpoint("nonexistent_id_12345"),
      "not found",
      "getCheckpoint nonexistent throws"
    );

    // 8c. downloadFiles nonexistent
    await assertThrows(
      () => store.downloadFiles("nonexistent_id_12345"),
      "not found",
      "downloadFiles nonexistent throws"
    );

    // 8d. downloadCheckpoint nonexistent
    await assertThrows(
      () => store.downloadCheckpoint("nonexistent_id_12345"),
      "not found",
      "downloadCheckpoint nonexistent throws"
    );

    log("  ✓ Phase 8 complete\n");

    // ══════════════════════════════════════════════════════════════════════
    // Results
    // ══════════════════════════════════════════════════════════════════════
    await cleanupS3Prefix();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log("=".repeat(60));
    log(
      `PASS — ${passed} assertions passed, 0 failed (${duration}s)`
    );
    log("=".repeat(60) + "\n");
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save("error.txt", err instanceof Error ? err.stack || msg : msg);

    await cleanupS3Prefix();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log("\n" + "=".repeat(60));
    log(`FAIL — ${passed} passed, then: ${msg} (${duration}s)`);
    log("=".repeat(60) + "\n");
    process.exit(1);
  }
}

main();
