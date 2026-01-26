/**
 * Modal Sandbox Provider - Clean Architecture
 *
 * @requires modal >= 0.1.0 (Modal JavaScript SDK)
 * @requires Node.js >= 18 (for ReadableStream support)
 *
 * Design principles:
 * - Single way to do things (no dual methods)
 * - Options objects only (no positional args)
 * - All interface methods required (no optional ?)
 * - Configuration externalized (no hardcoded mappings)
 * - Clear naming (run = blocking, spawn = background)
 */

import { ModalClient, type Sandbox as ModalSandbox } from "modal";

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

function isBinaryFile(path: string): boolean {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// ============================================================
// CORE TYPES (match E2B package for consistency)
// ============================================================

/** Result of a completed sandbox command */
export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Handle to a running background process in sandbox */
export interface SandboxCommandHandle {
  readonly pid: number;
  wait(): Promise<SandboxCommandResult>;
  kill(): Promise<boolean>;
}

/** Information about a running process */
export interface ProcessInfo {
  pid: number;
  cmd: string;
  args: string[];
  envs: Record<string, string>;
  cwd?: string;
  tag?: string;
}

/** Sandbox metadata and lifecycle info */
export interface SandboxInfo {
  sandboxId: string;
  templateId: string;
  name?: string;
  metadata: Record<string, string>;
  startedAt: string;
  endAt?: string;
}

/** File or directory entry info */
export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "dir";
}

// ============================================================
// OPTIONS (match E2B package)
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

/** Options for creating a sandbox */
export interface SandboxCreateOptions {
  templateId: string;
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
// INTERFACES (match SDK types.ts)
// ============================================================

/** Command execution capabilities */
export interface SandboxCommands {
  run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult>;
  spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle>;
  list(): Promise<ProcessInfo[]>;
  kill(pid: number): Promise<boolean>;
}

/** File system operations */
export interface SandboxFiles {
  read(path: string): Promise<string | Uint8Array>;
  write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void>;
  writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void>;
  makeDir(path: string): Promise<void>;
}

/** Sandbox instance with full capabilities */
export interface SandboxInstance {
  readonly sandboxId: string;
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
  getHost(port: number): string;
  kill(): Promise<void>;
  pause(): Promise<void>;
}

/** Sandbox lifecycle management */
export interface SandboxProvider {
  readonly providerType: string;
  create(options: SandboxCreateOptions): Promise<SandboxInstance>;
  connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance>;
  list(options?: SandboxListOptions): Promise<SandboxInfo[]>;
}

// ============================================================
// CONFIGURATION
// ============================================================

export interface ModalConfig {
  /** Modal API token. Default: reads from MODAL_TOKEN_ID and MODAL_TOKEN_SECRET env vars */
  tokenId?: string;
  tokenSecret?: string;
  /** Default app name to use for sandboxes */
  appName?: string;
  /** Default image to use (e.g., "python:3.13") */
  defaultImage?: string;
  defaultTimeoutMs?: number;
}

interface ResolvedModalConfig {
  tokenId: string;
  tokenSecret: string;
  appName: string;
  defaultImage: string;
  defaultTimeoutMs: number;
}

// ============================================================
// IMPLEMENTATION
// ============================================================

class ModalCommands implements SandboxCommands {
  constructor(private sandbox: ModalSandbox) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    // Parse command into parts (Modal expects command array)
    const parts = command.split(" ");

    const process = await this.sandbox.exec(parts, {
      env: options?.envs,
      workdir: options?.cwd,
      timeoutMs: options?.timeoutMs,
    });

    // Wait for process completion and collect output
    const exitCode = await process.wait();
    const stdout = await process.stdout.readText();
    const stderr = await process.stderr.readText();

    // Stream callbacks if provided
    if (options?.onStdout && stdout) {
      options.onStdout(stdout);
    }
    if (options?.onStderr && stderr) {
      options.onStderr(stderr);
    }

    return {
      exitCode,
      stdout,
      stderr,
    };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    const parts = command.split(" ");

    const process = await this.sandbox.exec(parts, {
      env: options?.envs,
      workdir: options?.cwd,
      timeoutMs: options?.timeoutMs,
    });

    // Modal doesn't expose PID directly, use a placeholder
    const pid = Date.now();

    return {
      pid,
      wait: async () => {
        const exitCode = await process.wait();
        const stdout = await process.stdout.readText();
        const stderr = await process.stderr.readText();
        return {
          exitCode,
          stdout,
          stderr,
        };
      },
      kill: async () => {
        // Modal processes are managed by the sandbox lifecycle
        return true;
      },
    };
  }

  async list(): Promise<ProcessInfo[]> {
    // Modal doesn't expose process listing - return empty
    return [];
  }

