/**
 * MicroVM Sandbox Provider — Lightweight VM Execution via Boxlite
 *
 * Implements the same SandboxProvider/SandboxInstance interface as E2B, Daytona,
 * Modal, and Docker providers, but runs workloads in lightweight microVMs via
 * the Boxlite SDK (@boxlite-ai/boxlite).
 *
 * Design notes:
 * - All VM interaction via Boxlite's SimpleBox API (exec, copyIn, copyOut, stop)
 * - Dynamic import of @boxlite-ai/boxlite to avoid compile-time dependency
 * - File writes use host temp file + copyIn
 * - File reads use exec cat
 * - Background processes use temp-file subshell pattern (same as Docker)
 * - Platform restricted to macOS ARM64 and Linux
 */

import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

// ============================================================
// BOXLITE TYPE DECLARATION (avoids compile-time dependency)
// ============================================================

/** Minimal interface matching Boxlite's SimpleBox API */
interface SimpleBoxLike {
  exec(cmd: string, ...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  exec(cmd: string, args: string[], env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  exec(cmd: string, args: string[], env: Record<string, string>, options?: { cwd?: string; user?: string; timeoutSecs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  copyIn(hostPath: string, containerDest: string): Promise<void>;
  copyOut(containerSrc: string, hostDest: string): Promise<void>;
  stop(): Promise<void>;
  get id(): string;
  get name(): string | undefined;
}

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

function isBinaryFile(path: string): boolean {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function randomId(): string {
  return randomBytes(4).toString("hex"); // 8 hex chars
}

/**
 * Strip Boxlite/libcontainer runtime warnings from stderr.
 * Boxlite injects ANSI-colored WARN lines (e.g. seccomp warnings)
 * into stderr that aren't part of the user's command output.
 */
function stripRuntimeWarnings(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !line.includes("libcontainer::") && !line.includes("seccomp not available"))
    .join("\n");
}

/**
 * Execute a command on a SimpleBox with a timeout.
 *
 * Boxlite's SimpleBox.exec() does NOT support a timeout option — the
 * `{ timeoutSecs }` parameter in the type signature is silently ignored.
 * This wrapper uses Promise.race to enforce a hard timeout from the JS side.
 *
 * This is critical for commands like `kill -9 <pid>` which can cause
 * Boxlite's Rust stream reader to hang indefinitely (the killed process
 * disrupts pipe cleanup in the native layer).
 */
async function execWithTimeout(
  box: SimpleBoxLike,
  cmd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const execPromise = box.exec(cmd, args, env);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`exec timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`)), timeoutMs)
  );
  return Promise.race([execPromise, timeoutPromise]);
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

export interface MicroVMConfig {
  /** OCI image to use. Default: "ubuntu:latest" */
  image?: string;
  /** Memory in MiB. Default: 512 */
  memoryMib?: number;
  /** Number of vCPUs. Default: 1 */
  cpus?: number;
  /** Working directory inside the VM. Default: "/workspace" */
  workingDirectory?: string;
  /** Volume mounts from host to guest */
  volumes?: Array<{ hostPath: string; guestPath: string; readOnly?: boolean }>;
  /** Port mappings */
  ports?: Array<{ hostPort?: number; guestPort: number; protocol?: string }>;
  /** Security configuration */
  security?: {
    jailerEnabled?: boolean;
    seccompEnabled?: boolean;
    maxOpenFiles?: number;
    maxProcesses?: number;
    networkEnabled?: boolean;
  };
}

// ============================================================
// IMPLEMENTATION
// ============================================================

class MicroVMCommands implements SandboxCommands {
  constructor(private box: SimpleBoxLike) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    const envs = options?.envs ?? {};
    const timeoutMs = options?.timeoutMs ?? 600_000; // default 10 min

    // Boxlite exec cwd option may not be supported — use cd wrapper instead
    const wrappedCommand = options?.cwd
      ? `cd ${JSON.stringify(options.cwd)} && ${command}`
      : command;

    const result = await execWithTimeout(
      this.box,
      "bash",
      ["-c", wrappedCommand],
      envs,
      timeoutMs,
    );

    const cleanStderr = stripRuntimeWarnings(result.stderr);

