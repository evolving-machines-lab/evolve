/**
 * Modal Sandbox Provider - Clean Architecture
 *
 * @requires modal >= 0.9.0
 * @requires Node.js >= 18 (for ReadableStream support)
 *
 * Design principles:
 * - Single way to do things (no dual methods)
 * - Options objects only (no positional args)
 * - All interface methods required (no optional ?)
 * - Configuration externalized (no hardcoded mappings)
 * - Clear naming (run = blocking, spawn = background)
 *
 * Modal-specific notes:
 * - No native file APIs - uses exec() with stdin/stdout
 * - pause() not supported - throws error (use Evolve checkpoints for persistence)
 * - Requires app context for sandbox creation
 * - Hard 24h sandbox lifetime cap (ModalSandboxLifetimeError when exceeded)
 * - Everything executes as root inside the sandbox; the `user` option is
 *   enforced through an `su <user> -c` wrapper (default user: "user")
 * - Network policy maps to Modal's blockNetwork / outboundDomainAllowlist /
 *   outboundCidrAllowlist (domain allowlist admits TLS on port 443 only —
 *   plaintext destinations must be listed as IPs/CIDRs)
 * - Modal exposes no metadata or public timestamps on sandboxes; both are
 *   stamped into sandbox tags at create time and read back via getTags()
 */

import {
  ModalClient,
  Sandbox,
  App,
  Image,
  ContainerProcess,
  NotFoundError,
} from "modal";
import { pack } from "tar-stream";

// ============================================================
// MODULE-LEVEL CONSTANTS & HELPERS
// ============================================================

/**
 * The Evolve image release this package defaults to — DERIVED, never
 * hand-written: `c-<12hex>`, the sha256 of the image's build inputs (the
 * Dockerfile plus everything the build copies in, see
 * assets/docker/image-digest.ts). `npm run generate:image-version` (repo
 * root) rewrites ./image-version.ts here and its two generated siblings
 * (assets/docker/image-version.ts, packages/daytona/src/image-version.ts);
 * the published packages ship standalone, so each carries the value as a
 * checked-in constant. The coherence test in
 * packages/daytona/tests/unit/daytona-image-version.test.ts recomputes the
 * digest and fails the suite whenever a checked-in copy is stale.
 *
 * WHY a per-release tag at all: Modal caches an image by its REFERENCE
 * string. A mutable :latest is pulled once per account and never again, so a
 * pushed update reached nobody. A content change moves the derived tag,
 * which moves the default image name (evolve-all-c-<12hex>) and makes Modal
 * pull the release.
 */
import { EVOLVE_IMAGE_VERSION } from "./image-version";
export { EVOLVE_IMAGE_VERSION };

/** Map generic image names to Docker images */
const IMAGE_MAP: Record<string, string> = {
  // The derived default: the immutable content-addressed tag this release pushes.
  [`evolve-all-${EVOLVE_IMAGE_VERSION}`]: `evolvingmachines/evolve-all:${EVOLVE_IMAGE_VERSION}`,
  // The legacy unversioned name. A caller who pins "evolve-all" explicitly
  // keeps resolving exactly what they always did — the mutable Docker Hub
  // name (same rule as Daytona's legacy snapshot name).
  "evolve-all": "evolvingmachines/evolve-all",
};

/**
 * Modal's hard cap on sandbox lifetime (24 hours).
 * Requests beyond this throw ModalSandboxLifetimeError.
 */
export const MODAL_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Chunk size for stdin uploads, and the reason it is THIS big.
 *
 * Every writeBytes() call is one awaited unary TaskExecStdinWrite round trip
 * to Modal, so upload time is set by how many messages a payload becomes, not
 * by how many bytes it is. Measured on live sandboxes with a 180MiB file:
 *
 *     64KiB   311.6s   (2880 messages — Node's default read size)
 *     4MiB     36.2s
 *     8MiB     30.1s   <- this constant
 *     16MiB    31.4s
 *
 * Below roughly 4MiB the upload is round-trip bound and shrinking the chunk
 * makes it dramatically slower; above it the transport saturates near 6MiB/s
 * and a bigger chunk buys nothing.
 *
 * Modal's 100MiB per-message cap (RESOURCE_EXHAUSTED at 104,857,600 bytes) is
 * the CEILING this must stay under — it is not the reason for the value. Do
 * not "play it safe" by trimming this toward the cap-satisfying end: 64KiB is
 * equally cap-safe and ten times slower, which is exactly the state this
 * constant was raised to fix.
 *
 * STANDING DECISION (chunk size stays 8MiB) and its trigger: a worker running
 * 16 concurrent uploads buffers about 256MiB at this size, which is real
 * pressure in a 1GB worker. The re-profile's saturation row runs exactly that
 * 16-parallel case; the ruling is to move on ITS data, not on precaution. If
 * that row shows memory pressure, dropping to 4MiB is a measured one-line
 * change — 36.2s versus 30.1s, about 83% of the throughput for half the
 * buffer — and everything above still holds.
 */
export const MODAL_STDIN_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Iterate a web ReadableStream. Node's implementation is async-iterable, but
 * the DOM lib type it is declared with is not, so the reader is driven by hand
 * rather than asserting the stream into an AsyncIterable it may not be.
 */
async function* streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Default sandbox user. Modal runs everything as root (ignoring the image's
 * USER directive), but agent CLIs refuse certain operations as root, so
 * commands and file ownership default to the image's "user" account.
 */
const DEFAULT_SANDBOX_USER = "user";

/** Tag keys used to stamp Evolve-owned info onto Modal sandboxes. */
const TAG_IMAGE = "evolve.image";
const TAG_STARTED_AT = "evolve.startedAt";

/**
 * Typed error for Modal's hard 24h sandbox lifetime cap.
 * Long-running sessions must persist progress with Evolve checkpoints and
 * resume in a fresh sandbox instead of extending the timeout.
 */
export class ModalSandboxLifetimeError extends Error {
  readonly requestedTimeoutMs: number;

  constructor(requestedTimeoutMs: number) {
    const requestedHours = (requestedTimeoutMs / 3_600_000).toFixed(1);
    super(
      `Modal sandboxes have a hard 24h lifetime cap; requested timeout was ${requestedHours}h. ` +
        "For sessions longer than 24h, persist progress with Evolve checkpoints " +
        "and resume in a fresh sandbox instead of extending the timeout."
    );
    this.name = "ModalSandboxLifetimeError";
    this.requestedTimeoutMs = requestedTimeoutMs;
  }
}

/** Throws ModalSandboxLifetimeError when the timeout exceeds Modal's 24h cap. */
function validateTimeout(timeoutMs: number): void {
  if (timeoutMs > MODAL_MAX_LIFETIME_MS) {
    throw new ModalSandboxLifetimeError(timeoutMs);
  }
}

/**
 * Typed error for an idle timeout Modal could not act on. Both bounds are
 * refusals rather than clamps: silently raising a zero, or lowering a value past
 * the lifetime cap, would hand back a box that dies on a schedule the caller
 * never asked for.
 */
export class ModalIdleTimeoutError extends Error {
  readonly requestedIdleTimeoutMs: number;

  constructor(requestedIdleTimeoutMs: number, reason: string) {
    super(`Modal idleTimeoutMs of ${requestedIdleTimeoutMs}ms is invalid: ${reason}`);
    this.name = "ModalIdleTimeoutError";
    this.requestedIdleTimeoutMs = requestedIdleTimeoutMs;
  }
}

/**
 * Evolve's idle bound -> Modal's create params, same shape as mapNetworkPolicy
 * and mapResources: provider-neutral option in, Modal fragment out.
 *
 * ABSENT MEANS ABSENT. Modal's own default is no idle timer at all, so an unset
 * option must spread to nothing — inventing a default here would start killing
 * boxes that today live out their lifetime, for every caller who never asked.
 *
 * An idle timeout has to be a positive span, and one above the 24h lifetime cap
 * can never fire because the sandbox is already gone. Both are caller mistakes,
 * and both throw rather than clamp: silently raising a zero or lowering an
 * over-cap value hands back a box that dies on a schedule nobody chose.
 */
function mapIdleTimeout(idleTimeoutMs?: number): { idleTimeoutMs?: number } {
  if (idleTimeoutMs === undefined) return {};
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new ModalIdleTimeoutError(idleTimeoutMs, "it must be a positive number of milliseconds");
  }
  if (idleTimeoutMs > MODAL_MAX_LIFETIME_MS) {
    throw new ModalIdleTimeoutError(
      idleTimeoutMs,
      "it exceeds Modal's 24h lifetime cap, so the sandbox would always die of the lifetime first"
    );
  }
  return { idleTimeoutMs };
}

