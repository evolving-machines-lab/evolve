/**
 * E2B Sandbox Provider - Clean Architecture
 *
 * @requires @e2b/code-interpreter >= 1.0.0 or e2b >= 1.0.0
 * @requires Node.js >= 18 (for ReadableStream support)
 *
 * Design principles:
 * - Single way to do things (no dual methods)
 * - Options objects only (no positional args)
 * - All interface methods required (no optional ?)
 * - Configuration externalized (no hardcoded mappings)
 * - Clear naming (run = blocking, spawn = background)
 */

import { Sandbox as E2BSandbox } from "@e2b/code-interpreter";

// ============================================================
// MODULE-LEVEL CONSTANTS & HELPERS
// ============================================================

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

function toISOString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toArrayBuffer(input: string | Buffer | ArrayBuffer | Uint8Array): string | ArrayBuffer {
  if (typeof input === "string") return input;
  if (input instanceof ArrayBuffer) return input;
  if (input instanceof Buffer) {
    return new Uint8Array(input).buffer;
  }
  if (input instanceof Uint8Array) {
    return new Uint8Array(input).buffer;
  }
  throw new Error(`Unsupported data type for file upload: ${typeof input}. Expected string, Buffer, ArrayBuffer, or Uint8Array.`);
}

function isBinaryFile(path: string): boolean {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Typed error for create-time sizing requests E2B cannot enforce.
 * E2B sandboxes inherit cpu/memory from their TEMPLATE (Template.build
 * cpuCount/memoryMB; disk is plan-fixed) — Sandbox.create has no sizing
 * parameters, so a `resources` request would be silently ignored. Per the
 * provider law (reject what you cannot enforce) it is refused loudly here.
 */
export class E2BResourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2BResourcesError";
  }
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
  image: string;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutMs?: number;
  workingDirectory?: string;
  /**
   * Per-sandbox compute sizing (cpu cores, memory GiB, disk GiB). E2B sizes
   * sandboxes at TEMPLATE BUILD time only (Template.build cpuCount/memoryMB;
   * disk is plan-fixed) — create-time sizing cannot be enforced, so any value
   * here is REJECTED with E2BResourcesError rather than silently ignored.
   * Bake sizing into the template the `image` names instead.
   */
  resources?: { cpu?: number; memory?: number; disk?: number };
  network?: {
    outbound: "open" | "blocked";
    allowedDestinations?: string[];
  };
  /** Run all commands and file operations as this user (passed on every E2B operation that supports it). */
  user?: string;
  /** Home directory used by the SDK for agent config paths; not consumed by the provider. */
  homeDir?: string;
}

/** Options for listing sandboxes */
export interface SandboxListOptions {
  state?: ("running" | "paused")[];
  metadata?: Record<string, string>;
  limit?: number;
}

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

  /** Create new sandbox */
  create(options: SandboxCreateOptions): Promise<SandboxInstance>;

  /** Connect to existing sandbox */
  connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance>;

  /** List sandboxes (first page only, up to limit) */
  list(options?: SandboxListOptions): Promise<SandboxInfo[]>;
}

// ============================================================
// CONFIGURATION
// ============================================================

export interface E2BConfig {
  /** E2B API key. Default: reads from E2B_API_KEY env var */
  apiKey?: string;
  /** @internal E2B API base URL override, used for managed gateway routing */
  apiUrl?: string;
  defaultTimeoutMs?: number;
  /** E2B template ID (default: 'evolve-all'). Create custom templates at https://e2b.dev/docs/sandbox-template */
  templateId?: string;
}

/** Internal resolved config with required apiKey */
interface ResolvedE2BConfig {
  apiKey: string;
  apiUrl?: string;
  defaultTimeoutMs?: number;
  templateId?: string;
}

// ============================================================
// IMPLEMENTATION
// ============================================================