    // Call streaming callbacks once with full output after exec completes
    if (result.stdout && options?.onStdout) {
      options.onStdout(result.stdout);
    }
    if (cleanStderr && options?.onStderr) {
      options.onStderr(cleanStderr);
    }

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: cleanStderr,
    };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    const uuid = randomId();
    const pidFile = `/tmp/evolve-proc-${uuid}.pid`;
    const outFile = `/tmp/evolve-proc-${uuid}.out`;
    const errFile = `/tmp/evolve-proc-${uuid}.err`;
    const exitFile = `/tmp/evolve-proc-${uuid}.exit`;

    // Run command in background subshell, capture PID and redirect output to temp files.
    // CRITICAL: The outer subshell must redirect stdin/stdout/stderr to /dev/null
    // so it doesn't hold Boxlite's exec pipe open. Without this, Boxlite's
    // stream reader blocks until the background process exits (defeating the
    // purpose of backgrounding).
    const cdPrefix = options?.cwd ? `cd ${JSON.stringify(options.cwd)} && ` : "";
    const bgCommand =
      `PID_FILE=${pidFile}; ` +
      `( (${cdPrefix}${command}) > ${outFile} 2> ${errFile}; echo $? > ${exitFile} ) </dev/null >/dev/null 2>&1 & ` +
      `echo $! > "$PID_FILE"; ` +
      `cat "$PID_FILE"`;

    const envs = options?.envs ?? {};

    const result = await execWithTimeout(this.box, "bash", ["-c", bgCommand], envs, 30_000);
    const pid = result.stdout.trim();

    const box = this.box;

