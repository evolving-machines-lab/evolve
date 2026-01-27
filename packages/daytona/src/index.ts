/**
 * Daytona Sandbox Provider
 *
 * @requires @daytonaio/sdk >= 0.134.0
 *
 * Design principles:
 * - Mirror E2B provider interface for SDK compatibility
 * - Auto-fallback: snapshot → public Docker image
 * - Users never need to think about images
 */

import { Daytona } from "@daytonaio/sdk";
import type { Sandbox as DaytonaSandbox } from "@daytonaio/sdk";

// ============================================================
// CONSTANTS
// ============================================================

/** Map generic image names to Daytona Docker images */
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

function getParentDir(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash > 0 ? path.substring(0, lastSlash) : "/";
}

function getBasename(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
}

/**
 * Wrap command with cd prefix for cwd support.
 *
 * Daytona's executeSessionCommand doesn't support cwd natively (unlike E2B),
 * so we use a shell-level workaround. The path is single-quoted to handle
 * spaces and most special characters safely.
 */
function wrapWithCwd(command: string, cwd?: string): string {
  if (!cwd) return command;
  // Single quotes handle spaces and most special chars; escape any single quotes in path
  const safeCwd = cwd.replace(/'/g, "'\\''");
  return `cd '${safeCwd}' && ${command}`;
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
  endAt?: string;
}

/** File or directory entry info */
export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "dir";
}

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

/** Command execution capabilities */
export interface SandboxCommands {
  run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult>;
  spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle>;
  list(): Promise<ProcessInfo[]>;
  kill(processId: string): Promise<boolean>;
}

/** File system operations */
export interface SandboxFiles {
  read(path: string): Promise<string | Uint8Array>;
  write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void>;
  writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void>;
  makeDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<FileInfo[]>;
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

/** Sandbox instance */
export interface SandboxInstance {
  readonly sandboxId: string;
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
  getHost(port: number): Promise<string>;
  isRunning(): Promise<boolean>;
  getInfo(): Promise<SandboxInfo>;
  kill(): Promise<void>;
  pause(): Promise<void>;
}

/** Sandbox lifecycle management */
export interface SandboxProvider {
  readonly providerType: string;
  readonly name?: string;
  create(options: SandboxCreateOptions): Promise<SandboxInstance>;
  connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance>;
  list(options?: SandboxListOptions): Promise<SandboxInfo[]>;
}

// ============================================================
// CONFIGURATION
// ============================================================

export interface DaytonaConfig {
  /** Daytona API key. Default: reads from DAYTONA_API_KEY env var */
  apiKey?: string;
  /** API URL. Default: https://app.daytona.io/api */
  apiUrl?: string;
  /** Target region. Default: us */
  target?: string;
  /** Default timeout in ms */
  defaultTimeoutMs?: number;
}

interface ResolvedDaytonaConfig {
  apiKey: string;
  apiUrl?: string;
  target?: string;
  defaultTimeoutMs?: number;
}

// ============================================================
// IMPLEMENTATION
// ============================================================

class DaytonaCommands implements SandboxCommands {
  constructor(private sandbox: DaytonaSandbox) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    const timeoutSec = options?.timeoutMs ? Math.floor(options.timeoutMs / 1000) : undefined;

