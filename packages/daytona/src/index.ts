/**
 * Daytona Sandbox Provider
 *
 * @requires @daytonaio/sdk >= 0.134.0
 *
 * Design principles:
 * - Mirror E2B provider interface for SDK compatibility
 * - Uses public Docker images via IMAGE_MAP
 * - Parallel structure to E2B provider
 *
 * Daytona-specific notes:
 * - Network policy maps to Daytona's networkBlockAll / networkAllowList,
 *   enforced by kernel iptables on the runner. The allowlist is IPv4 CIDR
 *   ONLY (max 10 entries, DAYTONA_MAX_NETWORK_ALLOWLIST). Hostname
 *   destinations are pinned to their IPv4 addresses by a DNS lookup at
 *   create time — see the DNS-ROTATION CAVEAT on SandboxCreateOptions.network.
 *   Destinations Daytona can never enforce (wildcards, IPv6, unresolvable
 *   hostnames, >10 CIDRs) throw DaytonaNetworkPolicyError instead of
 *   silently weakening the policy.
 * - The `user` option is a CREATE-TIME OS user (Daytona's osUser field);
 *   there is no per-exec user switch — the Daytona daemon runs commands as
 *   the container's user (governed by the image's USER directive; default
 *   images use "daytona" with passwordless sudo). `user: "root"` keeps the
 *   image's default user and elevates every command through a `sudo -n`
 *   wrapper instead (mirrors the Modal provider's su wrapper). File
 *   operations always go through the Daytona daemon and are NOT elevated.
 * - Private registry images (AWS ECR, GHCR, GCP Artifact Registry, ...)
 *   require registry credentials pre-registered in the Daytona dashboard
 *   (Registries page) — Daytona has no per-call image pull secret. Pull
 *   failures for such images throw DaytonaImagePullError.
 * - getInfo()/list() report the API's real createdAt timestamp (never a
 *   fabricated client-side date); Daytona exposes no end timestamp, so
 *   endAt is always undefined.
 */

import { Daytona, Image } from "@daytonaio/sdk";
import type { Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import { resolve4 } from "node:dns/promises";

// ============================================================
// CONSTANTS
// ============================================================

/** Map generic image names to Daytona Docker images */
const IMAGE_MAP: Record<string, string> = {
  "evolve-all": "evolvingmachines/evolve-all",
};

/**
 * Daytona's hard cap on network allowlist size (validated server-side too).
 * Policies that resolve to more CIDRs throw DaytonaNetworkPolicyError.
 */
export const DAYTONA_MAX_NETWORK_ALLOWLIST = 10;

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

// ============================================================
// TYPED ERRORS
// ============================================================

/** Why a network policy cannot be enforced by Daytona. */
export type DaytonaNetworkPolicyReason =
  | "wildcard-hostname"
  | "ipv6-unsupported"
  | "port-unsupported"
  | "invalid-ipv4"
  | "unresolvable-hostname"
  | "allowlist-too-large";

/**
 * Typed error for network policies Daytona cannot enforce.
 *
 * Daytona's allowlist is kernel-level IPv4 CIDR filtering only (max 10
 * entries) — no DNS/domain layer. Anything that cannot be pinned to stable
 * IPv4 CIDRs at create time is rejected loudly instead of silently
 * weakening the sandbox's egress policy.
 */
export class DaytonaNetworkPolicyError extends Error {
  readonly reason: DaytonaNetworkPolicyReason;
  /** The offending destination (absent for list-level violations). */
  readonly destination?: string;

  constructor(reason: DaytonaNetworkPolicyReason, message: string, destination?: string) {
    super(message);
    this.name = "DaytonaNetworkPolicyError";
    this.reason = reason;
    this.destination = destination;
  }
}

/**
 * Typed error for image pull failures on private registries.
 *
 * Daytona has no per-call image pull secret: credentials for private
 * registries (AWS ECR, GHCR, GCP Artifact Registry, private Docker Hub)
 * must be pre-registered in the Daytona dashboard BEFORE creating the
 * sandbox (dashboard → Registries → Add Registry).
 */
export class DaytonaImagePullError extends Error {
  /** The image reference that failed to pull. */
  readonly image: string;

  constructor(image: string, cause?: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause ?? "unknown error");
    super(
      `Failed to pull image "${image}" on Daytona: ${causeMsg}. ` +
        "Private registry images (e.g. AWS ECR) require registry credentials pre-registered in the " +
        "Daytona dashboard (Registries page) before sandbox creation — Daytona has no per-call image " +
        "pull secret. Register the registry at https://app.daytona.io, then retry. " +
        "Also ensure the image is linux/amd64 and pinned to a tag or digest (floating tags like " +
        "\"latest\" are rejected by Daytona's snapshot builder)."
    );
    this.name = "DaytonaImagePullError";
    this.image = image;
  }
}