/**
 * Wrap a command with cwd + env handling and (when not root) an
 * `su <user> -c` wrapper.
 *
 * Modal sandboxes run as root by default (ignoring the Dockerfile USER
 * directive), but Claude CLI and other tools refuse certain operations when
 * running as root.
 *
 * Uses `su <user> -c` instead of `sudo -u <user>` because Claude CLI's
 * --dangerously-skip-permissions flag refuses to run when it detects sudo.
 *
 * Uses base64 encoding to avoid shell escaping issues with complex commands
 * that contain quotes, special characters, etc. Env vars are inlined because
 * su does not preserve the environment the way `sudo -E` does.
 */
function wrapCommand(
  command: string,
  user: string,
  cwd?: string,
  envs?: Record<string, string>
): string[] {
  // Build env prefix for inline variable passing
  let envPrefix = "";
  if (envs && Object.keys(envs).length > 0) {
    envPrefix = Object.entries(envs)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
      .join("; ") + "; ";
  }

  // Build the full command with optional cd
  const fullCmd = cwd
    ? `cd '${cwd.replace(/'/g, "'\\''")}' && ${envPrefix}${command}`
    : `${envPrefix}${command}`;

  // Root is Modal's native execution user - no su wrapper needed
  if (user === "root") {
    return ["bash", "-c", fullCmd];
  }

  // Use base64 encoding to avoid all shell escaping issues
  const encoded = Buffer.from(fullCmd).toString("base64");

  // Use su <user> -c to avoid sudo detection by Claude CLI
  // Decode and execute via bash to preserve all shell features
  return ["su", user, "-c", `echo ${encoded} | base64 -d | bash`];
}

/**
 * Typed error for sizing requests Modal's create() cannot enforce.
 * The installed Modal JS SDK sizes cpu (cores) and memoryMiB at create time
 * only — there is no disk-size parameter, so a requested disk size would be
 * silently ignored. Per the provider law (reject what you cannot enforce,
 * never silently ignore) it is refused loudly here.
 */
export class ModalResourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModalResourcesError";
  }
}

/** Modal create-time sizing defaults (the provider's historical constants). */
const DEFAULT_CPU_CORES = 4;
const DEFAULT_MEMORY_MIB = 4096;

/**
 * Map Evolve's provider-neutral resources (cpu cores, memory GiB, disk GiB)
 * onto Modal's create() params (cpu cores, memoryMiB). Fractional GiB rounds
 * UP so the sandbox never gets less memory than requested. `disk` throws
 * ModalResourcesError — the SDK cannot express it.
 */
/**
 * Structural twin of SandboxCreateOptions["resources"] — spelled locally
 * (rather than indexed off the SDK type) so this package can build against
 * an SDK whose published type predates the GPU fields; the provider-parity
 * conformance file still pins the two to each other.
 */
type ModalCreateResources = {
  cpu?: number;
  memory?: number;
  disk?: number;
  gpu?: number;
  gpuTypes?: string[];
};

function mapResources(
  resources?: ModalCreateResources
): { cpu: number; memoryMiB: number; gpu?: string } {
  if (resources?.disk !== undefined) {
    throw new ModalResourcesError(
      `Modal's JS SDK has no create-time disk-size parameter, so a ${resources.disk} GiB ` +
        "disk request cannot be enforced. Drop `resources.disk` (containers get Modal's " +
        "default disk quota) or run on a provider that sizes disk."
    );
  }
  // GPU reservation: Modal takes a "<TYPE>:<count>" string (SandboxCreateParams
  // .gpu, e.g. "A100", "T4:2", "A100-80GB:4"; the SDK uppercases the type).
  // Type 'any' when the caller names none; the FIRST named type when several —
  // Modal reserves one type per sandbox. The type string passes through
  // verbatim: Modal rejects an unknown type at create with its own typed
  // error, never a silent CPU box. gpuTypes without a positive gpu count is a
  // contradiction worth refusing rather than guessing a count for.
  if ((resources?.gpu === undefined || resources.gpu <= 0) && resources?.gpuTypes?.length) {
    throw new ModalResourcesError(
      "resources.gpuTypes was set without a positive resources.gpu count — declare how many " +
        "GPUs to reserve, or drop gpuTypes."
    );
  }
  const gpu =
    resources?.gpu !== undefined && resources.gpu > 0
      ? `${resources.gpuTypes?.length ? resources.gpuTypes[0] : "any"}:${resources.gpu}`
      : undefined;
  return {
    cpu: resources?.cpu ?? DEFAULT_CPU_CORES,
    memoryMiB:
      resources?.memory !== undefined
        ? Math.ceil(resources.memory * 1024)
        : DEFAULT_MEMORY_MIB,
    ...(gpu !== undefined ? { gpu } : {}),
  };
}

/** Modal create() params derived from Evolve's provider-neutral network policy. */
interface ModalNetworkCreateParams {
  blockNetwork?: boolean;
  outboundCidrAllowlist?: string[];
  outboundDomainAllowlist?: string[];
}

/** Why a network destination cannot be mapped onto Modal's allowlist. */
export type ModalNetworkPolicyReason = "port-unsupported" | "invalid-ipv4";

/**
 * Typed error for destinations Modal's allowlist cannot express.
 *
 * Modal's allowlist filters hosts (domain allowlist) and IPs/CIDRs (CIDR
 * allowlist) only — it has no notion of a port, and an invalid IPv4/CIDR
 * would be silently forwarded to the API. Both are rejected loudly here
 * instead of weakening or mangling the sandbox's egress policy.
 */
export class ModalNetworkPolicyError extends Error {
  readonly reason: ModalNetworkPolicyReason;
  /** The offending destination. */
  readonly destination?: string;

  constructor(reason: ModalNetworkPolicyReason, message: string, destination?: string) {
    super(message);
    this.name = "ModalNetworkPolicyError";
    this.reason = reason;
    this.destination = destination;
  }
}

/**
 * Strict IPv4 literal or IPv4 CIDR (e.g. "10.0.0.1", "10.0.0.0/8"): every
 * octet is 0-255 and the optional prefix is 0-32. "300.1.1.1" and
 * "10.0.0.0/40" are rejected here rather than forwarded to the API.
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
 * "300.1.1.1" / "10.0.0.0/40" loudly instead of treating them as hostnames.
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
 * "host:port" / "ip:port" shape (exactly one colon, numeric port). Modal's
 * allowlist filters hosts and IPs only, so a port cannot be honored.
 */
function hasPort(destination: string): boolean {
  return /^[^:]+:\d+$/.test(destination);
}

/**
 * Map Evolve's provider-neutral network policy onto Modal create() params.
 *
 * - outbound "open" (or no policy)     → no restrictions
 * - outbound "blocked", no allowlist   → blockNetwork: true (drops all egress)
 * - outbound "blocked" with allowlist  → outboundDomainAllowlist (hostnames,
 *   wildcards like "*.example.com") + outboundCidrAllowlist (IPs/CIDRs; bare
 *   IPs get /32 or /128 appended). Both lists are always set because Modal
 *   treats an unset list as "allow all" — an empty array means "allow none"
 *   for that class of destination. Note: Modal's domain allowlist only admits
 *   TLS traffic on port 443; plaintext destinations must be listed as CIDRs.
 */
function mapNetworkPolicy(
  network?: SandboxCreateOptions["network"]
): ModalNetworkCreateParams {
  if (!network || network.outbound === "open") {
    if (network?.allowedDestinations?.length) {
      throw new Error("network.allowedDestinations is only valid when outbound is blocked");
    }
    return {};
  }

  const destinations = network.allowedDestinations ?? [];
  if (destinations.length === 0) {
    return { blockNetwork: true };
  }

  const cidrs: string[] = [];
  const domains: string[] = [];
  for (const destination of destinations) {
    if (isIpv4Destination(destination)) {
      cidrs.push(destination.includes("/") ? destination : `${destination}/32`);
    } else if (looksLikeInvalidIpv4(destination)) {
      throw new ModalNetworkPolicyError(
        "invalid-ipv4",
        `"${destination}" is not a valid IPv4 address or CIDR (octets must be 0-255, prefix 0-32). ` +
          "Fix the address or list a hostname instead.",
        destination
      );
    } else if (isIpv6Destination(destination)) {
      cidrs.push(destination.includes("/") ? destination : `${destination}/128`);
    } else if (hasPort(destination)) {
      throw new ModalNetworkPolicyError(
        "port-unsupported",
        `Modal's network allowlist filters hosts and IPs only and cannot match a port; ` +
          `drop the ":<port>" from "${destination}" and list just the host or IP.`,
        destination
      );
    } else {
      domains.push(destination);
    }
  }
  return { outboundCidrAllowlist: cidrs, outboundDomainAllowlist: domains };
}

