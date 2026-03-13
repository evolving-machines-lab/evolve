/**
 * Docker Sandbox Provider — Local Container Execution
 *
 * Implements the same SandboxProvider/SandboxInstance interface as E2B, Daytona,
 * and Modal providers, but runs containers locally via the Docker CLI.
 *
 * No external SDK dependency — uses child_process.execFile/spawn exclusively.
 *
 * Design notes:
 * - All Docker interaction via CLI (child_process), not Engine API
 * - File writes use tar-stream → docker cp (same pattern as Modal)
 * - File reads use docker exec cat
 * - Container kept alive via `sleep infinity` entrypoint
 * - Pause/resume supported natively via docker pause/unpause
 */

import { execFile, execFileSync, spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pack } from "tar-stream";

// ============================================================
// MODULE-LEVEL CONSTANTS & HELPERS
// ============================================================

/** Map generic image names to Docker Hub images */
const IMAGE_MAP: Record<string, string> = {
  "evolve-all": "evolvingmachines/evolve-all",
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
  ".bin",
]);

function isBinaryFile(path: string): boolean {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function randomId(): string {
  return randomBytes(4).toString("hex"); // 8 hex chars
}

// ============================================================
// DOCKER CLI HELPERS
// ============================================================

interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/**
 * Run a docker CLI command via execFile.
 * Returns stdout/stderr as Buffers and exit code (never throws on non-zero exit).
 */
function dockerExec(
  args: string[],
  options?: { timeoutMs?: number; input?: Buffer | Uint8Array }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      args,
      {
        maxBuffer: 50 * 1024 * 1024, // 50MB
        timeout: options?.timeoutMs,
        encoding: "buffer",
      },
      (error, stdout, stderr) => {
        if (error && (error as any).killed) {
          reject(new Error(`Docker command killed (signal: ${(error as any).signal})`));
          return;
        }
        // error.status is the child process exit code (number) for non-zero exits
        const exitCode = error ? ((error as any).status ?? child.exitCode ?? 1) : 0;
        resolve({
          stdout: stdout as unknown as Buffer,
          stderr: stderr as unknown as Buffer,
          exitCode,
        });
      }
    );
    if (options?.input && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

/**
 * Run a docker CLI command via spawn (streaming output).
 * Used for commands that need onStdout/onStderr callbacks.
 */
function dockerSpawn(
  args: string[],
  options?: {
    timeoutMs?: number;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    input?: Buffer | Uint8Array;
  }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = cpSpawn("docker", args, {
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
        reject(new Error(`Docker command timed out after ${options.timeoutMs}ms`));
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
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode: code ?? 0,
      });
    });

    if (options?.input && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    } else {
      child.stdin?.end();
    }
  });
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
// IMPLEMENTATION
// ============================================================

class DockerCommands implements SandboxCommands {
  constructor(private containerId: string) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    const args = this.buildExecArgs(command, options);