/**
 * Typed error for create-time sizing requests an EXISTING snapshot cannot
 * honor. Daytona pins cpu/memory/disk on the SNAPSHOT at build time;
 * create-from-snapshot has no resources parameter, so a `resources` request
 * against a cached snapshot would be silently ignored. Per the provider law
 * (reject what you cannot enforce) it is refused loudly instead: pre-build a
 * snapshot with the desired sizing under its own name, or drop `resources`.
 */
export class DaytonaResourcesError extends Error {
  /** The existing snapshot whose pinned sizing cannot be overridden. */
  readonly snapshot: string;

  constructor(snapshot: string) {
    super(
      `Daytona snapshot "${snapshot}" already exists and pins its cpu/memory/disk sizing — ` +
        "create-from-snapshot cannot resize it, so the requested `resources` cannot be enforced. " +
        "Pre-build a snapshot with the desired sizing under its own name (sizing-addressed), " +
        "or omit `resources` to accept the snapshot's pinned sizing."
    );
    this.name = "DaytonaResourcesError";
    this.snapshot = snapshot;
  }
}

// ============================================================
// COMMAND WRAPPING
// ============================================================

/**
 * Wrap command with cwd and envs shell prefixes, and (for user "root") a
 * `sudo -n` elevation wrapper.
 *
 * Daytona's executeSessionCommand doesn't support cwd or envs natively,
 * so we inline them as shell commands. Values are single-quoted to handle
 * spaces and special characters safely.
 *
 * Daytona has no per-exec user switch: commands run as the container's OS
 * user (image USER directive; default "daytona" with passwordless sudo).
 * When the sandbox user is "root", the fully wrapped command is base64
 * encoded and piped through `sudo -n bash` — base64 avoids escaping issues
 * and `-n` fails fast (typed non-zero exit) instead of hanging on a
 * password prompt if the image lacks passwordless sudo.
 */
/**
 * Enforce the timeout INSIDE the box. Daytona has no fixed sandbox lifetime and
 * its auto-stop timer measures INACTIVITY ("how long it remains active after
 * the last interaction"), so a busy runaway is never reclaimed by the provider
 * — unlike e2b and Modal, which both kill the process server-side. The session
 * API does take a timeout, but we launch with runAsync:true, so that argument
 * bounds the *call*, not the process, and the only real deadline was a
 * client-side poll in wait(): if this process died, the agent kept burning.
 *
 * coreutils `timeout` closes that hole: the kernel kills the harness whether or
 * not anything is still watching. The script is passed base64 -> file so no
 * quoting of the caller's command is ever attempted, and a box without
 * coreutils degrades to the un-timed run rather than failing outright (the
 * client-side deadline in wait() still covers it).
 */
function withInBoxTimeout(wrapped: string, timeoutSec?: number): string {
  if (!timeoutSec || timeoutSec <= 0) return wrapped;
  const encoded = Buffer.from(wrapped).toString("base64");
  const path = `/tmp/.evolve-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`;
  // RUN IT IN A CHILD SHELL. The whole thing is handed to `sh -c` rather than
  // appended to the session's own shell, because the script has to end by
  // propagating the timed command's status — and an `exit` evaluated by the
  // SESSION shell terminates the session itself, after which Daytona never
  // records the command as finished and the poll in wait() spins until the
  // client deadline. Measured: a bare `echo hello` came back exit 124 after 31s
  // that way, while the same command without this wrapper returned in 1.4s.
  // Single-quoted, and the body deliberately contains no single quote of its
  // own (the payload is base64) so no escaping is required.
  const inner =
    `echo ${encoded} | base64 -d > ${path}; ` +
    `if command -v timeout >/dev/null 2>&1; then ` +
    `timeout -k 10 ${timeoutSec} bash ${path}; else bash ${path}; fi; ` +
    `rc=$?; rm -f ${path}; exit $rc`;
  return `sh -c '${inner}'`;
}

