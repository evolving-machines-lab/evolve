#!/usr/bin/env tsx
/**
 * Unit Test: Storage Client (standalone checkpoint access)
 *
 * Tests the storage() factory function and all StorageClient methods:
 * listCheckpoints, getCheckpoint, getLatestCheckpoint, downloadCheckpoint, downloadFiles.
 *
 * Uses mock AWS SDK and mock fetch to test both BYOK and Gateway modes
 * without real S3/network calls.
 *
 * Usage:
 *   npm run test:unit:storage-client
 *   npx tsx tests/unit/storage-client.test.ts
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  storage,
  _testSetAwsSdk,
} from "../../src/storage/index.ts";

// =============================================================================
// TEST HELPERS
// =============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

async function assertThrows(fn: () => unknown, substring: string, message: string): Promise<void> {
  try {
    await fn();
    failed++;
    console.log(`  \u2717 ${message} (did not throw)`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(substring)) {
      passed++;
      console.log(`  \u2713 ${message}`);
    } else {
      failed++;
      console.log(`  \u2717 ${message} (threw "${msg}", expected to contain "${substring}")`);
    }
  }
}

// =============================================================================
// MOCK DATA
// =============================================================================

const HASH_64 = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

const MOCK_CHECKPOINT = {
  id: "ckpt_test_001",
  hash: "", // Set dynamically from mock archive
  tag: "test-session",
  timestamp: "2026-01-15T10:00:00.000Z",
  sizeBytes: 1024,
  agentType: "claude",
  model: "claude-sonnet-4-20250514",
  workspaceMode: "knowledge",
};

const MOCK_CHECKPOINT_2 = {
  id: "ckpt_test_002",
  hash: "",
  tag: "poker-agent",
  timestamp: "2026-01-16T10:00:00.000Z",
  sizeBytes: 2048,
  agentType: "claude",
  model: "claude-sonnet-4-20250514",
  workspaceMode: "knowledge",
};

// =============================================================================
// MOCK ARCHIVE — create a real tar.gz with known files
// =============================================================================

let mockArchivePath: string;
let mockArchiveBuffer: Buffer;
let mockArchiveHash: string;

async function createMockArchive(): Promise<void> {
  // Create a temp directory with known files
  const archiveRoot = join(tmpdir(), `evolve-test-archive-${Date.now()}`);
  const wsDir = join(archiveRoot, "workspace", "output");
  const ctxDir = join(archiveRoot, "workspace", "context");
  const agentDir = join(archiveRoot, ".claude");

  await mkdir(wsDir, { recursive: true });
  await mkdir(ctxDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  // Write test files
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(wsDir, "result.json"), JSON.stringify({ answer: 42 }));
  await writeFile(join(wsDir, "summary.txt"), "Test summary content");
  await writeFile(join(ctxDir, "input.txt"), "Test input");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ model: "claude" }));

  // Create tar.gz
  mockArchivePath = join(tmpdir(), `evolve-test-archive-${Date.now()}.tar.gz`);
  execSync(
    `tar -czf "${mockArchivePath}" -C "${archiveRoot}" workspace/ .claude/`,
    { stdio: "pipe" }
  );

  // Read and hash
  mockArchiveBuffer = await readFile(mockArchivePath);
  mockArchiveHash = createHash("sha256").update(mockArchiveBuffer).digest("hex");

  // Set hash on mock checkpoints
  MOCK_CHECKPOINT.hash = mockArchiveHash;
  MOCK_CHECKPOINT_2.hash = mockArchiveHash;

  // Cleanup source dir
  await rm(archiveRoot, { recursive: true, force: true });
}

async function createSymlinkArchive(): Promise<{ path: string; buffer: Buffer; hash: string }> {
  const archiveRoot = join(tmpdir(), `evolve-test-symlink-${Date.now()}`);
  const wsDir = join(archiveRoot, "workspace", "output");
  await mkdir(wsDir, { recursive: true });

  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(wsDir, "safe.txt"), "safe");
  execSync(`ln -sf /etc/passwd "${join(wsDir, "link-outside")}"`, { stdio: "pipe" });

  const archivePath = join(tmpdir(), `evolve-test-symlink-${Date.now()}.tar.gz`);
  execSync(
    `tar -czf "${archivePath}" -C "${archiveRoot}" workspace/`,
    { stdio: "pipe" }
  );

  const buffer = await readFile(archivePath);
  const hash = createHash("sha256").update(buffer).digest("hex");

  await rm(archiveRoot, { recursive: true, force: true });
  return { path: archivePath, buffer, hash };
}

async function createTraversalArchive(): Promise<{ path: string; buffer: Buffer; hash: string }> {
  const archiveRoot = join(tmpdir(), `evolve-test-traversal-${Date.now()}`);
  await mkdir(archiveRoot, { recursive: true });

  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(archiveRoot, "a.txt"), "evil");

  const archivePath = join(tmpdir(), `evolve-test-traversal-${Date.now()}.tar.gz`);
  try {
    // bsdtar (macOS)
    execSync(
      `tar -czf "${archivePath}" -C "${archiveRoot}" -s '#a.txt#../evil.txt#' a.txt`,
      { stdio: "pipe" }
    );
  } catch {
    // GNU tar (Linux)
    execSync(
      `tar -czf "${archivePath}" -C "${archiveRoot}" --transform='s#^a.txt$#../evil.txt#' a.txt`,
      { stdio: "pipe" }
    );
  }

  const buffer = await readFile(archivePath);
  const hash = createHash("sha256").update(buffer).digest("hex");

  await rm(archiveRoot, { recursive: true, force: true });
  return { path: archivePath, buffer, hash };
}

async function createFifoArchive(): Promise<{ path: string; buffer: Buffer; hash: string }> {
  const archiveRoot = join(tmpdir(), `evolve-test-fifo-${Date.now()}`);
  const wsDir = join(archiveRoot, "workspace", "output");
  await mkdir(wsDir, { recursive: true });

  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(wsDir, "safe.txt"), "safe");
  execSync(`mkfifo "${join(wsDir, "named-pipe")}"`, { stdio: "pipe" });

  const archivePath = join(tmpdir(), `evolve-test-fifo-${Date.now()}.tar.gz`);
  execSync(
    `tar -czf "${archivePath}" -C "${archiveRoot}" workspace/`,
    { stdio: "pipe" }
  );

  const buffer = await readFile(archivePath);
  const hash = createHash("sha256").update(buffer).digest("hex");

  await rm(archiveRoot, { recursive: true, force: true });
  return { path: archivePath, buffer, hash };
}

// =============================================================================
// MOCK AWS SDK (for BYOK tests)
// =============================================================================

function createMockAwsSdk(checkpoints: Record<string, unknown>) {
  // S3 object store
  const objects: Record<string, { body: string | Buffer; lastModified: Date }> = {};

  // Populate with checkpoint metadata
  for (const [key, value] of Object.entries(checkpoints)) {
    objects[key] = {
      body: JSON.stringify(value),
      lastModified: new Date((value as any).timestamp),
    };
  }

  class MockS3Client {
    async send(cmd: any): Promise<any> {
      if (cmd._type === "GetObject") {
        const obj = objects[cmd.Key];
        if (!obj) {
          const err = new Error("Not found");
          (err as any).name = "NoSuchKey";
          throw err;
        }
        return {
          Body: {
            transformToString: () => Promise.resolve(
              typeof obj.body === "string" ? obj.body : obj.body.toString()
            ),
          },
        };
      }
      if (cmd._type === "HeadObject") {
        if (!objects[cmd.Key]) {
          const err = new Error("Not found");
          (err as any).name = "NotFound";
          (err as any).$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return {};
      }
      if (cmd._type === "ListObjectsV2") {
        const prefix = cmd.Prefix || "";
        const contents = Object.entries(objects)
          .filter(([k]) => k.startsWith(prefix) && k.endsWith(".json"))
          .map(([k, v]) => ({
            Key: k,
            LastModified: v.lastModified,
          }));
        return { Contents: contents, IsTruncated: false };
      }
      throw new Error(`Unknown command type: ${cmd._type}`);
    }
  }

  return {
    s3: {
      S3Client: MockS3Client,
      GetObjectCommand: class { _type = "GetObject"; Key: string; constructor(p: any) { this.Key = p.Key; } },
      HeadObjectCommand: class { _type = "HeadObject"; Key: string; constructor(p: any) { this.Key = p.Key; } },
      ListObjectsV2Command: class { _type = "ListObjectsV2"; Prefix: string; constructor(p: any) { this.Prefix = p.Prefix; } },
      PutObjectCommand: class { _type = "PutObject"; constructor(p: any) {} },
    },
    presigner: {
      getSignedUrl: async (_client: any, cmd: any, _opts: any) => {
        // Return a mock URL that our fetch mock can intercept
        return `https://mock-s3.test/presigned/${cmd.Key}`;
      },
    },
  };
}

// =============================================================================
// MOCK FETCH (intercepts presigned URL downloads)
// =============================================================================

const originalFetch = globalThis.fetch;

function installMockFetch(): void {
  (globalThis as any).fetch = async (url: string | URL, init?: any) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    // Mock presigned S3 download — return the mock archive
    if (urlStr.includes("mock-s3.test/presigned/") && urlStr.includes("archive.tar.gz")) {
      return new Response(mockArchiveBuffer, {
        status: 200,
        headers: { "Content-Type": "application/gzip" },
      });
    }

    // Gateway API calls — pass through to gateway mock handler
    // Match both mock URL and real dashboard URL (DEFAULT_DASHBOARD_URL is captured at module load)
    if (urlStr.includes("mock-gateway.test") || urlStr.includes("/api/checkpoints")) {
      return handleGatewayMock(urlStr, init);
    }

    throw new Error(`Unexpected fetch: ${urlStr}`);
  };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// =============================================================================
// MOCK GATEWAY API
// =============================================================================

function handleGatewayMock(url: string, init?: any): Response {
  // GET /api/checkpoints/:id
  const getMatch = url.match(/\/api\/checkpoints\/([^?/]+)$/);
  if (getMatch && (!init || init.method === "GET")) {
    const id = getMatch[1];
    const ckpt = [MOCK_CHECKPOINT, MOCK_CHECKPOINT_2].find((c) => c.id === id);
    if (!ckpt) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(JSON.stringify(ckpt), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // GET /api/checkpoints?limit=N&tag=T
  if (url.includes("/api/checkpoints") && !url.includes("/presign") && (!init || init.method === "GET")) {
    const parsed = new URL(url);
    const limit = parseInt(parsed.searchParams.get("limit") || "100", 10);
    const tag = parsed.searchParams.get("tag");

    let results = [MOCK_CHECKPOINT_2, MOCK_CHECKPOINT]; // sorted newest first
    if (tag) {
      results = results.filter((c) => c.tag === tag);
    }
    results = results.slice(0, limit);

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // POST /api/checkpoints/presign
  if (url.includes("/api/checkpoints/presign") && init?.method === "POST") {
    // Return a presigned URL to our mock archive
    return new Response(
      JSON.stringify({ url: `https://mock-s3.test/presigned/data/${mockArchiveHash}/archive.tar.gz` }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response("Unknown endpoint", { status: 404 });
}

// =============================================================================
// TESTS: BYOK mode — listCheckpoints, getCheckpoint, getLatestCheckpoint
// =============================================================================

async function testByokBrowsing(): Promise<void> {
  console.log("\n[1] BYOK Mode — Browse Checkpoints");

  const mockSdk = createMockAwsSdk({
    "test-prefix/checkpoints/ckpt_test_001.json": MOCK_CHECKPOINT,
    "test-prefix/checkpoints/ckpt_test_002.json": MOCK_CHECKPOINT_2,
  });
  _testSetAwsSdk(mockSdk);

  const s = storage({ url: "s3://test-bucket/test-prefix" });

  // listCheckpoints
  const all = await s.listCheckpoints();
  assert(all.length === 2, "listCheckpoints returns 2 checkpoints");
  assertEqual(all[0].id, "ckpt_test_002", "listCheckpoints sorted newest first");

  // listCheckpoints with limit
  const limited = await s.listCheckpoints({ limit: 1 });
  assertEqual(limited.length, 1, "listCheckpoints respects limit");

  // listCheckpoints with tag filter
  const tagged = await s.listCheckpoints({ tag: "poker-agent" });
  assertEqual(tagged.length, 1, "listCheckpoints filters by tag");
  assertEqual(tagged[0].id, "ckpt_test_002", "listCheckpoints tag filter returns correct checkpoint");

  // getCheckpoint
  const ckpt = await s.getCheckpoint("ckpt_test_001");
  assertEqual(ckpt.id, "ckpt_test_001", "getCheckpoint returns correct checkpoint");
  assertEqual(ckpt.tag, "test-session", "getCheckpoint has correct tag");

  // getCheckpoint — not found
  await assertThrows(
    () => s.getCheckpoint("ckpt_nonexistent"),
    "not found",
    "getCheckpoint throws on missing checkpoint"
  );

  // getLatestCheckpoint
  const latest = await s.getLatestCheckpoint();
  assert(latest !== null, "getLatestCheckpoint returns a checkpoint");
  assertEqual(latest!.id, "ckpt_test_002", "getLatestCheckpoint returns newest");

  // getLatestCheckpoint with tag
  const latestTagged = await s.getLatestCheckpoint({ tag: "test-session" });
  assert(latestTagged !== null, "getLatestCheckpoint with tag returns a checkpoint");
  assertEqual(latestTagged!.id, "ckpt_test_001", "getLatestCheckpoint tag filter returns correct checkpoint");

  _testSetAwsSdk(null);
}

// =============================================================================
// TESTS: BYOK mode — downloadCheckpoint, downloadFiles
// =============================================================================

async function testByokDownloads(): Promise<void> {
  console.log("\n[2] BYOK Mode — Download Checkpoints & Files");

  const mockSdk = createMockAwsSdk({
    "test-prefix/checkpoints/ckpt_test_001.json": MOCK_CHECKPOINT,
    "test-prefix/checkpoints/ckpt_test_002.json": MOCK_CHECKPOINT_2,
  });
  _testSetAwsSdk(mockSdk);
  installMockFetch();

  try {
    const s = storage({ url: "s3://test-bucket/test-prefix" });

    // downloadCheckpoint (extract=true, default)
    const extractDir = join(tmpdir(), `evolve-test-extract-${Date.now()}`);
    const resultPath = await s.downloadCheckpoint("ckpt_test_001", { to: extractDir });
    assertEqual(resultPath, extractDir, "downloadCheckpoint returns target directory");

    // Verify extracted files exist
    const resultJson = await readFile(join(extractDir, "workspace", "output", "result.json"), "utf-8");
    assertEqual(resultJson, '{"answer":42}', "downloadCheckpoint extracts result.json correctly");

    const summaryTxt = await readFile(join(extractDir, "workspace", "output", "summary.txt"), "utf-8");
    assertEqual(summaryTxt, "Test summary content", "downloadCheckpoint extracts summary.txt correctly");

    const settingsJson = await readFile(join(extractDir, ".claude", "settings.json"), "utf-8");
    assertEqual(settingsJson, '{"model":"claude"}', "downloadCheckpoint extracts agent settings");

    await rm(extractDir, { recursive: true, force: true });

    // downloadCheckpoint (extract=false — raw archive)
    const archiveDir = join(tmpdir(), `evolve-test-archive-dl-${Date.now()}`);
    const archivePath = await s.downloadCheckpoint("ckpt_test_001", { to: archiveDir, extract: false });
    assert(archivePath.endsWith(".tar.gz"), "downloadCheckpoint extract=false returns .tar.gz path");

    const downloadedArchive = await readFile(archivePath);
    const downloadedHash = createHash("sha256").update(downloadedArchive).digest("hex");
    assertEqual(downloadedHash, mockArchiveHash, "downloadCheckpoint archive has correct hash");

    await rm(archiveDir, { recursive: true, force: true });

    // downloadFiles — all files
    const allFiles = await s.downloadFiles("ckpt_test_001");
    const fileKeys = Object.keys(allFiles).sort();
    assert(fileKeys.length === 4, `downloadFiles returns all 4 files (got ${fileKeys.length})`);
    assert(fileKeys.includes("workspace/output/result.json"), "downloadFiles includes result.json");
    assert(fileKeys.includes("workspace/output/summary.txt"), "downloadFiles includes summary.txt");
    assert(fileKeys.includes("workspace/context/input.txt"), "downloadFiles includes input.txt");
    assert(fileKeys.includes(".claude/settings.json"), "downloadFiles includes settings.json");

    // Verify file content
    const resultContent = allFiles["workspace/output/result.json"];
    assertEqual(
      Buffer.isBuffer(resultContent) ? resultContent.toString() : resultContent,
      '{"answer":42}',
      "downloadFiles content matches"
    );

    // downloadFiles — specific files
    const specific = await s.downloadFiles("ckpt_test_001", {
      files: ["workspace/output/result.json", "workspace/context/input.txt"],
    });
    assertEqual(Object.keys(specific).length, 2, "downloadFiles with files filter returns 2 files");
    assert("workspace/output/result.json" in specific, "downloadFiles files filter includes result.json");
    assert("workspace/context/input.txt" in specific, "downloadFiles files filter includes input.txt");

    // downloadFiles — glob patterns
    const globbed = await s.downloadFiles("ckpt_test_001", {
      glob: ["workspace/output/*"],
    });
    assertEqual(Object.keys(globbed).length, 2, "downloadFiles glob 'workspace/output/*' returns 2 files");
    assert("workspace/output/result.json" in globbed, "downloadFiles glob matches result.json");
    assert("workspace/output/summary.txt" in globbed, "downloadFiles glob matches summary.txt");

    // downloadFiles — glob with **
    const deepGlob = await s.downloadFiles("ckpt_test_001", {
      glob: ["**/*.json"],
    });
    assertEqual(Object.keys(deepGlob).length, 2, "downloadFiles glob '**/*.json' returns 2 json files");
    assert("workspace/output/result.json" in deepGlob, "downloadFiles ** glob matches workspace json");
    assert(".claude/settings.json" in deepGlob, "downloadFiles ** glob matches agent json");

    // downloadFiles — glob with no matches
    const noMatch = await s.downloadFiles("ckpt_test_001", {
      glob: ["nonexistent/**"],
    });
    assertEqual(Object.keys(noMatch).length, 0, "downloadFiles glob with no matches returns empty FileMap");

    // downloadFiles — with `to` (save to disk)
    const saveDir = join(tmpdir(), `evolve-test-save-${Date.now()}`);
    const savedFiles = await s.downloadFiles("ckpt_test_001", {
      files: ["workspace/output/result.json"],
      to: saveDir,
    });
    assertEqual(Object.keys(savedFiles).length, 1, "downloadFiles with `to` returns FileMap");

    const savedContent = await readFile(join(saveDir, "workspace", "output", "result.json"), "utf-8");
    assertEqual(savedContent, '{"answer":42}', "downloadFiles saves to disk correctly");
    await rm(saveDir, { recursive: true, force: true });

    // downloadFiles — "latest" resolution
    const latestFiles = await s.downloadFiles("latest", {
      files: ["workspace/output/result.json"],
    });
    assert("workspace/output/result.json" in latestFiles, "downloadFiles 'latest' resolves and downloads");

  } finally {
    restoreFetch();
    _testSetAwsSdk(null);
  }
}

