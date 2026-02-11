/**
 * Storage & Checkpointing Module
 *
 * Provides durable persistence for agent workspaces beyond sandbox lifetime.
 * Supports BYOK (user's S3 bucket) and Gateway (Evolve-managed) modes.
 *
 * Evidence: storage-checkpointing plan v2.2
 */

import type {
  AgentType,
  StorageConfig,
  ResolvedStorageConfig,
  CheckpointInfo,
  SandboxInstance,
} from "../types";
import { getAgentConfig } from "../registry";
import { DEFAULT_DASHBOARD_URL } from "../constants";

// =============================================================================
// TEST HELPERS (internal — used by unit tests to inject mock AWS SDK)
// =============================================================================

/**
 * @internal Inject mock AWS SDK for unit tests. Passing null clears the cache.
 * Uses globalThis with Symbol.for() so the mock works across module boundaries
 * (source ↔ dist). Tests import this from source; Agent is bundled in dist —
 * both read from the same global cache.
 */
const _AWS_SDK_KEY = Symbol.for("evolve:awsSdkCache");
const _S3_CLIENT_KEY = Symbol.for("evolve:s3ClientCache");

export function _testSetAwsSdk(mock: { s3: any; presigner: any } | null): void {
  (globalThis as any)[_AWS_SDK_KEY] = mock;
  (globalThis as any)[_S3_CLIENT_KEY] = null;
}

// =============================================================================
// PRESIGNED URL TTL
// =============================================================================

const PRESIGN_TTL_SECONDS = 3600; // 1 hour — safe for large archives over slow connections

// =============================================================================
// CACHE EXCLUDES (size only — no security filtering)
// =============================================================================

const TAR_EXCLUDES = [
  "node_modules",
  "__pycache__",
  "*.pyc",
  ".cache",
  ".npm",
  ".pip",
  ".venv",
  "venv",
];

// =============================================================================
// STORAGE CONFIG RESOLUTION
// =============================================================================

/**
 * Parse an S3-style URL into bucket and prefix.
 *
 * Handles:
 * - s3://bucket/prefix
 * - https://bucket.s3.region.amazonaws.com/prefix (virtual-hosted)
 * - https://account.r2.cloudflarestorage.com/bucket/prefix
 * - https://host:port/bucket/prefix (MinIO, custom)
 */
function parseStorageUrl(url: string): {
  bucket: string;
  prefix: string;
  endpoint?: string;
} {
  // s3:// scheme
  if (url.startsWith("s3://")) {
    const rest = url.slice("s3://".length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) {
      return { bucket: rest, prefix: "" };
    }
    return {
      bucket: rest.slice(0, slashIdx),
      prefix: rest.slice(slashIdx + 1).replace(/\/+$/, ""),
    };
  }

  // https:// scheme
  const parsed = new URL(url);
  const host = parsed.hostname;
  const pathParts = parsed.pathname
    .split("/")
    .filter(Boolean);

  // Virtual-hosted style: bucket.s3.region.amazonaws.com
  if (host.includes(".s3.") && host.endsWith(".amazonaws.com")) {
    const bucket = host.split(".s3.")[0];
    return {
      bucket,
      prefix: pathParts.join("/"),
    };
  }

  // Path-style: endpoint/bucket/prefix (R2, MinIO, custom)
  if (pathParts.length === 0) {
    throw new Error(
      `Invalid storage URL: no bucket in path. Expected https://endpoint/bucket/prefix, got ${url}`
    );
  }

  return {
    bucket: pathParts[0],
    prefix: pathParts.slice(1).join("/"),
    endpoint: `${parsed.protocol}//${parsed.host}`,
  };
}

/**
 * Resolve storage configuration from user input.
 *
 * BYOK mode: URL provided → parse into bucket/prefix, use S3 client directly
 * Gateway mode: no URL → use dashboard API endpoints
 */