    const result = await dockerSpawn(args, {
      timeoutMs: options?.timeoutMs,
      onStdout: options?.onStdout,
      onStderr: options?.onStderr,
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    const uuid = randomId();
    const pidFile = `/tmp/evolve-proc-${uuid}.pid`;
    const outFile = `/tmp/evolve-proc-${uuid}.out`;
    const errFile = `/tmp/evolve-proc-${uuid}.err`;
    const exitFile = `/tmp/evolve-proc-${uuid}.exit`;

    // Run command in background subshell, capture PID and redirect output to temp files.
    // Write PID file synchronously before backgrounding to avoid race with cat.
    const bgCommand =
      `PID_FILE=${pidFile}; ` +
      `( (${command}) > ${outFile} 2> ${errFile}; echo $? > ${exitFile} ) & ` +
      `echo $! > "$PID_FILE"; ` +
      `cat "$PID_FILE"`;

    const args = this.buildExecArgs(bgCommand, options);
    const result = await dockerExec(args, { timeoutMs: 30000 });
    const pid = result.stdout.toString().trim();

    const containerId = this.containerId;

    return {
      processId: pid,

      async wait(): Promise<SandboxCommandResult> {
        // Poll until process completes
        while (true) {
          const check = await dockerExec(
            ["exec", containerId, "bash", "-c", `kill -0 ${pid} 2>/dev/null; echo $?`],
            { timeoutMs: 10000 }
          );
          const alive = check.stdout.toString().trim();
          if (alive !== "0") {
            // Process exited — read output files
            const [exitResult, stdoutResult, stderrResult] = await Promise.all([
              dockerExec(["exec", containerId, "cat", exitFile], { timeoutMs: 10000 }),
              dockerExec(["exec", containerId, "cat", outFile], { timeoutMs: 30000 }),
              dockerExec(["exec", containerId, "cat", errFile], { timeoutMs: 30000 }),
            ]);

            const exitCode = parseInt(exitResult.stdout.toString().trim(), 10) || 0;

            // Cleanup temp files
            dockerExec(
              ["exec", containerId, "bash", "-c", `rm -f /tmp/evolve-proc-${uuid}.*`],
              { timeoutMs: 5000 }
            ).catch(() => {});

            return {
              exitCode,
              stdout: stdoutResult.stdout.toString(),
              stderr: stderrResult.stdout.toString(),
            };
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      },

      async kill(): Promise<boolean> {
        const result = await dockerExec(
          ["exec", containerId, "kill", "-9", pid],
          { timeoutMs: 10000 }
        );
        return result.exitCode === 0;
      },
    };
  }

  async list(): Promise<ProcessInfo[]> {
    const result = await dockerExec(
      ["exec", this.containerId, "ps", "-eo", "pid,comm,args"],
      { timeoutMs: 10000 }
    );

    const lines = result.stdout.toString().trim().split("\n").slice(1); // skip header
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
    const result = await dockerExec(
      ["exec", this.containerId, "kill", "-9", processId],
      { timeoutMs: 10000 }
    );
    return result.exitCode === 0;
  }

  private buildExecArgs(command: string, options?: SandboxRunOptions): string[] {
    const args = ["exec"];

    // Add environment variables
    if (options?.envs) {
      for (const [key, value] of Object.entries(options.envs)) {
        if (value !== undefined && value !== null) {
          args.push("-e", `${key}=${value}`);
        }
      }
    }

    // Add working directory
    if (options?.cwd) {
      args.push("-w", options.cwd);
    }

    args.push(this.containerId, "bash", "-c", command);
    return args;
  }
}

class DockerFiles implements SandboxFiles {
  constructor(private containerId: string) {}

  async read(path: string): Promise<string | Uint8Array> {
    const result = await dockerExec(
      ["exec", this.containerId, "cat", path],
      { timeoutMs: 300000 }
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to read file ${path}: ${result.stderr.toString() || `exit code ${result.exitCode}`}`
      );
    }

    if (isBinaryFile(path)) {
      return new Uint8Array(result.stdout);
    }
    return result.stdout.toString();
  }

  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    const data = this.toBuffer(content);

    // Ensure parent directory exists
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      await this.makeDir(dir);
    }

    // Use tar-stream → docker cp for all writes (safe for binary, consistent approach)
    const tarBuffer = await this.createTarBuffer([{ path, data }]);
    const result = await dockerExec(
      ["cp", "-", `${this.containerId}:/`],
      { timeoutMs: 300000, input: tarBuffer }
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to write file ${path}: ${result.stderr.toString() || `exit code ${result.exitCode}`}`
      );
    }
  }

  async writeBatch(
    files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>
  ): Promise<void> {
    if (files.length === 0) return;

    // Ensure parent directories exist
    const dirs = new Set<string>();
    for (const file of files) {
      const dir = file.path.substring(0, file.path.lastIndexOf("/"));
      if (dir) dirs.add(dir);
    }
    await Promise.all([...dirs].map((d) => this.makeDir(d)));

    const entries = files.map((f) => ({
      path: f.path,
      data: this.toBuffer(f.data),
    }));

    const tarBuffer = await this.createTarBuffer(entries);
    const result = await dockerExec(
      ["cp", "-", `${this.containerId}:/`],
      { timeoutMs: 300000, input: tarBuffer }
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to write batch: ${result.stderr.toString() || `exit code ${result.exitCode}`}`
      );
    }
  }

  async makeDir(path: string): Promise<void> {
    const result = await dockerExec(
      ["exec", this.containerId, "mkdir", "-p", path],
      { timeoutMs: 10000 }
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create directory ${path}: ${result.stderr.toString() || `exit code ${result.exitCode}`}`
      );
    }
  }

  private async createTarBuffer(
    entries: Array<{ path: string; data: Buffer }>
  ): Promise<Buffer> {
    const tarPack = pack();
    const chunks: Buffer[] = [];

    for (const entry of entries) {
      // Strip leading slash for tar entries
      const name = entry.path.startsWith("/") ? entry.path.slice(1) : entry.path;
      tarPack.entry({ name }, entry.data);
    }
    tarPack.finalize();

    for await (const chunk of tarPack) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private toBuffer(content: string | Buffer | ArrayBuffer | Uint8Array): Buffer {
    if (typeof content === "string") return Buffer.from(content, "utf-8");
    if (content instanceof Buffer) return content;
    if (content instanceof ArrayBuffer) return Buffer.from(content);
    if (content instanceof Uint8Array) return Buffer.from(content);
    throw new Error(`Unsupported data type: ${typeof content}`);
  }
}

class DockerSandboxImpl implements SandboxInstance {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;

  constructor(private containerId: string) {
    this.commands = new DockerCommands(containerId);
    this.files = new DockerFiles(containerId);
  }

  get sandboxId(): string {
    return this.containerId;
  }

  async getHost(port: number): Promise<string> {
    const result = await dockerExec(
      ["port", this.containerId, String(port)],
      { timeoutMs: 10000 }
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `No port mapping found for port ${port}. ` +
        `Publish ports at creation time or use --publish.`
      );
    }

    // docker port output format: "0.0.0.0:12345" or ":::12345"
    const mapping = result.stdout.toString().trim().split("\n")[0];
    const hostPort = mapping.split(":").pop();
    return `localhost:${hostPort}`;
  }

  async kill(): Promise<void> {
    await dockerExec(["rm", "-f", this.containerId], { timeoutMs: 30000 });
  }

  async pause(): Promise<void> {
    const result = await dockerExec(["pause", this.containerId], { timeoutMs: 10000 });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to pause container ${this.containerId}: ${result.stderr.toString()}`
      );
    }
  }
}

// ============================================================
// CONFIGURATION
// ============================================================

export interface DockerConfig {
  /** Default timeout in ms. Default: 3600000 (1 hour) */
  defaultTimeoutMs?: number;
  /** Docker image name (default: 'evolve-all'). Resolved through IMAGE_MAP or used as-is for custom images. */
  imageName?: string;
}

// ============================================================
// PROVIDER
// ============================================================

export class DockerProvider implements SandboxProvider {
  readonly providerType = "docker" as const;
  readonly name = "Docker";
  private readonly imageName: string;
  private readonly defaultTimeoutMs: number;

  constructor(config: DockerConfig = {}) {
    this.imageName = config.imageName ?? "evolve-all";
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 3600000;
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    const containerName = `evolve-${randomId()}`;

    // Resolve image name through IMAGE_MAP
    const imageName = options.image || this.imageName;
    const resolvedImage = IMAGE_MAP[imageName] ?? imageName;

    // Build docker run args
    const args = [
      "run", "-d",
      "--name", containerName,
      "--label", "evolve.managed=true",
      "--label", `evolve.created=${new Date().toISOString()}`,
      "--label", `evolve.image=${resolvedImage}`,
    ];

    // Add environment variables
    if (options.envs) {
      for (const [key, value] of Object.entries(options.envs)) {
        if (value !== undefined && value !== null) {
          args.push("-e", `${key}=${value}`);
        }
      }
    }

    // Set working directory
    if (options.workingDirectory) {
      args.push("-w", options.workingDirectory);
    }

    // Image and entrypoint
    args.push(resolvedImage, "sleep", "infinity");

    const result = await dockerExec(args, { timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs });

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString();
      if (stderr.includes("No such image") || stderr.includes("Unable to find image")) {
        throw new Error(
          `Docker image '${resolvedImage}' not found. ` +
          `Run 'docker pull ${resolvedImage}' or use a custom image.`
        );
      }
      throw new Error(`Failed to create Docker container: ${stderr}`);
    }

    // Ensure working directory exists inside the container
    if (options.workingDirectory) {
      await dockerExec(
        ["exec", containerName, "mkdir", "-p", options.workingDirectory],
        { timeoutMs: 10000 }
      );
    }

    return new DockerSandboxImpl(containerName);
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    // Inspect container to get its state
    const result = await dockerExec(
      ["inspect", "--format", "{{.State.Status}}", sandboxId],
      { timeoutMs: 10000 }
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Container '${sandboxId}' not found. It may have been removed.`
      );
    }

