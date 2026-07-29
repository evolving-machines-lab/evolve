/**
 * Modal Sandbox Provider - Clean Architecture
 *
 * @requires modal >= 0.9.0
 * @requires Node.js >= 18 (for ReadableStream support)
 *
 * Design principles:
 * - Single way to do things (no dual methods)
 * - Options objects only (no positional args)
 * - All interface methods required (no optional ?)
 * - Configuration externalized (no hardcoded mappings)
 * - Clear naming (run = blocking, spawn = background)
 *
 * Modal-specific notes:
 * - No native file APIs - uses exec() with stdin/stdout
 * - pause() not supported - throws error (use Evolve checkpoints for persistence)
 * - Requires app context for sandbox creation
 * - Hard 24h sandbox lifetime cap (ModalSandboxLifetimeError when exceeded)
 * - Everything executes as root inside the sandbox; the `user` option is
 *   enforced through an `su <user> -c` wrapper (default user: "user")
 * - Network policy maps to Modal's blockNetwork / outboundDomainAllowlist /
 *   outboundCidrAllowlist (domain allowlist admits TLS on port 443 only —
 *   plaintext destinations must be listed as IPs/CIDRs)
 * - Modal exposes no metadata or public timestamps on sandboxes; both are
 *   stamped into sandbox tags at create time and read back via getTags()
 */

import {
  ModalClient,
  Sandbox,
  App,
  Image,
  ContainerProcess,
} from "modal";
import { pack } from "tar-stream";

// ============================================================
// MODULE-LEVEL CONSTANTS & HELPERS
// ============================================================

/** Map generic image names to Docker images */
const IMAGE_MAP: Record<string, string> = {
  "evolve-all": "evolvingmachines/evolve-all",
};

/**
 * Modal's hard cap on sandbox lifetime (24 hours).
 * Requests beyond this throw ModalSandboxLifetimeError.
 */
export const MODAL_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Chunk size for stdin uploads. Modal's gRPC transport rejects any single
 * TaskExecStdinWrite message larger than 100MiB (RESOURCE_EXHAUSTED at
 * 104,857,600 bytes), so file payloads are split into 8MiB writeBytes()
 * calls — the same per-chunk pattern writeStream() uses.
 */
export const MODAL_STDIN_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Default sandbox user. Modal runs everything as root (ignoring the image's
 * USER directive), but agent CLIs refuse certain operations as root, so
 * commands and file ownership default to the image's "user" account.
 */
const DEFAULT_SANDBOX_USER = "user";

/** Tag keys used to stamp Evolve-owned info onto Modal sandboxes. */
const TAG_IMAGE = "evolve.image";
const TAG_STARTED_AT = "evolve.startedAt";

const BINARY_EXTENSIONS = new Set([
  ".xlsx", ".xls", ".docx", ".doc", ".pptx", ".ppt",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".mp3", ".wav", ".ogg", ".flac", ".aac",
  ".mp4", ".avi", ".mov", ".mkv", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dll", ".so", ".dylib",
  ".sqlite", ".db", ".pickle", ".pkl", ".parquet",
]);

function isBinaryFile(path: string): boolean {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Typed error for Modal's hard 24h sandbox lifetime cap.
 * Long-running sessions must persist progress with Evolve checkpoints and
 * resume in a fresh sandbox instead of extending the timeout.
 */
export class ModalSandboxLifetimeError extends Error {
  readonly requestedTimeoutMs: number;

  constructor(requestedTimeoutMs: number) {
    const requestedHours = (requestedTimeoutMs / 3_600_000).toFixed(1);
    super(
      `Modal sandboxes have a hard 24h lifetime cap; requested timeout was ${requestedHours}h. ` +
        "For sessions longer than 24h, persist progress with Evolve checkpoints " +
        "and resume in a fresh sandbox instead of extending the timeout."
    );
    this.name = "ModalSandboxLifetimeError";
    this.requestedTimeoutMs = requestedTimeoutMs;
  }
}

/** Throws ModalSandboxLifetimeError when the timeout exceeds Modal's 24h cap. */
function validateTimeout(timeoutMs: number): void {
  if (timeoutMs > MODAL_MAX_LIFETIME_MS) {
    throw new ModalSandboxLifetimeError(timeoutMs);
  }
}

/**
 * Wrap a command with cwd + env handling and (when not root) an
 * `su <user> -c` wrapper.
 *
 * Modal sandboxes run as root by default (ignoring the Dockerfile USER
 * directive), but Claude CLI and other tools refuse certain operations when
 * running as root.
 *
 * Uses `su <user> -c` instead of `sudo -u <user>` because Claude CLI's
 * --dangerously-skip-permissions flag refuses to run when it detects sudo.
 *
 * Uses base64 encoding to avoid shell escaping issues with complex commands
 * that contain quotes, special characters, etc. Env vars are inlined because
 * su does not preserve the environment the way `sudo -E` does.
 */
function wrapCommand(
  command: string,
  user: string,
  cwd?: string,
  envs?: Record<string, string>
): string[] {
  // Build env prefix for inline variable passing
  let envPrefix = "";
  if (envs && Object.keys(envs).length > 0) {
    envPrefix = Object.entries(envs)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
      .join("; ") + "; ";
  }

  // Build the full command with optional cd
  const fullCmd = cwd
    ? `cd '${cwd.replace(/'/g, "'\\''")}' && ${envPrefix}${command}`
    : `${envPrefix}${command}`;

  // Root is Modal's native execution user - no su wrapper needed
  if (user === "root") {
    return ["bash", "-c", fullCmd];
  }

  // Use base64 encoding to avoid all shell escaping issues
  const encoded = Buffer.from(fullCmd).toString("base64");

  // Use su <user> -c to avoid sudo detection by Claude CLI
  // Decode and execute via bash to preserve all shell features
  return ["su", user, "-c", `echo ${encoded} | base64 -d | bash`];
}

/**
 * Typed error for sizing requests Modal's create() cannot enforce.
 * The installed Modal JS SDK sizes cpu (cores) and memoryMiB at create time
 * only — there is no disk-size parameter, so a requested disk size would be
 * silently ignored. Per the provider law (reject what you cannot enforce,
 * never silently ignore) it is refused loudly here.
 */
export class ModalResourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModalResourcesError";
  }
}

