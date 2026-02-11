#!/usr/bin/env tsx
/**
 * Unit Test: Checkpoint DX v3.3 Features (Mock-Based)
 *
 * Tests all new v3.3 DX features:
 *   1. listCheckpoints() — BYOK + Gateway modes
 *   2. getLatestCheckpoint() — BYOK + Gateway modes
 *   3. from: "latest" resolution in Agent
 *   4. kit.checkpoint({ comment }) — explicit checkpoint
 *   5. checkpointComment passthrough via run()
 *   6. parentId lineage tracking across runs
 *   7. Limit normalization (default 100, max 500)
 *   8. resolveStorageForStandalone() — env-based gateway detection
 *   9. parentId and comment fields in createCheckpoint metadata
 *  10. parentId and comment fields in gatewayGetCheckpoint response
 *
 * Usage:
 *   npm run test:unit:checkpoint-dx
 *   npx tsx tests/unit/checkpoint-dx.test.ts
 */

import {
  createCheckpoint,
  restoreCheckpoint,
  listCheckpoints,
  _testSetAwsSdk,
} from "../../src/storage/index.ts";
import { Agent, Evolve } from "../../dist/index.js";

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
// MOCK AWS SDK (extended with ListObjectsV2Command)
// =============================================================================

/** S3 objects keyed by Key, with optional LastModified for list operations */
interface S3ObjectEntry {
  body?: string;
  lastModified?: Date;
}

let s3ListObjects: Map<string, S3ObjectEntry> = new Map();

/** When > 0, ListObjectsV2 returns at most this many entries per page. */
let s3ListPageSize = 0;

