/**
 * Daytona Sandbox Provider
 *
 * @requires @daytonaio/sdk
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

/** Public Docker image for evolve-all (fallback when snapshot doesn't exist) */
const EVOLVE_ALL_PUBLIC_IMAGE = "evolvingmachines/evolve-all:latest";

/** Map of image names to public Docker images */
const PUBLIC_IMAGE_MAP: Record<string, string> = {
  "evolve-all": EVOLVE_ALL_PUBLIC_IMAGE,
  "evolve-all-dev": EVOLVE_ALL_PUBLIC_IMAGE,  // Dev uses same image
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
}

/** Sandbox instance */
export interface SandboxInstance {
  readonly sandboxId: string;
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
  getHost(port: number): Promise<string>;
  kill(): Promise<void>;
  pause(): Promise<void>;
}

/** Sandbox lifecycle management */
export interface SandboxProvider {
  readonly providerType: string;
  readonly name?: string;
  create(options: SandboxCreateOptions): Promise<SandboxInstance>;
  connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance>;
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
    // Convert timeout from ms to seconds
    const timeoutSec = options?.timeoutMs ? Math.floor(options.timeoutMs / 1000) : undefined;

    // Check if streaming is requested
    if (options?.onStdout || options?.onStderr) {
      // Streaming path: use ephemeral session
      const sessionId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.sandbox.process.createSession(sessionId);

      try {
        // Execute command in session
        const resp = await this.sandbox.process.executeSessionCommand(sessionId, {
          command,
          async: false,
        }, timeoutSec);

        // Get command ID from response
        const cmdId = resp.cmdId;
        if (cmdId) {
          // Stream logs with callbacks - use the overload with 4 args
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
        // Clean up session
        try {
          await this.sandbox.process.deleteSession(sessionId);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // Non-streaming path: use executeCommand directly
    // Daytona API: executeCommand(command, cwd?, env?, timeout?)
    const result = await this.sandbox.process.executeCommand(
      command,
      options?.cwd,
      options?.envs,
      timeoutSec
    );

    return {
      exitCode: result.exitCode,
      stdout: result.result || "",
      stderr: "",  // Daytona combines output in result
    };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    // Daytona uses sessions for background processes
    const sessionId = `evolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.sandbox.process.createSession(sessionId);

    // Convert timeout from ms to seconds
    const timeoutSec = options?.timeoutMs ? Math.floor(options.timeoutMs / 1000) : undefined;

    // Execute command in async mode
    const resp = await this.sandbox.process.executeSessionCommand(sessionId, {
      command,
      async: true,
    }, timeoutSec);

    const cmdId = resp.cmdId;

    // If streaming callbacks provided, start streaming in background
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
        // Poll for completion by checking session
        // For now, return the initial response
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
    // Daytona uses sessions, not PIDs
    // Return sessions as process info
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
    // Daytona downloadFile returns Buffer
    const buffer = await this.sandbox.fs.downloadFile(path);
    if (isBinaryFile(path)) {
      // Return as Uint8Array for binary files
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
    // Daytona API: uploadFile(buffer: Buffer, remotePath: string, timeout?)
    await this.sandbox.fs.uploadFile(buffer, path);
  }

  async writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {
    // Daytona's uploadFiles expects { source: string | Buffer, destination: string }[]
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
    await this.sandbox.fs.createFolder(path, "755");
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
    return this.sandbox.id;
  }

  async getHost(port: number): Promise<string> {
    // Daytona getPreviewLink returns { url: string, token?: string }
    const preview = await this.sandbox.getPreviewLink(port);
    return preview.url;
  }

  async kill(): Promise<void> {
    await this.sandbox.delete();
  }

  async pause(): Promise<void> {
    await this.sandbox.stop();
  }
}

export class DaytonaSandboxProvider implements SandboxProvider {
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
    const imageName = options.image;

    let sandbox: DaytonaSandbox;

    // Try to create from snapshot first
    try {
      const snapshot = await this.client.snapshot.get(imageName);
      if (snapshot && snapshot.state === "active") {
        // Snapshot exists and is active - use it
        sandbox = await this.client.create({
          snapshot: imageName,
          envVars: options.envs,
          labels: options.metadata,
          autoStopInterval: 0,  // Don't auto-stop
        }, { timeout: timeoutSec });
      } else {
        throw new Error("Snapshot not active");
      }
    } catch {
      // Snapshot doesn't exist or not active - fall back to public image
      const publicImage = PUBLIC_IMAGE_MAP[imageName];
      if (!publicImage) {
        throw new Error(
          `Unknown image "${imageName}" and no public fallback available. ` +
          `Available images: ${Object.keys(PUBLIC_IMAGE_MAP).join(", ")}`
        );
      }

      console.log(`Snapshot "${imageName}" not found, creating from public image: ${publicImage}`);
      console.log("This may take a few minutes on first run (image will be cached)...");

      // Create sandbox from public Docker image
      sandbox = await this.client.create(
        {
          image: publicImage,
          envVars: options.envs,
          labels: options.metadata,
          autoStopInterval: 0,
        },
        {
          timeout: timeoutSec,
          onSnapshotCreateLogs: (log: string) => console.log(log),
        }
      );
    }

    if (options.workingDirectory) {
      await sandbox.fs.createFolder(options.workingDirectory, "755");
    }

    return new DaytonaSandboxImpl(sandbox);
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    const sandbox = await this.client.get(sandboxId);
    return new DaytonaSandboxImpl(sandbox);
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

  return new DaytonaSandboxProvider({ ...config, apiKey });
}
