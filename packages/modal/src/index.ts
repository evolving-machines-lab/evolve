/**
 * Modal Sandbox Provider - Clean Architecture
 *
 * @requires modal >= 0.3.0
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
 * - pause() not supported - throws error
 * - Requires app context for sandbox creation
 */

import {
  ModalClient,
  Sandbox,
  App,
  ContainerProcess,
} from "modal";
import { pack } from "tar-stream";

// ============================================================
// MODULE-LEVEL CONSTANTS & HELPERS
// ============================================================

/** Map generic image names to Docker images */
const IMAGE_MAP: Record<string, string> = {
  "evolve-all": "evolvingmachines/evolve-all:latest",
};

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

export interface ModalConfig {
  /** Modal app name. Default: "evolve-sandbox" */
  appName?: string;
  /** Default timeout in ms. Default: 3600000 (1 hour) */
  defaultTimeoutMs?: number;
}

// ============================================================
// IMPLEMENTATION
// ============================================================

class ModalCommands implements SandboxCommands {
  constructor(private sandbox: Sandbox) {}

  /**
   * Wrap command to run as non-root user.
   * Modal sandboxes run as root by default (ignoring Dockerfile USER directive),
   * but Claude CLI and other tools refuse certain operations when running as root.
   *
   * Uses `su user -c` instead of `sudo -u user` because Claude CLI's
   * --dangerously-skip-permissions flag refuses to run when it detects sudo.
   *
   * Uses base64 encoding to avoid shell escaping issues with complex commands
   * that contain quotes, special characters, etc.
   */
  private wrapAsUser(command: string, cwd?: string, envs?: Record<string, string>): string[] {
    // Build env prefix for inline variable passing (su doesn't preserve env like sudo -E)
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

    // Use base64 encoding to avoid all shell escaping issues
    const encoded = Buffer.from(fullCmd).toString("base64");

    // Use su user -c to avoid sudo detection by Claude CLI
    // Decode and execute via bash to preserve all shell features
    return ["su", "user", "-c", `echo ${encoded} | base64 -d | bash`];
  }

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    // Wrap command to run as non-root user with shell features
    // Pass envs to wrapAsUser for inline variable passing (su doesn't preserve env)
    const args = this.wrapAsUser(command, options?.cwd, options?.envs);

    const p = await this.sandbox.exec(args, {
      timeoutMs: options?.timeoutMs,
      // Don't pass envs to exec - they're inlined in the command via wrapAsUser
    });

    // Always accumulate output using for-await pattern (more reliable with Modal streams)
    const { stdout, stderr } = await this.accumulateStreams(p, options?.onStdout, options?.onStderr);

    const exitCode = await p.wait();
    return { exitCode, stdout, stderr };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    // Wrap command to run as non-root user with shell features
    // Pass envs to wrapAsUser for inline variable passing (su doesn't preserve env)
    const args = this.wrapAsUser(command, options?.cwd, options?.envs);
    const p = await this.sandbox.exec(args, {
      timeoutMs: options?.timeoutMs,
      // Don't pass envs to exec - they're inlined in the command via wrapAsUser
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

class ModalFiles implements SandboxFiles {
  constructor(private sandbox: Sandbox) {}

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

    // Use Modal SDK's writeBytes() method
    await p.stdin.writeBytes(new Uint8Array(data));
    const writer = p.stdin.getWriter();
    await writer.close();
    await p.wait();

    // Chown the file and parent directory to user:user so Claude can access them
    const chownCmd = await this.sandbox.exec(["chown", "user:user", path], { timeoutMs: 10000 });
    await chownCmd.wait();
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
    await p.stdin.writeBytes(new Uint8Array(tarBuffer));
    const writer = p.stdin.getWriter();
    await writer.close();
    await p.wait();

    // Chown all created files and directories to user:user so Claude can write to them
    // This is needed because Modal runs as root but Claude CLI needs to write as user
    if (dirs.size > 0) {
      const dirsArray = Array.from(dirs);
      // Chown the root workspace directory recursively
      const rootDirs = new Set(dirsArray.map(d => d.split("/").slice(0, 4).join("/")));
      for (const dir of rootDirs) {
        const chownCmd = await this.sandbox.exec(["chown", "-R", "user:user", dir], { timeoutMs: 30000 });
        await chownCmd.wait();
      }
    }
  }

  async makeDir(path: string): Promise<void> {
    const p = await this.sandbox.exec(["mkdir", "-p", path], { timeoutMs: 10000 });
    await p.wait();

    // Chown the directory to user:user so Claude can write to it
    const chownCmd = await this.sandbox.exec(["chown", "-R", "user:user", path], { timeoutMs: 10000 });
    await chownCmd.wait();
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
        await p.stdin.writeBytes(value);
      }
    } finally {
      reader.releaseLock();
    }

    const writer = p.stdin.getWriter();
    await writer.close();
    await p.wait();
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
  private readonly image: string;
  private readonly startTime: Date;

  constructor(private sandbox: Sandbox, image: string) {
    this.commands = new ModalCommands(sandbox);
    this.files = new ModalFiles(sandbox);
    this.image = image;
    this.startTime = new Date();
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
      const p = await this.sandbox.exec(["echo", "ping"], { timeoutMs: 5000 });
      await p.wait();
      return true;
    } catch {
      return false;
    }
  }