export class E2BCommands implements SandboxCommands {
  constructor(private sandbox: E2BSandbox, private defaultUser?: string) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    // E2B SDK throws CommandExitError on non-zero exit - normalize to result
    try {
      const result = await this.sandbox.commands.run(command, {
        timeoutMs: options?.timeoutMs,
        envs: options?.envs,
        cwd: options?.cwd,
        user: this.defaultUser,
        onStdout: options?.onStdout,
        onStderr: options?.onStderr,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (err: unknown) {
      if (err && typeof err === "object" && "exitCode" in err) {
        const cmdErr = err as { exitCode: number; stdout?: string; stderr?: string };
        return {
          exitCode: cmdErr.exitCode,
          stdout: cmdErr.stdout ?? "",
          stderr: cmdErr.stderr ?? "",
        };
      }
      throw err;
    }
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    const handle = await this.sandbox.commands.run(command, {
      background: true,
      stdin: options?.stdin ?? true,
      timeoutMs: options?.timeoutMs,
      envs: options?.envs,
      cwd: options?.cwd,
      user: this.defaultUser,
      onStdout: options?.onStdout,
      onStderr: options?.onStderr,
    });

    return {
      processId: String(handle.pid),
      wait: async () => {
        // E2B SDK throws CommandExitError on non-zero exit - normalize to result
        try {
          const result = await handle.wait();
          return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        } catch (err: unknown) {
          if (err && typeof err === "object" && "exitCode" in err) {
            const cmdErr = err as { exitCode: number; stdout?: string; stderr?: string };
            return {
              exitCode: cmdErr.exitCode,
              stdout: cmdErr.stdout ?? "",
              stderr: cmdErr.stderr ?? "",
            };
          }
          throw err;
        }
      },
      kill: () => this.sandbox.commands.kill(handle.pid),
    };
  }

  async list(): Promise<ProcessInfo[]> {
    const processes = await this.sandbox.commands.list();
    return processes.map((p) => ({
      ...p,
      processId: String(p.pid),
    }));
  }

  async connect(processId: string, options?: SandboxConnectOptions): Promise<SandboxCommandHandle> {
    const handle = await this.sandbox.commands.connect(Number(processId), {
      onStdout: options?.onStdout,
      onStderr: options?.onStderr,
      timeoutMs: options?.timeoutMs,
    });

    return {
      processId: String(handle.pid),
      wait: async () => {
        // E2B SDK throws CommandExitError on non-zero exit - normalize to result
        try {
          const result = await handle.wait();
          return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        } catch (err: unknown) {
          if (err && typeof err === "object" && "exitCode" in err) {
            const cmdErr = err as { exitCode: number; stdout?: string; stderr?: string };
            return {
              exitCode: cmdErr.exitCode,
              stdout: cmdErr.stdout ?? "",
              stderr: cmdErr.stderr ?? "",
            };
          }
          throw err;
        }
      },
      kill: () => this.sandbox.commands.kill(handle.pid),
    };
  }

  async sendStdin(processId: string, data: string): Promise<void> {
    await this.sandbox.commands.sendStdin(Number(processId), data);
  }

  async kill(processId: string): Promise<boolean> {
    return this.sandbox.commands.kill(Number(processId));
  }
}

export class E2BFiles implements SandboxFiles {
  constructor(private sandbox: E2BSandbox, private defaultUser?: string) {}

  async read(path: string): Promise<string | Uint8Array> {
    // Increase timeout for large files (default 60s is too short for multi-MB downloads)
    if (isBinaryFile(path)) {
      return this.sandbox.files.read(path, { format: "bytes", requestTimeoutMs: 300000, user: this.defaultUser });
    }
    return this.sandbox.files.read(path, { format: "text", requestTimeoutMs: 300000, user: this.defaultUser });
  }

  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    // Increase timeout for large files (default 60s is too short for multi-MB uploads)
    await this.sandbox.files.write(path, toArrayBuffer(content), { requestTimeoutMs: 300000, user: this.defaultUser });
  }

  async writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {
    const entries = files.map((f) => ({
      path: f.path,
      data: toArrayBuffer(f.data),
    }));
    // Increase timeout for large files (default 60s is too short for multi-MB uploads)
    await this.sandbox.files.write(entries, { requestTimeoutMs: 300000, user: this.defaultUser });
  }

  async makeDir(path: string): Promise<void> {
    await this.sandbox.files.makeDir(path, { user: this.defaultUser });
  }

  async uploadUrl(path: string, expiresInSeconds?: number): Promise<string> {
    return this.sandbox.uploadUrl(path, {
      user: this.defaultUser,
      ...(expiresInSeconds ? { useSignatureExpiration: expiresInSeconds } : {}),
    });
  }

  async downloadUrl(path: string, expiresInSeconds?: number): Promise<string> {
    return this.sandbox.downloadUrl(path, {
      user: this.defaultUser,
      ...(expiresInSeconds ? { useSignatureExpiration: expiresInSeconds } : {}),
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.sandbox.files.exists(path, { user: this.defaultUser });
  }

  async list(path: string): Promise<FileInfo[]> {
    const entries = await this.sandbox.files.list(path, { user: this.defaultUser });
    return entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type === "dir" ? "dir" : "file",
    }));
  }