function wrapCommand(
  command: string,
  cwd?: string,
  envs?: Record<string, string>,
  user?: string
): string {
  let wrapped = command;
  if (cwd) {
    // Single quotes handle spaces and most special chars; escape any single quotes in path
    const safeCwd = cwd.replace(/'/g, "'\\''");
    wrapped = `cd '${safeCwd}' && ${wrapped}`;
  }
  if (envs && Object.keys(envs).length > 0) {
    const exports = Object.entries(envs)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
      .join("; ");
    wrapped = `${exports}; ${wrapped}`;
  }
  if (user === "root") {
    // Envs/cwd are inside the payload, so they survive the sudo boundary
    const encoded = Buffer.from(wrapped).toString("base64");
    wrapped = `echo ${encoded} | base64 -d | sudo -n bash`;
  }
  return wrapped;
}

// ============================================================
// NETWORK POLICY MAPPING
// ============================================================

/** Daytona create() params derived from Evolve's provider-neutral network policy. */
interface DaytonaNetworkCreateParams {
  networkBlockAll?: boolean;
  networkAllowList?: string;
}

/** Resolves a hostname to its IPv4 addresses (injectable for tests). */
type HostnameResolver = (hostname: string) => Promise<string[]>;

const defaultResolveHostname: HostnameResolver = (hostname) => resolve4(hostname);

/**
 * Strict IPv4 literal or IPv4 CIDR (e.g. "10.0.0.1", "10.0.0.0/8"): every
 * octet is 0-255 and the optional prefix is 0-32. "300.1.1.1" and
 * "10.0.0.0/40" are rejected here rather than pinned/forwarded to the API.
 */
function isIpv4Destination(destination: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,3}))?$/.exec(destination);
  if (!match) return false;
  if ([match[1], match[2], match[3], match[4]].some((octet) => Number(octet) > 255)) return false;
  if (match[5] !== undefined && Number(match[5]) > 32) return false;
  return true;
}

/**
 * Dotted-quad shape (optionally with a /prefix) that is NOT a valid IPv4/CIDR
 * — an out-of-range octet (>255) or prefix (>32). Used to reject
 * "300.1.1.1" / "10.0.0.0/40" loudly instead of DNS-resolving them as
 * hostnames.
 */
function looksLikeInvalidIpv4(destination: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}(\/\d+)?$/.test(destination) && !isIpv4Destination(destination);
}

/**
 * True IPv6 literal or IPv6 CIDR (e.g. "2001:db8::1", "2001:db8::/32",
 * "[2001:db8::1]"): bracketed, or at least two colons. A single colon is a
 * "host:port" / "ip:port" destination, handled by hasPort() instead.
 */
function isIpv6Destination(destination: string): boolean {
  if (destination.startsWith("[")) return true;
  return (destination.match(/:/g)?.length ?? 0) >= 2;
}

/**
 * "host:port" / "ip:port" shape (exactly one colon, numeric port). Daytona's
 * allowlist filters hosts and IPs only, so a port cannot be honored.
 */
function hasPort(destination: string): boolean {
  return /^[^:]+:\d+$/.test(destination);
}

/**
 * Map Evolve's provider-neutral network policy onto Daytona create() params.
 *
 * - outbound "open" (or no policy)     → no restrictions
 * - outbound "blocked", no allowlist   → networkBlockAll: true (kernel DROP of all egress)
 * - outbound "blocked" with allowlist  → networkAllowList (comma-separated IPv4
 *   CIDRs; bare IPv4 gets /32). Daytona enforces the allowlist with kernel
 *   iptables and supports IPv4 CIDRs ONLY, max 10 entries.
 *
 * DNS-ROTATION CAVEAT (load-bearing): hostname destinations are resolved to
 * their IPv4 A records ONCE, at create time, and pinned as /32 CIDRs. If the
 * host rotates DNS afterwards (CDNs and cloud APIs often do), traffic to the
 * new IPs is BLOCKED for the sandbox's lifetime. Prefer stable IPs/CIDRs for
 * anything long-running.
 *
 * Anything that cannot be pinned to stable IPv4 CIDRs throws
 * DaytonaNetworkPolicyError (wildcard hostnames, IPv6, unresolvable
 * hostnames, >10 resolved CIDRs) — never silently weakened.
 */