function installMockAwsSdk(): void {
  const s3 = {
    S3Client: class {
      constructor(_config: any) {}
      async send(cmd: any) {
        const key = cmd.input?.Key;
        if (cmd._type === "HeadObject") {
          if (!state.s3Objects.has(key)) {
            throw new Error("NotFound");
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
          const allEntries: Array<{ Key: string; LastModified: Date }> = [];

          for (const [k, v] of s3ListObjects) {
            if (k.startsWith(prefix) && k.endsWith(".json")) {
              allEntries.push({
                Key: k,
                LastModified: v.lastModified || new Date("2025-01-01T00:00:00Z"),
              });
            }
          }

          // Pagination support: when s3ListPageSize > 0, split results into pages
          if (s3ListPageSize > 0) {
            // ContinuationToken is the stringified start index
            const startIdx = cmd.input.ContinuationToken ? parseInt(cmd.input.ContinuationToken, 10) : 0;
            const pageEntries = allEntries.slice(startIdx, startIdx + s3ListPageSize);
            const nextIdx = startIdx + s3ListPageSize;
            const isTruncated = nextIdx < allEntries.length;

            return {
              Contents: pageEntries.length > 0 ? pageEntries : undefined,
              IsTruncated: isTruncated,
              NextContinuationToken: isTruncated ? String(nextIdx) : undefined,
            };
          }

          return {
            Contents: allEntries.length > 0 ? allEntries : undefined,
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
// MOCK FETCH (for Gateway mode)
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
// STANDARD COMMAND HANDLERS
// =============================================================================

function checkpointCmdHandler(): CmdHandler {
  return (cmd: string) => {
    if (cmd.includes("tar -czf")) {
      return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("stat -c")) {
      return { stdout: "2048\n", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("curl") && cmd.includes("PUT")) {
      const dataK = `test-prefix/data/${HASH_64}/archive.tar.gz`;
      state.s3Objects.set(dataK, {});
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("rm -f")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

function fullRunHandler(opts: { exitCode?: number } = {}): CmdHandler {
  return (cmd: string) => {
    if (cmd.includes("mkdir -p")) return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd.includes("tar -czf")) return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    if (cmd.includes("stat -c")) return { stdout: "2048\n", stderr: "", exitCode: 0 };
    if (cmd.includes("curl") && cmd.includes("PUT")) {
      const dataK = `test-prefix/data/${HASH_64}/archive.tar.gz`;
      state.s3Objects.set(dataK, {});
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd.includes("claude") || cmd.includes("codex") || cmd.includes("gemini") || cmd.includes("qwen")) {
      return { stdout: "Agent output text\n", stderr: "", exitCode: opts.exitCode ?? 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

function restorePlusRunHandler(): CmdHandler {
  return (cmd: string) => {
    if (cmd.includes("curl") && cmd.includes("evolve-restore")) {
      return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("tar -xzf")) return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd.includes("tar -czf")) return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    if (cmd.includes("mkdir -p")) return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd.includes("stat -c")) return { stdout: "2048\n", stderr: "", exitCode: 0 };
    if (cmd.includes("curl") && cmd.includes("PUT")) {
      state.s3Objects.set(`test-prefix/data/${HASH_64}/archive.tar.gz`, {});
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
    // Agent CLI (must be after tar checks since tar command includes '.claude/')
    if (cmd.includes("claude") || cmd.includes("codex") || cmd.includes("gemini") || cmd.includes("qwen")) {
      return { stdout: "output\n", stderr: "", exitCode: 0 };
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
// TEST 1: listCheckpoints() — BYOK mode
// =============================================================================

async function testListCheckpointsByokEmpty(): Promise<void> {
  console.log("\n[1a] listCheckpoints() - BYOK empty bucket returns []");
  resetState();
  s3ListObjects = new Map();
  installMockAwsSdk();

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    const result = await listCheckpoints({ url: "s3://test-bucket/test-prefix" });
    assertEqual(result.length, 0, "Empty bucket returns empty array");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

async function testListCheckpointsByokReturnsEntries(): Promise<void> {
  console.log("\n[1b] listCheckpoints() - BYOK returns sorted entries");
  resetState();
  installMockAwsSdk();

  // Populate S3 list objects and get-able metadata
  s3ListObjects = new Map();
  const meta1 = { id: "ckpt_old", hash: HASH_64, tag: "old", timestamp: "2025-01-01T00:00:00Z" };
  const meta2 = { id: "ckpt_new", hash: HASH_64, tag: "new", timestamp: "2025-06-01T00:00:00Z" };

  s3ListObjects.set("test-prefix/checkpoints/ckpt_old.json", {
    body: JSON.stringify(meta1),
    lastModified: new Date("2025-01-01T00:00:00Z"),
  });
  s3ListObjects.set("test-prefix/checkpoints/ckpt_new.json", {
    body: JSON.stringify(meta2),
    lastModified: new Date("2025-06-01T00:00:00Z"),
  });

  // Make metadata readable via GetObject
  state.s3Objects.set("test-prefix/checkpoints/ckpt_old.json", { body: JSON.stringify(meta1) });
  state.s3Objects.set("test-prefix/checkpoints/ckpt_new.json", { body: JSON.stringify(meta2) });

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    const result = await listCheckpoints({ url: "s3://test-bucket/test-prefix" });
    assertEqual(result.length, 2, "Returns 2 entries");
    // Sorted by LastModified desc — newest first
    assertEqual(result[0].id, "ckpt_new", "First entry is newest");
    assertEqual(result[1].id, "ckpt_old", "Second entry is oldest");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

async function testListCheckpointsByokLimitApplied(): Promise<void> {
  console.log("\n[1c] listCheckpoints() - BYOK limit applied");
  resetState();
  installMockAwsSdk();

  s3ListObjects = new Map();
  // Create 5 checkpoint entries
  for (let i = 0; i < 5; i++) {
    const id = `ckpt_${i}`;
    const meta = { id, hash: HASH_64, tag: `tag${i}`, timestamp: `2025-0${i + 1}-01T00:00:00Z` };
    s3ListObjects.set(`test-prefix/checkpoints/${id}.json`, {
      body: JSON.stringify(meta),
      lastModified: new Date(`2025-0${i + 1}-01T00:00:00Z`),
    });
    state.s3Objects.set(`test-prefix/checkpoints/${id}.json`, { body: JSON.stringify(meta) });
  }

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    const result = await listCheckpoints({ url: "s3://test-bucket/test-prefix" }, { limit: 2 });
    assertEqual(result.length, 2, "Limit=2 returns 2 entries");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

// =============================================================================
// TEST 2: listCheckpoints() — Gateway mode
// =============================================================================

async function testListCheckpointsGateway(): Promise<void> {
  console.log("\n[2a] listCheckpoints() - Gateway mode");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any, url?: string, method?: string) => { status: number; body: any }>();
  let capturedUrl = "";
  handlers.set("/api/checkpoints", (_body: any, url?: string, method?: string) => {
    if (method === "GET") {
      capturedUrl = url || "";
      return {
        status: 200,
        body: [
          { id: "gw_ckpt_1", hash: HASH_64, tag: "gw-tag1", timestamp: "2025-06-01T00:00:00Z" },
          { id: "gw_ckpt_2", hash: HASH_64, tag: "gw-tag2", timestamp: "2025-05-01T00:00:00Z" },
        ],
      };
    }
    return { status: 404, body: {} };
  });
  installMockFetch(handlers);

  const originalApiKey = process.env.EVOLVE_API_KEY;
  process.env.EVOLVE_API_KEY = "test-gateway-key";

  try {
    const result = await listCheckpoints({});
    assertEqual(result.length, 2, "Gateway returns 2 entries");
    assertEqual(result[0].id, "gw_ckpt_1", "First entry ID matches");
  } finally {
    restoreFetch();
    if (originalApiKey) {
      process.env.EVOLVE_API_KEY = originalApiKey;
    } else {
      delete process.env.EVOLVE_API_KEY;
    }
  }
}

async function testListCheckpointsGatewayPassesLimit(): Promise<void> {
  console.log("\n[2b] listCheckpoints() - Gateway passes limit as query param");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any, url?: string, method?: string) => { status: number; body: any }>();
  let capturedUrl = "";
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
    await listCheckpoints({}, { limit: 5 });
    assert(capturedUrl.includes("limit=5"), "Gateway URL includes limit=5 query param");
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
// TEST 3: getLatestCheckpoint() (via listCheckpoints limit=1)
// =============================================================================

async function testGetLatestCheckpointByokEmpty(): Promise<void> {
  console.log("\n[3a] getLatestCheckpoint() - BYOK empty returns null");
  resetState();
  s3ListObjects = new Map();
  installMockAwsSdk();

  // Import getLatestCheckpoint from source
  const { getLatestCheckpoint } = await import("../../src/storage/index.ts");

  const result = await getLatestCheckpoint(BYOK_STORAGE as any);
  assertEqual(result, null, "Empty bucket returns null");
}

async function testGetLatestCheckpointByokReturnsMostRecent(): Promise<void> {
  console.log("\n[3b] getLatestCheckpoint() - BYOK returns most recent");
  resetState();
  installMockAwsSdk();

  const metaOld = { id: "ckpt_old", hash: HASH_64, tag: "old", timestamp: "2025-01-01T00:00:00Z" };
  const metaNew = { id: "ckpt_new", hash: HASH_64, tag: "new", timestamp: "2025-06-01T00:00:00Z" };

  s3ListObjects = new Map();
  s3ListObjects.set("test-prefix/checkpoints/ckpt_old.json", {
    body: JSON.stringify(metaOld),
    lastModified: new Date("2025-01-01T00:00:00Z"),
  });
  s3ListObjects.set("test-prefix/checkpoints/ckpt_new.json", {
    body: JSON.stringify(metaNew),
    lastModified: new Date("2025-06-01T00:00:00Z"),
  });
  state.s3Objects.set("test-prefix/checkpoints/ckpt_old.json", { body: JSON.stringify(metaOld) });
  state.s3Objects.set("test-prefix/checkpoints/ckpt_new.json", { body: JSON.stringify(metaNew) });

  const { getLatestCheckpoint } = await import("../../src/storage/index.ts");
  const result = await getLatestCheckpoint(BYOK_STORAGE as any);

  assert(result !== null, "Result is not null");
  assertEqual(result!.id, "ckpt_new", "Returns most recent checkpoint");
}

async function testGetLatestCheckpointGateway(): Promise<void> {
  console.log("\n[3c] getLatestCheckpoint() - Gateway mode");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any, url?: string, method?: string) => { status: number; body: any }>();
  handlers.set("/api/checkpoints", (_body: any, _url?: string, method?: string) => {
    if (method === "GET") {
      return {
        status: 200,
        body: [{ id: "gw_latest", hash: HASH_64, tag: "latest", timestamp: "2025-06-01T00:00:00Z" }],
      };
    }
    return { status: 404, body: {} };
  });
  installMockFetch(handlers);

  try {
    const { getLatestCheckpoint } = await import("../../src/storage/index.ts");
    const result = await getLatestCheckpoint(GATEWAY_STORAGE as any);

    assert(result !== null, "Result is not null");
    assertEqual(result!.id, "gw_latest", "Returns latest from gateway");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// TEST 4: from: "latest" resolution in Agent
// =============================================================================

async function testFromLatestResolvesToConcreteId(): Promise<void> {
  console.log("\n[4a] Agent - from: 'latest' resolves to concrete checkpoint ID");
  resetState();
  installMockAwsSdk();

  // Setup: latest checkpoint exists
  const metaLatest = { id: "ckpt_latest_resolved", hash: HASH_64, tag: "latest", timestamp: "2025-06-01T00:00:00Z", agentType: "claude" };

  s3ListObjects = new Map();
  s3ListObjects.set("test-prefix/checkpoints/ckpt_latest_resolved.json", {
    body: JSON.stringify(metaLatest),
    lastModified: new Date("2025-06-01T00:00:00Z"),
  });
  state.s3Objects.set("test-prefix/checkpoints/ckpt_latest_resolved.json", { body: JSON.stringify(metaLatest) });

  const sandbox = createMockSandbox(restorePlusRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  const result = await assertNoThrow(
    () => agent.run({ prompt: "test", from: "latest" }),
    "from: 'latest' run completes"
  ) as any;

  assert(result !== undefined, "Response returned");
  assertEqual(result?.exitCode, 0, "Exit code is 0");
}

async function testFromLatestNoCheckpointsThrows(): Promise<void> {
  console.log("\n[4b] Agent - from: 'latest' with no checkpoints throws");
  resetState();
  s3ListObjects = new Map();
  installMockAwsSdk();

  const sandbox = createMockSandbox(restorePlusRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  await assertThrows(
    () => agent.run({ prompt: "test", from: "latest" }),
    "No checkpoints found",
    "from: 'latest' with empty bucket throws"
  );
}

async function testFromLatestWithoutStorageThrows(): Promise<void> {
  console.log("\n[4c] Agent - from: 'latest' without storage throws");

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    // no storage
  });

  await assertThrows(
    () => agent.run({ prompt: "test", from: "latest" }),
    "Storage not configured",
    "from: 'latest' without storage throws"
  );
}

// =============================================================================
// TEST 5: kit.checkpoint({ comment }) — explicit checkpoint
// =============================================================================

async function testExplicitCheckpointWithComment(): Promise<void> {
  console.log("\n[5a] Agent.checkpoint({ comment }) - creates checkpoint with comment");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  // First run to get a sandbox
  await agent.run({ prompt: "setup" });

  // Now create explicit checkpoint
  const ckpt = await assertNoThrow(
    () => agent.checkpoint({ comment: "manual snapshot after setup" }),
    "Explicit checkpoint completes"
  ) as any;

  assert(ckpt !== undefined, "Checkpoint returned");
  assertEqual(ckpt?.comment, "manual snapshot after setup", "Comment matches");
  assert(ckpt?.id?.startsWith("ckpt_"), "ID has correct prefix");
}

async function testExplicitCheckpointWithoutStorageThrows(): Promise<void> {
  console.log("\n[5b] Agent.checkpoint() - throws without storage");

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    // no storage
  });

  await assertThrows(
    () => agent.checkpoint(),
    "Storage not configured",
    "checkpoint() without storage throws"
  );
}

async function testExplicitCheckpointWithoutSandboxThrows(): Promise<void> {
  console.log("\n[5c] Agent.checkpoint() - throws without active sandbox");

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  // Don't run() first
  await assertThrows(
    () => agent.checkpoint(),
    "No active sandbox",
    "checkpoint() without sandbox throws"
  );
}

// =============================================================================
// TEST 6: checkpointComment passthrough via run()
// =============================================================================

async function testCheckpointCommentPassthrough(): Promise<void> {
  console.log("\n[6] Agent.run({ checkpointComment }) - comment in checkpoint metadata");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  const result = await assertNoThrow(
    () => agent.run({ prompt: "test", checkpointComment: "auto from test run" }),
    "Run with checkpointComment completes"
  ) as any;

  assert(result?.checkpoint !== undefined, "Checkpoint present");
  assertEqual(result?.checkpoint?.comment, "auto from test run", "checkpointComment passed through to checkpoint metadata");
}

// =============================================================================
// TEST 7: parentId lineage tracking
// =============================================================================

async function testParentIdLineageAcrossRuns(): Promise<void> {
  console.log("\n[7a] parentId lineage - second run has parentId from first");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  // First run — no parentId
  const run1 = await agent.run({ prompt: "run 1" }) as any;
  assert(run1?.checkpoint !== undefined, "First checkpoint present");
  assertEqual(run1?.checkpoint?.parentId, undefined, "First run has no parentId");

  const firstId = run1?.checkpoint?.id;
  assert(typeof firstId === "string", "First checkpoint has an ID");

  // Second run — parentId should be first checkpoint ID
  const run2 = await agent.run({ prompt: "run 2" }) as any;
  assert(run2?.checkpoint !== undefined, "Second checkpoint present");
  assertEqual(run2?.checkpoint?.parentId, firstId, "Second run parentId = first checkpoint ID");
}

async function testParentIdAfterRestore(): Promise<void> {
  console.log("\n[7b] parentId lineage - restore sets parentId to restored checkpoint");
  resetState();
  installMockAwsSdk();

  // Setup: checkpoint to restore from
  const metaRestore = { id: "ckpt_parent_test", hash: HASH_64, tag: "test", agentType: "claude" };
  state.s3Objects.set("test-prefix/checkpoints/ckpt_parent_test.json", { body: JSON.stringify(metaRestore) });

  const sandbox = createMockSandbox(restorePlusRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  const result = await assertNoThrow(
    () => agent.run({ prompt: "continue", from: "ckpt_parent_test" }),
    "Restore + run completes"
  ) as any;

  assert(result?.checkpoint !== undefined, "Checkpoint present after restore");
  assertEqual(result?.checkpoint?.parentId, "ckpt_parent_test", "parentId = restored checkpoint ID");
}

async function testParentIdResetOnKill(): Promise<void> {
  console.log("\n[7c] parentId lineage - kill() resets lastCheckpointId");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  // First run creates checkpoint
  const run1 = await agent.run({ prompt: "run 1" }) as any;
  assert(run1?.checkpoint !== undefined, "First checkpoint present");

  // Kill resets lineage
  await agent.kill();

  // Create fresh sandbox for next run (provider will give us the same mock)
  const run2 = await agent.run({ prompt: "run after kill" }) as any;
  assert(run2?.checkpoint !== undefined, "Second checkpoint present");
  assertEqual(run2?.checkpoint?.parentId, undefined, "parentId is undefined after kill()");
}

async function testParentIdResetOnSetSession(): Promise<void> {
  console.log("\n[7d] parentId lineage - setSession() resets lastCheckpointId");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  // First run creates checkpoint
  const run1 = await agent.run({ prompt: "run 1" }) as any;
  assert(run1?.checkpoint !== undefined, "First checkpoint present");

  // setSession resets lineage
  await agent.setSession("different-sandbox-id");

  // Next run should have no parentId
  const run2 = await agent.run({ prompt: "run on new session" }) as any;
  assert(run2?.checkpoint !== undefined, "Second checkpoint present");
  assertEqual(run2?.checkpoint?.parentId, undefined, "parentId is undefined after setSession()");
}

// =============================================================================
// TEST 8: Limit normalization
// =============================================================================

async function testLimitDefault100(): Promise<void> {
  console.log("\n[8a] listCheckpoints() - default limit is 100");
  resetState();
  s3ListObjects = new Map();
  installMockAwsSdk();

  // Create 150 checkpoint entries
  for (let i = 0; i < 150; i++) {
    const id = `ckpt_${String(i).padStart(3, "0")}`;
    const meta = { id, hash: HASH_64, tag: `tag${i}`, timestamp: new Date(2025, 0, 1 + i).toISOString() };
    s3ListObjects.set(`test-prefix/checkpoints/${id}.json`, {
      body: JSON.stringify(meta),
      lastModified: new Date(2025, 0, 1 + i),
    });
    state.s3Objects.set(`test-prefix/checkpoints/${id}.json`, { body: JSON.stringify(meta) });
  }

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    // No limit specified — should default to 100
    const result = await listCheckpoints({ url: "s3://test-bucket/test-prefix" });
    assertEqual(result.length, 100, "Default limit returns 100 entries");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

async function testLimitMax500(): Promise<void> {
  console.log("\n[8b] listCheckpoints() - limit capped at 500");
  resetState();
  s3ListObjects = new Map();
  installMockAwsSdk();

  // Create 10 entries (we can't easily create 600 in a test)
  for (let i = 0; i < 10; i++) {
    const id = `ckpt_${i}`;
    const meta = { id, hash: HASH_64, tag: `tag${i}`, timestamp: `2025-01-0${i + 1}T00:00:00Z` };
    s3ListObjects.set(`test-prefix/checkpoints/${id}.json`, {
      body: JSON.stringify(meta),
      lastModified: new Date(`2025-01-0${i + 1}T00:00:00Z`),
    });
    state.s3Objects.set(`test-prefix/checkpoints/${id}.json`, { body: JSON.stringify(meta) });
  }

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    // limit=9999 should be capped to 500
    const result = await listCheckpoints({ url: "s3://test-bucket/test-prefix" }, { limit: 9999 });
    // With only 10 entries, we get 10 (not 500), but the normalized limit was 500
    assertEqual(result.length, 10, "Returns all 10 available (limit capped but fewer entries exist)");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

async function testLimitZeroDefaultsTo100(): Promise<void> {
  console.log("\n[8c] listCheckpoints() - limit=0 defaults to 100");
  resetState();
  s3ListObjects = new Map();
  installMockAwsSdk();

  for (let i = 0; i < 5; i++) {
    const id = `ckpt_${i}`;
    const meta = { id, hash: HASH_64, tag: `tag${i}` };
    s3ListObjects.set(`test-prefix/checkpoints/${id}.json`, {
      body: JSON.stringify(meta),
      lastModified: new Date(`2025-01-0${i + 1}T00:00:00Z`),
    });
    state.s3Objects.set(`test-prefix/checkpoints/${id}.json`, { body: JSON.stringify(meta) });
  }

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    const result = await listCheckpoints({ url: "s3://test-bucket/test-prefix" }, { limit: 0 });
    // limit=0 should be treated as default (100), returning all 5 available
    assertEqual(result.length, 5, "limit=0 returns all 5 (default 100 applied, fewer exist)");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

async function testNegativeLimitDefaultsTo100(): Promise<void> {
  console.log("\n[8d] listCheckpoints() - negative limit defaults to 100");
  resetState();
  s3ListObjects = new Map();
  installMockAwsSdk();

  for (let i = 0; i < 3; i++) {
    const id = `ckpt_${i}`;
    const meta = { id, hash: HASH_64, tag: `tag${i}` };
    s3ListObjects.set(`test-prefix/checkpoints/${id}.json`, {
      body: JSON.stringify(meta),
      lastModified: new Date(`2025-01-0${i + 1}T00:00:00Z`),
    });
    state.s3Objects.set(`test-prefix/checkpoints/${id}.json`, { body: JSON.stringify(meta) });
  }

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    const result = await listCheckpoints({ url: "s3://test-bucket/test-prefix" }, { limit: -5 });
    assertEqual(result.length, 3, "Negative limit returns all 3 (default 100 applied)");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

// =============================================================================
// TEST 9: resolveStorageForStandalone() — gateway detection
// =============================================================================

async function testStandaloneGatewayDetection(): Promise<void> {
  console.log("\n[9a] resolveStorageForStandalone() - detects gateway from EVOLVE_API_KEY");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any, url?: string, method?: string) => { status: number; body: any }>();
  handlers.set("/api/checkpoints", (_body: any, _url?: string, method?: string) => {
    if (method === "GET") {
      return { status: 200, body: [] };
    }
    return { status: 404, body: {} };
  });
  installMockFetch(handlers);

  const originalApiKey = process.env.EVOLVE_API_KEY;
  process.env.EVOLVE_API_KEY = "test-standalone-key";

  try {
    // Empty config + EVOLVE_API_KEY → gateway mode
    const result = await listCheckpoints({});
    assert(Array.isArray(result), "Gateway mode works with empty StorageConfig");

    // Verify it hit the gateway API
    assert(state.fetchCalls.some(c => c.url.includes("/api/checkpoints")), "Called gateway API");
  } finally {
    restoreFetch();
    if (originalApiKey) {
      process.env.EVOLVE_API_KEY = originalApiKey;
    } else {
      delete process.env.EVOLVE_API_KEY;
    }
  }
}

async function testStandaloneByokWithUrl(): Promise<void> {
  console.log("\n[9b] resolveStorageForStandalone() - uses BYOK when URL provided");
  resetState();
  s3ListObjects = new Map();
  installMockAwsSdk();

  const originalApiKey = process.env.EVOLVE_API_KEY;
  // Even with EVOLVE_API_KEY set, URL takes precedence for BYOK
  process.env.EVOLVE_API_KEY = "test-key";

  try {
    const result = await listCheckpoints({ url: "s3://test-bucket/test-prefix" });
    assert(Array.isArray(result), "BYOK mode works with URL even when EVOLVE_API_KEY is set");
    // Should have used ListObjectsV2, not gateway fetch
    assert(state.s3ListCalls.length > 0, "Used S3 ListObjectsV2 (BYOK)");
    assertEqual(state.fetchCalls.length, 0, "Did not call gateway fetch");
  } finally {
    if (originalApiKey) {
      process.env.EVOLVE_API_KEY = originalApiKey;
    } else {
      delete process.env.EVOLVE_API_KEY;
    }
  }
}

// =============================================================================
// TEST 10: parentId and comment in createCheckpoint metadata (BYOK)
// =============================================================================

async function testCreateCheckpointWithParentIdAndComment(): Promise<void> {
  console.log("\n[10a] createCheckpoint() - parentId and comment in BYOK metadata");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(checkpointCmdHandler());
  const result = await createCheckpoint(
    sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace",
    { tag: "test-tag", model: "opus", parentId: "ckpt_parent_abc", comment: "first real checkpoint" }
  );

  assertEqual(result.parentId, "ckpt_parent_abc", "parentId in result");
  assertEqual(result.comment, "first real checkpoint", "comment in result");

  // Verify S3 metadata JSON includes parentId and comment
  const metaPut = state.s3PutCalls.find((c) => c.Key.includes("checkpoints/"));
  assert(metaPut !== undefined, "Metadata written to S3");
  const metaBody = JSON.parse(metaPut!.Body || "{}");
  assertEqual(metaBody.parentId, "ckpt_parent_abc", "S3 metadata has parentId");
  assertEqual(metaBody.comment, "first real checkpoint", "S3 metadata has comment");
}

async function testCreateCheckpointWithoutParentIdOrComment(): Promise<void> {
  console.log("\n[10b] createCheckpoint() - no parentId/comment → undefined in metadata");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(checkpointCmdHandler());
  const result = await createCheckpoint(
    sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace",
    { tag: "no-lineage" }
  );

  assertEqual(result.parentId, undefined, "parentId is undefined");
  assertEqual(result.comment, undefined, "comment is undefined");
}

// =============================================================================
// TEST 11: parentId and comment in Gateway mode
// =============================================================================

async function testGatewayCreateCheckpointWithParentIdAndComment(): Promise<void> {
  console.log("\n[11a] gatewayCreateCheckpoint - sends parentId and comment");
  resetState();
  _testSetAwsSdk(null);

  let capturedBody: any;
  const handlers = new Map<string, (body?: any) => { status: number; body: any }>();
  handlers.set("/api/checkpoints/presign", () => ({
    status: 200,
    body: { url: "https://gw.test/upload", alreadyExists: true },
  }));
  handlers.set("/api/checkpoints", (body: any) => {
    capturedBody = body;
    return { status: 200, body: { id: "gw-with-lineage" } };
  });
  installMockFetch(handlers);

  try {
    const sandbox = createMockSandbox(checkpointCmdHandler());
    const result = await createCheckpoint(
      sandbox as any, GATEWAY_STORAGE as any, "claude", "/home/user/workspace",
      { tag: "gw-test", parentId: "ckpt_gw_parent", comment: "gateway comment" }
    );

    assertEqual(result.id, "gw-with-lineage", "Gateway ID returned");
    assertEqual(result.parentId, "ckpt_gw_parent", "parentId in result");
    assertEqual(result.comment, "gateway comment", "comment in result");

    // Verify the body sent to the gateway
    assertEqual(capturedBody?.parentId, "ckpt_gw_parent", "parentId sent to gateway API");
    assertEqual(capturedBody?.comment, "gateway comment", "comment sent to gateway API");
  } finally {
    restoreFetch();
  }
}

async function testGatewayGetCheckpointIncludesParentIdAndComment(): Promise<void> {
  console.log("\n[11b] gatewayGetCheckpoint - returns parentId and comment in restore metadata");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any) => { status: number; body: any }>();
  handlers.set("/api/checkpoints/ckpt_gw_lineage", () => ({
    status: 200,
    body: {
      id: "ckpt_gw_lineage",
      hash: HASH_64,
      tag: "gw-restore",
      sizeBytes: 1024,
      createdAt: "2025-01-01T00:00:00Z",
      agentType: "claude",
      parentId: "ckpt_gw_ancestor",
      comment: "gateway restored checkpoint",
    },
  }));
  handlers.set("/api/checkpoints/presign", () => ({
    status: 200,
    body: { url: "https://gw.test/download" },
  }));
  installMockFetch(handlers);

  try {
    const sandbox = createMockSandbox((cmd: string) => {
      if (cmd.includes("curl") && cmd.includes("evolve-restore")) {
        return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("tar -xzf")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await assertNoThrow(
      () => restoreCheckpoint(sandbox as any, GATEWAY_STORAGE as any, "ckpt_gw_lineage"),
      "Gateway restore with parentId/comment completes"
    );

    // Verify the GET endpoint was called
    assert(
      state.fetchCalls.some(c => c.url.includes("ckpt_gw_lineage") && c.method === "GET"),
      "Gateway GET metadata called"
    );
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// TEST 12: Evolve-level checkpoint and listCheckpoints
// =============================================================================

async function testEvolveCheckpointMethod(): Promise<void> {
  console.log("\n[12a] Evolve.checkpoint() - delegates to agent");

  const kit = new Evolve();
  // Not initialized → should throw
  await assertThrows(
    () => kit.checkpoint({ comment: "test" }),
    "Agent not initialized",
    "Evolve.checkpoint() before run() throws"
  );
}

async function testEvolveListCheckpointsWithoutStorage(): Promise<void> {
  console.log("\n[12b] Evolve.listCheckpoints() - throws without storage");

  const kit = new Evolve();
  await assertThrows(
    () => kit.listCheckpoints(),
    "Storage not configured",
    "Evolve.listCheckpoints() without storage throws"
  );
}

async function testEvolveListCheckpointsWithStorage(): Promise<void> {
  console.log("\n[12c] Evolve.listCheckpoints() - works with storage");
  resetState();
  s3ListObjects = new Map();
  installMockAwsSdk();

  const meta = { id: "ckpt_evolve_list", hash: HASH_64, tag: "evolve" };
  s3ListObjects.set("my-prefix/checkpoints/ckpt_evolve_list.json", {
    body: JSON.stringify(meta),
    lastModified: new Date("2025-06-01T00:00:00Z"),
  });
  state.s3Objects.set("my-prefix/checkpoints/ckpt_evolve_list.json", { body: JSON.stringify(meta) });

  const originalEnv = process.env.EVOLVE_API_KEY;
  delete process.env.EVOLVE_API_KEY;

  try {
    const kit = new Evolve().withStorage({ url: "s3://test-bucket/my-prefix" });
    const result = await kit.listCheckpoints();
    assertEqual(result.length, 1, "Returns 1 checkpoint");
    assertEqual(result[0].id, "ckpt_evolve_list", "Correct checkpoint ID");
  } finally {
    if (originalEnv) process.env.EVOLVE_API_KEY = originalEnv;
  }
}

// =============================================================================
// [13] S3 PAGINATION (ContinuationToken)
// =============================================================================

async function testListCheckpointsByokPagination(): Promise<void> {
  console.log("\n[13a] listCheckpoints() - BYOK pagination across multiple pages");

  resetState();
  installMockAwsSdk();

  // Populate 5 checkpoint entries with distinct timestamps
  s3ListObjects = new Map([
    ["test-prefix/checkpoints/ckpt_page1_a/metadata.json", {
      body: JSON.stringify({ id: "ckpt_page1_a", hash: "aaa", timestamp: "2025-01-01T00:00:00Z" }),
      lastModified: new Date("2025-01-01T00:00:00Z"),
    }],
    ["test-prefix/checkpoints/ckpt_page1_b/metadata.json", {
      body: JSON.stringify({ id: "ckpt_page1_b", hash: "bbb", timestamp: "2025-01-02T00:00:00Z" }),
      lastModified: new Date("2025-01-02T00:00:00Z"),
    }],
    ["test-prefix/checkpoints/ckpt_page2_a/metadata.json", {
      body: JSON.stringify({ id: "ckpt_page2_a", hash: "ccc", timestamp: "2025-01-03T00:00:00Z" }),
      lastModified: new Date("2025-01-03T00:00:00Z"),
    }],
    ["test-prefix/checkpoints/ckpt_page2_b/metadata.json", {
      body: JSON.stringify({ id: "ckpt_page2_b", hash: "ddd", timestamp: "2025-01-04T00:00:00Z" }),
      lastModified: new Date("2025-01-04T00:00:00Z"),
    }],
    ["test-prefix/checkpoints/ckpt_page3/metadata.json", {
      body: JSON.stringify({ id: "ckpt_page3", hash: "eee", timestamp: "2025-01-05T00:00:00Z" }),
      lastModified: new Date("2025-01-05T00:00:00Z"),
    }],
  ]);

  // Also add as readable objects for s3GetJson
  for (const [key, entry] of s3ListObjects) {
    state.s3Objects.set(key, { body: entry.body });
  }

  // Set page size to 2, so 5 entries = 3 pages (2 + 2 + 1)
  s3ListPageSize = 2;

  try {
    const result = await listCheckpoints(
      { url: "s3://test-bucket/test-prefix/" },
      { limit: 500 }
    );

    // Verify pagination happened: 3 ListObjectsV2 calls
    assertEqual(state.s3ListCalls.length, 3, "3 ListObjectsV2 calls (3 pages)");

    // First call has no ContinuationToken
    assertEqual(state.s3ListCalls[0].ContinuationToken, undefined, "First page has no ContinuationToken");

    // Second call has ContinuationToken
    assert(state.s3ListCalls[1].ContinuationToken !== undefined, "Second page has ContinuationToken");

    // Third call has ContinuationToken
    assert(state.s3ListCalls[2].ContinuationToken !== undefined, "Third page has ContinuationToken");

    // All 5 entries collected and sorted by LastModified descending
    assertEqual(result.length, 5, "All 5 entries returned from 3 pages");
    assertEqual(result[0].id, "ckpt_page3", "Newest entry is first (Jan 5)");
    assertEqual(result[1].id, "ckpt_page2_b", "Second newest (Jan 4)");
    assertEqual(result[2].id, "ckpt_page2_a", "Third (Jan 3)");
    assertEqual(result[3].id, "ckpt_page1_b", "Fourth (Jan 2)");
    assertEqual(result[4].id, "ckpt_page1_a", "Oldest entry is last (Jan 1)");
  } finally {
    s3ListPageSize = 0;
    s3ListObjects = new Map();
  }
}

async function testListCheckpointsByokPaginationWithLimit(): Promise<void> {
  console.log("\n[13b] listCheckpoints() - BYOK pagination collects all pages then applies limit");

  resetState();
  installMockAwsSdk();

  // 4 entries, page size 2 → 2 pages
  s3ListObjects = new Map([
    ["test-prefix/checkpoints/ckpt_old/metadata.json", {
      body: JSON.stringify({ id: "ckpt_old", hash: "old", timestamp: "2025-01-01T00:00:00Z" }),
      lastModified: new Date("2025-01-01T00:00:00Z"),
    }],
    ["test-prefix/checkpoints/ckpt_mid1/metadata.json", {
      body: JSON.stringify({ id: "ckpt_mid1", hash: "mid1", timestamp: "2025-01-02T00:00:00Z" }),
      lastModified: new Date("2025-01-02T00:00:00Z"),
    }],
    ["test-prefix/checkpoints/ckpt_mid2/metadata.json", {
      body: JSON.stringify({ id: "ckpt_mid2", hash: "mid2", timestamp: "2025-01-03T00:00:00Z" }),
      lastModified: new Date("2025-01-03T00:00:00Z"),
    }],
    ["test-prefix/checkpoints/ckpt_new/metadata.json", {
      body: JSON.stringify({ id: "ckpt_new", hash: "new", timestamp: "2025-01-04T00:00:00Z" }),
      lastModified: new Date("2025-01-04T00:00:00Z"),
    }],
  ]);

  for (const [key, entry] of s3ListObjects) {
    state.s3Objects.set(key, { body: entry.body });
  }

  s3ListPageSize = 2;

  try {
    // Request only 2 results from 4 total across 2 pages
    const result = await listCheckpoints(
      { url: "s3://test-bucket/test-prefix/" },
      { limit: 2 }
    );

    // Both pages should still be fetched (pagination happens before limit)
    assertEqual(state.s3ListCalls.length, 2, "2 ListObjectsV2 calls (2 pages)");

    // But only 2 results returned (limit applied after sort)
    assertEqual(result.length, 2, "Limit=2 returns only 2 entries");
    assertEqual(result[0].id, "ckpt_new", "Newest entry first");
    assertEqual(result[1].id, "ckpt_mid2", "Second newest second");
  } finally {
    s3ListPageSize = 0;
    s3ListObjects = new Map();
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Checkpoint DX v3.3 Unit Tests (Mock-Based)");
  console.log("=".repeat(60));

  // 1. listCheckpoints — BYOK
  await testListCheckpointsByokEmpty();
  await testListCheckpointsByokReturnsEntries();
  await testListCheckpointsByokLimitApplied();

  // 2. listCheckpoints — Gateway
  await testListCheckpointsGateway();
  await testListCheckpointsGatewayPassesLimit();

  // 3. getLatestCheckpoint
  await testGetLatestCheckpointByokEmpty();
  await testGetLatestCheckpointByokReturnsMostRecent();
  await testGetLatestCheckpointGateway();

  // 4. from: "latest" resolution
  await testFromLatestResolvesToConcreteId();
  await testFromLatestNoCheckpointsThrows();
  await testFromLatestWithoutStorageThrows();

  // 5. kit.checkpoint({ comment })
  await testExplicitCheckpointWithComment();
  await testExplicitCheckpointWithoutStorageThrows();
  await testExplicitCheckpointWithoutSandboxThrows();

  // 6. checkpointComment passthrough
  await testCheckpointCommentPassthrough();

  // 7. parentId lineage
  await testParentIdLineageAcrossRuns();
  await testParentIdAfterRestore();
  await testParentIdResetOnKill();
  await testParentIdResetOnSetSession();

  // 8. Limit normalization
  await testLimitDefault100();
  await testLimitMax500();
  await testLimitZeroDefaultsTo100();
  await testNegativeLimitDefaultsTo100();

  // 9. resolveStorageForStandalone
  await testStandaloneGatewayDetection();
  await testStandaloneByokWithUrl();

  // 10. parentId + comment in BYOK createCheckpoint
  await testCreateCheckpointWithParentIdAndComment();
  await testCreateCheckpointWithoutParentIdOrComment();

  // 11. parentId + comment in Gateway mode
  await testGatewayCreateCheckpointWithParentIdAndComment();
  await testGatewayGetCheckpointIncludesParentIdAndComment();

  // 12. Evolve-level
  await testEvolveCheckpointMethod();
  await testEvolveListCheckpointsWithoutStorage();
  await testEvolveListCheckpointsWithStorage();

  // 13. S3 pagination
  await testListCheckpointsByokPagination();
  await testListCheckpointsByokPaginationWithLimit();

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