  async remove(path: string): Promise<void> {
    await this.sandbox.files.remove(path, { user: this.defaultUser });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.sandbox.files.rename(oldPath, newPath, { user: this.defaultUser });
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    return this.sandbox.files.read(path, { format: "stream", user: this.defaultUser });
  }

  async writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    await this.sandbox.files.write(path, stream, { user: this.defaultUser });
  }

  async watchDir(
    path: string,
    onEvent: (event: FilesystemEvent) => void | Promise<void>,
    options?: WatchOptions
  ): Promise<WatchHandle> {
    const handle = await this.sandbox.files.watchDir(path, onEvent, {
      recursive: options?.recursive,
      timeoutMs: options?.timeoutMs,
      user: this.defaultUser,
      onExit: options?.onExit,
    });
    return {
      stop: () => handle.stop(),
    };
  }
}

class E2BSandboxImpl implements SandboxInstance {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;

  constructor(private sandbox: E2BSandbox, private apiKey: string, private apiUrl?: string, defaultUser?: string) {
    this.commands = new E2BCommands(sandbox, defaultUser);
    this.files = new E2BFiles(sandbox, defaultUser);
  }

  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  getHost(port: number): Promise<string> {
    return Promise.resolve(this.sandbox.getHost(port));
  }

  async isRunning(): Promise<boolean> {
    return this.sandbox.isRunning();
  }

  async getInfo(): Promise<SandboxInfo> {
    const info = await this.sandbox.getInfo();
    return {
      sandboxId: info.sandboxId,
      image: info.templateId,  // E2B calls it templateId, we expose as image
      name: info.name,
      metadata: info.metadata ?? {},
      startedAt: toISOString(info.startedAt),
      endAt: info.endAt ? toISOString(info.endAt) : undefined,
    };
  }

  async kill(): Promise<void> {
    try {
      await this.sandbox.kill();
    } catch {
      // Retry once after brief delay for transient API failures
      await new Promise((r) => setTimeout(r, 500));
      await this.sandbox.kill();
    }
  }

  async pause(): Promise<void> {
    await this.sandbox.betaPause({
      apiKey: this.apiKey,
      apiUrl: this.apiUrl,
    } as Parameters<E2BSandbox["betaPause"]>[0]);
  }
}

export class E2BProvider implements SandboxProvider {
  readonly providerType = "e2b" as const;
  private readonly apiKey: string;
  private readonly apiUrl?: string;
  private readonly defaultTimeoutMs: number;
  private readonly templateId?: string;
  /**
   * Sandbox user configured at create time, reapplied on connect() (e.g., resume).
   * In-memory only: a connect() from a fresh process runs as the template default
   * user — callers reconnecting across processes must recreate the provider config
   * with the same user, or operations on user-owned files fail loudly.
   */
  private readonly sandboxUsers = new Map<string, string>();