async function mapNetworkPolicy(
  network?: SandboxCreateOptions["network"],
  resolveHostname: HostnameResolver = defaultResolveHostname
): Promise<DaytonaNetworkCreateParams> {
  if (!network || network.outbound === "open") {
    if (network?.allowedDestinations?.length) {
      throw new Error("network.allowedDestinations is only valid when outbound is blocked");
    }
    return {};
  }

  const destinations = network.allowedDestinations ?? [];
  if (destinations.length === 0) {
    return { networkBlockAll: true };
  }

  // Pass 1 (synchronous): classify destinations and reject what Daytona can
  // never enforce, before any DNS lookups happen.
  const cidrs: string[] = [];
  const hostnames: string[] = [];
  for (const destination of destinations) {
    if (isIpv4Destination(destination)) {
      cidrs.push(destination.includes("/") ? destination : `${destination}/32`);
    } else if (looksLikeInvalidIpv4(destination)) {
      throw new DaytonaNetworkPolicyError(
        "invalid-ipv4",
        `"${destination}" is not a valid IPv4 address or CIDR (octets must be 0-255, prefix 0-32). ` +
          "Fix the address or list a hostname instead.",
        destination
      );
    } else if (isIpv6Destination(destination)) {
      throw new DaytonaNetworkPolicyError(
        "ipv6-unsupported",
        `Daytona's network allowlist supports IPv4 CIDRs only; cannot allow IPv6 destination "${destination}".`,
        destination
      );
    } else if (hasPort(destination)) {
      throw new DaytonaNetworkPolicyError(
        "port-unsupported",
        `Daytona's network allowlist filters hosts and IPs only and cannot match a port; ` +
          `drop the ":<port>" from "${destination}" and list just the host or IP.`,
        destination
      );
    } else if (destination.includes("*")) {
      throw new DaytonaNetworkPolicyError(
        "wildcard-hostname",
        `Daytona cannot enforce wildcard hostname "${destination}": its allowlist is kernel-level IPv4 ` +
          "CIDR filtering with no DNS/domain layer. List concrete hostnames or IPv4 CIDRs instead.",
        destination
      );
    } else {
      hostnames.push(destination);
    }
  }

  // Pass 2: pin hostnames to their IPv4 addresses at create time.
  for (const hostname of hostnames) {
    let ips: string[] = [];
    try {
      ips = await resolveHostname(hostname);
    } catch (error) {
      throw new DaytonaNetworkPolicyError(
        "unresolvable-hostname",
        `Cannot pin hostname "${hostname}" to stable IPv4 addresses at create time ` +
          `(${error instanceof Error ? error.message : String(error)}). Daytona enforces IPv4 CIDRs ` +
          "only; use an IPv4 CIDR for this destination instead.",
        hostname
      );
    }
    if (ips.length === 0) {
      throw new DaytonaNetworkPolicyError(
        "unresolvable-hostname",
        `Hostname "${hostname}" resolved to no IPv4 addresses. Daytona enforces IPv4 CIDRs only; ` +
          "use an IPv4 CIDR for this destination instead.",
        hostname
      );
    }
    // LOUD caveat: the pin is a snapshot of DNS at create time
    console.warn(
      `[daytona] Network allowlist: pinning "${hostname}" to [${ips.join(", ")}] (DNS resolved at ` +
        "create time). Daytona enforces IPv4 CIDRs only — if this host rotates DNS (CDNs and cloud " +
        "APIs often do), traffic to its new IPs will be BLOCKED for the sandbox's lifetime."
    );
    for (const ip of ips) {
      cidrs.push(`${ip}/32`);
    }
  }

  const uniqueCidrs = [...new Set(cidrs)];
  if (uniqueCidrs.length > DAYTONA_MAX_NETWORK_ALLOWLIST) {
    throw new DaytonaNetworkPolicyError(
      "allowlist-too-large",
      `Daytona allows at most ${DAYTONA_MAX_NETWORK_ALLOWLIST} entries in its network allowlist; ` +
        `this policy resolved to ${uniqueCidrs.length} CIDRs (${uniqueCidrs.join(", ")}). ` +
        "Aggregate destinations into broader CIDRs or reduce the list."
    );
  }

  // networkBlockAll must stay false: Daytona's runner checks blockAll first
  // and would ignore the allowlist if both were set.
  return { networkBlockAll: false, networkAllowList: uniqueCidrs.join(",") };
}

// ============================================================
// IMAGE REGISTRY DETECTION
// ============================================================

/**
 * Registry host of an image reference, or undefined for Docker Hub images.
 * A reference carries a registry host only when its first path segment
 * contains "." or ":" or is "localhost" (Docker's own heuristic).
 */