// =============================================================================
// TESTS: Gateway mode — all methods
// =============================================================================

async function testGatewayMode(): Promise<void> {
  console.log("\n[3] Gateway Mode — All Methods");

  // Set up gateway env
  const origApiKey = process.env.EVOLVE_API_KEY;
  const origDashUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_API_KEY = "test-gw-key";
  process.env.EVOLVE_DASHBOARD_URL = "https://mock-gateway.test";

  installMockFetch();

  try {
    const s = storage(); // gateway mode — no URL, uses EVOLVE_API_KEY

    // listCheckpoints
    const all = await s.listCheckpoints();
    assert(all.length === 2, "gateway listCheckpoints returns 2 checkpoints");
    assertEqual(all[0].id, "ckpt_test_002", "gateway listCheckpoints sorted newest first");

    // listCheckpoints with tag
    const tagged = await s.listCheckpoints({ tag: "poker-agent" });
    assertEqual(tagged.length, 1, "gateway listCheckpoints filters by tag");

    // getCheckpoint
    const ckpt = await s.getCheckpoint("ckpt_test_001");
    assertEqual(ckpt.id, "ckpt_test_001", "gateway getCheckpoint returns correct checkpoint");

    // getCheckpoint not found
    await assertThrows(
      () => s.getCheckpoint("ckpt_nonexistent"),
      "not found",
      "gateway getCheckpoint throws on missing"
    );

    // getLatestCheckpoint
    const latest = await s.getLatestCheckpoint();
    assert(latest !== null, "gateway getLatestCheckpoint returns a checkpoint");
    assertEqual(latest!.id, "ckpt_test_002", "gateway getLatestCheckpoint returns newest");

    // downloadCheckpoint
    const extractDir = join(tmpdir(), `evolve-test-gw-extract-${Date.now()}`);
    const resultPath = await s.downloadCheckpoint("ckpt_test_001", { to: extractDir });
    const resultJson = await readFile(join(extractDir, "workspace", "output", "result.json"), "utf-8");
    assertEqual(resultJson, '{"answer":42}', "gateway downloadCheckpoint extracts correctly");
    await rm(extractDir, { recursive: true, force: true });

    // downloadFiles
    const files = await s.downloadFiles("ckpt_test_001", {
      glob: ["workspace/output/*"],
    });
    assertEqual(Object.keys(files).length, 2, "gateway downloadFiles returns filtered files");

  } finally {
    restoreFetch();
    if (origApiKey !== undefined) process.env.EVOLVE_API_KEY = origApiKey;
    else delete process.env.EVOLVE_API_KEY;
    if (origDashUrl !== undefined) process.env.EVOLVE_DASHBOARD_URL = origDashUrl;
    else delete process.env.EVOLVE_DASHBOARD_URL;
  }
}

