/**
 * Managed Modal transport — SandboxProvider over the Dashboard's Modal door.
 *
 * Modal is the one provider whose upstream protocol cannot ride an apiUrl
 * swap: its control plane is gRPC/protobuf, so the managed door is not a
 * proxy but an operation-keyed HTTP API the Dashboard serves itself, with
 * platform-held Modal credentials behind it. This class is that API's client,
 * mapping the SDK's SandboxProvider contract 1:1 onto the door's routes.
 *
 * THE WIRE, stated here because the Dashboard's twin routes are built against
 * this exact contract. Every request carries `Authorization: Bearer <Evolve
 * API key>`; every error body is JSON `{ error }`. Base = /api/managed/modal.
 *
 * Control plane (the door's original five operations):
 *   create   POST   {base}/sandboxes                JSON {image?, timeoutMs?,
 *            workingDirectory?, envs?, metadata?} → 201 {sandboxId, image,
 *            metadata, startedAt}
 *   list     GET    {base}/sandboxes              → 200 {sandboxes: [...]}
 *   get      GET    {base}/sandboxes/{id}         → 200 {sandboxId, image,
 *            metadata, startedAt}
 *   kill     DELETE {base}/sandboxes/{id}         → 204
 *   exec     POST   {base}/sandboxes/{id}/exec      JSON {command, cwd?,
 *            envs?, timeoutMs?} → 200 {exitCode, stdout, stderr}
 *
 * File plane (the twin routes) — the wire shapes are E2B's envd file surface
 * verbatim, so the two managed file planes speak one language:
 *   read     GET  {base}/sandboxes/{id}/files?path=<abs> → 200 raw bytes
 *   write    POST {base}/sandboxes/{id}/files?path=<abs>
 *            multipart/form-data, ONE part, field name "file"; the part body
 *            is written to the `path` query → 200 JSON [{name, type, path}]
 *   batch    POST {base}/sandboxes/{id}/files   (no `path` query)
 *            multipart/form-data, one part PER FILE, field name "file", part
 *            FILENAME = absolute destination path → 200 JSON [{...}, ...]
 *   makeDir  POST {base}/sandboxes/{id}/filesystem.Filesystem/MakeDir
 *            JSON {"path": <abs>} → 200 JSON {}  (mkdir -p semantics)
 * No username travels on the file plane: the door executes every operation as
 * its provider's default sandbox user, exactly as its exec operation does.
 *
 * DEGRADATIONS, named rather than papered over:
 *  - exec is buffered, not streamed: onStdout/onStderr fire once, with the
 *    whole output, when the command completes. spawn() is the same exec fired
 *    without awaiting, so wait() resolves on HTTP completion and the door's
 *    exec time cap bounds every command.
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

/** Same table the providers use to decide read()'s return shape. */
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
    const result = (await response.json()) as SandboxCommandResult;
    // Buffered delivery: the door's exec answers once, with everything.
    if (result.stdout) options?.onStdout?.(result.stdout);
    if (result.stderr) options?.onStderr?.(result.stderr);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    // The same exec, fired now and awaited in wait() — there is no background
    // process verb on the door, so the HTTP call IS the process handle.
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

  private filesPath(query?: string): string {
    return `/sandboxes/${encodeURIComponent(this.sandboxId)}/files${query ?? ""}`;
  }

  async read(path: string): Promise<string | Uint8Array> {
    const response = await this.door.request(
      "file read",
      this.filesPath(`?path=${encodeURIComponent(path)}`),
      { method: "GET" },
    );
    if (isBinaryFile(path)) return new Uint8Array(await response.arrayBuffer());
    return response.text();
  }

  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    // The envd single-file shape: destination in the query, one anonymous part.
    const form = new FormData();
    form.append("file", new Blob([toUint8(content) as BlobPart]));
    await this.door.request("file write", this.filesPath(`?path=${encodeURIComponent(path)}`), {
      method: "POST",
      body: form,
    });
  }

  async writeBatch(
    files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>,
  ): Promise<void> {
    if (files.length === 0) return;
    // The envd batch shape: no query, each part's FILENAME is its destination.
    const form = new FormData();
    for (const file of files) {
      form.append("file", new Blob([toUint8(file.data) as BlobPart]), file.path);
    }
    await this.door.request("file writeBatch", this.filesPath(), { method: "POST", body: form });
  }

  async makeDir(path: string): Promise<void> {
    // The envd RPC shape, mkdir -p semantics on the door side.
    await this.door.request(
      "makeDir",
      `/sandboxes/${encodeURIComponent(this.sandboxId)}/filesystem.Filesystem/MakeDir`,
      this.door.json({ path }),
    );
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