    return {
      processId: pid,

      async wait(): Promise<SandboxCommandResult> {
        // Poll until process completes
        while (true) {
          const check = await execWithTimeout(
            box,
            "bash",
            ["-c", `kill -0 ${pid} 2>/dev/null; echo $?`],
            {},
            10_000,
          );
          const alive = check.stdout.trim();
          if (alive !== "0") {
            // Process exited — read output files
            const [exitResult, stdoutResult, stderrResult] = await Promise.all([
              execWithTimeout(box, "cat", [exitFile], {}, 10_000),
              execWithTimeout(box, "cat", [outFile], {}, 30_000),
              execWithTimeout(box, "cat", [errFile], {}, 30_000),
            ]);

            const exitCode = parseInt(exitResult.stdout.trim(), 10) || 0;

            // Cleanup temp files
            execWithTimeout(
              box,
              "bash",
              ["-c", `rm -f /tmp/evolve-proc-${uuid}.*`],
              {},
              5_000,
            ).catch(() => {});

            return {
              exitCode,
              stdout: stdoutResult.stdout,
              stderr: stderrResult.stdout,
            };
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      },

      async kill(): Promise<boolean> {
        // Boxlite's native exec can hang when running `kill` directly — the
        // killed process disrupts pipe cleanup in the Rust stream reader.
        // Workaround: wrap in bash -c so bash handles the signal, and race
        // with a timeout. If the exec hangs, the kill signal was still sent
        // by the kernel before the hang, so we treat timeout as success.
        try {
          await execWithTimeout(
            box,
            "bash",
            ["-c", `kill -9 ${pid} 2>/dev/null; exit 0`],
            {},
            5_000,
          );
          return true;
        } catch {
          // Timeout — the kill signal was likely sent before the hang.
          // Verify the process is actually dead.
          try {
            const check = await execWithTimeout(
              box,
              "bash",
              ["-c", `kill -0 ${pid} 2>/dev/null; echo $?`],
              {},
              5_000,
            );
            return check.stdout.trim() !== "0"; // true if process is gone
          } catch {
            // Even the check timed out — assume kill was successful
            return true;
          }
        }
      },
    };
  }

  async list(): Promise<ProcessInfo[]> {
    const result = await execWithTimeout(
      this.box,
      "ps",
      ["-eo", "pid,comm,args"],
      {},
      10_000,
    );

    const lines = result.stdout.trim().split("\n").slice(1); // skip header
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

  async kill(processId: string): Promise<boolean> {
    // Same bash wrapper + timeout pattern as spawn().kill() — see comments there.
    try {
      await execWithTimeout(
        this.box,
        "bash",
        ["-c", `kill -9 ${processId} 2>/dev/null; exit 0`],
        {},
        5_000,
      );
      return true;
    } catch {
      try {
        const check = await execWithTimeout(
          this.box,
          "bash",
          ["-c", `kill -0 ${processId} 2>/dev/null; echo $?`],
          {},
          5_000,
        );
        return check.stdout.trim() !== "0";
      } catch {
        return true;
      }
    }
  }
}

class MicroVMFiles implements SandboxFiles {
  constructor(private box: SimpleBoxLike) {}

  async read(path: string): Promise<string | Uint8Array> {
    if (isBinaryFile(path)) {
      // Binary files: read via base64 to avoid UTF-8 corruption
      // (Boxlite exec returns stdout as a string, which mangles bytes >127)
      const escapedPath = path.replace(/'/g, "'\\''");
      const result = await execWithTimeout(
        this.box,
        "bash",
        ["-c", `base64 '${escapedPath}'`],
        {},
        300_000,
      );

      if (result.exitCode !== 0) {
        const cleanStderr = stripRuntimeWarnings(result.stderr);
        throw new Error(
          `Failed to read file ${path}: ${cleanStderr || `exit code ${result.exitCode}`}`
        );
      }

      const b64 = result.stdout.replace(/\s/g, ""); // strip newlines from base64 output
      return new Uint8Array(Buffer.from(b64, "base64"));
    }

    // Text files: read directly
    const result = await execWithTimeout(
      this.box,
      "cat",
      [path],
      {},
      300_000,
    );

    if (result.exitCode !== 0) {
      const cleanStderr = stripRuntimeWarnings(result.stderr);
      throw new Error(
        `Failed to read file ${path}: ${cleanStderr || `exit code ${result.exitCode}`}`
      );
    }

    return result.stdout;
  }

  async write(filePath: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    const data = this.toBuffer(content);

    // Ensure parent directory exists inside the VM
    const dir = dirname(filePath);
    if (dir && dir !== "/") {
      await this.makeDir(dir);
    }

    // Write via base64-encoded exec — most reliable across Boxlite versions.
    // Split large content into chunks to avoid argument length limits.
    const b64 = data.toString("base64");
    const CHUNK_SIZE = 65536; // 64KB base64 chunks
    const escapedPath = filePath.replace(/'/g, "'\\''");

    if (b64.length <= CHUNK_SIZE) {
      // Single write
      const result = await execWithTimeout(
        this.box,
        "bash",
        ["-c", `printf '%s' '${b64}' | base64 -d > '${escapedPath}'`],
        {},
        60_000,
      );
      if (result.exitCode !== 0) {
        const cleanStderr = stripRuntimeWarnings(result.stderr);
        throw new Error(
          `Failed to write file ${filePath}: ${cleanStderr || `exit code ${result.exitCode}`}`
        );
      }
    } else {
      // Chunked write — first chunk truncates, rest append
      for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
        const chunk = b64.slice(i, i + CHUNK_SIZE);
        const op = i === 0 ? ">" : ">>";
        const result = await execWithTimeout(
          this.box,
          "bash",
          ["-c", `printf '%s' '${chunk}' ${op} /tmp/_evolve_b64_staging`],
          {},
          60_000,
        );
        if (result.exitCode !== 0) {
          const cleanStderr = stripRuntimeWarnings(result.stderr);
          throw new Error(
            `Failed to write file ${filePath}: ${cleanStderr || `exit code ${result.exitCode}`}`
          );
        }
      }
      // Decode staged base64 to final path
      const decodeResult = await execWithTimeout(
        this.box,
        "bash",
        ["-c", `base64 -d /tmp/_evolve_b64_staging > '${escapedPath}' && rm -f /tmp/_evolve_b64_staging`],
        {},
        60_000,
      );
      if (decodeResult.exitCode !== 0) {
        const cleanStderr = stripRuntimeWarnings(decodeResult.stderr);
        throw new Error(
          `Failed to write file ${filePath}: ${cleanStderr || `exit code ${decodeResult.exitCode}`}`
        );
      }
    }
  }

  async writeBatch(
    files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>
  ): Promise<void> {
    if (files.length === 0) return;
    await Promise.all(files.map((f) => this.write(f.path, f.data)));
  }

  async makeDir(path: string): Promise<void> {
    const result = await execWithTimeout(
      this.box,
      "mkdir",
      ["-p", path],
      {},
      10_000,
    );

    if (result.exitCode !== 0) {
      const cleanStderr = stripRuntimeWarnings(result.stderr);
      throw new Error(
        `Failed to create directory ${path}: ${cleanStderr || `exit code ${result.exitCode}`}`
      );
    }
  }

  private toBuffer(content: string | Buffer | ArrayBuffer | Uint8Array): Buffer {
    if (typeof content === "string") return Buffer.from(content, "utf-8");
    if (content instanceof Buffer) return content;
    if (content instanceof ArrayBuffer) return Buffer.from(content);
    if (content instanceof Uint8Array) return Buffer.from(content);
    throw new Error(`Unsupported data type: ${typeof content}`);
  }
}

class MicroVMSandboxImpl implements SandboxInstance {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;

  constructor(private box: SimpleBoxLike) {
    this.commands = new MicroVMCommands(box);
    this.files = new MicroVMFiles(box);
  }

  get sandboxId(): string {
    return this.box.name ?? this.box.id;
  }

  async getHost(port: number): Promise<string> {
    return `localhost:${port}`;
  }

  async kill(): Promise<void> {
    await this.box.stop();
  }

  async pause(): Promise<void> {
    // MicroVM pause not supported via Boxlite SimpleBox API — no-op
  }
}

// ============================================================
// PROVIDER
// ============================================================

export class MicroVMProvider implements SandboxProvider {
  readonly providerType = "microvm" as const;
  readonly name = "MicroVM";
  private readonly config: MicroVMConfig;

  constructor(config: MicroVMConfig = {}) {
    this.config = config;
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    const { SimpleBox } = await import("@boxlite-ai/boxlite");

    const image = options.image ?? this.config.image ?? "ubuntu:latest";
    const workingDirectory = options.workingDirectory ?? this.config.workingDirectory ?? "/workspace";
    const boxName = `evolve-${randomId()}`;

    const boxConfig: Record<string, unknown> = {
      name: boxName,
      image,
      memoryMib: this.config.memoryMib ?? 512,
      cpus: this.config.cpus ?? 1,
    };

    // Merge environment variables
    if (options.envs) {
      boxConfig.env = options.envs;
    }

    // Volume mounts
    if (this.config.volumes && this.config.volumes.length > 0) {
      boxConfig.volumes = this.config.volumes;
    }

    // Port mappings
    if (this.config.ports && this.config.ports.length > 0) {
      boxConfig.ports = this.config.ports;
    }

    // Security settings
    if (this.config.security) {
      boxConfig.security = this.config.security;
    }

    const box: SimpleBoxLike = new SimpleBox(boxConfig);
    const instance = new MicroVMSandboxImpl(box);

    // Ensure working directory exists inside the VM
    if (workingDirectory) {
      await execWithTimeout(box, "mkdir", ["-p", workingDirectory], {}, 10_000);
    }

    return instance;
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    const { SimpleBox } = await import("@boxlite-ai/boxlite");

    const box: SimpleBoxLike = new SimpleBox({
      name: sandboxId,
      reuseExisting: true,
    });

    return new MicroVMSandboxImpl(box);
  }
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Create MicroVM sandbox provider for lightweight VM execution via Boxlite.
 *
 * Requires @boxlite-ai/boxlite to be installed as a dependency.
 * Supported platforms: macOS ARM64, Linux.
 *
 * @param config - Optional configuration
 * @throws Error if platform is unsupported
 */
export function createMicroVMProvider(config: MicroVMConfig = {}): SandboxProvider {
  // Platform check: macOS ARM64 or Linux only
  const platform = process.platform;
  const arch = process.arch;

  const isMacARM = platform === "darwin" && arch === "arm64";
  const isLinux = platform === "linux";

  if (!isMacARM && !isLinux) {
    throw new Error(
      `MicroVM provider is not supported on ${platform}/${arch}. ` +
      `Supported platforms: macOS ARM64 (Apple Silicon), Linux.`
    );
  }

  return new MicroVMProvider(config);
}