    const status = result.stdout.toString().trim();

    if (status === "paused") {
      const unpause = await dockerExec(["unpause", sandboxId], { timeoutMs: 10000 });
      if (unpause.exitCode !== 0) {
        throw new Error(`Failed to unpause container '${sandboxId}': ${unpause.stderr.toString()}`);
      }
    } else if (status === "exited" || status === "created") {
      const start = await dockerExec(["start", sandboxId], { timeoutMs: 30000 });
      if (start.exitCode !== 0) {
        throw new Error(`Failed to start container '${sandboxId}': ${start.stderr.toString()}`);
      }
    } else if (status !== "running") {
      throw new Error(`Container '${sandboxId}' is in unexpected state: ${status}`);
    }

    return new DockerSandboxImpl(sandboxId);
  }
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Create Docker sandbox provider for local container execution.
 *
 * Requires Docker to be installed and the daemon to be running.
 * No API key needed — runs containers on the local machine.
 *
 * @param config - Optional configuration
 * @throws Error if Docker is not available
 */
export function createDockerProvider(config: DockerConfig = {}): SandboxProvider {
  // Verify Docker is available (synchronous check at construction time)
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      "Docker is not available. " +
      "Install Docker Desktop (https://docker.com/get-started) " +
      "or ensure the Docker daemon is running."
    );
  }

  return new DockerProvider(config);
}
