#!/usr/bin/env tsx
/**
 * Unit Test: Checkpoint Edge Cases
 *
 * Tests edge cases and bug fixes not covered by checkpoint-dx.test.ts:
 *   1. limit+tag interaction (BYOK) — limit applied after tag filter (bug fix)
 *   2. Tag filter in BYOK listCheckpoints — basic tag filtering
 *   3. Tag filter in Gateway listCheckpoints — tag passed as query param
 *   4. getLatestCheckpoint is globally scoped (not tag-scoped)
 *   5. from: "latest" with existing sandbox/sandboxId — mutual exclusivity check
 *      fires before network call
 *   6. Corrupted metadata JSON silently skipped in s3ListCheckpoints
 *   7. restoreCheckpoint hash mismatch — cleanup and throw
 *   8. restoreCheckpoint BYOK with nonexistent checkpoint
 *   9. Auto-checkpoint skipped on background run
 *  10. Auto-checkpoint skipped on non-zero exit code
 *  11. Gateway dedup — alreadyExists skips upload
 *
 * Usage:
 *   npm run test:unit:checkpoint-edge-cases
 *   npx tsx tests/unit/checkpoint-edge-cases.test.ts
 */

import {
  createCheckpoint,
  restoreCheckpoint,
  listCheckpoints,
  getLatestCheckpoint,
  _testSetAwsSdk,
} from "../../src/storage/index.ts";
import { Agent } from "../../dist/index.js";

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

async function assertNoThrow(fn: () => Promise<unknown>, message: string): Promise<unknown> {
  try {
    const result = await fn();
    passed++;
    console.log(`  \u2713 ${message}`);
    return result;
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${message} (threw "${(e as Error).message}")`);
    return undefined;
  }
}

// =============================================================================
// CONSTANTS
// =============================================================================

const HASH_64 = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const HASH_64_B = "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6b1b2";

const BYOK_STORAGE = {
  bucket: "test-bucket",
  prefix: "test-prefix",
  region: "us-east-1",
  mode: "byok" as const,
};

const GATEWAY_STORAGE = {
  bucket: "",
  prefix: "",
  region: "us-east-1",
  mode: "gateway" as const,
  gatewayUrl: "https://dashboard.test.com",
  gatewayApiKey: "test-api-key",
};

// =============================================================================
// MOCK STATE
// =============================================================================

interface MockState {
  s3Objects: Map<string, { body?: string }>;
  s3PutCalls: Array<{ Key: string; Body?: string }>;
  s3ListCalls: Array<{ Prefix?: string; ContinuationToken?: string }>;
  commandHistory: string[];
  fetchCalls: Array<{ url: string; method: string; body?: string }>;
}

let state: MockState;

function resetState(): void {
  state = {
    s3Objects: new Map(),
    s3PutCalls: [],
    s3ListCalls: [],
    commandHistory: [],
    fetchCalls: [],
  };
}

// =============================================================================
// MOCK AWS SDK
// =============================================================================

interface S3ObjectEntry {
  body?: string;
  lastModified?: Date;
}

let s3ListObjects: Map<string, S3ObjectEntry> = new Map();

function installMockAwsSdk(): void {
  const s3 = {
    S3Client: class {
      constructor(_config: any) {}
      async send(cmd: any) {
        const key = cmd.input?.Key;
        if (cmd._type === "HeadObject") {
          if (!state.s3Objects.has(key)) {
            const err: any = new Error("NotFound");
            err.name = "NotFound";
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return {};
        }
        if (cmd._type === "GetObject") {
          const obj = state.s3Objects.get(key);
          if (!obj) throw new Error("NoSuchKey");
          return { Body: { transformToString: async () => obj.body || "" } };
        }
        if (cmd._type === "PutObject") {
          state.s3PutCalls.push({ Key: key, Body: cmd.input.Body });
          return {};
        }
        if (cmd._type === "ListObjectsV2") {
          state.s3ListCalls.push({
            Prefix: cmd.input.Prefix,
            ContinuationToken: cmd.input.ContinuationToken,
          });
          const prefix = cmd.input.Prefix || "";
          const entries: Array<{ Key: string; LastModified: Date }> = [];
          for (const [k, v] of s3ListObjects) {
            if (k.startsWith(prefix) && k.endsWith(".json")) {
              entries.push({
                Key: k,
                LastModified: v.lastModified || new Date("2025-01-01T00:00:00Z"),
              });
            }
          }
          return {
            Contents: entries.length > 0 ? entries : undefined,
            IsTruncated: false,
            NextContinuationToken: undefined,
          };
        }
        throw new Error(`Unhandled S3 command: ${cmd._type}`);
      }
    },
    HeadObjectCommand: class { input: any; _type = "HeadObject"; constructor(i: any) { this.input = i; } },
    GetObjectCommand: class { input: any; _type = "GetObject"; constructor(i: any) { this.input = i; } },
    PutObjectCommand: class { input: any; _type = "PutObject"; constructor(i: any) { this.input = i; } },
    ListObjectsV2Command: class { input: any; _type = "ListObjectsV2"; constructor(i: any) { this.input = i; } },
  };

  const presigner = {
    getSignedUrl: async (_client: any, cmd: any, _opts: any) =>
      `https://presigned.test/${cmd.input.Key}`,
  };

  _testSetAwsSdk({ s3, presigner });
}

