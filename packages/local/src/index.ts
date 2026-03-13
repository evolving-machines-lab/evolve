/**
 * Local Sandbox Provider — Direct Subprocess Execution
 *
 * Implements the same SandboxProvider/SandboxInstance interface as E2B, Daytona,
 * Modal, and Docker providers, but runs commands directly on the host via
 * child_process.spawn.
 *
 * No isolation — commands run with the same permissions as the Node.js process.
 *
 * Design notes:
 * - Commands via bash -c (child_process.spawn)
 * - File operations via node:fs/promises
 * - No container, VM, or sandbox boundary
 * - Best for rapid iteration on trusted code
 */

import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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
  ".bin",
]);

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// ============================================================
// CORE TYPES (re-declared to avoid importing from sdk-ts)
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

/** Options for command execution */
export interface SandboxRunOptions {
  timeoutMs?: number;
  envs?: Record<string, string>;
  cwd?: string;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/** Options for spawning background processes in sandbox */
export interface SandboxSpawnOptions extends SandboxRunOptions {
  stdin?: boolean;
}

/** Options for creating a sandbox */
export interface SandboxCreateOptions {
  image?: string;
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

export interface LocalConfig {
  /** Working directory for commands. Default: process.cwd() */
  workingDirectory?: string;
  /** Default timeout in ms. Default: 600000 (10 min) */
  defaultTimeoutMs?: number;
}

// ============================================================
// IMPLEMENTATION
// ============================================================

class LocalCommands implements SandboxCommands {
  private processes = new Map<string, ChildProcess>();
  private processInfoMap = new Map<string, { cmd: string; envs: Record<string, string>; cwd?: string }>();

  constructor(private defaultCwd: string) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    return new Promise((resolve, reject) => {
      const cwd = options?.cwd ?? this.defaultCwd;
      const env = options?.envs
        ? { ...process.env, ...options.envs }
        : process.env;

      const child = cpSpawn("bash", ["-c", command], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      if (options?.timeoutMs) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        if (!settled) options?.onStdout?.(chunk.toString());
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        if (!settled) options?.onStderr?.(chunk.toString());
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          exitCode: code ?? 0,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
        });
      });

      child.stdin?.end();
    });
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    const cwd = options?.cwd ?? this.defaultCwd;
    const env = options?.envs
      ? { ...process.env, ...options.envs }
      : process.env;

    const child = cpSpawn("bash", ["-c", command], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const processId = String(child.pid);
    this.processes.set(processId, child);
    this.processInfoMap.set(processId, {
      cmd: command,
      envs: options?.envs ?? {},
      cwd,
    });

    if (options?.onStdout) {
      child.stdout?.on("data", (chunk: Buffer) => {
        options.onStdout!(chunk.toString());
      });
    }
    if (options?.onStderr) {
      child.stderr?.on("data", (chunk: Buffer) => {
        options.onStderr!(chunk.toString());
      });
    }

    const processes = this.processes;
    const processInfoRef = this.processInfoMap;

    return {
      processId,

      wait(): Promise<SandboxCommandResult> {
        return new Promise((resolve, reject) => {
          const stdoutChunks: Buffer[] = [];
          const stderrChunks: Buffer[] = [];

          child.stdout?.on("data", (chunk: Buffer) => {
            stdoutChunks.push(chunk);
          });

          child.stderr?.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk);
          });

          child.on("error", (err) => {
            processes.delete(processId);
            processInfoRef.delete(processId);
            reject(err);
          });

          child.on("close", (code) => {
            processes.delete(processId);
            processInfoRef.delete(processId);
            resolve({
              exitCode: code ?? 0,
              stdout: Buffer.concat(stdoutChunks).toString(),
              stderr: Buffer.concat(stderrChunks).toString(),
            });
          });
        });
      },

      async kill(): Promise<boolean> {
        try {
          child.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              try { child.kill("SIGKILL"); } catch {}
              resolve();
            }, 5000);
            child.on("close", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          processes.delete(processId);
          processInfoRef.delete(processId);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  async list(): Promise<ProcessInfo[]> {
    const result: ProcessInfo[] = [];
    for (const [processId, info] of this.processInfoMap) {
      if (this.processes.has(processId)) {
        result.push({
          processId,
          cmd: info.cmd,
          args: [],
          envs: info.envs,
          cwd: info.cwd,
        });
      }
    }
    return result;
  }

  async kill(processId: string): Promise<boolean> {
    const child = this.processes.get(processId);
    if (!child) return false;
    try {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          resolve();
        }, 5000);
        child.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.processes.delete(processId);
      this.processInfoMap.delete(processId);
      return true;
    } catch {
      return false;
    }
  }

  /** Kill all tracked processes */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }
}