// =============================================================================
// TESTS: Integrity check failure
// =============================================================================

async function testIntegrityFailure(): Promise<void> {
  console.log("\n[4] Download Integrity Check");

  // Create a checkpoint with wrong hash
  const wrongHashCheckpoint = {
    ...MOCK_CHECKPOINT,
    id: "ckpt_bad_hash",
    hash: "0000000000000000000000000000000000000000000000000000000000000000",
  };

  const mockSdk = createMockAwsSdk({
    "test-prefix/checkpoints/ckpt_bad_hash.json": wrongHashCheckpoint,
  });
  _testSetAwsSdk(mockSdk);
  installMockFetch();

  try {
    const s = storage({ url: "s3://test-bucket/test-prefix" });

    await assertThrows(
      () => s.downloadCheckpoint("ckpt_bad_hash"),
      "integrity check failed",
      "downloadCheckpoint throws on hash mismatch"
    );

    await assertThrows(
      () => s.downloadFiles("ckpt_bad_hash"),
      "integrity check failed",
      "downloadFiles throws on hash mismatch"
    );
  } finally {
    restoreFetch();
    _testSetAwsSdk(null);
  }
}

// =============================================================================
// TESTS: "latest" resolution with no checkpoints
// =============================================================================

async function testLatestNoCheckpoints(): Promise<void> {
  console.log("\n[5] Latest Resolution — No Checkpoints");

  const mockSdk = createMockAwsSdk({}); // no checkpoints
  _testSetAwsSdk(mockSdk);

  try {
    const s = storage({ url: "s3://test-bucket/test-prefix" });

    // getLatestCheckpoint returns null
    const latest = await s.getLatestCheckpoint();
    assertEqual(latest, null, "getLatestCheckpoint returns null when no checkpoints");

    // downloadCheckpoint "latest" throws
    installMockFetch();
    await assertThrows(
      () => s.downloadCheckpoint("latest"),
      "No checkpoints found",
      "downloadCheckpoint 'latest' throws when no checkpoints"
    );

    // downloadFiles "latest" throws
    await assertThrows(
      () => s.downloadFiles("latest"),
      "No checkpoints found",
      "downloadFiles 'latest' throws when no checkpoints"
    );
  } finally {
    restoreFetch();
    _testSetAwsSdk(null);
  }
}