// =============================================================================
// MOCK SANDBOX
// =============================================================================

type CmdResult = { stdout: string; stderr: string; exitCode: number };
type CmdHandler = (cmd: string) => CmdResult | Promise<CmdResult>;

function createMockSandbox(handler?: CmdHandler) {
  let killed = false;
  const defaultHandler: CmdHandler = () => ({ stdout: "", stderr: "", exitCode: 0 });
  const h = handler || defaultHandler;

  return {
    sandboxId: "test-sandbox-123",
    commands: {
      run: async (cmd: string, opts?: any) => {
        state.commandHistory.push(cmd);
        const result = await h(cmd);
        if (opts?.onStdout && result.stdout) opts.onStdout(result.stdout);
        if (opts?.onStderr && result.stderr) opts.onStderr(result.stderr);
        return result;
      },
      spawn: async (cmd: string, opts?: any) => {
        state.commandHistory.push(cmd);
        const result = await h(cmd);
        if (opts?.onStdout && result.stdout) opts.onStdout(result.stdout);
        if (opts?.onStderr && result.stderr) opts.onStderr(result.stderr);
        return {
          processId: "mock-pid-001",
          wait: async () => result,
          kill: async () => true,
        };
      },
      list: async () => [],
      kill: async (_pid: string) => true,
    },
    files: {
      list: async (_path: string, _opts?: any) => [],
      read: async (_path: string) => "",
      write: async (_path: string, _content: any) => {},
      writeBatch: async (_entries: any[]) => {},
      makeDir: async (_path: string) => {},
    },
    kill: async () => { killed = true; },
    pause: async () => {},
    resume: async () => {},
    getHost: (port: number) => `localhost:${port}`,
    get wasKilled() { return killed; },
  };
}

function createMockProvider(sandbox: any) {
  return {
    name: "mock",
    providerType: "mock",
    create: async (_opts?: any) => sandbox,
    connect: async (_id: string) => sandbox,
  };
}

// =============================================================================
// MOCK FETCH
// =============================================================================

const originalFetch = globalThis.fetch;

function installMockFetch(handlers: Map<string, (body?: any, url?: string, method?: string) => { status: number; body: any }>): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : (url as URL).toString();
    const method = init?.method || "GET";
    const reqBody = init?.body ? JSON.parse(init.body as string) : undefined;
    state.fetchCalls.push({ url: urlStr, method, body: init?.body as string });

    for (const [pattern, handler] of handlers) {
      if (urlStr.includes(pattern)) {
        const resp = handler(reqBody, urlStr, method);
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        } as Response;
      }
    }
    throw new Error(`Unmocked fetch: ${method} ${urlStr}`);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// =============================================================================
// COMMAND HANDLERS
// =============================================================================

