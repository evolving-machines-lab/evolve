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

import {
  Daytona,
  Image,
  MAX_PREFIX_LEN,
  STDERR_PREFIX_BYTES,
  STDOUT_PREFIX_BYTES,
} from "@daytonaio/sdk";
import type { Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import { resolve4 } from "node:dns/promises";

// ============================================================
// CONSTANTS
// ============================================================

/**
 * The Evolve image release this package defaults to — DERIVED, never
 * hand-written: `c-<12hex>`, the sha256 of the image's build inputs (the
 * Dockerfile plus everything the build copies in, see
 * assets/docker/image-digest.ts). `npm run generate:image-version` (repo
 * root) rewrites ./image-version.ts here and its two generated siblings
 * (assets/docker/image-version.ts, packages/modal/src/image-version.ts);
 * the published packages ship standalone, so each carries the value as a
 * checked-in constant. The coherence test in
 * packages/daytona/tests/unit/daytona-image-version.test.ts recomputes the
 * digest and fails the suite whenever a checked-in copy is stale.
 *
 * WHY a per-release tag at all: Daytona and Modal cache the image by NAME. A
 * mutable :latest is pulled once and never again, so a pushed update reached
 * nobody. A content change moves the derived tag, which moves the default
 * snapshot name, and the ensure logic in create() builds the new snapshot
 * from the new tag on first use.
 */
import { EVOLVE_IMAGE_VERSION } from "./image-version";
export { EVOLVE_IMAGE_VERSION };

/** Map generic image names to Daytona Docker images */
const IMAGE_MAP: Record<string, string> = {
  // The derived default: what a fresh `evolve-all-c-<12hex>` snapshot is built from.
  [`evolve-all-${EVOLVE_IMAGE_VERSION}`]: `evolvingmachines/evolve-all:${EVOLVE_IMAGE_VERSION}`,
  // The legacy unversioned name. A caller who pins "evolve-all" explicitly
  // keeps resolving exactly what they always did — their existing snapshot,
  // or a build from the mutable :latest tag.
  "evolve-all": "evolvingmachines/evolve-all",
};

/**
 * Daytona's hard cap on network allowlist size (validated server-side too).
 * Policies that resolve to more CIDRs throw DaytonaNetworkPolicyError.
 */
/**
 * Minutes a STOPPED sandbox is kept before Daytona deletes it. Long enough that
 * a stop nobody ordered leaves something to look at and something to collect
 * from; short enough that it is never a way to hold billable state.
 */
export const DAYTONA_AUTO_DELETE_GRACE_MINUTES = 10;

export const DAYTONA_MAX_NETWORK_ALLOWLIST = 10;

/**
 * How long a reactivated snapshot may take to come back before create() gives
 * up. Daytona deactivates any snapshot unused for two weeks (official docs:
 * "Snapshots automatically become inactive after 2 weeks of not being used"),
 * so exists-but-inactive is the steady state of every image that shipped more
 * than a fortnight before its next user — reactivation is a pull, not a build,
 * and one that outlives this bound is a provider incident worth a loud error.
 */
export const DAYTONA_SNAPSHOT_ACTIVATE_TIMEOUT_MS = 180_000;

const DAYTONA_SNAPSHOT_ACTIVATE_POLL_MS = 2_000;

/**
 * Sandboxes requested per list page. Held at the value every provider in this
 * lineup accepts, so one number is valid everywhere a fleet is enumerated.
 */
export const DAYTONA_LIST_PAGE_SIZE = 100;

/**
 * Page ceiling for one enumeration — 10,000 sandboxes at the page size above.
 * A walk that reaches it stops and reports itself INCOMPLETE, because the one
 * thing a fleet enumeration may never do is return a short list that reads like
 * a whole one.
 */
export const DAYTONA_MAX_LIST_PAGES = 100;

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

/**
 * Typed error for an idle timeout Daytona cannot take as a SEPARATE bound.
 * Daytona has no absolute lifetime at all: auto-stop is an inactivity clock and
 * it is the only one there is, so `timeoutMs` is already mapped onto it. A
 * second option pointing at the same knob could only contradict the first.
 */
export class DaytonaIdleTimeoutError extends Error {
  constructor() {
    super(
      "Daytona has no separate idle timeout: auto-stop IS its only clock and it already " +
        "measures inactivity, so `timeoutMs` is what sets it (autoStopInterval). Set the " +
        "inactivity bound with `timeoutMs`; a hard bound on the process itself is enforced " +
        "in-box instead (see withInBoxTimeout)."
    );
    this.name = "DaytonaIdleTimeoutError";
  }
}

/**
 * Typed error for a snapshot that exists but could not be brought back to
 * `active`. This is a final verdict, not a build trigger: the snapshot IS
 * there, so rebuilding under the same name can only fail on the name conflict
 * and then mask the real problem behind a slow direct image pull.
 */
export class DaytonaSnapshotActivationError extends Error {
  /** The snapshot that would not activate. */
  readonly snapshot: string;

  constructor(snapshot: string, detail: string) {
    super(
      `Daytona snapshot "${snapshot}" exists but could not be activated: ${detail}. ` +
        "Daytona deactivates snapshots unused for 2 weeks; activation normally completes in " +
        "seconds. Retry, or activate it manually in the Daytona dashboard (Snapshots page)."
    );
    this.name = "DaytonaSnapshotActivationError";
    this.snapshot = snapshot;
  }
}

/**
 * The slice of the Daytona client the reactivation path touches — structural,
 * so the unit tests can drive it with a plain mock.
 */
interface SnapshotActivationClient {
  snapshot: {
    get(name: string): Promise<{ state?: string }>;
    activate(snapshot: unknown): Promise<{ state?: string }>;
  };
}

/**
 * Bring an exists-but-inactive snapshot back to `active`, or say loudly why
 * not. Activation is asynchronous on Daytona's side — the activate call may
 * answer with a transitional state (`pulling`) — so the result is polled until
 * it lands on `active`, a terminal failure state, or the deadline.
 */
async function activateSnapshot(
  client: SnapshotActivationClient,
  name: string,
  snapshot: { state?: string },
  timing?: { timeoutMs?: number; pollMs?: number },
): Promise<{ state?: string }> {
  const timeoutMs = timing?.timeoutMs ?? DAYTONA_SNAPSHOT_ACTIVATE_TIMEOUT_MS;
  const pollMs = timing?.pollMs ?? DAYTONA_SNAPSHOT_ACTIVATE_POLL_MS;

  console.log(`[daytona] Snapshot "${name}" is inactive (unused for 2+ weeks) — reactivating...`);
  let current: { state?: string };
  try {
    current = await client.snapshot.activate(snapshot);
  } catch (err) {
    throw new DaytonaSnapshotActivationError(
      name,
      `the activate call failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (current?.state !== "active") {
    if (current?.state === "error" || current?.state === "build_failed") {
      throw new DaytonaSnapshotActivationError(name, `it entered state "${current.state}"`);
    }
    if (Date.now() >= deadline) {
      throw new DaytonaSnapshotActivationError(
        name,
        `still "${current?.state ?? "unknown"}" after ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
    // The poll get wears the same typed error as the activate call: a raw
    // network failure here would escape create()'s typed-refusal checks and
    // fall into the build path — name-conflict on the existing snapshot, then
    // the slow direct pull that masks the real incident.
    try {
      current = await client.snapshot.get(name);
    } catch (err) {
      throw new DaytonaSnapshotActivationError(
        name,
        `the activation poll failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  console.log(`[daytona] Snapshot "${name}" reactivated.`);
  return current;
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
 * Enforce the timeout INSIDE the box, on BOTH execution paths. Daytona has no
 * fixed sandbox lifetime, and its auto-stop timer measures INACTIVITY over SDK
 * interactions ("no new events ... state changes or interactions with the
 * Sandbox through the sdk"), so it bounds nothing that matters here: while a
 * client is polling, that polling is itself an interaction and resets the clock,
 * and once the client is gone the box still runs for the whole remaining
 * interval before it merely STOPS. e2b and Modal both take an absolute,
 * server-side lifetime; Daytona takes none.
 *
 * The session API's timeout argument does not close the hole on either path.
 * spawn launches with runAsync:true, where that argument bounds the *call*, not
 * the process, and the only deadline is a client-side poll in wait(). run blocks
 * with runAsync:false, where the argument is documented as how long to WAIT for
 * the command — and it is this process that waits, so a wait that ends because
 * this process died is not a kill.
 *
 * coreutils `timeout` closes it for both: the kernel kills the command whether
 * or not anything is still watching, and exits 124 — the same code wait()'s own
 * deadline and the e2b adapter return, so a timeout means one thing across every
 * provider and both paths. The script is passed base64 -> file so no quoting of
 * the caller's command is ever attempted, and a box without coreutils degrades
 * to the un-timed run rather than failing outright (the client-side deadlines
 * still cover the case where a client is alive to enforce them).
 *
 * IT FAILS CLOSED ON A BAD DECODE, and that is not a nicety. `>` creates the
 * file before the pipeline runs, so on an image with no `base64` the decode
 * fails and leaves a ZERO-BYTE script — and `bash <empty>` exits 0 having
 * printed nothing. This wrapper would then have turned a command that used to
 * fail loudly into one that reports success with empty output, on exactly the
 * images where it breaks: the eval artifact listing is itself a
 * `find ... | base64 -w0`, so a box missing base64 failed that listing outright
 * before this wrapper existed, and would afterwards have returned an empty
 * listing instead — no files, no patch, and a clean exit all the way up. So the
 * decode is chained with `&&` and the script is size-checked before bash is
 * handed it; either way out is exit 126, which is nonzero and therefore visible
 * to every caller that checks.
 */
function withInBoxTimeout(wrapped: string, timeoutSec?: number): string {
  if (!timeoutSec || timeoutSec <= 0) return wrapped;
  const encoded = Buffer.from(wrapped).toString("base64");
  const path = `/tmp/.evolve-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`;
  // RUN IT IN A CHILD SHELL. The whole thing is handed to `sh -c` rather than
  // appended to the session's own shell, because the script has to end by
  // propagating the timed command's status — and an `exit` evaluated by the
  // SESSION shell terminates the session itself, after which Daytona never
  // records the command as finished: the poll in wait() spins until the client
  // deadline, and a blocking run() never learns its exit code at all. Measured:
  // a bare `echo hello` came back exit 124 after 31s that way, while the same
  // command without this wrapper returned in 1.4s.
  // Single-quoted, and the body deliberately contains no single quote of its
  // own (the payload is base64) so no escaping is required.
  // 126 is the conventional "found but could not execute" status, and it is
  // what a non-executable script would exit with anyway — so it is NOT a
  // private signal and nothing should branch on the value. NONZERO is the
  // load-bearing property: every caller that checks an exit code sees a failure
  // instead of a success with empty output.
  const inner =
    `echo ${encoded} | base64 -d > ${path} && [ -s ${path} ] || ` +
    `{ rm -f ${path}; exit 126; }; ` +
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
    // AN EXPLICIT OPEN POLICY IS SENT, NOT OMITTED. Both cases leave the box
    // with unrestricted egress, and Daytona's default is already unrestricted,
    // so networkBlockAll:false changes no behaviour whatsoever. What it changes
    // is the EVIDENCE: a create body carrying networkBlockAll:false says
    // "someone decided this box may reach the internet", while a body carrying
    // no network fields at all is indistinguishable from a caller who forgot.
    // Reading an audit log of the second kind, there is no way to tell an
    // intended open box from a dropped policy — which is exactly the question
    // an audited open sandbox raises, and exactly the question we could not
    // answer on 2026-07-26 about a real create. A caller that passes no policy
    // still gets today's empty body, because in direct mode that IS the
    // documented default and refusing it would break every existing program;
    // the eval lane forbids reaching that state on its own side instead.
    return network ? { networkBlockAll: false } : {};
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
  /**
   * REJECTED with DaytonaIdleTimeoutError — not for want of an idle clock, but
   * because auto-stop is the ONLY clock Daytona has and `timeoutMs` is already
   * mapped onto it (autoStopInterval). Two options, one knob.
   */
  idleTimeoutMs?: number;
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

/**
 * A COMPLETE (or admittedly incomplete) enumeration of the organization's fleet.
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
  /** List sandboxes, paginating to exhaustion. `limit` bounds items returned. */
  list(options?: SandboxListOptions): Promise<SandboxInfo[]>;
  /** The same enumeration for fleet bookkeeping: never throws, reports completeness. */
  listAll(options?: SandboxListOptions): Promise<SandboxListPage>;
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
  /** Daytona snapshot name (default: 'evolve-all-<EVOLVE_IMAGE_VERSION>' direct, the platform's stable 'evolve-all' managed). Explicit names pass through untouched. Create custom snapshots via `cd assets && ./build.sh daytona` */
  snapshotName?: string;
  /**
   * Evolve-managed toolbox base URL. Setting it puts the provider in MANAGED
   * mode, where `apiKey` is an Evolve API key rather than a Daytona one and
   * both planes ride the Dashboard.
   *
   * One field rather than a separate `managed: true` because the two effects
   * have one cause: if the toolbox belongs to the platform, so do the
   * snapshots behind it, so managed creates name an existing platform snapshot
   * and never build one. Resolved by the Evolve SDK; direct/BYO callers leave
   * it unset.
   *
   * @internal
   */
  managedToolboxUrl?: string;
}

interface ResolvedDaytonaConfig {
  apiKey: string;
  apiUrl?: string;
  target?: string;
  defaultTimeoutMs?: number;
  snapshotName?: string;
  managedToolboxUrl?: string;
}

// ============================================================
// EVOLVE-MANAGED MODE
// ============================================================

/**
 * Daytona is a TWO-PLANE provider, and that is the whole reason this section
 * exists.
 *
 * `apiUrl` covers the control plane only. Everything an agent actually does —
 * every command, every file read and write — goes to a per-sandbox runner the
 * SDK discovers by calling GET /sandbox/{id}/toolbox-proxy-url and then talks
 * to DIRECTLY (@daytonaio/sdk/src/Daytona.js:409-419, Sandbox.js:569-578). So
 * pointing `apiUrl` at the Evolve Dashboard, the way the managed E2B lane
 * points E2B's, captures create and list and nothing an agent does.
 *
 * Managed mode closes that by answering the discovery call locally with the
 * Dashboard's own toolbox route, so the client builds
 * `<dashboard>/api/managed/daytona/toolbox/<sandboxId>/…` for exactly the
 * paths it would otherwise have sent to Daytona's runner. The client is not
 * patched and no path is rewritten: the base URL is the only thing that moves,
 * which is the same seam the control plane already uses.
 */
class ManagedDaytona extends Daytona {
  constructor(
    config: { apiKey: string; apiUrl?: string; target?: string },
    private readonly managedToolboxUrl: string,
  ) {
    super(config);
  }

  /**
   * Answered locally, never upstream. The real discovery call would hand back
   * Daytona's runner host, which a managed caller has no credential for — the
   * account key that opens it lives gateway-side and never reaches an SDK
   * process. The Dashboard resolves that host itself, per sandbox, and
   * forwards with a per-sandbox token.
   */
  override async getProxyToolboxUrl(): Promise<string> {
    return this.managedToolboxUrl;
  }
}

/** What a managed sandbox's streaming log follow needs to reach the Dashboard. */
interface ManagedStreamContext {
  toolboxUrl: string;
  apiKey: string;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(left.length + right.length));
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Split Daytona's multiplexed command log into stdout and stderr as the bytes
 * arrive.
 *
 * The wire format is one byte stream with 3-byte markers announcing which
 * stream the following bytes belong to (STDOUT_PREFIX_BYTES /
 * STDERR_PREFIX_BYTES, both exported by the Daytona SDK — this reads their
 * framing, it does not invent one). Two things make a streaming demux
 * different from the SDK's whole-buffer one: a marker can be split across two
 * chunks, so the last MAX_PREFIX_LEN-1 bytes are always held back rather than
 * emitted; and a multi-byte UTF-8 character can be split too, so each stream
 * keeps its own decoder in streaming mode.
 */
function createLogDemuxer(
  onStdout: (chunk: string) => void,
  onStderr: (chunk: string) => void,
) {
  const stdoutDecoder = new TextDecoder("utf-8");
  const stderrDecoder = new TextDecoder("utf-8");
  let buffer = new Uint8Array(0);
  // Starts at stdout rather than "unknown". A framed stream opens with a
  // marker, so nothing precedes it and this costs nothing; an UNFRAMED one
  // (see readCommandStreams — some daemon builds return combined bytes with no
  // markers at all) would otherwise be dropped byte for byte and reported as a
  // command that printed nothing.
  let current: "stdout" | "stderr" = "stdout";

  const emit = (bytes: Uint8Array) => {
    if (bytes.length === 0) return;
    if (current === "stdout") onStdout(stdoutDecoder.decode(bytes, { stream: true }));
    else onStderr(stderrDecoder.decode(bytes, { stream: true }));
  };

  return {
    push(chunk: Uint8Array) {
      buffer = concatBytes(buffer, chunk);
      for (;;) {
        const stdoutAt = indexOfBytes(buffer, STDOUT_PREFIX_BYTES, 0);
        const stderrAt = indexOfBytes(buffer, STDERR_PREFIX_BYTES, 0);
        let at = -1;
        let next: "stdout" | "stderr" = "stdout";
        let markerLen = 0;
        if (stdoutAt !== -1 && (stderrAt === -1 || stdoutAt < stderrAt)) {
          at = stdoutAt;
          next = "stdout";
          markerLen = STDOUT_PREFIX_BYTES.length;
        } else if (stderrAt !== -1) {
          at = stderrAt;
          next = "stderr";
          markerLen = STDERR_PREFIX_BYTES.length;
        }

        if (at === -1) {
          // No complete marker in the buffer. Emit everything that cannot be
          // the start of one and keep the rest for the next chunk.
          const safe = Math.max(0, buffer.length - (MAX_PREFIX_LEN - 1));
          emit(buffer.subarray(0, safe));
          buffer = buffer.slice(safe);
          return;
        }

        emit(buffer.subarray(0, at));
        current = next;
        buffer = buffer.slice(at + markerLen);
      }
    },
    flush() {
      emit(buffer);
      buffer = new Uint8Array(0);
      const stdoutTail = stdoutDecoder.decode();
      if (stdoutTail) onStdout(stdoutTail);
      const stderrTail = stderrDecoder.decode();
      if (stderrTail) onStderr(stderrTail);
    },
  };
}

/**
 * Follow a session command's logs over plain HTTP.
 *
 * The Daytona SDK follows logs over a WEBSOCKET (Process.js:289 rewrites the
 * toolbox base to ws:// and opens a socket). A managed sandbox's toolbox base
 * is a Next.js route handler, and a Next route handler never sees a websocket
 * upgrade — the codebase's one websocket proxy lives in a separate custom
 * server for exactly that reason. So managed mode cannot use that transport.
 *
 * It does not have to. MEASURED 2026-07-26 against a live sandbox: the same
 * endpoint with `?follow=true` over ordinary HTTP answers 200 with
 * `transfer-encoding: chunked` and `content-type: application/octet-stream`,
 * and chunks arrive as the command produces them — 95 ms, 1045 ms, 2127 ms,
 * 2984 ms, 3976 ms for a command printing one line per second. That is real
 * streaming through a plain response body, which is what the Dashboard route
 * pipes through unbuffered.
 */
async function followManagedSessionLogs(
  context: ManagedStreamContext,
  sandboxId: string,
  sessionId: string,
  commandId: string,
  onStdout: (chunk: string) => void,
  onStderr: (chunk: string) => void,
): Promise<void> {
  const url =
    `${context.toolboxUrl.replace(/\/+$/, "")}/${encodeURIComponent(sandboxId)}` +
    `/process/session/${encodeURIComponent(sessionId)}` +
    `/command/${encodeURIComponent(commandId)}/logs?follow=true`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${context.apiKey}`,
      accept: "application/octet-stream",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Daytona managed log follow failed: ${response.status} ${await response.text()}`,
    );
  }
  if (!response.body) return;

  const demuxer = createLogDemuxer(onStdout, onStderr);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) demuxer.push(value);
    }
  } finally {
    demuxer.flush();
    await reader.cancel().catch(() => undefined);
  }
}

// ============================================================
// IMPLEMENTATION
// ============================================================

/**
 * Read a command's streams out of whatever shape Daytona returned.
 *
 * Session logs are USUALLY framed with per-stream markers, and the Daytona
 * SDK's demux returns "" for a stream whose marker never appears. An empty
 * string is not "this command printed nothing" — it means "this daemon build
 * did not frame the output" — and `??` does not fall through an empty string,
 * so reading `stdout ?? output` silently reports every such command as silent.
 *
 * Measured 2026-07-26 on a live sandbox booted from ubuntu:22.04: a command
 * printing one line to each stream came back as
 * {output: "hello-managed\noops\n", stdout: null, exitCode: 0} with no marker
 * bytes anywhere in the log body, and the provider reported exit 0 with empty
 * stdout. Unframed output goes to stdout, because that is what the combined
 * `output` field is; a framed response is untouched.
 */
function readCommandStreams(source: {
  stdout?: string | null;
  stderr?: string | null;
  output?: string | null;
}): { stdout: string; stderr: string } {
  const stdout = source.stdout || "";
  const stderr = source.stderr || "";
  const combined = source.output || "";
  if (!stdout && !stderr && combined) return { stdout: combined, stderr: "" };
  return { stdout, stderr };
}

export class DaytonaCommands implements SandboxCommands {
  constructor(
    private sandbox: DaytonaSandbox,
    private user?: string,
    private managedStream?: ManagedStreamContext,
  ) {}

  /**
   * Stream a command's output to callbacks. Direct mode uses the Daytona
   * SDK's own follow, which is a websocket; managed mode uses the HTTP
   * chunked follow, because a Dashboard route handler cannot terminate a
   * websocket upgrade (see followManagedSessionLogs).
   */
  private followLogs(
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void> {
    if (this.managedStream) {
      return followManagedSessionLogs(
        this.managedStream,
        this.sandbox.id,
        sessionId,
        commandId,
        onStdout,
        onStderr,
      );
    }
    return this.sandbox.process.getSessionCommandLogs(
      sessionId,
      commandId,
      onStdout,
      onStderr,
    ) as Promise<void>;
  }

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    const timeoutSec = options?.timeoutMs ? Math.floor(options.timeoutMs / 1000) : undefined;

    // Always use ephemeral session for reliable stdout/stderr capture.
    // Daytona's executeCommand API can return empty output in some cases.
    // Session-based execution with explicit log retrieval is most reliable.
    const sessionId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.sandbox.process.createSession(sessionId);

    try {
      // A streaming caller needs output WHILE the command runs, and a
      // blocking execute holds every byte until exit — the campaign measured
      // a 10s command whose whole output landed in one burst after
      // completion (J5) while e2b/modal streamed within ~2s. So with
      // callbacks the command runs ASYNC and the live follow (direct = the
      // SDK's websocket, managed = the HTTP chunked follow) delivers chunks
      // as they are produced. Without callbacks the blocking execute stays:
      // one round trip, exit code inline.
      const streaming = Boolean(options?.onStdout || options?.onStderr);
      // The third argument stays the wait bound of a blocking execute, and
      // withInBoxTimeout is what survives this process dying while it waits
      // (see the wrapper's header). Both are the caller's own timeout, so
      // whichever fires first, nothing outlives it.
      const resp = await this.sandbox.process.executeSessionCommand(sessionId, {
        command: withInBoxTimeout(
          wrapCommand(command, options?.cwd, options?.envs, this.user),
          timeoutSec
        ),
        runAsync: streaming,
      }, timeoutSec);

      const cmdId = resp.cmdId;

      if (streaming && cmdId) {
        // The streamed chunks ARE the result: they reach the callbacks live
        // and accumulate into the returned stdout/stderr. The follow stream
        // closes when the command ends (the in-box timeout bounds a runaway),
        // and the exit code lands on the session command right after.
        let stdout = "";
        let stderr = "";
        await this.followLogs(
          sessionId,
          cmdId,
          (chunk) => {
            stdout += chunk;
            options?.onStdout?.(chunk);
          },
          (chunk) => {
            stderr += chunk;
            options?.onStderr?.(chunk);
          },
        );
        for (let attempt = 0; ; attempt++) {
          const cmd = await this.sandbox.process.getSessionCommand(sessionId, cmdId);
          if (cmd.exitCode !== undefined) {
            return { exitCode: cmd.exitCode, stdout, stderr };
          }
          if (attempt >= 20) {
            throw new Error(
              `Daytona reported no exit code for command ${cmdId} after its log stream closed`
            );
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      // Try inline output first; if empty and we have cmdId, fetch logs explicitly
      let { stdout, stderr } = readCommandStreams(resp);
      if (!stdout && !stderr && cmdId && !options?.onStdout) {
        try {
          const logs = await this.sandbox.process.getSessionCommandLogs(sessionId, cmdId);
          const fromLogs = readCommandStreams(logs as any);
          stdout = fromLogs.stdout;
          stderr = fromLogs.stderr || stderr;
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
      this.followLogs(
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
                  ...readCommandStreams(logs as any),
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
            // A poll that 404s ends the wait — but WHICH thing vanished decides
            // what the caller should do next, and reporting the wrong one costs
            // hours. A deleted SESSION is an interrupt: kill() and interrupt()
            // both delete the session out from under this loop, the sandbox is
            // still there, and anything the caller wants to collect afterwards
            // still can be. A deleted SANDBOX is an infrastructure event: the
            // box is gone, every later file read and command will fail too, and
            // the run did not "terminate" so much as have its machine removed.
            //
            // Both used to answer "session terminated", which is how a trial
            // whose sandbox had been deleted mid-run (measured 2026-07-26: the
            // box disappeared at 6m57s, this loop reported exit -1 "session
            // terminated" within its next 500ms poll, and the artifact collect
            // that followed failed with "sandbox not found") sent its reader
            // looking at the harness for a fault that was never there.
            //
            // Discriminated on the upstream's own noun, which it does supply:
            // Daytona's 404 for the box says "sandbox not found" verbatim —
            // that exact string is what the collect step surfaced in the same
            // incident. The exit code stays -1 in both cases so no caller's
            // adjudication changes; only the reason does.
            if (msg.includes("not found")) {
              // ASK THE API rather than parse the message. A 404's wording is
              // the vendor's to change, and the two cases are far enough apart
              // to be worth one extra call on an error path that has already
              // ended the wait: refreshData() succeeding proves the box is
              // still there and only the session went, while it failing the
              // same way proves the box itself is gone.
              let sandboxGone = msg.includes("sandbox");
              try {
                await sandbox.refreshData();
                sandboxGone = false;
              } catch (probeError) {
                const probeMsg =
                  probeError instanceof Error
                    ? probeError.message.toLowerCase()
                    : String(probeError).toLowerCase();
                if (probeMsg.includes("not found")) sandboxGone = true;
              }
              return {
                exitCode: -1,
                stdout: "",
                stderr: sandboxGone ? "sandbox deleted during run" : "session terminated",
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
    // Evidence: Daytona SDK downloadFile(remotePath) returns Buffer.
    // Text-vs-binary is decided from CONTENT, never from the file's name:
    // the SandboxFiles contract is "read returns string | Uint8Array", and
    // an extension table cannot keep that honest — binary bytes under an
    // unlisted extension (.bin) would ride a lossy text decode and come back
    // U+FFFD-mangled. A NUL byte marks binary (the platform's agent-home
    // sniff, git's own heuristic); everything else must survive a STRICT
    // UTF-8 decode (fatal, BOM preserved) to come back as a string. Both
    // answers are therefore byte-exact: a returned string re-encodes to the
    // identical bytes, a returned Uint8Array IS the bytes.
    const bytes = new Uint8Array(await this.sandbox.fs.downloadFile(path));
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

  constructor(
    private sandbox: DaytonaSandbox,
    user?: string,
    managedStream?: ManagedStreamContext,
  ) {
    this.commands = new DaytonaCommands(sandbox, user, managedStream);
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

  /** Set only in Evolve-managed mode; see the EVOLVE-MANAGED MODE section. */
  private readonly managedStream?: ManagedStreamContext;

  constructor(config: ResolvedDaytonaConfig) {
    const clientConfig = {
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      target: config.target,
    };
    this.client = config.managedToolboxUrl
      ? new ManagedDaytona(clientConfig, config.managedToolboxUrl)
      : new Daytona(clientConfig);
    if (config.managedToolboxUrl) {
      this.managedStream = { toolboxUrl: config.managedToolboxUrl, apiKey: config.apiKey };
    }
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 3600000;
    // Two defaults, one per mode. DIRECT mode defaults to the versioned
    // snapshot so a release actually reaches users (see the law comment on
    // EVOLVE_IMAGE_VERSION) — the ensure logic below builds it on first use.
    // MANAGED mode names the PLATFORM's stable "evolve-all" snapshot: managed
    // creates never build, the platform owns which release backs that name,
    // and its warm keeper keeps exactly that name active. An explicit
    // snapshotName passes through untouched in both modes — pinning
    // "evolve-all" keeps meaning "evolve-all".
    this.snapshotName =
      config.snapshotName ??
      (config.managedToolboxUrl ? "evolve-all" : `evolve-all-${EVOLVE_IMAGE_VERSION}`);
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    // Provider law: reject what cannot be enforced, never silently ignore.
    // Daytona's refusal is the opposite of e2b's: it is not that there is no
    // idle clock, it is that the idle clock is the ONLY one, and timeoutMs is
    // already mapped onto it (autoStopInterval, below). Honouring both would be
    // two options steering one knob.
    if (options.idleTimeoutMs !== undefined) throw new DaytonaIdleTimeoutError();

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
    // So `timeoutMs` is a MISNOMER on this provider, and worth naming as one at
    // the line that makes it true: the number below is an idle clock, not a
    // lifetime. `timeoutMs: 3_600_000` means "stop after an hour of doing
    // nothing", never "stop after an hour".
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const autoStopMinutes = Math.max(1, Math.ceil(timeoutMs / 60000)); // Min 1 minute
    const imageName = options.image || this.snapshotName;

    const baseParams = {
      envVars: options.envs,
      labels: options.metadata,
      autoStopInterval: autoStopMinutes,
      // Delete a stopped box after a short GRACE, not instantly. The reason for
      // reclaiming at all is unchanged — a stopped box lingers as billable
      // state that nothing is watching, because the eval worker's reaper only
      // kills boxes it still has a DB row for and a stopped-but-kept sandbox
      // outlives that row — but 0 meant "delete immediately upon stopping",
      // which turns ANY stop into instant, unrecoverable loss of a box whose
      // work has not been collected yet.
      //
      // That is not hypothetical. On 2026-07-26 a box ceased to exist mid-run
      // and the artifact collect that followed had nothing to read; because the
      // box was already deleted rather than merely stopped, there was no state
      // left to inspect and the cause could not be attributed at all. A stop we
      // did not order is exactly when the box is worth keeping for a few
      // minutes.
      //
      // Nothing depends on instant deletion: the phase's own finally-kill, the
      // eval reaper, and the provider's inactivity TTL all still reclaim, and
      // they run in minutes, not hours.
      autoDeleteInterval: DAYTONA_AUTO_DELETE_GRACE_MINUTES,
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

    // Managed mode never builds. Snapshots are platform artifacts on the
    // Evolve organization's Daytona account: a managed caller who could
    // trigger a build would be spending our image-build budget on an image
    // nothing here would ever clean up, so the managed door does not serve
    // /snapshots at all. A create names a snapshot the platform already
    // publishes, and a name that does not exist fails loudly at create rather
    // than quietly building something.
    if (this.managedStream) {
      if (wantsResources) throw new DaytonaResourcesError(imageName);
      const sandbox = await this.client.create(
        { snapshot: imageName, ...baseParams },
        { timeout: 600 },
      );
      if (options.workingDirectory) {
        await sandbox.fs.createFolder(options.workingDirectory, "755");
      }
      if (user) this.sandboxUsers.set(sandbox.id, user);
      return new DaytonaSandboxImpl(sandbox, user, this.managedStream);
    }

    // Try to use existing snapshot first (fast path for returning users or ./build.sh daytona)
    try {
      const snapshot = await this.client.snapshot.get(imageName);
      let snapshotState: string | undefined = snapshot?.state;
      // An existing snapshot pins its sizing whatever its state, so the sizing
      // refusal fires before any reactivation work is spent on a doomed create.
      if (snapshot && (snapshotState === "active" || snapshotState === "inactive")) {
        if (wantsResources) throw new DaytonaResourcesError(imageName);
      }
      // Exists-but-inactive is HEALED, never treated as absent. Daytona
      // deactivates snapshots after 2 weeks unused; sending this case to the
      // build path made snapshot.create fail on the existing name and fall
      // back to a slow direct pull — the 2026-07-31 evolve-all prod incident.
      if (snapshot && snapshotState === "inactive") {
        snapshotState = (await activateSnapshot(this.client, imageName, snapshot)).state;
      }
      if (snapshot && snapshotState === "active") {
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
      // The typed refusals are final verdicts, not build triggers: sizing
      // cannot be enforced on an existing snapshot, and a snapshot that exists
      // but would not activate can only name-conflict with a rebuild.
      if (fastPathErr instanceof DaytonaResourcesError) throw fastPathErr;
      if (fastPathErr instanceof DaytonaSnapshotActivationError) throw fastPathErr;
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

    return new DaytonaSandboxImpl(sandbox, user, this.managedStream);
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    const sandbox = await this.client.get(sandboxId);
    if (sandbox.state !== "started") {
      await sandbox.start();
    }
    return new DaytonaSandboxImpl(sandbox, this.sandboxUsers.get(sandboxId), this.managedStream);
  }

  /**
   * List sandboxes, walking every page.
   *
   * This used to request page 1 and stop, discarding `totalPages` — an
   * organization with more than one page of sandboxes was silently truncated,
   * and nothing in the return value said so. For any caller that reads absence
   * from the list as "this sandbox is gone", that is a correctness bug.
   *
   * ORDER OF OPERATIONS, because it is observable: `limit` bounds the sandboxes
   * RETURNED, and Daytona has no server-side state filter, so the state filter
   * runs client-side on each page BEFORE the limit is counted. Asking for 10
   * running sandboxes therefore keeps paging until ten running ones have been
   * found, rather than filtering ten arbitrary rows down to whatever survives.
   */
  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    const page = await this.paginate(options);
    // A walk that stopped on the caller's own limit is not a failure — the
    // caller asked for a sample and got one. Only a walk that could not finish
    // is an exception here; `listAll` reports the distinction instead.
    if (page.error && !page.stoppedAtLimit) throw new Error(page.error);
    return page.sandboxes;
  }

  /**
   * The fleet-bookkeeping enumeration: same walk, never throws.
   *
   * The distinction from `list()` is what a failure MEANS to the caller. An
   * orphan sweep treats a missing sandbox as a terminated one, so it must be
   * able to tell "the organization has no sandboxes" from "the enumeration
   * stopped early".
   */
  async listAll(options?: SandboxListOptions): Promise<SandboxListPage> {
    const { stoppedAtLimit: _stoppedAtLimit, ...page } = await this.paginate(options);
    return page;
  }

  private async paginate(
    options?: SandboxListOptions,
  ): Promise<SandboxListPage & { stoppedAtLimit: boolean }> {
    return collectSandboxPages(
      (page) => this.listPage(options, page),
      options,
    );
  }

  /**
   * One page, asking the API to do the state filtering when it can.
   *
   * Daytona's REST endpoint takes a `states` array
   * (api-client sandbox-api.d.ts listSandboxesPaginated), but the SDK wrapper
   * this provider is built on does not expose it — `Daytona.list(labels, page,
   * limit)` is the whole public surface, and `sandboxApi` is declared private.
   * Without the server-side filter, `state: ['running']` on an organization
   * full of archived boxes pages through all of them client-side looking for a
   * handful of live ones.
   *
   * So the server filter is applied OPPORTUNISTICALLY, through the private
   * field when it is shaped the way we expect, and the client-side filter in
   * the walk stays the authority regardless. That ordering is the whole point:
   * if a future SDK refactor renames or removes the field, this degrades to the
   * request count it has today, and can never degrade to admitting states the
   * caller excluded.
   */
  private async listPage(
    options: SandboxListOptions | undefined,
    page: number,
  ): Promise<DaytonaSandboxPage> {
    const states = options?.state ? evolveStatesToDaytonaStates(options.state) : undefined;
    if (states && states.length > 0) {
      const api = (this.client as unknown as { sandboxApi?: DaytonaSandboxApiShape }).sandboxApi;
      if (typeof api?.listSandboxesPaginated === "function") {
        try {
          const response = await api.listSandboxesPaginated(
            undefined,
            page,
            DAYTONA_LIST_PAGE_SIZE,
            undefined,
            undefined,
            options?.metadata ? JSON.stringify(options.metadata) : undefined,
            undefined,
            states,
          );
          return { items: response.data.items, totalPages: response.data.totalPages };
        } catch {
          // Any shape surprise falls through to the supported path rather than
          // failing a list; the walk filters client-side either way.
        }
      }
    }
    return this.client.list(options?.metadata, page, DAYTONA_LIST_PAGE_SIZE);
  }
}

/** One page as Daytona's `list(labels?, page?, limit?)` returns it. */
export interface DaytonaSandboxPage {
  items: DaytonaSandbox[];
  totalPages?: number;
}

/**
 * The one api-client method the opportunistic server-side state filter uses.
 * Declared structurally rather than imported: it is reached through a field the
 * SDK marks private, so this is a shape we CHECK for, never a contract we can
 * rely on.
 */
interface DaytonaSandboxApiShape {
  listSandboxesPaginated(
    organizationId?: string,
    page?: number,
    limit?: number,
    id?: string,
    name?: string,
    labels?: string,
    includeErroredDeleted?: boolean,
    states?: string[],
  ): Promise<{ data: { items: DaytonaSandbox[]; totalPages?: number } }>;
}

/**
 * Our provider-neutral states, in Daytona's vocabulary — the inverse of
 * daytonaStateToEvolveState, used only to narrow the server-side query. The
 * client-side filter remains the authority, so an omission here costs requests
 * and never correctness.
 */
function evolveStatesToDaytonaStates(states: ("running" | "paused")[]): string[] {
  const out: string[] = [];
  for (const state of states) {
    if (state === "running") out.push("started");
    if (state === "paused") out.push("stopped", "archived");
  }
  return out;
}

/**
 * Walk every page into one answer, with an honest completeness verdict.
 *
 * Separate from the provider because everything worth getting wrong lives here
 * and none of it needs a network: the ways a walk can fail to terminate, the
 * difference between "the caller asked for ten" and "the provider ran out", and
 * the rule that a failure mid-walk yields the sandboxes seen so far marked
 * INCOMPLETE rather than either an exception or a short complete list.
 *
 * Exported for its test (`_testCollectSandboxPages`).
 */
async function collectSandboxPages(
  fetchPage: (page: number) => Promise<DaytonaSandboxPage>,
  options?: SandboxListOptions,
): Promise<SandboxListPage & { stoppedAtLimit: boolean }> {
  const wanted = options?.limit;
  const sandboxes: SandboxInfo[] = [];
  let pagesFetched = 0;
  /**
   * OFFSET PAGING OVER A MUTATING FLEET REPEATS ROWS. Daytona pages by number,
   * so a sandbox deleted while the walk is in flight shifts everything after it
   * back one page and the walk sees a row it already has — measured, not
   * theorised. A fleet enumeration that reports the same sandbox twice makes
   * every count downstream wrong, so ids are deduped as they arrive.
   */
  const seenIds = new Set<string>();

  for (let page = 1; page <= DAYTONA_MAX_LIST_PAGES; page += 1) {
    let result: DaytonaSandboxPage;
    try {
      result = await fetchPage(page);
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

    for (const sandbox of result.items) {
      if (options?.state) {
        // The state filter runs client-side on the REAL API-reported state, and
        // it stays the authority even when the server was asked to narrow too:
        // an opportunistic server filter that silently stopped applying must
        // never be able to admit a state the caller excluded. It runs BEFORE
        // the limit is counted, so "ten running" means ten running rather than
        // ten rows minus misses.
        const evolveState = daytonaStateToEvolveState(sandbox.state);
        if (evolveState === undefined || !options.state.includes(evolveState)) continue;
      }
      if (seenIds.has(sandbox.id)) continue;
      // BOUND CHECKED BEFORE THE PUSH: checked after, `limit: 0` returns one.
      if (wanted !== undefined && sandboxes.length >= wanted) {
        // Stopping on the caller's limit is NOT completion — there is at least
        // one more sandbox here and we are holding it.
        return {
          sandboxes,
          complete: false,
          pagesFetched,
          stoppedAtLimit: true,
          error: `stopped at the requested limit of ${wanted} with more sandboxes available`,
        };
      }
      seenIds.add(sandbox.id);
      sandboxes.push(toSandboxInfo(sandbox));
    }

    // totalPages is the server's own count; an empty page ends the walk too, so
    // a server that omits or miscounts totalPages still cannot spin us.
    const exhausted =
      result.items.length === 0 ||
      (typeof result.totalPages === "number" && page >= result.totalPages);
    if (wanted !== undefined && sandboxes.length >= wanted && !exhausted) {
      return {
        sandboxes,
        complete: false,
        pagesFetched,
        stoppedAtLimit: true,
        error: `stopped at the requested limit of ${wanted} with more sandboxes available`,
      };
    }
    if (exhausted) break;
    if (page === DAYTONA_MAX_LIST_PAGES) {
      return {
        sandboxes,
        complete: false,
        pagesFetched,
        stoppedAtLimit: false,
        error: `sandbox list exceeded ${DAYTONA_MAX_LIST_PAGES} pages`,
      };
    }
  }

  return { sandboxes, complete: true, pagesFetched, stoppedAtLimit: false };
}

export const _testCollectSandboxPages = collectSandboxPages;

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
export const _testWithInBoxTimeout = withInBoxTimeout;
export const _testMapNetworkPolicy = mapNetworkPolicy;
export const _testImageRegistryHost = imageRegistryHost;
export const _testToSandboxInfo = toSandboxInfo;
export const _testDaytonaStateToEvolveState = daytonaStateToEvolveState;
export const _testActivateSnapshot = activateSnapshot;
export const _testImageMap = IMAGE_MAP;
export const _testCreateLogDemuxer = createLogDemuxer;
export const _testFollowManagedSessionLogs = followManagedSessionLogs;
export const _testReadCommandStreams = readCommandStreams;