/**
 * The same policy expressed the way Modal's RUNTIME switch takes it: both
 * allowlists, always.
 *
 * Two independent reasons, and the second outlives the first. Modal requires
 * both today — "Both `outboundCidrAllowlist` and `outboundDomainAllowlist`
 * must be provided" (modal@0.9.0 index.d.ts:8040) — but that is documented as
 * temporary ("This requirement will be relaxed in a future release",
 * index.d.ts:7917-7919). What does not change is the meaning of leaving one
 * out: "`undefined` leaves that dimension unchanged, while a defined value
 * replaces it" (index.d.ts:7913-7915). An omitted list therefore CARRIES OVER
 * whatever the box already had — which for a switch whose whole contract is
 * "replace the policy" is precisely the silent-widening bug: the dimension the
 * new policy never mentions would keep the old policy's allowances. Stating
 * both is what makes the switch a true replace, and it stays correct when
 * partial updates become legal.
 *
 * `blockNetwork` has no runtime form at all, which is why a sealed policy
 * becomes empty lists here: "an empty array blocks all egress for that
 * dimension" (index.d.ts:7913-7915).
 *
 * Built on mapNetworkPolicy so the classification of a destination — what
 * counts as a CIDR, what is rejected for carrying a port — is the SAME code
 * the create path uses. A second copy of that logic is how an update ends up
 * admitting what the create refused.
 *
 * Upstream: harbor modal.py:1236-1249 (`_dynamic_network_kwargs`).
 */
function dynamicNetworkPolicyParams(network?: SandboxCreateOptions["network"]): {
  outboundCidrAllowlist: string[];
  outboundDomainAllowlist: string[];
} {
  if (!network || network.outbound === "open") {
    if (network?.allowedDestinations?.length) {
      throw new Error("network.allowedDestinations is only valid when outbound is blocked");
    }
    // Modal's own wildcards for "everything" — the runtime call has no way to
    // say "unrestricted" other than allowing all of both dimensions.
    return { outboundCidrAllowlist: ["0.0.0.0/0"], outboundDomainAllowlist: ["*"] };
  }
  const mapped = mapNetworkPolicy(network);
  return {
    outboundCidrAllowlist: mapped.outboundCidrAllowlist ?? [],
    outboundDomainAllowlist: withDomainFilteringEnabled(mapped.outboundDomainAllowlist ?? []),
  };
}

/**
 * A domain that can never resolve to anything, used to keep Modal's domain
 * filter TURNED ON while allowing nothing through it.
 *
 * `.invalid` is reserved by RFC 2606 §2 precisely so it can never be
 * delegated, so this admits no real destination — it is a switch position, not
 * an allowance.
 */
const MODAL_DOMAIN_FILTER_SENTINEL = "sealed.invalid";

/**
 * Keep a domain allowlist NON-EMPTY, because on Modal an empty one does not
 * mean "allow no domains" — it means the domain filter was never turned on,
 * and it cannot be turned on later.
 *
 * LIVE-PROVEN, and not something the published types say. A sandbox created
 * with `outboundDomainAllowlist: []` refuses every runtime widening with
 *
 *   FAILED_PRECONDITION: sandbox was created without a domain allowlist;
 *   enabling domain filtering while running is not currently supported;
 *   create the sandbox with domains (* to start by allowing all) to update
 *   them later
 *
 * (modal TaskCommandRouter/TaskSetNetworkAccess, observed 2026-08-14 on a real
 * sandbox). Modal's own suggested remedy — create with `*` — is no use to a
 * box whose first phase must be SEALED: it would grant every domain exactly
 * when the task says none. So the filter is armed with an unresolvable
 * sentinel instead: filtering is on from the start, nothing real is admitted,
 * and the later switch to a real allowlist (or to `*`) is permitted.
 *
 * Applied on the update path too, so a switch BACK to a sealed policy cannot
 * empty the list and strand the box unswitchable for whatever comes after.
 *
 * Upstream has this hole open: harbor's `_dynamic_network_kwargs` returns
 * empty lists for NO_NETWORK (modal.py:1247-1248), so a harbor task whose
 * environment baseline is no-network and whose agent phase is public would
 * fail this same precondition at the switch, with the agent already waiting.
 */
function withDomainFilteringEnabled(domains: string[]): string[] {
  return domains.length > 0 ? domains : [MODAL_DOMAIN_FILTER_SENTINEL];
}

/**
 * Whether this box must be created in the switchable shape: true when any
 * declared phase policy differs from the boot policy. Order and duplicate
 * destinations are not meaning (Modal applies a set), so they are normalized
 * away before comparing — otherwise a caller listing the same hosts in a
 * different order would arm dynamic mode for no reason.
 *
 * Upstream: harbor modal.py:1040-1047 (`_requires_dynamic_network`).
 */
function requiresDynamicNetwork(
  network: SandboxCreateOptions["network"],
  phases: SandboxCreateOptions["phaseNetworkPolicies"]
): boolean {
  if (!phases || phases.length === 0) return false;
  const key = (p?: { outbound: string; allowedDestinations?: string[] }): string =>
    p === undefined
      ? "open|"
      : `${p.outbound}|${[...new Set(p.allowedDestinations ?? [])].sort().join(",")}`;
  const bootKey = key(network);
  return phases.some((phase) => key(phase) !== bootKey);
}

/** Container registry family for an image tag. */
type ImageRegistry = "aws-ecr" | "gcp-artifact-registry" | "registry";

/** Detect which Modal image constructor an image tag needs. */
function resolveImageRegistry(tag: string): ImageRegistry {
  const host = tag.split("/")[0];
  if (/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) {
    return "aws-ecr";
  }
  if (host === "gcr.io" || host.endsWith(".gcr.io") || host.endsWith("-docker.pkg.dev")) {
    return "gcp-artifact-registry";
  }
  return "registry";
}

/**
 * Build a SandboxInfo from a sandbox's tags. Modal exposes no metadata or
 * public timestamps, so image and startedAt come from the tags stamped at
 * create time; for sandboxes not created by this SDK they are empty strings
 * (never fabricated). endAt is always undefined — Modal does not expose it.
 */
function buildSandboxInfo(
  sandboxId: string,
  tags: Record<string, string>,
  fallbackImage?: string
): SandboxInfo {
  const { [TAG_IMAGE]: image, [TAG_STARTED_AT]: startedAt, ...metadata } = tags;
  return {
    sandboxId,
    image: image ?? fallbackImage ?? "",
    metadata,
    startedAt: startedAt ?? "",
  };
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
  image?: string;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
  /** Sandbox lifetime in ms. Modal hard-caps lifetime at 24h (MODAL_MAX_LIFETIME_MS). */
  timeoutMs?: number;
  /**
   * Terminate the sandbox after this long with nothing running in it — the
   * bound that reclaims a box whose client died, without waiting out the whole
   * lifetime. Modal is the only provider with both clocks.
   *
   * OMITTED BY DEFAULT: Modal runs no idle timer unless asked. Modal counts a
   * sandbox active while an exec is running, while its stdin is being written,
   * or while a tunnel connection is open — file operations are not named in
   * that list, and this adapter is safe only because it routes reads and writes
   * through exec (`cat` / `cat >`). A future native filesystem path would need
   * this re-checked.
   */
  idleTimeoutMs?: number;
  workingDirectory?: string;
  /**
   * Per-sandbox compute sizing: cpu in cores, memory in GiB — mapped to
   * Modal's create-time cpu / memoryMiB requests (defaults when omitted:
   * 4 cores / 4 GiB). `disk` is REJECTED with ModalResourcesError: the Modal
   * JS SDK exposes no disk-size parameter, so a specific disk size cannot be
   * enforced (containers get Modal's default disk quota).
   *
   * `gpu` + `gpuTypes` become Modal's "<TYPE>:<count>" GPU reservation
   * ('any' when no types are named; the FIRST type when several — Modal
   * reserves one type per sandbox; the type passes through verbatim and an
   * unknown one gets Modal's own typed rejection at create).
   */
  resources?: ModalCreateResources;
  /**
   * Provider-neutral outbound network policy, enforced by Modal's network
   * stack. "blocked" with no allowedDestinations drops all egress; with
   * allowedDestinations, hostnames go to Modal's domain allowlist (TLS/443
   * only) and IPs/CIDRs to the CIDR allowlist.
   */
  network?: {
    outbound: "open" | "blocked";
    allowedDestinations?: string[];
  };
  /**
   * Every policy `updateNetwork()` may later be asked for on this box.
   *
   * LOAD-BEARING ON MODAL, unlike on the other providers. Modal's create call
   * takes EITHER `blockNetwork: true` OR the two allowlists — each allowlist
   * field is documented "Cannot be used with blockNetwork" (modal@0.9.0
   * index.d.ts:7682-7686) — so the blunt `blockNetwork: true` box this adapter
   * builds for a sealed policy has no allowlist to widen later. When a phase
   * policy here differs from `network`, the adapter creates the box in the
   * switchable shape instead: an empty `outboundCidrAllowlist` — "an empty
   * array blocks all egress for that dimension" (index.d.ts:7913-7915) — plus
   * a domain allowlist holding only the unresolvable sentinel, never an empty
   * one (see withDomainFilteringEnabled: an empty domain list leaves Modal's
   * domain filter switched OFF and unswitchable). Same zero egress, still
   * switchable.
   *
   * Upstream: harbor modal.py:1040-1047 (`_requires_dynamic_network`) and
   * :1169-1171 (`if self._dynamic_network: block_network = False`).
   */
  phaseNetworkPolicies?: Array<{
    outbound: "open" | "blocked";
    allowedDestinations?: string[];
  }>;
  /**
   * Run all commands and file operations as this user (default "user"),
   * enforced via an `su <user> -c` wrapper since Modal executes everything as
   * root. Pass "root" to run directly as root with no wrapper.
   */
  user?: string;
  /** Home directory used by the SDK for agent config paths; not consumed by the provider. */
  homeDir?: string;
}