/** Modal create-time sizing defaults (the provider's historical constants). */
const DEFAULT_CPU_CORES = 4;
const DEFAULT_MEMORY_MIB = 4096;

/**
 * Map Evolve's provider-neutral resources (cpu cores, memory GiB, disk GiB)
 * onto Modal's create() params (cpu cores, memoryMiB). Fractional GiB rounds
 * UP so the sandbox never gets less memory than requested. `disk` throws
 * ModalResourcesError — the SDK cannot express it.
 */
function mapResources(
  resources?: SandboxCreateOptions["resources"]
): { cpu: number; memoryMiB: number } {
  if (resources?.disk !== undefined) {
    throw new ModalResourcesError(
      `Modal's JS SDK has no create-time disk-size parameter, so a ${resources.disk} GiB ` +
        "disk request cannot be enforced. Drop `resources.disk` (containers get Modal's " +
        "default disk quota) or run on a provider that sizes disk."
    );
  }
  return {
    cpu: resources?.cpu ?? DEFAULT_CPU_CORES,
    memoryMiB:
      resources?.memory !== undefined
        ? Math.ceil(resources.memory * 1024)
        : DEFAULT_MEMORY_MIB,
  };
}

/** Modal create() params derived from Evolve's provider-neutral network policy. */
interface ModalNetworkCreateParams {
  blockNetwork?: boolean;
  outboundCidrAllowlist?: string[];
  outboundDomainAllowlist?: string[];
}

/** Why a network destination cannot be mapped onto Modal's allowlist. */
export type ModalNetworkPolicyReason = "port-unsupported" | "invalid-ipv4";

/**
 * Typed error for destinations Modal's allowlist cannot express.
 *
 * Modal's allowlist filters hosts (domain allowlist) and IPs/CIDRs (CIDR
 * allowlist) only — it has no notion of a port, and an invalid IPv4/CIDR
 * would be silently forwarded to the API. Both are rejected loudly here
 * instead of weakening or mangling the sandbox's egress policy.
 */
export class ModalNetworkPolicyError extends Error {
  readonly reason: ModalNetworkPolicyReason;
  /** The offending destination. */
  readonly destination?: string;

  constructor(reason: ModalNetworkPolicyReason, message: string, destination?: string) {
    super(message);
    this.name = "ModalNetworkPolicyError";
    this.reason = reason;
    this.destination = destination;
  }
}

/**
 * Strict IPv4 literal or IPv4 CIDR (e.g. "10.0.0.1", "10.0.0.0/8"): every
 * octet is 0-255 and the optional prefix is 0-32. "300.1.1.1" and
 * "10.0.0.0/40" are rejected here rather than forwarded to the API.
 */
function isIpv4Destination(destination: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,3}))?$/.exec(destination);
  if (!match) return false;
  if ([match[1], match[2], match[3], match[4]].some((octet) => Number(octet) > 255)) return false;
  if (match[5] !== undefined && Number(match[5]) > 32) return false;
  return true;
}

/**
 * Dotted-quad shape (optionally with a /prefix) that is NOT a valid IPv4/CIDR
 * — an out-of-range octet (>255) or prefix (>32). Used to reject
 * "300.1.1.1" / "10.0.0.0/40" loudly instead of treating them as hostnames.
 */
function looksLikeInvalidIpv4(destination: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}(\/\d+)?$/.test(destination) && !isIpv4Destination(destination);
}

/**
 * True IPv6 literal or IPv6 CIDR (e.g. "2001:db8::1", "2001:db8::/32",
 * "[2001:db8::1]"): bracketed, or at least two colons. A single colon is a
 * "host:port" / "ip:port" destination, handled by hasPort() instead.
 */
function isIpv6Destination(destination: string): boolean {
  if (destination.startsWith("[")) return true;
  return (destination.match(/:/g)?.length ?? 0) >= 2;
}

/**
 * "host:port" / "ip:port" shape (exactly one colon, numeric port). Modal's
 * allowlist filters hosts and IPs only, so a port cannot be honored.
 */
function hasPort(destination: string): boolean {
  return /^[^:]+:\d+$/.test(destination);
}

/**
 * Map Evolve's provider-neutral network policy onto Modal create() params.
 *
 * - outbound "open" (or no policy)     → no restrictions
 * - outbound "blocked", no allowlist   → blockNetwork: true (drops all egress)
 * - outbound "blocked" with allowlist  → outboundDomainAllowlist (hostnames,
 *   wildcards like "*.example.com") + outboundCidrAllowlist (IPs/CIDRs; bare
 *   IPs get /32 or /128 appended). Both lists are always set because Modal
 *   treats an unset list as "allow all" — an empty array means "allow none"
 *   for that class of destination. Note: Modal's domain allowlist only admits
 *   TLS traffic on port 443; plaintext destinations must be listed as CIDRs.
 */
function mapNetworkPolicy(
  network?: SandboxCreateOptions["network"]
): ModalNetworkCreateParams {
  if (!network || network.outbound === "open") {
    if (network?.allowedDestinations?.length) {
      throw new Error("network.allowedDestinations is only valid when outbound is blocked");
    }
    return {};
  }

  const destinations = network.allowedDestinations ?? [];
  if (destinations.length === 0) {
    return { blockNetwork: true };
  }

  const cidrs: string[] = [];
  const domains: string[] = [];
  for (const destination of destinations) {
    if (isIpv4Destination(destination)) {
      cidrs.push(destination.includes("/") ? destination : `${destination}/32`);
    } else if (looksLikeInvalidIpv4(destination)) {
      throw new ModalNetworkPolicyError(
        "invalid-ipv4",
        `"${destination}" is not a valid IPv4 address or CIDR (octets must be 0-255, prefix 0-32). ` +
          "Fix the address or list a hostname instead.",
        destination
      );
    } else if (isIpv6Destination(destination)) {
      cidrs.push(destination.includes("/") ? destination : `${destination}/128`);
    } else if (hasPort(destination)) {
      throw new ModalNetworkPolicyError(
        "port-unsupported",
        `Modal's network allowlist filters hosts and IPs only and cannot match a port; ` +
          `drop the ":<port>" from "${destination}" and list just the host or IP.`,
        destination
      );
    } else {
      domains.push(destination);
    }
  }
  return { outboundCidrAllowlist: cidrs, outboundDomainAllowlist: domains };
}

/** Container registry family for an image tag. */
type ImageRegistry = "aws-ecr" | "gcp-artifact-registry" | "registry";

