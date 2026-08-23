/**
 * Managed Modal transport — SandboxProvider over the Dashboard's Modal door.
 *
 * Modal is the one provider whose upstream protocol cannot ride an apiUrl
 * swap: its control plane is gRPC/protobuf, so the managed door is not a
 * proxy but an operation-keyed HTTP API the Dashboard serves itself, with
 * platform-held Modal credentials behind it. This class is that API's client,
 * mapping the SDK's SandboxProvider contract 1:1 onto the door's routes.
 *
 * THE WIRE, restating the door's own contract (app/api/managed/modal in the
 * Dashboard — the door rules, this transport follows). Every request carries
 * `Authorization: Bearer <Evolve API key>`; every request body is ONE JSON
 * object capped at 1 MiB of wire bytes; every error body is JSON `{ error }`.
 * Base = /api/managed/modal.
 *
 * Control plane:
 *   create   POST   {base}/sandboxes                JSON {image?, timeoutMs?,
 *            workingDirectory?, envs?, metadata?} → 201 {sandboxId, image,
 *            metadata, startedAt}
 *   list     GET    {base}/sandboxes              → 200 {sandboxes: [...]}
 *   get      GET    {base}/sandboxes/{id}         → 200 {sandboxId, image,
 *            metadata, startedAt}; a stopped or killed sandbox is 404 — Modal
 *            itself keeps describing terminated boxes, so the door answers
 *            from its own ownership record, and that 404 is what flips
 *            isRunning() to false
 *   kill     DELETE {base}/sandboxes/{id}         → 204
 *   exec     POST   {base}/sandboxes/{id}/exec      JSON {command, cwd?,
 *            envs?, timeoutMs?} → 200 NDJSON stream: one {stream: "stdout" |
 *            "stderr", data} record per output chunk as the command produces
 *            it, then one terminal record — {exitCode} on completion, or
 *            {error} if the upstream run failed after the stream had begun.
 *            The door bounds each command's duration (60 min default, 120 min
 *            ceiling) and REJECTS a longer timeoutMs with a 400 naming the
 *            bound — never a silent clamp.
 *
 * File plane — POST-only, path IN the JSON body (never a query string, so
 * file paths stay out of access logs), base64 as the binary carrier:
 *   read       POST {base}/sandboxes/{id}/files/read       {path}
 *              → 200 {content, encoding: "utf8" | "base64"} — the door says
 *              which carrier it chose (decided from the bytes themselves,
 *              never the file's extension); either way the caller rebuilds
 *              the exact bytes
 *   write      POST {base}/sandboxes/{id}/files/write      {path, content,
 *              encoding?: "base64"} → 204
 *   writeBatch POST {base}/sandboxes/{id}/files/writeBatch {files: [{path,
 *              content, encoding?}]} → 204
 *   makeDir    POST {base}/sandboxes/{id}/files/makeDir    {path} → 204
 *              (mkdir -p semantics)
 * The door's 1 MiB body cap is the write bound; the transport refuses a
 * larger write HERE, with a typed error, before a byte is sent.
 * No username travels on the file plane: the door executes every operation as
 * its provider's default sandbox user, exactly as its exec operation does.
 *
 * DEGRADATIONS, named rather than papered over:
 *  - spawn() is the same exec fired without awaiting: the door has no
 *    background-process verb, so wait() resolves when the exec stream ends
 *    and the door's command-duration ceiling bounds every command.
 *  - interrupt() cannot stop a running command: spawn's handle.kill() answers
 *    false, because neither Modal nor the door has kill-by-pid for a live
 *    exec (the direct Modal provider degrades identically).
 *  - getHost() and pause() throw: the door serves no tunnels, and Modal has
 *    no pause anywhere (the direct provider throws the same way).
 */

import type {
  FileInfo,
  ProcessInfo,
  SandboxCommandHandle,
  SandboxCommandResult,
  SandboxCommands,
  SandboxCreateOptions,
  SandboxFiles,
  SandboxInfo,
  SandboxInstance,
  SandboxListOptions,
  SandboxListPage,
  SandboxProvider,
  SandboxRunOptions,
  SandboxSpawnOptions,
} from "../types";

/** The door's request-body cap: 1 MiB of wire bytes, JSON included. */
const MANAGED_MODAL_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Typed refusal for a file write the door would answer 413. Thrown BEFORE the
 * request is sent — provider law: reject what the door cannot carry, never
 * ship a payload whose refusal the caller only meets as a transport error.
 */