/** Options for listing sandboxes */
export interface SandboxListOptions {
  /** Modal has no paused state; filters that exclude "running" match nothing. */
  state?: ("running" | "paused")[];
  metadata?: Record<string, string>;
  limit?: number;
}

/**
 * A COMPLETE (or admittedly incomplete) enumeration of the app's fleet.
 *
 * `complete` is the load-bearing field. Callers that need a whole fleet —
 * orphan sweeps, lifecycle reconciliation — read a sandbox's ABSENCE from the
 * list as evidence it is gone, so a truncated walk and a small fleet must never
 * be the same answer. That includes a walk stopped by the caller's own `limit`:
 * "you asked for ten and there are more" is a truncated fleet.
 */
export interface SandboxListPage {
  sandboxes: SandboxInfo[];
  complete: boolean;
  pagesFetched: number;
  error?: string;
}

/**
 * Sandboxes a single enumeration will walk before it gives up and reports
 * itself incomplete. Modal's list is an async generator with no page size we
 * control, so the ceiling is counted in SANDBOXES rather than pages — same
 * purpose as the other providers' page caps: never return a short list that
 * reads like a whole one.
 */
export const MODAL_MAX_LIST_SANDBOXES = 10_000;

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
  updateNetwork(network: {
    outbound: "open" | "blocked";
    allowedDestinations?: string[];
  }): Promise<void>;
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

  /** List sandboxes, walking the whole app. `limit` bounds items returned. */
  list(options?: SandboxListOptions): Promise<SandboxInfo[]>;
  /** The same enumeration for fleet bookkeeping: never throws, reports completeness. */
  listAll(options?: SandboxListOptions): Promise<SandboxListPage>;

  /**
   * Build or pull the sandbox image ahead of time so a later create() does not
   * wait for it. Takes what `create({ image })` takes, resolved by the same
   * path, and defaults to the provider's configured image. Optional on the
   * same terms as the SDK contract: declared so every provider offering it
   * offers the same signature.
   */
  prepareImage?(image?: string): Promise<void>;
}

// ============================================================
// CONFIGURATION
// ============================================================

export interface ModalConfig {
  /** Modal app name. Default: "evolve-sandbox" */
  appName?: string;
  /** Default timeout in ms. Default: 3600000 (1 hour) */
  defaultTimeoutMs?: number;
  /** Modal token ID. Falls back to MODAL_TOKEN_ID env var */
  tokenId?: string;
  /** Modal token secret. Falls back to MODAL_TOKEN_SECRET env var */
  tokenSecret?: string;
  /** Modal API endpoint. Default: https://api.modal.com:443 */
  endpoint?: string;
  /** Docker image name (default: 'evolve-all-<EVOLVE_IMAGE_VERSION>'). Resolved through IMAGE_MAP or used as-is for custom images; explicit names pass through untouched. */
  imageName?: string;
  /**
   * Name of a Modal Secret holding registry credentials for private images.
   * Required for AWS ECR (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
   * AWS_REGION with read-only ECR IAM) and GCP Artifact Registry; optional
   * for private Docker Hub images. Create one at https://modal.com/secrets
   */
  imageSecretName?: string;
}

/** Internal resolved config with required credentials */
interface ResolvedModalConfig {
  tokenId: string;
  tokenSecret: string;
  appName?: string;
  defaultTimeoutMs?: number;
  endpoint?: string;
  imageName?: string;
  imageSecretName?: string;
}

// ============================================================
// IMPLEMENTATION
// ============================================================

export class ModalCommands implements SandboxCommands {
  constructor(private sandbox: Sandbox, private user: string) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    // Wrap command for the configured sandbox user with shell features.
    // Envs are inlined by wrapCommand (su doesn't preserve env like sudo -E).
    const args = wrapCommand(command, this.user, options?.cwd, options?.envs);

    const p = await this.sandbox.exec(args, {
      timeoutMs: options?.timeoutMs,
      // Don't pass envs to exec - they're inlined in the command via wrapCommand
    });

    // Always accumulate output using for-await pattern (more reliable with Modal streams)
    const { stdout, stderr } = await this.accumulateStreams(p, options?.onStdout, options?.onStderr);

    const exitCode = await p.wait();
    return { exitCode, stdout, stderr };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    // Wrap command for the configured sandbox user with shell features.
    // Envs are inlined by wrapCommand (su doesn't preserve env like sudo -E).
    const args = wrapCommand(command, this.user, options?.cwd, options?.envs);
    const p = await this.sandbox.exec(args, {
      timeoutMs: options?.timeoutMs,
      // Don't pass envs to exec - they're inlined in the command via wrapCommand
    });

    // Accumulate streams in background for the wait() call
    let stdoutBuffer = "";
    let stderrBuffer = "";

    // Start streaming in background (non-blocking)
    const streamPromise = this.accumulateStreams(
      p,
      options?.onStdout ? (chunk) => { options.onStdout!(chunk); } : undefined,
      options?.onStderr ? (chunk) => { options.onStderr!(chunk); } : undefined
    ).then(({ stdout, stderr }) => {
      stdoutBuffer = stdout;
      stderrBuffer = stderr;
    }).catch(() => {});