function imageRegistryHost(image: string): string | undefined {
  const slash = image.indexOf("/");
  if (slash < 0) return undefined;
  const host = image.substring(0, slash);
  return host.includes(".") || host.includes(":") || host === "localhost" ? host : undefined;
}

// ============================================================
// SANDBOX INFO MAPPING
// ============================================================

/** Fields we read off a Daytona SDK sandbox to build a SandboxInfo. */
interface DaytonaSandboxLike {
  id: string;
  name?: string;
  snapshot?: string;
  labels?: Record<string, string>;
  createdAt?: string;
}

/**
 * Build a SandboxInfo from a Daytona sandbox entity. Timestamps come from
 * the API's createdAt (never fabricated client-side; empty string when the
 * API omits it). Daytona exposes no end timestamp, so endAt is always
 * undefined.
 */
function toSandboxInfo(sandbox: DaytonaSandboxLike): SandboxInfo {
  return {
    sandboxId: sandbox.id,
    image: sandbox.snapshot ?? "",
    name: sandbox.name,
    metadata: sandbox.labels ?? {},
    startedAt: sandbox.createdAt ?? "",
  };
}

/**
 * Map a Daytona sandbox state onto Evolve's list() filter states.
 * "started" → running; "stopped"/"archived" → paused (our pause() stops the
 * sandbox); transitional and terminal states match no filter.
 */