class LocalFiles implements SandboxFiles {
  constructor(private defaultCwd: string) {}

  async read(filePath: string): Promise<string | Uint8Array> {
    const resolved = path.resolve(this.defaultCwd, filePath);
    try {
      if (isBinaryFile(resolved)) {
        const buffer = await fs.readFile(resolved);
        return new Uint8Array(buffer);
      }
      return await fs.readFile(resolved, "utf-8");
    } catch (err) {
      throw new Error(
        `Failed to read file ${filePath}: ${(err as Error).message}`
      );
    }
  }

  async write(filePath: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    const resolved = path.resolve(this.defaultCwd, filePath);
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });

    const data = this.toBuffer(content);
    await fs.writeFile(resolved, data);
  }

  async writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {
    await Promise.all(files.map((f) => this.write(f.path, f.data)));
  }

  async makeDir(dirPath: string): Promise<void> {
    const resolved = path.resolve(this.defaultCwd, dirPath);
    await fs.mkdir(resolved, { recursive: true });
  }

  private toBuffer(content: string | Buffer | ArrayBuffer | Uint8Array): Buffer {
    if (typeof content === "string") return Buffer.from(content, "utf-8");
    if (content instanceof Buffer) return content;
    if (content instanceof ArrayBuffer) return Buffer.from(content);
    if (content instanceof Uint8Array) return Buffer.from(content);
    throw new Error(`Unsupported data type: ${typeof content}`);
  }
}

class LocalSandboxImpl implements SandboxInstance {
  readonly sandboxId: string;
  readonly commands: LocalCommands;
  readonly files: SandboxFiles;

  constructor(private workingDirectory: string) {
    this.sandboxId = randomUUID();
    this.commands = new LocalCommands(workingDirectory);
    this.files = new LocalFiles(workingDirectory);
  }

  async getHost(port: number): Promise<string> {
    return `localhost:${port}`;
  }

  async kill(): Promise<void> {
    await this.commands.killAll();
    instances.delete(this.sandboxId);
  }

  async pause(): Promise<void> {
    // No-op — local processes can't be meaningfully paused
  }
}

// ============================================================
// PROVIDER
// ============================================================

/** Registry of active local sandbox instances */
const instances = new Map<string, LocalSandboxImpl>();

export class LocalProvider implements SandboxProvider {
  readonly providerType = "local" as const;
  readonly name = "Local";
  private readonly config: LocalConfig;

  constructor(config: LocalConfig = {}) {
    this.config = config;
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    const cwd = options.workingDirectory ?? this.config.workingDirectory ?? process.cwd();

    const instance = new LocalSandboxImpl(cwd);
    instances.set(instance.sandboxId, instance);
    return instance;
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    const instance = instances.get(sandboxId);
    if (!instance) {
      throw new Error(
        `Local sandbox '${sandboxId}' not found. It may have been killed or never existed.`
      );
    }
    return instance;
  }
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Create local sandbox provider for direct subprocess execution.
 *
 * No isolation — commands run with the same permissions as the Node.js process.
 * Best for rapid iteration, debugging, and testing trusted code.
 *
 * @param config - Optional configuration
 */
export function createLocalProvider(config: LocalConfig = {}): SandboxProvider {
  return new LocalProvider(config);
}