    const processId = `modal-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return {
      processId,
      wait: async () => {
        await streamPromise;
        const exitCode = await p.wait();
        return { exitCode, stdout: stdoutBuffer, stderr: stderrBuffer };
      },
      kill: async () => false, // Modal doesn't expose process kill by PID
    };
  }

  async list(): Promise<ProcessInfo[]> {
    const p = await this.sandbox.exec(["ps", "-eo", "pid,comm,args"], { timeoutMs: 10000 });
    await p.wait();
    const output = await p.stdout.readText();

    const lines = output.trim().split("\n").slice(1);
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

  async connect(_processId: string, _options?: SandboxConnectOptions): Promise<SandboxCommandHandle> {
    throw new Error("Modal does not support connecting to existing processes");
  }

  async sendStdin(_processId: string, _data: string): Promise<void> {
    throw new Error("Modal does not support sendStdin by process ID");
  }

  async kill(processId: string): Promise<boolean> {
    const p = await this.sandbox.exec(["kill", "-9", processId], { timeoutMs: 10000 });
    const exitCode = await p.wait();
    return exitCode === 0;
  }

  /**
   * Accumulate stdout/stderr using for-await pattern (more reliable with Modal streams).
   * Based on vibekit's approach which works correctly with Modal SDK.
   */
  private async accumulateStreams(
    p: ContainerProcess<string>,
    onStdout?: (data: string) => void,
    onStderr?: (data: string) => void
  ): Promise<{ stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";

    const promises: Promise<void>[] = [];

    // Stream stdout using for-await (Modal stream is async iterable)
    promises.push(
      (async () => {
        try {
          // @ts-ignore - Modal stream is async iterable of Uint8Array|string
          for await (const chunk of p.stdout as any) {
            const text = typeof chunk === "string"
              ? chunk
              : new TextDecoder().decode(chunk);
            stdout += text;
            onStdout?.(text);
          }
        } catch {
          // Stream may close unexpectedly
        }
      })()
    );

    // Stream stderr using for-await
    promises.push(
      (async () => {
        try {
          // @ts-ignore - Modal stream is async iterable of Uint8Array|string
          for await (const chunk of p.stderr as any) {
            const text = typeof chunk === "string"
              ? chunk
              : new TextDecoder().decode(chunk);
            stderr += text;
            onStderr?.(text);
          }
        } catch {
          // Stream may close unexpectedly
        }
      })()
    );

    await Promise.all(promises);
    return { stdout, stderr };
  }
}

export class ModalFiles implements SandboxFiles {
  constructor(private sandbox: Sandbox, private user: string) {}

  /**
   * Chown a path to the sandbox user so agent CLIs (running via the su
   * wrapper) can access files created by root-level exec. No-op when the
   * sandbox user is root.
   */
  private async chownToUser(path: string, recursive = false): Promise<void> {
    if (this.user === "root") return;
    const args = recursive
      ? ["chown", "-R", `${this.user}:${this.user}`, path]
      : ["chown", `${this.user}:${this.user}`, path];
    const p = await this.sandbox.exec(args, { timeoutMs: recursive ? 30000 : 10000 });
    await p.wait();
  }

  /**
   * Write a payload to a process's stdin in MODAL_STDIN_CHUNK_BYTES slices.
   * Each writeBytes() call becomes one gRPC TaskExecStdinWrite message and
   * Modal rejects messages over 100MiB, so large files must be chunked
   * (multi-hundred-MB payloads are common).
   */
  private async writeStdinChunked(
    stdin: { writeBytes(data: Uint8Array): Promise<void> },
    data: Uint8Array
  ): Promise<void> {
    for (let offset = 0; offset < data.length; offset += MODAL_STDIN_CHUNK_BYTES) {
      await stdin.writeBytes(data.subarray(offset, offset + MODAL_STDIN_CHUNK_BYTES));
    }
  }

  /**
   * Stream a byte source into a process's stdin, buffering it into
   * MODAL_STDIN_CHUNK_BYTES writes rather than forwarding the source's own
   * chunk size.
   *
   * WHY this exists rather than the SDK's own file copy. Modal documents
   * "convenience APIs for streaming file copies in both directions"
   * (https://modal.com/docs/guide/sandbox-files), but the JS
   * `filesystem.copyFromLocal()` in modal@0.9.0 streams the local file with
   * a bare `createReadStream(localPath)` — Node's default 64KiB highWaterMark
   * — and awaits one unary TaskExecStdinWrite per chunk. Modal's own Python
   * SDK reads TASK_COMMAND_ROUTER_MAX_BUFFER_SIZE (16MiB) per chunk for the
   * same operation, so the 64KiB default is a JS-side omission, not a
   * transport limit. Since the size is not a parameter of copyFromLocal(),
   * the native call cannot be made to send larger messages.
   *
   * Measured, 180MiB payload: 64KiB 311.6s (2880 messages), native
   * copyFromLocal 308.7s, 4MiB 36.2s, 8MiB 30.1s, 16MiB 31.4s. The upload is
   * round-trip bound until roughly 4MiB and throughput bound after it, so the
   * fix is message SIZE rather than which sink receives the bytes — the
   * exec-stdin sink stays and the chunking changes.
   *
   * Peak memory stays at one chunk plus the source's own, never the whole
   * payload: bundles run to hundreds of MB while workers hold many trials in
   * a small heap.
   */
  private async writeStdinCoalesced(
    stdin: { writeBytes(data: Uint8Array): Promise<void> },
    source: AsyncIterable<Uint8Array>
  ): Promise<void> {
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;

    const flush = async (): Promise<void> => {
      if (pendingBytes === 0) return;
      const merged =
        pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      await this.writeStdinChunked(stdin, merged);
    };

    for await (const chunk of source) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= MODAL_STDIN_CHUNK_BYTES) await flush();
    }
    await flush();
  }

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
    const p = await this.sandbox.exec(["cat", path], { timeoutMs: 300000, mode: "binary" });
    const exitCode = await p.wait();
    if (exitCode !== 0) {
      const stderr = await p.stderr.readText();
      throw new Error(`Failed to read file ${path}: ${stderr || `exit code ${exitCode}`}`);
    }
    const bytes = await p.stdout.readBytes();
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
    const data = this.toBuffer(content);
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) await this.makeDir(dir);

    const escapedPath = path.replace(/'/g, "'\\''");
    const p = await this.sandbox.exec(["bash", "-c", `cat > '${escapedPath}'`], { mode: "binary" });

    // Chunked writeBytes(): one gRPC message per chunk, under Modal's 100MiB cap
    await this.writeStdinChunked(p.stdin, new Uint8Array(data));
    const writer = p.stdin.getWriter();
    await writer.close();
    await p.wait();

    // Chown the file to the sandbox user so agent CLIs can access it
    await this.chownToUser(path);
  }

  async writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {
    const tarPack = pack();

    // Collect unique parent directories for chown
    const dirs = new Set<string>();

    for (const file of files) {
      const data = this.toBuffer(file.data);
      const name = file.path.startsWith("/") ? file.path.slice(1) : file.path;
      tarPack.entry({ name }, data);

      // Track parent directories
      const parentDir = file.path.substring(0, file.path.lastIndexOf("/"));
      if (parentDir) {
        dirs.add(parentDir);
      }
    }
    tarPack.finalize();

    const p = await this.sandbox.exec(["tar", "-xf", "-", "-C", "/"], { mode: "binary" });
    // The archive streams into tar's stdin in MODAL_STDIN_CHUNK_BYTES writes
    // (one gRPC message each, under Modal's 100MiB cap) instead of being
    // concatenated into one Buffer first: tar-stream emits the archive as it
    // is packed, so nothing needs to hold every file at once.
    await this.writeStdinCoalesced(p.stdin, tarPack as AsyncIterable<Uint8Array>);
    const writer = p.stdin.getWriter();
    await writer.close();
    await p.wait();

    // Chown all created files and directories to the sandbox user so agent
    // CLIs (running via the su wrapper) can write to them
    if (dirs.size > 0) {
      const dirsArray = Array.from(dirs);
      // Chown the root workspace directory recursively
      const rootDirs = new Set(dirsArray.map(d => d.split("/").slice(0, 4).join("/")));
      for (const dir of rootDirs) {
        await this.chownToUser(dir, true);
      }
    }
  }

  async makeDir(path: string): Promise<void> {
    const p = await this.sandbox.exec(["mkdir", "-p", path], { timeoutMs: 10000 });
    await p.wait();

    // Chown the directory to the sandbox user so agent CLIs can write to it
    await this.chownToUser(path, true);
  }

  async exists(path: string): Promise<boolean> {
    const p = await this.sandbox.exec(["test", "-e", path], { timeoutMs: 10000 });
    const exitCode = await p.wait();
    return exitCode === 0;
  }

  async list(path: string): Promise<FileInfo[]> {
    const escapedPath = path.replace(/'/g, "'\\''");
    const p = await this.sandbox.exec(["bash", "-c", `ls -la '${escapedPath}' | tail -n +2`], { timeoutMs: 30000 });
    await p.wait();
    const output = await p.stdout.readText();

    const entries: FileInfo[] = [];
    for (const line of output.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      const permissions = parts[0];
      const name = parts.slice(8).join(" ");
      if (name === "." || name === "..") continue;

      entries.push({
        name,
        path: path.endsWith("/") ? `${path}${name}` : `${path}/${name}`,
        type: permissions.startsWith("d") ? "dir" : "file",
      });
    }
    return entries;
  }

  async remove(path: string): Promise<void> {
    const p = await this.sandbox.exec(["rm", "-rf", path], { timeoutMs: 30000 });
    await p.wait();
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const p = await this.sandbox.exec(["mv", oldPath, newPath], { timeoutMs: 30000 });
    await p.wait();
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const p = await this.sandbox.exec(["cat", path], { timeoutMs: 300000, mode: "binary" });
    return p.stdout as unknown as ReadableStream<Uint8Array>;
  }

  async writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) await this.makeDir(dir);

    const escapedPath = path.replace(/'/g, "'\\''");
    const p = await this.sandbox.exec(["bash", "-c", `cat > '${escapedPath}'`], { mode: "binary" });

    // Coalesced, not forwarded chunk-for-chunk: a source that yields small
    // pieces (an fs stream's 64KiB default is the common one) would otherwise
    // cost one awaited gRPC round trip each. writeStdinCoalesced also splits
    // anything oversized, so a source yielding >100MiB in one piece still
    // cannot blow Modal's gRPC message cap.
    await this.writeStdinCoalesced(p.stdin, streamToAsyncIterable(stream));

    const writer = p.stdin.getWriter();
    await writer.close();
    await p.wait();

    // Chown the file to the sandbox user so agent CLIs can access it
    await this.chownToUser(path);
  }

  /**
   * Upload a local file by PATH, chunk by chunk into the same `cat >` sink
   * writeStream() uses — so peak memory is one chunk rather than the whole
   * file, which is what makes a large artifact safe under concurrency.
   *
   * The read is sized to MODAL_STDIN_CHUNK_BYTES instead of Node's 64KiB
   * default because every chunk costs one awaited round trip to Modal: the
   * same 180MiB bundle took 311.6s at 64KiB and 30.1s at 8MiB (measured, one
   * sandbox, same file). writeStdinCoalesced would batch a small-chunk stream
   * anyway; asking the filesystem for whole chunks just avoids assembling
   * them from 128 pieces.
   */
  async writeFromPath(sandboxPath: string, localPath: string): Promise<void> {
    const { createReadStream } = await import("node:fs");
    const { Readable } = await import("node:stream");
    const web = Readable.toWeb(
      createReadStream(localPath, { highWaterMark: MODAL_STDIN_CHUNK_BYTES })
    ) as ReadableStream<Uint8Array>;
    await this.writeStream(sandboxPath, web);
  }

  async uploadUrl(_path: string, _expiresInSeconds?: number): Promise<string> {
    throw new Error("Modal does not support pre-signed upload URLs");
  }

  async downloadUrl(_path: string, _expiresInSeconds?: number): Promise<string> {
    throw new Error("Modal does not support pre-signed download URLs");
  }

  async watchDir(
    _path: string,
    _onEvent: (event: FilesystemEvent) => void | Promise<void>,
    _options?: WatchOptions
  ): Promise<WatchHandle> {
    throw new Error("Modal does not support watchDir");
  }

  private toBuffer(content: string | Buffer | ArrayBuffer | Uint8Array): Buffer {
    if (typeof content === "string") return Buffer.from(content, "utf-8");
    if (content instanceof Buffer) return content;
    if (content instanceof ArrayBuffer) return Buffer.from(content);
    if (content instanceof Uint8Array) return Buffer.from(content);
    throw new Error(`Unsupported data type: ${typeof content}`);
  }
}

class ModalSandboxImpl implements SandboxInstance {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
  private readonly image?: string;

  constructor(private sandbox: Sandbox, image: string | undefined, user: string) {
    this.commands = new ModalCommands(sandbox, user);
    this.files = new ModalFiles(sandbox, user);
    this.image = image;
  }

  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  async getHost(port: number): Promise<string> {
    const tunnels = await this.sandbox.tunnels();
    const tunnel = tunnels[port];
    if (!tunnel) throw new Error(`No tunnel found for port ${port}`);
    return tunnel.url;
  }

  async isRunning(): Promise<boolean> {
    try {
      // poll() returns null while running, the exit code once finished
      return (await this.sandbox.poll()) === null;
    } catch {
      return false;
    }
  }

  async getInfo(): Promise<SandboxInfo> {
    // Metadata and startedAt are stamped into tags at create time; Modal has
    // no metadata API and exposes no public timestamps of its own.
    const tags = await this.sandbox.getTags();
    return buildSandboxInfo(this.sandbox.sandboxId, tags, this.image);
  }

  /**
   * Replace the running sandbox's outbound policy — Modal's
   * `Sandbox.updateNetworkPolicy`, "Updates the outbound network policy of a
   * running Sandbox. Established connections that the new policy no longer
   * permits are terminated." (modal@0.9.0 index.d.ts:8035-8042).
   *
   * The policy is mapped by dynamicNetworkPolicyParams — the create path's own
   * classification — so an update can never admit a destination the create
   * would have refused.
   *
   * WHAT THIS CANNOT FIX: a box created with `blockNetwork: true` has no
   * allowlist for Modal to widen, because create refuses the two together
   * (index.d.ts:7682-7686). Declare `phaseNetworkPolicies` at create and the
   * adapter builds the box switchable instead. Modal's refusal in that case is
   * its own error, surfaced verbatim rather than reinterpreted here — guessing
   * at a remote refusal is how a real quota or auth failure gets mislabelled.
   */
  async updateNetwork(network: {
    outbound: "open" | "blocked";
    allowedDestinations?: string[];
  }): Promise<void> {
    await this.sandbox.updateNetworkPolicy(dynamicNetworkPolicyParams(network));
  }

  async kill(): Promise<void> {
    try {
      await this.sandbox.terminate();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      await this.sandbox.terminate();
    }
  }

  async pause(): Promise<void> {
    throw new Error(
      "Modal does not support pause/resume. Persist progress with Evolve checkpoints " +
        "and resume in a fresh sandbox, or use kill() to terminate."
    );
  }
}

export class ModalProvider implements SandboxProvider {
  readonly providerType = "modal" as const;
  readonly name = "Modal";
  private readonly client: ModalClient;
  private readonly appName: string;
  private readonly defaultTimeoutMs: number;
  private readonly imageName: string;
  private readonly imageSecretName?: string;
  private _app: App | undefined;
  /**
   * Sandbox user configured at create time, reapplied on connect() so the su
   * wrapper keeps targeting the same account. In-memory only: a connect()
   * from a fresh process falls back to the default "user" account — callers
   * reconnecting across processes must recreate the provider and sandbox with
   * the same user, or operations on user-owned files fail loudly.
   */
  private readonly sandboxUsers = new Map<string, string>();

  constructor(config: ResolvedModalConfig) {
    // When running inside Modal containers, Modal sets MODAL_SERVER_URL to internal socket.
    // Force external API by overriding env var (SDK ignores endpoint param, only reads env).
    if (!config.endpoint && process.env.MODAL_SERVER_URL?.startsWith("unix:")) {
      process.env.MODAL_SERVER_URL = "https://api.modal.com:443";
    } else if (config.endpoint) {
      process.env.MODAL_SERVER_URL = config.endpoint;
    }
    this.client = new ModalClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret });
    this.appName = config.appName ?? "evolve-sandbox";
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 3600000;
    // Versioned default so a release actually reaches users (see the law
    // comment on EVOLVE_IMAGE_VERSION). An explicit imageName passes through
    // untouched — pinning "evolve-all" keeps meaning "evolve-all".
    this.imageName = config.imageName ?? `evolve-all-${EVOLVE_IMAGE_VERSION}`;
    this.imageSecretName = config.imageSecretName;
  }

  private async getApp(): Promise<App> {
    if (!this._app) {
      // Use client.apps.fromName() - the modern API
      this._app = await this.client.apps.fromName(this.appName, { createIfMissing: true });
    }
    return this._app;
  }

  /**
   * Build a Modal Image for the resolved tag, routing private registries
   * (AWS ECR, GCP Artifact Registry) through the configured Modal Secret.
   *
   * Digest-pinned ECR refs (`<repo>@sha256:<digest>`) are accepted by
   * fromAwsEcr — verified LIVE against Modal 2026-08-21 (built and booted a
   * sandbox from one). Modal's docs never say so (the modal.Image reference
   * describes the parameter only as "Full ECR image URI", tag-form example),
   * so treat the capability as observed behavior, not contract.
   */
  private async resolveImage(tag: string): Promise<Image> {
    const registry = resolveImageRegistry(tag);

    if (registry === "registry") {
      // Public registries need no secret; a configured one enables private Docker Hub images
      const secret = this.imageSecretName
        ? await this.client.secrets.fromName(this.imageSecretName)
        : undefined;
      return this.client.images.fromRegistry(tag, secret);
    }

    if (!this.imageSecretName) {
      throw new Error(
        `Private registry image "${tag}" requires config.imageSecretName — the name of a Modal Secret ` +
          "holding registry credentials (AWS ECR: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION " +
          "with read-only ECR IAM). Create one at https://modal.com/secrets"
      );
    }
    const secret =
      registry === "aws-ecr"
        ? // Modal's own ECR example names these exact keys (modal.Image
          // reference, from_aws_ecr: required_keys=["AWS_ACCESS_KEY_ID",
          // "AWS_SECRET_ACCESS_KEY", "AWS_REGION"]). Asserting them at the
          // lookup makes a mis-provisioned secret fail HERE with the missing
          // key named, instead of as an opaque registry 403 mid-build.
          await this.client.secrets.fromName(this.imageSecretName, {
            requiredKeys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
          })
        : await this.client.secrets.fromName(this.imageSecretName);
    return registry === "aws-ecr"
      ? this.client.images.fromAwsEcr(tag, secret)
      : this.client.images.fromGcpArtifactRegistry(tag, secret);
  }

  /**
   * Resolve a requested image name to the Modal image identity, eagerly
   * building it when it is a registry reference and resolving WITHOUT a build
   * when it is a published Modal image name. The ONE place that resolution
   * happens, because create(), prepareImage() and publishImageAs() drifting
   * apart is a silent failure: the prewarm would populate one image while
   * trials created against another, and nothing would report the mismatch —
   * only the cold-start cost prewarm was meant to remove would quietly come
   * back.
   *
   * "Eagerly builds an Image on Modal" — the SDK's own description of
   * Image.build(app) (modal@0.9.0, dist/index.d.ts). The call is idempotent:
   * the same reference returns the same cached imageId, so the first caller
   * pays the registry pull and later ones resolve quickly.
   */
  private async resolveAndBuildImage(imageName: string): Promise<{ tag: string; image: Image }> {
    // Resolve image name through IMAGE_MAP (e.g., "evolve-all" -> "evolvingmachines/evolve-all")
    const tag = IMAGE_MAP[imageName] ?? imageName;
    // PUBLISHED-NAME BOOT. A bare token (no '/', ':' or '@') that is not an
    // IMAGE_MAP alias may be a name a previous publishImageAs bound; resolving
    // it through images.fromName boots the already-built image with NO app
    // lookup, no registry resolve and no build — Modal's own guidance for
    // Sandboxes ("it's recommended to use Modal's named Images with
    // sandboxes"; from_name references the Image "in a way that's guaranteed
    // to not block on rebuilds" — modal.com/docs/guide/sandbox). A bare name
    // that was never published answers NotFound and stays what it always was:
    // a Docker Hub library ref ("alpine"), resolved below. The one behavior
    // change for such names is precedence — a published name shadows its
    // Docker Hub twin — which is a deliberate act by whoever published it.
    if (!/[/:@]/.test(tag)) {
      try {
        return { tag, image: await this.client.images.fromName(tag) };
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
    }
    const app = await this.getApp();
    const image = await this.resolveImage(tag);
    return { tag, image: await image.build(app) };
  }

  /**
   * Build (or pull) an image on Modal ahead of time, so the sandbox that
   * needs it later does not wait for it.
   *
   * Modal's own guidance: "To avoid blocking creation of new Sandboxes on
   * rebuilding an invalidated Image, it's recommended to use Modal's named
   * Images with sandboxes, rather than using inline Image definitions", and
   * "Use `Image.build` to trigger Image builds as part of a deployment flow
   * or at a regular interval (e.g., in a scheduled job or CI pipeline)"
   * (https://modal.com/docs/guide/sandbox). This is that deployment-flow
   * call: run it at publish time, and trial-time create() finds the image
   * already built.
   *
   * `imageName` takes exactly what `create({ image })` takes and is resolved
   * by the identical path, so callers prewarm the image they will actually
   * run on rather than a reconstruction of it. Omitted, it prewarms the
   * provider's configured default — again what create() would have chosen.
   *
   * There is deliberately no sizing parameter: on Modal, image identity is
   * the registry reference alone, and CPU/memory/GPU are create-time sandbox
   * options, so one eager build serves every sizing.
   *
   * OPERATIONAL TRAP, and prewarming at publish time is what makes it likely.
   * From the same guide: "Modal treats external Image tags as immutable once
   * pulled" and "Modal does not detect upstream changes to mutable tags like
   * `:latest`". So prewarming a MUTABLE tag after re-pushing that tag warms
   * the OLD image, and every later create() keeps launching the old image —
   * quietly, because the reference still resolves. Modal's own remedy is to
   * "update the tag in your deploy script (for example, `ubuntu:24.04` →
   * `ubuntu:24.04-20240523`)".
   *
   * The versioned default (evolve-all-<c-hash>) is immune, because a content
   * change moves the tag. The exposed legacy alias "evolve-all" is NOT: it
   * maps to the mutable Docker Hub name, so prewarming it after a re-push
   * warms the stale image. That alias is precisely why EVOLVE_IMAGE_VERSION
   * exists — prewarm the versioned name unless you specifically want the
   * account's already-pulled copy.
   */
  /**
   * Give a built image OUR name on Modal, so it can be found — and deleted —
   * later by a name this platform minted rather than an id Modal minted.
   *
   * WHY THIS EXISTS. Every other provider hands back a named artifact: an e2b
   * template alias, a daytona snapshot name. Modal's image identity is the
   * registry reference plus an opaque server-side id, and its delete verb
   * (`client.images.delete`) takes the ID — which only exists after a build and
   * is never returned by any lookup we could do later from a reference alone.
   * So a Modal image built for a dataset could never be reclaimed when that
   * dataset was deleted; the platform recorded the honest refusal
   * `store_unsupported` and the images accumulated.
   *
   * `Image.publish(name)` closes that: it binds a stable name to the built
   * image, and `images.fromName(name)` resolves that name back to the id
   * WITHOUT rebuilding (it is a plain `imageGetByTag` lookup). Named, findable,
   * deletable — the same shape the other two providers already have.
   *
   * IDEMPOTENT BY CONSTRUCTION for our use: the alias is a content address, so
   * re-publishing the same alias re-binds it to the image that same content
   * built. A caller that publishes twice names the same bytes twice.
   *
   * The build goes through resolveAndBuildImage, the ONE pair every other path
   * uses, so a published image and the image a trial creates against cannot be
   * different images — the same law prepareImage keeps.
   *
   * MODAL-ONLY, deliberately not on the shared provider interface: e2b and
   * daytona name their artifacts at creation and have nothing to publish. The
   * platform feature-detects this method rather than every provider carrying a
   * verb only one of them can honor.
   */
  async publishImageAs(alias: string, imageName?: string): Promise<string> {
    if (!alias.trim()) {
      throw new Error("publishImageAs requires a non-empty alias to publish under");
    }
    const { image } = await this.resolveAndBuildImage(imageName || this.imageName);
    await image.publish(alias);
    // RETURNS the name it bound, so a caller can assert the name it asked for
    // is the name that now exists. A void return would let a build that
    // published nothing look identical to one that published correctly, and
    // the only symptom would be an image nobody can reclaim months later.
    return alias;
  }

  async prepareImage(imageName?: string): Promise<void> {
    // `||`, not `??`, so an empty string falls back to the default exactly as
    // create()'s `options.image || this.imageName` does. Two different
    // emptiness rules would put the prewarm on a different image than the
    // create it is meant to serve — the one divergence this method exists to
    // prevent.
    await this.resolveAndBuildImage(imageName || this.imageName);
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    // Validate before any network call so misconfigurations fail fast
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    validateTimeout(timeoutMs);
    // Resolved HERE, not at the create call, so an invalid idle bound throws
    // before the app/image round trips like every other validation above.
    const idleParams = mapIdleTimeout(options.idleTimeoutMs);
    // A box whose later phases differ from its boot policy is created in the
    // SWITCHABLE shape (two allowlists, possibly empty) rather than the blunt
    // `blockNetwork: true` one, because Modal refuses to combine the two and a
    // blockNetwork box therefore has nothing to widen later. Same egress at
    // boot either way — see dynamicNetworkPolicyParams. Harbor modal.py:1169-1171.
    // Every DECLARED phase policy is mapped here too, and its result thrown
    // away: mapping is what rejects a destination this provider cannot express
    // (a bad IPv4, a host carrying a port), and a phase policy that only gets
    // mapped at switch time fails with the box up and the agent waiting.
    // Upstream validates the baseline and every phase policy at start for the
    // same reason (harbor environments/base.py:832-836).
    for (const phase of options.phaseNetworkPolicies ?? []) {
      dynamicNetworkPolicyParams(phase);
    }
    const networkParams = requiresDynamicNetwork(options.network, options.phaseNetworkPolicies)
      ? dynamicNetworkPolicyParams(options.network)
      : mapNetworkPolicy(options.network);
    const sizing = mapResources(options.resources);
    const user = options.user ?? DEFAULT_SANDBOX_USER;

    const app = await this.getApp();

    // The SAME resolve-and-build pair prepareImage() calls, so a prewarmed
    // image and the image a trial creates against cannot drift apart.
    const { tag: resolvedImage, image: builtImage } = await this.resolveAndBuildImage(
      options.image || this.imageName
    );

    // Filter out undefined values and only pass env if non-empty
    // Modal SDK throws if env is empty object or contains undefined values
    const filteredEnvs = options.envs
      ? Object.fromEntries(
          Object.entries(options.envs).filter(([, v]) => v !== undefined && v !== null)
        )
      : undefined;
    const env = filteredEnvs && Object.keys(filteredEnvs).length > 0 ? filteredEnvs : undefined;

    // Stamp metadata + Evolve-owned info into tags: Modal has no metadata API
    // and no public timestamps, so tags are the durable record for list()/getInfo()
    const tags: Record<string, string> = {
      ...options.metadata,
      [TAG_IMAGE]: resolvedImage,
      [TAG_STARTED_AT]: new Date().toISOString(),
    };

    // Use client.sandboxes.create() - the modern API
    // Sizing from options.resources (cpu cores / memory GiB -> memoryMiB);
    // defaults preserve the provider's historical 4 CPU / 4 GiB constants.
    const sandbox = await this.client.sandboxes.create(app, builtImage, {
      cpu: sizing.cpu,
      memoryMiB: sizing.memoryMiB,
      // GPU reservation string ("<TYPE>:<count>"), when the caller asked for
      // one — see mapResources.
      ...(sizing.gpu !== undefined ? { gpu: sizing.gpu } : {}),
      timeoutMs,
      ...idleParams,
      workdir: options.workingDirectory,
      env,
      tags,
      ...networkParams,
    });

    // Fix workspace directory ownership (Modal creates it as root, but the
    // sandbox user needs write access). Skipped when running as root.
    if (options.workingDirectory && user !== "root") {
      const chown = await sandbox.exec(
        ["chown", "-R", `${user}:${user}`, options.workingDirectory],
        { timeoutMs: 30000 }
      );
      await chown.wait();
    }

    this.sandboxUsers.set(sandbox.sandboxId, user);

    return new ModalSandboxImpl(sandbox, resolvedImage, user);
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    // Use client.sandboxes.fromId() - the modern API
    const sandbox = await this.client.sandboxes.fromId(sandboxId);
    // Image is recovered lazily from tags in getInfo(); user falls back to the
    // default account when this process didn't create the sandbox.
    const user = this.sandboxUsers.get(sandboxId) ?? DEFAULT_SANDBOX_USER;
    return new ModalSandboxImpl(sandbox, undefined, user);
  }

  /**
   * List sandboxes, walking the whole app.
   *
   * This used to stop at a hardcoded default of 100 regardless of fleet size,
   * which silently truncated any app with more — and said nothing about it
   * while the shared SandboxProvider interface promised exhaustive listing.
   * `limit` still bounds the sandboxes RETURNED, so a caller wanting one cheap
   * sample asks for one; without it the answer is the whole app.
   *
   * The O(N)-round-trips warning below is unchanged and is the reason `limit`
   * matters here more than on the other providers.
   */
  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    const page = await this.walk(options);
    // A walk stopped by the caller's own limit is not a failure; only one that
    // could not finish is. `listAll` reports that distinction instead.
    if (page.error && !page.stoppedAtLimit) throw new Error(page.error);
    return page.sandboxes;
  }

  /**
   * The fleet-bookkeeping enumeration: same walk, never throws.
   *
   * Modal has no lifecycle webhooks, so absence from a list is the ONLY
   * termination signal either lane gets — which makes the difference between
   * "the app is empty" and "the enumeration stopped early" the difference
   * between a quiet fleet and one about to be reclaimed.
   *
   * NOTE the divergence from `listSandboxIds` below, which returns an EMPTY set
   * on failure on the grounds that partial results are worse than none for a
   * terminal-state decision. This one returns what it saw alongside
   * `complete: false`. Both are safe because `complete` is what callers branch
   * on, and the shared type documents the choice; do not align one to the other
   * without deciding which rule you want.
   */
  async listAll(options?: SandboxListOptions): Promise<SandboxListPage> {
    const { stoppedAtLimit: _stoppedAtLimit, ...page } = await this.walk(options);
    return page;
  }

  private async walk(
    options?: SandboxListOptions,
  ): Promise<SandboxListPage & { stoppedAtLimit: boolean }> {
    // Modal has no paused state; a filter that excludes "running" matches nothing
    if (options?.state && !options.state.includes("running")) {
      return { sandboxes: [], complete: true, pagesFetched: 0, stoppedAtLimit: false };
    }

    let app: Awaited<ReturnType<typeof this.getApp>>;
    try {
      app = await this.getApp();
    } catch (err) {
      return {
        sandboxes: [],
        complete: false,
        pagesFetched: 0,
        stoppedAtLimit: false,
        error: `sandbox list failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Scope to our app; tag filter narrows server-side to sandboxes carrying
    // at least the requested metadata.
    return collectSandboxes(
      () => this.client.sandboxes.list({ appId: app.appId, tags: options?.metadata }),
      options?.limit,
    );
  }

  /**
   * Live sandbox ids for the whole app, in ONE streamed call and O(1) round
   * trips — the fleet-bookkeeping counterpart to `list()`.
   *
   * Exists because `list()` cannot be made cheap without dropping metadata from
   * its contract: it owes callers a populated `SandboxInfo.metadata`, and Modal
   * only serves tags per sandbox. Anything that just needs "which ids are
   * alive" — lifecycle polling, orphan sweeps, reconciliation — uses this and
   * pays one request no matter how large the fleet is.
   *
   * `complete` is the load-bearing field, not a nicety: absence from this list
   * is what callers read as "terminated", so a truncated or errored enumeration
   * MUST NOT be mistaken for an empty fleet. A caller that sees complete=false
   * has to leave rows alone rather than mass-marking live sandboxes dead.
   */
  async listSandboxIds(): Promise<{ ids: Set<string>; complete: boolean }> {
    const ids = new Set<string>();
    try {
      const app = await this.getApp();
      for await (const sandbox of this.client.sandboxes.list({ appId: app.appId })) {
        ids.add(sandbox.sandboxId);
      }
      return { ids, complete: true };
    } catch {
      // Partial results are worse than none for a terminal-state decision.
      return { ids: new Set(), complete: false };
    }
  }
}