/** Detect which Modal image constructor an image tag needs. */
function resolveImageRegistry(tag: string): ImageRegistry {
  const host = tag.split("/")[0];
  if (/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) {
    return "aws-ecr";
  }
  if (host === "gcr.io" || host.endsWith(".gcr.io") || host.endsWith("-docker.pkg.dev")) {
    return "gcp-artifact-registry";
  }
  return "registry";
}

/**
 * Build a SandboxInfo from a sandbox's tags. Modal exposes no metadata or
 * public timestamps, so image and startedAt come from the tags stamped at
 * create time; for sandboxes not created by this SDK they are empty strings
 * (never fabricated). endAt is always undefined — Modal does not expose it.
 */
function buildSandboxInfo(
  sandboxId: string,
  tags: Record<string, string>,
  fallbackImage?: string
): SandboxInfo {
  const { [TAG_IMAGE]: image, [TAG_STARTED_AT]: startedAt, ...metadata } = tags;
  return {
    sandboxId,
    image: image ?? fallbackImage ?? "",
    metadata,
    startedAt: startedAt ?? "",
  };
}

// ============================================================
// CORE TYPES
// ============================================================

/** Result of a completed sandbox command */
export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Handle to a running background process in sandbox */
export interface SandboxCommandHandle {
  readonly processId: string;
  wait(): Promise<SandboxCommandResult>;
  kill(): Promise<boolean>;
}

/** Information about a running process */
export interface ProcessInfo {
  processId: string;
  cmd: string;
  args: string[];
  envs: Record<string, string>;
  cwd?: string;
  tag?: string;
}

/** Sandbox metadata and lifecycle info */
export interface SandboxInfo {
  sandboxId: string;
  image: string;
  name?: string;
  metadata: Record<string, string>;
  startedAt: string;
  /** End time (undefined for running sandboxes) */
  endAt?: string;
}

/** File or directory entry info */
export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "dir";
}

/** Filesystem event from watchDir */
export interface FilesystemEvent {
  /** Relative path to the changed file/directory */
  name: string;
  /** Type of filesystem operation */
  type: "create" | "remove" | "rename" | "chmod" | "write";
}

/** Handle to stop watching a directory */
export interface WatchHandle {
  stop(): Promise<void>;
}

/** Options for watching a directory */
export interface WatchOptions {
  recursive?: boolean;
  timeoutMs?: number;
  onExit?: (err?: Error) => void | Promise<void>;
}

// ============================================================
// OPTIONS
// ============================================================

/** Options for blocking sandbox command execution */
export interface SandboxRunOptions {
  timeoutMs?: number;
  envs?: Record<string, string>;
  cwd?: string;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/** Options for spawning background sandbox processes */
export interface SandboxSpawnOptions extends SandboxRunOptions {
  stdin?: boolean;
}

/** Options for connecting to a running process */
export interface SandboxConnectOptions {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  timeoutMs?: number;
}

/** Options for creating a sandbox */
export interface SandboxCreateOptions {
  image?: string;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
  /** Sandbox lifetime in ms. Modal hard-caps lifetime at 24h (MODAL_MAX_LIFETIME_MS). */
  timeoutMs?: number;
  workingDirectory?: string;
  /**
   * Per-sandbox compute sizing: cpu in cores, memory in GiB — mapped to
   * Modal's create-time cpu / memoryMiB requests (defaults when omitted:
   * 4 cores / 4 GiB). `disk` is REJECTED with ModalResourcesError: the Modal
   * JS SDK exposes no disk-size parameter, so a specific disk size cannot be
   * enforced (containers get Modal's default disk quota).
   */
  resources?: { cpu?: number; memory?: number; disk?: number };
  /**
   * Provider-neutral outbound network policy, enforced by Modal's network
   * stack. "blocked" with no allowedDestinations drops all egress; with
   * allowedDestinations, hostnames go to Modal's domain allowlist (TLS/443
   * only) and IPs/CIDRs to the CIDR allowlist.
   */
  network?: {
    outbound: "open" | "blocked";
    allowedDestinations?: string[];
  };
  /**
   * Run all commands and file operations as this user (default "user"),
   * enforced via an `su <user> -c` wrapper since Modal executes everything as
   * root. Pass "root" to run directly as root with no wrapper.
   */
  user?: string;
  /** Home directory used by the SDK for agent config paths; not consumed by the provider. */
  homeDir?: string;
}

/** Options for listing sandboxes */
export interface SandboxListOptions {
  /** Modal has no paused state; filters that exclude "running" match nothing. */
  state?: ("running" | "paused")[];
  metadata?: Record<string, string>;
  limit?: number;
}

/**
 * A COMPLETE (or admittedly incomplete) enumeration of the app's fleet.
 *
 * `complete` is the load-bearing field. Callers that need a whole fleet —
 * orphan sweeps, lifecycle reconciliation — read a sandbox's ABSENCE from the
 * list as evidence it is gone, so a truncated walk and a small fleet must never
 * be the same answer. That includes a walk stopped by the caller's own `limit`:
 * "you asked for ten and there are more" is a truncated fleet.
 */
export interface SandboxListPage {
  sandboxes: SandboxInfo[];
  complete: boolean;
  pagesFetched: number;
  error?: string;
}

/**
 * Sandboxes a single enumeration will walk before it gives up and reports
 * itself incomplete. Modal's list is an async generator with no page size we
 * control, so the ceiling is counted in SANDBOXES rather than pages — same
 * purpose as the other providers' page caps: never return a short list that
 * reads like a whole one.
 */
export const MODAL_MAX_LIST_SANDBOXES = 10_000;

// ============================================================
// INTERFACES
// ============================================================

/** Command execution capabilities */
export interface SandboxCommands {
  /** Run command and wait for completion */
  run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult>;

  /** Spawn background process, returns handle for control */
  spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle>;

  /** List running processes */
  list(): Promise<ProcessInfo[]>;

  /** Connect to existing process by ID */
  connect(processId: string, options?: SandboxConnectOptions): Promise<SandboxCommandHandle>;

  /** Send data to process stdin */
  sendStdin(processId: string, data: string): Promise<void>;

  /** Kill process by ID */
  kill(processId: string): Promise<boolean>;
}

/** File system operations */
export interface SandboxFiles {
  // --- Read/Write ---