export function resolveStorageConfig(
  config: StorageConfig | undefined,
  isGateway: boolean,
  gatewayUrl?: string,
  gatewayApiKey?: string
): ResolvedStorageConfig {
  // Gateway mode: no URL needed
  if (!config?.url && !config?.bucket) {
    if (!isGateway) {
      throw new Error(
        "Storage requires either a URL (BYOK mode) or gateway API key. " +
        "Use .withStorage({ url: 's3://bucket/prefix' }) or configure EVOLVE_API_KEY for gateway mode."
      );
    }
    return {
      bucket: "", // Not used in gateway mode
      prefix: "", // Not used in gateway mode
      region: config?.region || "us-east-1",
      mode: "gateway",
      gatewayUrl,
      gatewayApiKey,
    };
  }

  // BYOK mode: parse URL
  let bucket = config?.bucket || "";
  let prefix = config?.prefix || "";
  let endpoint = config?.endpoint;

  if (config?.url) {
    const parsed = parseStorageUrl(config.url);
    bucket = bucket || parsed.bucket;
    prefix = prefix || parsed.prefix;
    endpoint = endpoint || parsed.endpoint;
  }

  if (!bucket) {
    throw new Error(
      "Storage bucket is required. Provide url (s3://bucket/prefix) or explicit bucket name."
    );
  }

  return {
    bucket,
    prefix,
    region: config?.region || process.env.AWS_REGION || "us-east-1",
    endpoint,
    credentials: config?.credentials,
    mode: "byok",
  };
}

// =============================================================================
// PATH NORMALIZATION
// =============================================================================

/**
 * Normalize agent settings dir to a relative path under /home/user.
 *
 * Registry values: "~/.claude", "~/.codex", "~/.gemini", "~/.qwen"
 * Output: ".claude", ".codex", ".gemini", ".qwen"
 */
export function normalizeAgentDir(settingsDir: string): string {
  if (settingsDir.includes("..")) {
    throw new Error(`settingsDir must not contain '..': ${settingsDir}`);
  }
  let dir: string;
  if (settingsDir.startsWith("~/")) {
    dir = settingsDir.slice(2);
  } else if (settingsDir.startsWith("/home/user/")) {
    dir = settingsDir.slice("/home/user/".length);
  } else if (settingsDir.startsWith(".")) {
    dir = settingsDir;
  } else {
    throw new Error(
      `Unexpected settingsDir: ${settingsDir}. Expected ~/ or /home/user/ prefix.`
    );
  }
  if (!dir || dir.startsWith("/")) {
    throw new Error(`settingsDir resolves to invalid path: ${settingsDir}`);
  }
  return dir;
}

/**
 * Normalize working directory to a relative path under /home/user.
 *
 * Input: "/home/user/workspace" → "workspace"
 * Input: "/home/user/myproject" → "myproject"
 */
export function normalizeWorkspaceDir(workingDir: string): string {
  if (workingDir.includes("..")) {
    throw new Error(`workingDir must not contain '..': ${workingDir}`);
  }
  if (!workingDir.startsWith("/home/user/")) {
    throw new Error(
      `Unexpected workingDir: ${workingDir}. Must start with /home/user/.`
    );
  }
  const dir = workingDir.slice("/home/user/".length).replace(/\/+$/, "");
  if (!dir || dir.startsWith("/") || dir.includes("//")) {
    throw new Error(`workingDir resolves to invalid path: ${workingDir}`);
  }
  return dir;
}

// =============================================================================
// TAR COMMAND
// =============================================================================

/**
 * Escape a string for safe interpolation into a shell command.
 * Wraps in single quotes with internal single-quote escaping.
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the tar + sha256sum command for checkpointing.
 *
 * Archives workspace/ + .{agent}/ directories with cache excludes.
 * Returns combined tar + sha256sum command (stdout = hash).
 */
