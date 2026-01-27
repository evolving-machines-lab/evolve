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
  defaultTimeoutMs?: number;
}

/** Internal resolved config with required apiKey */
interface ResolvedE2BConfig {
  apiKey: string;
  defaultTimeoutMs?: number;
}

// ============================================================
// IMPLEMENTATION
// ============================================================

class E2BCommands implements SandboxCommands {
  constructor(private sandbox: E2BSandbox) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    // E2B SDK throws CommandExitError on non-zero exit - normalize to result
    try {
      const result = await this.sandbox.commands.run(command, {
        timeoutMs: options?.timeoutMs,
        envs: options?.envs,
        cwd: options?.cwd,
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

class E2BFiles implements SandboxFiles {
  constructor(private sandbox: E2BSandbox) {}

  async read(path: string): Promise<string | Uint8Array> {
    // Increase timeout for large files (default 60s is too short for multi-MB downloads)
    if (isBinaryFile(path)) {
      return this.sandbox.files.read(path, { format: "bytes", requestTimeoutMs: 300000 });
    }
    return this.sandbox.files.read(path, { format: "text", requestTimeoutMs: 300000 });
  }

  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    // Increase timeout for large files (default 60s is too short for multi-MB uploads)
    await this.sandbox.files.write(path, toArrayBuffer(content), { requestTimeoutMs: 300000 });
  }

  async writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {
    const entries = files.map((f) => ({
      path: f.path,
      data: toArrayBuffer(f.data),
    }));
    // Increase timeout for large files (default 60s is too short for multi-MB uploads)
    await this.sandbox.files.write(entries, { requestTimeoutMs: 300000 });
  }

  async makeDir(path: string): Promise<void> {
    await this.sandbox.files.makeDir(path);
  }

  async uploadUrl(path: string, expiresInSeconds?: number): Promise<string> {
    return this.sandbox.uploadUrl(path, expiresInSeconds ? { useSignatureExpiration: expiresInSeconds } : undefined);
  }

  async downloadUrl(path: string, expiresInSeconds?: number): Promise<string> {
    return this.sandbox.downloadUrl(path, expiresInSeconds ? { useSignatureExpiration: expiresInSeconds } : undefined);
  }

  async exists(path: string): Promise<boolean> {
    return this.sandbox.files.exists(path);
  }

  async list(path: string): Promise<FileInfo[]> {
    const entries = await this.sandbox.files.list(path);
    return entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type === "dir" ? "dir" : "file",
    }));
  }

  async remove(path: string): Promise<void> {
    await this.sandbox.files.remove(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.sandbox.files.rename(oldPath, newPath);
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    return this.sandbox.files.read(path, { format: "stream" });
  }

  async writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    await this.sandbox.files.write(path, stream);
  }

  async watchDir(
    path: string,
    onEvent: (event: FilesystemEvent) => void | Promise<void>,
    options?: WatchOptions
  ): Promise<WatchHandle> {
    const handle = await this.sandbox.files.watchDir(path, onEvent, {
      recursive: options?.recursive,
      timeoutMs: options?.timeoutMs,
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

  constructor(private sandbox: E2BSandbox) {
    this.commands = new E2BCommands(sandbox);
    this.files = new E2BFiles(sandbox);
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
    await this.sandbox.betaPause();
  }
}

export class E2BProvider implements SandboxProvider {
  readonly providerType = "e2b" as const;
  private readonly apiKey: string;
  private readonly defaultTimeoutMs: number;

  constructor(config: ResolvedE2BConfig) {
    this.apiKey = config.apiKey;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 3600000;
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    // Map generic 'image' to E2B's 'templateId'
    const sandbox = await E2BSandbox.create(options.image, {
      apiKey: this.apiKey,
      envs: options.envs,
      metadata: options.metadata,
      timeoutMs,
    });

    if (options.workingDirectory) {
      // Use E2B files.makeDir() to avoid shell injection risk
      await sandbox.files.makeDir(options.workingDirectory);
    }

    return new E2BSandboxImpl(sandbox);
  }

  async connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance> {
    const sandbox = await E2BSandbox.connect(sandboxId, {
      apiKey: this.apiKey,
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
    });
    return new E2BSandboxImpl(sandbox);
  }

  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    const paginator = E2BSandbox.list({
      apiKey: this.apiKey,
      query: {
        state: options?.state,
        metadata: options?.metadata,
      },
      limit: options?.limit ?? 100,
    });

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