  /** Read file (auto-detects binary by extension) */
  read(path: string): Promise<string | Uint8Array>;

  /** Write single file */
  write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void>;

  /** Write multiple files in batch */
  writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void>;

  // --- Streaming (large files without memory load) ---

  /** Read file as stream */
  readStream(path: string): Promise<ReadableStream<Uint8Array>>;

  /** Write from stream */
  writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void>;

  /** Upload a local file by path, streamed off disk (never buffered whole) */
  writeFromPath(sandboxPath: string, localPath: string): Promise<void>;

  // --- Large File URLs (browser-friendly) ---

  /** Get pre-signed upload URL for large files (expiration in seconds) */
  uploadUrl(path: string, expiresInSeconds?: number): Promise<string>;

  /** Get pre-signed download URL for large files (expiration in seconds) */
  downloadUrl(path: string, expiresInSeconds?: number): Promise<string>;

  // --- Directory & Utilities ---

  /** Create directory (recursive) */
  makeDir(path: string): Promise<void>;

  /** Check if file or directory exists */
  exists(path: string): Promise<boolean>;

  /** List directory contents */
  list(path: string): Promise<FileInfo[]>;

  /** Delete file or directory */
  remove(path: string): Promise<void>;

  /** Rename or move file/directory */
  rename(oldPath: string, newPath: string): Promise<void>;

  /** Watch directory for changes */
  watchDir(
    path: string,
    onEvent: (event: FilesystemEvent) => void | Promise<void>,
    options?: WatchOptions
  ): Promise<WatchHandle>;
}

/** Sandbox instance with full capabilities */
export interface SandboxInstance {
  readonly sandboxId: string;
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;

  /** Get public URL for port */
  getHost(port: number): Promise<string>;

  /** Check if sandbox is running */
  isRunning(): Promise<boolean>;

  /** Get sandbox metadata and timing */
  getInfo(): Promise<SandboxInfo>;

  /** Terminate sandbox */
  kill(): Promise<void>;

  /** Pause sandbox (preserves state) */
  pause(): Promise<void>;
}

/** Sandbox lifecycle management */
export interface SandboxProvider {
  /** Provider type identifier */
  readonly providerType: string;

  /** Human-readable provider name for logging */
  readonly name?: string;

  /** Create new sandbox */
  create(options: SandboxCreateOptions): Promise<SandboxInstance>;

  /** Connect to existing sandbox */
  connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance>;

  /** List sandboxes (first page only, up to limit) */
  /** List sandboxes, walking the whole app. `limit` bounds items returned. */
  list(options?: SandboxListOptions): Promise<SandboxInfo[]>;
  /** The same enumeration for fleet bookkeeping: never throws, reports completeness. */
  listAll(options?: SandboxListOptions): Promise<SandboxListPage>;
}

// ============================================================
// CONFIGURATION
// ============================================================

export interface ModalConfig {
  /** Modal app name. Default: "evolve-sandbox" */
  appName?: string;
  /** Default timeout in ms. Default: 3600000 (1 hour) */
  defaultTimeoutMs?: number;
  /** Modal token ID. Falls back to MODAL_TOKEN_ID env var */
  tokenId?: string;
  /** Modal token secret. Falls back to MODAL_TOKEN_SECRET env var */
  tokenSecret?: string;
  /** Modal API endpoint. Default: https://api.modal.com:443 */
  endpoint?: string;
  /** Docker image name (default: 'evolve-all'). Resolved through IMAGE_MAP or used as-is for custom images. */
  imageName?: string;
  /**
   * Name of a Modal Secret holding registry credentials for private images.
   * Required for AWS ECR (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
   * AWS_REGION with read-only ECR IAM) and GCP Artifact Registry; optional
   * for private Docker Hub images. Create one at https://modal.com/secrets
   */
  imageSecretName?: string;
}

/** Internal resolved config with required credentials */
interface ResolvedModalConfig {
  tokenId: string;
  tokenSecret: string;
  appName?: string;
  defaultTimeoutMs?: number;
  endpoint?: string;
  imageName?: string;
  imageSecretName?: string;
}

// ============================================================
// IMPLEMENTATION
// ============================================================

export class ModalCommands implements SandboxCommands {
  constructor(private sandbox: Sandbox, private user: string) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    // Wrap command for the configured sandbox user with shell features.
    // Envs are inlined by wrapCommand (su doesn't preserve env like sudo -E).
    const args = wrapCommand(command, this.user, options?.cwd, options?.envs);

    const p = await this.sandbox.exec(args, {
      timeoutMs: options?.timeoutMs,
      // Don't pass envs to exec - they're inlined in the command via wrapCommand
    });

    // Always accumulate output using for-await pattern (more reliable with Modal streams)
    const { stdout, stderr } = await this.accumulateStreams(p, options?.onStdout, options?.onStderr);

    const exitCode = await p.wait();
    return { exitCode, stdout, stderr };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    // Wrap command for the configured sandbox user with shell features.
    // Envs are inlined by wrapCommand (su doesn't preserve env like sudo -E).
    const args = wrapCommand(command, this.user, options?.cwd, options?.envs);
    const p = await this.sandbox.exec(args, {
      timeoutMs: options?.timeoutMs,
      // Don't pass envs to exec - they're inlined in the command via wrapCommand
    });

    // Accumulate streams in background for the wait() call
    let stdoutBuffer = "";
    let stderrBuffer = "";

    // Start streaming in background (non-blocking)
    const streamPromise = this.accumulateStreams(
      p,
      options?.onStdout ? (chunk) => { options.onStdout!(chunk); } : undefined,
      options?.onStderr ? (chunk) => { options.onStderr!(chunk); } : undefined
    ).then(({ stdout, stderr }) => {
      stdoutBuffer = stdout;
      stderrBuffer = stderr;
    }).catch(() => {});