  constructor(config: ResolvedE2BConfig) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 3600000;
    this.templateId = config.templateId;
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    if (
      options.resources &&
      (options.resources.cpu !== undefined ||
        options.resources.memory !== undefined ||
        options.resources.disk !== undefined)
    ) {
      // Provider law: reject what cannot be enforced, never silently ignore.
      // E2B sandboxes inherit sizing from their template (Template.build
      // cpuCount/memoryMB; disk is plan-fixed) — there is no create-time knob.
      throw new E2BResourcesError(
        "E2B cannot size a sandbox at create time: sizing is fixed by the template " +
          "(Template.build cpuCount/memoryMB; disk is plan-fixed). Build a template " +
          "with the desired resources and pass it as `image` instead of `resources`."
      );
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const templateId = options.image ?? this.templateId ?? "evolve-all";
    if (options.network?.outbound === "open" && options.network.allowedDestinations?.length) {
      throw new Error("network.allowedDestinations is only valid when outbound is blocked");
    }
    const allowedDestinations = options.network?.allowedDestinations ?? [];
    const usesAllowlist =
      options.network?.outbound === "blocked" && allowedDestinations.length > 0;

    // Map generic 'image' to E2B's 'templateId'
    const sandbox = await E2BSandbox.create(templateId, {
      apiKey: this.apiKey,
      apiUrl: this.apiUrl,
      envs: options.envs,
      metadata: options.metadata,
      timeoutMs,
      allowInternetAccess:
        options.network?.outbound !== "blocked" || usesAllowlist,
      network: usesAllowlist
        ? {
            denyOut: ["0.0.0.0/0"],
            allowOut: allowedDestinations,
          }
        : undefined,
    });

    if (options.workingDirectory) {
      // Use E2B files.makeDir() to avoid shell injection risk
      await sandbox.files.makeDir(options.workingDirectory, { user: options.user });
    }

    if (options.user) {
      this.sandboxUsers.set(sandbox.sandboxId, options.user);
    }

    return new E2BSandboxImpl(sandbox, this.apiKey, this.apiUrl, options.user);
  }

  async connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance> {
    const sandbox = await E2BSandbox.connect(sandboxId, {
      apiKey: this.apiKey,
      apiUrl: this.apiUrl,
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
    });
    return new E2BSandboxImpl(
      sandbox,
      this.apiKey,
      this.apiUrl,
      this.sandboxUsers.get(sandboxId),
    );
  }

  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    const paginator = E2BSandbox.list({
      apiKey: this.apiKey,
      apiUrl: this.apiUrl,
      query: {
        state: options?.state,
        metadata: options?.metadata,
      },
      limit: options?.limit ?? 100,
    } as Parameters<typeof E2BSandbox.list>[0]);

    const items = await paginator.nextItems();

    return items.map((item) => ({
      sandboxId: item.sandboxId,
      image: item.templateId,  // E2B calls it templateId, we expose as image
      name: item.name,
      metadata: item.metadata ?? {},
      startedAt: toISOString(item.startedAt),
      endAt: item.endAt ? toISOString(item.endAt) : undefined,
    }));
  }
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Create E2B sandbox provider.
 *
 * @param config - Optional configuration. If apiKey not provided, reads from E2B_API_KEY env var.
 * @throws Error if apiKey cannot be resolved
 */
export function createE2BProvider(config: E2BConfig = {}): SandboxProvider {
  const apiKey = config.apiKey ?? process.env.E2B_API_KEY;

  if (!apiKey) {
    throw new Error(
      "E2B API key required. " +
        "Set E2B_API_KEY environment variable or pass apiKey in config. " +
        "Get your key at https://e2b.dev/sign-in"
    );
  }

  return new E2BProvider({ ...config, apiKey });
}