export function buildTarCommand(
  agentType: AgentType,
  workingDir: string
): string {
  const registry = getAgentConfig(agentType);
  const agentDir = normalizeAgentDir(registry.mcpConfig.settingsDir);
  const workspaceDir = normalizeWorkspaceDir(workingDir);

  const excludes = [
    ...TAR_EXCLUDES.map((e) => `--exclude=${shellEscape(e)}`),
    `--exclude=${shellEscape(workspaceDir + "/temp")}`,
  ].join(" ");

  return [
    `tar -czf /tmp/evolve-ckpt.tar.gz -C /home/user ${excludes} ${shellEscape(workspaceDir + "/")} ${shellEscape(agentDir + "/")}`,
    `sha256sum /tmp/evolve-ckpt.tar.gz | awk '{print $1}'`,
  ].join(" && ");
}

// =============================================================================
// S3 CLIENT (dynamic import)
// =============================================================================

/**
 * Dynamically import AWS SDK modules (optional peer deps).
 * Returns both @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner.
 *
 * Uses Function("m", "return import(m)") instead of bare import() because
 * tsc resolves static import() specifiers and emits TS2307 when the optional
 * peer deps aren't installed. The Function wrapper hides the specifier from
 * tsc while tsup (which has both in `external`) emits a clean require/import.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAwsSdk(): Promise<{ s3: any; presigner: any }> {
  const cached = (globalThis as any)[_AWS_SDK_KEY];
  if (cached) return cached;

  const S3_MODULE = "@aws-sdk/client-s3";
  const PRESIGNER_MODULE = "@aws-sdk/s3-request-presigner";

  try {
    const [s3, presigner] = await Promise.all([
      Function("m", "return import(m)")(S3_MODULE),
      Function("m", "return import(m)")(PRESIGNER_MODULE),
    ]);
    (globalThis as any)[_AWS_SDK_KEY] = { s3, presigner };
    return { s3, presigner };
  } catch {
    throw new Error(
      "Storage requires @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner. " +
      "Install: npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner"
    );
  }
}

/**
 * Get S3Client instance (dynamic import for optional peer dep).
 * Cached per unique bucket+region+endpoint combination.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getS3Client(storage: ResolvedStorageConfig): Promise<any> {
  const credKey = storage.credentials
    ? `${storage.credentials.accessKeyId}:${storage.credentials.secretAccessKey.slice(-4)}`
    : "env";
  const cacheKey = `${storage.bucket}:${storage.region}:${storage.endpoint || ""}:${credKey}`;
  const cached = (globalThis as any)[_S3_CLIENT_KEY] as { client: any; key: string } | null;
  if (cached?.key === cacheKey) return cached.client;

  const { s3 } = await loadAwsSdk();
  const client = new s3.S3Client({
    region: storage.region,
    ...(storage.endpoint && {
      endpoint: storage.endpoint,
      forcePathStyle: true,
    }),
    ...(storage.credentials && { credentials: storage.credentials }),
  });
  (globalThis as any)[_S3_CLIENT_KEY] = { client, key: cacheKey };
  return client;
}

/**
 * Generate a presigned URL for S3 operations (BYOK mode).
 */
async function presignUrl(
  storage: ResolvedStorageConfig,
  key: string,
  method: "put" | "get"
): Promise<string> {
  const { s3, presigner } = await loadAwsSdk();
  const client = await getS3Client(storage);

  const command = method === "put"
    ? new s3.PutObjectCommand({ Bucket: storage.bucket, Key: key, ContentType: "application/gzip" })
    : new s3.GetObjectCommand({ Bucket: storage.bucket, Key: key });

  return presigner.getSignedUrl(client, command, { expiresIn: PRESIGN_TTL_SECONDS });
}

/**
 * Check if an S3 object exists (BYOK mode).
 */