    const processId = `modal-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return {
      processId,
      wait: async () => {
        await streamPromise;
        const exitCode = await p.wait();
        return { exitCode, stdout: stdoutBuffer, stderr: stderrBuffer };
      },
      kill: async () => false, // Modal doesn't expose process kill by PID
    };
  }

  async list(): Promise<ProcessInfo[]> {
    const p = await this.sandbox.exec(["ps", "-eo", "pid,comm,args"], { timeoutMs: 10000 });
    await p.wait();
    const output = await p.stdout.readText();

    const lines = output.trim().split("\n").slice(1);
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        processId: parts[0],
        cmd: parts[1] || "",
        args: parts.slice(2),
        envs: {},
      };
    });
  }

  async connect(_processId: string, _options?: SandboxConnectOptions): Promise<SandboxCommandHandle> {
    throw new Error("Modal does not support connecting to existing processes");
  }

  async sendStdin(_processId: string, _data: string): Promise<void> {
    throw new Error("Modal does not support sendStdin by process ID");
  }

  async kill(processId: string): Promise<boolean> {
    const p = await this.sandbox.exec(["kill", "-9", processId], { timeoutMs: 10000 });
    const exitCode = await p.wait();
    return exitCode === 0;
  }

  /**
   * Accumulate stdout/stderr using for-await pattern (more reliable with Modal streams).
   * Based on vibekit's approach which works correctly with Modal SDK.
   */
  private async accumulateStreams(
    p: ContainerProcess<string>,
    onStdout?: (data: string) => void,
    onStderr?: (data: string) => void
  ): Promise<{ stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";

    const promises: Promise<void>[] = [];

    // Stream stdout using for-await (Modal stream is async iterable)
    promises.push(
      (async () => {
        try {
          // @ts-ignore - Modal stream is async iterable of Uint8Array|string
          for await (const chunk of p.stdout as any) {
            const text = typeof chunk === "string"
              ? chunk
              : new TextDecoder().decode(chunk);
            stdout += text;
            onStdout?.(text);
          }
        } catch {
          // Stream may close unexpectedly
        }
      })()
    );

    // Stream stderr using for-await
    promises.push(
      (async () => {
        try {
          // @ts-ignore - Modal stream is async iterable of Uint8Array|string
          for await (const chunk of p.stderr as any) {
            const text = typeof chunk === "string"
              ? chunk
              : new TextDecoder().decode(chunk);
            stderr += text;
            onStderr?.(text);
          }
        } catch {
          // Stream may close unexpectedly
        }
      })()
    );

    await Promise.all(promises);
    return { stdout, stderr };
  }
}

export class ModalFiles implements SandboxFiles {
  constructor(private sandbox: Sandbox, private user: string) {}

  /**
   * Chown a path to the sandbox user so agent CLIs (running via the su
   * wrapper) can access files created by root-level exec. No-op when the
   * sandbox user is root.
   */
  private async chownToUser(path: string, recursive = false): Promise<void> {
    if (this.user === "root") return;
    const args = recursive
      ? ["chown", "-R", `${this.user}:${this.user}`, path]
      : ["chown", `${this.user}:${this.user}`, path];
    const p = await this.sandbox.exec(args, { timeoutMs: recursive ? 30000 : 10000 });
    await p.wait();
  }

  /**
   * Write a payload to a process's stdin in MODAL_STDIN_CHUNK_BYTES slices.
   * Each writeBytes() call becomes one gRPC TaskExecStdinWrite message and
   * Modal rejects messages over 100MiB, so large files must be chunked
   * (multi-hundred-MB payloads are common).
   */
  private async writeStdinChunked(
    stdin: { writeBytes(data: Uint8Array): Promise<void> },
    data: Uint8Array
  ): Promise<void> {
    for (let offset = 0; offset < data.length; offset += MODAL_STDIN_CHUNK_BYTES) {
      await stdin.writeBytes(data.subarray(offset, offset + MODAL_STDIN_CHUNK_BYTES));
    }
  }

  async read(path: string): Promise<string | Uint8Array> {
    if (isBinaryFile(path)) {
      // Binary: use cat with binary mode - no base64 overhead
      const p = await this.sandbox.exec(["cat", path], { timeoutMs: 300000, mode: "binary" });
      const exitCode = await p.wait();
      if (exitCode !== 0) {
        const stderr = await p.stderr.readText();
        throw new Error(`Failed to read file ${path}: ${stderr || `exit code ${exitCode}`}`);
      }
      return await p.stdout.readBytes();
    }
    // Text: read directly via exec
    const p = await this.sandbox.exec(["cat", path], { timeoutMs: 300000 });
    const exitCode = await p.wait();
    if (exitCode !== 0) {
      const stderr = await p.stderr.readText();
      throw new Error(`Failed to read file ${path}: ${stderr || `exit code ${exitCode}`}`);
    }
    return await p.stdout.readText();
  }

  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    const data = this.toBuffer(content);
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) await this.makeDir(dir);

    const escapedPath = path.replace(/'/g, "'\\''");
    const p = await this.sandbox.exec(["bash", "-c", `cat > '${escapedPath}'`], { mode: "binary" });

    // Chunked writeBytes(): one gRPC message per chunk, under Modal's 100MiB cap
    await this.writeStdinChunked(p.stdin, new Uint8Array(data));
    const writer = p.stdin.getWriter();
    await writer.close();
    await p.wait();

    // Chown the file to the sandbox user so agent CLIs can access it
    await this.chownToUser(path);
  }

  async writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {
    const tarPack = pack();
    const chunks: Buffer[] = [];

    // Collect unique parent directories for chown
    const dirs = new Set<string>();

    for (const file of files) {
      const data = this.toBuffer(file.data);
      const name = file.path.startsWith("/") ? file.path.slice(1) : file.path;
      tarPack.entry({ name }, data);

      // Track parent directories
      const parentDir = file.path.substring(0, file.path.lastIndexOf("/"));
      if (parentDir) {
        dirs.add(parentDir);
      }
    }
    tarPack.finalize();

    for await (const chunk of tarPack) {
      chunks.push(Buffer.from(chunk));
    }
    const tarBuffer = Buffer.concat(chunks);

    const p = await this.sandbox.exec(["tar", "-xf", "-", "-C", "/"], { mode: "binary" });
    // Chunked writeBytes(): one gRPC message per chunk, under Modal's 100MiB cap
    await this.writeStdinChunked(p.stdin, new Uint8Array(tarBuffer));
    const writer = p.stdin.getWriter();
    await writer.close();
    await p.wait();

    // Chown all created files and directories to the sandbox user so agent
    // CLIs (running via the su wrapper) can write to them
    if (dirs.size > 0) {
      const dirsArray = Array.from(dirs);
      // Chown the root workspace directory recursively
      const rootDirs = new Set(dirsArray.map(d => d.split("/").slice(0, 4).join("/")));
      for (const dir of rootDirs) {
        await this.chownToUser(dir, true);
      }
    }
  }

  async makeDir(path: string): Promise<void> {
    const p = await this.sandbox.exec(["mkdir", "-p", path], { timeoutMs: 10000 });
    await p.wait();

    // Chown the directory to the sandbox user so agent CLIs can write to it
    await this.chownToUser(path, true);
  }

  async exists(path: string): Promise<boolean> {
    const p = await this.sandbox.exec(["test", "-e", path], { timeoutMs: 10000 });
    const exitCode = await p.wait();
    return exitCode === 0;
  }

  async list(path: string): Promise<FileInfo[]> {
    const escapedPath = path.replace(/'/g, "'\\''");
    const p = await this.sandbox.exec(["bash", "-c", `ls -la '${escapedPath}' | tail -n +2`], { timeoutMs: 30000 });
    await p.wait();
    const output = await p.stdout.readText();

    const entries: FileInfo[] = [];
    for (const line of output.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      const permissions = parts[0];
      const name = parts.slice(8).join(" ");
      if (name === "." || name === "..") continue;

      entries.push({
        name,
        path: path.endsWith("/") ? `${path}${name}` : `${path}/${name}`,
        type: permissions.startsWith("d") ? "dir" : "file",
      });
    }
    return entries;
  }

  async remove(path: string): Promise<void> {
    const p = await this.sandbox.exec(["rm", "-rf", path], { timeoutMs: 30000 });
    await p.wait();
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const p = await this.sandbox.exec(["mv", oldPath, newPath], { timeoutMs: 30000 });
    await p.wait();
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const p = await this.sandbox.exec(["cat", path], { timeoutMs: 300000, mode: "binary" });
    return p.stdout as unknown as ReadableStream<Uint8Array>;
  }

  async writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) await this.makeDir(dir);

    const escapedPath = path.replace(/'/g, "'\\''");
    const p = await this.sandbox.exec(["bash", "-c", `cat > '${escapedPath}'`], { mode: "binary" });

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Split per chunk, not just per call: a source yielding >100MiB in one
        // chunk would otherwise blow Modal's gRPC message cap. fs read streams
        // (what writeFromPath feeds in) stay at 64KiB, so this is a no-op there.
        await this.writeStdinChunked(p.stdin, value);
      }
    } finally {
      reader.releaseLock();
    }

    const writer = p.stdin.getWriter();
    await writer.close();
    await p.wait();

    // Chown the file to the sandbox user so agent CLIs can access it
    await this.chownToUser(path);
  }

  /**
   * Upload a local file by PATH, chunk by chunk into the same `cat >` sink
   * writeStream() uses — so peak memory is one chunk rather than the whole
   * file, which is what makes a large artifact safe under concurrency.
   */
  async writeFromPath(sandboxPath: string, localPath: string): Promise<void> {
    const { createReadStream } = await import("node:fs");
    const { Readable } = await import("node:stream");
    const web = Readable.toWeb(
      createReadStream(localPath)
    ) as ReadableStream<Uint8Array>;
    await this.writeStream(sandboxPath, web);
  }

  async uploadUrl(_path: string, _expiresInSeconds?: number): Promise<string> {
    throw new Error("Modal does not support pre-signed upload URLs");
  }

  async downloadUrl(_path: string, _expiresInSeconds?: number): Promise<string> {
    throw new Error("Modal does not support pre-signed download URLs");
  }

  async watchDir(
    _path: string,
    _onEvent: (event: FilesystemEvent) => void | Promise<void>,
    _options?: WatchOptions
  ): Promise<WatchHandle> {
    throw new Error("Modal does not support watchDir");
  }

  private toBuffer(content: string | Buffer | ArrayBuffer | Uint8Array): Buffer {
    if (typeof content === "string") return Buffer.from(content, "utf-8");
    if (content instanceof Buffer) return content;
    if (content instanceof ArrayBuffer) return Buffer.from(content);
    if (content instanceof Uint8Array) return Buffer.from(content);
    throw new Error(`Unsupported data type: ${typeof content}`);
  }
}

class ModalSandboxImpl implements SandboxInstance {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
  private readonly image?: string;

  constructor(private sandbox: Sandbox, image: string | undefined, user: string) {
    this.commands = new ModalCommands(sandbox, user);
    this.files = new ModalFiles(sandbox, user);
    this.image = image;
  }

  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  async getHost(port: number): Promise<string> {
    const tunnels = await this.sandbox.tunnels();
    const tunnel = tunnels[port];
    if (!tunnel) throw new Error(`No tunnel found for port ${port}`);
    return tunnel.url;
  }

  async isRunning(): Promise<boolean> {
    try {
      // poll() returns null while running, the exit code once finished
      return (await this.sandbox.poll()) === null;
    } catch {
      return false;
    }
  }

  async getInfo(): Promise<SandboxInfo> {
    // Metadata and startedAt are stamped into tags at create time; Modal has
    // no metadata API and exposes no public timestamps of its own.
    const tags = await this.sandbox.getTags();
    return buildSandboxInfo(this.sandbox.sandboxId, tags, this.image);
  }

  async kill(): Promise<void> {
    try {
      await this.sandbox.terminate();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      await this.sandbox.terminate();
    }
  }

  async pause(): Promise<void> {
    throw new Error(
      "Modal does not support pause/resume. Persist progress with Evolve checkpoints " +
        "and resume in a fresh sandbox, or use kill() to terminate."
    );
  }
}

export class ModalProvider implements SandboxProvider {
  readonly providerType = "modal" as const;
  readonly name = "Modal";
  private readonly client: ModalClient;
  private readonly appName: string;
  private readonly defaultTimeoutMs: number;
  private readonly imageName: string;
  private readonly imageSecretName?: string;
  private _app: App | undefined;
  /**
   * Sandbox user configured at create time, reapplied on connect() so the su
   * wrapper keeps targeting the same account. In-memory only: a connect()
   * from a fresh process falls back to the default "user" account — callers
   * reconnecting across processes must recreate the provider and sandbox with
   * the same user, or operations on user-owned files fail loudly.
   */
  private readonly sandboxUsers = new Map<string, string>();

  constructor(config: ResolvedModalConfig) {
    // When running inside Modal containers, Modal sets MODAL_SERVER_URL to internal socket.
    // Force external API by overriding env var (SDK ignores endpoint param, only reads env).
    if (!config.endpoint && process.env.MODAL_SERVER_URL?.startsWith("unix:")) {
      process.env.MODAL_SERVER_URL = "https://api.modal.com:443";
    } else if (config.endpoint) {
      process.env.MODAL_SERVER_URL = config.endpoint;
    }
    this.client = new ModalClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret });
    this.appName = config.appName ?? "evolve-sandbox";
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 3600000;
    this.imageName = config.imageName ?? "evolve-all";
    this.imageSecretName = config.imageSecretName;
  }

  private async getApp(): Promise<App> {
    if (!this._app) {
      // Use client.apps.fromName() - the modern API
      this._app = await this.client.apps.fromName(this.appName, { createIfMissing: true });
    }
    return this._app;
  }

  /**
   * Build a Modal Image for the resolved tag, routing private registries
   * (AWS ECR, GCP Artifact Registry) through the configured Modal Secret.
   */
  private async resolveImage(tag: string): Promise<Image> {
    const registry = resolveImageRegistry(tag);

    if (registry === "registry") {
      // Public registries need no secret; a configured one enables private Docker Hub images
      const secret = this.imageSecretName
        ? await this.client.secrets.fromName(this.imageSecretName)
        : undefined;
      return this.client.images.fromRegistry(tag, secret);
    }

    if (!this.imageSecretName) {
      throw new Error(
        `Private registry image "${tag}" requires config.imageSecretName — the name of a Modal Secret ` +
          "holding registry credentials (AWS ECR: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION " +
          "with read-only ECR IAM). Create one at https://modal.com/secrets"
      );
    }
    const secret = await this.client.secrets.fromName(this.imageSecretName);
    return registry === "aws-ecr"
      ? this.client.images.fromAwsEcr(tag, secret)
      : this.client.images.fromGcpArtifactRegistry(tag, secret);
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    // Validate before any network call so misconfigurations fail fast
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    validateTimeout(timeoutMs);
    const networkParams = mapNetworkPolicy(options.network);
    const sizing = mapResources(options.resources);
    const user = options.user ?? DEFAULT_SANDBOX_USER;

    const app = await this.getApp();

    // Resolve image name through IMAGE_MAP (e.g., "evolve-all" -> "evolvingmachines/evolve-all")
    const imageName = options.image || this.imageName;
    const resolvedImage = IMAGE_MAP[imageName] ?? imageName;

    // Eagerly build image on Modal's infra (idempotent — same tag returns same cached imageId).
    // First run pulls from the registry and caches; subsequent runs resolve quickly.
    const image = await this.resolveImage(resolvedImage);
    const builtImage = await image.build(app);

    // Filter out undefined values and only pass env if non-empty
    // Modal SDK throws if env is empty object or contains undefined values
    const filteredEnvs = options.envs
      ? Object.fromEntries(
          Object.entries(options.envs).filter(([, v]) => v !== undefined && v !== null)
        )
      : undefined;
    const env = filteredEnvs && Object.keys(filteredEnvs).length > 0 ? filteredEnvs : undefined;

    // Stamp metadata + Evolve-owned info into tags: Modal has no metadata API
    // and no public timestamps, so tags are the durable record for list()/getInfo()
    const tags: Record<string, string> = {
      ...options.metadata,
      [TAG_IMAGE]: resolvedImage,
      [TAG_STARTED_AT]: new Date().toISOString(),
    };

    // Use client.sandboxes.create() - the modern API
    // Sizing from options.resources (cpu cores / memory GiB -> memoryMiB);
    // defaults preserve the provider's historical 4 CPU / 4 GiB constants.
    const sandbox = await this.client.sandboxes.create(app, builtImage, {
      cpu: sizing.cpu,
      memoryMiB: sizing.memoryMiB,
      timeoutMs,
      workdir: options.workingDirectory,
      env,
      tags,
      ...networkParams,
    });

    // Fix workspace directory ownership (Modal creates it as root, but the
    // sandbox user needs write access). Skipped when running as root.
    if (options.workingDirectory && user !== "root") {
      const chown = await sandbox.exec(
        ["chown", "-R", `${user}:${user}`, options.workingDirectory],
        { timeoutMs: 30000 }
      );
      await chown.wait();
    }

    this.sandboxUsers.set(sandbox.sandboxId, user);

    return new ModalSandboxImpl(sandbox, resolvedImage, user);
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    // Use client.sandboxes.fromId() - the modern API
    const sandbox = await this.client.sandboxes.fromId(sandboxId);
    // Image is recovered lazily from tags in getInfo(); user falls back to the
    // default account when this process didn't create the sandbox.
    const user = this.sandboxUsers.get(sandboxId) ?? DEFAULT_SANDBOX_USER;
    return new ModalSandboxImpl(sandbox, undefined, user);
  }

  /**
   * List sandboxes, walking the whole app.
   *
   * This used to stop at a hardcoded default of 100 regardless of fleet size,
   * which silently truncated any app with more — and said nothing about it
   * while the shared SandboxProvider interface promised exhaustive listing.
   * `limit` still bounds the sandboxes RETURNED, so a caller wanting one cheap
   * sample asks for one; without it the answer is the whole app.
   *
   * The O(N)-round-trips warning below is unchanged and is the reason `limit`
   * matters here more than on the other providers.
   */
  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    const page = await this.walk(options);
    // A walk stopped by the caller's own limit is not a failure; only one that
    // could not finish is. `listAll` reports that distinction instead.
    if (page.error && !page.stoppedAtLimit) throw new Error(page.error);
    return page.sandboxes;
  }

  /**
   * The fleet-bookkeeping enumeration: same walk, never throws.
   *
   * Modal has no lifecycle webhooks, so absence from a list is the ONLY
   * termination signal either lane gets — which makes the difference between
   * "the app is empty" and "the enumeration stopped early" the difference
   * between a quiet fleet and one about to be reclaimed.
   *
   * NOTE the divergence from `listSandboxIds` below, which returns an EMPTY set
   * on failure on the grounds that partial results are worse than none for a
   * terminal-state decision. This one returns what it saw alongside
   * `complete: false`. Both are safe because `complete` is what callers branch
   * on, and the shared type documents the choice; do not align one to the other
   * without deciding which rule you want.
   */
  async listAll(options?: SandboxListOptions): Promise<SandboxListPage> {
    const { stoppedAtLimit: _stoppedAtLimit, ...page } = await this.walk(options);
    return page;
  }

  private async walk(
    options?: SandboxListOptions,
  ): Promise<SandboxListPage & { stoppedAtLimit: boolean }> {
    // Modal has no paused state; a filter that excludes "running" matches nothing
    if (options?.state && !options.state.includes("running")) {
      return { sandboxes: [], complete: true, pagesFetched: 0, stoppedAtLimit: false };
    }

    let app: Awaited<ReturnType<typeof this.getApp>>;
    try {
      app = await this.getApp();
    } catch (err) {
      return {
        sandboxes: [],
        complete: false,
        pagesFetched: 0,
        stoppedAtLimit: false,
        error: `sandbox list failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Scope to our app; tag filter narrows server-side to sandboxes carrying
    // at least the requested metadata.
    return collectSandboxes(
      () => this.client.sandboxes.list({ appId: app.appId, tags: options?.metadata }),
      options?.limit,
    );
  }