/** The streamed sandbox surface this walk needs — Modal's list() satisfies it. */
export interface ModalSandboxStream {
  sandboxId: string;
  getTags(): Promise<Record<string, string>>;
}

/**
 * Drain Modal's sandbox generator into one answer, with an honest completeness
 * verdict.
 *
 * Separate from the provider because everything worth getting wrong lives here
 * and none of it needs a gRPC connection: the difference between "the caller
 * asked for ten" and "the app ran out", the ceiling that stops an unbounded
 * walk, and the rule that a failure mid-walk yields what it saw marked
 * INCOMPLETE rather than an exception or a short complete list.
 *
 * COST WARNING — this loop is O(N) ROUND TRIPS, not O(1). `list()` itself is one
 * streamed call, but `getTags()` is a separate gRPC request per sandbox
 * (`sandboxTagsGet`), so listing N sandboxes costs N+1 calls. That is fine for a
 * user listing their handful of boxes with metadata, and NOT fine for fleet-wide
 * bookkeeping: anything that only needs to know WHICH ids are alive must use
 * `listSandboxIds`, never this. Please do not "optimize" by reintroducing tag
 * reads into those paths.
 *
 * Exported for its test (`_testCollectSandboxes`).
 */
async function collectSandboxes(
  iterate: () => AsyncIterable<ModalSandboxStream>,
  wanted?: number,
): Promise<SandboxListPage & { stoppedAtLimit: boolean }> {
  const sandboxes: SandboxInfo[] = [];
  try {
    for await (const sandbox of iterate()) {
      // BOUND CHECKED BEFORE THE PUSH: checked after, `limit: 0` returns one.
      if (wanted !== undefined && sandboxes.length >= wanted) {
        // We are holding a sandbox we did not return, so this app has more than
        // the caller asked for — a truncated fleet, not a complete one.
        return {
          sandboxes,
          complete: false,
          pagesFetched: sandboxes.length,
          stoppedAtLimit: true,
          error: `stopped at the requested limit of ${wanted} with more sandboxes available`,
        };
      }
      if (sandboxes.length >= MODAL_MAX_LIST_SANDBOXES) {
        return {
          sandboxes,
          complete: false,
          pagesFetched: sandboxes.length,
          stoppedAtLimit: false,
          error: `sandbox list exceeded ${MODAL_MAX_LIST_SANDBOXES} sandboxes`,
        };
      }
      const tags = await sandbox.getTags();
      sandboxes.push(buildSandboxInfo(sandbox.sandboxId, tags));
    }
  } catch (err) {
    return {
      sandboxes,
      complete: false,
      pagesFetched: sandboxes.length,
      stoppedAtLimit: false,
      error: `sandbox list failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { sandboxes, complete: true, pagesFetched: sandboxes.length, stoppedAtLimit: false };
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Create Modal sandbox provider.
 *
 * @param config - Optional configuration. If credentials not provided, reads from env vars.
 * @throws Error if credentials cannot be resolved
 *
 * @see https://github.com/evolving-machines-lab/evolve/issues/8
 */
export function createModalProvider(config: ModalConfig = {}): SandboxProvider {
  const tokenId = config.tokenId ?? process.env.MODAL_TOKEN_ID;
  const tokenSecret = config.tokenSecret ?? process.env.MODAL_TOKEN_SECRET;

  if (!tokenId || !tokenSecret) {
    throw new Error(
      "Modal credentials required. " +
        "Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET environment variables, " +
        "or pass tokenId/tokenSecret in config. " +
        "Get your token at https://modal.com/settings/tokens"
    );
  }

  return new ModalProvider({ ...config, tokenId, tokenSecret });
}

// ============================================================
// TEST-ONLY EXPORTS
// ============================================================

export const _testWrapCommand = wrapCommand;
export const _testImageMap = IMAGE_MAP;
export const _testMapNetworkPolicy = mapNetworkPolicy;
export const _testDynamicNetworkPolicyParams = dynamicNetworkPolicyParams;
export const _testRequiresDynamicNetwork = requiresDynamicNetwork;
export const _testMapResources = mapResources;
export const _testResolveImageRegistry = resolveImageRegistry;
export const _testBuildSandboxInfo = buildSandboxInfo;
export const _testCollectSandboxes = collectSandboxes;
export const _testValidateTimeout = validateTimeout;
export const _testMapIdleTimeout = mapIdleTimeout;

/**
 * TYPE-ONLY handle on the concrete sandbox class, for the contract-conformance
 * seam. create() is declared to return the local SandboxInstance INTERFACE, so
 * a seam reading create()'s return type checks the interface and never the
 * class — which let a narrowed method on the class pass unnoticed. Exporting
 * the type (never the constructor) gives the seam the real methods to pin.
 */
export type _testModalSandboxImpl = ModalSandboxImpl;