  async kill(pid: number): Promise<boolean> {
    // Modal processes are managed by sandbox lifecycle
    return true;
  }
}

class ModalFiles implements SandboxFiles {
  constructor(private sandbox: ModalSandbox) {}

  async read(path: string): Promise<string | Uint8Array> {
    const file = await this.sandbox.open(path, "r");
    const content = await file.read(); // Returns Uint8Array
    await file.close();

    if (isBinaryFile(path)) {
      // Return as Uint8Array for binary files
      return content;
    }
    // Decode to string for text files
    return new TextDecoder().decode(content);
  }

  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    const file = await this.sandbox.open(path, "w");

    let data: Uint8Array;
    if (typeof content === "string") {
      data = new TextEncoder().encode(content);
    } else if (content instanceof Buffer) {
      data = new Uint8Array(content);
    } else if (content instanceof ArrayBuffer) {
      data = new Uint8Array(content);
    } else {
      data = content;
    }

    await file.write(data);
    await file.close();
  }

  async writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {
    // Modal doesn't have batch write - iterate
    for (const { path, data } of files) {
      await this.write(path, data);
    }
  }

  async makeDir(path: string): Promise<void> {
    // Use exec to create directory
    await this.sandbox.exec(["mkdir", "-p", path]);
  }
}

class ModalSandboxImpl implements SandboxInstance {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;

  constructor(
    private sandbox: ModalSandbox,
    private _sandboxId: string,
  ) {
    this.commands = new ModalCommands(sandbox);
    this.files = new ModalFiles(sandbox);
  }

  get sandboxId(): string {
    return this._sandboxId;
  }

  getHost(port: number): string {
    // Modal sandboxes expose ports differently - construct URL
    // Format: https://<sandbox-id>--<port>.modal.run
    return `https://${this._sandboxId}--${port}.modal.run`;
  }

  async kill(): Promise<void> {
    await this.sandbox.terminate();
  }

  async pause(): Promise<void> {
    // Modal doesn't support pause - kill instead
    await this.sandbox.terminate();
  }
}

export class ModalSandboxProvider implements SandboxProvider {
  readonly providerType = "modal" as const;
  private readonly client: ModalClient;
  private readonly config: ResolvedModalConfig;

  constructor(config: ResolvedModalConfig) {
    this.config = config;
    this.client = new ModalClient();
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    const timeoutMs = options.timeoutMs ?? this.config.defaultTimeoutMs;

    // Get or create the Modal app
    const app = await this.client.apps.fromName(this.config.appName, { createIfMissing: true });

    // Create image from template (templateId maps to image name)
    const image = this.client.images.fromRegistry(options.templateId || this.config.defaultImage);

    // Create sandbox with configuration
    const sandbox = await this.client.sandboxes.create(app, image, {
      env: options.envs,
      timeoutMs,
      workdir: options.workingDirectory,
    });

    // Get sandbox ID
    const sandboxId = sandbox.sandboxId;

    if (options.workingDirectory) {
      await sandbox.exec(["mkdir", "-p", options.workingDirectory]);
    }

    return new ModalSandboxImpl(sandbox, sandboxId);
  }

  async connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance> {
    // Connect to existing sandbox by ID
    const sandbox = await this.client.sandboxes.fromId(sandboxId);
    return new ModalSandboxImpl(sandbox, sandboxId);
  }

  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    // Modal doesn't expose a sandbox listing API in the same way
    // Return empty for now - users should track sandbox IDs
    return [];
  }
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Create Modal sandbox provider.
 *
 * @param config - Optional configuration. If tokens not provided, reads from MODAL_TOKEN_ID and MODAL_TOKEN_SECRET env vars.
 * @throws Error if tokens cannot be resolved
 */
export function createModalProvider(config: ModalConfig = {}): SandboxProvider {
  const tokenId = config.tokenId ?? process.env.MODAL_TOKEN_ID;
  const tokenSecret = config.tokenSecret ?? process.env.MODAL_TOKEN_SECRET;

  if (!tokenId || !tokenSecret) {
    throw new Error(
      "Modal tokens required. " +
        "Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET environment variables or pass tokenId/tokenSecret in config. " +
        "Get your tokens at https://modal.com/settings"
    );
  }

  // Set Modal auth environment variables for the SDK
  process.env.MODAL_TOKEN_ID = tokenId;
  process.env.MODAL_TOKEN_SECRET = tokenSecret;

  return new ModalSandboxProvider({
    tokenId,
    tokenSecret,
    appName: config.appName ?? "evolve-sandbox",
    defaultImage: config.defaultImage ?? "python:3.12-slim",
    defaultTimeoutMs: config.defaultTimeoutMs ?? 3600000,
  });
}