  /**
   * Live sandbox ids for the whole app, in ONE streamed call and O(1) round
   * trips — the fleet-bookkeeping counterpart to `list()`.
   *
   * Exists because `list()` cannot be made cheap without dropping metadata from
   * its contract: it owes callers a populated `SandboxInfo.metadata`, and Modal
   * only serves tags per sandbox. Anything that just needs "which ids are
   * alive" — lifecycle polling, orphan sweeps, reconciliation — uses this and
   * pays one request no matter how large the fleet is.
   *
   * `complete` is the load-bearing field, not a nicety: absence from this list
   * is what callers read as "terminated", so a truncated or errored enumeration
   * MUST NOT be mistaken for an empty fleet. A caller that sees complete=false
   * has to leave rows alone rather than mass-marking live sandboxes dead.
   */
  async listSandboxIds(): Promise<{ ids: Set<string>; complete: boolean }> {
    const ids = new Set<string>();
    try {
      const app = await this.getApp();
      for await (const sandbox of this.client.sandboxes.list({ appId: app.appId })) {
        ids.add(sandbox.sandboxId);
      }
      return { ids, complete: true };
    } catch {
      // Partial results are worse than none for a terminal-state decision.
      return { ids: new Set(), complete: false };
    }
  }
}

/** The streamed sandbox surface this walk needs — Modal's list() satisfies it. */
export interface ModalSandboxStream {
  sandboxId: string;
  getTags(): Promise<Record<string, string>>;
}

