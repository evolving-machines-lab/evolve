/**
 * Storage & Checkpointing Module
 *
 * Provides durable persistence for agent workspaces beyond sandbox lifetime.
 * Supports BYOK (user's S3 bucket) and Gateway (Evolve-managed) modes.
 *
 * Evidence: storage-checkpointing plan v2.2
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { writeFile, readFile, mkdir, rm, unlink, copyFile } from "node:fs/promises";
import { join, dirname, normalize, resolve, isAbsolute, relative } from "node:path";
import { tmpdir } from "node:os";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AgentType,
  StorageConfig,
  ResolvedStorageConfig,
  CheckpointInfo,
  SandboxInstance,
  FileMap,
  StorageClient,
  DownloadCheckpointOptions,
  DownloadFilesOptions,
} from "../types";
import { getAgentConfig } from "../registry";
import { DEFAULT_DASHBOARD_URL } from "../constants";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
 * Archives workspace/ + agent directories with cache excludes.
 * Uses checkpointDirs if defined (e.g., OpenCode XDG dirs), else falls back to mcpConfig.settingsDir.
 * Returns combined tar + sha256sum command (stdout = hash).
 */
export function buildTarCommand(
  agentType: AgentType,
  workingDir: string
): string {
  const registry = getAgentConfig(agentType);
  const workspaceDir = normalizeWorkspaceDir(workingDir);

  // Determine agent directories to include in checkpoint
  const agentDirs: string[] = registry.checkpointDirs?.length
    ? registry.checkpointDirs.map((d) => normalizeAgentDir(d))
    : [normalizeAgentDir(registry.mcpConfig.settingsDir)];

  const excludes = [
    ...TAR_EXCLUDES.map((e) => `--exclude=${shellEscape(e)}`),
    `--exclude=${shellEscape(workspaceDir + "/temp")}`,
  ].join(" ");

  const dirs = [
    shellEscape(workspaceDir + "/"),
    ...agentDirs.map((d) => shellEscape(d + "/")),
  ].join(" ");

  return [
    `tar -czf /tmp/evolve-ckpt.tar.gz -C /home/user ${excludes} ${dirs}`,
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
  } catch (err: unknown) {
    // Only treat 404/NotFound as "doesn't exist". Re-throw auth, network, permission errors.
    const name = (err as any)?.name || (err as Error)?.message || "";
    const statusCode = (err as any)?.$metadata?.httpStatusCode;
    if (statusCode === 404 || name === "NotFound" || name === "NoSuchKey") {
      return false;
    }
    throw err;
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
  const response = await fetch(`${storage.gatewayUrl}/api/checkpoints/${encodeURIComponent(checkpointId)}`, {
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

  // 3. Dedup check + upload (with guaranteed tar cleanup)
  let checkpointId: string;

  try {
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
  } finally {
    // 4. Cleanup — always runs even if upload/metadata write fails
    await sandbox.commands.run("rm -f /tmp/evolve-ckpt.tar.gz", { timeoutMs: 10000 });
  }

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
  // Fetch metadata and presigned download URL (works for both BYOK and gateway)
  const metadata = await getCheckpointInfo(storage, checkpointId);
  const hash = metadata.hash;
  const restoreMeta: RestoreMetadata = { agentType: metadata.agentType, workspaceMode: metadata.workspaceMode };
  const getUrl = await getArchiveDownloadUrl(storage, metadata);

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
function resolveStorageForStandalone(
  config: StorageConfig,
  overrides?: { gatewayUrl?: string; gatewayApiKey?: string }
): ResolvedStorageConfig {
  const apiKey = overrides?.gatewayApiKey || process.env.EVOLVE_API_KEY;
  const gatewayUrl = overrides?.gatewayUrl || DEFAULT_DASHBOARD_URL;
  const isGateway = !config.url && !config.bucket && !!apiKey;
  return resolveStorageConfig(config, isGateway, gatewayUrl, apiKey);
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
  options?: { limit?: number; tag?: string }
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

  // When tag filtering: fetch all metadata, filter by tag, then apply limit.
  // When no tag: apply limit before fetching metadata (optimization — avoids
  // reading metadata for entries we'll discard).
  const needsTagFilter = !!options?.tag;
  const preFetchSlice = needsTagFilter
    ? allEntries
    : options?.limit ? allEntries.slice(0, options.limit) : allEntries;

  // Fetch metadata JSON
  const results = await Promise.all(
    preFetchSlice.map(async (entry) => {
      try {
        return await s3GetJson<CheckpointInfo>(storage, entry.key);
      } catch {
        return null;
      }
    })
  );

  let valid = results.filter((r): r is CheckpointInfo => r !== null);

  // Post-filter by tag if requested
  if (options?.tag) {
    valid = valid.filter((r) => r.tag === options.tag);
  }

  // Apply limit after tag filter
  if (options?.limit && valid.length > options.limit) {
    valid = valid.slice(0, options.limit);
  }

  return valid;
}

/**
 * List checkpoints from Gateway mode (dashboard API).
 */
async function gatewayListCheckpoints(
  storage: ResolvedStorageConfig,
  options?: { limit?: number; tag?: string }
): Promise<CheckpointInfo[]> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.tag) params.set("tag", options.tag);

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
/** Clamp limit to [1, 500], default 100. */
function normalizeLimit(limit?: number): number {
  return limit && limit > 0 ? Math.min(limit, 500) : 100;
}

export async function listCheckpoints(
  config: StorageConfig,
  options?: { limit?: number; tag?: string }
): Promise<CheckpointInfo[]> {
  const resolved = resolveStorageForStandalone(config);
  const normalizedLimit = normalizeLimit(options?.limit);

  if (resolved.mode === "byok") {
    return s3ListCheckpoints(resolved, { limit: normalizedLimit, tag: options?.tag });
  } else {
    return gatewayListCheckpoints(resolved, { limit: normalizedLimit, tag: options?.tag });
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
  storage: ResolvedStorageConfig,
  options?: { tag?: string }
): Promise<CheckpointInfo | null> {
  if (storage.mode === "byok") {
    const results = await s3ListCheckpoints(storage, { limit: 1, tag: options?.tag });
    return results[0] ?? null;
  } else {
    const results = await gatewayListCheckpoints(storage, { limit: 1, tag: options?.tag });
    return results[0] ?? null;
  }
}

// =============================================================================
// STORAGE CLIENT (standalone access — no Evolve instance needed)
// =============================================================================

/**
 * Get checkpoint metadata by ID (both modes).
 */
async function getCheckpointInfo(
  resolved: ResolvedStorageConfig,
  id: string
): Promise<CheckpointInfo> {
  if (resolved.mode === "byok") {
    const key = metadataKey(resolved, id);
    try {
      return await s3GetJson<CheckpointInfo>(resolved, key);
    } catch (err: unknown) {
      if (isS3NotFoundError(err)) {
        throw new Error(`Checkpoint ${id} not found`);
      }
      throw err;
    }
  } else {
    return await gatewayGetCheckpoint(resolved, id) as CheckpointInfo;
  }
}

/**
 * Resolve "latest" to a concrete checkpoint ID.
 */
async function resolveCheckpointId(
  resolved: ResolvedStorageConfig,
  idOrLatest: string,
  tag?: string
): Promise<string> {
  if (idOrLatest === "latest") {
    const latest = await getLatestCheckpoint(resolved, { tag });
    if (!latest) {
      throw new Error(tag ? `No checkpoints found with tag "${tag}"` : "No checkpoints found");
    }
    return latest.id;
  }
  return idOrLatest;
}

/**
 * Get presigned download URL for a checkpoint archive.
 */
async function getArchiveDownloadUrl(
  resolved: ResolvedStorageConfig,
  metadata: CheckpointInfo
): Promise<string> {
  if (resolved.mode === "byok") {
    return presignUrl(resolved, dataKey(resolved, metadata.hash), "get");
  } else {
    const result = await gatewayPresign(resolved, metadata.tag, metadata.hash, "get");
    if (!result.url) throw new Error("Gateway presign returned no download URL");
    return result.url;
  }
}

// =============================================================================
// PATH SAFETY (archive path traversal prevention)
// =============================================================================

/**
 * Validate that an archive path is safe (no traversal, no absolute paths).
 * Returns true if the path is safe, false if it should be rejected.
 */
function isSafeArchivePath(filePath: string): boolean {
  if (!filePath) return false;
  // Reject absolute paths (isAbsolute covers both POSIX "/" and Windows "C:\")
  if (isAbsolute(filePath)) return false;
  // Reject option-like names (prevents tar option injection via crafted archives)
  if (filePath.startsWith("-")) return false;
  // Reject path traversal (normalize resolves all ".." segments)
  if (normalize(filePath).startsWith("..")) return false;
  // Reject null bytes
  if (filePath.includes("\0")) return false;
  return true;
}

/**
 * Validate that an extracted path resolves within the target directory.
 * Defense-in-depth: even after isSafeArchivePath, verify the resolved path.
 */
function assertWithinDir(targetDir: string, filePath: string): void {
  const resolved = resolve(targetDir, filePath);
  const resolvedDir = resolve(targetDir);
  const rel = relative(resolvedDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: "${filePath}" resolves outside target directory`);
  }
}

/**
 * Detect AWS S3 "not found" errors (NoSuchKey, 404, NotFound).
 * Used to distinguish missing checkpoints from real S3 errors (auth, network, etc.).
 */
function isS3NotFoundError(err: unknown): boolean {
  const name = (err as { name?: string }).name;
  const message = (err as { message?: string }).message;
  const statusCode = (err as any)?.$metadata?.httpStatusCode;
  return statusCode === 404 || name === "NoSuchKey" || name === "NotFound" || message === "NoSuchKey";
}

/**
 * Validate archive file list and fail closed on unsafe paths.
 */
function assertSafePaths(files: string[]): string[] {
  const unsafe = files.filter((f) => !isSafeArchivePath(f));
  if (unsafe.length > 0) {
    throw new Error(`Archive contains unsafe path(s): ${unsafe.slice(0, 3).join(", ")}`);
  }
  return files;
}

/**
 * Large-archive-safe buffer for tar listing commands.
 * Default exec maxBuffer is ~1MB which can truncate archives with thousands of files.
 */
const TAR_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

// =============================================================================
// TAR BINARY CHECK
// =============================================================================

let tarChecked = false;

/**
 * Verify that the `tar` binary is available. Throws a clear error if not.
 */
async function ensureTarAvailable(): Promise<void> {
  if (tarChecked) return;
  try {
    await execFileAsync("tar", ["--version"]);
    tarChecked = true;
  } catch {
    throw new Error(
      "The 'tar' command is not available on this system. " +
      "Storage download/extract requires tar (available on macOS, Linux, and Windows with Git Bash or WSL)."
    );
  }
}

// =============================================================================
// STREAMING DOWNLOAD WITH INCREMENTAL HASH
// =============================================================================

/**
 * Download checkpoint archive to a local temp file with streaming + incremental SHA-256.
 * Avoids loading entire archive into memory.
 * Returns path to the temp file and the checkpoint metadata.
 */
async function downloadArchiveToLocal(
  resolved: ResolvedStorageConfig,
  checkpointId: string
): Promise<{ tmpPath: string; metadata: CheckpointInfo }> {
  const metadata = await getCheckpointInfo(resolved, checkpointId);
  const downloadUrl = await getArchiveDownloadUrl(resolved, metadata);

  const safeId = checkpointId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const tmpPath = join(tmpdir(), `evolve-dl-${safeId}-${Date.now()}.tar.gz`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Checkpoint download failed (${response.status})`);
  }
  if (!response.body) {
    throw new Error("Checkpoint download returned empty body");
  }

  // Stream response to file while computing SHA-256 incrementally
  const hash = createHash("sha256");
  const fileStream = createWriteStream(tmpPath);

  try {
    const reader = response.body.getReader();
    await new Promise<void>((resolvePromise, reject) => {
      fileStream.on("error", reject);
      fileStream.on("finish", resolvePromise);

      async function pump(): Promise<void> {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            fileStream.end();
            break;
          }
          hash.update(value);
          if (!fileStream.write(value)) {
            await new Promise<void>((r) => fileStream.once("drain", r));
          }
        }
      }

      pump().catch(reject);
    });
  } catch (err) {
    // Cleanup on stream error
    fileStream.destroy();
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  // Verify hash
  const actualHash = hash.digest("hex");
  if (actualHash !== metadata.hash) {
    await unlink(tmpPath).catch(() => {});
    throw new Error(
      `Checkpoint integrity check failed (expected ${metadata.hash}, got ${actualHash})`
    );
  }

  return { tmpPath, metadata };
}

/**
 * List regular files inside a tar.gz archive with entry type validation.
 *
 * Uses `tar -tvzf` (verbose) for type checking and `tar -tzf` (compact) for
 * path listing. Allows regular files ('-'), directories ('d'), and symlinks ('l')
 * but only returns paths of regular files. Symlinks are allowed to exist in the
 * archive (needed for sandbox environments) but excluded from the file list to
 * prevent symlink-following attacks in downloadFiles().
 */
async function listTarFiles(archivePath: string): Promise<string[]> {
  await ensureTarAvailable();

  // Single tar process — verbose output contains both type info and paths.
  // Uses execFileAsync (no shell) for cross-platform safety.
  const { stdout } = await execFileAsync(
    "tar", ["-tvzf", archivePath], { maxBuffer: TAR_MAX_BUFFER }
  );

  // Parse verbose output: validate entry types, extract paths, track symlinks.
  // Verbose format: "drwxr-xr-x user/group 0 2025-01-01 00:00 path/"
  //                 "-rw-r--r-- user/group 1234 2025-01-01 00:00 path/file"
  //                 "lrwxrwxrwx user/group 0 2025-01-01 00:00 link -> target"
  const symlinkPaths = new Set<string>();
  const dirPaths: string[] = [];
  const filePaths: string[] = [];

  for (const line of stdout.trim().split("\n")) {
    if (!line || line.startsWith("total ")) continue;
    const typeChar = line[0];
    if (typeChar !== "-" && typeChar !== "d" && typeChar !== "l") {
      throw new Error(`Archive contains unsupported entry type: "${typeChar}"`);
    }
    // Extract path: everything after the time field (HH:MM).
    // Works for both GNU tar ("2025-01-01 14:23 path") and BSD tar ("Mar  1 14:23 path").
    // For symlinks, strip " -> target" suffix.
    const pathMatch = line.match(/\d{2}:\d{2}\s+(.+)/);
    if (!pathMatch) continue;
    let entryPath = pathMatch[1];
    if (typeChar === "l") {
      const arrowIdx = entryPath.indexOf(" -> ");
      if (arrowIdx !== -1) entryPath = entryPath.slice(0, arrowIdx);
      symlinkPaths.add(entryPath);
    } else if (typeChar === "d") {
      dirPaths.push(entryPath.replace(/\/$/, ""));
    } else {
      filePaths.push(entryPath);
    }
  }

  // Validate ALL entry paths — not just regular files.
  // Directories and symlinks are extracted by downloadCheckpoint, so their
  // paths must also be free of traversal (../, absolute, null bytes).
  assertSafePaths(dirPaths);
  assertSafePaths([...symlinkPaths]);
  return assertSafePaths(filePaths);
}

/**
 * Extract files from a tar.gz archive to a local directory.
 * Uses --no-same-owner and --no-same-permissions for safety.
 * If specificFiles is provided, only those files are extracted.
 */
async function extractTarFiles(
  archivePath: string,
  toDir: string,
  specificFiles?: string[]
): Promise<void> {
  await ensureTarAvailable();
  await mkdir(toDir, { recursive: true });
  const args = ["-xzf", archivePath, "--no-same-owner", "--no-same-permissions", "-C", toDir];
  if (specificFiles?.length) {
    args.push("--", ...specificFiles);
  }
  await execFileAsync("tar", args, { maxBuffer: TAR_MAX_BUFFER });
}

/**
 * Minimal glob-to-regex conversion for file matching.
 * Supports: ** (any path), * (any non-slash), ? (single char).
 */
function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 3;
      } else {
        regex += ".*";
        i += 2;
      }
    } else if (c === "*") {
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(c)) {
      regex += "\\" + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

/**
 * Create a standalone storage client for browsing and fetching checkpoints.
 *
 * @example
 * const s = storage({ url: "s3://my-bucket/prefix/" });
 * const checkpoints = await s.listCheckpoints({ tag: "poker-agent" });
 * const files = await s.downloadFiles("latest");
 *
 * @example
 * // Gateway mode (uses EVOLVE_API_KEY from env)
 * const s = storage();
 * const files = await s.downloadFiles("ckpt_abc123", { to: "./output" });
 */
/**
 * Internal factory with gateway credential binding.
 * Used by Evolve.storage() to pass bound credentials without leaking
 * the overrides parameter into the public storage() signature.
 */
/** @internal — used by Evolve.storage(), not part of the public API. */
export function createBoundStorageClient(
  config: StorageConfig,
  overrides: { gatewayUrl?: string; gatewayApiKey?: string }
): StorageClient {
  const resolved = resolveStorageForStandalone(config, overrides);
  return buildStorageClient(resolved);
}

export function storage(config?: StorageConfig): StorageClient {
  const resolved = resolveStorageForStandalone(config || {});
  return buildStorageClient(resolved);
}

function buildStorageClient(resolved: ResolvedStorageConfig): StorageClient {

  return {
    async listCheckpoints(options) {
      const normalizedLimit = normalizeLimit(options?.limit);

      if (resolved.mode === "byok") {
        return s3ListCheckpoints(resolved, { limit: normalizedLimit, tag: options?.tag });
      } else {
        return gatewayListCheckpoints(resolved, { limit: normalizedLimit, tag: options?.tag });
      }
    },

    async getCheckpoint(id: string) {
      return getCheckpointInfo(resolved, id);
    },

    async downloadCheckpoint(idOrLatest: string, options?: DownloadCheckpointOptions) {
      const extract = options?.extract !== false; // default: true
      const toDir = options?.to || process.cwd();

      const id = await resolveCheckpointId(resolved, idOrLatest);
      const { tmpPath, metadata } = await downloadArchiveToLocal(resolved, id);

      try {
        if (extract) {
          await mkdir(toDir, { recursive: true });
          await listTarFiles(tmpPath); // validates: throws on links or unsafe paths
          await extractTarFiles(tmpPath, toDir); // extract all — no ARG_MAX risk
          return toDir;
        } else {
          // Save raw archive
          await mkdir(toDir, { recursive: true });
          const destPath = join(toDir, `checkpoint-${metadata.id}.tar.gz`);
          await copyFile(tmpPath, destPath);
          return destPath;
        }
      } finally {
        await unlink(tmpPath).catch(() => {});
      }
    },

    async downloadFiles(idOrLatest: string, options?: DownloadFilesOptions) {
      const id = await resolveCheckpointId(resolved, idOrLatest);
      const { tmpPath } = await downloadArchiveToLocal(resolved, id);
      let extractDir: string | undefined;

      try {
        // List archive contents (already filtered for safe paths)
        const allFiles = await listTarFiles(tmpPath);

        // Determine which files to extract
        let targetFiles: string[];
        if (options?.files) {
          const unsafeRequested = options.files.filter((f) => !isSafeArchivePath(f));
          if (unsafeRequested.length > 0) {
            throw new Error(`Unsafe file path requested: ${unsafeRequested[0]}`);
          }
          const requested = new Set(options.files);
          targetFiles = allFiles.filter((f) => requested.has(f));
        } else if (options?.glob) {
          const patterns = options.glob.map(globToRegex);
          targetFiles = allFiles.filter((f) => patterns.some((re) => re.test(f)));
        } else {
          targetFiles = allFiles; // all files (already safe-filtered by listTarFiles)
        }

        if (targetFiles.length === 0) {
          return {};
        }

        // Extract to temp dir. Try selective extraction first; fall back to
        // full extraction if the file list is too long for ARG_MAX.
        extractDir = join(tmpdir(), `evolve-extract-${Date.now()}`);
        try {
          await extractTarFiles(tmpPath, extractDir, targetFiles);
        } catch (extractErr: unknown) {
          // Only fall back to full extraction for ARG_MAX / argument-length errors.
          // Rethrow everything else (corrupt archive, disk full, permissions).
          const msg = (extractErr as Error)?.message ?? "";
          if (!msg.includes("E2BIG") && !msg.includes("Argument list too long") && !msg.includes("ENAMETOOLONG")) {
            throw extractErr;
          }
          await rm(extractDir, { recursive: true, force: true }).catch(() => {});
          extractDir = join(tmpdir(), `evolve-extract-${Date.now()}`);
          await extractTarFiles(tmpPath, extractDir);
        }

        // Read into FileMap with path validation
        const fileMap: FileMap = {};
        await Promise.all(
          targetFiles.map(async (file) => {
            assertWithinDir(extractDir!, file);
            fileMap[file] = await readFile(join(extractDir!, file));
          })
        );

        // Optionally save to local directory with path validation
        if (options?.to) {
          await mkdir(options.to, { recursive: true });
          await Promise.all(
            Object.entries(fileMap).map(async ([file, content]) => {
              assertWithinDir(options.to!, file);
              const destPath = join(options.to!, file);
              await mkdir(dirname(destPath), { recursive: true });
              await writeFile(destPath, content as Buffer);
            })
          );
        }

        return fileMap;
      } finally {
        // Cleanup temp files — always runs even if write-to-disk fails
        if (extractDir) {
          await rm(extractDir, { recursive: true, force: true }).catch(() => {});
        }
        await unlink(tmpPath).catch(() => {});
      }
    },
  };
}
