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

/**
 * E2B signals an expired command with TimeoutError. Matched by NAME rather than
 * instanceof, so a duplicated copy of the SDK in the dependency tree cannot
 * quietly turn a timeout back into an unrecognized throw.
 */
function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { name?: unknown }).name === "TimeoutError") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /timed?\s*out/i.test(message);
}

// ============================================================
// MODULE-LEVEL CONSTANTS & HELPERS
// ============================================================

/**
 * Largest page E2B will serve. Not a taste choice — a larger `limit` is refused
 * outright: `400 validation error: parameter "limit" in query has an error:
 * number must be at most 100`.
 */
export const E2B_MAX_PAGE_SIZE = 100;

/**
 * Page ceiling for one enumeration — 10,000 sandboxes at the maximum page size.
 * A walk that reaches it stops and reports itself INCOMPLETE, because the one
 * thing a fleet enumeration may never do is return a short list that reads like
 * a whole one.
 */
export const E2B_MAX_LIST_PAGES = 100;

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

/**
 * Minimum `e2b` client that can switch a running sandbox's egress.
 * `Sandbox.updateNetwork` first appears in 2.26.0 — established by fetching the
 * versions published to the npm registry and reading their shipped type
 * declarations: absent in 2.24.0, present in 2.26.0. Cited that way on purpose:
 * a line number in whatever copy happens to sit in node_modules says nothing
 * about which RELEASE gained the method, which is the only thing a caller
 * deciding on an upgrade needs to know.
 */
export const E2B_MIN_UPDATE_NETWORK_VERSION = "2.26.0";

/**
 * Typed error for a runtime egress switch the INSTALLED client cannot make.
 *
 * E2B the service supports it; an older `e2b` package simply has no method to
 * call. That distinction matters to whoever reads this: the fix is a
 * dependency bump, not a plan change or a different provider. Refused loudly
 * rather than skipped, because a policy switch that quietly does nothing
 * leaves the sandbox running under the previous policy — which, when the
 * switch was meant to TIGHTEN egress, is the failure nobody notices.
 */
export class E2BNetworkUpdateUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2BNetworkUpdateUnsupportedError";
  }
}

/** E2B create/update params derived from Evolve's provider-neutral network policy. */
interface E2BNetworkParams {
  allowInternetAccess: boolean;
  network?: { denyOut: string[]; allowOut: string[] };
}

/**
 * Map Evolve's provider-neutral network policy onto E2B's network params.
 *
 * - outbound "open" (or no policy)     → unrestricted egress
 * - outbound "blocked", no allowlist   → allowInternetAccess: false, which E2B
 *   documents as behaving "the same as specifying `denyOut: ['0.0.0.0/0']`"
 * - outbound "blocked" with allowlist  → deny everything, then allow the
 *   declared destinations back
 *
 * ONE mapper for both paths. The create path and the runtime switch must agree
 * on what a policy means, or an update would grant egress the create would
 * have refused — and the two calls take structurally identical params
 * (`SandboxNetworkUpdate` is documented as a "Subset of SandboxNetworkOpts"),
 * so there is no reason for them to diverge.
 */
function mapNetworkPolicy(network?: SandboxCreateOptions["network"]): E2BNetworkParams {
  if (network?.outbound === "open" && network.allowedDestinations?.length) {
    throw new Error("network.allowedDestinations is only valid when outbound is blocked");
  }
  const allowedDestinations = network?.allowedDestinations ?? [];
  const usesAllowlist = network?.outbound === "blocked" && allowedDestinations.length > 0;
  return {
    allowInternetAccess: network?.outbound !== "blocked" || usesAllowlist,
    network: usesAllowlist
      ? { denyOut: ["0.0.0.0/0"], allowOut: allowedDestinations }
      : undefined,
  };
}

/**
 * Typed error for an idle timeout E2B cannot enforce. E2B has exactly one
 * clock and it is absolute: the sandbox is killed when its timeout expires,
 * and only explicit client calls (create, connect, setTimeout) move that
 * deadline — never what the sandbox is or is not doing. An `idleTimeoutMs`
 * would therefore be silently ignored, so it is refused instead.
 */