  async getInfo(): Promise<SandboxInfo> {
    return {
      sandboxId: this.sandbox.sandboxId,
      image: this.image,
      metadata: {},
      startedAt: this.startTime.toISOString(),
    };
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
    throw new Error("Modal does not support pause. Use kill() instead.");
  }
}

export class ModalProvider implements SandboxProvider {
  readonly providerType = "modal" as const;
  private readonly client: ModalClient;
  private readonly appName: string;
  private readonly defaultTimeoutMs: number;
  private _app: App | undefined;

  constructor(config: ModalConfig = {}) {
    // Use modern ModalClient constructor (reads from env vars or .modal.toml)
    this.client = new ModalClient();
    this.appName = config.appName ?? "evolve-sandbox";
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 3600000;
  }

  private async getApp(): Promise<App> {
    if (!this._app) {
      // Use client.apps.fromName() - the modern API
      this._app = await this.client.apps.fromName(this.appName, { createIfMissing: true });
    }
    return this._app;
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    const app = await this.getApp();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    // Resolve image name through IMAGE_MAP (e.g., "evolve-all" -> "evolvingmachines/evolve-all:latest")
    const resolvedImage = IMAGE_MAP[options.image] ?? options.image;
    const image = this.client.images.fromRegistry(resolvedImage);

    // Filter out undefined values and only pass env if non-empty
    // Modal SDK throws if env is empty object or contains undefined values
    const filteredEnvs = options.envs
      ? Object.fromEntries(
          Object.entries(options.envs).filter(([, v]) => v !== undefined && v !== null)
        )
      : undefined;
    const env = filteredEnvs && Object.keys(filteredEnvs).length > 0 ? filteredEnvs : undefined;

    // Use client.sandboxes.create() - the modern API
    const sandbox = await this.client.sandboxes.create(app, image, {
      timeoutMs,
      workdir: options.workingDirectory,
      env,
    });

    // Fix workspace directory ownership (Modal creates it as root, but user needs write access)
    if (options.workingDirectory) {
      const chown = await sandbox.exec(["chown", "-R", "user:user", options.workingDirectory], { timeoutMs: 30000 });
      await chown.wait();
    }

    return new ModalSandboxImpl(sandbox, resolvedImage);
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    // Use client.sandboxes.fromId() - the modern API
    const sandbox = await this.client.sandboxes.fromId(sandboxId);
    return new ModalSandboxImpl(sandbox, "unknown");
  }

  async list(_options?: SandboxListOptions): Promise<SandboxInfo[]> {
    const results: SandboxInfo[] = [];
    const limit = _options?.limit ?? 100;

    try {
      // Use client.sandboxes.list() - the modern API
      for await (const sandbox of this.client.sandboxes.list()) {
        results.push({
          sandboxId: sandbox.sandboxId,
          image: "unknown",
          metadata: {},
          startedAt: new Date().toISOString(),
        });
        if (results.length >= limit) break;
      }
    } catch {
      // List not supported or failed
    }

    return results;
  }
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Create Modal sandbox provider.
 *
 * Requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET environment variables,
 * or a .modal.toml configuration file.
 *
 * @param config - Optional configuration
 */
export function createModalProvider(config: ModalConfig = {}): SandboxProvider {
  return new ModalProvider(config);
}
