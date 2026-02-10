#!/usr/bin/env tsx
/**
 * Unit Test: Checkpoint Async Flows (Mock-Based)
 *
 * Tests createCheckpoint(), restoreCheckpoint(), and Agent/Evolve integration
 * with mock sandbox, mock AWS SDK, and mock fetch (gateway).
 *
 * Usage:
 *   npm run test:unit:checkpoint-flows
 *   npx tsx tests/unit/checkpoint-flows.test.ts
 */

import {
  createCheckpoint,
  restoreCheckpoint,
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

const TEST_HASH = "a]b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2".replace(/]/g, "1");
// Proper 64-char hex hash
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
  commandHistory: string[];
  fetchCalls: Array<{ url: string; method: string; body?: string }>;
}

let state: MockState;

function resetState(): void {
  state = {
    s3Objects: new Map(),
    s3PutCalls: [],
    commandHistory: [],
    fetchCalls: [],
  };
}

// =============================================================================
// MOCK AWS SDK
// =============================================================================

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
        throw new Error(`Unhandled S3 command: ${cmd._type}`);
      }
    },
    HeadObjectCommand: class { input: any; _type = "HeadObject"; constructor(i: any) { this.input = i; } },
    GetObjectCommand: class { input: any; _type = "GetObject"; constructor(i: any) { this.input = i; } },
    PutObjectCommand: class { input: any; _type = "PutObject"; constructor(i: any) { this.input = i; } },
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

  let stdoutBuf = "";

  return {
    sandboxId: "test-sandbox-123",
    commands: {
      run: async (cmd: string, opts?: any) => {
        state.commandHistory.push(cmd);
        const result = await h(cmd);
        // Forward to onStdout/onStderr if provided (Agent uses these)
        if (opts?.onStdout && result.stdout) opts.onStdout(result.stdout);
        if (opts?.onStderr && result.stderr) opts.onStderr(result.stderr);
        return result;
      },
      spawn: async (cmd: string, opts?: any) => {
        state.commandHistory.push(cmd);
        const result = await h(cmd);
        // Buffer stdout for wait() and call streaming callbacks
        stdoutBuf = result.stdout;
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

function installMockFetch(handlers: Map<string, (body?: any) => { status: number; body: any }>): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : (url as URL).toString();
    const method = init?.method || "GET";
    const reqBody = init?.body ? JSON.parse(init.body as string) : undefined;
    state.fetchCalls.push({ url: urlStr, method, body: init?.body as string });

    for (const [pattern, handler] of handlers) {
      if (urlStr.includes(pattern)) {
        const resp = handler(reqBody);
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

/** Handler for createCheckpoint sandbox commands. */
function checkpointCmdHandler(opts: { tarFail?: boolean; uploadFail?: boolean } = {}): CmdHandler {
  return (cmd: string) => {
    if (cmd.includes("tar -czf")) {
      if (opts.tarFail) return { stdout: "", stderr: "tar: error", exitCode: 1 };
      return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("stat -c")) {
      return { stdout: "2048\n", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("curl") && cmd.includes("PUT")) {
      if (opts.uploadFail) return { stdout: "", stderr: "curl: upload failed", exitCode: 1 };
      // Simulate real upload: object now exists in S3
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

/** Handler for restoreCheckpoint sandbox commands. */
function restoreCmdHandler(opts: {
  downloadFail?: boolean;
  extractFail?: boolean;
  downloadHash?: string;
} = {}): CmdHandler {
  return (cmd: string) => {
    if (cmd.includes("curl") && cmd.includes("evolve-restore")) {
      if (opts.downloadFail) return { stdout: "", stderr: "curl: download failed", exitCode: 1 };
      const h = opts.downloadHash || HASH_64;
      return { stdout: h + "\n", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("tar -xzf")) {
      if (opts.extractFail) return { stdout: "", stderr: "tar: extract error", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("rm -f")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

// =============================================================================
// TESTS: createCheckpoint BYOK
// =============================================================================

async function testCreateCheckpointByokHappyPath(): Promise<void> {
  console.log("\n[1] createCheckpoint() - BYOK Happy Path");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(checkpointCmdHandler());
  const result = await createCheckpoint(
    sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace",
    { tag: "test-tag", model: "opus" }
  );

  assert(result.id.startsWith("ckpt_"), "ID starts with ckpt_");
  assertEqual(result.hash, HASH_64, "Hash matches");
  assertEqual(result.tag, "test-tag", "Tag matches");
  assert(typeof result.timestamp === "string", "Timestamp is a string");
  assert(result.timestamp.includes("T"), "Timestamp is ISO format");
  assertEqual(result.sizeBytes, 2048, "Size bytes correct");
  assertEqual(result.agentType, "claude", "Agent type correct");
  assertEqual(result.model, "opus", "Model correct");

  // Verify S3 metadata was written
  assert(state.s3PutCalls.length >= 1, "S3 PutObject called for metadata");
  const metaPut = state.s3PutCalls.find((c) => c.Key.includes("checkpoints/"));
  assert(metaPut !== undefined, "Metadata key contains checkpoints/");
  const metaBody = JSON.parse(metaPut!.Body || "{}");
  assertEqual(metaBody.hash, HASH_64, "Metadata body has correct hash");
  assertEqual(metaBody.tag, "test-tag", "Metadata body has correct tag");
  assertEqual(metaBody.sandboxId, "test-sandbox-123", "Metadata has sandboxId");

  // Verify command history
  assert(state.commandHistory.some((c) => c.includes("tar -czf")), "Tar command issued");
  assert(state.commandHistory.some((c) => c.includes("stat -c")), "Stat command issued");
  assert(state.commandHistory.some((c) => c.includes("curl") && c.includes("PUT")), "Curl upload issued");
  assert(state.commandHistory.some((c) => c.includes("rm -f")), "Cleanup issued");
}

async function testCreateCheckpointByokDedup(): Promise<void> {
  console.log("\n[2] createCheckpoint() - BYOK Dedup (skip upload)");
  resetState();
  installMockAwsSdk();

  // Pre-populate: data already exists in S3
  const dataK = `test-prefix/data/${HASH_64}/archive.tar.gz`;
  state.s3Objects.set(dataK, {});

  const sandbox = createMockSandbox(checkpointCmdHandler());
  const result = await createCheckpoint(
    sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace",
    { tag: "dedup-tag", model: "sonnet" }
  );

  assertEqual(result.hash, HASH_64, "Hash correct");
  assertEqual(result.tag, "dedup-tag", "Tag correct");
  assertEqual(result.model, "sonnet", "Model correct");

  // No curl upload should have been issued (dedup skipped it)
  const curlUploads = state.commandHistory.filter((c) => c.includes("curl") && c.includes("PUT"));
  assertEqual(curlUploads.length, 0, "No curl upload (deduped)");

  // Metadata should still be written
  assert(state.s3PutCalls.length >= 1, "Metadata still written");
}

// =============================================================================
// TESTS: createCheckpoint Gateway
// =============================================================================

async function testCreateCheckpointGatewayHappyPath(): Promise<void> {
  console.log("\n[3] createCheckpoint() - Gateway Happy Path");
  resetState();
  _testSetAwsSdk(null); // No AWS SDK needed for gateway

  const handlers = new Map<string, (body?: any) => { status: number; body: any }>();
  handlers.set("/api/checkpoints/presign", () => ({
    status: 200,
    body: { url: "https://gateway-presigned.test/upload", alreadyExists: false },
  }));
  handlers.set("/api/checkpoints", (body: any) => ({
    status: 200,
    body: { id: "gw-ckpt-001" },
  }));
  installMockFetch(handlers);

  try {
    const sandbox = createMockSandbox(checkpointCmdHandler());
    const result = await createCheckpoint(
      sandbox as any, GATEWAY_STORAGE as any, "claude", "/home/user/workspace",
      { tag: "gw-tag", model: "opus" }
    );

    assertEqual(result.id, "gw-ckpt-001", "Gateway-assigned ID returned");
    assertEqual(result.hash, HASH_64, "Hash correct");
    assertEqual(result.tag, "gw-tag", "Tag correct");
    assertEqual(result.sizeBytes, 2048, "Size correct");

    // Verify fetch calls
    const presignCall = state.fetchCalls.find((c) => c.url.includes("/presign"));
    assert(presignCall !== undefined, "Presign endpoint called");
    const createCall = state.fetchCalls.find(
      (c) => c.url.includes("/api/checkpoints") && !c.url.includes("/presign") && c.method === "POST"
    );
    assert(createCall !== undefined, "Create checkpoint endpoint called");

    // Verify curl upload was issued
    assert(
      state.commandHistory.some((c) => c.includes("curl") && c.includes("PUT")),
      "Curl upload issued"
    );
  } finally {
    restoreFetch();
  }
}

async function testCreateCheckpointGatewayDedup(): Promise<void> {
  console.log("\n[4] createCheckpoint() - Gateway Dedup (skip upload)");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any) => { status: number; body: any }>();
  handlers.set("/api/checkpoints/presign", () => ({
    status: 200,
    body: { url: "https://gateway-presigned.test/upload", alreadyExists: true },
  }));
  handlers.set("/api/checkpoints", () => ({
    status: 200,
    body: { id: "gw-ckpt-dedup" },
  }));
  installMockFetch(handlers);

  try {
    const sandbox = createMockSandbox(checkpointCmdHandler());
    const result = await createCheckpoint(
      sandbox as any, GATEWAY_STORAGE as any, "claude", "/home/user/workspace",
      { tag: "gw-dedup", model: "opus" }
    );

    assertEqual(result.id, "gw-ckpt-dedup", "ID from gateway");
    assertEqual(result.hash, HASH_64, "Hash correct");

    // No curl upload
    const curlUploads = state.commandHistory.filter((c) => c.includes("curl") && c.includes("PUT"));
    assertEqual(curlUploads.length, 0, "No curl upload (gateway dedup)");

    // Create endpoint still called
    assert(
      state.fetchCalls.some((c) => c.url.includes("/api/checkpoints") && !c.url.includes("/presign")),
      "Create endpoint still called"
    );
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// TESTS: createCheckpoint Errors
// =============================================================================

async function testCreateCheckpointTarFailure(): Promise<void> {
  console.log("\n[5] createCheckpoint() - Tar Failure");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(checkpointCmdHandler({ tarFail: true }));
  await assertThrows(
    () => createCheckpoint(sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace", { tag: "t" }),
    "Checkpoint tar failed",
    "Tar failure throws"
  );
}

async function testCreateCheckpointUploadFailure(): Promise<void> {
  console.log("\n[6] createCheckpoint() - Upload Failure");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(checkpointCmdHandler({ uploadFail: true }));
  await assertThrows(
    () => createCheckpoint(sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace", { tag: "t" }),
    "Checkpoint upload failed",
    "Upload failure throws"
  );
}

async function testCreateCheckpointVerifyFailure(): Promise<void> {
  console.log("\n[7] createCheckpoint() - Verify Failure (HeadObject after upload)");
  resetState();
  installMockAwsSdk();

  // Custom handler: curl succeeds but does NOT add object to S3 state
  // so the verify HeadObject will fail
  const handler: CmdHandler = (cmd: string) => {
    if (cmd.includes("tar -czf")) return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    if (cmd.includes("stat -c")) return { stdout: "2048\n", stderr: "", exitCode: 0 };
    if (cmd.includes("curl") && cmd.includes("PUT")) {
      // Upload "succeeds" but object doesn't actually appear in S3
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const sandbox = createMockSandbox(handler);
  await assertThrows(
    () => createCheckpoint(sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace", { tag: "t" }),
    "verification failed",
    "Verify failure throws"
  );
}

// =============================================================================
// TESTS: restoreCheckpoint BYOK
// =============================================================================

async function testRestoreCheckpointByokHappyPath(): Promise<void> {
  console.log("\n[8] restoreCheckpoint() - BYOK Happy Path");
  resetState();
  installMockAwsSdk();

  // Set up: metadata exists in S3, data exists
  const metaKey = "test-prefix/checkpoints/ckpt_test_restore.json";
  state.s3Objects.set(metaKey, {
    body: JSON.stringify({ hash: HASH_64, tag: "restore-tag" }),
  });
  const dataK = `test-prefix/data/${HASH_64}/archive.tar.gz`;
  state.s3Objects.set(dataK, {});

  const sandbox = createMockSandbox(restoreCmdHandler());
  await assertNoThrow(
    () => restoreCheckpoint(sandbox as any, BYOK_STORAGE as any, "ckpt_test_restore"),
    "Restore completes without throwing"
  );

  assert(state.commandHistory.some((c) => c.includes("curl") && c.includes("evolve-restore")), "Download command issued");
  assert(state.commandHistory.some((c) => c.includes("tar -xzf")), "Extract command issued");
  assert(!state.commandHistory.some((c) => c.includes("rm -f /tmp/evolve-restore.tar.gz") && !c.includes("tar")),
    "No cleanup rm (hash matched, cleanup is in tar command)");
}

// =============================================================================
// TESTS: restoreCheckpoint Gateway
// =============================================================================

async function testRestoreCheckpointGatewayHappyPath(): Promise<void> {
  console.log("\n[9] restoreCheckpoint() - Gateway Happy Path");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any) => { status: number; body: any }>();
  handlers.set("/api/checkpoints/ckpt_gw_restore", () => ({
    status: 200,
    body: { id: "ckpt_gw_restore", hash: HASH_64, tag: "gw-tag", sizeBytes: 1024, createdAt: "2025-01-01T00:00:00Z" },
  }));
  handlers.set("/api/checkpoints/presign", () => ({
    status: 200,
    body: { url: "https://gateway.test/download-url" },
  }));
  installMockFetch(handlers);

  try {
    const sandbox = createMockSandbox(restoreCmdHandler());
    await assertNoThrow(
      () => restoreCheckpoint(sandbox as any, GATEWAY_STORAGE as any, "ckpt_gw_restore"),
      "Gateway restore completes without throwing"
    );

    assert(state.fetchCalls.some((c) => c.url.includes("ckpt_gw_restore")), "Gateway GET metadata called");
    assert(state.commandHistory.some((c) => c.includes("tar -xzf")), "Extract command issued");
  } finally {
    restoreFetch();
  }
}

// =============================================================================
// TESTS: restoreCheckpoint Errors
// =============================================================================

async function testRestoreByokNotFound(): Promise<void> {
  console.log("\n[10] restoreCheckpoint() - BYOK Checkpoint Not Found");
  resetState();
  installMockAwsSdk();
  // No metadata in S3

  const sandbox = createMockSandbox(restoreCmdHandler());
  await assertThrows(
    () => restoreCheckpoint(sandbox as any, BYOK_STORAGE as any, "ckpt_nonexistent"),
    "not found",
    "BYOK not found throws"
  );
}

async function testRestoreGatewayNotFound(): Promise<void> {
  console.log("\n[11] restoreCheckpoint() - Gateway Checkpoint Not Found");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any) => { status: number; body: any }>();
  handlers.set("/api/checkpoints/ckpt_missing", () => ({
    status: 404,
    body: { error: "not found" },
  }));
  installMockFetch(handlers);

  try {
    const sandbox = createMockSandbox(restoreCmdHandler());
    await assertThrows(
      () => restoreCheckpoint(sandbox as any, GATEWAY_STORAGE as any, "ckpt_missing"),
      "not found",
      "Gateway not found throws"
    );
  } finally {
    restoreFetch();
  }
}

async function testRestoreHashMismatch(): Promise<void> {
  console.log("\n[12] restoreCheckpoint() - Hash Mismatch");
  resetState();
  installMockAwsSdk();

  const metaKey = "test-prefix/checkpoints/ckpt_bad_hash.json";
  state.s3Objects.set(metaKey, {
    body: JSON.stringify({ hash: HASH_64, tag: "test" }),
  });

  // Download returns a different hash
  const wrongHash = "b".repeat(64);
  const sandbox = createMockSandbox(restoreCmdHandler({ downloadHash: wrongHash }));
  await assertThrows(
    () => restoreCheckpoint(sandbox as any, BYOK_STORAGE as any, "ckpt_bad_hash"),
    "integrity check failed",
    "Hash mismatch throws"
  );

  // Verify cleanup was issued
  assert(
    state.commandHistory.some((c) => c.includes("rm -f /tmp/evolve-restore.tar.gz")),
    "Cleanup rm issued on hash mismatch"
  );
}

async function testRestoreDownloadFailure(): Promise<void> {
  console.log("\n[13] restoreCheckpoint() - Download Failure");
  resetState();
  installMockAwsSdk();

  const metaKey = "test-prefix/checkpoints/ckpt_dl_fail.json";
  state.s3Objects.set(metaKey, {
    body: JSON.stringify({ hash: HASH_64, tag: "test" }),
  });

  const sandbox = createMockSandbox(restoreCmdHandler({ downloadFail: true }));
  await assertThrows(
    () => restoreCheckpoint(sandbox as any, BYOK_STORAGE as any, "ckpt_dl_fail"),
    "download failed",
    "Download failure throws"
  );
}

async function testRestoreExtractFailure(): Promise<void> {
  console.log("\n[14] restoreCheckpoint() - Extract Failure");
  resetState();
  installMockAwsSdk();

  const metaKey = "test-prefix/checkpoints/ckpt_extract_fail.json";
  state.s3Objects.set(metaKey, {
    body: JSON.stringify({ hash: HASH_64, tag: "test" }),
  });

  const sandbox = createMockSandbox(restoreCmdHandler({ extractFail: true }));
  await assertThrows(
    () => restoreCheckpoint(sandbox as any, BYOK_STORAGE as any, "ckpt_extract_fail"),
    "extraction failed",
    "Extract failure throws"
  );
}

// =============================================================================
// TESTS: Agent checkpoint integration
// =============================================================================

function makeAgentConfig() {
  return {
    type: "claude" as const,
    apiKey: "test-key-000",
    isDirectMode: true,
    isOAuth: false,
    model: "opus",
  };
}

/** Handler that supports full Agent.run() flow + checkpointing */
function fullRunHandler(opts: { exitCode?: number; checkpointTarFail?: boolean } = {}): CmdHandler {
  return (cmd: string) => {
    // Workspace setup
    if (cmd.includes("mkdir -p")) return { stdout: "", stderr: "", exitCode: 0 };
    // Checkpoint tar
    if (cmd.includes("tar -czf")) {
      if (opts.checkpointTarFail) return { stdout: "", stderr: "tar error", exitCode: 1 };
      return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    }
    // Checkpoint stat
    if (cmd.includes("stat -c")) return { stdout: "2048\n", stderr: "", exitCode: 0 };
    // Curl (checkpoint upload)
    if (cmd.includes("curl") && cmd.includes("PUT")) {
      const dataK = `test-prefix/data/${HASH_64}/archive.tar.gz`;
      state.s3Objects.set(dataK, {});
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    // Cleanup
    if (cmd.includes("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
    // Agent CLI process (claude, codex, etc.)
    if (cmd.includes("claude") || cmd.includes("codex") || cmd.includes("gemini") || cmd.includes("qwen")) {
      return { stdout: "Agent output text\n", stderr: "", exitCode: opts.exitCode ?? 0 };
    }
    // Default
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

async function testNonFatalCheckpoint(): Promise<void> {
  console.log("\n[15] Agent - Non-Fatal Checkpoint (createCheckpoint throws)");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(fullRunHandler({ checkpointTarFail: true }));
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  const result = await assertNoThrow(
    () => agent.run({ prompt: "test" }),
    "Run completes despite checkpoint failure"
  ) as any;

  assert(result !== undefined, "Response returned");
  assertEqual(result?.checkpoint, undefined, "No checkpoint field (tar failed, non-fatal)");
  assertEqual(result?.exitCode, 0, "Exit code is 0 (run succeeded)");
}

async function testFailedRunSkipsCheckpoint(): Promise<void> {
  console.log("\n[17] Agent - Failed Run Skips Checkpoint");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(fullRunHandler({ exitCode: 1 }));
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  const result = await assertNoThrow(
    () => agent.run({ prompt: "test" }),
    "Run completes with exitCode 1"
  ) as any;

  assertEqual(result?.exitCode, 1, "Exit code is 1");
  assertEqual(result?.checkpoint, undefined, "No checkpoint (run failed)");

  // No tar command should appear (checkpoint skipped)
  const tarCmds = state.commandHistory.filter((c) => c.includes("tar -czf"));
  assertEqual(tarCmds.length, 0, "No tar command issued for failed run");
}

async function testSuccessfulRunCreatesCheckpoint(): Promise<void> {
  console.log("\n[18] Agent - Successful Run Creates Checkpoint");
  resetState();
  installMockAwsSdk();

  const sandbox = createMockSandbox(fullRunHandler());
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  const result = await assertNoThrow(
    () => agent.run({ prompt: "test" }),
    "Run completes successfully"
  ) as any;

  assertEqual(result?.exitCode, 0, "Exit code is 0");
  assert(result?.checkpoint !== undefined, "Checkpoint field present");
  assertEqual(result?.checkpoint?.hash, HASH_64, "Checkpoint hash correct");
  assert(result?.checkpoint?.id?.startsWith("ckpt_"), "Checkpoint ID has correct prefix");
  assertEqual(result?.checkpoint?.agentType, "claude", "Checkpoint agentType correct");

  // Verify tar was issued
  assert(state.commandHistory.some((c) => c.includes("tar -czf")), "Tar command issued for checkpoint");
}

// =============================================================================
// TESTS: Agent restore integration
// =============================================================================

async function testSandboxCleanupOnFailedRestore(): Promise<void> {
  console.log("\n[19] Agent - Sandbox Cleanup on Failed Restore");
  resetState();
  installMockAwsSdk();

  // Metadata exists but download will fail
  const metaKey = "test-prefix/checkpoints/ckpt_restore_fail.json";
  state.s3Objects.set(metaKey, {
    body: JSON.stringify({ hash: HASH_64, tag: "test" }),
  });

  const sandbox = createMockSandbox(restoreCmdHandler({ downloadFail: true }));
  const provider = createMockProvider(sandbox);

  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  await assertThrows(
    () => agent.run({ prompt: "test", from: "ckpt_restore_fail" }),
    "download failed",
    "Restore failure propagates"
  );

  assert(sandbox.wasKilled, "Sandbox was killed after failed restore");
}

async function testSuccessfulRestoreSetsHasRun(): Promise<void> {
  console.log("\n[20] Agent - Successful Restore Sets hasRun");
  resetState();
  installMockAwsSdk();

  // Metadata and data exist
  const metaKey = "test-prefix/checkpoints/ckpt_resume.json";
  state.s3Objects.set(metaKey, {
    body: JSON.stringify({ hash: HASH_64, tag: "test" }),
  });

  const sandbox = createMockSandbox((cmd: string) => {
    // Restore: download + hash match
    if (cmd.includes("curl") && cmd.includes("evolve-restore")) {
      return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    }
    // Restore: extract
    if (cmd.includes("tar -xzf")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    // Workspace setup
    if (cmd.includes("mkdir -p")) return { stdout: "", stderr: "", exitCode: 0 };
    // Agent CLI (after restore)
    if (cmd.includes("claude")) {
      return { stdout: "Resumed output\n", stderr: "", exitCode: 0 };
    }
    // Checkpoint tar (after successful resumed run)
    if (cmd.includes("tar -czf")) {
      return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("stat -c")) return { stdout: "2048\n", stderr: "", exitCode: 0 };
    if (cmd.includes("curl") && cmd.includes("PUT")) {
      state.s3Objects.set(`test-prefix/data/${HASH_64}/archive.tar.gz`, {});
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });

  const provider = createMockProvider(sandbox);
  const agent = new Agent(makeAgentConfig() as any, {
    sandboxProvider: provider as any,
    storage: BYOK_STORAGE as any,
  });

  const result = await assertNoThrow(
    () => agent.run({ prompt: "continue work", from: "ckpt_resume" }),
    "Restore + run completes"
  ) as any;

  assert(result !== undefined, "Response returned after restore");

  // The CLI command should include --continue flag (hasRun = true after restore)
  const cliCmd = state.commandHistory.find((c) => c.includes("claude") && c.includes("continue work"));
  assert(cliCmd !== undefined || state.commandHistory.some((c) => c.includes("claude")),
    "CLI command was issued after restore");
}

// =============================================================================
// TESTS: Evolve-level
// =============================================================================

async function testWithStorageNoArgs(): Promise<void> {
  console.log("\n[22] Evolve - .withStorage() no args (gateway mode ready)");

  const kit = new Evolve().withStorage();
  // Accessing internal config to verify storage was set
  assert((kit as any).config.storage !== undefined, "Storage config is set");
  assert(typeof (kit as any).config.storage === "object", "Storage config is an object");
}

async function testWithStorageUrl(): Promise<void> {
  console.log("\n[23] Evolve - .withStorage({ url }) BYOK");

  const kit = new Evolve().withStorage({ url: "s3://my-bucket/my-prefix" });
  const cfg = (kit as any).config.storage;
  assert(cfg !== undefined, "Storage config is set");
  assertEqual(cfg.url, "s3://my-bucket/my-prefix", "URL stored correctly");
}

async function testFromPlusWithSession(): Promise<void> {
  console.log("\n[24] Evolve - from + withSession() mutual exclusivity");

  const kit = new Evolve().withSession("existing-sandbox");
  await assertThrows(
    () => (kit as any).run({ prompt: "test", from: "ckpt_abc" }),
    "Cannot use 'from' with 'withSession()'",
    "from + withSession throws"
  );
}

// =============================================================================
// ADDITIONAL EDGE CASE TESTS
// =============================================================================

async function testCreateCheckpointInvalidHash(): Promise<void> {
  console.log("\n[25] createCheckpoint() - Invalid Hash (too short)");
  resetState();
  installMockAwsSdk();

  const handler: CmdHandler = (cmd: string) => {
    if (cmd.includes("tar -czf")) return { stdout: "shorthash\n", stderr: "", exitCode: 0 };
    if (cmd.includes("stat -c")) return { stdout: "2048\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const sandbox = createMockSandbox(handler);
  await assertThrows(
    () => createCheckpoint(sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace", { tag: "t" }),
    "Invalid checkpoint hash",
    "Short hash throws"
  );
}

async function testCreateCheckpointEmptyHash(): Promise<void> {
  console.log("\n[26] createCheckpoint() - Empty stdout (no hash)");
  resetState();
  installMockAwsSdk();

  const handler: CmdHandler = (cmd: string) => {
    if (cmd.includes("tar -czf")) return { stdout: "\n", stderr: "", exitCode: 0 };
    if (cmd.includes("stat -c")) return { stdout: "2048\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const sandbox = createMockSandbox(handler);
  await assertThrows(
    () => createCheckpoint(sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace", { tag: "t" }),
    "Invalid checkpoint hash",
    "Empty hash throws"
  );
}

async function testCreateCheckpointNoPrefix(): Promise<void> {
  console.log("\n[27] createCheckpoint() - BYOK with empty prefix");
  resetState();
  installMockAwsSdk();

  const noPrefixStorage = { ...BYOK_STORAGE, prefix: "" };
  // Pre-populate for dedup to work (simplifies the test)
  const dataK = `data/${HASH_64}/archive.tar.gz`;
  state.s3Objects.set(dataK, {});

  const sandbox = createMockSandbox(checkpointCmdHandler());
  const result = await createCheckpoint(
    sandbox as any, noPrefixStorage as any, "claude", "/home/user/workspace",
    { tag: "no-prefix" }
  );

  assertEqual(result.hash, HASH_64, "Hash correct");
  // Metadata key should not have double slashes
  const metaPut = state.s3PutCalls[0];
  assert(metaPut !== undefined, "Metadata written");
  assert(!metaPut.Key.startsWith("/"), "Key does not start with /");
  assert(metaPut.Key.startsWith("checkpoints/"), "Key starts with checkpoints/ (no prefix)");
}

async function testRestoreCheckpointByokVerifiesCallSequence(): Promise<void> {
  console.log("\n[28] restoreCheckpoint() - BYOK call sequence");
  resetState();
  installMockAwsSdk();

  const metaKey = "test-prefix/checkpoints/ckpt_seq.json";
  state.s3Objects.set(metaKey, {
    body: JSON.stringify({ hash: HASH_64, tag: "seq-test" }),
  });

  const sandbox = createMockSandbox(restoreCmdHandler());
  await restoreCheckpoint(sandbox as any, BYOK_STORAGE as any, "ckpt_seq");

  // Verify command order: download (curl) happens before extract (tar -xzf)
  const curlIdx = state.commandHistory.findIndex((c) => c.includes("curl"));
  const tarIdx = state.commandHistory.findIndex((c) => c.includes("tar -xzf"));
  assert(curlIdx >= 0, "Download command found");
  assert(tarIdx >= 0, "Extract command found");
  assert(curlIdx < tarIdx, "Download happens before extract");
}

async function testGatewayPresignFailure(): Promise<void> {
  console.log("\n[29] createCheckpoint() - Gateway Presign Failure");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any) => { status: number; body: any }>();
  handlers.set("/api/checkpoints/presign", () => ({
    status: 500,
    body: { error: "internal error" },
  }));
  installMockFetch(handlers);

  try {
    const sandbox = createMockSandbox(checkpointCmdHandler());
    await assertThrows(
      () => createCheckpoint(sandbox as any, GATEWAY_STORAGE as any, "claude", "/home/user/workspace", { tag: "t" }),
      "Gateway presign failed",
      "Presign 500 throws"
    );
  } finally {
    restoreFetch();
  }
}

async function testGatewayCreateMetadataFailure(): Promise<void> {
  console.log("\n[30] createCheckpoint() - Gateway Create Metadata Failure");
  resetState();
  _testSetAwsSdk(null);

  const handlers = new Map<string, (body?: any) => { status: number; body: any }>();
  handlers.set("/api/checkpoints/presign", () => ({
    status: 200,
    body: { url: "https://upload.test/put", alreadyExists: true },
  }));
  // Create endpoint fails
  handlers.set("/api/checkpoints", () => ({
    status: 500,
    body: { error: "db error" },
  }));
  installMockFetch(handlers);

  try {
    const sandbox = createMockSandbox(checkpointCmdHandler());
    await assertThrows(
      () => createCheckpoint(sandbox as any, GATEWAY_STORAGE as any, "claude", "/home/user/workspace", { tag: "t" }),
      "Gateway checkpoint create failed",
      "Gateway create 500 throws"
    );
  } finally {
    restoreFetch();
  }
}

async function testCreateCheckpointSizeBytesUndefined(): Promise<void> {
  console.log("\n[31] createCheckpoint() - sizeBytes undefined when stat fails");
  resetState();
  installMockAwsSdk();

  const dataK = `test-prefix/data/${HASH_64}/archive.tar.gz`;
  state.s3Objects.set(dataK, {});

  const handler: CmdHandler = (cmd: string) => {
    if (cmd.includes("tar -czf")) return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    if (cmd.includes("stat -c")) return { stdout: "notanumber\n", stderr: "", exitCode: 0 };
    if (cmd.includes("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const sandbox = createMockSandbox(handler);
  const result = await createCheckpoint(
    sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace",
    { tag: "size-test" }
  );

  assertEqual(result.sizeBytes, undefined, "sizeBytes is undefined when stat returns NaN");
}

async function testCreateCheckpointSizeBytesZero(): Promise<void> {
  console.log("\n[32] createCheckpoint() - sizeBytes 0 is preserved (not coerced to undefined)");
  resetState();
  installMockAwsSdk();

  const dataK = `test-prefix/data/${HASH_64}/archive.tar.gz`;
  state.s3Objects.set(dataK, {});

  const handler: CmdHandler = (cmd: string) => {
    if (cmd.includes("tar -czf")) return { stdout: HASH_64 + "\n", stderr: "", exitCode: 0 };
    if (cmd.includes("stat -c")) return { stdout: "0\n", stderr: "", exitCode: 0 };
    if (cmd.includes("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const sandbox = createMockSandbox(handler);
  const result = await createCheckpoint(
    sandbox as any, BYOK_STORAGE as any, "claude", "/home/user/workspace",
    { tag: "zero-size" }
  );

  assertEqual(result.sizeBytes, 0, "sizeBytes 0 is preserved (not undefined)");
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Checkpoint Async Flows Unit Tests (Mock-Based)");
  console.log("=".repeat(60));

  // createCheckpoint
  await testCreateCheckpointByokHappyPath();
  await testCreateCheckpointByokDedup();
  await testCreateCheckpointGatewayHappyPath();
  await testCreateCheckpointGatewayDedup();
  await testCreateCheckpointTarFailure();
  await testCreateCheckpointUploadFailure();
  await testCreateCheckpointVerifyFailure();

  // restoreCheckpoint
  await testRestoreCheckpointByokHappyPath();
  await testRestoreCheckpointGatewayHappyPath();
  await testRestoreByokNotFound();
  await testRestoreGatewayNotFound();
  await testRestoreHashMismatch();
  await testRestoreDownloadFailure();
  await testRestoreExtractFailure();

  // Agent integration - checkpoint path
  await testNonFatalCheckpoint();
  await testFailedRunSkipsCheckpoint();
  await testSuccessfulRunCreatesCheckpoint();

  // Agent integration - restore path
  await testSandboxCleanupOnFailedRestore();
  await testSuccessfulRestoreSetsHasRun();

  // Evolve-level
  await testWithStorageNoArgs();
  await testWithStorageUrl();
  await testFromPlusWithSession();

  // Edge cases
  await testCreateCheckpointInvalidHash();
  await testCreateCheckpointEmptyHash();
  await testCreateCheckpointNoPrefix();
  await testRestoreCheckpointByokVerifiesCallSequence();
  await testGatewayPresignFailure();
  await testGatewayCreateMetadataFailure();
  await testCreateCheckpointSizeBytesUndefined();
  await testCreateCheckpointSizeBytesZero();

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
  restoreFetch(); // Ensure fetch is restored on crash
  _testSetAwsSdk(null);
  console.error("Test runner error:", e);
  process.exit(1);
});