/**
 * Drain Modal's sandbox generator into one answer, with an honest completeness
 * verdict.
 *
 * Separate from the provider because everything worth getting wrong lives here
 * and none of it needs a gRPC connection: the difference between "the caller
 * asked for ten" and "the app ran out", the ceiling that stops an unbounded
 * walk, and the rule that a failure mid-walk yields what it saw marked
 * INCOMPLETE rather than an exception or a short complete list.
 *
 * COST WARNING — this loop is O(N) ROUND TRIPS, not O(1). `list()` itself is one
 * streamed call, but `getTags()` is a separate gRPC request per sandbox
 * (`sandboxTagsGet`), so listing N sandboxes costs N+1 calls. That is fine for a
 * user listing their handful of boxes with metadata, and NOT fine for fleet-wide
 * bookkeeping: anything that only needs to know WHICH ids are alive must use
 * `listSandboxIds`, never this. Please do not "optimize" by reintroducing tag
 * reads into those paths.
 *
 * Exported for its test (`_testCollectSandboxes`).
 */
async function collectSandboxes(
  iterate: () => AsyncIterable<ModalSandboxStream>,
  wanted?: number,
): Promise<SandboxListPage & { stoppedAtLimit: boolean }> {
  const sandboxes: SandboxInfo[] = [];
  try {
    for await (const sandbox of iterate()) {
      // BOUND CHECKED BEFORE THE PUSH: checked after, `limit: 0` returns one.
      if (wanted !== undefined && sandboxes.length >= wanted) {
        // We are holding a sandbox we did not return, so this app has more than
        // the caller asked for — a truncated fleet, not a complete one.
        return {
          sandboxes,
          complete: false,
          pagesFetched: sandboxes.length,
          stoppedAtLimit: true,
          error: `stopped at the requested limit of ${wanted} with more sandboxes available`,
        };
      }
      if (sandboxes.length >= MODAL_MAX_LIST_SANDBOXES) {
        return {
          sandboxes,
          complete: false,
          pagesFetched: sandboxes.length,
          stoppedAtLimit: false,
          error: `sandbox list exceeded ${MODAL_MAX_LIST_SANDBOXES} sandboxes`,
        };
      }
      const tags = await sandbox.getTags();
      sandboxes.push(buildSandboxInfo(sandbox.sandboxId, tags));
    }
  } catch (err) {
    return {
      sandboxes,
      complete: false,
      pagesFetched: sandboxes.length,
      stoppedAtLimit: false,
      error: `sandbox list failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { sandboxes, complete: true, pagesFetched: sandboxes.length, stoppedAtLimit: false };
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Create Modal sandbox provider.
 *
 * @param config - Optional configuration. If credentials not provided, reads from env vars.
 * @throws Error if credentials cannot be resolved
 *
 * @see https://github.com/evolving-machines-lab/evolve/issues/8
 */
export function createModalProvider(config: ModalConfig = {}): SandboxProvider {
  const tokenId = config.tokenId ?? process.env.MODAL_TOKEN_ID;
  const tokenSecret = config.tokenSecret ?? process.env.MODAL_TOKEN_SECRET;

  if (!tokenId || !tokenSecret) {
    throw new Error(
      "Modal credentials required. " +
        "Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET environment variables, " +
        "or pass tokenId/tokenSecret in config. " +
        "Get your token at https://modal.com/settings/tokens"
    );
  }

  return new ModalProvider({ ...config, tokenId, tokenSecret });
}

// ============================================================
// TEST-ONLY EXPORTS
// ============================================================

export const _testWrapCommand = wrapCommand;
export const _testMapNetworkPolicy = mapNetworkPolicy;
export const _testMapResources = mapResources;
export const _testResolveImageRegistry = resolveImageRegistry;
export const _testBuildSandboxInfo = buildSandboxInfo;
export const _testCollectSandboxes = collectSandboxes;
export const _testValidateTimeout = validateTimeout;