export class E2BIdleTimeoutError extends Error {
  constructor() {
    super(
      "E2B has no idle timeout: its sandbox timeout is an ABSOLUTE lifetime that " +
        "in-sandbox activity never extends. Use `timeoutMs` for the lifetime, and " +
        "call setTimeout() to extend a sandbox you know is still working."
    );
    this.name = "E2BIdleTimeoutError";
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
  /**
   * E2B template ID. OPTIONAL: create() falls back to the provider's
   * configured `templateId`, then to "evolve-all" — declaring it required
   * contradicted that implementation and only went unnoticed because TS
   * method parameters are bivariant, so the SDK could already call
   * create({}) through the shared contract.
   */
  image?: string;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutMs?: number;
  /**
   * REJECTED with E2BIdleTimeoutError. E2B's timeout is an ABSOLUTE lifetime
   * that in-sandbox activity never extends, so there is no inactivity clock to
   * map this onto and honouring it would be a lie.
   */
  idleTimeoutMs?: number;
  workingDirectory?: string;
  /**
   * Per-sandbox compute sizing (cpu cores, memory GiB, disk GiB). E2B sizes
   * sandboxes at TEMPLATE BUILD time only (Template.build cpuCount/memoryMB;
   * disk is plan-fixed) — create-time sizing cannot be enforced, so any value
   * here is REJECTED with E2BResourcesError rather than silently ignored.
   * Bake sizing into the template the `image` names instead. `gpu`/`gpuTypes`
   * are rejected the same way: e2b offers no GPU allocation at any tier.
   */
  resources?: { cpu?: number; memory?: number; disk?: number; gpu?: number; gpuTypes?: string[] };
  network?: {
    outbound: "open" | "blocked";
    allowedDestinations?: string[];
  };
  /**
   * Every policy `updateNetwork()` may later be asked for on this box.
   *
   * ACCEPTED AND IGNORED HERE, deliberately. It exists because on modal the
   * create call decides whether switching is possible at all, and a box built
   * the blunt way can never be widened. E2B has no such constraint — it
   * switches freely at any time — so this changes nothing about the sandbox
   * it creates.
   *
   * Declared anyway so the option means the SAME thing in every provider
   * package: a caller reading these types must not conclude that E2B
   * cannot do phase switching because the option is missing here.
   */
  phaseNetworkPolicies?: Array<{
    outbound: "open" | "blocked";
    allowedDestinations?: string[];
  }>;
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

/**
 * A COMPLETE (or admittedly incomplete) enumeration of the project's fleet.
 *
 * `complete` is the load-bearing field. Callers that need a whole fleet —
 * orphan sweeps, lifecycle reconciliation — read a sandbox's ABSENCE from the
 * list as evidence it is gone, so a truncated page and a small fleet must never
 * be the same answer. `complete: false` means leave every row alone.
 */
export interface SandboxListPage {
  sandboxes: SandboxInfo[];
  complete: boolean;
  pagesFetched: number;
  error?: string;
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

  /** Replace the outbound network policy of the running sandbox. */
  updateNetwork(network: SandboxCreateOptions["network"]): Promise<void>;
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

  /** List sandboxes, paginating to exhaustion. `limit` bounds items returned. */
  list(options?: SandboxListOptions): Promise<SandboxInfo[]>;

  /** The same enumeration for fleet bookkeeping: never throws, reports completeness. */
  listAll(options?: SandboxListOptions): Promise<SandboxListPage>;
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
      // A TIMEOUT IS AN OUTCOME, NOT AN ABSENCE. E2B raises for an expired
      // command instead of returning a code, so a caller that treats a throw as
      // "could not observe the run" ends up with exit code 0 — a harness that
      // hung and emitted nothing then looks like a clean exit and gets SCORED
      // (reward 0) instead of reported as infrastructure. Daytona and Modal both
      // surface a nonzero code, so this was the one place the three providers
      // disagreed on what a timeout MEANS. 124 is the coreutils convention the
      // daytona path already produces in-box.
      if (isTimeoutError(err)) {
        return {
          exitCode: 124,
          stdout: "",
          stderr: err instanceof Error ? err.message : "command timed out",
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
          // A TIMEOUT IS AN OUTCOME, NOT AN ABSENCE. E2B raises for an expired
          // command instead of returning a code, so a caller that treats a throw as
          // "could not observe the run" ends up with exit code 0 — a harness that
          // hung and emitted nothing then looks like a clean exit and gets SCORED
          // (reward 0) instead of reported as infrastructure. Daytona and Modal both
          // surface a nonzero code, so this was the one place the three providers
          // disagreed on what a timeout MEANS. 124 is the coreutils convention the
          // daytona path already produces in-box.
          if (isTimeoutError(err)) {
            return {
              exitCode: 124,
              stdout: "",
              stderr: err instanceof Error ? err.message : "command timed out",
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
          // A TIMEOUT IS AN OUTCOME, NOT AN ABSENCE. E2B raises for an expired
          // command instead of returning a code, so a caller that treats a throw as
          // "could not observe the run" ends up with exit code 0 — a harness that
          // hung and emitted nothing then looks like a clean exit and gets SCORED
          // (reward 0) instead of reported as infrastructure. Daytona and Modal both
          // surface a nonzero code, so this was the one place the three providers
          // disagreed on what a timeout MEANS. 124 is the coreutils convention the
          // daytona path already produces in-box.
          if (isTimeoutError(err)) {
            return {
              exitCode: 124,
              stdout: "",
              stderr: err instanceof Error ? err.message : "command timed out",
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
    // Always read raw bytes and decide text-vs-binary from CONTENT, never
    // from the file's name: the SandboxFiles contract is "read returns
    // string | Uint8Array", and an extension table cannot keep that honest —
    // binary bytes under an unlisted extension (.bin) would ride a lossy
    // text decode and come back U+FFFD-mangled. A NUL byte marks binary (the
    // platform's agent-home sniff, git's own heuristic); everything else must
    // survive a STRICT UTF-8 decode (fatal, BOM preserved) to come back as a
    // string. Both answers are therefore byte-exact: a returned string
    // re-encodes to the identical bytes, a returned Uint8Array IS the bytes.
    // Long timeout: default 60s is too short for multi-MB downloads.
    const bytes = await this.sandbox.files.read(path, { format: "bytes", requestTimeoutMs: 300000, user: this.defaultUser });
    if (!bytes.includes(0)) {
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        // Not valid UTF-8 — binary after all.
      }
    }
    return bytes;
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

  /**
   * Upload a local file by PATH, streamed off disk with real backpressure.
   *
   * Why this does NOT go through files.write(): that method calls
   * `new Response(data).blob()` on whatever it is given, which MATERIALIZES the
   * body — measured at +463 MB RSS for a 200 MB source, whether the input is a
   * stream, a Buffer, or even a file-backed Blob. So handing it a stream looks
   * like streaming and is not, which is precisely the trap this method exists to
   * avoid: a caller uploading a large artifact once per concurrent task would
   * still pay the full size every time.
   *
   * Instead the multipart body is assembled as a ReadableStream and POSTed to
   * the signed upload URL with `duplex: "half"` — the same shape E2B's own
   * template-context upload uses. Verified to hold backpressure: against a
   * deliberately slow sink the producer had read 7 MB of a 200 MB file after
   * four seconds, rather than racing to the end.
   *
   * The wire format mirrors files.write()'s single-file case exactly: the
   * destination is the `path` query parameter of the signed URL, and the body is
   * one `file` part. If E2B ever changes that, the POST fails and we fall back to
   * the SDK's own (buffering) path — a correct upload beats a cheap one.
   */
  async writeFromPath(sandboxPath: string, localPath: string): Promise<void> {
    const { createReadStream, statSync } = await import("node:fs");
    const { Readable } = await import("node:stream");
    const { randomBytes } = await import("node:crypto");

    const size = statSync(localPath).size;
    const boundary = `----evolve${randomBytes(16).toString("hex")}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="blob"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

    async function* multipart(): AsyncGenerator<Buffer> {
      yield head;
      for await (const chunk of createReadStream(localPath)) {
        yield chunk as Buffer;
      }
      yield tail;
    }

    try {
      const url = await this.uploadUrl(sandboxPath);
      const response = await fetch(url, {
        method: "POST",
        body: Readable.toWeb(Readable.from(multipart())) as ReadableStream<Uint8Array>,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(head.length + size + tail.length),
        },
        // Node/undici requires this to send a request body as a stream.
        duplex: "half",
      } as RequestInit);
      if (!response.ok) {
        throw new Error(
          `streamed upload to ${sandboxPath} failed (HTTP ${response.status})`
        );
      }
    } catch (error) {
      console.warn(
        `[e2b] streamed upload of ${localPath} failed, falling back to a buffered write:`,
        error instanceof Error ? error.message : error
      );
      const web = Readable.toWeb(
        createReadStream(localPath)
      ) as ReadableStream<Uint8Array>;
      await this.writeStream(sandboxPath, web);
    }
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

  /**
   * Replace the running sandbox's outbound policy — E2B's
   * `Sandbox.updateNetwork`: "Update the network configuration of the sandbox.
   * Replaces the current egress configuration atomically — fields that are
   * omitted are cleared on the server." (from the published e2b 2.26.0+ type
   * declarations for Sandbox.updateNetwork).
   *
   * That "omitted fields are cleared" rule is why the whole policy is sent
   * every time and never a delta: mapNetworkPolicy always states
   * allowInternetAccess, and states `network` only when an allowlist is in
   * force — so switching from an allowlist to a sealed box clears the
   * allowlist by the server's own rule rather than by a second call that could
   * fail in between and leave the box half-switched.
   *
   * VERSION GATE. `updateNetwork` landed in e2b 2.26.0; the client resolved in
   * this workspace today is older and has no such method. Feature-detected
   * rather than assumed, and refused loudly when absent — a `catch` around a
   * missing method, or an early return, would leave the sandbox on its
   * previous policy while the caller believes the switch happened.
   */
  async updateNetwork(network: SandboxCreateOptions["network"]): Promise<void> {
    const params = mapNetworkPolicy(network);
    const sandbox = this.sandbox as unknown as {
      updateNetwork?: (update: {
        allowOut?: string[];
        denyOut?: string[];
        allowInternetAccess?: boolean;
      }) => Promise<void>;
    };
    if (typeof sandbox.updateNetwork !== "function") {
      throw new E2BNetworkUpdateUnsupportedError(
        `The installed e2b client cannot change a running sandbox's network policy: ` +
          `Sandbox.updateNetwork requires e2b >= ${E2B_MIN_UPDATE_NETWORK_VERSION}. ` +
          "Upgrade the e2b dependency (it is pulled in by @e2b/code-interpreter), or create the " +
          "sandbox with the policy it needs for its whole lifetime."
      );
    }
    await sandbox.updateNetwork({
      allowInternetAccess: params.allowInternetAccess,
      ...(params.network ?? {}),
    });
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
  readonly name = "E2B";
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
    if (options.idleTimeoutMs !== undefined) {
      // Provider law: reject what cannot be enforced, never silently ignore.
      // E2B's only clock is an absolute lifetime — the timeout set at create (or
      // extended by setTimeout/connect) kills the sandbox when it expires, and
      // nothing about what the box is doing moves it. There is no inactivity
      // knob to map this onto.
      throw new E2BIdleTimeoutError();
    }
    if (
      options.resources?.gpu !== undefined ||
      options.resources?.gpuTypes !== undefined
    ) {
      // Not "no create-time knob" — NO knob at all: e2b offers no GPU
      // allocation at any tier (neither Template.build nor Sandbox.create
      // takes one). Distinct message so callers don't go hunting for a
      // template-build GPU option that does not exist.
      throw new E2BResourcesError(
        "E2B offers no GPU allocation at any tier — a `resources.gpu` request cannot be " +
          "enforced. Run GPU workloads on a provider that reserves GPUs (modal)."
      );
    }
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
    // Every DECLARED phase policy is mapped here too, and its result thrown
    // away: mapping is what rejects a destination this provider cannot express,
    // and a phase policy that only gets mapped at switch time fails with the
    // box up and the agent waiting. Upstream validates the baseline and every
    // phase policy at start for the same reason (harbor
    // environments/base.py:832-836).
    for (const phase of options.phaseNetworkPolicies ?? []) {
      mapNetworkPolicy(phase);
    }
    const networkParams = mapNetworkPolicy(options.network);

    // Map generic 'image' to E2B's 'templateId'
    const sandbox = await E2BSandbox.create(templateId, {
      apiKey: this.apiKey,
      apiUrl: this.apiUrl,
      envs: options.envs,
      metadata: options.metadata,
      timeoutMs,
      ...networkParams,
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

  /**
   * List sandboxes, walking every page.
   *
   * This used to call `nextItems()` exactly once and return whatever the first
   * page held — an account with more than E2B_MAX_PAGE_SIZE sandboxes was
   * silently truncated, and nothing in the return value said so. That is a
   * correctness bug rather than a performance one for any caller that reads
   * absence from the list as "this sandbox is gone".
   *
   * `limit` still means what a caller expects: stop after this many ITEMS, so
   * an explicit limit remains a cost bound. The per-request page size is capped
   * separately at E2B_MAX_PAGE_SIZE because E2B rejects anything larger
   * outright (`400 validation error: parameter "limit" ... must be at most
   * 100`), so a caller asking for 500 gets five requests, not one refusal.
   */
  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    const page = await this.paginate(options);
    // A walk that stopped on the caller's own limit is not a failure — the
    // caller asked for a sample and got one. Only a walk that could not finish
    // is an exception here; `listAll` is where the distinction is reported
    // rather than thrown.
    if (page.error && !page.stoppedAtLimit) throw new Error(page.error);
    return page.sandboxes;
  }

  /**
   * The fleet-bookkeeping enumeration: same walk, never throws.
   *
   * The distinction from `list()` is what a failure MEANS to the caller. An
   * orphan sweep treats a missing sandbox as a terminated one, so it must be
   * able to tell "the project has no sandboxes" from "the enumeration stopped
   * early" — and an exception it catches and turns into an empty array erases
   * exactly that difference.
   */
  async listAll(options?: SandboxListOptions): Promise<SandboxListPage> {
    const { stoppedAtLimit: _stoppedAtLimit, ...page } = await this.paginate(options);
    return page;
  }

  private async paginate(
    options?: SandboxListOptions,
  ): Promise<SandboxListPage & { stoppedAtLimit: boolean }> {
    const wanted = options?.limit;
    return collectSandboxPages(
      E2BSandbox.list({
        apiKey: this.apiKey,
        apiUrl: this.apiUrl,
        query: {
          state: options?.state,
          metadata: options?.metadata,
        },
        limit: wanted === undefined ? E2B_MAX_PAGE_SIZE : Math.min(wanted, E2B_MAX_PAGE_SIZE),
      } as Parameters<typeof E2BSandbox.list>[0]),
      wanted,
    );
  }
}

/** The paginator surface this walk needs — E2B's SandboxPaginator satisfies it. */
export interface E2BSandboxPaginator {
  readonly hasNext: boolean;
  readonly nextToken?: string;
  nextItems(): Promise<
    Array<{
      sandboxId: string;
      templateId: string;
      name?: string;
      metadata?: Record<string, string>;
      startedAt: unknown;
      endAt?: unknown;
    }>
  >;
}

/**
 * Drain a paginator into one answer, with an honest completeness verdict.
 *
 * Separate from the provider because everything worth getting wrong lives here
 * and none of it needs a network: the two ways a walk can fail to terminate,
 * the difference between "the caller asked for ten" and "the provider ran out",
 * and the rule that a failure mid-walk yields the sandboxes seen so far marked
 * INCOMPLETE rather than either an exception or a short complete list.
 *
 * Exported for its test (`_testCollectSandboxPages`).
 */
async function collectSandboxPages(
  paginator: E2BSandboxPaginator,
  wanted?: number,
): Promise<SandboxListPage & { stoppedAtLimit: boolean }> {
  const sandboxes: SandboxInfo[] = [];
  let pagesFetched = 0;
  // Pagination tokens come off the wire, so a server that repeats one would
  // spin here forever. This guard and the page ceiling both end the walk as
  // INCOMPLETE rather than returning a short answer that reads as a whole fleet.
  const seenTokens = new Set<string>();

  while (paginator.hasNext) {
    if (pagesFetched >= E2B_MAX_LIST_PAGES) {
      return {
        sandboxes,
        complete: false,
        pagesFetched,
        stoppedAtLimit: false,
        error: `sandbox list exceeded ${E2B_MAX_LIST_PAGES} pages`,
      };
    }
    const token = paginator.nextToken;
    if (token !== undefined) {
      if (seenTokens.has(token)) {
        return {
          sandboxes,
          complete: false,
          pagesFetched,
          stoppedAtLimit: false,
          error: "pagination token repeated",
        };
      }
      seenTokens.add(token);
    }

    let items: Awaited<ReturnType<E2BSandboxPaginator["nextItems"]>>;
    try {
      items = await paginator.nextItems();
    } catch (err) {
      return {
        sandboxes,
        complete: false,
        pagesFetched,
        stoppedAtLimit: false,
        error: `sandbox list failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    pagesFetched += 1;

    for (const item of items) {
      // BOUND CHECKED BEFORE THE PUSH, not after. Checked after, `limit: 0`
      // returns one sandbox — the loop pushes, then discovers it was already
      // over. "Give me none" is a strange request but it has an obvious right
      // answer, and off-by-one on a bound is not the kind of thing to leave to
      // whether a caller ever passes zero.
      if (wanted !== undefined && sandboxes.length >= wanted) {
        // STOPPING ON THE CALLER'S LIMIT IS NOT COMPLETION. There is at least
        // one more sandbox here — we are holding it — so this fleet was
        // truncated, and a caller that reads absence as death must be told.
        // Reporting this as complete is what made the flag useless at its only
        // real consumer, which always passes a limit.
        return {
          sandboxes,
          complete: false,
          pagesFetched,
          stoppedAtLimit: true,
          error: `stopped at the requested limit of ${wanted} with more sandboxes available`,
        };
      }
      sandboxes.push({
        sandboxId: item.sandboxId,
        image: item.templateId,  // E2B calls it templateId, we expose as image
        name: item.name,
        metadata: item.metadata ?? {},
        startedAt: toISOString(item.startedAt),
        endAt: item.endAt ? toISOString(item.endAt) : undefined,
      });
    }

    // The limit landed exactly on the end of a page: whether that was the whole
    // fleet is the paginator's answer, not ours.
    if (wanted !== undefined && sandboxes.length >= wanted && paginator.hasNext) {
      return {
        sandboxes,
        complete: false,
        pagesFetched,
        stoppedAtLimit: true,
        error: `stopped at the requested limit of ${wanted} with more sandboxes available`,
      };
    }
    if (wanted !== undefined && sandboxes.length >= wanted) break;
  }

  return { sandboxes, complete: true, pagesFetched, stoppedAtLimit: false };
}

export const _testCollectSandboxPages = collectSandboxPages;

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

/**
 * TYPE-ONLY handle on the concrete sandbox class, for the contract-conformance
 * seam. create() is declared to return the local SandboxInstance INTERFACE, so
 * a seam reading create()'s return type checks the interface and never the
 * class — which let a narrowed method on the class pass unnoticed. Exporting
 * the type (never the constructor) gives the seam the real methods to pin.
 */
export type _testE2BSandboxImpl = E2BSandboxImpl;