function checkpointCmdHandler(): CmdHandler {
  return (cmd: string) => {
    if (cmd.includes("tar -czf")) return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    if (cmd.includes("stat -c")) return { stdout: "2048\n", stderr: "", exitCode: 0 };
    if (cmd.includes("curl") && cmd.includes("PUT")) {
      state.s3Objects.set(`test-prefix/data/${HASH_64}/archive.tar.gz`, {});
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

function fullRunHandler(opts: { exitCode?: number } = {}): CmdHandler {
  return (cmd: string) => {
    if (cmd.includes("mkdir -p")) return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd.includes("tar -czf")) return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    if (cmd.includes("stat -c")) return { stdout: "2048\n", stderr: "", exitCode: 0 };
    if (cmd.includes("curl") && cmd.includes("PUT")) {
      state.s3Objects.set(`test-prefix/data/${HASH_64}/archive.tar.gz`, {});
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd.includes("claude") || cmd.includes("codex") || cmd.includes("gemini") || cmd.includes("qwen")) {
      return { stdout: "Agent output text\n", stderr: "", exitCode: opts.exitCode ?? 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

function makeAgentConfig() {
  return {
    type: "claude" as const,
    apiKey: "test-key-000",
    isDirectMode: true,
    isOAuth: false,
    model: "opus",
  };
}

// =============================================================================
// TEST 1: limit+tag interaction (bug fix verification)
// =============================================================================

async function testLimitAppliedAfterTagFilter(): Promise<void> {
  console.log("\n[1a] limit+tag: limit applied AFTER tag filter (bug fix)");
  resetState();
  installMockAwsSdk();

  // Create 6 checkpoints: 3 with tag "alpha", 3 with tag "beta"
  // Ordered by time: beta-1, alpha-1, beta-2, alpha-2, beta-3, alpha-3 (interleaved)
  s3ListObjects = new Map();
  const entries = [
    { id: "ckpt_b1", tag: "beta", ts: "2025-01-01T00:00:00Z" },
    { id: "ckpt_a1", tag: "alpha", ts: "2025-01-02T00:00:00Z" },
    { id: "ckpt_b2", tag: "beta", ts: "2025-01-03T00:00:00Z" },
    { id: "ckpt_a2", tag: "alpha", ts: "2025-01-04T00:00:00Z" },
    { id: "ckpt_b3", tag: "beta", ts: "2025-01-05T00:00:00Z" },
    { id: "ckpt_a3", tag: "alpha", ts: "2025-01-06T00:00:00Z" },
  ];

  for (const e of entries) {
    const meta = { id: e.id, hash: HASH_64, tag: e.tag, timestamp: e.ts };
    s3ListObjects.set(`test-prefix/checkpoints/${e.id}.json`, {
      body: JSON.stringify(meta),
      lastModified: new Date(e.ts),
    });
    state.s3Objects.set(`test-prefix/checkpoints/${e.id}.json`, { body: JSON.stringify(meta) });
  }

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    // Request limit=2 with tag="alpha" — should get the 2 newest alpha checkpoints
    const result = await listCheckpoints(
      { url: "s3://test-bucket/test-prefix" },
      { limit: 2, tag: "alpha" }
    );
    assertEqual(result.length, 2, "limit=2, tag='alpha' returns exactly 2");
    assertEqual(result[0].id, "ckpt_a3", "First is newest alpha (ckpt_a3)");
    assertEqual(result[1].id, "ckpt_a2", "Second is next alpha (ckpt_a2)");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

async function testLimitWithTagReturnsAllMatchingWhenLimitExceedsCount(): Promise<void> {
  console.log("\n[1b] limit+tag: limit > matching entries returns all matches");
  resetState();
  installMockAwsSdk();

  s3ListObjects = new Map();
  const entries = [
    { id: "ckpt_x1", tag: "target", ts: "2025-01-01T00:00:00Z" },
    { id: "ckpt_y1", tag: "other", ts: "2025-01-02T00:00:00Z" },
    { id: "ckpt_x2", tag: "target", ts: "2025-01-03T00:00:00Z" },
  ];

  for (const e of entries) {
    const meta = { id: e.id, hash: HASH_64, tag: e.tag, timestamp: e.ts };
    s3ListObjects.set(`test-prefix/checkpoints/${e.id}.json`, {
      body: JSON.stringify(meta),
      lastModified: new Date(e.ts),
    });
    state.s3Objects.set(`test-prefix/checkpoints/${e.id}.json`, { body: JSON.stringify(meta) });
  }

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    // limit=10 but only 2 match tag="target"
    const result = await listCheckpoints(
      { url: "s3://test-bucket/test-prefix" },
      { limit: 10, tag: "target" }
    );
    assertEqual(result.length, 2, "Returns all 2 matching entries (limit=10 doesn't inflate)");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

// =============================================================================
// TEST 2: Tag filter in BYOK listCheckpoints (basic)
// =============================================================================

async function testTagFilterByok(): Promise<void> {
  console.log("\n[2] Tag filter: BYOK only returns matching tag");
  resetState();
  installMockAwsSdk();

  s3ListObjects = new Map();
  const entries = [
    { id: "ckpt_t1", tag: "session-A", ts: "2025-01-01T00:00:00Z" },
    { id: "ckpt_t2", tag: "session-B", ts: "2025-01-02T00:00:00Z" },
    { id: "ckpt_t3", tag: "session-A", ts: "2025-01-03T00:00:00Z" },
  ];

  for (const e of entries) {
    const meta = { id: e.id, hash: HASH_64, tag: e.tag, timestamp: e.ts };
    s3ListObjects.set(`test-prefix/checkpoints/${e.id}.json`, {
      body: JSON.stringify(meta),
      lastModified: new Date(e.ts),
    });
    state.s3Objects.set(`test-prefix/checkpoints/${e.id}.json`, { body: JSON.stringify(meta) });
  }

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    const result = await listCheckpoints(
      { url: "s3://test-bucket/test-prefix" },
      { tag: "session-A" }
    );
    assertEqual(result.length, 2, "Returns 2 entries for tag=session-A");
    assertEqual(result[0].id, "ckpt_t3", "Newest session-A first");
    assertEqual(result[1].id, "ckpt_t1", "Oldest session-A second");
    assert(result.every(r => r.tag === "session-A"), "All results have tag=session-A");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

// =============================================================================
// TEST 3: Tag filter in Gateway listCheckpoints
// =============================================================================

async function testTagFilterGatewayPassesQueryParam(): Promise<void> {
  console.log("\n[3] Tag filter: Gateway passes tag as query param");
  resetState();
  _testSetAwsSdk(null);

  let capturedUrl = "";
  const handlers = new Map<string, (body?: any, url?: string, method?: string) => { status: number; body: any }>();
  handlers.set("/api/checkpoints", (_body: any, url?: string, method?: string) => {
    if (method === "GET") {
      capturedUrl = url || "";
      return { status: 200, body: [] };
    }
    return { status: 404, body: {} };
  });
  installMockFetch(handlers);

  const originalApiKey = process.env.EVOLVE_API_KEY;
  process.env.EVOLVE_API_KEY = "test-gateway-key";

  try {
    await listCheckpoints({}, { tag: "my-session-tag", limit: 5 });
    assert(capturedUrl.includes("tag=my-session-tag"), "Gateway URL includes tag query param");
    assert(capturedUrl.includes("limit=5"), "Gateway URL includes limit query param");
  } finally {
    restoreFetch();
    if (originalApiKey) {
      process.env.EVOLVE_API_KEY = originalApiKey;
    } else {
      delete process.env.EVOLVE_API_KEY;
    }
  }
}

// =============================================================================
// TEST 4: getLatestCheckpoint is globally scoped
// =============================================================================

async function testGetLatestCheckpointIsGlobal(): Promise<void> {
  console.log("\n[4] getLatestCheckpoint: returns globally latest (not tag-scoped)");
  resetState();
  installMockAwsSdk();

  // Two tags, different times — globally latest is tag-B
  s3ListObjects = new Map();
  const metaA = { id: "ckpt_tagA", hash: HASH_64, tag: "tag-A", timestamp: "2025-01-01T00:00:00Z" };
  const metaB = { id: "ckpt_tagB", hash: HASH_64, tag: "tag-B", timestamp: "2025-06-01T00:00:00Z" };

  s3ListObjects.set("test-prefix/checkpoints/ckpt_tagA.json", {
    body: JSON.stringify(metaA),
    lastModified: new Date("2025-01-01T00:00:00Z"),
  });
  s3ListObjects.set("test-prefix/checkpoints/ckpt_tagB.json", {
    body: JSON.stringify(metaB),
    lastModified: new Date("2025-06-01T00:00:00Z"),
  });
  state.s3Objects.set("test-prefix/checkpoints/ckpt_tagA.json", { body: JSON.stringify(metaA) });
  state.s3Objects.set("test-prefix/checkpoints/ckpt_tagB.json", { body: JSON.stringify(metaB) });

  const result = await getLatestCheckpoint(BYOK_STORAGE as any);

  assert(result !== null, "Result is not null");
  assertEqual(result!.id, "ckpt_tagB", "Returns globally latest (tag-B), not just one tag");
  assertEqual(result!.tag, "tag-B", "Tag confirms it's from the other session");
}

// =============================================================================
// TEST 5: from "latest" mutual exclusivity fires before network call
// =============================================================================

async function testFromLatestMutualExclusivityBeforeNetworkCall(): Promise<void> {
  console.log("\n[5a] from: 'latest' + sandboxId: mutual exclusivity error before network call");
  resetState();
  // Don't install mock S3 — if a network call were made, it would fail

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
    sandboxId: "existing-sandbox-id",
  });

  await assertThrows(
    () => agent.run({ prompt: "test", from: "latest" }),
    "Cannot restore into existing sandbox",
    "from: 'latest' + sandboxId throws mutual exclusivity error without network call"
  );

  // Verify no S3 calls were made
  assertEqual(state.s3ListCalls.length, 0, "No S3 list calls made (fast-fail before network)");
}

async function testFromConcreteIdMutualExclusivity(): Promise<void> {
  console.log("\n[5b] from: concrete ID + existing sandbox: throws before restore");
  resetState();

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  // First run creates a sandbox
  await agent.run({ prompt: "setup" });

  // Try to restore from a checkpoint while sandbox is active
  await assertThrows(
    () => agent.run({ prompt: "test", from: "ckpt_xyz" }),
    "Cannot restore into existing sandbox",
    "from: ID + active sandbox throws"
  );
}

// =============================================================================
// TEST 6: Corrupted metadata JSON silently skipped
// =============================================================================

async function testCorruptedMetadataSilentlySkipped(): Promise<void> {
  console.log("\n[6] Corrupted metadata JSON silently skipped in listCheckpoints");
  resetState();
  installMockAwsSdk();

  s3ListObjects = new Map();
  // Good checkpoint
  const metaGood = { id: "ckpt_good", hash: HASH_64, tag: "good", timestamp: "2025-01-02T00:00:00Z" };
  s3ListObjects.set("test-prefix/checkpoints/ckpt_good.json", {
    body: JSON.stringify(metaGood),
    lastModified: new Date("2025-01-02T00:00:00Z"),
  });
  state.s3Objects.set("test-prefix/checkpoints/ckpt_good.json", { body: JSON.stringify(metaGood) });

  // Corrupted checkpoint (invalid JSON in S3 object)
  s3ListObjects.set("test-prefix/checkpoints/ckpt_corrupt.json", {
    body: "not-json!!!{{{",
    lastModified: new Date("2025-01-03T00:00:00Z"),
  });
  state.s3Objects.set("test-prefix/checkpoints/ckpt_corrupt.json", { body: "not-json!!!{{{" });

  // Missing checkpoint (listed in S3 but GetObject fails)
  s3ListObjects.set("test-prefix/checkpoints/ckpt_missing.json", {
    body: undefined,
    lastModified: new Date("2025-01-01T00:00:00Z"),
  });
  // Don't add to state.s3Objects — GetObject will throw NoSuchKey

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    const result = await listCheckpoints({ url: "s3://test-bucket/test-prefix" });
    assertEqual(result.length, 1, "Only 1 valid checkpoint returned (2 corrupted/missing skipped)");
    assertEqual(result[0].id, "ckpt_good", "The valid checkpoint is returned");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

// =============================================================================
// TEST 7: restoreCheckpoint hash mismatch
// =============================================================================

async function testRestoreHashMismatch(): Promise<void> {
  console.log("\n[7] restoreCheckpoint: hash mismatch cleans up and throws");
  resetState();
  installMockAwsSdk();

  // Checkpoint metadata says hash is HASH_64
  const meta = { id: "ckpt_mismatch", hash: HASH_64, tag: "test", agentType: "claude" };
  state.s3Objects.set("test-prefix/checkpoints/ckpt_mismatch.json", { body: JSON.stringify(meta) });

  // But the downloaded file has a different hash
  const sandbox = createMockSandbox((cmd: string) => {
    if (cmd.includes("curl") && cmd.includes("evolve-restore")) {
      // Return wrong hash
      return { stdout: HASH_64_B + "\n", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });

  await assertThrows(
    () => restoreCheckpoint(sandbox as any, BYOK_STORAGE as any, "ckpt_mismatch"),
    "integrity check failed",
    "Hash mismatch throws integrity error"
  );

  // Verify cleanup was called
  const cleanupRan = state.commandHistory.some(cmd => cmd.includes("rm -f /tmp/evolve-restore.tar.gz"));
  assert(cleanupRan, "Cleanup rm -f runs after hash mismatch");
}

// =============================================================================
// TEST 8: restoreCheckpoint with nonexistent ID
// =============================================================================

async function testRestoreNonexistentCheckpoint(): Promise<void> {
  console.log("\n[8] restoreCheckpoint: nonexistent ID throws clear error");
  resetState();
  installMockAwsSdk();

  // Don't add any checkpoint metadata to S3
  const sandbox = createMockSandbox();

  await assertThrows(
    () => restoreCheckpoint(sandbox as any, BYOK_STORAGE as any, "nonexistent-id-12345"),
    "not found",
    "Nonexistent checkpoint throws 'not found'"
  );
}

// =============================================================================
// TEST 9: Auto-checkpoint skipped on background run
// =============================================================================

async function testAutoCheckpointSkippedOnBackgroundRun(): Promise<void> {
  console.log("\n[9] Auto-checkpoint skipped on background run");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  const result = await agent.run({ prompt: "test", background: true }) as any;

  assertEqual(result.exitCode, 0, "Background run exits 0");
  assertEqual(result.checkpoint, undefined, "No checkpoint on background run");

  // Verify no tar command was issued for checkpointing
  const tarCmds = state.commandHistory.filter(c => c.includes("tar -czf"));
  assertEqual(tarCmds.length, 0, "No tar checkpoint command on background run");
}

// =============================================================================
// TEST 10: Auto-checkpoint skipped on non-zero exit code
// =============================================================================

async function testAutoCheckpointSkippedOnNonZeroExit(): Promise<void> {
  console.log("\n[10] Auto-checkpoint skipped on non-zero exit code");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(fullRunHandler({ exitCode: 1 }));
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  const result = await agent.run({ prompt: "test" }) as any;

  assertEqual(result.exitCode, 1, "Run exits with code 1");
  assertEqual(result.checkpoint, undefined, "No checkpoint on failed run");

  // Verify no tar command was issued for checkpointing
  const tarCmds = state.commandHistory.filter(c => c.includes("tar -czf"));
  assertEqual(tarCmds.length, 0, "No tar checkpoint command on failed run");
}

// =============================================================================
// TEST 11: Gateway dedup — alreadyExists skips upload
// =============================================================================

async function testGatewayDedupSkipsUpload(): Promise<void> {
  console.log("\n[11] Gateway dedup: alreadyExists=true skips upload");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any) => { status: number; body: any }>();
  handlers.set("/api/checkpoints/presign", () => ({
    status: 200,
    body: { url: null, alreadyExists: true },
  }));
  handlers.set("/api/checkpoints", () => ({
    status: 200,
    body: { id: "gw-dedup" },
  }));
  installMockFetch(handlers);

  try {
    const sandbox = createMockSandbox(checkpointCmdHandler());
    const result = await createCheckpoint(
      sandbox as any, GATEWAY_STORAGE as any, "claude", "/home/user/workspace",
      { tag: "dedup-test" }
    );

    assertEqual(result.id, "gw-dedup", "Gateway checkpoint created via dedup");

    // Verify no curl upload was done (alreadyExists=true should skip)
    const curlPuts = state.commandHistory.filter(c => c.includes("curl") && c.includes("PUT"));
    assertEqual(curlPuts.length, 0, "No curl PUT when alreadyExists=true");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Checkpoint Edge Cases Unit Tests");
  console.log("=".repeat(60));

  // 1. limit+tag bug fix
  await testLimitAppliedAfterTagFilter();
  await testLimitWithTagReturnsAllMatchingWhenLimitExceedsCount();

  // 2. Tag filter BYOK
  await testTagFilterByok();

  // 3. Tag filter Gateway
  await testTagFilterGatewayPassesQueryParam();

  // 4. getLatestCheckpoint global scope
  await testGetLatestCheckpointIsGlobal();

  // 5. Mutual exclusivity before network call
  await testFromLatestMutualExclusivityBeforeNetworkCall();
  await testFromConcreteIdMutualExclusivity();

  // 6. Corrupted metadata
  await testCorruptedMetadataSilentlySkipped();

  // 7. Hash mismatch
  await testRestoreHashMismatch();

  // 8. Nonexistent checkpoint
  await testRestoreNonexistentCheckpoint();

  // 9. Background run
  await testAutoCheckpointSkippedOnBackgroundRun();

  // 10. Non-zero exit
  await testAutoCheckpointSkippedOnNonZeroExit();

  // 11. Gateway dedup
  await testGatewayDedupSkipsUpload();

  // Cleanup
  _testSetAwsSdk(null);

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  restoreFetch();
  _testSetAwsSdk(null);
  console.error("Test runner error:", e);
  process.exit(1);
});