// =============================================================================
// TESTS: Security hardening (symlink + traversal archives)
// =============================================================================

async function testSecurityHardening(): Promise<void> {
  console.log("\n[6] Security Hardening — Reject Malicious Archives");

  const originalBuffer = mockArchiveBuffer;
  const originalHash = mockArchiveHash;

  // A) Archive with symlink entry should be rejected
  const symlinkArchive = await createSymlinkArchive();
  try {
    mockArchiveBuffer = symlinkArchive.buffer;
    mockArchiveHash = symlinkArchive.hash;

    const symlinkCheckpoint = {
      ...MOCK_CHECKPOINT,
      id: "ckpt_symlink",
      hash: symlinkArchive.hash,
    };
    _testSetAwsSdk(createMockAwsSdk({
      "test-prefix/checkpoints/ckpt_symlink.json": symlinkCheckpoint,
    }));
    installMockFetch();

    const s = storage({ url: "s3://test-bucket/test-prefix" });
    await assertThrows(
      () => s.downloadFiles("ckpt_symlink"),
      "unsupported entry type",
      "downloadFiles rejects archive symlink entries"
    );
    await assertThrows(
      () => s.downloadCheckpoint("ckpt_symlink"),
      "unsupported entry type",
      "downloadCheckpoint rejects archive symlink entries"
    );
  } finally {
    restoreFetch();
    _testSetAwsSdk(null);
    await rm(symlinkArchive.path, { force: true }).catch(() => {});
  }

  // B) Archive with traversal path should be rejected
  const traversalArchive = await createTraversalArchive();
  try {
    mockArchiveBuffer = traversalArchive.buffer;
    mockArchiveHash = traversalArchive.hash;

    const traversalCheckpoint = {
      ...MOCK_CHECKPOINT,
      id: "ckpt_traversal",
      hash: traversalArchive.hash,
    };
    _testSetAwsSdk(createMockAwsSdk({
      "test-prefix/checkpoints/ckpt_traversal.json": traversalCheckpoint,
    }));
    installMockFetch();

    const s = storage({ url: "s3://test-bucket/test-prefix" });
    await assertThrows(
      () => s.downloadFiles("ckpt_traversal"),
      "unsafe path",
      "downloadFiles rejects archive traversal paths"
    );
    await assertThrows(
      () => s.downloadCheckpoint("ckpt_traversal"),
      "unsafe path",
      "downloadCheckpoint rejects archive traversal paths"
    );
  } finally {
    restoreFetch();
    _testSetAwsSdk(null);
    await rm(traversalArchive.path, { force: true }).catch(() => {});
    mockArchiveBuffer = originalBuffer;
    mockArchiveHash = originalHash;
  }

  // C) Archive with special entry type (FIFO) should be rejected
  const fifoArchive = await createFifoArchive();
  try {
    mockArchiveBuffer = fifoArchive.buffer;
    mockArchiveHash = fifoArchive.hash;

    const fifoCheckpoint = {
      ...MOCK_CHECKPOINT,
      id: "ckpt_fifo",
      hash: fifoArchive.hash,
    };
    _testSetAwsSdk(createMockAwsSdk({
      "test-prefix/checkpoints/ckpt_fifo.json": fifoCheckpoint,
    }));
    installMockFetch();

    const s = storage({ url: "s3://test-bucket/test-prefix" });
    await assertThrows(
      () => s.downloadFiles("ckpt_fifo"),
      "unsupported entry type",
      "downloadFiles rejects archive special entry types (fifo)"
    );
    await assertThrows(
      () => s.downloadCheckpoint("ckpt_fifo"),
      "unsupported entry type",
      "downloadCheckpoint rejects archive special entry types (fifo)"
    );
  } finally {
    restoreFetch();
    _testSetAwsSdk(null);
    await rm(fifoArchive.path, { force: true }).catch(() => {});
    mockArchiveBuffer = originalBuffer;
    mockArchiveHash = originalHash;
  }
}

// =============================================================================
// TESTS: storage() export available
// =============================================================================

async function testExport(): Promise<void> {
  console.log("\n[7] Export Availability");

  const sdk = await import("../../dist/index.js");
  assert(typeof sdk.storage === "function", "storage is exported from dist");
  assert(typeof sdk.resolveStorageConfig === "function", "resolveStorageConfig is still exported");
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Storage Client Unit Tests");
  console.log("=".repeat(60));

  // Create mock archive (shared by all tests)
  await createMockArchive();

  await testByokBrowsing();
  await testByokDownloads();
  await testGatewayMode();
  await testIntegrityFailure();
  await testLatestNoCheckpoints();
  await testSecurityHardening();
  await testExport();

  // Cleanup
  if (mockArchivePath) {
    await rm(mockArchivePath, { force: true }).catch(() => {});
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