function daytonaStateToEvolveState(state?: string): "running" | "paused" | undefined {
  if (state === "started") return "running";
  if (state === "stopped" || state === "archived") return "paused";
  return undefined;
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
  /** End time (undefined for running sandboxes; Daytona never exposes one) */
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

/** Resource configuration for sandbox */
export interface SandboxResources {
  /** CPU cores (default: 4) */
  cpu?: number;
  /** Memory in GB (default: 4) */
  memory?: number;
  /** Disk in GB (default: 10) */
  disk?: number;
}

/** Options for creating a sandbox */
export interface SandboxCreateOptions {
  image?: string;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutMs?: number;
  workingDirectory?: string;
  /**
   * Resource allocation (cpu cores, memory GiB, disk GiB), applied when a
   * SNAPSHOT IS BUILT for the image (Daytona pins sizing on the snapshot).
   * When the named snapshot ALREADY exists it cannot be resized at create —
   * declaring resources then throws DaytonaResourcesError rather than
   * silently ignoring them (pre-build a sizing-addressed snapshot instead).
   */
  resources?: SandboxResources;
  /**
   * Provider-neutral outbound network policy, enforced by kernel iptables on
   * the Daytona runner. "blocked" with no allowedDestinations drops all
   * egress. With allowedDestinations, Daytona supports IPv4 CIDRs ONLY (max
   * 10): IPs/CIDRs pass through; hostnames are DNS-resolved ONCE at create
   * time and pinned as /32 CIDRs — if the host rotates DNS later (CDNs and
   * cloud APIs often do), its new IPs are BLOCKED for the sandbox's
   * lifetime. Wildcards, IPv6, and unresolvable hostnames throw
   * DaytonaNetworkPolicyError rather than silently weakening the policy.
   * Note: on Daytona orgs below Tier 3, org network policy overrides
   * per-sandbox settings server-side.
   */
  network?: {
    outbound: "open" | "blocked";
    allowedDestinations?: string[];
  };
  /**
   * OS user for the sandbox, applied at CREATE time (Daytona's osUser field)
   * — Daytona has no per-exec user switch, so the user commands actually run
   * as is governed by the sandbox image (USER directive; default Daytona
   * images use "daytona" with passwordless sudo). A non-root value must
   * exist in the image. Pass "root" to keep the image's default user and
   * elevate every command through a `sudo -n` wrapper instead (requires
   * passwordless sudo in the image; default images have it). File operations
   * go through the Daytona daemon and are NOT elevated.
   */
  user?: string;
  /** Home directory used by the SDK for agent config paths; not consumed by the provider. */
  homeDir?: string;
}

/** Options for listing sandboxes */
export interface SandboxListOptions {
  /** "running" matches Daytona "started"; "paused" matches "stopped"/"archived". */
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
  /** Upload a local file by path, without buffering it whole */
  writeFromPath(sandboxPath: string, localPath: string): Promise<void>;
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
  /** Daytona snapshot name (default: 'evolve-all'). Create custom snapshots via `cd assets && ./build.sh daytona` */
  snapshotName?: string;
}

interface ResolvedDaytonaConfig {
  apiKey: string;
  apiUrl?: string;
  target?: string;
  defaultTimeoutMs?: number;
  snapshotName?: string;
}

// ============================================================
// IMPLEMENTATION
// ============================================================

export class DaytonaCommands implements SandboxCommands {
  constructor(private sandbox: DaytonaSandbox, private user?: string) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    const timeoutSec = options?.timeoutMs ? Math.floor(options.timeoutMs / 1000) : undefined;

    // Always use ephemeral session for reliable stdout/stderr capture.
    // Daytona's executeCommand API can return empty output in some cases.
    // Session-based execution with explicit log retrieval is most reliable.
    const sessionId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.sandbox.process.createSession(sessionId);

    try {
      const resp = await this.sandbox.process.executeSessionCommand(sessionId, {
        command: wrapCommand(command, options?.cwd, options?.envs, this.user),
        runAsync: false,
      }, timeoutSec);

      const cmdId = resp.cmdId;

      // Streaming: pipe logs to callbacks
      if (cmdId && (options?.onStdout || options?.onStderr)) {
        await this.sandbox.process.getSessionCommandLogs(
          sessionId,
          cmdId,
          options.onStdout || (() => {}),
          options.onStderr || (() => {})
        );
      }

      // Try inline stdout first; if empty and we have cmdId, fetch logs explicitly
      let stdout = resp.stdout ?? resp.output ?? "";
      let stderr = resp.stderr ?? "";
      if (!stdout && cmdId && !options?.onStdout) {
        try {
          const logs = await this.sandbox.process.getSessionCommandLogs(sessionId, cmdId);
          stdout = (logs as any).stdout ?? (logs as any).output ?? "";
          stderr = (logs as any).stderr ?? stderr;
        } catch {
          // Ignore log fetch errors — use inline response
        }
      }

      return {
        exitCode: resp.exitCode ?? 0,
        stdout,
        stderr,
      };
    } finally {
      try {
        await this.sandbox.process.deleteSession(sessionId);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

    async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    const sessionId = `evolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.sandbox.process.createSession(sessionId);

    const timeoutSec = options?.timeoutMs ? Math.floor(options.timeoutMs / 1000) : undefined;
    const startedAt = Date.now();
    const timeoutMs = options?.timeoutMs;

    const resp = await this.sandbox.process.executeSessionCommand(sessionId, {
      command: withInBoxTimeout(
        wrapCommand(command, options?.cwd, options?.envs, this.user),
        timeoutSec
      ),
      runAsync: true,
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

    const sandbox = this.sandbox;
    return {
      processId: sessionId,
      wait: async () => {
        if (!cmdId) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        // Poll until command completes (exitCode becomes defined)
        while (true) {
          if (timeoutMs && Date.now() - startedAt >= timeoutMs) {
            try {
              await sandbox.process.deleteSession(sessionId);
            } catch {
              // Ignore cleanup errors after timeout
            }
            // 124, the coreutils convention — the same code the in-box
            // `timeout` produces and the same one the e2b adapter now returns,
            // so a timeout means one thing across all three providers.
            return {
              exitCode: 124,
              stdout: "",
              stderr: "operation timed out",
            };
          }
          try {
            const cmd = await sandbox.process.getSessionCommand(sessionId, cmdId);
            if (cmd.exitCode !== undefined) {
              try {
                const logs = await sandbox.process.getSessionCommandLogs(sessionId, cmdId);
                return {
                  exitCode: cmd.exitCode,
                  stdout: logs.stdout ?? logs.output ?? "",
                  stderr: logs.stderr ?? "",
                };
              } catch {
                return {
                  exitCode: cmd.exitCode,
                  stdout: "",
                  stderr: "",
                };
              }
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
            // Session may disappear after kill()/interrupt() - treat as interrupted completion
            if (msg.includes("not found")) {
              return {
                exitCode: -1,
                stdout: "",
                stderr: "session terminated",
              };
            }
            throw error;
          }
          await new Promise(r => setTimeout(r, 500));
        }
      },
      kill: async () => {
        try {
          await sandbox.process.deleteSession(sessionId);
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

export class DaytonaFiles implements SandboxFiles {
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

  /**
   * Upload a local file by PATH. Daytona's own uploadFile has a local-path
   * overload (FileSystem.d.ts: `uploadFile(localPath: string, remotePath:
   * string, timeout?)`), so the bytes never pass through this process's heap —
   * which is what makes a large artifact safe to upload under concurrency.
   */
  async writeFromPath(sandboxPath: string, localPath: string): Promise<void> {
    await this.sandbox.fs.uploadFile(localPath, sandboxPath);
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

  constructor(private sandbox: DaytonaSandbox, user?: string) {
    this.commands = new DaytonaCommands(sandbox, user);
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
    // Refresh from the API so the answer reflects current state, not the
    // state captured when this instance was constructed.
    try {
      await this.sandbox.refreshData();
    } catch {
      return false;
    }
    return this.sandbox.state === "started";
  }

  async getInfo(): Promise<SandboxInfo> {
    // Refresh from the API: real createdAt/labels/state, never a fabricated
    // client-side timestamp. API errors propagate.
    await this.sandbox.refreshData();
    return toSandboxInfo(this.sandbox);
  }

  async kill(): Promise<void> {
    // Evidence: Daytona SDK sandbox.delete()
    await this.sandbox.delete();
  }

  async pause(): Promise<void> {
    await this.sandbox.stop();
  }
}

export class DaytonaProvider implements SandboxProvider {
  readonly providerType = "daytona" as const;
  readonly name = "Daytona";
  private readonly client: Daytona;
  private readonly defaultTimeoutMs: number;
  private readonly snapshotName: string;
  /**
   * Sandbox user configured at create time, reapplied on connect() so the
   * root sudo wrapper keeps applying. In-memory only: a connect() from a
   * fresh process falls back to the sandbox's create-time OS user without
   * the wrapper — callers reconnecting across processes must recreate the
   * provider and sandbox with the same user, or root-only operations fail
   * loudly.
   */
  private readonly sandboxUsers = new Map<string, string>();

  constructor(config: ResolvedDaytonaConfig) {
    this.client = new Daytona({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      target: config.target,
    });
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 3600000;
    this.snapshotName = config.snapshotName ?? "evolve-all";
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    // Validate the network policy before any Daytona API call: the invalid
    // open+allowlist combination and every unenforceable destination
    // (wildcard/IPv6/unresolvable/too-many) fail fast with typed errors.
    // Hostname destinations are DNS-pinned to IPv4 /32s here (see the
    // DNS-rotation caveat on SandboxCreateOptions.network).
    const networkParams = await mapNetworkPolicy(options.network);

    // Daytona has no per-exec user switch: a non-root user is applied as the
    // create-time OS user; "root" keeps the image default user and elevates
    // commands via the sudo wrapper in wrapCommand() instead.
    const user = options.user;
    const osUser = user && user !== "root" ? user : undefined;

    // LIFETIME IS NOT PARITY. e2b and Modal take an absolute sandbox lifetime;
    // Daytona has none — its documented controls are auto-stop ("how long it
    // remains active after the last interaction"), auto-archive (inactivity)
    // and auto-delete (measured after STOPPING). So the timeout can only be
    // mapped onto the inactivity clock, and a box that keeps looking busy is
    // never reclaimed by the provider. The process-level deadline is enforced
    // in-box instead (withInBoxTimeout in spawn), which is what actually bounds
    // a runaway harness here.
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const autoStopMinutes = Math.max(1, Math.ceil(timeoutMs / 60000)); // Min 1 minute
    const imageName = options.image || this.snapshotName;

    const baseParams = {
      envVars: options.envs,
      labels: options.metadata,
      autoStopInterval: autoStopMinutes,
      // Delete on stop (0 = "delete immediately upon stopping"). Without it a
      // stopped box lingers as billable state that nothing is watching: the
      // eval worker's reaper only kills boxes it still has a DB row for, and a
      // stopped-but-kept sandbox outlives that row.
      autoDeleteInterval: 0,
      ...(osUser ? { user: osUser } : {}),
      ...networkParams,
    };

    let sandbox: DaytonaSandbox;

    // True when the caller declared any create-time sizing. An EXISTING
    // snapshot pins its sizing (create-from-snapshot cannot resize), so the
    // fast path below must refuse rather than silently ignore the request.
    const wantsResources =
      options.resources !== undefined &&
      (options.resources.cpu !== undefined ||
        options.resources.memory !== undefined ||
        options.resources.disk !== undefined);

    // Try to use existing snapshot first (fast path for returning users or ./build.sh daytona)
    try {
      const snapshot = await this.client.snapshot.get(imageName);
      if (snapshot && snapshot.state === "active") {
        if (wantsResources) throw new DaytonaResourcesError(imageName);
        console.log(`[daytona] Using cached snapshot: ${imageName}`);
        sandbox = await this.client.create(
          {
            snapshot: imageName,
            ...baseParams,
          },
          { timeout: 600 }
        );
      } else {
        throw new Error("Snapshot not active");
      }
    } catch (fastPathErr) {
      // The typed sizing refusal is a final verdict, not a build trigger.
      if (fastPathErr instanceof DaytonaResourcesError) throw fastPathErr;
      // Snapshot doesn't exist — create a named one from the Docker image, then use it.
      // Private registry images (ECR etc.) require credentials pre-registered in the
      // Daytona dashboard (Registries) — there is no per-call image pull secret.
      const publicImage = IMAGE_MAP[imageName] ?? imageName;

      console.log(`[daytona] Snapshot "${imageName}" not found, building from image: ${publicImage}`);
      console.log("[daytona] First run will take a few minutes (this only happens once)...");

      try {
        // Step 1: Create named snapshot (blocking — so it's available for all future runs)
        // Use Image.base() — snapshot.create() requires a Daytona Image object, not a raw string
        await this.client.snapshot.create(
          {
            name: imageName,
            image: Image.base(publicImage),
            resources: {
              cpu: options.resources?.cpu ?? 4,
              memory: options.resources?.memory ?? 4,
              disk: options.resources?.disk ?? 10,
            },
          },
          { onLogs: (log: string) => console.log(`[daytona] ${log}`) },
        );
        console.log(`[daytona] Snapshot "${imageName}" ready.`);

        // Step 2: Create sandbox from the just-created snapshot (fast)
        sandbox = await this.client.create(
          {
            snapshot: imageName,
            ...baseParams,
          },
          { timeout: 600 }
        );
      } catch (snapshotErr) {
        // Snapshot creation failed — fall back to direct image creation
        console.warn(`[daytona] Snapshot creation failed, falling back to direct image: ${snapshotErr instanceof Error ? snapshotErr.message : snapshotErr}`);
        try {
          sandbox = await this.client.create(
            {
              image: publicImage,
              ...baseParams,
              resources: {
                cpu: options.resources?.cpu ?? 4,
                memory: options.resources?.memory ?? 4,
                disk: options.resources?.disk ?? 10,
              },
            },
            {
              timeout: 600,
              onSnapshotCreateLogs: (log: string) => console.log(`[daytona] ${log}`),
            }
          );
        } catch (directErr) {
          // Both the snapshot build and the direct pull failed. For private
          // registry images the overwhelmingly likely cause is missing
          // dashboard-registered registry credentials — surface that loudly.
          if (imageRegistryHost(publicImage)) {
            throw new DaytonaImagePullError(publicImage, directErr);
          }
          throw directErr;
        }
      }
    }

    if (options.workingDirectory) {
      await sandbox.fs.createFolder(options.workingDirectory, "755");
    }

    if (user) {
      this.sandboxUsers.set(sandbox.id, user);
    }

    return new DaytonaSandboxImpl(sandbox, user);
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    const sandbox = await this.client.get(sandboxId);
    if (sandbox.state !== "started") {
      await sandbox.start();
    }
    return new DaytonaSandboxImpl(sandbox, this.sandboxUsers.get(sandboxId));
  }

  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    // Evidence: Daytona SDK list(labels?, page?, limit?) returns PaginatedSandboxes.
    // API errors propagate; nothing is fabricated for missing fields.
    const limit = options?.limit ?? 100;
    const result = await this.client.list(options?.metadata, 1, limit);

    let items = result.items;
    if (options?.state) {
      // Daytona's list API has no state filter param — filter on the real
      // API-reported state client-side.
      items = items.filter((sandbox) => {
        const evolveState = daytonaStateToEvolveState(sandbox.state);
        return evolveState !== undefined && options.state!.includes(evolveState);
      });
    }

    return items.map(toSandboxInfo);
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

// ============================================================
// TEST-ONLY EXPORTS
// ============================================================

/** @internal Test-only export for unit testing wrapCommand logic. */
export const _testWrapCommand = wrapCommand;
export const _testMapNetworkPolicy = mapNetworkPolicy;
export const _testImageRegistryHost = imageRegistryHost;
export const _testToSandboxInfo = toSandboxInfo;
export const _testDaytonaStateToEvolveState = daytonaStateToEvolveState;