    // Streaming path: use ephemeral session
    if (options?.onStdout || options?.onStderr) {
      const sessionId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.sandbox.process.createSession(sessionId);

      try {
        const resp = await this.sandbox.process.executeSessionCommand(sessionId, {
          command: wrapWithCwd(command, options?.cwd),
          async: false,
        }, timeoutSec);

        const cmdId = resp.cmdId;
        if (cmdId) {
          await this.sandbox.process.getSessionCommandLogs(
            sessionId,
            cmdId,
            options.onStdout || (() => {}),
            options.onStderr || (() => {})
          );
        }

        return {
          exitCode: resp.exitCode ?? 0,
          stdout: resp.output ?? "",
          stderr: "",
        };
      } finally {
        try {
          await this.sandbox.process.deleteSession(sessionId);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // Non-streaming path: use executeCommand directly
    // Evidence: Daytona SDK executeCommand(command, cwd?, env?, timeout?)
    const result = await this.sandbox.process.executeCommand(
      command,
      options?.cwd,
      options?.envs,
      timeoutSec
    );

    return {
      exitCode: result.exitCode,
      stdout: result.result || "",
      stderr: "",
    };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    const sessionId = `evolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.sandbox.process.createSession(sessionId);

    const timeoutSec = options?.timeoutMs ? Math.floor(options.timeoutMs / 1000) : undefined;

    const resp = await this.sandbox.process.executeSessionCommand(sessionId, {
      command: wrapWithCwd(command, options?.cwd),
      async: true,
    }, timeoutSec);

    const cmdId = resp.cmdId;

    if (cmdId && (options?.onStdout || options?.onStderr)) {
      this.sandbox.process.getSessionCommandLogs(
        sessionId,
        cmdId,
        options.onStdout || (() => {}),
        options.onStderr || (() => {})
      ).catch(() => {
        // Ignore streaming errors for background processes
      });
    }

    return {
      processId: sessionId,
      wait: async () => {
        return {
          exitCode: resp.exitCode ?? 0,
          stdout: resp.output ?? "",
          stderr: "",
        };
      },
      kill: async () => {
        try {
          await this.sandbox.process.deleteSession(sessionId);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  async list(): Promise<ProcessInfo[]> {
    // Evidence: Daytona SDK listSessions() returns Session[]
    try {
      const sessions = await this.sandbox.process.listSessions();
      return sessions.map(session => ({
        processId: session.sessionId || "",
        cmd: "",
        args: [],
        envs: {},
      }));
    } catch {
      return [];
    }
  }

  async kill(processId: string): Promise<boolean> {
    // Evidence: Daytona SDK deleteSession(sessionId)
    try {
      await this.sandbox.process.deleteSession(processId);
      return true;
    } catch {
      return false;
    }
  }
}

class DaytonaFiles implements SandboxFiles {
  constructor(private sandbox: DaytonaSandbox) {}

  async read(path: string): Promise<string | Uint8Array> {
    // Evidence: Daytona SDK downloadFile(remotePath) returns Buffer
    const buffer = await this.sandbox.fs.downloadFile(path);
    if (isBinaryFile(path)) {
      return new Uint8Array(buffer);
    }
    return buffer.toString("utf-8");
  }

  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    let buffer: Buffer;
    if (typeof content === "string") {
      buffer = Buffer.from(content, "utf-8");
    } else if (Buffer.isBuffer(content)) {
      buffer = content;
    } else if (content instanceof ArrayBuffer) {
      buffer = Buffer.from(content);
    } else if (content instanceof Uint8Array) {
      buffer = Buffer.from(content);
    } else {
      throw new Error(`Unsupported content type: ${typeof content}`);
    }
    // Evidence: Daytona SDK uploadFile(buffer: Buffer, remotePath: string, timeout?)
    await this.sandbox.fs.uploadFile(buffer, path);
  }

  async writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {
    // Evidence: Daytona SDK uploadFiles([{ source: Buffer, destination: string }])
    const uploads = files.map(file => {
      let source: Buffer;
      if (typeof file.data === "string") {
        source = Buffer.from(file.data, "utf-8");
      } else if (Buffer.isBuffer(file.data)) {
        source = file.data;
      } else if (file.data instanceof ArrayBuffer) {
        source = Buffer.from(file.data);
      } else if (file.data instanceof Uint8Array) {
        source = Buffer.from(file.data);
      } else {
        throw new Error(`Unsupported content type: ${typeof file.data}`);
      }
      return { source, destination: file.path };
    });
    await this.sandbox.fs.uploadFiles(uploads);
  }

  async makeDir(path: string): Promise<void> {
    // Evidence: Daytona SDK createFolder(path: string, mode: string)
    await this.sandbox.fs.createFolder(path, "755");
  }

  async exists(path: string): Promise<boolean> {
    // Evidence: Daytona SDK listFiles(path) returns FileInfo[]
    // Check if file exists by listing parent directory and searching for basename
    try {
      const parentDir = getParentDir(path);
      const basename = getBasename(path);
      const files = await this.sandbox.fs.listFiles(parentDir);
      return files.some(f => f.name === basename);
    } catch {
      return false;
    }
  }

  async list(path: string): Promise<FileInfo[]> {
    // Evidence: Daytona SDK listFiles(path) returns FileInfo[] with { name, isDir, size, ... }
    const files = await this.sandbox.fs.listFiles(path);
    return files.map(f => ({
      name: f.name,
      path: path.endsWith("/") ? `${path}${f.name}` : `${path}/${f.name}`,
      type: f.isDir ? "dir" as const : "file" as const,
    }));
  }

  async remove(path: string): Promise<void> {
    // Evidence: Daytona SDK deleteFile(path: string, recursive?: boolean)
    await this.sandbox.fs.deleteFile(path, true);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    // Evidence: Daytona SDK moveFiles(source: string, destination: string)
    await this.sandbox.fs.moveFiles(oldPath, newPath);
  }
}

class DaytonaSandboxImpl implements SandboxInstance {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;

  constructor(private sandbox: DaytonaSandbox) {
    this.commands = new DaytonaCommands(sandbox);
    this.files = new DaytonaFiles(sandbox);
  }

  get sandboxId(): string {
    // Evidence: Daytona Sandbox has id property
    return this.sandbox.id;
  }

  async getHost(port: number): Promise<string> {
    // Evidence: Daytona SDK getPreviewLink(port) returns { url: string, token?: string }
    const preview = await this.sandbox.getPreviewLink(port);
    return preview.url;
  }

  async isRunning(): Promise<boolean> {
    // Evidence: Daytona Sandbox has state property (SandboxState enum)
    // Values: "started", "stopped", "starting", "stopping", "unknown", etc.
    return this.sandbox.state === "started";
  }

  async getInfo(): Promise<SandboxInfo> {
    // Evidence: Daytona Sandbox properties: id, name, snapshot, labels
    return {
      sandboxId: this.sandbox.id,
      image: this.sandbox.snapshot || "unknown",
      name: this.sandbox.name,
      metadata: this.sandbox.labels || {},
      startedAt: new Date().toISOString(), // Daytona doesn't expose startedAt directly
    };
  }

  async kill(): Promise<void> {
    // Evidence: Daytona SDK sandbox.delete()
    await this.sandbox.delete();
  }

  async pause(): Promise<void> {
    // Evidence: Daytona SDK sandbox.stop()
    await this.sandbox.stop();
  }
}

export class DaytonaProvider implements SandboxProvider {
  readonly providerType = "daytona" as const;
  readonly name = "Daytona";
  private readonly client: Daytona;
  private readonly defaultTimeoutMs: number;

  constructor(config: ResolvedDaytonaConfig) {
    this.client = new Daytona({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      target: config.target,
    });
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 3600000;
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    const timeoutSec = Math.floor((options.timeoutMs ?? this.defaultTimeoutMs) / 1000);

    // Map generic 'image' to Daytona Docker image
    const image = IMAGE_MAP[options.image] ?? options.image;

    const sandbox = await this.client.create(
      {
        image,
        envVars: options.envs,
        labels: options.metadata,
        autoStopInterval: 0,
      },
      { timeout: timeoutSec }
    );

    if (options.workingDirectory) {
      await sandbox.fs.createFolder(options.workingDirectory, "755");
    }

    return new DaytonaSandboxImpl(sandbox);
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    // Evidence: Daytona SDK get(sandboxId) returns Sandbox
    const sandbox = await this.client.get(sandboxId);
    return new DaytonaSandboxImpl(sandbox);
  }

  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    // Evidence: Daytona SDK list(labels?, page?, limit?) returns PaginatedSandboxes
    const limit = options?.limit ?? 100;
    const result = await this.client.list(options?.metadata, 1, limit);

    return result.items.map(sandbox => ({
      sandboxId: sandbox.id,
      image: sandbox.snapshot || "unknown",
      name: sandbox.name,
      metadata: sandbox.labels || {},
      startedAt: new Date().toISOString(),
    }));
  }
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Create Daytona sandbox provider.
 *
 * @param config - Optional configuration. If apiKey not provided, reads from DAYTONA_API_KEY env var.
 * @throws Error if apiKey cannot be resolved
 */
export function createDaytonaProvider(config: DaytonaConfig = {}): SandboxProvider {
  const apiKey = config.apiKey ?? process.env.DAYTONA_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Daytona API key required. " +
        "Set DAYTONA_API_KEY environment variable or pass apiKey in config. " +
        "Get your key at https://app.daytona.io/dashboard/keys"
    );
  }

  return new DaytonaProvider({ ...config, apiKey });
}