async function s3ObjectExists(
  storage: ResolvedStorageConfig,
  key: string
): Promise<boolean> {
  const { s3 } = await loadAwsSdk();
  const client = await getS3Client(storage);

  try {
    await client.send(new s3.HeadObjectCommand({ Bucket: storage.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a JSON object from S3 (BYOK mode).
 */
async function s3GetJson<T>(
  storage: ResolvedStorageConfig,
  key: string
): Promise<T> {
  const { s3 } = await loadAwsSdk();
  const client = await getS3Client(storage);

  const response = await client.send(
    new s3.GetObjectCommand({ Bucket: storage.bucket, Key: key })
  );
  const body = await response.Body?.transformToString();
  if (!body) {
    throw new Error(`Empty response from S3 key: ${key}`);
  }
  return JSON.parse(body);
}

/**
 * Write a JSON object to S3 (BYOK mode).
 */
async function s3PutJson(
  storage: ResolvedStorageConfig,
  key: string,
  data: unknown
): Promise<void> {
  const { s3 } = await loadAwsSdk();
  const client = await getS3Client(storage);

  await client.send(
    new s3.PutObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    })
  );
}

// =============================================================================
// S3 KEY HELPERS
// =============================================================================

function dataKey(storage: ResolvedStorageConfig, hash: string): string {
  const prefix = storage.prefix ? `${storage.prefix}/` : "";
  return `${prefix}data/${hash}/archive.tar.gz`;
}

function metadataKey(storage: ResolvedStorageConfig, id: string): string {
  const prefix = storage.prefix ? `${storage.prefix}/` : "";
  return `${prefix}checkpoints/${id}.json`;
}

// =============================================================================
// ID GENERATION
// =============================================================================

function generateCheckpointId(): string {
  // Simple unique ID: timestamp + random hex (no external dependency)
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `ckpt_${ts}_${rand}`;
}

// =============================================================================
// GATEWAY HELPERS
// =============================================================================

async function gatewayPresign(
  storage: ResolvedStorageConfig,
  tag: string,
  hash: string,
  action: "put" | "get"
): Promise<{ url: string | null; alreadyExists?: boolean }> {
  const response = await fetch(`${storage.gatewayUrl}/api/checkpoints/presign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${storage.gatewayApiKey}`,
    },
    body: JSON.stringify({ tag, hash, action }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gateway presign failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function gatewayCreateCheckpoint(
  storage: ResolvedStorageConfig,
  metadata: {
    tag: string;
    hash: string;
    sizeBytes: number;
    agentType?: string;
    model?: string;
    workspaceMode?: string;
    parentId?: string;
    comment?: string;
  }
): Promise<{ id: string }> {
  const response = await fetch(`${storage.gatewayUrl}/api/checkpoints`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${storage.gatewayApiKey}`,
    },
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gateway checkpoint create failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function gatewayGetCheckpoint(
  storage: ResolvedStorageConfig,
  checkpointId: string
): Promise<{ id: string; hash: string; tag: string; sizeBytes: number; timestamp: string; agentType?: string; model?: string; workspaceMode?: string; parentId?: string; comment?: string }> {
  const response = await fetch(`${storage.gatewayUrl}/api/checkpoints/${checkpointId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${storage.gatewayApiKey}`,
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }
    const text = await response.text().catch(() => "");
    throw new Error(`Gateway checkpoint get failed (${response.status}): ${text}`);
  }

  return response.json();
}

// =============================================================================
// CREATE CHECKPOINT
// =============================================================================

/**
 * Create a checkpoint after a successful run.
 *
 * 2-phase: data upload (tar.gz) → metadata write.
 * Content-addressed dedup: same hash = skip upload.
 */
export async function createCheckpoint(
  sandbox: SandboxInstance,
  storage: ResolvedStorageConfig,
  agentType: AgentType,
  workingDir: string,
  meta: { tag: string; model?: string; workspaceMode?: string; parentId?: string; comment?: string }
): Promise<CheckpointInfo> {
  const timestamp = new Date().toISOString();

  // 1. Tar workspace + agent dir, compute hash
  const tarCmd = buildTarCommand(agentType, workingDir);
  const tarResult = await sandbox.commands.run(tarCmd, { timeoutMs: 120000 });

  if (tarResult.exitCode !== 0) {
    throw new Error(`Checkpoint tar failed: ${tarResult.stderr}`);
  }

  const hash = tarResult.stdout.trim().split("\n").pop()?.trim();
  if (!hash || hash.length !== 64) {
    throw new Error(`Invalid checkpoint hash: ${hash}`);
  }

  // 2. Get archive size
  const sizeResult = await sandbox.commands.run(
    "stat -c '%s' /tmp/evolve-ckpt.tar.gz 2>/dev/null || stat -f '%z' /tmp/evolve-ckpt.tar.gz",
    { timeoutMs: 10000 }
  );
  const parsed = parseInt(sizeResult.stdout.trim(), 10);
  const sizeBytes = Number.isNaN(parsed) ? undefined : parsed;

  // 3. Dedup check + upload
  let checkpointId: string;

  if (storage.mode === "byok") {
    const key = dataKey(storage, hash);
    const exists = await s3ObjectExists(storage, key);

    if (!exists) {
      // Phase 1: Upload data
      const putUrl = await presignUrl(storage, key, "put");
      const uploadResult = await sandbox.commands.run(
        `curl -sf -X PUT -H "Content-Type: application/gzip" --upload-file /tmp/evolve-ckpt.tar.gz "${putUrl}"`,
        { timeoutMs: 300000 }
      );
      if (uploadResult.exitCode !== 0) {
        throw new Error(`Checkpoint upload failed: ${uploadResult.stderr}`);
      }

      // Verify upload
      const verified = await s3ObjectExists(storage, key);
      if (!verified) {
        throw new Error("Checkpoint upload verification failed (HeadObject)");
      }
    }

    // Phase 2: Write metadata
    checkpointId = generateCheckpointId();
    const metaObj = {
      id: checkpointId,
      hash,
      tag: meta.tag,
      timestamp,
      sizeBytes,
      agentType,
      model: meta.model,
      workspaceMode: meta.workspaceMode,
      parentId: meta.parentId,
      comment: meta.comment,
      sandboxId: sandbox.sandboxId,
    };
    await s3PutJson(storage, metadataKey(storage, checkpointId), metaObj);
  } else {
    // Gateway mode
    // Step 1: Presign (server does HeadObject for dedup)
    const presignResult = await gatewayPresign(storage, meta.tag, hash, "put");

    if (!presignResult.alreadyExists) {
      // Phase 1: Upload data
      const uploadResult = await sandbox.commands.run(
        `curl -sf -X PUT -H "Content-Type: application/gzip" --upload-file /tmp/evolve-ckpt.tar.gz "${presignResult.url!}"`,
        { timeoutMs: 300000 }
      );
      if (uploadResult.exitCode !== 0) {
        throw new Error(`Checkpoint upload failed: ${uploadResult.stderr}`);
      }
    }

    // Phase 2: Write metadata via API
    const created = await gatewayCreateCheckpoint(storage, {
      tag: meta.tag,
      hash,
      sizeBytes: sizeBytes ?? 0,
      agentType,
      model: meta.model,
      workspaceMode: meta.workspaceMode,
      parentId: meta.parentId,
      comment: meta.comment,
    });
    checkpointId = created.id;
  }

  // 4. Cleanup
  await sandbox.commands.run("rm -f /tmp/evolve-ckpt.tar.gz", { timeoutMs: 10000 });

  return {
    id: checkpointId,
    hash,
    tag: meta.tag,
    timestamp,
    sizeBytes,
    agentType,
    model: meta.model,
    workspaceMode: meta.workspaceMode,
    parentId: meta.parentId,
    comment: meta.comment,
  };
}

// =============================================================================
// RESTORE CHECKPOINT
// =============================================================================

/** Metadata returned from restoreCheckpoint for validation by the caller. */
export interface RestoreMetadata {
  agentType?: string;
  workspaceMode?: string;
}

/**
 * Restore a checkpoint into a fresh sandbox.
 *
 * Downloads archive, verifies hash, extracts into /home/user.
 * Returns checkpoint metadata so the caller can validate agent type, etc.
 */
export async function restoreCheckpoint(
  sandbox: SandboxInstance,
  storage: ResolvedStorageConfig,
  checkpointId: string
): Promise<RestoreMetadata> {
  let hash: string;
  let getUrl: string;
  let restoreMeta: RestoreMetadata = {};

  if (storage.mode === "byok") {
    // Read checkpoint metadata from S3
    const key = metadataKey(storage, checkpointId);
    let metadata: { hash: string; tag: string; agentType?: string; workspaceMode?: string };
    try {
      metadata = await s3GetJson<typeof metadata>(storage, key);
    } catch {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    hash = metadata.hash;
    restoreMeta = { agentType: metadata.agentType, workspaceMode: metadata.workspaceMode };
    getUrl = await presignUrl(storage, dataKey(storage, hash), "get");
  } else {
    // Gateway mode: get metadata via API
    const metadata = await gatewayGetCheckpoint(storage, checkpointId);
    hash = metadata.hash;
    restoreMeta = { agentType: metadata.agentType, workspaceMode: metadata.workspaceMode };

    // Presign uses the OLD tag from checkpoint metadata (not current session)
    const presignResult = await gatewayPresign(
      storage,
      metadata.tag,
      hash,
      "get"
    );
    getUrl = presignResult.url!; // GET action always returns a URL
  }

  // Download archive into sandbox
  const downloadResult = await sandbox.commands.run(
    `curl -sf -o /tmp/evolve-restore.tar.gz "${getUrl}" && sha256sum /tmp/evolve-restore.tar.gz | awk '{print $1}'`,
    { timeoutMs: 300000 }
  );

  if (downloadResult.exitCode !== 0) {
    throw new Error(`Checkpoint download failed: ${downloadResult.stderr}`);
  }

  // Verify hash integrity
  const downloadedHash = downloadResult.stdout.trim().split("\n").pop()?.trim();
  if (downloadedHash !== hash) {
    await sandbox.commands.run("rm -f /tmp/evolve-restore.tar.gz", { timeoutMs: 10000 });
    throw new Error(
      `Checkpoint integrity check failed (expected ${hash}, got ${downloadedHash})`
    );
  }

  // Extract archive
  const extractResult = await sandbox.commands.run(
    "tar -xzf /tmp/evolve-restore.tar.gz -C /home/user && rm -f /tmp/evolve-restore.tar.gz",
    { timeoutMs: 120000 }
  );

  if (extractResult.exitCode !== 0) {
    throw new Error(`Checkpoint extraction failed: ${extractResult.stderr}`);
  }

  return restoreMeta;
}

// =============================================================================
// STANDALONE STORAGE RESOLUTION
// =============================================================================

/**
 * Resolve storage config for standalone functions (listCheckpoints, getLatestCheckpoint).
 *
 * Bridges the gap between the standalone API (takes StorageConfig) and the internal
 * resolveStorageConfig() which requires explicit gateway params. Reads EVOLVE_API_KEY
 * from env for gateway mode detection.
 */
function resolveStorageForStandalone(config: StorageConfig): ResolvedStorageConfig {
  const apiKey = process.env.EVOLVE_API_KEY;
  const isGateway = !config.url && !config.bucket && !!apiKey;
  return resolveStorageConfig(config, isGateway, DEFAULT_DASHBOARD_URL, apiKey);
}

// =============================================================================
// LIST CHECKPOINTS
// =============================================================================

/**
 * List checkpoints from BYOK S3 storage.
 *
 * Paginates all checkpoint metadata keys, sorts by LastModified descending,
 * then fetches metadata JSON for the top N results only.
 */
async function s3ListCheckpoints(
  storage: ResolvedStorageConfig,
  options?: { limit?: number }
): Promise<CheckpointInfo[]> {
  const { s3 } = await loadAwsSdk();
  const client = await getS3Client(storage);

  const prefix = storage.prefix ? `${storage.prefix}/` : "";
  const checkpointPrefix = `${prefix}checkpoints/`;

  // Paginate to collect all .json object entries
  const allEntries: Array<{ key: string; lastModified: Date }> = [];
  let continuationToken: string | undefined;

  do {
    const params: Record<string, unknown> = {
      Bucket: storage.bucket,
      Prefix: checkpointPrefix,
      ...(continuationToken && { ContinuationToken: continuationToken }),
    };
    const response = await client.send(new s3.ListObjectsV2Command(params));

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key?.endsWith(".json") && obj.LastModified) {
          allEntries.push({ key: obj.Key, lastModified: obj.LastModified });
        }
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  if (allEntries.length === 0) return [];

  // Sort by LastModified descending, Key descending as tie-breaker
  allEntries.sort((a, b) => {
    const timeDiff = b.lastModified.getTime() - a.lastModified.getTime();
    if (timeDiff !== 0) return timeDiff;
    return b.key < a.key ? -1 : b.key > a.key ? 1 : 0;
  });

  // Slice to limit
  const limited = options?.limit ? allEntries.slice(0, options.limit) : allEntries;

  // Fetch metadata JSON for top N only
  const results = await Promise.all(
    limited.map(async (entry) => {
      try {
        return await s3GetJson<CheckpointInfo>(storage, entry.key);
      } catch {
        return null;
      }
    })
  );

  return results.filter((r): r is CheckpointInfo => r !== null);
}

/**
 * List checkpoints from Gateway mode (dashboard API).
 */
async function gatewayListCheckpoints(
  storage: ResolvedStorageConfig,
  options?: { limit?: number }
): Promise<CheckpointInfo[]> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));

  const url = `${storage.gatewayUrl}/api/checkpoints${params.toString() ? `?${params}` : ""}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${storage.gatewayApiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gateway list checkpoints failed (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * List checkpoints (standalone — no Evolve instance needed).
 *
 * BYOK mode: reads directly from S3.
 * Gateway mode: reads EVOLVE_API_KEY from env, calls dashboard API.
 *
 * @example
 * // BYOK
 * const all = await listCheckpoints({ url: "s3://my-bucket/project/" });
 *
 * // Gateway
 * const all = await listCheckpoints({});
 */
export async function listCheckpoints(
  config: StorageConfig,
  options?: { limit?: number }
): Promise<CheckpointInfo[]> {
  const resolved = resolveStorageForStandalone(config);
  const normalizedLimit = options?.limit && options.limit > 0 ? Math.min(options.limit, 500) : 100;

  if (resolved.mode === "byok") {
    return s3ListCheckpoints(resolved, { limit: normalizedLimit });
  } else {
    return gatewayListCheckpoints(resolved, { limit: normalizedLimit });
  }
}

// =============================================================================
// GET LATEST CHECKPOINT
// =============================================================================

/**
 * Get the most recent checkpoint.
 *
 * BYOK: reuses s3ListCheckpoints with limit=1.
 * Gateway: calls list endpoint with limit=1.
 */
export async function getLatestCheckpoint(
  storage: ResolvedStorageConfig
): Promise<CheckpointInfo | null> {
  if (storage.mode === "byok") {
    const results = await s3ListCheckpoints(storage, { limit: 1 });
    return results[0] ?? null;
  } else {
    const results = await gatewayListCheckpoints(storage, { limit: 1 });
    return results[0] ?? null;
  }
}