export class ManagedModalWriteLimitError extends Error {
  /** Serialized request size that broke the bound, in bytes. */
  readonly bytes: number;

  constructor(operation: string, bytes: number) {
    super(
      `Managed Modal ${operation} body is ${bytes} bytes; the managed door caps every ` +
        `request at ${MANAGED_MODAL_MAX_BODY_BYTES} bytes (1 MiB) of wire bytes, base64 ` +
        "inflation included. Split the payload into smaller writes.",
    );
    this.name = "ManagedModalWriteLimitError";
    this.bytes = bytes;
  }
}

function toUint8(content: string | Buffer | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return new Uint8Array(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  throw new Error(`Unsupported data type: ${typeof content}`);
}

interface ManagedModalConfig {
  /** The Evolve API key; the door authenticates it, never Modal. */
  apiKey: string;
  /** The door's base URL (getManagedProviderUrl("modal")). */
  baseUrl: string;
}

/** One fetch seam for the whole transport, with the door's error body surfaced. */
class ManagedModalDoor {
  constructor(private readonly config: ManagedModalConfig) {}

  async request(operation: string, path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      let detail = "";
      try {
        const payload = (await response.json()) as { error?: string };
        detail = payload?.error ?? "";
      } catch {
        // A non-JSON error body still yields the status line below.
      }
      throw new Error(
        `Managed Modal ${operation} failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return response;
  }

  json(body: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }
}

/** One NDJSON record on the exec stream — an output chunk or the terminal verdict. */
interface ManagedModalExecRecord {
  stream?: string;
  data?: string;
  exitCode?: number;
  error?: string;
}

class ManagedModalCommands implements SandboxCommands {
  constructor(private readonly door: ManagedModalDoor, private readonly sandboxId: string) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    const response = await this.door.request(
      "exec",
      `/sandboxes/${encodeURIComponent(this.sandboxId)}/exec`,
      this.door.json({
        command,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.envs ? { envs: options.envs } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      }),
    );

    // Streamed delivery: the door flushes an NDJSON record per output chunk
    // the moment the command produces it — those flowing bytes are also what
    // keeps a long exec's HTTP connection alive — then one terminal record.
    let stdout = "";
    let stderr = "";
    let terminal: ManagedModalExecRecord | undefined;
    const consume = (line: string) => {
      if (!line.trim()) return;
      let record: ManagedModalExecRecord;
      try {
        record = JSON.parse(line) as ManagedModalExecRecord;
      } catch {
        throw new Error(`Managed Modal exec stream carried a garbled record: ${line}`);
      }
      if (record.stream === "stdout" && typeof record.data === "string") {
        stdout += record.data;
        options?.onStdout?.(record.data);
      } else if (record.stream === "stderr" && typeof record.data === "string") {
        stderr += record.data;
        options?.onStderr?.(record.data);
      } else {
        terminal = record;
      }
    };

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) !== -1) {
          consume(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
        }
      }
      buffered += decoder.decode();
      consume(buffered);
    } else {
      for (const line of (await response.text()).split("\n")) consume(line);
    }

    // The status was committed at 200 when the stream opened, so an upstream
    // failure after that can only arrive as the terminal record — and a
    // stream that ends with NO terminal record is a connection that died
    // mid-run, which must never be mistaken for a completed command.
    if (terminal?.error !== undefined) {
      throw new Error(`Managed Modal exec failed: ${terminal.error}`);
    }
    if (typeof terminal?.exitCode !== "number") {
      throw new Error(
        "Managed Modal exec stream ended without a terminal record — the connection died mid-run.",
      );
    }
    return { exitCode: terminal.exitCode, stdout, stderr };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    // The same exec, fired now and awaited in wait() — there is no background
    // process verb on the door, so the exec stream IS the process handle.
    const pending = this.run(command, options);
    // A rejection nobody has awaited yet must not crash the process; wait()
    // re-surfaces it to whoever asks.
    pending.catch(() => {});
    return {
      processId: `managed-modal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      wait: () => pending,
      // Same answer as the direct Modal provider's spawn handle: Modal exposes
      // no kill-by-pid for an exec, and neither does the door.
      kill: async () => false,
    };
  }

  async list(): Promise<ProcessInfo[]> {
    // Same command (and parse) the direct Modal provider runs.
    const result = await this.run("ps -eo pid,comm,args");
    const lines = result.stdout.trim().split("\n").slice(1);
    return lines
      .filter((line) => line.trim())
      .map((line) => {
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
    // The pid rides a shell command line, so only a literal pid may pass.
    if (!/^\d+$/.test(processId)) return false;
    const result = await this.run(`kill -9 ${processId}`);
    return result.exitCode === 0;
  }
}

class ManagedModalFiles implements SandboxFiles {
  constructor(private readonly door: ManagedModalDoor, private readonly sandboxId: string) {}

  private filesPath(operation: string): string {
    return `/sandboxes/${encodeURIComponent(this.sandboxId)}/files/${operation}`;
  }

  /** Strings ride as-is (utf8, the door's default); bytes ride base64. */
  private encodeContent(
    data: string | Buffer | ArrayBuffer | Uint8Array,
  ): { content: string; encoding?: "base64" } {
    if (typeof data === "string") return { content: data };
    return { content: Buffer.from(toUint8(data)).toString("base64"), encoding: "base64" };
  }

  /** door.json plus the pre-send refusal of anything the door would 413. */
  private boundedJson(operation: string, body: unknown): RequestInit {
    const init = this.door.json(body);
    const bytes = Buffer.byteLength(init.body as string, "utf8");
    if (bytes > MANAGED_MODAL_MAX_BODY_BYTES) {
      throw new ManagedModalWriteLimitError(operation, bytes);
    }
    return init;
  }

  async read(path: string): Promise<string | Uint8Array> {
    const response = await this.door.request(
      "file read",
      this.filesPath("read"),
      this.door.json({ path }),
    );
    const payload = (await response.json()) as { content?: string; encoding?: string };
    // The door decides text-vs-binary (it holds the provider, which sniffs
    // the CONTENT — never the extension) and reports which carrier it chose;
    // the transport just rebuilds the exact bytes.
    if (payload.encoding === "base64") {
      return new Uint8Array(Buffer.from(payload.content ?? "", "base64"));
    }
    return payload.content ?? "";
  }

  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    await this.door.request(
      "file write",
      this.filesPath("write"),
      this.boundedJson("file write", { path, ...this.encodeContent(content) }),
    );
  }

  async writeBatch(
    files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>,
  ): Promise<void> {
    if (files.length === 0) return;
    await this.door.request(
      "file writeBatch",
      this.filesPath("writeBatch"),
      this.boundedJson("file writeBatch", {
        files: files.map((file) => ({ path: file.path, ...this.encodeContent(file.data) })),
      }),
    );
  }

  async makeDir(path: string): Promise<void> {
    // mkdir -p semantics on the door side — the provider's own contract.
    await this.door.request("makeDir", this.filesPath("makeDir"), this.door.json({ path }));
  }
}

interface ManagedModalSandboxPayload {
  sandboxId: string;
  image?: string;
  metadata?: Record<string, string>;
  startedAt?: string;
}

function toSandboxInfo(payload: ManagedModalSandboxPayload): SandboxInfo {
  return {
    sandboxId: payload.sandboxId,
    image: payload.image ?? "",
    metadata: payload.metadata ?? {},
    startedAt: payload.startedAt ?? "",
  };
}

class ManagedModalSandbox implements SandboxInstance {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;

  constructor(
    private readonly door: ManagedModalDoor,
    readonly sandboxId: string,
  ) {
    this.commands = new ManagedModalCommands(door, sandboxId);
    this.files = new ManagedModalFiles(door, sandboxId);
  }

  async getHost(_port: number): Promise<string> {
    throw new Error(
      "Managed Modal sandboxes expose no tunnels, so getHost() is unavailable through the managed door.",
    );
  }

  async kill(): Promise<void> {
    try {
      await this.door.request(
        "kill",
        `/sandboxes/${encodeURIComponent(this.sandboxId)}`,
        { method: "DELETE" },
      );
    } catch (err) {
      // A box already gone IS the outcome kill asks for.
      if (err instanceof Error && err.message.includes("(404)")) return;
      throw err;
    }
  }

  async pause(): Promise<void> {
    throw new Error(
      "Modal does not support pause/resume. Persist progress with Evolve checkpoints " +
        "and resume in a fresh sandbox, or use kill() to terminate.",
    );
  }

  async isRunning(): Promise<boolean> {
    try {
      await this.getInfo();
      return true;
    } catch (err) {
      if (err instanceof Error && err.message.includes("(404)")) return false;
      throw err;
    }
  }

  async getInfo(): Promise<SandboxInfo> {
    const response = await this.door.request(
      "get",
      `/sandboxes/${encodeURIComponent(this.sandboxId)}`,
      { method: "GET" },
    );
    return toSandboxInfo((await response.json()) as ManagedModalSandboxPayload);
  }
}

export class ManagedModalProvider implements SandboxProvider {
  readonly providerType = "modal" as const;
  readonly name = "Managed Modal";
  private readonly door: ManagedModalDoor;

  constructor(config: ManagedModalConfig) {
    this.door = new ManagedModalDoor(config);
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    // Provider law: reject what the door cannot carry, never silently drop it.
    // The create body is image/timeoutMs/workingDirectory/envs/metadata — a
    // request the door would ignore must fail here, not look honored.
    if (options.resources !== undefined) {
      throw new Error(
        "Managed Modal sandboxes are platform-sized; `resources` cannot be enforced through the managed door.",
      );
    }
    if (options.network !== undefined) {
      throw new Error(
        "Managed Modal sandboxes run the platform's network policy; `network` cannot be enforced through the managed door.",
      );
    }
    if (options.user !== undefined) {
      throw new Error(
        "Managed Modal sandboxes run as the platform's sandbox user; `user` cannot be enforced through the managed door.",
      );
    }
    if (options.idleTimeoutMs !== undefined) {
      throw new Error(
        "The managed Modal door takes no idle timeout; bound the sandbox with `timeoutMs` instead.",
      );
    }
    if (options.bootCommand !== undefined) {
      throw new Error(
        "Managed Modal sandboxes boot the platform image as configured; `bootCommand` cannot be enforced through the managed door.",
      );
    }

    const response = await this.door.request(
      "create",
      "/sandboxes",
      this.door.json({
        ...(options.image ? { image: options.image } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
        ...(options.envs ? { envs: options.envs } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      }),
    );
    const payload = (await response.json()) as ManagedModalSandboxPayload;
    return new ManagedModalSandbox(this.door, payload.sandboxId);
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    // The get operation is the existence/ownership check — an unknown or
    // unowned id fails here rather than on the first file op.
    const sandbox = new ManagedModalSandbox(this.door, sandboxId);
    await sandbox.getInfo();
    return sandbox;
  }

  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    // Modal has no paused state; a filter that excludes "running" matches
    // nothing (same rule as the direct provider), and costs no request.
    if (options?.state && !options.state.includes("running")) return [];

    const response = await this.door.request("list", "/sandboxes", { method: "GET" });
    const payload = (await response.json()) as { sandboxes?: ManagedModalSandboxPayload[] };
    let sandboxes = (payload.sandboxes ?? []).map(toSandboxInfo);
    if (options?.metadata) {
      const wanted = Object.entries(options.metadata);
      sandboxes = sandboxes.filter((sandbox) =>
        wanted.every(([key, value]) => sandbox.metadata[key] === value),
      );
    }
    if (options?.limit !== undefined) sandboxes = sandboxes.slice(0, options.limit);
    return sandboxes;
  }

  /**
   * The fleet-bookkeeping enumeration: never throws, reports completeness.
   * The door assembles the caller's whole owned fleet in ONE answer, so
   * `complete: false` here means either a `limit` that stopped short of that
   * fleet, or a door that could not be asked at all.
   */
  async listAll(options?: SandboxListOptions): Promise<SandboxListPage> {
    if (options?.state && !options.state.includes("running")) {
      return { sandboxes: [], complete: true, pagesFetched: 0 };
    }
    let fleet: SandboxInfo[];
    try {
      fleet = await this.list({ ...options, limit: undefined });
    } catch (err) {
      return {
        sandboxes: [],
        complete: false,
        pagesFetched: 0,
        error: `sandbox list failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const sandboxes = options?.limit !== undefined ? fleet.slice(0, options.limit) : fleet;
    const truncated = sandboxes.length < fleet.length;
    return {
      sandboxes,
      complete: !truncated,
      pagesFetched: 1,
      ...(truncated
        ? { error: `stopped at the requested limit of ${options?.limit} with more sandboxes available` }
        : {}),
    };
  }
}

// ============================================================
// TEST-ONLY EXPORTS
// ============================================================

/** An instance without the connect round trip, for wire-shape tests. */
export const _testManagedModalSandbox = (
  config: ManagedModalConfig,
  sandboxId: string,
): SandboxInstance => new ManagedModalSandbox(new ManagedModalDoor(config), sandboxId);
